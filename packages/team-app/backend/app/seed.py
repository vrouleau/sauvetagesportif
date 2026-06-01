"""Parse a Lenex entries .lxf and seed clubs + athletes + entries into the DB."""
from __future__ import annotations

import zipfile
from datetime import date
from io import BytesIO
from xml.etree import ElementTree as ET  # noqa: F401 — kept for type hints
from defusedxml.ElementTree import fromstring as _ET_fromstring

from sqlalchemy.orm import Session
from .models import gender_from_str, SwimEvent, AgeGroup, SwimResult, SwimStyle
from .models_team import TeamClub, Member


def _lenex_to_ms(time_str: str) -> int | None:
    """Convert LENEX time string (HH:MM:SS.cc or MM:SS.cc or SS.cc) to milliseconds."""
    if not time_str or time_str in ("NT", "0", ""):
        return None
    try:
        parts = time_str.split(":")
        if len(parts) == 3:
            h, m, s_cc = int(parts[0]), int(parts[1]), parts[2]
        elif len(parts) == 2:
            h, m, s_cc = 0, int(parts[0]), parts[1]
        else:
            h, m, s_cc = 0, 0, parts[0]
        s_parts = s_cc.split(".")
        s = int(s_parts[0])
        cc = int(s_parts[1]) if len(s_parts) > 1 else 0
        return h * 3600000 + m * 60000 + s * 1000 + cc * 10
    except (ValueError, IndexError):
        return None


def _age_code_from_bounds(agemin: int, agemax: int) -> str:
    """Derive age_code from agegroup bounds (matches _age_group_code in api.py)."""
    if agemin <= 10 and agemax == 10:
        return "10-"
    if agemin == 11 and agemax == 12:
        return "11-12"
    if agemin == 13 and agemax == 14:
        return "13-14"
    if agemin == 15 and agemax == 18:
        return "15-18"
    if agemin == 19 and (agemax == -1 or agemax >= 99):
        return "Open"
    return "Open"


def parse_lxf(file_bytes: bytes) -> list[dict]:
    """Parse .lxf zip -> list of {club, athletes} dicts.

    Each athlete dict includes an 'entries' list of
    {event_id, agegroup_id, entrytime, entrycourse} dicts.
    """
    with zipfile.ZipFile(BytesIO(file_bytes)) as z:
        lef_name = [n for n in z.namelist() if n.endswith(".lef")][0]
        xml_bytes = z.read(lef_name)

    root = _ET_fromstring(xml_bytes)
    clubs_data = []

    for meet in root.iter("MEET"):
        for clubs_el in meet.iter("CLUBS"):
            for club_el in clubs_el.findall("CLUB"):
                email = ""
                contact_el = club_el.find("CONTACT")
                if contact_el is not None:
                    email = contact_el.get("email", "") or contact_el.get("e-mail", "")
                club_info = {
                    "name": club_el.get("name", ""),
                    "code": club_el.get("code", ""),
                    "nation": club_el.get("nation", ""),
                    "email": email,
                    "athletes": [],
                }
                for ath_el in club_el.iter("ATHLETE"):
                    bd_str = ath_el.get("birthdate", "")
                    birthdate = None
                    if bd_str:
                        try:
                            birthdate = date.fromisoformat(bd_str)
                        except ValueError:
                            pass

                    entries = []
                    for entry_el in ath_el.iter("ENTRY"):
                        event_id_str = entry_el.get("eventid")
                        if not event_id_str:
                            continue
                        entries.append({
                            "event_id": int(event_id_str),
                            "agegroup_id": int(entry_el.get("agegroupid")) if entry_el.get("agegroupid") else None,
                            "entrytime": _lenex_to_ms(entry_el.get("entrytime", "")),
                            "entrycourse": entry_el.get("entrycourse", ""),
                        })

                    club_info["athletes"].append({
                        "first_name": ath_el.get("firstname", "").strip().rstrip(","),
                        "last_name": ath_el.get("lastname", "").strip().rstrip(","),
                        "gender": ath_el.get("gender", "M"),
                        "birthdate": birthdate,
                        "license": ath_el.get("license", ""),
                        "exception": ath_el.get("exception", "") or None,
                        "entries": entries,
                    })
                clubs_data.append(club_info)
    return clubs_data


