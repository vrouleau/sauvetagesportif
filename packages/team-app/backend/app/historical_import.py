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

"""Historical meet import — parse a results LXF and store as a distinct meet record.

Creates a Meet, Events, Results, and MemberMeet entries for the imported competition.
Also updates best times from all historical results.
"""
from __future__ import annotations

import re
import zipfile
from datetime import date as _date, datetime as _dt
from io import BytesIO

from defusedxml.ElementTree import fromstring as _ET_fromstring
from sqlalchemy import func
from sqlalchemy.orm import Session

from .models import BsGlobal, SwimStyle
from .models_team import Meet, Event, Result, MemberMeet, TeamClub, Member
from .best_times import _lenex_time_to_ms, _find_or_create_athlete


def _parse_meet_metadata(root) -> dict:
    """Extract meet-level metadata from the LXF XML root."""
    meet_el = root.find(".//MEET")
    if meet_el is None:
        return {"name": "Unknown Meet", "course": "LCM", "startdate": None, "city": ""}

    name = meet_el.get("name", "Unknown Meet")
    course = meet_el.get("course", "LCM")
    if course not in ("LCM", "SCM", "SCY"):
        course = "LCM"
    city = meet_el.get("city", "")

    startdate: _date | None = None
    for attr in ("startdate", "date"):
        raw = meet_el.get(attr, "")
        if raw:
            try:
                startdate = _date.fromisoformat(raw[:10])
                break
            except ValueError:
                pass

    stopdate: _date | None = None
    raw = meet_el.get("stopdate", "")
    if raw:
        try:
            stopdate = _date.fromisoformat(raw[:10])
        except ValueError:
            pass

    return {
        "name": name,
        "course": course,
        "startdate": startdate,
        "stopdate": stopdate,
        "city": city,
    }


def _course_str_to_int(course: str) -> int:
    return {"LCM": 1, "SCY": 2, "SCM": 3}.get(course, 1)


