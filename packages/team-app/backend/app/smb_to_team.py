"""Import a Meet Manager .smb file into the Team Manager schema.

Maps:
- BSGLOBAL (MeetName, MeetCity, MeetCourse) → MEETS row
- SWIMSESSION (startdate) → SESSIONS rows
- SWIMEVENT → EVENTS rows
- CLUB → CLUBS (merge by code if existing)
- ATHLETE → MEMBERS (merge by license if existing)
- SWIMRESULT (with swimtime) → RESULTS rows

This is used after a competition: the meet-app exports an .smb,
and the team-app imports it to record results as historical data.
"""
from __future__ import annotations

import secrets
import string
from datetime import datetime, timedelta

from sqlalchemy.orm import Session as DbSession

from .smb import read_smb, D_NULL_SENTINEL
from .models import SwimStyle
from .models_team import (
    Meet, Session as MeetSession, Event, TeamClub, Member,
    Result, MemberMeet,
)


OLE_EPOCH = datetime(1899, 12, 30)


def _ole_to_datetime(val) -> datetime | None:
    if val is None or not isinstance(val, (int, float)):
        return None
    if val == D_NULL_SENTINEL or val == 0:
        return None
    int_part = int(val)
    if int_part == -36522 or int_part == 0:
        frac = abs(val) % 1
        if frac == 0:
            return None
        total_minutes = round(frac * 24 * 60)
        return datetime(2000, 1, 1, total_minutes // 60, total_minutes % 60)
    try:
        dt = OLE_EPOCH + timedelta(days=val)
        if dt.year < 1900 or dt.year > 2100:
            return None
        return dt
    except (OverflowError, ValueError):
        return None


def _ole_to_date(val) -> datetime | None:
    if val is None or not isinstance(val, (int, float)):
        return None
    if val == D_NULL_SENTINEL or val == 0 or val <= 0:
        return None
    try:
        dt = OLE_EPOCH + timedelta(days=int(val))
        if dt.year < 1900 or dt.year > 2100:
            return None
        return dt
    except (OverflowError, ValueError):
        return None


def _next_id(db: DbSession, model, pk_col) -> int:
    """Get next available ID for a table."""
    from sqlalchemy import func
    max_id = db.query(func.max(pk_col)).scalar()
    return (max_id or 0) + 1


def import_smb_as_meet(db: DbSession, smb_bytes: bytes) -> dict:
    """Import an .smb file as a historical meet in the Team Manager schema.

    Returns counts of imported entities.
    """
    tables = read_smb(smb_bytes)

    # ── Extract meet metadata from BSGLOBAL ───────────────────────────────
    bsglobal = {row["name"]: row.get("data", "") for row in tables.get("BSGLOBAL", [])}
    meet_name = bsglobal.get("MeetName", "Imported Meet")
    meet_city = bsglobal.get("MeetCity", "")
    meet_course_str = bsglobal.get("MeetCourse", "1")
    meet_course = int(meet_course_str) if meet_course_str.isdigit() else 1

    # Get meet date from first session
    sessions_data = tables.get("SWIMSESSION", [])
    meet_date = None
    for sess in sessions_data:
        d = _ole_to_date(sess.get("startdate"))
        if d:
            if meet_date is None or d < meet_date:
                meet_date = d

    # ── Create MEETS row ──────────────────────────────────────────────────
    meet_id = _next_id(db, Meet, Meet.meetsid)
    meet = Meet(
        meetsid=meet_id,
        name=meet_name,
        place=meet_city,
        mindate=meet_date,
        maxdate=meet_date,
        course=meet_course,
        meetstate=3,  # completed
    )
    db.add(meet)
    db.flush()

    # ── Import SWIMSTYLE (merge into existing) ────────────────────────────
    styles_imported = 0
    for row in tables.get("SWIMSTYLE", []):
        sid = row.get("swimstyleid")
        if not sid:
            continue
        existing = db.query(SwimStyle).get(sid)
        if not existing:
            db.add(SwimStyle(
                swimstyleid=sid,
                code=row.get("code"),
                distance=row.get("distance"),
                name=row.get("name"),
                relaycount=row.get("relaycount"),
                stroke=row.get("stroke"),
                sortcode=row.get("sortcode"),
            ))
            styles_imported += 1
    db.flush()

    # ── Import CLUBS (merge by code) ──────────────────────────────────────
    # Map old clubid → new clubsid
    club_id_map: dict[int, int] = {}
    clubs_imported = 0
    for row in tables.get("CLUB", []):
        old_id = row.get("clubid")
        if not old_id:
            continue
        code = (row.get("code") or "").strip()
        name = row.get("name") or ""

        # Try to find existing club by code
        existing = db.query(TeamClub).filter(TeamClub.code == code).first() if code else None
        if existing:
            club_id_map[old_id] = existing.clubsid
        else:
            new_id = _next_id(db, TeamClub, TeamClub.clubsid)
            pin = ''.join(secrets.choice(string.digits) for _ in range(6))
            db.add(TeamClub(
                clubsid=new_id,
                name=name,
                code=code,
                nation=row.get("nation") or "CAN",
                pin=pin,
                email=row.get("contactemail") or "",
            ))
            db.flush()
            club_id_map[old_id] = new_id
            clubs_imported += 1

    # ── Import ATHLETES → MEMBERS (merge by license) ─────────────────────
    # Map old athleteid → new membersid
    athlete_id_map: dict[int, int] = {}
    members_imported = 0
    for row in tables.get("ATHLETE", []):
        old_id = row.get("athleteid")
        if not old_id:
            continue
        license_val = (row.get("license") or "").strip()
        firstname = row.get("firstname") or ""
        lastname = row.get("lastname") or ""

        # Try to find existing member by license
        existing = None
        if license_val:
            existing = db.query(Member).filter(Member.license == license_val).first()

        if existing:
            athlete_id_map[old_id] = existing.membersid
        else:
            new_id = _next_id(db, Member, Member.membersid)
            old_club = row.get("clubid")
            new_club = club_id_map.get(old_club)
            birthdate = _ole_to_date(row.get("birthdate"))
            db.add(Member(
                membersid=new_id,
                lastname=lastname,
                firstname=firstname,
                birthdate=birthdate,
                gender=row.get("gender"),
                nation=row.get("nation") or "",
                license=license_val,
                clubsid=new_club,
            ))
            db.flush()
            athlete_id_map[old_id] = new_id
            members_imported += 1

    # ── Import SESSIONS ───────────────────────────────────────────────────
    sessions_imported = 0
    for row in sessions_data:
        sid = row.get("swimsessionid")
        if not sid:
            continue
        new_id = _next_id(db, MeetSession, MeetSession.sessionsid)
        db.add(MeetSession(
            sessionsid=new_id,
            meetsid=meet_id,
            numb=row.get("sessionnumber"),
            startdate=_ole_to_date(row.get("startdate")),
            starttime=_ole_to_datetime(row.get("daytime")),
            name=row.get("name"),
        ))
        sessions_imported += 1
    db.flush()

    # ── Import SWIMEVENT → EVENTS ─────────────────────────────────────────
    events_imported = 0
    for row in tables.get("SWIMEVENT", []):
        eid = row.get("swimeventid")
        if not eid:
            continue
        # Skip internal/admin events
        if row.get("internalevent") == "T":
            continue
        style_id = row.get("swimstyleid")
        new_id = _next_id(db, Event, Event.eventsid)
        db.add(Event(
            eventsid=new_id,
            meetsid=meet_id,
            sessionnumb=None,  # we don't track session number mapping
            numb=row.get("eventnumber"),
            eventtyp=0,
            stylesid=style_id,
            minage=None,
            maxage=None,
            fee=row.get("fee"),
            gender=row.get("gender"),
            sortcode=row.get("sortcode"),
        ))
        events_imported += 1
    db.flush()

    # ── Import SWIMRESULT → RESULTS (only rows with swimtime) ─────────────
    results_imported = 0
    # Build event→style map from SWIMEVENT
    event_style_map: dict[int, int] = {}
    for row in tables.get("SWIMEVENT", []):
        eid = row.get("swimeventid")
        sid = row.get("swimstyleid")
        if eid and sid:
            event_style_map[eid] = sid

    for row in tables.get("SWIMRESULT", []):
        rid = row.get("swimresultid")
        if not rid:
            continue
        old_athlete = row.get("athleteid")
        new_member = athlete_id_map.get(old_athlete)
        if not new_member:
            continue

        swimtime = row.get("swimtime")
        entrytime = row.get("entrytime")
        # Only import if there's a result time or entry time
        if not swimtime and not entrytime:
            continue

        event_id = row.get("swimeventid")
        style_id = event_style_map.get(event_id)

        new_id = _next_id(db, Result, Result.resultsid)
        db.add(Result(
            resultsid=new_id,
            membersid=new_member,
            meetsid=meet_id,
            eventdate=meet_date,
            stylesid=style_id,
            totaltime=swimtime if swimtime and swimtime > 0 else None,
            entrytime=entrytime if entrytime and entrytime > 0 else None,
            eventnumb=row.get("lane"),  # not ideal but preserves some info
            course=meet_course,
            resulttyp=0,  # official
        ))
        results_imported += 1
    db.flush()

    # ── Create MEMBERSMEETS links ─────────────────────────────────────────
    # Link all members who have results in this meet
    member_ids_with_results = set()
    for row in tables.get("SWIMRESULT", []):
        old_athlete = row.get("athleteid")
        new_member = athlete_id_map.get(old_athlete)
        if new_member:
            member_ids_with_results.add(new_member)

    for mid in member_ids_with_results:
        member = db.query(Member).get(mid)
        club_id = member.clubsid if member else None
        db.merge(MemberMeet(
            membersid=mid,
            meetsid=meet_id,
            clubsid=club_id,
        ))
    db.flush()

    db.commit()
    return {
        "meet_name": meet_name,
        "meet_id": meet_id,
        "styles": styles_imported,
        "clubs": clubs_imported,
        "members": members_imported,
        "sessions": sessions_imported,
        "events": events_imported,
        "results": results_imported,
    }
