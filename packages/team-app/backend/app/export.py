"""Generate Lenex .lxf from registrations (swimresult rows with entrytime)."""
from __future__ import annotations

import zipfile
from datetime import date
from io import BytesIO
from xml.etree import ElementTree as ET

from sqlalchemy.orm import Session, joinedload
from .models import (
    SwimEvent, SwimStyle, SwimResult, AgeGroup, BsGlobal,
    SwimSession, gender_to_str, fee_dollars_to_cents,
)
from .models_team import TeamClub, Member
from .best_times import get_best_time_date


def _ms_to_lenex(ms: int | None) -> str:
    if not ms:
        return "NT"
    h = ms // 3600000
    m = (ms % 3600000) // 60000
    s = (ms % 60000) // 1000
    cs = (ms % 1000) // 10
    return f"{h:02d}:{m:02d}:{s:02d}.{cs:02d}"


def _agegroup_for_code(age_groups, age_code: str, masters: bool):
    """Pick the AgeGroup row matching the registration's age_code."""
    if masters:
        return age_groups[0] if age_groups else None
    for ag in age_groups:
        if age_code == "10-" and ag.agemax == 10:
            return ag
        if age_code == "11-12" and ag.agemin == 11 and ag.agemax == 12:
            return ag
        if age_code == "13-14" and ag.agemin == 13 and ag.agemax == 14:
            return ag
        if age_code == "15-18" and ag.agemin == 15 and ag.agemax == 18:
            return ag
        if age_code == "Open" and ag.agemin == 19 and ag.agemax == -1:
            return ag
    return None


def _meet_struct_from_db(db: Session):
    """Build ParsedMeet from DB instead of requiring meet.lxf on disk."""
    from .meet_parser import ParsedMeet, MeetSession, MeetEvent, MeetAgeGroup

    name_row = db.query(BsGlobal).get("meet_name")
    course_row = db.query(BsGlobal).get("meet_course")
    course = (course_row.data if course_row else None) or "LCM"

    gender_map = {1: "M", 2: "F", 3: "X"}
    round_map = {1: "PRE", 2: "SEM", 4: "FIN", 5: "TIM"}

    db_sessions = (
        db.query(SwimSession)
        .order_by(SwimSession.sessionnumber, SwimSession.swimsessionid)
        .all()
    )
    parsed_sessions = []
    for ses in db_sessions:
        events = []
        for ev in sorted(ses.events, key=lambda e: e.sortcode or e.eventnumber or 0):
            ag_list = [
                MeetAgeGroup(ag.agegroupid, ag.agemin or -1, ag.agemax or -1)
                for ag in ev.agegroups
            ]
            events.append(MeetEvent(
                eventid=ev.swimeventid,
                number=ev.eventnumber or 0,
                gender=gender_map.get(ev.gender, "X"),
                round=round_map.get(ev.round, "TIM"),
                event_type="MASTERS" if ev.masters == 'T' else "",
                swimstyleid=ev.swimstyleid or 0,
                distance=ev.swimstyle.distance if ev.swimstyle else 0,
                relaycount=ev.swimstyle.relaycount if ev.swimstyle else 1,
                style_name=ev.swimstyle.name if ev.swimstyle else "",
                agegroups=ag_list,
                roundname=ev.roundname or (ev.comment if ev.swimstyleid is None else "") or "",
                is_internal=(ev.internalevent == 'T' or ev.swimstyleid is None),
            ))
        parsed_sessions.append(MeetSession(
            number=ses.sessionnumber or ses.swimsessionid,
            name=ses.name or "",
            events=events,
        ))

    return ParsedMeet(
        meet_name=(name_row.data if name_row else "") or "Inscription Export",
        course=course,
        sessions=parsed_sessions,
    )


