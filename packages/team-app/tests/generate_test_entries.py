#!/usr/bin/env python3
"""Generate a deterministic Lenex entries .lxf with synthetic clubs + athletes.

The output exercises every age category (10-, 11-12, 13-14, 15-18, Open) for
both genders. Run from repo root:

    python tests/generate_test_entries.py --out tests/fixtures/test_entries.lxf

The seed is fixed so the output is reproducible.
"""
from __future__ import annotations

import argparse
import random
import zipfile
from datetime import date
from pathlib import Path
from xml.etree import ElementTree as ET

DEFAULT_SEED = 20260509
AGE_DATE_YEAR = 2026  # AGEDATE is Dec 31 of this year

CLUBS = [
    {"name": "Club Aurora",       "code": "AUR", "nation": "CAN"},
    {"name": "Béluga Sauvetage",  "code": "BLG", "nation": "CAN"},
    {"name": "Cedar Creek LSC",   "code": "CCL", "nation": "CAN"},
    {"name": "Dauphins de l'Est", "code": "DDE", "nation": "CAN"},
    {"name": "Elite Rescue",      "code": "ELR", "nation": "CAN"},
]

FIRST_F = ["Alice", "Béatrice", "Chloé", "Diane", "Emma", "Frédérique", "Gabrielle",
           "Héloïse", "Inès", "Juliette", "Karine", "Léa", "Maude", "Noémie",
           "Océane", "Pénélope", "Rosalie", "Sophie", "Tania", "Valérie"]
FIRST_M = ["Alexandre", "Benoît", "Christophe", "David", "Émile", "François",
           "Gabriel", "Hugo", "Isaac", "Jérôme", "Kevin", "Liam", "Mathis",
           "Olivier", "Philippe", "Raphaël", "Samuel", "Thomas", "Vincent",
           "William"]
LAST = ["Tremblay", "Gagnon", "Roy", "Côté", "Bouchard", "Gauthier", "Morin",
        "Lavoie", "Fortin", "Gagné", "Ouellet", "Pelletier", "Bélanger",
        "Lévesque", "Bergeron", "Leblanc", "Paquette", "Girard", "Simard",
        "Boucher", "Caron", "Beaulieu", "Cloutier", "Dubois", "Poirier"]

# Age category -> birth year that yields that category given AGEDATE Dec 31, 2026.
# We use a deterministic year per category so tests can predict outcomes.
CATEGORY_YEARS = {
    "10-":   2018,  # age 8
    "11-12": 2014,  # age 12
    "13-14": 2012,  # age 14
    "15-18": 2010,  # age 16
    "Open":  2002,  # age 24
}


def _make_athlete(rng: random.Random, gender: str, year: int, idx: int,
                  used: set[tuple[str, str]]) -> dict:
    """Pick a (first, last) pair not yet used in `used` within the current club."""
    first_pool = FIRST_F if gender == "F" else FIRST_M
    for offset in range(len(first_pool) * len(LAST)):
        first = first_pool[(idx + offset) % len(first_pool)]
        last = LAST[(idx + offset * 3) % len(LAST)]
        if (first, last) not in used:
            used.add((first, last))
            break
    else:
        raise RuntimeError("name pool exhausted")
    license_ = f"NRA{idx:05d}"
    month = rng.randint(1, 12)
    day = rng.randint(1, 28)
    birthdate = date(year, month, day)
    return {
        "first_name": first,
        "last_name": last,
        "gender": gender,
        "birthdate": birthdate,
        "license": license_,
    }


def build_entries(seed: int = DEFAULT_SEED, athletes_per_category: int = 2):
    """Build clubs+athletes covering all categories x both genders.

    Each (club, category, gender) gets `athletes_per_category` athletes.
    With 5 clubs x 5 categories x 2 genders x N athletes => 50*N total.
    """
    rng = random.Random(seed)
    idx = 0
    clubs = []
    for c in CLUBS:
        athletes = []
        used: set[tuple[str, str]] = set()
        for cat, year in CATEGORY_YEARS.items():
            for gender in ("M", "F"):
                for _ in range(athletes_per_category):
                    idx += 1
                    athletes.append(_make_athlete(rng, gender, year, idx, used))
        clubs.append({**c, "athletes": athletes})
    return clubs


def write_lxf(clubs: list[dict], out_path: Path) -> None:
    """Write a Lenex 3.0 .lxf zip with the given clubs."""
    root = ET.Element("LENEX", version="3.0")
    meets = ET.SubElement(root, "MEETS")
    meet = ET.SubElement(meets, "MEET", {
        "name": "Test Entries Meet",
        "city": "Test City",
        "course": "SCM",
    })
    ET.SubElement(meet, "AGEDATE", value=f"{AGE_DATE_YEAR}-12-31", type="DATE")

    clubs_xml = ET.SubElement(meet, "CLUBS")
    for c in clubs:
        club_xml = ET.SubElement(clubs_xml, "CLUB", {
            "name": c["name"], "code": c["code"], "nation": c["nation"],
        })
        athletes_xml = ET.SubElement(club_xml, "ATHLETES")
        for a in c["athletes"]:
            ET.SubElement(athletes_xml, "ATHLETE", {
                "firstname": a["first_name"],
                "lastname": a["last_name"],
                "gender": a["gender"],
                "birthdate": a["birthdate"].isoformat(),
                "license": a["license"],
            })

    xml = ET.tostring(root, encoding="unicode", xml_declaration=True).encode("utf-8")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("entries.lef", xml)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--seed", type=int, default=DEFAULT_SEED)
    p.add_argument("--per-category", type=int, default=2,
                   help="Athletes per (club, category, gender) cell")
    args = p.parse_args()

    clubs = build_entries(seed=args.seed, athletes_per_category=args.per_category)
    write_lxf(clubs, args.out)
    total = sum(len(c["athletes"]) for c in clubs)
    print(f"Wrote {args.out} — {len(clubs)} clubs, {total} athletes")


if __name__ == "__main__":
    main()
