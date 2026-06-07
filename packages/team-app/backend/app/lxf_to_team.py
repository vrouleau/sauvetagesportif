"""Import a results LENEX .lxf file into the Team Manager schema.

Maps:
- MEET element (name, city, course, startdate) → MEETS row
- SESSIONS/SESSION → SESSIONS rows
- CLUBS/CLUB/ATHLETES/ATHLETE → CLUBS + MEMBERS (merge by license / club code)
- ATHLETE/RESULTS/RESULT → RESULTS rows (only rows with swimtime or status)

This is the LXF equivalent of smb_to_team.py, used after a competition:
meet-app exports results via File → "Exporter les résultats LENEX…",
and the team-app organizer imports it to record results as historical data.
"""
from __future__ import annotations

import secrets
import string
import zipfile
from datetime import datetime, date
from io import BytesIO
from xml.etree import ElementTree as ET

from sqlalchemy import func
from sqlalchemy.orm import Session as DbSession

from .models import SwimStyle
from .models_team import (
    Meet, Session as MeetSession, Event, TeamClub, Member,
    Result, MemberMeet,
)


def _lenex_time_to_ms(t: str | None) -> int | None:
    """Convert LENEX time 'HH:MM:SS.cc' or 'MM:SS.cc' to integer milliseconds."""
    if not t or t == "NT":
        return None
    parts = t.split(":")
    try:
        if len(parts) == 3:
            hh, mm, ss_cc = int(parts[0]), int(parts[1]), parts[2]
        elif len(parts) == 2:
            hh, mm, ss_cc = 0, int(parts[0]), parts[1]
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


def _course_to_int(course: str) -> int:
    return {"LCM": 1, "SCY": 2, "SCM": 3}.get((course or "").upper(), 1)


def _next_id(db: DbSession, model, pk_col) -> int:
    max_id = db.query(func.max(pk_col)).scalar()
    return (max_id or 0) + 1


def _read_lef_xml(content: bytes) -> ET.Element:
    with zipfile.ZipFile(BytesIO(content)) as z:
        lef_name = next(n for n in z.namelist() if n.endswith(".lef"))
        xml_bytes = z.read(lef_name)
    return ET.fromstring(xml_bytes)


