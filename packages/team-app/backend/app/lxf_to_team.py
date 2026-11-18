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

"""Archive a results LENEX .lxf as a historical meet (Team Manager schema).

The one results importer behind both entry points:
- `import_lxf_as_meet` — Organizer/Admin "Import results" (POST
  /api/import-results-lxf), which then closes the open meet. An already
  archived copy of the same meet is replaced silently.
- `historical_import.import_historical_meet` — Admin "Import historical"
  (POST /api/admin/import-historical), for older meets. Asks for confirmation
  (needs_force) before replacing an archived copy, and warns when the file
  looks like the open meet.

Both used to be separate copies of this code and drifted apart (one never
wrote results.eventnumb); everything below `archive_results_lxf` is shared.

Maps:
- MEET (name, city, course, dates) → MEETS row (meetstate=3)
- SESSIONS/SESSION → SESSIONS rows, EVENT → EVENTS rows
- CLUB → CLUBS (merge by code, else name); ATHLETE → MEMBERS (merge by
  license, else name + birthdate in any club, else name in the same club)
- ATHLETE/RESULTS/RESULT with a time → RESULTS rows
- RELAY results → RELAYS/RELAYSPOS (relay_archive.py)
"""
from __future__ import annotations

import secrets
import string
from datetime import datetime, date
from xml.etree.ElementTree import Element

from sqlalchemy import func
from sqlalchemy.orm import Session as DbSession

from .lxf_io import read_lef_xml
from .models import SwimStyle
from .models_team import (
    Meet, Session as MeetSession, Event, TeamClub, Member,
    Result, MemberMeet,
)


def _lenex_time_to_ms(t: str | None) -> int | None:
    """Convert LENEX time 'HH:MM:SS.cc', 'MM:SS.cc' or 'SS.cc' to integer ms."""
    if not t or t == "NT":
        return None
    parts = t.split(":")
    try:
        if len(parts) == 3:
            hh, mm, ss_cc = int(parts[0]), int(parts[1]), parts[2]
        elif len(parts) == 2:
            hh, mm, ss_cc = 0, int(parts[0]), parts[1]
        elif len(parts) == 1:
            hh, mm, ss_cc = 0, 0, parts[0]
        else:
            return None
        ss_parts = ss_cc.split(".")
        ss = int(ss_parts[0])
        cc = int(ss_parts[1].ljust(2, "0")[:2]) if len(ss_parts) > 1 else 0
        ms = hh * 3600000 + mm * 60000 + ss * 1000 + cc * 10
        return ms if ms > 0 else None
    except (ValueError, IndexError):
        return None


def _parse_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _as_datetime(d: date | None) -> datetime | None:
    return datetime(d.year, d.month, d.day) if d else None


def _course_to_int(course: str) -> int:
    return {"LCM": 1, "SCY": 2, "SCM": 3}.get((course or "").upper(), 1)


def _next_id(db: DbSession, model, pk_col) -> int:
    max_id = db.query(func.max(pk_col)).scalar()
    return (max_id or 0) + 1


# ── Pre-import guards ─────────────────────────────────────────────────────────
# A results import that closes a meet is destructive (registrations deleted,
# PINs regenerated), so before writing anything, check the file actually is a
# results file and belongs to the meet being closed.

_RESULT_STATUSES = {"DSQ", "DNS", "DNF", "EXH", "WDR", "SICK", "DNQ"}


def count_results_in_lxf(root: Element) -> int:
    """Number of RESULT elements carrying a real time or a status.

    0 means this isn't a results file — e.g. an entries/inscriptions or
    meet-structure LXF picked by mistake (entries carry only entrytime).
    """
    n = 0
    for r in root.iter("RESULT"):
        if (_lenex_time_to_ms(r.get("swimtime")) or 0) > 0 or (r.get("status") or "").upper() in _RESULT_STATUSES:
            n += 1
    return n


class BeachResultsNotArchived(ValueError):
    """A beach results file was handed to a historical-results importer."""


def is_beach_results(root) -> bool:
    """True if the file uses any beach swimstyle (id >= BEACH_STYLE_MIN).

    Beach results are finishing positions, not times: they never feed best
    times, so archiving them as a historical meet only adds noise. A beach
    meet is closed with close-meet-without-results instead. Decided from the
    file's own styles, not the global meet_type flag (one per install, not
    per meet).
    """
    from .best_times import BEACH_STYLE_MIN
    for ss in root.iter("SWIMSTYLE"):
        try:
            if int(ss.get("swimstyleid") or 0) >= BEACH_STYLE_MIN:
                return True
        except ValueError:
            continue
    return False


