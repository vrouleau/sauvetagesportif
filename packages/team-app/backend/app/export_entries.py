"""Export all athletes and best times as a Lenex .lxf entries file."""
from __future__ import annotations

import zipfile
from io import BytesIO
from xml.etree import ElementTree as ET

from sqlalchemy.orm import Session, joinedload
from .models import SwimEvent, SwimStyle, BsGlobal, gender_to_str
from .models_team import TeamClub, Member
from .best_times import get_best_times


def _ms_to_lenex(ms: int | None) -> str:
    if not ms:
        return "NT"
    h = ms // 3600000
    m = (ms % 3600000) // 60000
    s = (ms % 60000) // 1000
    cs = (ms % 1000) // 10
    return f"{h:02d}:{m:02d}:{s:02d}.{cs:02d}"


def generate_entries_lxf(db: Session) -> bytes:
    """Generate Lenex .lxf with all clubs, athletes, and best times."""
    clubs = db.query(TeamClub).options(
        joinedload(TeamClub.members)
    ).all()

    # Collect all style_uids from best times
    style_uids: set[int] = set()
    athlete_bts: dict[int, dict] = {}
    for club in clubs:
        for member in club.members:
            bt_data = get_best_times(db, member.membersid)
            if bt_data:
                athlete_bts[member.membersid] = bt_data
                for uid_key in bt_data:
                    style_uids.add(int(uid_key))

    # Get style names
    style_names: dict[int, str] = {}
    for uid in style_uids:
        style = db.query(SwimStyle).get(uid)
        style_names[uid] = style.name if style else ""

    root = ET.Element("LENEX", version="3.0")
    meets = ET.SubElement(root, "MEETS")
    meet = ET.SubElement(meets, "MEET", {
        "name": "Entries Export",
        "city": "",
        "course": "LCM",
    })

    # One SESSION with one EVENT per style_uid
    sessions = ET.SubElement(meet, "SESSIONS")
    session = ET.SubElement(sessions, "SESSION", {"number": "1", "course": "LCM"})
    events_xml = ET.SubElement(session, "EVENTS")
    for uid in sorted(style_uids):
        ev_xml = ET.SubElement(events_xml, "EVENT", {
            "eventid": str(uid),
            "number": str(uid),
            "gender": "X",
            "round": "TIM",
        })
        ET.SubElement(ev_xml, "SWIMSTYLE", {
            "swimstyleid": str(uid),
            "name": style_names.get(uid, ""),
            "distance": "0",
            "relaycount": "1",
            "stroke": "FREE",
        })

    clubs_xml = ET.SubElement(meet, "CLUBS")
    for club in clubs:
        if not club.members:
            continue
        club_xml = ET.SubElement(clubs_xml, "CLUB", {
            "name": club.name,
            "code": club.code or "",
            "nation": club.nation or "",
        })
        if club.email:
            ET.SubElement(club_xml, "CONTACT", {"email": club.email})
        athletes_xml = ET.SubElement(club_xml, "ATHLETES")
        for member in club.members:
            ath_xml = ET.SubElement(athletes_xml, "ATHLETE", {
                "athleteid": str(member.membersid),
                "firstname": member.firstname,
                "lastname": member.lastname,
                "gender": gender_to_str(member.gender),
                "birthdate": str(member.birthdate.date()) if member.birthdate else "",
                "license": member.license or "",
                **({"exception": member.handicapex} if member.handicapex else {}),
            })
            bt_data = athlete_bts.get(member.membersid, {})
            if bt_data:
                entries_xml = ET.SubElement(ath_xml, "ENTRIES")
                for uid_key, style_data in bt_data.items():
                    for course, entry in style_data.items():
                        time_ms = entry.get("time_ms")
                        if not time_ms:
                            continue
                        entry_xml = ET.SubElement(entries_xml, "ENTRY", {
                            "eventid": uid_key,
                            "entrycourse": course,
                            "entrytime": _ms_to_lenex(time_ms),
                        })
                        meetinfo_attrs = {
                            "qualificationtime": _ms_to_lenex(time_ms),
                            "course": course,
                        }
                        if entry.get("date"):
                            meetinfo_attrs["date"] = entry["date"]
                        ET.SubElement(entry_xml, "MEETINFO", meetinfo_attrs)

    xml_bytes = ET.tostring(root, encoding="unicode", xml_declaration=True).encode("utf-8")

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("entries.lef", xml_bytes)
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