def import_lxf_as_meet(db: DbSession, content: bytes) -> dict:
    """Import a results .lxf as a historical meet in the Team Manager schema.

    If a completed meet with the same name already exists, its results are
    replaced (events/sessions/results deleted and re-imported).  Clubs and
    members are always merged by code/license rather than recreated.

    Returns counts of imported entities.
    """
    root = _read_lef_xml(content)
    meet_el = root.find(".//MEET")
    if meet_el is None:
        raise ValueError("No MEET element found in LENEX file")

    # ── Meet metadata ─────────────────────────────────────────────────────────
    meet_name = meet_el.get("name") or "Imported Meet"
    meet_city = meet_el.get("city") or ""
    course_str = meet_el.get("course") or "LCM"
    meet_course = _course_to_int(course_str)
    meet_date = _parse_date(meet_el.get("startdate") or meet_el.get("date"))

    # Fall back to first SESSION date if no meet-level date
    if not meet_date:
        for sess_el in root.iter("SESSION"):
            meet_date = _parse_date(sess_el.get("date"))
            if meet_date:
                break

    # ── Create or reuse MEETS row ─────────────────────────────────────────────
    existing_meet = db.query(Meet).filter(
        func.lower(Meet.name) == meet_name.lower(),
        Meet.meetstate == 3,
    ).first()

    if existing_meet:
        meet_id = existing_meet.meetsid
        existing_meet.place = meet_city
        existing_meet.course = meet_course
        if meet_date:
            existing_meet.mindate = meet_date
            existing_meet.maxdate = meet_date
        # Replace existing results/events/sessions for this meet
        db.query(MemberMeet).filter(MemberMeet.meetsid == meet_id).delete()
        db.query(Result).filter(Result.meetsid == meet_id).delete()
        db.query(Event).filter(Event.meetsid == meet_id).delete()
        db.query(MeetSession).filter(MeetSession.meetsid == meet_id).delete()
        db.flush()
    else:
        meet_id = _next_id(db, Meet, Meet.meetsid)
        db.add(Meet(
            meetsid=meet_id,
            name=meet_name,
            place=meet_city,
            mindate=meet_date,
            maxdate=meet_date,
            course=meet_course,
            meetstate=3,  # completed
        ))
        db.flush()

    # ── Build eventid → swimstyleid map from SESSIONS/EVENTS ─────────────────
    event_style_map: dict[str, int | None] = {}
    events_imported = 0
    for ev_el in root.iter("EVENT"):
        eid = ev_el.get("eventid")
        if not eid:
            continue
        style_el = ev_el.find("SWIMSTYLE")
        if style_el is not None:
            style_id_str = style_el.get("swimstyleid")
            style_id = int(style_id_str) if style_id_str else None
            event_style_map[eid] = style_id
            # Ensure swimstyle exists in DB
            if style_id and not db.query(SwimStyle).get(style_id):
                db.add(SwimStyle(
                    swimstyleid=style_id,
                    distance=int(style_el.get("distance") or 0),
                    name=style_el.get("name") or "",
                    relaycount=int(style_el.get("relaycount") or 1),
                    stroke=None,
                ))
                db.flush()
            # Create Event row
            ev_gender_str = ev_el.get("gender", "X")
            ev_gender = {"M": 1, "F": 2, "X": 3}.get(ev_gender_str.upper(), 3)
            new_ev_id = _next_id(db, Event, Event.eventsid)
            db.add(Event(
                eventsid=new_ev_id,
                meetsid=meet_id,
                sessionnumb=None,
                numb=int(ev_el.get("number") or 0),
                eventtyp=0,
                stylesid=style_id,
                minage=None,
                maxage=None,
                gender=ev_gender,
                sortcode=int(ev_el.get("order") or ev_el.get("number") or 0),
            ))
            events_imported += 1
    db.flush()

    # ── Sessions ──────────────────────────────────────────────────────────────
    sessions_imported = 0
    for sess_el in root.iter("SESSION"):
        new_id = _next_id(db, MeetSession, MeetSession.sessionsid)
        sess_date = _parse_date(sess_el.get("date"))
        db.add(MeetSession(
            sessionsid=new_id,
            meetsid=meet_id,
            numb=int(sess_el.get("number") or 0),
            startdate=sess_date,
            name=(sess_el.get("name") or "")[:50],
        ))
        sessions_imported += 1
    db.flush()

    # ── Clubs + Athletes + Results ────────────────────────────────────────────
    clubs_imported = 0
    members_imported = 0
    results_imported = 0
    member_ids_with_results: set[int] = set()

    for club_el in root.iter("CLUB"):
        code = (club_el.get("code") or "").strip()
        club_name = club_el.get("name") or ""
        nation = club_el.get("nation") or "CAN"

        # Merge by code
        existing_club = db.query(TeamClub).filter(TeamClub.code == code).first() if code else None
        if existing_club:
            club_team_id = existing_club.clubsid
        else:
            club_team_id = _next_id(db, TeamClub, TeamClub.clubsid)
            pin = "".join(secrets.choice(string.digits) for _ in range(6))
            db.add(TeamClub(
                clubsid=club_team_id,
                name=club_name,
                code=code,
                nation=nation,
                pin=pin,
                email="",
            ))
            db.flush()
            clubs_imported += 1

        for ath_el in club_el.iter("ATHLETE"):
            license_val = (ath_el.get("license") or "").strip()
            firstname = ath_el.get("firstname") or ""
            lastname = ath_el.get("lastname") or ""
            birthdate = _parse_date(ath_el.get("birthdate"))
            gender_str = ath_el.get("gender") or "M"
            gender_int = {"M": 1, "F": 2}.get(gender_str.upper(), 1)
            nation_ath = ath_el.get("nation") or nation
            handicap_el = ath_el.find("HANDICAP")
            exception_code = (
                handicap_el.get("exception") if handicap_el is not None else None
            ) or ath_el.get("exception") or None

            # Merge by license
            existing_member = None
            if license_val:
                existing_member = db.query(Member).filter(Member.license == license_val).first()

            if existing_member:
                member_id = existing_member.membersid
                if exception_code and not existing_member.handicapex:
                    existing_member.handicapex = exception_code
            else:
                member_id = _next_id(db, Member, Member.membersid)
                db.add(Member(
                    membersid=member_id,
                    lastname=lastname,
                    firstname=firstname,
                    birthdate=birthdate,
                    gender=gender_int,
                    nation=nation_ath,
                    license=license_val,
                    clubsid=club_team_id,
                    handicapex=exception_code,
                ))
                db.flush()
                members_imported += 1

            for result_el in ath_el.iter("RESULT"):
                eid = result_el.get("eventid")
                swimtime_ms = _lenex_time_to_ms(result_el.get("swimtime"))
                entrytime_ms = _lenex_time_to_ms(result_el.get("entrytime"))
                if not swimtime_ms and not entrytime_ms:
                    continue
                style_id = event_style_map.get(eid) if eid else None
                res_id = _next_id(db, Result, Result.resultsid)
                db.add(Result(
                    resultsid=res_id,
                    membersid=member_id,
                    meetsid=meet_id,
                    eventdate=meet_date,
                    stylesid=style_id,
                    totaltime=swimtime_ms,
                    entrytime=entrytime_ms,
                    course=meet_course,
                    resulttyp=0,  # official
                ))
                results_imported += 1
                member_ids_with_results.add(member_id)
    db.flush()

    # ── MemberMeet links ──────────────────────────────────────────────────────
    for mid in member_ids_with_results:
        member = db.query(Member).get(mid)
        db.merge(MemberMeet(
            membersid=mid,
            meetsid=meet_id,
            clubsid=member.clubsid if member else None,
        ))
    db.flush()

    db.commit()
    return {
        "meet_name": meet_name,
        "meet_id": meet_id,
        "clubs": clubs_imported,
        "members": members_imported,
        "sessions": sessions_imported,
        "events": events_imported,
        "results": results_imported,
    }