BEACH_RESULTS_DETAIL = {
    "code": "beach_results_not_archived",
    "message": "Beach results are not archived (positions, not times — no best "
               "times). Close the beach meet with \"Close without results\".",
}


def _norm_name(s: str | None) -> str:
    return " ".join((s or "").lower().split())


def meet_mismatch(db: DbSession, root: Element, meetsid: int | None) -> dict | None:
    """Compare a results file against the open meet it would close.

    Two signals, either one flags a mismatch:
    - MEET@name differs from the open meet's name (case/whitespace-insensitive);
    - fewer than half of the file's result event ids exist in the open meet
      (meet-app keeps team-app's swimevent ids end to end, so a genuine
      results file for this meet matches them).
    Returns None when it looks like the same meet, else a detail dict.
    """
    from .models import SwimEvent
    from .meet_config import _get_meet_config

    if not meetsid:
        return None
    meet_el = root.find(".//MEET")
    file_name = (meet_el.get("name") if meet_el is not None else "") or ""
    open_meet = db.get(Meet, meetsid)
    open_name = _get_meet_config(db, meetsid, "meet_name") or (open_meet.name if open_meet else "") or ""

    name_differs = bool(_norm_name(file_name)) and bool(_norm_name(open_name)) \
        and _norm_name(file_name) != _norm_name(open_name)

    # Event ids actually used by results (EVENT elements of a results file
    # all carry results, but RESULT@eventid is what matters).
    file_ids = {int(r.get("eventid")) for r in root.iter("RESULT") if (r.get("eventid") or "").isdigit()}
    open_ids = {eid for (eid,) in db.query(SwimEvent.swimeventid).filter(SwimEvent.meetsid == meetsid).all()}
    matched = len(file_ids & open_ids)
    events_differ = bool(file_ids) and bool(open_ids) and matched * 2 < len(file_ids)

    if not (name_differs or events_differ):
        return None
    return {
        "code": "meet_mismatch",
        "file_meet": file_name,
        "open_meet": open_name,
        "events_matched": matched,
        "events_in_file": len(file_ids),
    }


def import_lxf_as_meet(db: DbSession, content: bytes, force: bool = False) -> dict:
    """Organizer/Admin "Import results" (the call that closes the open meet).

    An archived copy of the same meet (same name and start date) is replaced
    without asking: re-importing a corrected results file is the normal way
    to fix a closed meet. `force` only confirms swimstyle ids that aren't in
    the local catalog yet. See archive_results_lxf.
    """
    return archive_results_lxf(db, content, force=force, confirm_replace=False)


# ── The importer ──────────────────────────────────────────────────────────────

_EVENT_GENDER = {"ALL": 0, "M": 1, "F": 2, "MIXED": 3, "X": 3}


def _parse_meet(root: Element) -> dict:
    """MEET name/city/course and start/end dates.

    Results files in the wild often carry dates only on <SESSION date>, so the
    start falls back to the EARLIEST session date (sessions aren't guaranteed
    to be in order) and the end to MEET@stopdate, else the latest session date.
    """
    meet_el = root.find(".//MEET")
    if meet_el is None:
        raise ValueError("No MEET element found in LENEX file")
    session_dates = [d for d in (_parse_date(s.get("date")) for s in root.iter("SESSION")) if d]
    start = _parse_date(meet_el.get("startdate") or meet_el.get("date")) \
        or (min(session_dates) if session_dates else None)
    stop = _parse_date(meet_el.get("stopdate")) or (max(session_dates) if session_dates else None)
    if start and (not stop or stop < start):
        stop = start
    course = (meet_el.get("course") or "LCM").upper()
    if course not in ("LCM", "SCM", "SCY"):
        course = "LCM"
    return {
        "name": (meet_el.get("name") or "").strip() or "Imported Meet",
        "city": meet_el.get("city") or "",
        "course": course,
        "start": start,
        "stop": stop,
    }


def _find_archived_meet(db: DbSession, name: str, start: date | None) -> Meet | None:
    """The completed meet this file is a re-import of, or None.

    Same name (case-insensitive) and, when the file has a date, same start
    day — a meet held every year under the same name is a different meet
    each year. A file with no date at all can only be matched by name, and
    only when exactly one completed meet has it (don't guess between years).
    """
    q = db.query(Meet).filter(func.lower(Meet.name) == name.lower(), Meet.meetstate == 3)
    if start:
        # Calendar day only: SQLite stores DateTime as text, and older rows
        # hold '2025-05-24 00:00:00' while SQLAlchemy binds
        # '2025-05-24 00:00:00.000000' — a plain == never matched those.
        return q.filter(func.date(Meet.mindate) == start.isoformat()).first()
    same_name = q.all()
    return same_name[0] if len(same_name) == 1 else None