def generate_lxf(db: Session) -> bytes:
    """Generate a Lenex 3.0 .lxf zip from all registrations."""
    meet_struct = _meet_struct_from_db(db)

    cfg = db.query(BsGlobal).get("age_base_date")
    age_base_date = cfg.data if cfg and cfg.data else date(date.today().year, 12, 31).isoformat()

    # Get all registrations
    regs = db.query(SwimResult).options(
        joinedload(SwimResult.member).joinedload(Member.club),
        joinedload(SwimResult.event).joinedload(SwimEvent.agegroups),
        joinedload(SwimResult.event).joinedload(SwimEvent.swimstyle),
    ).all()

    # Group by club -> athlete -> entries
    clubs_map: dict[int, dict] = {}
    for reg in regs:
        member = reg.member
        club = member.club
        clubs_map.setdefault(club.clubsid, {"club": club, "athletes": {}})
        clubs_map[club.clubsid]["athletes"].setdefault(member.membersid, {"athlete": member, "entries": []})
        clubs_map[club.clubsid]["athletes"][member.membersid]["entries"].append(reg)

    # Build XML
    root = ET.Element("LENEX", version="3.0")
    meets = ET.SubElement(root, "MEETS")
    meet_attrs = {
        "name": meet_struct.meet_name or "Inscription Export",
        "course": meet_struct.course or "LCM",
    }
    # Add optional meet attributes from bsglobal
    for key, attr_name in [("meet_city", "city"), ("meet_nation", "nation"),
                           ("meet_masters", "masters")]:
        row = db.query(BsGlobal).get(key)
        if row and row.data:
            meet_attrs[attr_name] = row.data
    # Read organizer/hostclub from MEETVALUES
    mv_row = db.query(BsGlobal).get("MEETVALUES")
    if mv_row and mv_row.data:
        for line in mv_row.data.replace("\\r", "").split("\n"):
            line = line.strip("\r\n ")
            eq = line.find("=")
            if eq >= 0:
                key = line[:eq]
                val_part = line[eq + 1:]
                semi = val_part.find(";")
                val = val_part[semi + 1:] if semi >= 0 else val_part
                if val:
                    if key == "ORGANIZER":
                        meet_attrs["organizer"] = val
                    elif key == "HOSTCLUB":
                        meet_attrs["hostclub"] = val
                    elif key == "STATE":
                        meet_attrs["state"] = val
                    elif key == "CITY" and "city" not in meet_attrs:
                        meet_attrs["city"] = val
    meet = ET.SubElement(meets, "MEET", meet_attrs)
    ET.SubElement(meet, "AGEDATE", value=age_base_date, type="DATE")

    # Sessions + Events from meet structure
    sessions_xml = ET.SubElement(meet, "SESSIONS")
    for ses in meet_struct.sessions:
        ses_xml = ET.SubElement(sessions_xml, "SESSION", {
            "number": str(ses.number),
            "name": ses.name or "",
            "date": age_base_date,
            "course": meet_struct.course or "LCM",
        })
        evts_xml = ET.SubElement(ses_xml, "EVENTS")
        for idx, m_ev in enumerate(ses.events, start=1):
            ev_attrs: dict[str, str] = {
                "eventid": str(m_ev.eventid),
                "number": str(m_ev.number),
                "order": str(idx),
                "gender": m_ev.gender,
                "round": m_ev.round,
            }
            if m_ev.roundname:
                ev_attrs["name"] = m_ev.roundname
            if m_ev.is_internal:
                ev_attrs["internalevent"] = "T"
            ev_xml = ET.SubElement(evts_xml, "EVENT", ev_attrs)
            style_attrs: dict[str, str] = {
                "stroke": "UNKNOWN",
                "distance": str(m_ev.distance),
                "relaycount": str(m_ev.relaycount),
            }
            if m_ev.swimstyleid:
                style_attrs["swimstyleid"] = str(m_ev.swimstyleid)
            if m_ev.style_name:
                style_attrs["name"] = m_ev.style_name
            ET.SubElement(ev_xml, "SWIMSTYLE", style_attrs)
            if m_ev.agegroups:
                ags_xml = ET.SubElement(ev_xml, "AGEGROUPS")
                for ag in m_ev.agegroups:
                    ET.SubElement(ags_xml, "AGEGROUP", {
                        "agegroupid": str(ag.agegroupid),
                        "agemin": str(ag.agemin),
                        "agemax": str(ag.agemax),
                    })

    clubs_xml = ET.SubElement(meet, "CLUBS")

    for club_data in clubs_map.values():
        club = club_data["club"]
        club_xml = ET.SubElement(clubs_xml, "CLUB", {
            "name": club.name,
            "code": club.code or "",
            "nation": club.nation or "CAN",
            "clubid": str(club.clubsid),
        })
        athletes_xml = ET.SubElement(club_xml, "ATHLETES")

        for ath_data in club_data["athletes"].values():
            ath = ath_data["athlete"]
            ath_xml = ET.SubElement(athletes_xml, "ATHLETE", {
                "athleteid": str(ath.membersid),
                "firstname": ath.firstname,
                "lastname": ath.lastname,
                "gender": gender_to_str(ath.gender),
                "birthdate": str(ath.birthdate.date()) if ath.birthdate else "",
                "license": ath.license or "",
            })
            if ath.handicapex:
                ET.SubElement(ath_xml, "HANDICAP", {"exception": ath.handicapex})
            entries_xml = ET.SubElement(ath_xml, "ENTRIES")
            for reg in ath_data["entries"]:
                ev = reg.event
                if not ev:
                    continue
                entry_attrs = {
                    "eventid": str(ev.swimeventid),
                    "entrycourse": meet_struct.course or "LCM",
                }
                ag = _agegroup_for_code(ev.agegroups, reg.age_code, ev.masters == "T")
                if ag:
                    entry_attrs["agegroupid"] = str(ag.agegroupid)
                if reg.entrytime:
                    entry_attrs["entrytime"] = _ms_to_lenex(reg.entrytime)
                entry_xml = ET.SubElement(entries_xml, "ENTRY", entry_attrs)
                if reg.entrytime and ev.swimstyleid:
                    bt_date = get_best_time_date(db, ath.membersid, ev.swimstyleid,
                                                 meet_struct.course or "LCM")
                    meetinfo_attrs = {
                        "qualificationtime": _ms_to_lenex(reg.entrytime),
                        "course": meet_struct.course or "LCM",
                        "date": str(bt_date) if bt_date else str(date.today()),
                    }
                    ET.SubElement(entry_xml, "MEETINFO", meetinfo_attrs)

    xml_bytes = ET.tostring(root, encoding="unicode", xml_declaration=True).encode("utf-8")

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("meet.lef", xml_bytes)
        # Embed Gemini API keys as hidden dotfile (key transport to meet-app)
        gemini_free = db.query(BsGlobal).get("GEMINI_KEY_FREE")
        gemini_paid = db.query(BsGlobal).get("GEMINI_KEY_PAID")
        if (gemini_free and gemini_free.data) or (gemini_paid and gemini_paid.data):
            import json as _json
            keys = {}
            if gemini_free and gemini_free.data:
                keys["gemini_free"] = gemini_free.data
            if gemini_paid and gemini_paid.data:
                keys["gemini_paid"] = gemini_paid.data
            z.writestr(".keys", _json.dumps(keys))
    return buf.getvalue()


