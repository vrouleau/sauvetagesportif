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

"""Generate Lenex .lxf from registrations (swimresult rows with entrytime)."""
from __future__ import annotations

import os
import zipfile
from datetime import date
from io import BytesIO
from xml.etree import ElementTree as ET

from sqlalchemy.orm import Session, joinedload
from .models import (
    SwimEvent, SwimStyle, SwimResult, AgeGroup, BsGlobal,
    SwimSession, gender_to_str, fee_dollars_to_cents,
)
from .models_team import TeamClub, Member, Relay, RelayPos
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

    # Include every club member, not just registered ones, so late arrivals on meet
    # day can be added straight from the roster in meet-app without a re-upload.
    for club in db.query(TeamClub).options(joinedload(TeamClub.members)).all():
        if not club.members:
            continue
        club_data = clubs_map.setdefault(club.clubsid, {"club": club, "athletes": {}})
        for member in club.members:
            club_data["athletes"].setdefault(member.membersid, {"athlete": member, "entries": []})

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
            else:
                # Style-less events (pauses/breaks) are flagged code="ID0" so Splash
                # recognizes the SWIMSTYLE as an intentional placeholder, not a missing style.
                style_attrs["code"] = "ID0"
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

    # ── Relay teams (RELAY/RELAYPOSITION elements per club) ────────────────
    # Query all relay teams and their positions, grouped by club
    relay_rows = (
        db.query(Relay)
        .filter(Relay.clubsid.isnot(None))
        .order_by(Relay.clubsid, Relay.stylesid, Relay.teamnumb)
        .all()
    )
    relay_pos_rows = (
        db.query(RelayPos)
        .join(Relay, RelayPos.relaysid == Relay.relaysid)
        .filter(RelayPos.membersid.isnot(None))
        .order_by(RelayPos.relaysid, RelayPos.numb)
        .all()
    )
    # Build lookup: relaysid → list of positions
    positions_by_relay: dict[int, list[RelayPos]] = {}
    for pos in relay_pos_rows:
        positions_by_relay.setdefault(pos.relaysid, []).append(pos)

    # Group relays by club
    relays_by_club: dict[int, list[Relay]] = {}
    for relay in relay_rows:
        relays_by_club.setdefault(relay.clubsid, []).append(relay)

    # Load custom team names from relay.name column (fallback to bsglobal for backward compat)
    custom_names: dict[int, str] = {}
    for r in relay_rows:
        if r.name:
            custom_names[r.relaysid] = r.name
    missing_name_relays = [r for r in relay_rows if r.relaysid not in custom_names]
    if missing_name_relays:
        relay_name_keys = [f"relay_name_{r.relaysid}" for r in missing_name_relays]
        for cfg in db.query(BsGlobal).filter(BsGlobal.name.in_(relay_name_keys)).all():
            rid = int(cfg.name.replace("relay_name_", ""))
            custom_names[rid] = cfg.data

    # Build member lookup for relay positions (ensure all relay members are exported as athletes)
    all_relay_member_ids = {pos.membersid for pos in relay_pos_rows}
    member_ids_in_export = set()
    for club_data in clubs_map.values():
        for mid in club_data["athletes"]:
            member_ids_in_export.add(mid)
    # Members who are in relays but not in individual entries — need to be added as ATHLETE elements
    missing_member_ids = all_relay_member_ids - member_ids_in_export
    missing_members_by_club: dict[int, list] = {}
    if missing_member_ids:
        for m in db.query(Member).filter(Member.membersid.in_(missing_member_ids)).all():
            missing_members_by_club.setdefault(m.clubsid, []).append(m)

    for club_data in clubs_map.values():
        club = club_data["club"]
        club_relays = relays_by_club.get(club.clubsid)
        if not club_relays:
            continue
        # Find the CLUB xml element (already created above)
        club_xml = None
        for c_xml in clubs_xml:
            if c_xml.get("clubid") == str(club.clubsid):
                club_xml = c_xml
                break
        if club_xml is None:
            continue

        # Add relay-only members as ATHLETE elements (so athleteid refs resolve)
        extra_members = missing_members_by_club.get(club.clubsid, [])
        if extra_members:
            athletes_xml = club_xml.find("ATHLETES")
            if athletes_xml is None:
                athletes_xml = ET.SubElement(club_xml, "ATHLETES")
            for m in extra_members:
                ET.SubElement(athletes_xml, "ATHLETE", {
                    "athleteid": str(m.membersid),
                    "firstname": m.firstname or "",
                    "lastname": m.lastname or "",
                    "gender": gender_to_str(m.gender),
                    "birthdate": str(m.birthdate.date()) if m.birthdate else "",
                    "license": m.license or "",
                })

        relays_xml = ET.SubElement(club_xml, "RELAYS")
        for relay in club_relays:
            # Build team name: custom name or concatenated last names
            positions = positions_by_relay.get(relay.relaysid, [])
            team_name = custom_names.get(relay.relaysid)
            if not team_name and positions:
                member_ids = [p.membersid for p in positions]
                names = []
                for mid in member_ids:
                    m = db.query(Member).get(mid)
                    if m:
                        names.append(m.lastname or "")
                team_name = "/".join(names) if names else None

            relay_attrs: dict[str, str] = {
                "number": str(relay.teamnumb or 1),
            }
            if team_name:
                relay_attrs["name"] = team_name
            if relay.gender:
                relay_attrs["gender"] = gender_to_str(relay.gender)
            if relay.minage is not None:
                relay_attrs["agemin"] = str(relay.minage)
            if relay.maxage is not None:
                relay_attrs["agemax"] = str(relay.maxage)
            relay_xml = ET.SubElement(relays_xml, "RELAY", relay_attrs)
            # RELAYPOSITIONS at RELAY level (Lenex 3.0 spec)
            if positions:
                positions_xml = ET.SubElement(relay_xml, "RELAYPOSITIONS")
                for pos in positions:
                    pos_attrs: dict[str, str] = {
                        "number": str(pos.numb),
                        "athleteid": str(pos.membersid),
                    }
                    if pos.entrytime:
                        pos_attrs["entrytime"] = _ms_to_lenex(pos.entrytime)
                    ET.SubElement(positions_xml, "RELAYPOSITION", pos_attrs)
            # ENTRIES — always include eventid so importers know which event the relay belongs to
            relay_entries_xml = ET.SubElement(relay_xml, "ENTRIES")
            relay_entry_attrs: dict[str, str] = {
                "entrycourse": meet_struct.course or "LCM",
            }
            if relay.entrytime:
                relay_entry_attrs["entrytime"] = _ms_to_lenex(relay.entrytime)
            # Find matching event by stylesid + gender + age range
            for ses in meet_struct.sessions:
                for m_ev in ses.events:
                    if m_ev.swimstyleid == relay.stylesid:
                        relay_entry_attrs["eventid"] = str(m_ev.eventid)
                        break
                if "eventid" in relay_entry_attrs:
                    break
            entry_xml = ET.SubElement(relay_entries_xml, "ENTRY", relay_entry_attrs)
            # Also put RELAYPOSITIONS inside ENTRY (meet-app importer expects them here)
            if positions:
                positions_xml2 = ET.SubElement(entry_xml, "RELAYPOSITIONS")
                for pos in positions:
                    pos_attrs2: dict[str, str] = {
                        "number": str(pos.numb),
                        "athleteid": str(pos.membersid),
                    }
                    if pos.entrytime:
                        pos_attrs2["entrytime"] = _ms_to_lenex(pos.entrytime)
                    ET.SubElement(positions_xml2, "RELAYPOSITION", pos_attrs2)

    # Also handle clubs that have relay data but no individual registrations
    for club_id, club_relays in relays_by_club.items():
        if club_id in clubs_map:
            continue  # Already handled above
        # Query the club
        club = db.query(TeamClub).get(club_id)
        if not club:
            continue
        club_xml = ET.SubElement(clubs_xml, "CLUB", {
            "name": club.name or "",
            "code": club.code or "",
            "nation": club.nation or "CAN",
            "clubid": str(club.clubsid),
        })
        # Add relay members as ATHLETE elements (so athleteid refs resolve)
        athletes_xml = ET.SubElement(club_xml, "ATHLETES")
        extra_members = missing_members_by_club.get(club_id, [])
        for m in extra_members:
            ET.SubElement(athletes_xml, "ATHLETE", {
                "athleteid": str(m.membersid),
                "firstname": m.firstname or "",
                "lastname": m.lastname or "",
                "gender": gender_to_str(m.gender),
                "birthdate": str(m.birthdate.date()) if m.birthdate else "",
                "license": m.license or "",
            })
        relays_xml = ET.SubElement(club_xml, "RELAYS")
        for relay in club_relays:
            positions = positions_by_relay.get(relay.relaysid, [])
            # Build team name
            team_name = custom_names.get(relay.relaysid)
            if not team_name and positions:
                names = []
                for p in positions:
                    m = db.query(Member).get(p.membersid)
                    if m:
                        names.append(m.lastname or "")
                team_name = "/".join(names) if names else None

            relay_attrs: dict[str, str] = {
                "number": str(relay.teamnumb or 1),
            }
            if team_name:
                relay_attrs["name"] = team_name
            if relay.gender:
                relay_attrs["gender"] = gender_to_str(relay.gender)
            if relay.minage is not None:
                relay_attrs["agemin"] = str(relay.minage)
            if relay.maxage is not None:
                relay_attrs["agemax"] = str(relay.maxage)
            relay_xml = ET.SubElement(relays_xml, "RELAY", relay_attrs)
            if positions:
                positions_xml = ET.SubElement(relay_xml, "RELAYPOSITIONS")
                for pos in positions:
                    pos_attrs: dict[str, str] = {
                        "number": str(pos.numb),
                        "athleteid": str(pos.membersid),
                    }
                    if pos.entrytime:
                        pos_attrs["entrytime"] = _ms_to_lenex(pos.entrytime)
                    ET.SubElement(positions_xml, "RELAYPOSITION", pos_attrs)
            # ENTRIES — always include eventid
            relay_entries_xml = ET.SubElement(relay_xml, "ENTRIES")
            relay_entry_attrs: dict[str, str] = {
                "entrycourse": meet_struct.course or "LCM",
            }
            if relay.entrytime:
                relay_entry_attrs["entrytime"] = _ms_to_lenex(relay.entrytime)
            for ses in meet_struct.sessions:
                for m_ev in ses.events:
                    if m_ev.swimstyleid == relay.stylesid:
                        relay_entry_attrs["eventid"] = str(m_ev.eventid)
                        break
                if "eventid" in relay_entry_attrs:
                    break
            entry_xml = ET.SubElement(relay_entries_xml, "ENTRY", relay_entry_attrs)
            # Also put RELAYPOSITIONS inside ENTRY (meet-app importer expects them here)
            if positions:
                positions_xml2 = ET.SubElement(entry_xml, "RELAYPOSITIONS")
                for pos in positions:
                    pos_attrs2: dict[str, str] = {
                        "number": str(pos.numb),
                        "athleteid": str(pos.membersid),
                    }
                    if pos.entrytime:
                        pos_attrs2["entrytime"] = _ms_to_lenex(pos.entrytime)
                    ET.SubElement(positions_xml2, "RELAYPOSITION", pos_attrs2)

    xml_bytes = ET.tostring(root, encoding="unicode", xml_declaration=True).encode("utf-8")

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("meet.lef", xml_bytes)
        # Embed Gemini API keys as hidden dotfile (key transport to meet-app)
        gemini_free = db.query(BsGlobal).get("GEMINI_KEY_FREE")
        gemini_paid = db.query(BsGlobal).get("GEMINI_KEY_PAID")
        live_secret = db.query(BsGlobal).get("LIVE_PUSH_SECRET")
        live_url = os.environ.get("APP_BASE_URL", "http://localhost:8001")
        has_keys = (
            (gemini_free and gemini_free.data)
            or (gemini_paid and gemini_paid.data)
            or (live_secret and live_secret.data)
        )
        if has_keys:
            import json as _json
            keys = {}
            if gemini_free and gemini_free.data:
                keys["gemini_free"] = gemini_free.data
            if gemini_paid and gemini_paid.data:
                keys["gemini_paid"] = gemini_paid.data
            if live_secret and live_secret.data:
                keys["live_push_secret"] = live_secret.data
                keys["live_url"] = live_url
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
            }
            if ev.swimstyleid:
                style_attrs["swimstyleid"] = str(ev.swimstyleid)
            else:
                # Style-less events (pauses/breaks) are flagged code="ID0" so Splash
                # recognizes the SWIMSTYLE as an intentional placeholder, not a missing style.
                style_attrs["code"] = "ID0"
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