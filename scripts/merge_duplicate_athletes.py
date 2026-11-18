#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
"""Merge duplicate athletes (members) in a team-app SQLite database.

Works from the plan CSV written by scripts/audit_duplicate_athletes.py --csv.
The input database is only ever opened READ-ONLY:

  dry run (default)  merges into an in-memory copy, prints what would change,
                     discards it
  --out FILE         writes the merged database to FILE (must not exist);
                     restore it through Admin → Restore once checked

Typical use on production:

  1. Admin → Backup → download prod.db
  2. python scripts/audit_duplicate_athletes.py prod.db --csv plan.csv
  3. Review plan.csv: in each group exactly one row has suggest_keep=Y (the
     member that survives); change it if needed, delete the rows/groups you
     don't want merged. Rows are grouped by (group, label).
  4. python scripts/merge_duplicate_athletes.py prod.db plan.csv           (dry run)
  5. python scripts/merge_duplicate_athletes.py prod.db plan.csv --out merged.db
  6. Check merged.db (re-run the audit on it), then restore it.

Per duplicate D merged into keeper K (one transaction, all or nothing):
  results            moved to K; a result identical to one K already has
                     (meet, style, event number, time) is dropped
  membersmeets       moved to K (keeps the club the meet was swum for);
                     dropped when K is already in that meet
  relayspos          slot moved to K; emptied if K is already on that team
  swimresult         (current-meet registrations) moved; dropped when K is
                     already registered for that event
  athlete_best_times moved; on a clash the most recently entered one wins
  live_results/live_startlist  athlete_id repointed
  members            K's empty license/birthdate/nation/handicapex/gender are
                     filled from D, then D is deleted
K keeps its own club. Group E (blank name) rows are deleted only with
--delete-blank, and only if no result, relay slot or registration uses them.
The run aborts if anything still references a merged member, or if
PRAGMA foreign_key_check reports a problem.
"""
from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path


def _has_table(con, name: str) -> bool:
    return con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def load_plan(path: str) -> tuple[list[tuple[int, list[int]]], list[int]]:
    """Return ([(keep_id, [dup_ids])], [blank_ids]) from an audit CSV."""
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if not row.get("membersid", "").strip():
                continue
            groups[(row["group"].strip(), row["label"])].append(row)

    merges: list[tuple[int, list[int]]] = []
    blanks: list[int] = []
    errors: list[str] = []
    for (kind, label), rows in groups.items():
        ids = [int(r["membersid"]) for r in rows]
        if kind == "E":
            blanks.extend(ids)
            continue
        keep = [int(r["membersid"]) for r in rows if r.get("suggest_keep", "").strip().upper() == "Y"]
        if len(rows) < 2:
            continue
        if len(keep) != 1:
            errors.append(f"[{kind}] {label}: needs exactly one suggest_keep=Y row (has {len(keep)})")
            continue
        merges.append((keep[0], [i for i in ids if i != keep[0]]))

    # A member can show up in several groups (e.g. A and D): fold them so each
    # duplicate has one keeper, and keepers are never merged away themselves.
    target: dict[int, int] = {}
    for keep, dups in merges:
        for d in dups:
            if target.get(d, keep) != keep:
                errors.append(f"member {d} is merged into both {target[d]} and {keep}")
            target[d] = keep
    for d in list(target):
        seen = {d}
        while target[d] in target:
            if target[d] in seen:
                errors.append(f"merge cycle involving member {d}")
                break
            seen.add(target[d])
            target[d] = target[target[d]]
    if errors:
        raise SystemExit("Plan errors:\n  " + "\n  ".join(errors))

    by_keep: dict[int, list[int]] = defaultdict(list)
    for d, k in target.items():
        by_keep[k].append(d)
    return sorted((k, sorted(ds)) for k, ds in by_keep.items()), sorted(set(blanks) - set(target))