def _find_or_create_club(db: DbSession, club_el: Element, counts: dict) -> int:
    """Club by code, else by name; created (with a fresh PIN) when unknown."""
    code = (club_el.get("code") or "").strip()
    name = club_el.get("name") or ""
    if code:
        club = db.query(TeamClub).filter(TeamClub.code == code).first()
    else:
        club = db.query(TeamClub).filter(TeamClub.name == name).first() if name else None
    counts["clubs_matched"] += 1
    if club:
        return club.clubsid
    club_id = _next_id(db, TeamClub, TeamClub.clubsid)
    db.add(TeamClub(
        clubsid=club_id, name=name, code=code,
        nation=club_el.get("nation") or "CAN",
        pin="".join(secrets.choice(string.digits) for _ in range(6)),
        email="",
    ))
    db.flush()
    counts["clubs_created"] += 1
    return club_id


def _find_or_create_member(db: DbSession, ath_el: Element, club_el: Element,
                           club_id: int, counts: dict) -> int | None:
    """Member by license; else exact name + birthdate in any club (athlete
    changed clubs); else exact name in this club unless the birthdates
    disagree. License-only matching created a new member on every import for
    athletes without a license, so re-importing duplicated them; name-only
    matching across clubs merged different people.

    A matched member gets a missing birthdate, gender or HANDICAP exception
    code filled in from the file; nothing already set is overwritten.
    """
    firstname = (ath_el.get("firstname") or "").strip().rstrip(",")
    lastname = (ath_el.get("lastname") or "").strip().rstrip(",")
    if not firstname and not lastname:
        return None
    license_val = (ath_el.get("license") or "").strip()
    birthdate = _parse_date(ath_el.get("birthdate"))
    gender = {"M": 1, "F": 2}.get((ath_el.get("gender") or "").upper())
    handicap_el = ath_el.find("HANDICAP")
    exception_code = (
        handicap_el.get("exception") if handicap_el is not None else None
    ) or ath_el.get("exception") or None

    member = None
    if license_val:
        member = db.query(Member).filter(Member.license == license_val).first()
    if not member and firstname and lastname:
        same_name = db.query(Member).filter(
            Member.firstname == firstname, Member.lastname == lastname,
        ).order_by(Member.membersid).all()

        def _bd(m):
            return m.birthdate.date() if hasattr(m.birthdate, "date") else m.birthdate

        if birthdate:
            member = next((m for m in same_name if _bd(m) == birthdate), None)
        if not member:
            member = next((
                m for m in same_name
                if m.clubsid == club_id and (not birthdate or not m.birthdate or _bd(m) == birthdate)
            ), None)

    counts["athletes_matched"] += 1
    if member:
        if birthdate and not member.birthdate:
            member.birthdate = _as_datetime(birthdate)
        if gender and not member.gender:
            member.gender = gender
        if exception_code and not member.handicapex:
            member.handicapex = exception_code
        return member.membersid

    member_id = _next_id(db, Member, Member.membersid)
    db.add(Member(
        membersid=member_id,
        lastname=lastname,
        firstname=firstname,
        birthdate=_as_datetime(birthdate),
        gender=gender or 1,
        nation=ath_el.get("nation") or club_el.get("nation") or "CAN",
        license=license_val,
        clubsid=club_id,
        handicapex=exception_code,
    ))
    db.flush()
    counts["athletes_created"] += 1
    return member_id


