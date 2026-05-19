#!/usr/bin/env python3
"""Generate a deterministic Lenex results .lxf simulating SPLASH meet output.

Combines the meet template (events) with the synthetic entries (athletes) to
produce a results file the app can ingest via /api/upload/results. Each
matched athlete gets RESULT rows on a handful of age/gender-appropriate
events, with plausible swim times.

Run from repo root:

    python tests/generate_test_results.py \
        --meet tests/fixtures/meet_template.lxf \
        --entries tests/fixtures/test_entries.lxf \
        --out tests/fixtures/test_results.lxf
"""
from __future__ import annotations

import argparse
import random
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

DEFAULT_SEED = 20260509
AGE_DATE_YEAR = 2026


def _read_lef(path: Path) -> bytes:
    with zipfile.ZipFile(path) as z:
        name = next(n for n in z.namelist() if n.endswith(".lef"))
        return z.read(name)


def _ms_to_lenex(ms: int) -> str:
    h = ms // 3600000
    m = (ms % 3600000) // 60000
    s = (ms % 60000) // 1000
    cs = (ms % 1000) // 10
    if h:
        return f"{h:02d}:{m:02d}:{s:02d}.{cs:02d}"
    return f"{m:02d}:{s:02d}.{cs:02d}"


def _category_matches(age: int, agemin: int, agemax: int) -> bool:
    if agemax == -1:
        return age >= agemin
    return agemin <= age <= agemax


def _gender_matches(ath_g: str, ev_g: str) -> bool:
    if not ev_g or ev_g in ("X", "A", "0"):
        return True  # mixed / all
    return ath_g == ev_g


def _seconds_per_100m(age: int) -> float:
    if age >= 19:
        return 70
    if age >= 15:
        return 78
    if age >= 13:
        return 90
    if age >= 11:
        return 105
    return 130


def _generate_time_ms(rng: random.Random, distance: int, age: int) -> int:
    base = (max(distance, 25) / 100.0) * _seconds_per_100m(age)
    secs = base * rng.uniform(0.9, 1.2)
    return int(secs * 1000)


def parse_meet_events(meet_path: Path):
    root = ET.fromstring(_read_lef(meet_path))
    meet_el = root.find(".//MEET")
    course = meet_el.get("course", "LCM") if meet_el is not None else "LCM"

    events = []
    for ev in root.iter("EVENT"):
        ss = ev.find("SWIMSTYLE")
        if ss is None:
            continue
        agegroups = []
        for ag in ev.iter("AGEGROUP"):
            try:
                agegroups.append({
                    "agemin": int(ag.get("agemin", "1")),
                    "agemax": int(ag.get("agemax", "-1")),
                })
            except ValueError:
                continue
        events.append({
            "eventid": ev.get("eventid", ""),
            "swimstyleid": ss.get("swimstyleid", ""),
            "style_name": ss.get("name", ""),
            "gender": ev.get("gender", ""),
            "distance": int(ss.get("distance", "0") or 0),
            "relaycount": int(ss.get("relaycount", "1") or 1),
            "agegroups": agegroups,
        })
    return course, events


def parse_entries(entries_path: Path):
    root = ET.fromstring(_read_lef(entries_path))
    clubs = []
    for club_el in root.iter("CLUB"):
        athletes = []
        for ath_el in club_el.iter("ATHLETE"):
            bd = ath_el.get("birthdate", "")
            try:
                year = int(bd[:4])
            except ValueError:
                continue
            athletes.append({
                "first_name": ath_el.get("firstname", ""),
                "last_name": ath_el.get("lastname", ""),
                "gender": ath_el.get("gender", "M"),
                "birthdate": bd,
                "license": ath_el.get("license", ""),
                "year": year,
            })
        clubs.append({
            "name": club_el.get("name", ""),
            "code": club_el.get("code", ""),
            "nation": club_el.get("nation", ""),
            "athletes": athletes,
        })
    return clubs


