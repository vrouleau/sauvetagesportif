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

"""Tests: HANDICAP/Para exception codes propagate through all three LXF import paths.

Covers:
- seed_from_lxf      (POST /api/upload/entries)          — entries upload path
- import_lxf_as_meet  (POST /api/import-results-lxf)     — organizer results path
- import_historical_meet (POST /api/admin/import-historical) — admin historical path

Five cases per path:
1. New athlete with <HANDICAP exception="S12"/> → handicapex = "S12"
2. Existing athlete (no handicapex) → backfilled from <HANDICAP>
3. Existing athlete (has handicapex "S14") → NOT overwritten by import with "S9"
4. Athlete without <HANDICAP> element → handicapex stays None
5. Legacy: exception= as direct ATHLETE attribute → handicapex set
"""
from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base
from app.models_team import TeamClub, Member
from app.seed import seed_from_lxf
from app.lxf_to_team import import_lxf_as_meet
from app.historical_import import import_historical_meet


# ── DB factory ────────────────────────────────────────────────────────────────

def _make_db():
    """Fresh in-memory SQLite session with the full schema."""
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


# ── LXF builder ───────────────────────────────────────────────────────────────

def _lxf(athletes: list[dict], *, club_code: str = "TST",
         meet_name: str = "TestMeet") -> bytes:
    """Build a minimal LXF ZIP suitable for all three import paths.

    Athlete dict keys:
      first, last     — required
      gender          — "M" or "F" (default "M")
      license         — license string (default "")
      exception       — value for <HANDICAP exception="..."> child element
      exception_attr  — legacy: exception= as direct ATHLETE attribute
    """
    lenex = ET.Element("LENEX", version="3.0")
    meets_el = ET.SubElement(lenex, "MEETS")
    meet_el = ET.SubElement(meets_el, "MEET", name=meet_name, course="LCM",
                             startdate="2024-01-15", city="TestCity")
    clubs_el = ET.SubElement(meet_el, "CLUBS")
    club_el = ET.SubElement(clubs_el, "CLUB", name="Test Club", code=club_code, nation="CAN")
    athletes_el = ET.SubElement(club_el, "ATHLETES")
    for ath in athletes:
        kwargs: dict = dict(
            firstname=ath["first"],
            lastname=ath["last"],
            gender=ath.get("gender", "M"),
            license=ath.get("license", ""),
        )
        if ath.get("exception_attr"):
            kwargs["exception"] = ath["exception_attr"]
        ath_el = ET.SubElement(athletes_el, "ATHLETE", **kwargs)
        if ath.get("exception"):
            ET.SubElement(ath_el, "HANDICAP", exception=ath["exception"])

    xml_bytes = ET.tostring(lenex, encoding="utf-8", xml_declaration=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("meet.lef", xml_bytes)
    return buf.getvalue()


def _find(db, first: str, last: str) -> Member | None:
    return db.query(Member).filter(
        Member.firstname == first, Member.lastname == last
    ).first()


def _seed_club(db, code: str = "TST") -> TeamClub:
    """Pre-create a club so import paths can match it by code."""
    club = TeamClub(name="Test Club", code=code, nation="CAN", pin="000000")
    db.add(club)
    db.flush()
    return club


# =============================================================================
# seed_from_lxf  (POST /api/upload/entries)
# =============================================================================

class TestSeedHandicap:
    """HANDICAP handling in the entries upload path (seed.py → seed_from_lxf)."""

    def test_new_athlete_gets_handicapex(self):
        """Fresh athlete with <HANDICAP exception="S12"> → handicapex stored."""
        db = _make_db()
        seed_from_lxf(db, _lxf([{"first": "Alice", "last": "Roy", "exception": "S12"}]))
        m = _find(db, "Alice", "Roy")
        assert m is not None
        assert m.handicapex == "S12"

    def test_existing_athlete_backfilled(self):
        """Member with no handicapex gets it set when HANDICAP appears in new import."""
        db = _make_db()
        club = _seed_club(db)
        db.add(Member(firstname="Bob", lastname="Gagnon", gender=1, clubsid=club.clubsid))
        db.commit()

        seed_from_lxf(db, _lxf([{"first": "Bob", "last": "Gagnon", "exception": "S9"}]))
        assert _find(db, "Bob", "Gagnon").handicapex == "S9"

    def test_existing_handicapex_not_overwritten(self):
        """Existing handicapex is NOT replaced by a subsequent import with a different code."""
        db = _make_db()
        club = _seed_club(db)
        db.add(Member(firstname="Carol", lastname="Tremblay", gender=2,
                      clubsid=club.clubsid, handicapex="S14"))
        db.commit()

        seed_from_lxf(db, _lxf([{"first": "Carol", "last": "Tremblay", "exception": "S9"}]))
        assert _find(db, "Carol", "Tremblay").handicapex == "S14"

    def test_no_handicap_element_leaves_null(self):
        """Athlete with no <HANDICAP> element → handicapex stays None."""
        db = _make_db()
        seed_from_lxf(db, _lxf([{"first": "David", "last": "Côté"}]))
        m = _find(db, "David", "Côté")
        assert m is not None
        assert m.handicapex is None

    def test_legacy_exception_attribute_fallback(self):
        """exception= directly on <ATHLETE> (old format) → handicapex stored."""
        db = _make_db()
        seed_from_lxf(db, _lxf([{"first": "Eve", "last": "Fortin", "exception_attr": "X"}]))
        assert _find(db, "Eve", "Fortin").handicapex == "X"


# =============================================================================
# import_lxf_as_meet  (POST /api/import-results-lxf)
# =============================================================================

class TestLxfToTeamHandicap:
    """HANDICAP handling in the organizer results import path (lxf_to_team.py)."""

    def test_new_athlete_gets_handicapex(self):
        db = _make_db()
        import_lxf_as_meet(db, _lxf([
            {"first": "Alice", "last": "Roy", "license": "L201", "exception": "S12"}
        ]))
        assert _find(db, "Alice", "Roy").handicapex == "S12"

    def test_existing_athlete_backfilled(self):
        """Member found by license with no handicapex gets it backfilled."""
        db = _make_db()
        club = _seed_club(db)
        db.add(Member(firstname="Bob", lastname="Gagnon", gender=1,
                      clubsid=club.clubsid, license="L202"))
        db.commit()

        import_lxf_as_meet(db, _lxf([
            {"first": "Bob", "last": "Gagnon", "license": "L202", "exception": "S9"}
        ]))
        assert _find(db, "Bob", "Gagnon").handicapex == "S9"

    def test_existing_handicapex_not_overwritten(self):
        db = _make_db()
        club = _seed_club(db)
        db.add(Member(firstname="Carol", lastname="Tremblay", gender=2,
                      clubsid=club.clubsid, license="L203", handicapex="S14"))
        db.commit()

        import_lxf_as_meet(db, _lxf([
            {"first": "Carol", "last": "Tremblay", "license": "L203", "exception": "S9"}
        ]))
        assert _find(db, "Carol", "Tremblay").handicapex == "S14"

    def test_no_handicap_element_leaves_null(self):
        db = _make_db()
        import_lxf_as_meet(db, _lxf([{"first": "David", "last": "Côté", "license": "L204"}]))
        m = _find(db, "David", "Côté")
        assert m is not None
        assert m.handicapex is None

    def test_legacy_exception_attribute_fallback(self):
        db = _make_db()
        import_lxf_as_meet(db, _lxf([
            {"first": "Eve", "last": "Fortin", "license": "L205", "exception_attr": "X"}
        ]))
        assert _find(db, "Eve", "Fortin").handicapex == "X"


# =============================================================================
# import_historical_meet  (POST /api/admin/import-historical)
# =============================================================================

class TestHistoricalImportHandicap:
    """HANDICAP handling in the admin historical import path (historical_import.py)."""

    def test_new_athlete_gets_handicapex(self):
        db = _make_db()
        import_historical_meet(db, _lxf([
            {"first": "Alice", "last": "Roy", "license": "L301", "exception": "S12"}
        ], meet_name="HistA"))
        assert _find(db, "Alice", "Roy").handicapex == "S12"

    def test_existing_athlete_backfilled(self):
        """Member found by license with no handicapex gets it backfilled."""
        db = _make_db()
        club = _seed_club(db)
        db.add(Member(firstname="Bob", lastname="Gagnon", gender=1,
                      clubsid=club.clubsid, license="L302"))
        db.commit()

        import_historical_meet(db, _lxf([
            {"first": "Bob", "last": "Gagnon", "license": "L302", "exception": "S9"}
        ], meet_name="HistB"))
        assert _find(db, "Bob", "Gagnon").handicapex == "S9"

    def test_existing_handicapex_not_overwritten(self):
        db = _make_db()
        club = _seed_club(db)
        db.add(Member(firstname="Carol", lastname="Tremblay", gender=2,
                      clubsid=club.clubsid, license="L303", handicapex="S14"))
        db.commit()

        import_historical_meet(db, _lxf([
            {"first": "Carol", "last": "Tremblay", "license": "L303", "exception": "S9"}
        ], meet_name="HistC"))
        assert _find(db, "Carol", "Tremblay").handicapex == "S14"

    def test_no_handicap_element_leaves_null(self):
        db = _make_db()
        import_historical_meet(db, _lxf([
            {"first": "David", "last": "Côté", "license": "L304"}
        ], meet_name="HistD"))
        m = _find(db, "David", "Côté")
        assert m is not None
        assert m.handicapex is None

    def test_legacy_exception_attribute_fallback(self):
        db = _make_db()
        import_historical_meet(db, _lxf([
            {"first": "Eve", "last": "Fortin", "license": "L305", "exception_attr": "X"}
        ], meet_name="HistE"))
        assert _find(db, "Eve", "Fortin").handicapex == "X"