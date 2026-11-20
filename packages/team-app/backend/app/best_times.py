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

import math

from datetime import date, datetime
from sqlalchemy import DateTime, func, or_, true
from sqlalchemy.orm import Session, joinedload

from .models import SwimStyle
from .models_team import Result, Member, AthleteBestTime, Meet
from .meet_config import get_active_meetsid, _get_meet_config, _get_meet_course, _get_meet_type


# Beach styles (601-624) are ranked, not timed: their "results" are finishing
# positions stored as ms (1st = 1000, 2nd = 2000…), meaningless as best times.
# Pool styles are 5xx; the ranges never overlap (see the meet-type detection in
# routers/api.py, which uses the same >= 600 threshold).
BEACH_STYLE_MIN = 600

# Pool styles shorter than a pool length are throws from the deck — "Lancer de
# précision" (4 m / 7 m) and "Lancer de la corde" (10 m / 12.5 m): the pool's
# length doesn't matter, so a 50 m and a 25 m result are the same event. Their
# best time is the best across both courses, shown as one value. Same "< 25 m"
# rule meet-app's combined events use (combinedEvents.ts). distance 0/NULL is
# "unknown" (SERC has 0), never course-free.
COURSE_FREE_MAX_DISTANCE = 25


def course_free_style_ids(db: Session) -> set[int]:
    """Individual pool styles whose best time ignores the course (see above)."""
    return {sid for (sid,) in db.query(SwimStyle.swimstyleid).filter(
        SwimStyle.swimstyleid < BEACH_STYLE_MIN,
        SwimStyle.distance > 0,
        SwimStyle.distance < COURSE_FREE_MAX_DISTANCE,
        or_(SwimStyle.relaycount.is_(None), SwimStyle.relaycount <= 1),
    ).all()}


def team_style_ids(db: Session) -> set[int]:
    """Team events (relaycount > 1: relays, Lancer de la corde, SERC). A
    best time is an athlete's own: team times never count, even if a file
    recorded them per athlete."""
    return {sid for (sid,) in db.query(SwimStyle.swimstyleid).filter(SwimStyle.relaycount > 1).all()}


def pick_course(style_data: dict, course: str, course_free: bool) -> dict | None:
    """The best-time entry for `course` — or, for a course-free style, the
    single resolved entry whatever course it was swum in."""
    if not style_data:
        return None
    entry = style_data.get(course)
    if entry is None and course_free:
        entry = next(iter(style_data.values()), None)
    return entry


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
        Result.stylesid < BEACH_STYLE_MIN,  # beach = positions, not times
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
        AthleteBestTime.stylesid < BEACH_STYLE_MIN,
    )
    if member_id is not None:
        q = q.filter(AthleteBestTime.membersid == member_id)
    return q