def merge_member(con, keep: int, dup: int, log) -> None:
    q = con.execute

    # results
    for rid, meet, style, numb, t in q(
            "SELECT resultsid, meetsid, stylesid, eventnumb, totaltime FROM results WHERE membersid=?",
            (dup,)).fetchall():
        same = q("SELECT 1 FROM results WHERE membersid=? AND meetsid IS ? AND stylesid IS ? "
                 "AND eventnumb IS ? AND totaltime IS ?", (keep, meet, style, numb, t)).fetchone()
        if same:
            q("DELETE FROM results WHERE resultsid=?", (rid,))
            log(f"      result {rid} dropped (identical to one of {keep})")
        else:
            q("UPDATE results SET membersid=? WHERE resultsid=?", (keep, rid))
    # membersmeets
    for meet, in q("SELECT meetsid FROM membersmeets WHERE membersid=?", (dup,)).fetchall():
        if q("SELECT 1 FROM membersmeets WHERE membersid=? AND meetsid=?", (keep, meet)).fetchone():
            q("DELETE FROM membersmeets WHERE membersid=? AND meetsid=?", (dup, meet))
        else:
            q("UPDATE membersmeets SET membersid=? WHERE membersid=? AND meetsid=?", (keep, dup, meet))
    # relayspos
    for relay, numb in q("SELECT relaysid, numb FROM relayspos WHERE membersid=?", (dup,)).fetchall():
        if q("SELECT 1 FROM relayspos WHERE relaysid=? AND membersid=?", (relay, keep)).fetchone():
            q("UPDATE relayspos SET membersid=NULL WHERE relaysid=? AND numb=?", (relay, numb))
            log(f"      relay {relay} slot {numb} emptied ({keep} already on that team)")
        else:
            q("UPDATE relayspos SET membersid=? WHERE relaysid=? AND numb=?", (keep, relay, numb))
    # swimresult (current-meet registrations)
    if _has_table(con, "swimresult"):
        for srid, meet, ev, age in q("SELECT swimresultid, meetsid, swimeventid, age_code FROM swimresult "
                                     "WHERE athleteid=?", (dup,)).fetchall():
            if q("SELECT 1 FROM swimresult WHERE athleteid=? AND meetsid IS ? AND swimeventid IS ? "
                 "AND age_code IS ?", (keep, meet, ev, age)).fetchone():
                q("DELETE FROM swimresult WHERE swimresultid=?", (srid,))
                log(f"      registration {srid} dropped ({keep} already registered)")
            else:
                q("UPDATE swimresult SET athleteid=? WHERE swimresultid=?", (keep, srid))
    # athlete_best_times
    if _has_table(con, "athlete_best_times"):
        for style, course, t, entered in q("SELECT stylesid, course, time_ms, entered_date "
                                           "FROM athlete_best_times WHERE membersid=?", (dup,)).fetchall():
            mine = q("SELECT entered_date FROM athlete_best_times WHERE membersid=? AND stylesid=? AND course=?",
                     (keep, style, course)).fetchone()
            if mine is None:
                q("UPDATE athlete_best_times SET membersid=? WHERE membersid=? AND stylesid=? AND course=?",
                  (keep, dup, style, course))
            else:
                if (entered or "") > (mine[0] or ""):
                    q("UPDATE athlete_best_times SET time_ms=?, entered_date=? "
                      "WHERE membersid=? AND stylesid=? AND course=?", (t, entered, keep, style, course))
                q("DELETE FROM athlete_best_times WHERE membersid=? AND stylesid=? AND course=?",
                  (dup, style, course))
    # live tables
    for table in ("live_results", "live_startlist"):
        if _has_table(con, table):
            q(f"UPDATE {table} SET athlete_id=? WHERE athlete_id=?", (keep, dup))

    # fill the keeper's empty fields, then delete the duplicate
    k = q("SELECT license, birthdate, nation, handicapex, gender FROM members WHERE membersid=?", (keep,)).fetchone()
    d = q("SELECT license, birthdate, nation, handicapex, gender FROM members WHERE membersid=?", (dup,)).fetchone()
    for col, kv, dv in zip(("license", "birthdate", "nation", "handicapex", "gender"), k, d):
        if (kv in (None, "", 0)) and dv not in (None, "", 0):
            q(f"UPDATE members SET {col}=? WHERE membersid=?", (dv, keep))
            log(f"      {keep}.{col} filled from {dup}: {dv}")
    q("DELETE FROM members WHERE membersid=?", (dup,))


def references(con, member: int) -> list[str]:
    """Every row in any table that still points at this member."""
    left = []
    for table, in con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
        for fk in con.execute(f"PRAGMA foreign_key_list('{table}')").fetchall():
            if fk[2] == "members":
                n = con.execute(f"SELECT COUNT(*) FROM '{table}' WHERE {fk[3]}=?", (member,)).fetchone()[0]
                if n:
                    left.append(f"{table}.{fk[3]}: {n}")
    for table in ("live_results", "live_startlist"):
        if _has_table(con, table):
            n = con.execute(f"SELECT COUNT(*) FROM {table} WHERE athlete_id=?", (member,)).fetchone()[0]
            if n:
                left.append(f"{table}.athlete_id: {n}")
    return left