def seed_from_lxf(db: Session, file_bytes: bytes) -> dict:
    """Parse .lxf and upsert clubs, athletes, and event entries. Returns counts."""
    clubs_data = parse_lxf(file_bytes)
    clubs_added = 0
    athletes_added = 0
    entries_added = 0
    entries_updated = 0

    # Cache event masters flag and relay count to avoid per-entry queries
    _event_cache: dict[int, SwimEvent] = {}

    def _get_event(event_id: int) -> SwimEvent | None:
        if event_id not in _event_cache:
            _event_cache[event_id] = db.query(SwimEvent).get(event_id)
        return _event_cache[event_id]

    for cd in clubs_data:
        if cd.get("code"):
            club = db.query(TeamClub).filter(TeamClub.code == cd["code"]).first()
        else:
            club = db.query(TeamClub).filter(TeamClub.name == cd["name"]).first()
        if not club:
            import secrets, string
            pin = ''.join(secrets.choice(string.digits) for _ in range(6))
            club = TeamClub(name=cd["name"], code=cd["code"], nation=cd["nation"],
                            pin=pin, email=cd.get("email") or None)
            db.add(club)
            db.flush()
            clubs_added += 1
        else:
            if cd.get("code"):
                club.code = cd["code"]
            if cd.get("nation"):
                club.nation = cd["nation"]
            if not club.email and cd.get("email"):
                club.email = cd["email"]

        for ad in cd["athletes"]:
            existing = db.query(Member).filter(
                Member.firstname == ad["first_name"],
                Member.lastname == ad["last_name"],
                Member.clubsid == club.clubsid,
            ).first()
            if not existing:
                member = Member(
                    firstname=ad["first_name"],
                    lastname=ad["last_name"],
                    gender=gender_from_str(ad["gender"]),
                    birthdate=ad["birthdate"],
                    license=ad["license"],
                    handicapex=ad.get("exception"),
                    clubsid=club.clubsid,
                )
                db.add(member)
                db.flush()
                athletes_added += 1
            else:
                member = existing

            for entry in ad.get("entries", []):
                event_id = entry["event_id"]
                event = _get_event(event_id)
                if not event:
                    continue

                # Skip relays — relay entries need separate handling
                if event.swimstyle and event.swimstyle.relaycount and event.swimstyle.relaycount > 1:
                    continue

                # Determine age_code
                if event.masters == 'T':
                    age_code = "Masters"
                elif entry["agegroup_id"]:
                    ag = db.query(AgeGroup).get(entry["agegroup_id"])
                    age_code = _age_code_from_bounds(ag.agemin or 0, ag.agemax or 99) if ag else "Open"
                else:
                    age_code = "Open"

                existing_result = db.query(SwimResult).filter(
                    SwimResult.athleteid == member.membersid,
                    SwimResult.swimeventid == event_id,
                    SwimResult.age_code == age_code,
                ).first()

                if existing_result:
                    existing_result.entrytime = entry["entrytime"]
                    entries_updated += 1
                else:
                    db.add(SwimResult(
                        athleteid=member.membersid,
                        swimeventid=event_id,
                        agegroupid=entry["agegroup_id"],
                        age_code=age_code,
                        entrytime=entry["entrytime"],
                    ))
                    entries_added += 1

    db.commit()
    # Reset sequences to avoid conflicts when creating new entries later
    from sqlalchemy import text
    db.execute(text("SELECT setval('clubs_clubsid_seq', GREATEST(COALESCE((SELECT MAX(clubsid) FROM clubs), 0), 1))"))
    db.execute(text("SELECT setval('members_membersid_seq', GREATEST(COALESCE((SELECT MAX(membersid) FROM members), 0), 1))"))
    db.commit()
    return {
        "clubs_added": clubs_added,
        "athletes_added": athletes_added,
        "entries_added": entries_added,
        "entries_updated": entries_updated,
    }
