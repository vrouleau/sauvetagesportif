"""Parse a Lenex entries .lxf and seed clubs + athletes into the DB."""
from __future__ import annotations

import zipfile
from datetime import date
from io import BytesIO
from xml.etree import ElementTree as ET  # noqa: F401 — kept for type hints
from defusedxml.ElementTree import fromstring as _ET_fromstring

from sqlalchemy.orm import Session
from .models import Club, Athlete, gender_from_str


def parse_lxf(file_bytes: bytes) -> list[dict]:
    """Parse .lxf zip -> list of {club, athletes} dicts."""
    with zipfile.ZipFile(BytesIO(file_bytes)) as z:
        lef_name = [n for n in z.namelist() if n.endswith(".lef")][0]
        xml_bytes = z.read(lef_name)

    root = _ET_fromstring(xml_bytes)
    clubs_data = []

    for meet in root.iter("MEET"):
        for clubs_el in meet.iter("CLUBS"):
            for club_el in clubs_el.findall("CLUB"):
                # Extract email from CONTACT element if present
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
                    club_info["athletes"].append({
                        "first_name": ath_el.get("firstname", "").strip().rstrip(","),
                        "last_name": ath_el.get("lastname", "").strip().rstrip(","),
                        "gender": ath_el.get("gender", "M"),
                        "birthdate": birthdate,
                        "license": ath_el.get("license", ""),
                        "exception": ath_el.get("exception", "") or None,
                    })
                clubs_data.append(club_info)
    return clubs_data


def seed_from_lxf(db: Session, file_bytes: bytes) -> dict:
    """Parse .lxf and upsert clubs + athletes. Returns counts."""
    clubs_data = parse_lxf(file_bytes)
    clubs_added = 0
    athletes_added = 0

    for cd in clubs_data:
        if cd.get("code"):
            club = db.query(Club).filter(Club.code == cd["code"]).first()
        else:
            club = db.query(Club).filter(Club.name == cd["name"]).first()
        if not club:
            import secrets, string
            pin = ''.join(secrets.choice(string.digits) for _ in range(6))
            club = Club(name=cd["name"], code=cd["code"], nation=cd["nation"], pin=pin,
                        email=cd.get("email") or None)
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
            existing = db.query(Athlete).filter(
                Athlete.firstname == ad["first_name"],
                Athlete.lastname == ad["last_name"],
                Athlete.clubid == club.clubid,
            ).first()
            if not existing:
                ath = Athlete(
                    firstname=ad["first_name"],
                    lastname=ad["last_name"],
                    gender=gender_from_str(ad["gender"]),
                    birthdate=ad["birthdate"],
                    license=ad["license"],
                    exception=ad.get("exception"),
                    clubid=club.clubid,
                )
                db.add(ath)
                athletes_added += 1

    db.commit()
    return {"clubs_added": clubs_added, "athletes_added": athletes_added}