def _resolve(results, coach_rows, course_free: set[int] = frozenset(),
             exclude: set[int] = frozenset()) -> dict[int, dict]:
    """{membersid: {"{stylesid}": {"LCM": {...}, "SCM": {...}}}}

    Course-free styles (throws) are resolved across both courses and yield a
    single entry, kept under the course it was actually swum/entered in (so
    the LXF exports stay truthful); readers use pick_course().
    """
    def slot(style_id, course):
        return 0 if style_id in course_free else course

    results = [r for r in results if r.stylesid not in exclude]
    coach_rows = [c for c in coach_rows if c.stylesid not in exclude]

    # value: (time_ms, date, source, real course)
    best: dict[tuple[int, int, int], tuple[int, datetime | None, str, int]] = {}
    for r in results:
        key = (r.membersid, r.stylesid, slot(r.stylesid, r.course))
        cur = best.get(key)
        # Fastest wins; on a tie keep the most recent date.
        if (cur is None or r.totaltime < cur[0]
                or (r.totaltime == cur[0] and r.eventdate and (cur[1] is None or r.eventdate > cur[1]))):
            best[key] = (r.totaltime, r.eventdate, "result", r.course)
    coach: dict[tuple[int, int, int], tuple[int, datetime | None, str, int]] = {}
    for c in coach_rows:
        key = (c.membersid, c.stylesid, slot(c.stylesid, c.course))
        cur = coach.get(key)
        # Course-free: one coach row per course may exist — the latest entry
        # is the coach's current statement (tie: the faster one).
        if (cur is None or (c.entered_date and cur[1] and c.entered_date > cur[1])
                or (c.entered_date == cur[1] and c.time_ms < cur[0])):
            coach[key] = (c.time_ms, c.entered_date, "coach", c.course)
    best.update(coach)  # coach value is authoritative while valid

    out: dict[int, dict] = {}
    for (member_id, style_id, _slot), (time_ms, when, source, course_int) in best.items():
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
        course_free_style_ids(db),
        team_style_ids(db),
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
    course_free = course_free_style_ids(db)
    athlete_bt = _resolve(
        _eligible_results(db, cutoff).all(),
        _valid_coach_rows(db, cutoff).all(),
        course_free,
        team_style_ids(db),
    )
    all_uids: set[int] = {int(uid) for bt in athlete_bt.values() for uid in bt}

    style_uids = sorted(all_uids)
    styles = []
    for uid in style_uids:
        style = db.get(SwimStyle, uid)
        name = style.name if style else f"ID{uid}"
        # course_free: one value whatever the course (throws) — the page shows
        # a single cell instead of 50 m / 25 m.
        styles.append({"uid": uid, "name": name, "course_free": uid in course_free})

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
    course = _get_meet_course(db, get_active_meetsid(db))

    return {"styles": styles, "clubs": clubs, "course": course}


def get_best_time(
    db: Session,
    member_id: int,
    style_id: int,
    course: str,
    max_age_months: int = 18,
) -> int | None:
    """Resolved best time for a specific member/style/course combination."""
    entry = pick_course(get_best_times_for_member(db, member_id, max_age_months).get(str(style_id), {}),
                        course, style_id in course_free_style_ids(db))
    return entry["time_ms"] if entry else None


def get_best_time_date(
    db: Session,
    member_id: int,
    style_id: int,
    course: str,
    max_age_months: int = 18,
    time_ms: int | None = None,
) -> date | None:
    """Date of the resolved best time for a specific member/style/course.

    With `time_ms`, only when that best time *is* `time_ms` — the date of a
    different (e.g. faster/slower) time says nothing about when `time_ms` was
    swum, so a coach-typed entry time gets None.
    """
    entry = pick_course(get_best_times_for_member(db, member_id, max_age_months).get(str(style_id), {}),
                        course, style_id in course_free_style_ids(db))
    if not entry or not entry["date"]:
        return None
    if time_ms is not None and entry["time_ms"] != time_ms:
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
    - entry time equal to one of the athlete's *expired* times for that
      style/course → nothing to do either: it was the pre-filled best time
      when the coach registered, and it expired before the meet was closed
      (registration often opens weeks earlier). Capturing it would re-date it
      to this meet and keep an old performance alive for another window;
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
    course_str = _get_meet_course(db, meetsid)
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
            SwimEvent.swimstyleid < BEACH_STYLE_MIN,  # even if MEET_TYPE is wrong
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

    course_free = course_free_style_ids(db)
    cutoff = _cutoff_date(max_age_months)
    resolved_cache: dict[int, dict] = {}
    written = 0
    for (athlete_id, style_id), entry_ms in entries.items():
        if athlete_id not in resolved_cache:
            resolved_cache[athlete_id] = get_best_times_for_member(db, athlete_id, max_age_months)
        current = pick_course(resolved_cache[athlete_id].get(str(style_id), {}),
                              course_str, style_id in course_free)
        if current and current["time_ms"] == entry_ms:
            continue
        if entry_ms in _expired_times(db, athlete_id, style_id, course_int,
                                      style_id in course_free, cutoff):
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


