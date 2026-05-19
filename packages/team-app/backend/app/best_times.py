"""Parse a Lenex results .lxf and populate best times as qttime on swimresult rows.

Best times are stored on the swimresult row itself (qttime, qtcourse, qtdate, qtname).
A separate "best_times" table no longer exists — instead we maintain a dedicated
swimresult row per (athlete, swimevent) with entrytime=NULL, swimtime=NULL that
carries the qualification time fields. When a registration is created, the qt fields
are merged onto the registration's swimresult row.

For backward compatibility with the import flow, this module also maintains a
lightweight in-memory best-time cache that the registration page queries.
"""
from __future__ import annotations

import re
import zipfile
from datetime import date as _date
from io import BytesIO
from xml.etree import ElementTree as ET  # noqa: F401
from defusedxml.ElementTree import fromstring as _ET_fromstring

import json as _json

from sqlalchemy.orm import Session
from .models import (
    Athlete, BsGlobal, Club, SwimEvent, SwimResult, SwimStyle,
    gender_from_str, course_from_str, COURSE_LCM, COURSE_SCM,
)


def _lenex_time_to_ms(t: str) -> int | None:
    """Convert Lenex time 'HH:MM:SS.hh' or 'MM:SS.hh' to ms."""
    if not t or t == "NT":
        return None
    m = re.match(r"(\d+):(\d+):(\d+)\.(\d+)", t)
    if m:
        return (int(m.group(1)) * 3600000 + int(m.group(2)) * 60000
                + int(m.group(3)) * 1000 + int(m.group(4)) * 10)
    m = re.match(r"(\d+):(\d+)\.(\d+)", t)
    if m:
        return (int(m.group(1)) * 60000 + int(m.group(2)) * 1000
                + int(m.group(3)) * 10)
    m = re.match(r"(\d+)\.(\d+)", t)
    if m:
        return int(m.group(1)) * 1000 + int(m.group(2)) * 10
    return None


def _find_or_create_athlete(db: Session, first: str, last: str, license: str, club=None) -> Athlete | None:
    """Match athlete by license first, then name. Create if not found and club provided."""
    if license:
        ath = db.query(Athlete).filter(Athlete.license == license).first()
        if ath:
            return ath
    ath = db.query(Athlete).filter(
        Athlete.firstname == first, Athlete.lastname == last
    ).first()
    if ath:
        return ath
    if not club:
        return None
    ath = Athlete(firstname=first, lastname=last, gender=1, clubid=club.clubid, license=license)
    db.add(ath)
    db.flush()
    return ath


# ---------------------------------------------------------------------------
# Best-time storage: we store best times in bsglobal as a JSON blob keyed by
# "bt_{athlete_id}" with structure: {style_uid: {course: {time_ms, date, source}}}
# This avoids needing a separate table while keeping fast lookups.
# ---------------------------------------------------------------------------

def _bt_key(athlete_id: int) -> str:
    return f"bt_{athlete_id}"


def get_best_times(db: Session, athlete_id: int) -> dict:
    """Return {style_uid: {"LCM": time_ms, "SCM": time_ms, "date": ...}} for an athlete."""
    cfg = db.query(BsGlobal).get(_bt_key(athlete_id))
    if not cfg or not cfg.data:
        return {}
    try:
        return _json.loads(cfg.data)
    except (ValueError, TypeError):
        return {}


def _save_best_times(db: Session, athlete_id: int, bt_data: dict):
    """Persist best-time data for an athlete."""
    key = _bt_key(athlete_id)
    payload = _json.dumps(bt_data)
    cfg = db.query(BsGlobal).get(key)
    if cfg:
        cfg.data = payload
    else:
        db.add(BsGlobal(name=key, data=payload))


def _upsert_best_time(db: Session, athlete_id: int, style_uid: int,
                      time_ms: int, course: str, source: str,
                      recorded_on: _date | None = None) -> bool:
    """Upsert a best time in the bsglobal JSON store.
    Returns True when a row was inserted or improved."""
    bt_data = get_best_times(db, athlete_id)
    uid_key = str(style_uid)

    if uid_key not in bt_data:
        bt_data[uid_key] = {}

    style_data = bt_data[uid_key]
    existing = style_data.get(course)
    date_str = str(recorded_on) if recorded_on else None

    if existing:
        if time_ms < existing.get("time_ms", 999999999):
            style_data[course] = {"time_ms": time_ms, "source": source, "date": date_str}
            improved = True
        else:
            if date_str and not existing.get("date"):
                existing["date"] = date_str
            improved = False
    else:
        style_data[course] = {"time_ms": time_ms, "source": source, "date": date_str}
        improved = True

    # Sync date across courses
    if date_str:
        for c in ("LCM", "SCM"):
            if c in style_data and c != course:
                style_data[c]["date"] = date_str

    bt_data[uid_key] = style_data
    _save_best_times(db, athlete_id, bt_data)
    return improved


