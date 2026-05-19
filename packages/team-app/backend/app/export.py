"""Generate Lenex .lxf from registrations (swimresult rows with entrytime)."""
from __future__ import annotations

import os
import zipfile
from datetime import date
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

from sqlalchemy.orm import Session, joinedload
from .models import (
    Club, Athlete, SwimEvent, SwimStyle, SwimResult, AgeGroup, BsGlobal,
    gender_to_str, fee_dollars_to_cents,
)
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


def generate_lxf(db: Session) -> bytes:
    """Generate a Lenex 3.0 .lxf zip from all registrations."""
    from .meet_parser import parse_meet_lxf

    meet_path = Path(os.environ.get("MEET_STORAGE", "/app/data/meet.lxf"))
    meet_struct = parse_meet_lxf(meet_path)

    cfg = db.query(BsGlobal).get("age_base_date")
    age_base_date = cfg.data if cfg and cfg.data else date(date.today().year, 12, 31).isoformat()

    # Get all registrations
    regs = db.query(SwimResult).options(
        joinedload(SwimResult.athlete).joinedload(Athlete.club),
        joinedload(SwimResult.event).joinedload(SwimEvent.agegroups),
        joinedload(SwimResult.event).joinedload(SwimEvent.swimstyle),
    ).all()

    # Group by club -> athlete -> entries
    clubs_map: dict[int, dict] = {}
    for reg in regs:
        ath = reg.athlete
        club = ath.club
        clubs_map.setdefault(club.clubid, {"club": club, "athletes": {}})
        clubs_map[club.clubid]["athletes"].setdefault(ath.athleteid, {"athlete": ath, "entries": []})
        clubs_map[club.clubid]["athletes"][ath.athleteid]["entries"].append(reg)

    # Build XML
    root = ET.Element("LENEX", version="3.0")
    meets = ET.SubElement(root, "MEETS")
    meet = ET.SubElement(meets, "MEET", {
        "name": meet_struct.meet_name or "Inscription Export",
        "city": "Laval",
        "course": meet_struct.course or "LCM",
    })
    ET.SubElement(meet, "AGEDATE", value=age_base_date, type="DATE")

    # Sessions + Events from meet structure
    sessions_xml = ET.SubElement(meet, "SESSIONS")
    for ses in meet_struct.sessions:
        ses_xml = ET.SubElement(sessions_xml, "SESSION", {
            "number": str(ses.number),
            "date": age_base_date,
            "course": meet_struct.course or "LCM",
        })
        evts_xml = ET.SubElement(ses_xml, "EVENTS")
        for m_ev in ses.events:
            ev_xml = ET.SubElement(evts_xml, "EVENT", {
                "eventid": str(m_ev.eventid),
                "number": str(m_ev.number),
                "gender": m_ev.gender,
                "round": m_ev.round,
            })
            ET.SubElement(ev_xml, "SWIMSTYLE", {
                "stroke": "UNKNOWN",
                "distance": str(m_ev.distance),
                "relaycount": str(m_ev.relaycount),
            })
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
            "clubid": str(club.clubid),
        })
        athletes_xml = ET.SubElement(club_xml, "ATHLETES")

        for ath_data in club_data["athletes"].values():
            ath = ath_data["athlete"]
            ath_xml = ET.SubElement(athletes_xml, "ATHLETE", {
                "athleteid": str(ath.athleteid),
                "firstname": ath.firstname,
                "lastname": ath.lastname,
                "gender": gender_to_str(ath.gender),
                "birthdate": str(ath.birthdate.date()) if ath.birthdate else "",
                "license": ath.license or "",
            })
            if ath.exception:
                ET.SubElement(ath_xml, "HANDICAP", {"exception": ath.exception})
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
                    bt_date = get_best_time_date(db, ath.athleteid, ev.swimstyleid,
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
    return buf.getvalue()
