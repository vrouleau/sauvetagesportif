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

"""Unit tests for relay_helpers — eligible athlete computation.

Uses an in-memory SQLite database — no Docker required.
Validates: Requirements 4.1, 4.2, 4.3, 4.4
"""
from __future__ import annotations

import sys
from datetime import date, datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, BsGlobal, GENDER_M, GENDER_F, GENDER_MIXED
from app.models_team import TeamClub, Member
from app.relay_helpers import compute_age, get_eligible_athletes


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def db_session():
    """Create an in-memory SQLite database with all tables and return a session."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


@pytest.fixture()
def club(db_session) -> TeamClub:
    """Insert a club for testing."""
    club = TeamClub(name="Test Club", code="TST", nation="CAN", pin="111111")
    db_session.add(club)
    db_session.commit()
    return club


@pytest.fixture()
def age_base_date_config(db_session):
    """Set the age base date to 2026-12-31."""
    db_session.add(BsGlobal(name="age_base_date", data="2026-12-31"))
    db_session.commit()


@pytest.fixture()
def athletes(db_session, club, age_base_date_config) -> list[Member]:
    """Create a variety of athletes for eligibility testing.

    Age base date: 2026-12-31
    - Alice: born 2016 → age 10
    - Bob: born 2014 → age 12
    - Charlie: born 2012 → age 14
    - Diana: born 2008 → age 18
    - Eve: born 2000 → age 26 (Open)
    """
    members = [
        Member(firstname="Alice", lastname="Aubert", gender=GENDER_F, birthdate=datetime(2016, 3, 15), clubsid=club.clubsid),
        Member(firstname="Bob", lastname="Bernier", gender=GENDER_M, birthdate=datetime(2014, 7, 20), clubsid=club.clubsid),
        Member(firstname="Charlie", lastname="Caron", gender=GENDER_M, birthdate=datetime(2012, 1, 5), clubsid=club.clubsid),
        Member(firstname="Diana", lastname="Dupont", gender=GENDER_F, birthdate=datetime(2008, 11, 30), clubsid=club.clubsid),
        Member(firstname="Eve", lastname="Emond", gender=GENDER_F, birthdate=datetime(2000, 6, 1), clubsid=club.clubsid),
    ]
    db_session.add_all(members)
    db_session.commit()
    return members


# ---------------------------------------------------------------------------
# compute_age tests
# ---------------------------------------------------------------------------

class TestComputeAge:
    def test_same_year(self):
        assert compute_age(date(2010, 6, 15), date(2010, 12, 31)) == 0

    def test_one_year_apart(self):
        assert compute_age(date(2010, 6, 15), date(2011, 12, 31)) == 1

    def test_ten_years(self):
        assert compute_age(date(2016, 3, 15), date(2026, 12, 31)) == 10

    def test_year_difference_only(self):
        # Even if birthday hasn't occurred yet relative to age_base_date,
        # this project uses simple year subtraction
        assert compute_age(date(2010, 12, 31), date(2020, 1, 1)) == 10


# ---------------------------------------------------------------------------
# get_eligible_athletes tests
# ---------------------------------------------------------------------------

class TestGetEligibleAthletes:
    """Test eligible athlete filtering by age and gender."""

    def test_age_filter_10_and_under(self, db_session, club, athletes):
        """Requirement 4.2: age within [0, 10] includes only age-10 athlete."""
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_MIXED, 0, 10)
        names = [a["name"] for a in result]
        assert names == ["Aubert, Alice"]

    def test_age_filter_11_12(self, db_session, club, athletes):
        """Requirement 4.2: age within [11, 12] includes only Bob (age 12)."""
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_MIXED, 11, 12)
        names = [a["name"] for a in result]
        assert names == ["Bernier, Bob"]

    def test_age_filter_13_14(self, db_session, club, athletes):
        """Requirement 4.2: age within [13, 14] includes only Charlie (age 14)."""
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_MIXED, 13, 14)
        names = [a["name"] for a in result]
        assert names == ["Caron, Charlie"]

    def test_age_filter_open_ended(self, db_session, club, athletes):
        """Requirement 4.2: agemax NULL means open-ended, includes all at or above agemin."""
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_MIXED, 19, None)
        names = [a["name"] for a in result]
        # Only Eve (age 26) is >= 19
        assert names == ["Emond, Eve"]

    def test_age_filter_open_ended_low_min(self, db_session, club, athletes):
        """Requirement 4.2: agemax NULL with low agemin includes everyone."""
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_MIXED, 0, None)
        assert len(result) == 5

    def test_gender_filter_male(self, db_session, club, athletes):
        """Requirement 4.3: male event includes only male athletes."""
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_M, 0, None)
        names = [a["name"] for a in result]
        assert names == ["Bernier, Bob", "Caron, Charlie"]

    def test_gender_filter_female(self, db_session, club, athletes):
        """Requirement 4.3: female event includes only female athletes."""
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_F, 0, None)
        names = [a["name"] for a in result]
        assert names == ["Aubert, Alice", "Dupont, Diana", "Emond, Eve"]

    def test_gender_filter_mixed(self, db_session, club, athletes):
        """Requirement 4.4: mixed event includes all genders."""
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_MIXED, 0, None)
        assert len(result) == 5

    def test_combined_age_and_gender(self, db_session, club, athletes):
        """Requirements 4.2, 4.3: filter by both age range and gender."""
        # Female athletes aged 15-18: only Diana (age 18, female)
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_F, 15, 18)
        names = [a["name"] for a in result]
        assert names == ["Dupont, Diana"]

    def test_sorted_by_lastname_firstname(self, db_session, club, athletes):
        """Requirement 4.1: results sorted alphabetically by last name then first name."""
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_MIXED, 0, None)
        names = [a["name"] for a in result]
        assert names == sorted(names)

    def test_no_eligible_athletes(self, db_session, club, athletes):
        """No athletes in range returns empty list."""
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_M, 50, 60)
        assert result == []

    def test_athlete_without_birthdate_excluded(self, db_session, club, age_base_date_config):
        """Athletes without a birthdate are excluded from eligibility."""
        member = Member(firstname="No", lastname="Birth", gender=GENDER_M, birthdate=None, clubsid=club.clubsid)
        db_session.add(member)
        db_session.commit()
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_MIXED, 0, None)
        names = [a["name"] for a in result]
        assert "Birth, No" not in names

    def test_return_format(self, db_session, club, athletes):
        """Each result has id, name, and gender fields."""
        result = get_eligible_athletes(db_session, club.clubsid, GENDER_MIXED, 0, 10)
        assert len(result) == 1
        athlete = result[0]
        assert "id" in athlete
        assert athlete["name"] == "Aubert, Alice"
        assert athlete["gender"] == "F"

    def test_other_club_not_included(self, db_session, club, athletes, age_base_date_config):
        """Athletes from another club are not returned."""
        other_club = TeamClub(name="Other Club", code="OTH", nation="CAN", pin="222222")
        db_session.add(other_club)
        db_session.flush()
        other_member = Member(firstname="Zoe", lastname="Zeta", gender=GENDER_F, birthdate=datetime(2010, 1, 1), clubsid=other_club.clubsid)
        db_session.add(other_member)
        db_session.commit()

        result = get_eligible_athletes(db_session, club.clubsid, GENDER_MIXED, 0, None)
        names = [a["name"] for a in result]
        assert "Zeta, Zoe" not in names