def _expired_times(db: Session, member_id: int, style_id: int, course_int: int,
                   course_free: bool, cutoff: date) -> set[int]:
    """Times of one athlete/style/course that have aged out of the window:
    official non-HC results and coach rows dated before `cutoff` (any course
    for a course-free style). Undated results never expire, so never appear.
    """
    cut = datetime.combine(cutoff, datetime.min.time())
    eff = _result_date()
    results = db.query(Result.totaltime).outerjoin(Meet, Meet.meetsid == Result.meetsid).filter(
        Result.membersid == member_id,
        Result.stylesid == style_id,
        Result.totaltime > 0,
        Result.resulttyp == 0,
        or_(Result.resultstatus.is_(None), Result.resultstatus != 4),
        eff < cut,
    )
    coach = db.query(AthleteBestTime.time_ms).filter(
        AthleteBestTime.membersid == member_id,
        AthleteBestTime.stylesid == style_id,
        AthleteBestTime.time_ms > 0,
        AthleteBestTime.entered_date < cut,
    )
    if not course_free:
        results = results.filter(Result.course == course_int)
        coach = coach.filter(AthleteBestTime.course == course_int)
    return {t for (t,) in results.all()} | {t for (t,) in coach.all()}


def coach_best_time_date(db: Session, meetsid: int | None) -> date:
    """The date a coach's typed entry time for this meet would be stored with
    when the meet is closed (capture_coach_best_times): the meet's start date,
    today if it has none. Shown in the registration help bubble."""
    if not meetsid:
        return date.today()
    return _meet_start(db, meetsid, db.get(Meet, meetsid)).date()


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
        Result.stylesid < BEACH_STYLE_MIN,
        Result.totaltime.isnot(None),
        Result.totaltime > 0,
        Result.resulttyp == 0,
        or_(Result.resultstatus.is_(None), Result.resultstatus != 4),
    ).all()
    course_free = course_free_style_ids(db)
    updated: set[tuple[int, int, int]] = set()
    for r in results:
        if r.stylesid in course_free:
            # A throw's coach value may sit under the other course.
            rows = db.query(AthleteBestTime).filter(
                AthleteBestTime.membersid == r.membersid,
                AthleteBestTime.stylesid == r.stylesid,
            ).all()
        else:
            row = db.get(AthleteBestTime, (r.membersid, r.stylesid, r.course))
            rows = [row] if row is not None else []
        when = r.eventdate or meet_date
        for row in rows:
            if r.totaltime >= row.time_ms:
                continue
            if when and row.entered_date and when.date() < row.entered_date.date():
                continue
            row.time_ms = r.totaltime
            if when:
                row.entered_date = when
            updated.add((row.membersid, row.stylesid, row.course))
    db.flush()
    return len(updated)


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


# --- Relay best times ---------------------------------------------------------
#
# A relay time belongs to the team, but every member of an archived relay team
# is credited with that team's total: a member's relay best time for a style and
# course is the fastest total of any team they swam on. Archived relays live in
# `relays` (totaltime, resultstatus) + `relayspos` (members), written by the
# results imports. Used only to suggest a new team's entry time at registration
# (the average of its members' relay best times) — never as an individual best.
#
# Same rules as individual best times: pool only, official and non-HC/DSQ/DNS/DNF
# (resultstatus NULL/0), not older than max_age_months (team's eventdate, else
# its meet's start date). SERC (530) is judged, not timed. Throws from the deck
# (Lancer de la corde, distance < 25 m) are course-free, like individual throws.

SERC_STYLE_ID = 530


