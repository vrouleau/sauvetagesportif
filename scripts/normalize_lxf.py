#!/usr/bin/env python3
"""
normalize_lxf.py — Normalize a historic results LXF against a current meet template.

Usage:
    python scripts/normalize_lxf.py TEMPLATE.lxf ENTRIES.lxf HISTORIC.lxf

Inputs:
    TEMPLATE.lxf  — Current meet template (defines canonical swimstyle IDs)
    ENTRIES.lxf   — Current entries file (canonical clubs + athlete names with accents)
    HISTORIC.lxf  — Historical results file to normalize

Output:
    {HISTORIC_stem}_normalized.lxf  (same directory as HISTORIC.lxf)
    + verbose console report of every match / fix / creation

Normalizations applied:
    1. Swimstyle IDs  — remapped to canonical template IDs by matching on normalized
                        event name + distance + relaycount.
                        Events with no template equivalent are DROPPED.

    2. Clubs          — code and name normalized to canonical values from entries file.
                        Match order: exact code → exact name → fuzzy name.

    3. Athlete names  — firstname/lastname fixed for missing accents.
                        Match order: license → exact normalized name → fuzzy name.
                        Unmatched athletes are kept as-is (logged as NEW).
"""
from __future__ import annotations

import argparse
import difflib
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Optional


# ─── Normalization helpers ────────────────────────────────────────────────────

def strip_accents(s: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )


def norm_str(s: str) -> str:
    """Lowercase + strip accents + collapse spaces."""
    return re.sub(r"\s+", " ", strip_accents(s).lower()).strip()


def normalize_person_key(first: str, last: str) -> str:
    return norm_str(f"{last} {first}")


def normalize_club_name(name: str) -> str:
    n = norm_str(name)
    # remove very common prefixes that vary
    n = re.sub(r"^(club\s+(de\s+)?|association\s+)", "", n)
    return n.strip()


def normalize_style_name(name: str, distance: int, relaycount: int) -> Optional[str]:
    """Canonical lookup key: strip age suffixes, bilingual halves, articles, prefixes."""
    if not name:
        return None
    n = unicodedata.normalize("NFC", name)
    n = re.sub(r"\s*/.*", "", n)                                            # bilingual slash
    n = re.sub(r"\s*\([^)]*\)", "", n)                                      # parentheses
    n = re.sub(r"\b\d+\s*ans?\s+et\s*[-+]", " ", n, flags=re.IGNORECASE)   # "10 ans et -"
    n = re.sub(r"\b\d+\s*et\s*[-+]", " ", n, flags=re.IGNORECASE)          # "10 et -"
    n = re.sub(r"\b\d+[-–]\d+\s*ans?\b", " ", n, flags=re.IGNORECASE)      # "11-12 ans"
    n = re.sub(r"\b(open|senior|junior|cadet|u\d+)\b", " ", n, flags=re.IGNORECASE)
    n = re.sub(r"^\d+\s*[x×]\s*\d+[\s.,]*m?\s*[-–]?\s*", "", n, flags=re.IGNORECASE)  # relay prefix
    n = re.sub(r"^\d+[\s.,]*m\s*", "", n, flags=re.IGNORECASE)             # distance prefix
    n = n.replace("1/2", "½")
    n = re.sub(r"½\s*", "½ ", n)
    n = re.sub(r"\b(du|de|d'|la|le|les|avec|des)\b", " ", n, flags=re.IGNORECASE)
    n = re.sub(r"[+\-–·,]", " ", n)
    n = n.lower()
    n = re.sub(r"\s+", " ", n).strip()
    return f"{distance or 0}:{relaycount or 1}:{n}" if n else None


# ─── LXF reading ─────────────────────────────────────────────────────────────

def read_lxf_xml(path: Path) -> ET.Element:
    with zipfile.ZipFile(path) as z:
        lef_name = next(n for n in z.namelist() if n.endswith(".lef"))
        return ET.fromstring(z.read(lef_name))


# ─── Template: style lookup ───────────────────────────────────────────────────

