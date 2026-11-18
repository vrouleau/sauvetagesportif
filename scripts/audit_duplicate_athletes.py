#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
"""Audit duplicate athletes (members) in a team-app SQLite database. READ-ONLY.

Opens the database with mode=ro: nothing is ever written. Run it on a backup
(Admin → Backup → download .db) or on the live file.

Usage:
    python scripts/audit_duplicate_athletes.py meetmgr.db [--csv out.csv]

Groups reported (one member can appear in several):
  A  SAME PERSON       same name (accent/case/space-insensitive) + same birthdate
  B  SAME NAME, CLUB   same name + same club, birthdate missing on at least one
  C  SAME LICENSE      one non-empty license shared by several members
  D  SIMILAR NAME      same birthdate + same club, name differs but is close
                       (typos such as Annabelle/Anabelle) — verify by hand
  E  BLANK NAME        members with an empty first and last name

For each member it prints what references it (meets, results, relay slots,
current-meet registrations, coach best times) — the rows a merge would move.
Suggested "keep" id = the lowest id that anything references (the original
record), else the lowest id.

The --csv output is the plan file for scripts/merge_duplicate_athletes.py:
review it, fix the suggest_keep column where needed, delete the groups you
don't want merged.
"""
from __future__ import annotations

import argparse
import csv
import difflib
import sqlite3
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path


def norm(s: str | None) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return " ".join(s.lower().replace("-", " ").replace("'", " ").split())