def get_relay_best_times(
    db: Session,
    member_ids: list[int] | set[int],
    style_id: int,
    course: str | None,
    max_age_months: int = 18,
) -> dict[int, int]:
    """{membersid: best relay team total (ms)} for one relay style and course."""
    from .models_team import Relay, RelayPos

    course_int = _course_int(course or "")
    ids = [m for m in member_ids if m]
    if not ids or course_int is None or style_id >= BEACH_STYLE_MIN or style_id == SERC_STYLE_ID:
        return {}
    cutoff = datetime.combine(_cutoff_date(max_age_months), datetime.min.time())
    eff = func.coalesce(Relay.eventdate, Meet.mindate, type_=DateTime)
    style = db.get(SwimStyle, style_id)
    course_free = bool(style and style.distance and 0 < style.distance < COURSE_FREE_MAX_DISTANCE)
    rows = (
        db.query(RelayPos.membersid, func.min(Relay.totaltime))
        .join(Relay, Relay.relaysid == RelayPos.relaysid)
        .outerjoin(Meet, Meet.meetsid == Relay.meetsid)
        .filter(
            RelayPos.membersid.in_(ids),
            Relay.stylesid == style_id,
            true() if course_free else Relay.course == course_int,
            Relay.totaltime.isnot(None),
            Relay.totaltime > 0,
            or_(Relay.resulttyp.is_(None), Relay.resulttyp == 0),
            or_(Relay.resultstatus.is_(None), Relay.resultstatus == 0),
            or_(eff.is_(None), eff >= cutoff),
        )
        .group_by(RelayPos.membersid)
        .all()
    )
    return {mid: t for mid, t in rows if t}


def suggest_relay_entry_time(times: list[int | None]) -> int | None:
    """Suggested team entry time: the average of the members' relay best times
    (members without one are left out), rounded to the hundredth.

    Same rule as shared-ui's suggestRelayEntryTime (logic/relayEntryTime.ts),
    including JS Math.round's half-up rounding — keep the two in step.
    """
    valid = [t for t in times if t and t > 0]
    if not valid:
        return None
    return int(math.floor(sum(valid) / len(valid) / 10 + 0.5)) * 10


def refresh_relay_entry_times_for_course(db: Session, meetsid: int | None, old_course: str, new_course: str) -> int:
    """After the meet's pool length changed, move every relay entry time that
    still follows the suggestion to the new course's suggestion.

    A team's entry time was filled from the members' relay best times for the
    meet's course at the time. One still equal to that suggestion (or empty)
    was never typed by the coach, so it follows the course like it follows
    member changes (entryTimeAfterMemberChange in shared-ui); a typed time is
    kept. Returns the number of teams changed.
    """
    from .models_team import Relay, RelayPos

    if meetsid is None or old_course == new_course:
        return 0
    relays = (
        db.query(Relay)
        .filter(Relay.meetsid == meetsid, Relay.stylesid.isnot(None),
                Relay.stylesid < BEACH_STYLE_MIN, Relay.stylesid != SERC_STYLE_ID)
        .all()
    )
    if not relays:
        return 0
    members: dict[int, list[int]] = {}
    for pos in db.query(RelayPos).filter(RelayPos.relaysid.in_([r.relaysid for r in relays])):
        if pos.membersid:
            members.setdefault(pos.relaysid, []).append(pos.membersid)
    bests: dict[tuple[int, str], dict[int, int]] = {}

    def suggestion(relay, course: str) -> int | None:
        key = (relay.stylesid, course)
        if key not in bests:
            style_members = {m for r in relays if r.stylesid == relay.stylesid for m in members.get(r.relaysid, [])}
            bests[key] = get_relay_best_times(db, style_members, relay.stylesid, course)
        return suggest_relay_entry_time([bests[key].get(m) for m in members.get(relay.relaysid, [])])

    changed = 0
    for relay in relays:
        current = relay.entrytime or None
        if current is not None and current != suggestion(relay, old_course):
            continue  # typed by the coach
        new = suggestion(relay, new_course)
        if new != current:
            relay.entrytime = new
            changed += 1
    return changed