def build_style_lookup(root: ET.Element) -> tuple[dict[str, int], dict[int, str]]:
    """Returns (key→id, id→display_name)."""
    lookup: dict[str, int] = {}
    names: dict[int, str] = {}
    for ss in root.iter("SWIMSTYLE"):
        uid_raw = ss.get("swimstyleid", "")
        name = ss.get("name", "")
        if not uid_raw or not name:
            continue
        uid = int(uid_raw)
        dist = int(ss.get("distance") or "0")
        relay = int(ss.get("relaycount") or "1")
        key = normalize_style_name(name, dist, relay)
        if key and key not in lookup:
            lookup[key] = uid
            names[uid] = name
    return lookup, names


# ─── Entries: club + athlete lookups ─────────────────────────────────────────

ClubInfo = dict    # code, name, norm_code, norm_name
AthleteInfo = dict # firstname, lastname, license, birthdate, gender, norm_key, handicap


def build_entries_lookups(root: ET.Element) -> tuple[
    dict[str, ClubInfo],    # by_club_code  (lowercased)
    dict[str, ClubInfo],    # by_club_name  (normalized)
    list[ClubInfo],         # all_clubs
    dict[str, AthleteInfo], # by_license
    dict[str, AthleteInfo], # by_norm_name
    list[AthleteInfo],      # all_athletes
]:
    by_club_code: dict[str, ClubInfo] = {}
    by_club_name: dict[str, ClubInfo] = {}
    all_clubs: list[ClubInfo] = []

    by_license: dict[str, AthleteInfo] = {}
    by_norm_name: dict[str, AthleteInfo] = {}
    all_athletes: list[AthleteInfo] = []

    for club_el in root.iter("CLUB"):
        code = club_el.get("code", "").strip()
        name = club_el.get("name", "").strip()
        ci: ClubInfo = {
            "code": code, "name": name,
            "norm_code": code.lower(),
            "norm_name": normalize_club_name(name),
        }
        all_clubs.append(ci)
        if ci["norm_code"]:
            by_club_code[ci["norm_code"]] = ci
        if ci["norm_name"] and ci["norm_name"] not in by_club_name:
            by_club_name[ci["norm_name"]] = ci

        for ath_el in club_el.iter("ATHLETE"):
            first = ath_el.get("firstname", "").strip()
            last  = ath_el.get("lastname",  "").strip()
            lic   = ath_el.get("license",   "").strip()
            bd    = ath_el.get("birthdate", "").strip()
            gen   = ath_el.get("gender",    "").strip()
            handicap_el = ath_el.find("HANDICAP")
            ai: AthleteInfo = {
                "firstname": first, "lastname": last,
                "license": lic, "birthdate": bd, "gender": gen,
                "norm_key": normalize_person_key(first, last),
                "handicap": dict(handicap_el.attrib) if handicap_el is not None else None,
            }
            all_athletes.append(ai)
            if lic:
                by_license[lic] = ai
            nk = ai["norm_key"]
            if nk and nk not in by_norm_name:
                by_norm_name[nk] = ai

    return by_club_code, by_club_name, all_clubs, by_license, by_norm_name, all_athletes


def match_club(
    h_code: str, h_name: str,
    by_code: dict, by_name: dict, all_clubs: list,
) -> tuple[Optional[ClubInfo], str]:
    """Returns (matched_club | None, match_type)."""
    # 1. Exact code
    if h_code and h_code.lower() in by_code:
        return by_code[h_code.lower()], "code"
    # 2. Exact normalized name
    nn = normalize_club_name(h_name)
    if nn and nn in by_name:
        return by_name[nn], "name"
    # 3. Fuzzy name
    best_ratio, best_match = 0.0, None
    for ci in all_clubs:
        r = difflib.SequenceMatcher(None, nn, ci["norm_name"]).ratio()
        if r > best_ratio:
            best_ratio, best_match = r, ci
    if best_ratio >= 0.80 and best_match:
        return best_match, f"fuzzy({best_ratio:.2f})"
    return None, "none"