def table_exists(con, name: str) -> bool:
    return con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def count_by_member(con, table: str, col: str) -> dict[int, int]:
    if not table_exists(con, table):
        return {}
    return {mid: n for mid, n in con.execute(
        f"SELECT {col}, COUNT(*) FROM {table} WHERE {col} IS NOT NULL GROUP BY {col}")}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("db", help="team-app SQLite database (meetmgr.db or a backup .db)")
    ap.add_argument("--csv", help="also write one row per member per group to this CSV file")
    ap.add_argument("--similarity", type=float, default=0.85,
                    help="name similarity threshold for group D (default 0.85)")
    args = ap.parse_args()

    db = Path(args.db)
    if not db.is_file():
        print(f"not found: {db}", file=sys.stderr)
        return 2
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)

    clubs = {cid: (name or "", code or "") for cid, name, code in
             con.execute("SELECT clubsid, name, code FROM clubs")}
    meets = {mid: name for mid, name in con.execute("SELECT meetsid, name FROM meets")}
    member_meets: dict[int, list[int]] = defaultdict(list)
    for mid, meetid in con.execute("SELECT membersid, meetsid FROM membersmeets ORDER BY meetsid"):
        member_meets[mid].append(meetid)

    refs = {
        "results": count_by_member(con, "results", "membersid"),
        "relay": count_by_member(con, "relayspos", "membersid"),
        "reg": count_by_member(con, "swimresult", "athleteid"),
        "best": count_by_member(con, "athlete_best_times", "membersid"),
    }

    members = {}
    for mid, first, last, bd, gender, lic, cid in con.execute(
            "SELECT membersid, firstname, lastname, birthdate, gender, license, clubsid FROM members"):
        members[mid] = {
            "id": mid, "first": first or "", "last": last or "",
            "bd": (bd or "")[:10], "gender": {1: "M", 2: "F"}.get(gender, "?"),
            "license": (lic or "").strip(), "club": cid,
            "name_key": norm(f"{first} {last}"),
        }
        m = members[mid]
        m["meets"] = member_meets.get(mid, [])
        for k, d in refs.items():
            m[k] = d.get(mid, 0)
        m["weight"] = len(m["meets"]) + m["results"] + m["relay"] + m["reg"] + m["best"]

    groups: list[tuple[str, str, list[dict]]] = []
    seen_pairs: set[frozenset] = set()

    def add(kind: str, label: str, ms: list[dict]):
        if len(ms) > 1 or kind == "E":
            groups.append((kind, label, sorted(ms, key=lambda m: m["id"])))
            if kind in "ABC":
                for i, a in enumerate(ms):
                    for b in ms[i + 1:]:
                        seen_pairs.add(frozenset((a["id"], b["id"])))

    by = defaultdict(list)
    for m in members.values():
        if m["name_key"] and m["bd"]:
            by[(m["name_key"], m["bd"])].append(m)
    for (name, bd), ms in by.items():
        add("A", f"{name} / {bd}", ms)

    by = defaultdict(list)
    for m in members.values():
        if m["name_key"]:
            by[(m["name_key"], m["club"])].append(m)
    for (name, club), ms in by.items():
        if len(ms) > 1 and any(not m["bd"] for m in ms):
            add("B", f"{name} / {clubs.get(club, ('?',))[0]}", ms)

    by = defaultdict(list)
    for m in members.values():
        if m["license"]:
            by[m["license"]].append(m)
    for lic, ms in by.items():
        add("C", f"license {lic}", ms)

    by = defaultdict(list)
    for m in members.values():
        if m["name_key"] and m["bd"]:
            by[(m["bd"], m["club"])].append(m)
    for (bd, club), ms in by.items():
        for i, a in enumerate(ms):
            for b in ms[i + 1:]:
                if a["name_key"] == b["name_key"] or frozenset((a["id"], b["id"])) in seen_pairs:
                    continue
                if difflib.SequenceMatcher(None, a["name_key"], b["name_key"]).ratio() >= args.similarity:
                    add("D", f"{a['first']} {a['last']} ~ {b['first']} {b['last']} / {bd}", [a, b])

    blanks = [m for m in members.values() if not m["first"].strip() and not m["last"].strip()]
    if blanks:
        add("E", "blank first and last name", blanks)

    titles = {"A": "SAME PERSON (name + birthdate)", "B": "SAME NAME + CLUB, birthdate missing",
              "C": "SAME LICENSE", "D": "SIMILAR NAME, same birthdate + club (verify)",
              "E": "BLANK NAME"}
    order = "ABCDE"
    groups.sort(key=lambda g: (order.index(g[0]), g[1]))

    def club_str(cid):
        name, code = clubs.get(cid, ("?", ""))
        return f"{name} [{code}]" if code else name

    def keep_id(ms):
        # The oldest member that anything references (the original record);
        # copies an import created later have higher ids.
        used = [m for m in ms if m["weight"]] or ms
        return min(m["id"] for m in used)

    print(f"Database: {db}   members: {len(members)}   clubs: {len(clubs)}   meets: {len(meets)}")
    for kind in order:
        gs = [g for g in groups if g[0] == kind]
        extra = sum(len(ms) - 1 for _, _, ms in gs) if kind != "E" else sum(len(ms) for _, _, ms in gs)
        print(f"\n{'=' * 100}\n{kind}  {titles[kind]}: {len(gs)} group(s), {extra} extra member(s)\n{'=' * 100}")
        for _, label, ms in gs:
            k = keep_id(ms) if kind != "E" else None
            print(f"\n  {label}")
            for m in ms:
                tag = "keep" if m["id"] == k else "    "
                meet_list = ",".join(map(str, m["meets"])) or "-"
                print(f"    {tag} id={m['id']:<6} {m['first']} {m['last']:<28} {m['gender']} bd={m['bd'] or '-':<10} "
                      f"lic={m['license'] or '-':<9} club={club_str(m['club'])}")
                print(f"           meets={meet_list}  results={m['results']}  relay_slots={m['relay']}  "
                      f"registrations={m['reg']}  best_times={m['best']}")

    print("\nMeets:")
    for mid in sorted(meets):
        print(f"  {mid:>4}  {meets[mid]}")

    by_club = defaultdict(int)
    for kind, _, ms in groups:
        if kind == "A":
            for m in ms:
                by_club[club_str(m["club"])] += 1
    if by_club:
        print("\nMembers in group A by club:")
        for c, n in sorted(by_club.items(), key=lambda x: -x[1]):
            print(f"  {n:>4}  {c}")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["group", "label", "suggest_keep", "membersid", "firstname", "lastname", "gender",
                        "birthdate", "license", "club", "meets", "results", "relay_slots",
                        "registrations", "best_times"])
            for kind, label, ms in groups:
                k = keep_id(ms) if kind != "E" else None
                for m in ms:
                    w.writerow([kind, label, "Y" if m["id"] == k else "", m["id"], m["first"], m["last"],
                                m["gender"], m["bd"], m["license"], club_str(m["club"]),
                                " ".join(map(str, m["meets"])), m["results"], m["relay"], m["reg"], m["best"]])
        print(f"\nCSV written: {args.csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
