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

"""Fuzzy lookup of existing athletes, used to stop a coach from creating a
second copy of someone who is already registered (often in another club).

An athlete counts as "already there" when, in any club:
- the NRAN (``members.license``) is the same, or
- the name is the same / near-identical (accents, case, typos, first/last
  swapped) and the birth dates agree or one side has none, or
- the name is exactly the same even though the birth dates differ (a typo in
  one of the two dates is more likely than two people sharing a full name).
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime
from difflib import SequenceMatcher

from sqlalchemy.orm import Session, joinedload

from .models_team import Member

NAME_FUZZY_MIN = 0.88


def _fold(s: str | None) -> str:
    """Lower-case, accent-free, punctuation-free, single-spaced."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def _license_key(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _as_date(v) -> date | None:
    if isinstance(v, datetime):
        return v.date()
    return v if isinstance(v, date) else None


def name_similarity(first_a: str, last_a: str, first_b: str, last_b: str) -> float:
    """0..1, best of "first last" and "last first" so a swap still matches."""
    fa, la, fb, lb = _fold(first_a), _fold(last_a), _fold(first_b), _fold(last_b)
    straight = SequenceMatcher(None, f"{fa} {la}", f"{fb} {lb}").ratio()
    swapped = SequenceMatcher(None, f"{fa} {la}", f"{lb} {fb}").ratio()
    return max(straight, swapped)


def find_similar_members(
    db: Session,
    first_name: str,
    last_name: str,
    birthdate: date | None,
    license: str | None,
) -> list[dict]:
    """Existing members that look like the athlete being created, best first."""
    lic = _license_key(license)
    matches: list[tuple[int, float, dict]] = []
    for m in db.query(Member).options(joinedload(Member.club)).all():
        reason = None
        rank = 0
        sim = name_similarity(first_name, last_name, m.firstname, m.lastname)
        m_bd = _as_date(m.birthdate)
        if lic and _license_key(m.license) == lic:
            reason, rank = "license", 3
        elif sim >= NAME_FUZZY_MIN and birthdate and m_bd and birthdate == m_bd:
            reason, rank = "name_birthdate", 3
        elif sim >= NAME_FUZZY_MIN and (not birthdate or not m_bd):
            reason, rank = "name", 2
        elif sim >= 0.999:
            reason, rank = "name_only", 1
        if reason:
            matches.append((rank, sim, {
                "id": m.membersid,
                "first_name": m.firstname,
                "last_name": m.lastname,
                "birthdate": str(m_bd) if m_bd else None,
                "license": m.license or "",
                "club_id": m.clubsid,
                "club": m.club.name if m.club else "",
                "reason": reason,
            }))
    matches.sort(key=lambda t: (-t[0], -t[1]))
    return [m for _, _, m in matches[:5]]