def match_athlete(
    h_first: str, h_last: str, h_gen: str, h_lic: str,
    by_license: dict, by_norm: dict, all_athletes: list,
) -> tuple[Optional[AthleteInfo], str]:
    """Returns (matched_athlete | None, match_type)."""
    # 1. License
    if h_lic and h_lic in by_license:
        return by_license[h_lic], "license"
    # 2. Exact normalized name
    nk = normalize_person_key(h_first, h_last)
    if nk in by_norm:
        c = by_norm[nk]
        if not h_gen or not c["gender"] or h_gen == c["gender"]:
            return c, "exact"
    # 3. Fuzzy name
    best_ratio, best_match = 0.0, None
    for ai in all_athletes:
        r = difflib.SequenceMatcher(None, nk, ai["norm_key"]).ratio()
        if h_gen and ai["gender"] and h_gen == ai["gender"]:
            r += 0.02
        if r > best_ratio:
            best_ratio, best_match = r, ai
    if best_ratio >= 0.85 and best_match:
        return best_match, f"fuzzy({best_ratio:.2f})"
    return None, "none"


# ─── Formatting helpers ───────────────────────────────────────────────────────

def _tag(match_type: str) -> str:
    if match_type == "license": return "[lic  ]"
    if match_type == "code":    return "[code ]"
    if match_type == "name":    return "[name ]"
    if match_type == "exact":   return "[exact]"
    if match_type == "none":    return "[NEW  ]"
    return f"[{match_type:<7}]"  # fuzzy(0.xx)


WARN = "  ⚠ verify"
SEP  = "─" * 64


# ─── Main ─────────────────────────────────────────────────────────────────────