def archive_results_lxf(db: DbSession, content: bytes, *, force: bool = False,
                        confirm_replace: bool = False) -> dict:
    """Archive a results .lxf as a completed historical meet (meetstate=3).

    Refuses beach results (BeachResultsNotArchived: positions, never best
    times). Otherwise returns {"needs_force": True, "warning": ..., ...}
    without writing anything when:
    - the file uses swimstyle ids not in the local catalog (unless `force`);
    - `confirm_replace` and the meet is already archived (unless `force`).
    An already archived meet (see _find_archived_meet) has its events,
    sessions, results, relays and athlete links replaced, keeping its id.

    Results without a time are skipped (DSQ/DNS/DNF: nothing to archive);
    an EXH (hors concours) time is kept with resultstatus=4, excluded from
    best times. Stored coach best times are lowered to this meet's faster
    results (refresh_best_times_from_meet).
    """
    root = read_lef_xml(content)
    meta = _parse_meet(root)
    if is_beach_results(root):
        raise BeachResultsNotArchived(BEACH_RESULTS_DETAIL["message"])

    # ── Events: eventid → style / number / gender ────────────────────────────
    event_style: dict[str, int] = {}
    event_number: dict[str, int] = {}
    event_gender: dict[str, int] = {}
    event_session: dict[str, int | None] = {}
    event_order: dict[str, int] = {}
    style_info: dict[int, tuple[str, int | None, int | None]] = {}  # name, distance, relaycount

    def _int(s):
        try:
            return int(s)
        except (TypeError, ValueError):
            return None

    for sess_el in root.iter("SESSION"):
        sess_numb = _int(sess_el.get("number"))
        for ev_el in sess_el.iter("EVENT"):
            event_session[ev_el.get("eventid") or ""] = sess_numb
    for ev_el in root.iter("EVENT"):
        eid = ev_el.get("eventid")
        style_el = ev_el.find("SWIMSTYLE")
        style_id = _int(style_el.get("swimstyleid")) if style_el is not None else None
        if not eid or not style_id:
            continue
        event_style[eid] = style_id
        event_number[eid] = _int(ev_el.get("number")) or 0
        # LENEX's GENDER enum is ALL|M|F|MIXED; "X" is also accepted since our
        # own exporter used to write it for Mixed (non-conformant, fixed in
        # export.py). Absent/unknown → ALL.
        event_gender[eid] = _EVENT_GENDER.get((ev_el.get("gender") or "").upper(), 0)
        event_order[eid] = _int(ev_el.get("order")) or event_number[eid]
        style_info[style_id] = (style_el.get("name") or "",
                                _int(style_el.get("distance")),
                                _int(style_el.get("relaycount")))

    # ── Confirmations (nothing written yet) ──────────────────────────────────
    if not force:
        from .swimstyle_check import find_new_swimstyles, describe_new_swimstyles
        new_styles = find_new_swimstyles(db, (
            (sid, name, dist) for sid, (name, dist, _rc) in style_info.items()
        ))
        if new_styles:
            return {
                "needs_force": True,
                "warning": describe_new_swimstyles(new_styles),
                "new_swimstyles": new_styles,
                "meet_name": meta["name"],
            }

    existing = _find_archived_meet(db, meta["name"], meta["start"])
    if existing and confirm_replace and not force:
        when = existing.mindate.date().isoformat() if existing.mindate else "?"
        return {
            "needs_force": True,
            "warning": f"Meet '{meta['name']}' ({when}) already imported "
                       f"(id={existing.meetsid}). Pass force=true to re-import.",
            "meet_name": meta["name"],
            "meet_id": existing.meetsid,
        }

    # ── Meet row: replace an archived copy in place, else create ─────────────
    course_int = _course_to_int(meta["course"])
    if existing:
        meet = existing
        from .relay_archive import delete_archived_relays
        delete_archived_relays(db, meet.meetsid)
        db.query(MemberMeet).filter(MemberMeet.meetsid == meet.meetsid).delete()
        db.query(Result).filter(Result.meetsid == meet.meetsid).delete()
        db.query(Event).filter(Event.meetsid == meet.meetsid).delete()
        db.query(MeetSession).filter(MeetSession.meetsid == meet.meetsid).delete()
        meet.place = meta["city"]
        meet.course = course_int
        if meta["start"]:  # a dateless file keeps the archived meet's own dates
            meet.mindate = _as_datetime(meta["start"])
            meet.maxdate = _as_datetime(meta["stop"])
        db.flush()
    else:
        meet = Meet(
            meetsid=_next_id(db, Meet, Meet.meetsid),
            name=meta["name"],
            place=meta["city"],
            mindate=_as_datetime(meta["start"]),
            maxdate=_as_datetime(meta["stop"]),
            course=course_int,
            meetstate=3,  # completed
        )
        db.add(meet)
        db.flush()
    meet_id = meet.meetsid
    # Results/relays are dated to the meet start (they expire from it); a
    # dateless re-import uses the archived meet's own date.
    meet_date = _as_datetime(meta["start"]) or meet.mindate

    # ── Swim styles, sessions, events ────────────────────────────────────────
    for style_id, (name, dist, relaycount) in style_info.items():
        if not db.get(SwimStyle, style_id):
            # The file's own distance/relaycount: relays and throws are
            # classified by them (hard-coding relaycount=1 misclassified them).
            db.add(SwimStyle(
                swimstyleid=style_id,
                name=name or f"Style {style_id}",
                distance=dist if dist and dist > 0 else None,
                relaycount=relaycount or 1,
            ))
    db.flush()

    counts = {
        "sessions_created": 0, "events_created": 0,
        "clubs_matched": 0, "clubs_created": 0,
        "athletes_matched": 0, "athletes_created": 0,
        "results_imported": 0, "relays_imported": 0,
    }
    # Running ids (one MAX query per table, not per row: big meets have
    # well over a thousand results).
    next_session_id = _next_id(db, MeetSession, MeetSession.sessionsid)
    next_event_id = _next_id(db, Event, Event.eventsid)
    next_result_id = _next_id(db, Result, Result.resultsid)

    for sess_el in root.iter("SESSION"):
        db.add(MeetSession(
            sessionsid=next_session_id,
            meetsid=meet_id,
            numb=_int(sess_el.get("number")) or 0,
            startdate=_as_datetime(_parse_date(sess_el.get("date"))),
            name=(sess_el.get("name") or "")[:50],
        ))
        next_session_id += 1
        counts["sessions_created"] += 1

    for eid, style_id in event_style.items():
        db.add(Event(
            eventsid=next_event_id,
            meetsid=meet_id,
            sessionnumb=event_session.get(eid),
            numb=event_number[eid],
            eventtyp=0,
            stylesid=style_id,
            gender=event_gender[eid],
            sortcode=event_order[eid],
        ))
        next_event_id += 1
        counts["events_created"] += 1
    db.flush()

    # ── Clubs, athletes, individual results ──────────────────────────────────
    member_ids_with_results: set[int] = set()
    member_club: dict[int, int] = {}
    # File athleteid -> membersid across ALL clubs: a relay can include an
    # athlete listed under another club (athlete switched clubs, composite
    # team), so relays are archived once every club's athletes are known.
    athlete_members: dict[str, int] = {}
    relay_clubs: list[tuple[Element, int]] = []

    for club_el in root.iter("CLUB"):
        club_id = _find_or_create_club(db, club_el, counts)
        for ath_el in club_el.iter("ATHLETE"):
            member_id = _find_or_create_member(db, ath_el, club_el, club_id, counts)
            if member_id is None:
                continue
            member_club.setdefault(member_id, club_id)
            if ath_el.get("athleteid"):
                athlete_members[ath_el.get("athleteid")] = member_id

            for result_el in ath_el.iter("RESULT"):
                eid = result_el.get("eventid") or ""
                style_id = event_style.get(eid)
                swimtime_ms = _lenex_time_to_ms(result_el.get("swimtime"))
                if not style_id or not swimtime_ms:
                    continue  # unknown event, or DSQ/DNS/DNF with no time
                # HC (hors concours / exhibition) keeps its time but is
                # excluded from best times.
                is_hc = (result_el.get("status") or "").upper() == "EXH"
                db.add(Result(
                    resultsid=next_result_id,
                    membersid=member_id,
                    meetsid=meet_id,
                    eventdate=meet_date,
                    stylesid=style_id,
                    # Groups the meet's results by event (results.py, athlete
                    # history) — one importer used to leave it NULL.
                    eventnumb=event_number.get(eid),
                    totaltime=swimtime_ms,
                    entrytime=_lenex_time_to_ms(result_el.get("entrytime")),
                    course=course_int,
                    resulttyp=0,  # official
                    resultstatus=4 if is_hc else None,
                ))
                next_result_id += 1
                counts["results_imported"] += 1
                member_ids_with_results.add(member_id)

        relay_clubs.append((club_el, club_id))

    # ── Relay results: team total + members (relay_archive.py) ───────────────
    from .relay_archive import archive_club_relays
    for club_el, club_id in relay_clubs:
        n_relays, relay_members = archive_club_relays(
            db, club_el,
            club_id=club_id, meet_id=meet_id, meet_date=meet_date, course=course_int,
            event_style=event_style, event_number=event_number,
            athlete_members=athlete_members,
        )
        counts["relays_imported"] += n_relays
        member_ids_with_results |= relay_members
    db.flush()

    # ── Athlete ↔ meet links: everyone who swam (individual or relay) ────────
    for mid in member_ids_with_results:
        member = db.get(Member, mid)
        db.add(MemberMeet(
            membersid=mid,
            meetsid=meet_id,
            clubsid=member_club.get(mid) or (member.clubsid if member else None),
        ))
    db.flush()

    # A faster result from this meet replaces a stored coach best time
    # (only when the meet isn't older than the stored value).
    from .best_times import refresh_best_times_from_meet
    refresh_best_times_from_meet(db, meet_id)

    db.commit()
    return {
        "meet_id": meet_id,
        "meet_name": meta["name"],
        "meet_date": meet_date.date().isoformat() if meet_date else None,
        "course": meta["course"],
        "reimported": existing is not None,
        **counts,
    }