_STROKE_MAP = {1: "FREE", 2: "BACK", 3: "BREAST", 4: "FLY", 5: "MEDLEY", 6: "FREE", 7: "MEDLEY"}
_GENDER_MAP = {1: "M", 2: "F", 3: "X"}
_ROUND_MAP = {1: "PRE", 2: "SEM", 4: "FIN", 5: "TIM"}


def generate_meet_lxf_from_db(db: Session) -> bytes:
    """Generate a meet-structure .lxf (sessions + events) from DB, no file required."""
    meet_struct = _meet_struct_from_db(db)

    cfg = db.query(BsGlobal).get("age_base_date")
    age_base_date = cfg.data if cfg and cfg.data else date(date.today().year, 12, 31).isoformat()

    db_sessions = (
        db.query(SwimSession)
        .order_by(SwimSession.sessionnumber, SwimSession.swimsessionid)
        .all()
    )

    root = ET.Element("LENEX", version="3.0")
    meets_xml = ET.SubElement(root, "MEETS")
    meet_xml = ET.SubElement(meets_xml, "MEET", {
        "name": meet_struct.meet_name or "Meet Export",
        "course": meet_struct.course or "LCM",
        "city": "",
    })
    ET.SubElement(meet_xml, "AGEDATE", value=age_base_date, type="DATE")

    sessions_xml = ET.SubElement(meet_xml, "SESSIONS")
    for ses in db_sessions:
        ses_date = ""
        if ses.daytime:
            ses_date = ses.daytime.strftime("%Y-%m-%d")
        elif ses.startdate:
            ses_date = ses.startdate.strftime("%Y-%m-%d")
        ses_xml = ET.SubElement(sessions_xml, "SESSION", {
            "number": str(ses.sessionnumber or ses.swimsessionid),
            "name": ses.name or "",
            "date": ses_date,
            "course": meet_struct.course or "LCM",
        })
        evts_xml = ET.SubElement(ses_xml, "EVENTS")
        for ev in sorted(ses.events, key=lambda e: e.sortcode or e.eventnumber or 0):
            ev_attrs = {
                "eventid": str(ev.swimeventid),
                "number": str(ev.eventnumber or 0),
                "gender": _GENDER_MAP.get(ev.gender, "X"),
                "round": _ROUND_MAP.get(ev.round, "TIM"),
            }
            if ev.masters == 'T':
                ev_attrs["type"] = "MASTERS"
            if ev.roundname:
                ev_attrs["name"] = ev.roundname
            elif ev.swimstyleid is None and ev.comment:
                ev_attrs["name"] = ev.comment
            if ev.internalevent == 'T' or ev.swimstyleid is None:
                ev_attrs["internalevent"] = "T"
            ev_xml = ET.SubElement(evts_xml, "EVENT", ev_attrs)
            style_attrs = {
                "stroke": _STROKE_MAP.get(ev.swimstyle.stroke if ev.swimstyle else 0, "UNKNOWN"),
                "distance": str(ev.swimstyle.distance if ev.swimstyle else 0),
                "relaycount": str(ev.swimstyle.relaycount if ev.swimstyle else 1),
                "swimstyleid": str(ev.swimstyleid or 0),
            }
            if ev.swimstyle and ev.swimstyle.name:
                style_attrs["name"] = ev.swimstyle.name
            ET.SubElement(ev_xml, "SWIMSTYLE", style_attrs)
            if ev.agegroups:
                ags_xml = ET.SubElement(ev_xml, "AGEGROUPS")
                for ag in ev.agegroups:
                    ET.SubElement(ags_xml, "AGEGROUP", {
                        "agegroupid": str(ag.agegroupid),
                        "agemin": str(ag.agemin if ag.agemin is not None else -1),
                        "agemax": str(ag.agemax if ag.agemax is not None else -1),
                    })

    xml_bytes = ET.tostring(root, encoding="unicode", xml_declaration=True).encode("utf-8")
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("meet.lef", xml_bytes)
    return buf.getvalue()