def delete_best_times(db: Session, athlete_id: int):
    """Delete all best times for an athlete."""
    key = _bt_key(athlete_id)
    cfg = db.query(BsGlobal).get(key)
    if cfg:
        db.delete(cfg)


def get_best_time_for_style(db: Session, athlete_id: int, style_uid: int, course: str) -> int | None:
    """Get best time in ms for a specific style and course."""
    bt_data = get_best_times(db, athlete_id)
    uid_key = str(style_uid)
    if uid_key not in bt_data:
        return None
    entry = bt_data[uid_key].get(course)
    return entry["time_ms"] if entry else None


def get_best_time_date(db: Session, athlete_id: int, style_uid: int, course: str) -> _date | None:
    """Get the recorded_on date for a best time."""
    bt_data = get_best_times(db, athlete_id)
    uid_key = str(style_uid)
    if uid_key not in bt_data:
        return None
    entry = bt_data[uid_key].get(course)
    if not entry or not entry.get("date"):
        return None
    try:
        return _date.fromisoformat(entry["date"])
    except (ValueError, TypeError):
        return None


def expire_old_best_times(db: Session, athlete_id: int, max_age_months: int) -> set:
    """Remove best times older than max_age_months. Returns set of expired style_uids."""
    from datetime import date as _d
    import calendar as _cal

    bt_data = get_best_times(db, athlete_id)
    if not bt_data:
        return set()

    today = _d.today()
    m = max_age_months
    cutoff_month = today.month - (m % 12)
    cutoff_year = today.year - (m // 12)
    if cutoff_month <= 0:
        cutoff_month += 12
        cutoff_year -= 1
    cutoff = _d(cutoff_year, cutoff_month,
                min(today.day, _cal.monthrange(cutoff_year, cutoff_month)[1]))

    expired_styles = set()
    for uid_key, style_data in list(bt_data.items()):
        for course, entry in list(style_data.items()):
            if entry.get("date"):
                try:
                    d = _d.fromisoformat(entry["date"])
                    if d < cutoff:
                        expired_styles.add(int(uid_key))
                except (ValueError, TypeError):
                    pass

    # Remove entire style entries that have expired times
    for uid_key in [str(uid) for uid in expired_styles]:
        if uid_key in bt_data:
            del bt_data[uid_key]

    if expired_styles:
        _save_best_times(db, athlete_id, bt_data)

    return expired_styles


def load_best_times(db: Session, file_bytes: bytes, source: str = "") -> dict:
    """Parse results .lxf and upsert best times. Returns counts."""
    with zipfile.ZipFile(BytesIO(file_bytes)) as z:
        lef_name = [n for n in z.namelist() if n.endswith(".lef")][0]
        xml_bytes = z.read(lef_name)

    root = _ET_fromstring(xml_bytes)

    # Get course and date from MEET element
    meet_el = root.find(".//MEET")
    course = meet_el.get("course", "LCM") if meet_el is not None else "LCM"
    if course not in ("LCM", "SCM"):
        course = "LCM"
    recorded_on: _date | None = None
    if meet_el is not None:
        for date_attr in ("startdate", "date"):
            raw = meet_el.get(date_attr, "")
            if raw:
                try:
                    recorded_on = _date.fromisoformat(raw[:10])
                except ValueError:
                    pass
                if recorded_on:
                    break
    if recorded_on is None:
        for sess_el in root.iter("SESSION"):
            raw = sess_el.get("date", "")
            if raw:
                try:
                    d = _date.fromisoformat(raw[:10])
                    if recorded_on is None or d < recorded_on:
                        recorded_on = d
                except ValueError:
                    pass
    if recorded_on is None:
        recorded_on = _date.today()

    # Build eventid -> style_uid map
    event_style: dict[str, int] = {}
    style_names: dict[int, str] = {}
    for event_el in root.iter("EVENT"):
        eid = event_el.get("eventid", "")
        for ss in event_el.iter("SWIMSTYLE"):
            uid_raw = ss.get("swimstyleid") or ss.get("stroke", "")
            try:
                uid_int = int(uid_raw)
            except (ValueError, TypeError):
                continue
            event_style[eid] = uid_int
            name = ss.get("name", "")
            if name and uid_int not in style_names:
                style_names[uid_int] = name

    updated = 0
    skipped = 0
    athletes_created = 0
    athlete_by_lenex_id: dict[str, Athlete] = {}

    for club_el in root.iter("CLUB"):
        club_code = club_el.get("code", "")
        club_name = club_el.get("name", "")
        if club_code:
            club = db.query(Club).filter(Club.code == club_code).first()
        else:
            club = db.query(Club).filter(Club.name == club_name).first()
        for ath_el in club_el.iter("ATHLETE"):
            first = ath_el.get("firstname", "")
            last = ath_el.get("lastname", "")
            license_val = ath_el.get("license", "")
            gender_str = ath_el.get("gender", "M")
            bd_str = ath_el.get("birthdate", "")
            lenex_aid = ath_el.get("athleteid", "")

            athlete = _find_or_create_athlete(db, first, last, license_val, club)
            if not athlete:
                skipped += 1
                continue
            if lenex_aid:
                athlete_by_lenex_id[lenex_aid] = athlete
            # Update gender/birthdate if newly created
            if athlete.athleteid is None or (not athlete.birthdate and bd_str):
                athlete.gender = gender_from_str(gender_str)
                if bd_str:
                    try:
                        athlete.birthdate = _date.fromisoformat(bd_str)
                    except ValueError:
                        pass
                athletes_created += 1

            # Collect best candidate times per (event, course) pair
            event_times: dict[tuple[str, str], list[tuple[int, _date | None]]] = {}
            for entry_el in ath_el.iter("ENTRY"):
                eid = entry_el.get("eventid", "")
                t = _lenex_time_to_ms(entry_el.get("entrytime", ""))
                if t and eid:
                    ec = entry_el.get("entrycourse", "") or course
                    if ec not in ("LCM", "SCM"):
                        ec = course
                    entry_date: _date | None = None
                    mi = entry_el.find("MEETINFO")
                    if mi is not None:
                        raw_d = mi.get("date", "")
                        if raw_d:
                            try:
                                entry_date = _date.fromisoformat(raw_d[:10])
                            except ValueError:
                                pass
                    event_times.setdefault((eid, ec), []).append((t, entry_date))
            for result_el in ath_el.iter("RESULT"):
                eid = result_el.get("eventid", "")
                t = _lenex_time_to_ms(result_el.get("swimtime", ""))
                if t and eid:
                    event_times.setdefault((eid, course), []).append((t, recorded_on))

            for (eid, ev_course), times in event_times.items():
                style_uid = event_style.get(eid)
                if not style_uid:
                    continue
                best_time, best_date = min(times, key=lambda x: x[0])
                if _upsert_best_time(db, athlete.athleteid, style_uid,
                                     best_time, ev_course, source, best_date):
                    updated += 1

    # Relay BT
    for relay_el in root.iter("RELAY"):
        roster: list[Athlete] = []
        for pos_el in relay_el.iter("RELAYPOSITION"):
            ath = athlete_by_lenex_id.get(pos_el.get("athleteid", ""))
            if ath and ath not in roster:
                roster.append(ath)
        if not roster:
            continue

        relay_event_times: dict[str, list[int]] = {}
        for entry_el in relay_el.iter("ENTRY"):
            eid = entry_el.get("eventid", "")
            t = _lenex_time_to_ms(entry_el.get("entrytime", ""))
            if t and eid:
                relay_event_times.setdefault(eid, []).append(t)
        for result_el in relay_el.iter("RESULT"):
            eid = result_el.get("eventid", "")
            t = _lenex_time_to_ms(result_el.get("swimtime", ""))
            if t and eid:
                relay_event_times.setdefault(eid, []).append(t)

        for eid, times in relay_event_times.items():
            style_uid = event_style.get(eid)
            if not style_uid:
                continue
            best = min(times)
            for ath in roster:
                if _upsert_best_time(db, ath.athleteid, style_uid, best, course, source, recorded_on):
                    updated += 1

    db.commit()

    # Persist style uid→name
    if style_names:
        try:
            cfg = db.query(BsGlobal).get("style_names_json")
            existing: dict[int, str] = _json.loads(cfg.data) if cfg else {}
            merged = {int(k): v for k, v in existing.items()}
            for uid, name in style_names.items():
                if uid not in merged:
                    merged[uid] = name
            payload = _json.dumps({str(k): v for k, v in merged.items()})
            if cfg:
                cfg.data = payload
            else:
                db.add(BsGlobal(name="style_names_json", data=payload))
            db.commit()
        except Exception:
            db.rollback()

    return {"times_updated": updated, "athletes_skipped": skipped, "athletes_created": athletes_created}
