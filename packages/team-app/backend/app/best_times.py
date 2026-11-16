# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
#
# This file is part of Sauvetage Sportif.
#
# Sauvetage Sportif is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Sauvetage Sportif is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with Sauvetage Sportif. If not, see <https://www.gnu.org/licenses/>.

"""Best times per (member, swim style, course).

Two sources, one resolver (`get_best_times_for_member`) used by registration,
the public Best Times page and the LXF exports:

1. Coach best time (`athlete_best_times`) — the entry time a coach typed for
   a registration, captured when the meet is closed (`capture_coach_best_times`)
   and lowered to that meet's own result when the result is faster
   (`refresh_best_times_from_meet`). Authoritative while `entered_date` is
   within the expiry window, even if a faster historical result exists.
2. Otherwise the fastest official, non-HC historical result (`results`) whose
   own date is within the expiry window.

Expiry: anything dated more than `max_age_months` ago is ignored.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from sqlalchemy import DateTime, func, or_
from sqlalchemy.orm import Session, joinedload

from .models import SwimStyle
from .models_team import Result, Member, AthleteBestTime, Meet
from .meet_config import get_active_meetsid, _get_meet_config, _get_meet_type


# --- Core query functions ---


def _result_date():
    """A result's effective date: its own eventdate, else its meet's start date.

    Most historical rows (MDB/older imports) never got a per-result eventdate,
    only meets.mindate — without this fallback they could never expire.
    """
    return func.coalesce(Result.eventdate, Meet.mindate, type_=DateTime)


def _eligible_results(db: Session, cutoff: date, member_id: int | None = None):
    """Official, non-HC, timed results not older than cutoff.

    Rows expose membersid/stylesid/course/totaltime/eventdate, eventdate being
    the effective date (see _result_date). Rows with no date at all (neither
    result nor meet) are kept rather than silently dropped.
    """
    eff = _result_date()
    q = db.query(
        Result.membersid, Result.stylesid, Result.course, Result.totaltime,
        eff.label("eventdate"),
    ).outerjoin(Meet, Meet.meetsid == Result.meetsid).filter(
        Result.membersid.isnot(None),
        Result.stylesid.isnot(None),
        Result.totaltime.isnot(None),
        Result.totaltime > 0,
        Result.resulttyp == 0,
        or_(Result.resultstatus.is_(None), Result.resultstatus != 4),  # exclude HC/EXH
        or_(eff.is_(None), eff >= datetime.combine(cutoff, datetime.min.time())),
    )
    if member_id is not None:
        q = q.filter(Result.membersid == member_id)
    return q


def _valid_coach_rows(db: Session, cutoff: date, member_id: int | None = None):
    q = db.query(AthleteBestTime).filter(
        AthleteBestTime.entered_date >= datetime.combine(cutoff, datetime.min.time()),
        AthleteBestTime.time_ms > 0,
    )
    if member_id is not None:
        q = q.filter(AthleteBestTime.membersid == member_id)
    return q


def _resolve(results, coach_rows) -> dict[int, dict]:
    """{membersid: {"{stylesid}": {"LCM": {...}, "SCM": {...}}}}"""
    best: dict[tuple[int, int, int], tuple[int, datetime | None, str]] = {}
    for r in results:
        key = (r.membersid, r.stylesid, r.course)
        cur = best.get(key)
        # Fastest wins; on a tie keep the most recent date.
        if (cur is None or r.totaltime < cur[0]
                or (r.totaltime == cur[0] and r.eventdate and (cur[1] is None or r.eventdate > cur[1]))):
            best[key] = (r.totaltime, r.eventdate, "result")
    for c in coach_rows:  # coach value is authoritative while valid
        best[(c.membersid, c.stylesid, c.course)] = (c.time_ms, c.entered_date, "coach")

    out: dict[int, dict] = {}
    for (member_id, style_id, course_int), (time_ms, when, source) in best.items():
        course_key = _course_str(course_int)
        if not course_key:
            continue
        out.setdefault(member_id, {}).setdefault(str(style_id), {})[course_key] = {
            "time_ms": time_ms,
            "date": when.strftime("%Y-%m-%d") if when else None,
            "source": source,
        }
    return out


def get_best_times_for_member(
    db: Session,
    member_id: int,
    max_age_months: int = 18,
) -> dict[str, dict]:
    """Resolved best times for one member (see module docstring for rules).

    Returns: {
        "{stylesid}": {
            "LCM": {"time_ms": int, "date": str, "source": "coach"|"result"},
            "SCM": {...},
        }
    }
    """
    cutoff = _cutoff_date(max_age_months)
    resolved = _resolve(
        _eligible_results(db, cutoff, member_id).all(),
        _valid_coach_rows(db, cutoff, member_id).all(),
    )
    return resolved.get(member_id, {})


# Alias for backward compatibility
get_best_times = get_best_times_for_member


def get_public_best_times(db: Session, max_age_months: int = 18) -> dict:
    """Best times for every member with a qualifying result, grouped by club.

    Powers the public /results Best Times tab. Pure SQLAlchemy — no FastAPI
    import here on purpose, so it stays importable (and testable) without
    the full backend dependency stack.

    Returns: {
        "styles": [{"uid": int, "name": str}, ...],
        "clubs": [{"name": str, "athletes": [{"name": str, "times": {"{uid}_LCM": ms, ...}}]}],
        "course": str,  # current meet's course (LCM/SCY/SCM), for display preference
    }
    """
    # Same resolver as registration, computed in bulk (results + coach rows).
    cutoff = _cutoff_date(max_age_months)
    athlete_bt = _resolve(
        _eligible_results(db, cutoff).all(),
        _valid_coach_rows(db, cutoff).all(),
    )
    all_uids: set[int] = {int(uid) for bt in athlete_bt.values() for uid in bt}

    style_uids = sorted(all_uids)
    styles = []
    for uid in style_uids:
        style = db.get(SwimStyle, uid)
        name = style.name if style else f"ID{uid}"
        styles.append({"uid": uid, "name": name})

    # Load athletes with clubs
    athlete_ids = list(athlete_bt.keys())
    athletes_db = db.query(Member).options(
        joinedload(Member.club)
    ).filter(Member.membersid.in_(athlete_ids)).all() if athlete_ids else []
    athlete_map = {a.membersid: a for a in athletes_db}

    # Group by club
    clubs_map: dict[int, dict] = {}
    for athlete_id, bt_data in athlete_bt.items():
        a = athlete_map.get(athlete_id)
        if not a or not a.club:
            continue
        c = a.club
        if c.clubsid not in clubs_map:
            clubs_map[c.clubsid] = {"name": c.name, "athletes": []}
        times = {}
        for uid_str, style_data in bt_data.items():
            if "LCM" in style_data:
                times[f"{uid_str}_LCM"] = style_data["LCM"]["time_ms"]
            if "SCM" in style_data:
                times[f"{uid_str}_SCM"] = style_data["SCM"]["time_ms"]
        clubs_map[c.clubsid]["athletes"].append({
            "name": f"{a.lastname}, {a.firstname}",
            "times": times,
        })

    # Sort clubs and athletes
    clubs = sorted(clubs_map.values(), key=lambda c: c["name"])
    for club in clubs:
        club["athletes"].sort(key=lambda a: a["name"])

    # Determine course (current meet's course, used to pick LCM vs SCM when both exist)
    course = _get_meet_config(db, get_active_meetsid(db), "meet_course") or "LCM"

    return {"styles": styles, "clubs": clubs, "course": course}


def get_best_time(
    db: Session,
    member_id: int,
    style_id: int,
    course: str,
    max_age_months: int = 18,
) -> int | None:
    """Resolved best time for a specific member/style/course combination."""
    entry = get_best_times_for_member(db, member_id, max_age_months).get(str(style_id), {}).get(course)
    return entry["time_ms"] if entry else None


def get_best_time_date(
    db: Session,
    member_id: int,
    style_id: int,
    course: str,
    max_age_months: int = 18,
) -> date | None:
    """Date of the resolved best time for a specific member/style/course."""
    entry = get_best_times_for_member(db, member_id, max_age_months).get(str(style_id), {}).get(course)
    if not entry or not entry["date"]:
        return None
    return date.fromisoformat(entry["date"])


# --- Writers: meet close / results import ---


def capture_coach_best_times(db: Session, meetsid: int | None, max_age_months: int = 18) -> int:
    """Store coaches' registration entry times of a live meet as best times.

    Call when the meet is closed, before its registrations are reset, and
    before the meet's own results are imported (so the comparison below sees
    the best time the coach was looking at). For each individual registration
    with an entry time on the meet's course:
    - entry time equal to the currently resolved best time → nothing to do
      (it's the pre-filled default; don't re-date a historical value);
    - otherwise → upsert it as the coach best time, dated the meet's start
      date (today if the meet has none).
    Beach meets are skipped (no times). Returns the number of rows written.
    """
    from .models import SwimResult, SwimEvent

    if not meetsid:
        return 0
    meet = db.get(Meet, meetsid)
    meet_type = ((meet.meet_type if meet else None) or _get_meet_type(db)).upper()
    if meet_type == "BEACH":
        return 0
    course_str = _get_meet_config(db, meetsid, "meet_course") or "LCM"
    course_int = _course_int(course_str)
    if course_int is None:
        return 0
    entered = _meet_start(db, meetsid, meet)

    rows = (
        db.query(SwimResult.athleteid, SwimEvent.swimstyleid, SwimResult.entrytime)
        .join(SwimEvent, (SwimResult.swimeventid == SwimEvent.swimeventid)
              & (SwimResult.meetsid == SwimEvent.meetsid))
        .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
        .filter(
            SwimResult.meetsid == meetsid,
            SwimResult.athleteid.isnot(None),
            SwimResult.entrytime.isnot(None),
            SwimResult.entrytime > 0,
            or_(SwimStyle.relaycount.is_(None), SwimStyle.relaycount <= 1),
        )
        .all()
    )
    # One value per athlete/style (several age-code rows → keep the fastest)
    entries: dict[tuple[int, int], int] = {}
    for athlete_id, style_id, entry_ms in rows:
        key = (athlete_id, style_id)
        if key not in entries or entry_ms < entries[key]:
            entries[key] = entry_ms

    resolved_cache: dict[int, dict] = {}
    written = 0
    for (athlete_id, style_id), entry_ms in entries.items():
        if athlete_id not in resolved_cache:
            resolved_cache[athlete_id] = get_best_times_for_member(db, athlete_id, max_age_months)
        current = resolved_cache[athlete_id].get(str(style_id), {}).get(course_str)
        if current and current["time_ms"] == entry_ms:
            continue
        row = db.get(AthleteBestTime, (athlete_id, style_id, course_int))
        if row is None:
            db.add(AthleteBestTime(membersid=athlete_id, stylesid=style_id, course=course_int,
                                   time_ms=entry_ms, entered_date=entered))
        else:
            row.time_ms = entry_ms
            row.entered_date = entered
        written += 1
    db.flush()
    return written


def _meet_start(db: Session, meetsid: int, meet) -> datetime:
    """Live meet start: meets.mindate, else earliest session date, else today.

    Same fallback chain as invoices._meet_year — live meets rarely set mindate.
    Matches the date the results import stamps on this meet's own results, so
    refresh_best_times_from_meet can still lower a value captured here.
    """
    from .models import SwimSession

    if meet and meet.mindate:
        return meet.mindate
    first = (
        db.query(SwimSession.startdate)
        .filter(SwimSession.meetsid == meetsid, SwimSession.startdate.isnot(None))
        .order_by(SwimSession.startdate)
        .first()
    )
    if first and first[0]:
        return first[0]
    return datetime.combine(date.today(), datetime.min.time())


def refresh_best_times_from_meet(db: Session, meetsid: int) -> int:
    """Lower stored coach best times to this meet's faster official results.

    Called at the end of every results import. A result replaces the stored
    time and date only when it is faster and not older than the stored entry
    (importing an old historical meet never overrides a newer coach value).
    Athletes without a stored coach row need nothing: their best time already
    comes from the results table. Returns the number of rows updated.
    """
    db.flush()
    meet = db.get(Meet, meetsid)
    meet_date = meet.mindate if meet else None
    results = db.query(Result).filter(
        Result.meetsid == meetsid,
        Result.membersid.isnot(None),
        Result.stylesid.isnot(None),
        Result.totaltime.isnot(None),
        Result.totaltime > 0,
        Result.resulttyp == 0,
        or_(Result.resultstatus.is_(None), Result.resultstatus != 4),
    ).all()
    updated: set[tuple[int, int, int]] = set()
    for r in results:
        row = db.get(AthleteBestTime, (r.membersid, r.stylesid, r.course))
        if row is None or r.totaltime >= row.time_ms:
            continue
        when = r.eventdate or meet_date
        if when and row.entered_date and when.date() < row.entered_date.date():
            continue
        row.time_ms = r.totaltime
        if when:
            row.entered_date = when
        updated.add((r.membersid, r.stylesid, r.course))
    db.flush()
    return len(updated)


# --- Shared utilities (used by historical_import.py) ---


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


def _find_or_create_athlete(db: Session, first: str, last: str, license: str, club=None, gender: int = 1) -> Member | None:
    """Match athlete by license first, then name. Create if not found and club provided."""
    if license:
        member = db.query(Member).filter(Member.license == license).first()
        if member:
            return member
    member = db.query(Member).filter(
        Member.firstname == first, Member.lastname == last
    ).first()
    if member:
        return member
    if not club:
        return None
    member = Member(firstname=first, lastname=last, gender=gender, clubsid=club.clubsid, license=license)
    db.add(member)
    db.flush()
    return member


# --- Internal helpers ---


def _cutoff_date(max_age_months: int) -> date:
    """Calculate the cutoff date for expiry."""
    today = date.today()
    year = today.year
    month = today.month - max_age_months
    while month <= 0:
        month += 12
        year -= 1
    return date(year, month, today.day if today.day <= 28 else 28)


def _course_str(course_int: int | None) -> str | None:
    """Convert course integer to string."""
    if course_int == 1:
        return "LCM"
    if course_int == 2:
        return "SCY"
    if course_int == 3:
        return "SCM"
    return None


def _course_int(course_str: str) -> int | None:
    """Convert course string to integer."""
    if course_str == "LCM":
        return 1
    if course_str == "SCY":
        return 2
    if course_str == "SCM":
        return 3
    return None
