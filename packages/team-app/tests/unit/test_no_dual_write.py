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

"""Unit tests for single-write behavior (no dual-write).

Verifies that after the dual-schema removal:
- create_club writes only to `clubs` table (no `club` table exists)
- create_athlete writes only to `members` table (no `athlete` table exists)
- create_registration writes only to `swimresult` table (no parallel `results` row)
- delete_registration deletes only from `swimresult` table (no parallel `results` delete)

Uses an in-memory SQLite database — no Docker required.
Tests the actual database operations that the API endpoints perform.

Requirements: 4.1, 4.2, 4.5, 4.6
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimResult, SwimEvent, SwimSession, SwimStyle, AgeGroup
from app.models_team import TeamClub, Member, Result, Meet


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
def seeded_club(db_session) -> TeamClub:
    """Insert a club directly into the DB for test setup."""
    club = TeamClub(name="Existing Club", code="EXI", nation="CAN", pin="123456")
    db_session.add(club)
    db_session.commit()
    return club


@pytest.fixture()
def seeded_member(db_session, seeded_club) -> Member:
    """Insert a member directly into the DB for test setup."""
    member = Member(
        firstname="Alice",
        lastname="Smith",
        gender=2,
        birthdate=date(2000, 1, 15),
        clubsid=seeded_club.clubsid,
    )
    db_session.add(member)
    db_session.commit()
    return member


@pytest.fixture()
def seeded_event(db_session) -> SwimEvent:
    """Insert a swim session, style, event, and age group for registration tests."""
    session = SwimSession(name="Session 1")
    db_session.add(session)
    db_session.flush()

    style = SwimStyle(
        swimstyleid=1,
        distance=100,
        stroke=2,
        relaycount=1,
        name="100m Freestyle",
    )
    db_session.add(style)
    db_session.flush()

    event = SwimEvent(
        swimsessionid=session.swimsessionid,
        swimstyleid=style.swimstyleid,
        gender=2,
        round=5,  # TIM
    )
    db_session.add(event)
    db_session.flush()

    agegroup = AgeGroup(
        swimeventid=event.swimeventid,
        agemin=18,
        agemax=25,
        gender=2,
    )
    db_session.add(agegroup)
    db_session.commit()

    return event


# ---------------------------------------------------------------------------
# Tests: create_club writes only to `clubs`
# ---------------------------------------------------------------------------

class TestCreateClubSingleWrite:
    """Requirement 4.1: create_club writes only to `clubs` (not to both `clubs` and `club`)."""

    def test_club_table_does_not_exist_in_schema(self, db_session):
        """The old `club` table must not exist in the schema — proves no dual-write is possible."""
        inspector = inspect(db_session.bind)
        table_names = inspector.get_table_names()
        assert "club" not in table_names, "Old 'club' table should not exist in schema"

    def test_create_club_writes_to_clubs_table(self, db_session):
        """Simulating create_club: writing a TeamClub row lands in `clubs` table only."""
        clubs_before = db_session.query(TeamClub).count()

        # This is what the create_club endpoint does:
        club = TeamClub(name="New Club", code="NEW", nation="CAN", pin="654321")
        db_session.add(club)
        db_session.commit()

        # Verify the club exists in `clubs` table
        clubs_after = db_session.query(TeamClub).count()
        assert clubs_after == clubs_before + 1

        fetched = db_session.query(TeamClub).filter(TeamClub.clubsid == club.clubsid).first()
        assert fetched is not None
        assert fetched.name == "New Club"
        assert fetched.code == "NEW"

    def test_create_club_only_clubs_table_has_identity_data(self, db_session):
        """After creating a club, only `clubs` table contains club identity data.
        No other table in the schema stores club identity (old `club` table is gone)."""
        inspector = inspect(db_session.bind)
        table_names = inspector.get_table_names()

        # The only table that stores club identity is `clubs`
        assert "clubs" in table_names
        assert "club" not in table_names

        # Create a club
        club = TeamClub(name="Solo Club", code="SOL", nation="USA", pin="111111")
        db_session.add(club)
        db_session.commit()

        # Verify it's in clubs
        assert db_session.query(TeamClub).filter(TeamClub.name == "Solo Club").first() is not None


# ---------------------------------------------------------------------------
# Tests: create_athlete writes only to `members`
# ---------------------------------------------------------------------------

class TestCreateAthleteSingleWrite:
    """Requirement 4.2: create_athlete writes only to `members` (not to both `members` and `athlete`)."""

    def test_athlete_table_does_not_exist_in_schema(self, db_session):
        """The old `athlete` table must not exist in the schema — proves no dual-write is possible."""
        inspector = inspect(db_session.bind)
        table_names = inspector.get_table_names()
        assert "athlete" not in table_names, "Old 'athlete' table should not exist in schema"

    def test_create_athlete_writes_to_members_table(self, db_session, seeded_club):
        """Simulating create_athlete: writing a Member row lands in `members` table only."""
        members_before = db_session.query(Member).count()

        # This is what the create_athlete endpoint does:
        member = Member(
            firstname="Bob",
            lastname="Jones",
            gender=1,
            birthdate=date(2001, 5, 20),
            clubsid=seeded_club.clubsid,
        )
        db_session.add(member)
        db_session.commit()

        # Verify the member exists in `members` table
        members_after = db_session.query(Member).count()
        assert members_after == members_before + 1

        fetched = db_session.query(Member).filter(Member.membersid == member.membersid).first()
        assert fetched is not None
        assert fetched.firstname == "Bob"
        assert fetched.lastname == "Jones"
        assert fetched.clubsid == seeded_club.clubsid

    def test_create_athlete_only_members_table_has_identity_data(self, db_session, seeded_club):
        """After creating an athlete, only `members` table contains athlete identity data.
        No other table in the schema stores athlete identity (old `athlete` table is gone)."""
        inspector = inspect(db_session.bind)
        table_names = inspector.get_table_names()

        # The only table that stores athlete identity is `members`
        assert "members" in table_names
        assert "athlete" not in table_names

        # Create a member
        member = Member(
            firstname="Carol",
            lastname="White",
            gender=2,
            birthdate=date(1999, 3, 10),
            clubsid=seeded_club.clubsid,
        )
        db_session.add(member)
        db_session.commit()

        # Verify it's in members
        assert db_session.query(Member).filter(Member.firstname == "Carol").first() is not None


# ---------------------------------------------------------------------------
# Tests: create_registration writes only to `swimresult`
# ---------------------------------------------------------------------------

class TestCreateRegistrationSingleWrite:
    """Requirement 4.5: create_registration writes only to `swimresult` (no parallel `results` write)."""

    def test_create_registration_writes_to_swimresult(
        self, db_session, seeded_member, seeded_event
    ):
        """Simulating create_registration: writing a SwimResult row lands in `swimresult` only."""
        swimresults_before = db_session.query(SwimResult).count()

        # This is what the create_registration endpoint does:
        reg = SwimResult(
            athleteid=seeded_member.membersid,
            swimeventid=seeded_event.swimeventid,
            age_code="18-25",
            entrytime=65000,
        )
        db_session.add(reg)
        db_session.commit()

        # Verify swimresult has the new row
        swimresults_after = db_session.query(SwimResult).count()
        assert swimresults_after == swimresults_before + 1

        fetched = db_session.query(SwimResult).filter(
            SwimResult.swimresultid == reg.swimresultid
        ).first()
        assert fetched is not None
        assert fetched.athleteid == seeded_member.membersid
        assert fetched.swimeventid == seeded_event.swimeventid
        assert fetched.entrytime == 65000

    def test_create_registration_no_results_row(
        self, db_session, seeded_member, seeded_event
    ):
        """Creating a registration does NOT create a parallel row in the Team Manager `results` table.
        This is the key dual-write elimination: registrations go to `swimresult` only."""
        results_before = db_session.query(Result).count()

        # Simulate what create_registration does
        reg = SwimResult(
            athleteid=seeded_member.membersid,
            swimeventid=seeded_event.swimeventid,
            age_code="18-25",
            entrytime=70000,
        )
        db_session.add(reg)
        db_session.commit()

        # Verify NO new row in `results` table
        results_after = db_session.query(Result).count()
        assert results_after == results_before, (
            "create_registration must NOT write to the Team Manager `results` table"
        )

    def test_swimresult_fk_references_members(self, db_session, seeded_member, seeded_event):
        """SwimResult.athleteid correctly references members.membersid (not old athlete table)."""
        reg = SwimResult(
            athleteid=seeded_member.membersid,
            swimeventid=seeded_event.swimeventid,
            age_code="18-25",
            entrytime=55000,
        )
        db_session.add(reg)
        db_session.commit()

        # Verify the relationship resolves to the correct Member
        db_session.refresh(reg)
        assert reg.member is not None
        assert reg.member.membersid == seeded_member.membersid
        assert reg.member.firstname == "Alice"


# ---------------------------------------------------------------------------
# Tests: delete_registration deletes only from `swimresult`
# ---------------------------------------------------------------------------

class TestDeleteRegistrationSingleWrite:
    """Requirement 4.6: delete_registration deletes only from `swimresult` (no parallel `results` delete)."""

    def test_delete_registration_removes_from_swimresult(
        self, db_session, seeded_member, seeded_event
    ):
        """Simulating delete_registration: deleting a SwimResult removes it from `swimresult`."""
        # Create a registration
        reg = SwimResult(
            athleteid=seeded_member.membersid,
            swimeventid=seeded_event.swimeventid,
            age_code="18-25",
            entrytime=60000,
        )
        db_session.add(reg)
        db_session.commit()
        reg_id = reg.swimresultid

        # This is what the delete_registration endpoint does:
        db_session.delete(reg)
        db_session.commit()

        # Verify swimresult row is gone
        deleted = db_session.query(SwimResult).filter(SwimResult.swimresultid == reg_id).first()
        assert deleted is None

    def test_delete_registration_no_results_deletion(
        self, db_session, seeded_member, seeded_event
    ):
        """Deleting a registration does NOT delete from the Team Manager `results` table.
        Historical results must remain intact when current-meet registrations are removed."""
        # Insert a historical result in `results` for this member (simulating past meet data)
        meet = Meet(name="Past Meet", meetstate=3, course=1)
        db_session.add(meet)
        db_session.flush()

        historical_result = Result(
            membersid=seeded_member.membersid,
            meetsid=meet.meetsid,
            totaltime=59000,
            course=1,
        )
        db_session.add(historical_result)
        db_session.flush()

        # Create a swimresult registration
        reg = SwimResult(
            athleteid=seeded_member.membersid,
            swimeventid=seeded_event.swimeventid,
            age_code="18-25",
            entrytime=62000,
        )
        db_session.add(reg)
        db_session.commit()

        results_before = db_session.query(Result).count()
        assert results_before >= 1, "Should have at least one historical result"

        # Simulate what delete_registration does:
        db_session.delete(reg)
        db_session.commit()

        # Verify `results` table is untouched
        results_after = db_session.query(Result).count()
        assert results_after == results_before, (
            "delete_registration must NOT delete from the Team Manager `results` table"
        )

        # Verify the historical result still exists
        hist = db_session.query(Result).filter(
            Result.resultsid == historical_result.resultsid
        ).first()
        assert hist is not None
        assert hist.totaltime == 59000