def describe(con, mid: int) -> str:
    r = con.execute("SELECT m.firstname, m.lastname, substr(m.birthdate,1,10), c.name FROM members m "
                    "LEFT JOIN clubs c ON c.clubsid=m.clubsid WHERE m.membersid=?", (mid,)).fetchone()
    return f"{mid} {r[0]} {r[1]} ({r[2] or '-'}, {r[3] or '-'})" if r else f"{mid} <missing>"


def run(con, merges, blanks, delete_blank: bool, log=print) -> dict:
    """Apply the plan inside the current transaction. Raises on any problem."""
    con.execute("PRAGMA foreign_keys=ON")
    stats = {"merged": 0, "blank_deleted": 0, "blank_skipped": 0}
    for keep, dups in merges:
        if not con.execute("SELECT 1 FROM members WHERE membersid=?", (keep,)).fetchone():
            raise RuntimeError(f"keeper {keep} not found")
        log(f"  keep {describe(con, keep)}")
        for dup in dups:
            if not con.execute("SELECT 1 FROM members WHERE membersid=?", (dup,)).fetchone():
                raise RuntimeError(f"duplicate {dup} not found (already merged?)")
            log(f"    <- {describe(con, dup)}")
            merge_member(con, keep, dup, log)
            stats["merged"] += 1
    if delete_blank:
        for mid in blanks:
            busy = [n for t, c in (("results", "membersid"), ("relayspos", "membersid"),
                                   ("swimresult", "athleteid"))
                    if _has_table(con, t)
                    for n in [con.execute(f"SELECT COUNT(*) FROM {t} WHERE {c}=?", (mid,)).fetchone()[0]] if n]
            if busy:
                log(f"  blank {mid}: kept (still used by results/relays/registrations)")
                stats["blank_skipped"] += 1
                continue
            con.execute("DELETE FROM membersmeets WHERE membersid=?", (mid,))
            con.execute("DELETE FROM athlete_best_times WHERE membersid=?", (mid,))
            con.execute("DELETE FROM members WHERE membersid=?", (mid,))
            log(f"  blank {mid}: deleted")
            stats["blank_deleted"] += 1

    gone = [d for _, ds in merges for d in ds]
    for d in gone:
        left = references(con, d)
        if left:
            raise RuntimeError(f"member {d} still referenced: {', '.join(left)}")
    bad = con.execute("PRAGMA foreign_key_check").fetchall()
    if bad:
        raise RuntimeError(f"foreign_key_check failed: {bad[:10]}")
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("db", help="team-app SQLite database (a downloaded backup)")
    ap.add_argument("plan", help="plan CSV from audit_duplicate_athletes.py --csv")
    ap.add_argument("--out", help="write the merged database here (default: dry run, nothing written)")
    ap.add_argument("--delete-blank", action="store_true",
                    help="also delete group E (blank name) members that nothing uses")
    args = ap.parse_args()

    src_path = Path(args.db)
    if not src_path.is_file():
        print(f"not found: {src_path}", file=sys.stderr)
        return 2
    if args.out and Path(args.out).exists():
        print(f"refusing to overwrite {args.out}", file=sys.stderr)
        return 2

    merges, blanks = load_plan(args.plan)
    src = sqlite3.connect(f"file:{src_path.as_posix()}?mode=ro", uri=True)
    dst = sqlite3.connect(args.out if args.out else ":memory:", isolation_level=None)
    src.backup(dst)
    src.close()

    before = dst.execute("SELECT COUNT(*) FROM members").fetchone()[0]
    print(f"{'DRY RUN' if not args.out else 'WRITING ' + args.out}: {len(merges)} keeper(s), "
          f"{sum(len(d) for _, d in merges)} duplicate(s), {len(blanks)} blank(s)\n")
    dst.execute("BEGIN")
    try:
        stats = run(dst, merges, blanks, args.delete_blank)
    except Exception as e:
        dst.execute("ROLLBACK")
        dst.close()
        if args.out:
            Path(args.out).unlink(missing_ok=True)
        print(f"\nABORTED, nothing written: {e}", file=sys.stderr)
        return 1
    dst.execute("COMMIT")
    after = dst.execute("SELECT COUNT(*) FROM members").fetchone()[0]
    dst.close()
    print(f"\nmembers: {before} -> {after}  (merged {stats['merged']}, blank deleted "
          f"{stats['blank_deleted']}, blank kept {stats['blank_skipped']})")
    print(f"Written: {args.out}" if args.out else "Dry run: nothing written. Add --out FILE to write.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