def import_historical_meet(db: Session, file_bytes: bytes, force: bool = False) -> dict:
    """Import a results LXF as a historical meet.

    Args:
        db: Database session.
        file_bytes: Raw bytes of the .lxf zip file.
        force: If True, skip the "looks like current meet" warning.

    Returns:
        Dict with import results: meet_id, meet_name, warning, results_imported, etc.
    """
    # Parse the LXF zip
    with zipfile.ZipFile(BytesIO(file_bytes)) as z:
        lef_name = next(n for n in z.namelist() if n.endswith(".lef"))
        xml_bytes = z.read(lef_name)

    root = _ET_fromstring(xml_bytes)
    meta = _parse_meet_metadata(root)

    # ── Cross-validation: warn if this looks like the current meet ──
    current_meet_name = None
    cfg = db.query(BsGlobal).get("meet_name")
    if cfg:
        current_meet_name = cfg.data

    warning = None
    if current_meet_name and meta["name"] and not force:
        # Fuzzy match: case-insensitive, ignore leading/trailing whitespace
        if meta["name"].strip().lower() == current_meet_name.strip().lower():
            warning = (
                f"This LXF appears to be your current meet ('{meta['name']}'). "
                f"Use the results import on the Invitation page instead. "
                f"Pass force=true to override."
            )
            return {
                "warning": warning,
                "meet_name": meta["name"],
                "needs_force": True,
            }

    # ── Deduplication: check if this meet was already imported ──
    existing_meet = None
    if meta["startdate"]:
        existing_meet = db.query(Meet).filter(
            Meet.name == meta["name"],
            Meet.mindate == _dt(meta["startdate"].year, meta["startdate"].month, meta["startdate"].day),
        ).first()

    if existing_meet and not force:
        return {
            "warning": f"Meet '{meta['name']}' ({meta['startdate']}) already imported (id={existing_meet.meetsid}). Pass force=true to re-import.",
            "meet_name": meta["name"],
            "meet_id": existing_meet.meetsid,
            "needs_force": True,
        }

    # If re-importing, wipe old results for this meet
    if existing_meet:
        db.query(Result).filter(Result.meetsid == existing_meet.meetsid).delete()
        db.query(MemberMeet).filter(MemberMeet.meetsid == existing_meet.meetsid).delete()
        db.query(Event).filter(Event.meetsid == existing_meet.meetsid).delete()
        db.flush()
        meet = existing_meet
    else:
        # Create new Meet record
        next_id = (db.query(func.max(Meet.meetsid)).scalar() or 0) + 1
        meet = Meet(
            meetsid=next_id,
            name=meta["name"],
            place=meta["city"],
            mindate=_dt(meta["startdate"].year, meta["startdate"].month, meta["startdate"].day) if meta["startdate"] else None,
            maxdate=_dt(meta["stopdate"].year, meta["stopdate"].month, meta["stopdate"].day) if meta.get("stopdate") else None,
            course=_course_str_to_int(meta["course"]),
            meetstate=3,  # completed
        )
        db.add(meet)
        db.flush()

    course_int = _course_str_to_int(meta["course"])

    # ── Build event→style_uid map ──
    event_style: dict[str, int] = {}
    event_number: dict[str, int] = {}
    event_gender: dict[str, int] = {}
    style_names: dict[int, str] = {}

    for event_el in root.iter("EVENT"):
        eid = event_el.get("eventid", "")
        enumber = int(event_el.get("number", "0") or "0")
        egender = {"M": 1, "F": 2}.get(event_el.get("gender", ""), 0)
        event_number[eid] = enumber
        event_gender[eid] = egender

        for ss in event_el.iter("SWIMSTYLE"):
            uid_raw = ss.get("swimstyleid") or ""
            try:
                uid_int = int(uid_raw)
            except (ValueError, TypeError):
                continue
            event_style[eid] = uid_int
            name = ss.get("name", "")
            if name:
                style_names[uid_int] = name

    # ── Create Event records for this meet ──
    events_created = 0
    # Get next event ID to avoid PK conflicts
    from sqlalchemy import func as _func
    next_event_id = (db.query(_func.max(Event.eventsid)).scalar() or 0) + 1
    for eid_str, style_uid in event_style.items():
        # Ensure the SwimStyle exists
        if not db.query(SwimStyle).get(style_uid):
            db.add(SwimStyle(
                swimstyleid=style_uid,
                name=style_names.get(style_uid, f"Style {style_uid}"),
                relaycount=1,
            ))
            db.flush()

        ev = Event(
            eventsid=next_event_id,
            meetsid=meet.meetsid,
            numb=event_number.get(eid_str, 0),
            stylesid=style_uid,
            gender=event_gender.get(eid_str, 0),
        )
        db.add(ev)
        next_event_id += 1
        events_created += 1
    db.flush()

    # ── Parse clubs/athletes and results ──
    results_imported = 0
    athletes_matched = 0
    athletes_created = 0
    clubs_matched = 0
    clubs_created = 0
    member_meet_ids: set[int] = set()
    # Get next result ID to avoid PK conflicts
    next_result_id = (db.query(_func.max(Result.resultsid)).scalar() or 0) + 1

    for club_el in root.iter("CLUB"):
        club_code = club_el.get("code", "")
        club_name = club_el.get("name", "")

        # Find or create club
        if club_code:
            club = db.query(TeamClub).filter(TeamClub.code == club_code).first()
        else:
            club = db.query(TeamClub).filter(TeamClub.name == club_name).first()

        if not club:
            import secrets, string
            pin = ''.join(secrets.choice(string.digits) for _ in range(6))
            club = TeamClub(name=club_name, code=club_code, nation=club_el.get("nation", ""), pin=pin)
            db.add(club)
            db.flush()
            clubs_created += 1
        clubs_matched += 1

        for ath_el in club_el.iter("ATHLETE"):
            first = ath_el.get("firstname", "").strip().rstrip(",")
            last = ath_el.get("lastname", "").strip().rstrip(",")
            license_val = ath_el.get("license", "")
            gender_str = ath_el.get("gender", "M")
            bd_str = ath_el.get("birthdate", "")
            handicap_el = ath_el.find("HANDICAP")
            exception_code = (
                handicap_el.get("exception") if handicap_el is not None else None
            ) or ath_el.get("exception") or None

            # Check if athlete exists before find_or_create
            existing_member = None
            if license_val:
                existing_member = db.query(Member).filter(Member.license == license_val).first()
            if not existing_member:
                existing_member = db.query(Member).filter(
                    Member.firstname == first, Member.lastname == last
                ).first()

            member = _find_or_create_athlete(db, first, last, license_val, club)
            if not member:
                continue

            if not existing_member:
                athletes_created += 1

            # Update birthdate/gender/handicapex if missing
            if bd_str and not member.birthdate:
                try:
                    member.birthdate = _date.fromisoformat(bd_str)
                except ValueError:
                    pass
            if not member.gender:
                from .models import gender_from_str
                member.gender = gender_from_str(gender_str)
            if exception_code and not member.handicapex:
                member.handicapex = exception_code

            athletes_matched += 1

            # Track MemberMeet link
            if member.membersid not in member_meet_ids:
                member_meet_ids.add(member.membersid)
                existing_mm = db.query(MemberMeet).filter(
                    MemberMeet.membersid == member.membersid,
                    MemberMeet.meetsid == meet.meetsid,
                ).first()
                if not existing_mm:
                    db.add(MemberMeet(
                        membersid=member.membersid,
                        meetsid=meet.meetsid,
                        clubsid=club.clubsid,
                    ))

            # Parse RESULT elements for this athlete
            for result_el in ath_el.iter("RESULT"):
                eid = result_el.get("eventid", "")
                style_uid = event_style.get(eid)
                if not style_uid:
                    continue

                swimtime_ms = _lenex_time_to_ms(result_el.get("swimtime", ""))
                status = result_el.get("status", "")

                # Skip DSQ/DNS/DNF — no time to store
                if status in ("DSQ", "DNS", "DNF") and not swimtime_ms:
                    continue

                db.add(Result(
                    resultsid=next_result_id,
                    membersid=member.membersid,
                    meetsid=meet.meetsid,
                    stylesid=style_uid,
                    totaltime=swimtime_ms,
                    course=course_int,
                    eventnumb=event_number.get(eid, 0),
                    resulttyp=0,  # official
                    eventdate=_dt(meta["startdate"].year, meta["startdate"].month, meta["startdate"].day) if meta["startdate"] else None,
                ))
                next_result_id += 1
                results_imported += 1

    db.commit()

    return {
        "meet_id": meet.meetsid,
        "meet_name": meta["name"],
        "meet_date": str(meta["startdate"]) if meta["startdate"] else None,
        "course": meta["course"],
        "results_imported": results_imported,
        "events_created": events_created,
        "athletes_matched": athletes_matched,
        "athletes_created": athletes_created,
        "clubs_matched": clubs_matched,
        "clubs_created": clubs_created,
        "reimported": existing_meet is not None,
    }