def normalize(template_path: Path, entries_path: Path, historic_path: Path) -> None:
    output_path = historic_path.parent / f"{historic_path.stem}_normalized.lxf"

    print(f"\n{'='*64}")
    print(f"  normalize_lxf  —  {historic_path.name}")
    print(f"  template : {template_path.name}")
    print(f"  entries  : {entries_path.name}")
    print(f"  output   : {output_path.name}")
    print(f"{'='*64}\n")

    template_root = read_lxf_xml(template_path)
    entries_root  = read_lxf_xml(entries_path)
    hist_root     = read_lxf_xml(historic_path)

    style_lookup, style_display = build_style_lookup(template_root)
    (by_club_code, by_club_name, all_clubs,
     by_license, by_norm_name, all_athletes) = build_entries_lookups(entries_root)

    # ── 1. Swimstyle remaps ───────────────────────────────────────────────────

    # uid_remap: file_uid → canonical_uid | None (None = drop)
    uid_remap: dict[int, Optional[int]] = {}
    uid_orig_name: dict[int, str] = {}
    event_to_uid: dict[str, int] = {}  # eventid → file_uid

    for event_el in hist_root.iter("EVENT"):
        eid = event_el.get("eventid", "")
        ss  = event_el.find("SWIMSTYLE")
        if ss is None:
            continue
        uid_raw = ss.get("swimstyleid", "")
        if not uid_raw:
            continue
        file_uid = int(uid_raw)
        event_to_uid[eid] = file_uid
        if file_uid in uid_remap:
            continue
        name  = ss.get("name", "")
        dist  = int(ss.get("distance")  or "0")
        relay = int(ss.get("relaycount") or "1")
        key   = normalize_style_name(name, dist, relay)
        uid_remap[file_uid] = style_lookup.get(key) if key else None
        uid_orig_name[file_uid] = name

    dropped_uids: set[int] = {u for u, c in uid_remap.items() if c is None}
    dropped_eventids: set[str] = {e for e, u in event_to_uid.items() if u in dropped_uids}

    print(SEP)
    print("SWIMSTYLE REMAPS")
    print(SEP)
    n_remapped = n_dropped = n_unchanged = 0
    for file_uid in sorted(uid_remap):
        canonical = uid_remap[file_uid]
        raw_name = uid_orig_name.get(file_uid, "")
        short = (raw_name[:40] + "…") if len(raw_name) > 42 else raw_name
        relay_str = ""
        for event_el in hist_root.iter("EVENT"):
            ss = event_el.find("SWIMSTYLE")
            if ss is not None and ss.get("swimstyleid") == str(file_uid):
                rc = int(ss.get("relaycount") or "1")
                if rc > 1:
                    relay_str = f" (relay{rc})"
                break

        if canonical is None:
            print(f"  DROPPED  {file_uid:<5}  {short}{relay_str}")
            n_dropped += 1
        elif canonical == file_uid:
            print(f"  ok       {file_uid:<5}  {short}{relay_str}")
            n_unchanged += 1
        else:
            canon_name = style_display.get(canonical, f"ID{canonical}")
            print(f"  remap    {file_uid:<5}  {short}{relay_str}")
            print(f"           {'':5}  → {canonical}  {canon_name}")
            n_remapped += 1

    print(f"\n  {n_remapped} remapped  |  {n_unchanged} already canonical  |  {n_dropped} dropped\n")

    # Apply remaps to XML
    for el in hist_root.iter():
        uid_raw = el.get("swimstyleid")
        if not uid_raw:
            continue
        try:
            file_uid = int(uid_raw)
        except ValueError:
            continue
        if file_uid in uid_remap and uid_remap[file_uid] is not None:
            el.set("swimstyleid", str(uid_remap[file_uid]))

    # Drop events
    for session_el in hist_root.iter("SESSION"):
        events_el = session_el.find("EVENTS")
        if events_el is None:
            continue
        for event_el in list(events_el):
            if event_el.get("eventid", "") in dropped_eventids:
                events_el.remove(event_el)

    results_removed = relays_removed = 0
    for results_el in hist_root.iter("RESULTS"):
        for r in list(results_el):
            if r.get("eventid", "") in dropped_eventids:
                results_el.remove(r)
                results_removed += 1
    for relays_el in hist_root.iter("RELAYS"):
        for r in list(relays_el):
            if r.get("eventid", "") in dropped_eventids:
                relays_el.remove(r)
                relays_removed += 1

    if n_dropped:
        print(f"  → {results_removed} individual results removed, "
              f"{relays_removed} relay records removed\n")

    # ── 2. Clubs & athletes ───────────────────────────────────────────────────

    print(SEP)
    print("CLUBS & ATHLETES")
    print(SEP)

    clubs_matched = clubs_new = 0
    clubs_fuzzy_warn: list[str] = []
    ath_by_type: dict[str, int] = {"license": 0, "exact": 0, "fuzzy": 0, "NEW": 0}
    ath_fuzzy_warn: list[str] = []

    for club_el in hist_root.iter("CLUB"):
        h_code = club_el.get("code", "").strip()
        h_name = club_el.get("name", "").strip()

        matched_club, club_match_type = match_club(
            h_code, h_name, by_club_code, by_club_name, all_clubs
        )

        # Club line
        tag = _tag(club_match_type)
        if matched_club:
            clubs_matched += 1
            code_changed = matched_club["code"] != h_code
            name_changed = matched_club["name"] != h_name
            changes = []
            if code_changed: changes.append(f"code: {h_code!r} → {matched_club['code']!r}")
            if name_changed: changes.append(f"name: {h_name!r} → {matched_club['name']!r}")
            change_str = "  [" + ", ".join(changes) + "]" if changes else "  (no change)"
            warn_str = WARN if "fuzzy" in club_match_type else ""
            print(f"\n{tag} {h_code} / {h_name}")
            print(f"         ↳ {matched_club['code']} / {matched_club['name']}{change_str}{warn_str}")
            if "fuzzy" in club_match_type:
                clubs_fuzzy_warn.append(f"{h_code} / {h_name}")
            # Apply fix
            club_el.set("code", matched_club["code"])
            club_el.set("name", matched_club["name"])
        else:
            clubs_new += 1
            print(f"\n{tag} {h_code} / {h_name}")
            print(f"         ↳ (not in entries — kept as-is)")

        # Athletes within this club
        for ath_el in club_el.iter("ATHLETE"):
            h_first = ath_el.get("firstname", "").strip()
            h_last  = ath_el.get("lastname",  "").strip()
            h_gen   = ath_el.get("gender",    "").strip()
            h_lic   = ath_el.get("license",   "").strip()

            matched_ath, ath_match_type = match_athlete(
                h_first, h_last, h_gen, h_lic,
                by_license, by_norm_name, all_athletes,
            )

            atag = _tag(ath_match_type)
            if matched_ath:
                first_changed  = matched_ath["firstname"] != h_first
                last_changed   = matched_ath["lastname"]  != h_last
                lic_added      = not h_lic and matched_ath["license"]
                handicap_added = (
                    matched_ath.get("handicap") is not None
                    and ath_el.find("HANDICAP") is None
                )
                if first_changed or last_changed or lic_added or handicap_added:
                    changes_str = f"{h_last}, {h_first}"
                    canon_str   = f"{matched_ath['lastname']}, {matched_ath['firstname']}"
                    detail = []
                    if lic_added:
                        detail.append(f"lic: {matched_ath['license']}")
                    if handicap_added:
                        exc = matched_ath["handicap"].get("exception", "?")
                        detail.append(f"HANDICAP exception={exc!r}")
                    if detail:
                        canon_str += f" ({', '.join(detail)})"
                    warn_str = WARN if "fuzzy" in ath_match_type else ""
                    print(f"  {atag}  {changes_str}  →  {canon_str}{warn_str}")
                    if "fuzzy" in ath_match_type:
                        ath_fuzzy_warn.append(f"{h_last}, {h_first} → {matched_ath['lastname']}, {matched_ath['firstname']}")
                    # Apply fix
                    ath_el.set("firstname", matched_ath["firstname"])
                    ath_el.set("lastname",  matched_ath["lastname"])
                    if lic_added:
                        ath_el.set("license", matched_ath["license"])
                    if handicap_added:
                        new_h = ET.SubElement(ath_el, "HANDICAP")
                        for k, v in matched_ath["handicap"].items():
                            new_h.set(k, v)
                else:
                    print(f"  {atag}  {h_last}, {h_first}  (no change)")
                # Track stats
                key = "fuzzy" if "fuzzy" in ath_match_type else ath_match_type
                ath_by_type[key] = ath_by_type.get(key, 0) + 1
            else:
                print(f"  {atag}  {h_last}, {h_first}  (not in entries)")
                ath_by_type["NEW"] += 1

    # ── 3. Write output ───────────────────────────────────────────────────────

    xml_bytes = (
        b'<?xml version="1.0" encoding="utf-8"?>\n'
        + ET.tostring(hist_root, encoding="unicode").encode("utf-8")
    )
    with zipfile.ZipFile(historic_path) as z_in:
        with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as z_out:
            for item in z_in.infolist():
                if item.filename.endswith(".lef"):
                    z_out.writestr(item.filename, xml_bytes)
                else:
                    z_out.writestr(item, z_in.read(item.filename))

    # ── 4. Summary ────────────────────────────────────────────────────────────

    total_ath = sum(ath_by_type.values())
    print(f"\n{SEP}")
    print("SUMMARY")
    print(SEP)
    print(f"  Styles   : {n_remapped} remapped, {n_unchanged} unchanged, {n_dropped} dropped")
    print(f"  Clubs    : {clubs_matched} matched, {clubs_new} new/unmatched")
    if clubs_fuzzy_warn:
        print(f"             ⚠ {len(clubs_fuzzy_warn)} fuzzy club match(es) — verify manually:")
        for s in clubs_fuzzy_warn:
            print(f"               {s}")
    print(f"  Athletes : {total_ath} total")
    print(f"             {ath_by_type.get('license',0)} by license, "
          f"{ath_by_type.get('exact',0)} by exact name, "
          f"{ath_by_type.get('fuzzy',0)} fuzzy, "
          f"{ath_by_type.get('NEW',0)} new/unmatched")
    if ath_fuzzy_warn:
        print(f"             ⚠ {len(ath_fuzzy_warn)} fuzzy athlete match(es) — verify manually:")
        for s in ath_fuzzy_warn[:10]:
            print(f"               {s}")
        if len(ath_fuzzy_warn) > 10:
            print(f"               … and {len(ath_fuzzy_warn) - 10} more (search '⚠ verify' above)")
    print(f"\n  Output   : {output_path}")
    print(f"{'='*64}\n")


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Normalize a historic results LXF against a current meet template.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("template", type=Path, help="Meet template .lxf")
    ap.add_argument("entries",  type=Path, help="Entries .lxf (canonical clubs + athletes)")
    ap.add_argument("historic", type=Path, help="Historic results .lxf to normalize")
    args = ap.parse_args()

    for p, label in [(args.template, "template"), (args.entries, "entries"), (args.historic, "historic")]:
        if not p.exists():
            print(f"error: {label} file not found: {p}", file=sys.stderr)
            sys.exit(1)

    normalize(args.template, args.entries, args.historic)


if __name__ == "__main__":
    main()