def build_results(clubs, events, seed: int = DEFAULT_SEED,
                  events_per_athlete: int = 3):
    rng = random.Random(seed)
    out_clubs = []
    for c in clubs:
        out_athletes = []
        for ath in c["athletes"]:
            age = AGE_DATE_YEAR - ath["year"]
            # Find events that match gender and contain an age group covering age
            candidates = []
            for ev in events:
                if ev["relaycount"] > 1:
                    continue
                if not _gender_matches(ath["gender"], ev["gender"]):
                    continue
                if not any(_category_matches(age, ag["agemin"], ag["agemax"])
                           for ag in ev["agegroups"]):
                    continue
                candidates.append(ev)
            if not candidates:
                continue
            n = min(events_per_athlete, len(candidates))
            chosen = rng.sample(candidates, n)
            results = []
            for ev in chosen:
                t_ms = _generate_time_ms(rng, ev["distance"], age)
                results.append({"eventid": ev["eventid"],
                                "swimtime": _ms_to_lenex(t_ms)})
            out_athletes.append({**ath, "results": results})
        out_clubs.append({**c, "athletes": out_athletes})
    return out_clubs


def write_lxf(course: str, events: list[dict], clubs: list[dict],
              out_path: Path) -> None:
    """Emit a results .lxf with MEET + flat EVENT list + CLUBS/ATHLETES/RESULTS.

    The best_times parser only needs each EVENT to carry its eventid +
    SWIMSTYLE.swimstyleid, so we skip the SESSIONS hierarchy.
    """
    root = ET.Element("LENEX", version="3.0")
    meets = ET.SubElement(root, "MEETS")
    meet = ET.SubElement(meets, "MEET", {
        "name": "Test Results Meet",
        "city": "Test City",
        "course": course,
        "startdate": f"{AGE_DATE_YEAR - 1}-06-01",
    })
    ET.SubElement(meet, "AGEDATE", value=f"{AGE_DATE_YEAR}-12-31", type="DATE")

    sessions = ET.SubElement(meet, "SESSIONS")
    session = ET.SubElement(sessions, "SESSION", {
        "number": "1", "date": f"{AGE_DATE_YEAR}-12-31", "course": course,
    })
    evts = ET.SubElement(session, "EVENTS")
    for ev in events:
        ev_xml = ET.SubElement(evts, "EVENT", {
            "eventid": ev["eventid"],
            "gender": ev["gender"] or "X",
            "round": "TIM",
        })
        ss_attrs = {
            "swimstyleid": ev["swimstyleid"],
            "distance": str(ev["distance"]),
            "relaycount": str(ev["relaycount"]),
            "stroke": "UNKNOWN",
        }
        if ev.get("style_name"):
            ss_attrs["name"] = ev["style_name"]
        ET.SubElement(ev_xml, "SWIMSTYLE", ss_attrs)

    clubs_xml = ET.SubElement(meet, "CLUBS")
    for c in clubs:
        club_xml = ET.SubElement(clubs_xml, "CLUB", {
            "name": c["name"], "code": c["code"], "nation": c["nation"],
        })
        athletes_xml = ET.SubElement(club_xml, "ATHLETES")
        for ath in c["athletes"]:
            ath_xml = ET.SubElement(athletes_xml, "ATHLETE", {
                "firstname": ath["first_name"],
                "lastname": ath["last_name"],
                "gender": ath["gender"],
                "birthdate": ath["birthdate"],
                "license": ath["license"],
            })
            results_xml = ET.SubElement(ath_xml, "RESULTS")
            for r in ath["results"]:
                ET.SubElement(results_xml, "RESULT", {
                    "eventid": r["eventid"],
                    "swimtime": r["swimtime"],
                    "status": "OFFICIAL",
                })

    xml = ET.tostring(root, encoding="unicode", xml_declaration=True).encode("utf-8")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("results.lef", xml)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--meet", type=Path, required=True)
    p.add_argument("--entries", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--seed", type=int, default=DEFAULT_SEED)
    p.add_argument("--events-per-athlete", type=int, default=3)
    args = p.parse_args()

    course, events = parse_meet_events(args.meet)
    clubs = parse_entries(args.entries)
    results = build_results(clubs, events, seed=args.seed,
                            events_per_athlete=args.events_per_athlete)
    write_lxf(course, events, results, args.out)

    n_athletes = sum(len(c["athletes"]) for c in results)
    n_results = sum(len(a["results"]) for c in results for a in c["athletes"])
    print(f"Wrote {args.out} — {len(results)} clubs, {n_athletes} athletes, "
          f"{n_results} results")


if __name__ == "__main__":
    main()
