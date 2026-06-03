"""Unit tests for relay backward compatibility with swimresult relay locks.

Tests Requirements 10.1, 10.2, 10.4, 10.5:
- 10.1: Display swimresult lock athlete in position 1 when no relays record exists
- 10.2: Prefer relays/relayspos data when both exist
- 10.4: On modification, persist to relays/relayspos and remove legacy swimresult
- 10.5: Fall back to swimresult only when no relays record exists

Tests the database-level logic for backward compatibility with the relay lock
mechanism (swimresult rows for relay events).

Uses an in-memory SQLite database — no Docker required.
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

from app.models import (
    Base, SwimResult, SwimEvent, SwimSession, SwimStyle, AgeGroup, BsGlobal,
    GENDER_M, GENDER_F, GENDER_MIXED,
)
from app.models_team import TeamClub, Member, Relay, RelayPos, Meet


# ---------------------------------------------------------------------------
# Local copies of helper functions (can't import from api.py due to FastAPI dep)
# ---------------------------------------------------------------------------

def _relay_age_code(minage, maxage):
    """Convert relay minage/maxage to an age code string."""
    minage = minage or 0
    maxage = maxage or 0
    if minage <= 10 and maxage == 10:
        return "10-"
    if minage == 11 and maxage == 12:
        return "11-12"
    if minage == 13 and maxage == 14:
        return "13-14"
    if minage == 15 and maxage == 18:
        return "15-18"
    if minage == 19 and (maxage == 0 or maxage == -1 or maxage >= 99):
        return "Open"
    if minage == 0 and (maxage == 0 or maxage == -1 or maxage is None):
        return "Open"
    if maxage and maxage > 0 and maxage < 99:
        return f"{minage}-{maxage}"
    return f"{minage}-"


def _age_code_to_range(age_code):
    """Convert an age code string to (minage, maxage). maxage=None means open-ended."""
    if age_code == "10-":
        return (0, 10)
    if age_code == "11-12":
        return (11, 12)
    if age_code == "13-14":
        return (13, 14)
    if age_code == "15-18":
        return (15, 18)
    if age_code == "Open":
        return (19, None)
    if age_code == "Masters":
        return (25, None)
    parts = age_code.split("-")
    if len(parts) == 2:
        minage = int(parts[0]) if parts[0] else 0
        maxage = int(parts[1]) if parts[1] else None
        return (minage, maxage)
    return (0, None)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def db_session():
    """Create an in-memory SQLite database with all tables."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


@pytest.fixture()
def seed_data(db_session):
    """Seed the database with a club, athletes, meet, relay event, and age groups."""
    # Configs
    db_session.add(BsGlobal(name="admin_pin", data="000000"))
    db_session.add(BsGlobal(name="age_base_date", data="2026-12-31"))
    db_session.add(BsGlobal(name="current_meetsid", data="1"))

    # Club
    club = TeamClub(clubsid=1, name="Test Club", code="TST", nation="CAN", pin="111111")
    db_session.add(club)

    # Second club for admin tests
    club2 = TeamClub(clubsid=2, name="Club Deux", code="CL2", nation="CAN", pin="222222")
    db_session.add(club2)

    # Meet
    meet = Meet(meetsid=1, name="Test Meet", course=3)
    db_session.add(meet)

    # Athletes (age 14 as of 2026-12-31)
    athlete1 = Member(membersid=1, firstname="Alice", lastname="Aubert", gender=GENDER_F,
                      birthdate=datetime(2012, 3, 15), clubsid=1)
    athlete2 = Member(membersid=2, firstname="Bob", lastname="Bernier", gender=GENDER_M,
                      birthdate=datetime(2012, 7, 20), clubsid=1)
    athlete3 = Member(membersid=3, firstname="Charlie", lastname="Caron", gender=GENDER_M,
                      birthdate=datetime(2012, 1, 5), clubsid=1)
    # Athlete from club 2
    athlete4 = Member(membersid=4, firstname="Diana", lastname="Dupont", gender=GENDER_F,
                      birthdate=datetime(2012, 5, 10), clubsid=2)
    db_session.add_all([athlete1, athlete2, athlete3, athlete4])

    # Swim session
    session = SwimSession(swimsessionid=1, name="Session 1", sessionnumber=1)
    db_session.add(session)

    # Relay swim style (4x50 mixed)
    style = SwimStyle(swimstyleid=201, distance=200, stroke=6, relaycount=4,
                      name="4x50 Relais Libre", code="4x50FR")
    db_session.add(style)

    # Relay event
    event = SwimEvent(swimeventid=10, swimsessionid=1, swimstyleid=201,
                      gender=GENDER_MIXED, round=5, eventnumber=5)
    db_session.add(event)

    # Age group for the event
    agegroup = AgeGroup(agegroupid=1, swimeventid=10, agemin=13, agemax=14,
                        name="13-14", code="13-14")
    db_session.add(agegroup)

    db_session.commit()
    return {
        "club": club,
        "club2": club2,
        "athletes": [athlete1, athlete2, athlete3, athlete4],
        "event": event,
        "style": style,
        "agegroup": agegroup,
    }


# ---------------------------------------------------------------------------
# Helper: simulate the backward compatibility logic from the GET endpoint
# ---------------------------------------------------------------------------

def _build_virtual_teams_for_club(db_session, club_id, relay_events, existing_relays):
    """Simulate the backward compatibility logic from GET /api/relay-teams.

    Returns virtual teams dict: event_key -> list of virtual team dicts.
    """
    club_member_ids = [
        m.membersid for m in db_session.query(Member).filter(Member.clubsid == club_id).all()
    ]
    if not club_member_ids:
        return {}

    relay_event_ids = [ev.swimeventid for ev in relay_events]
    sr_relay_locks = (
        db_session.query(SwimResult)
        .filter(
            SwimResult.swimeventid.in_(relay_event_ids),
            SwimResult.athleteid.in_(club_member_ids),
        )
        .all()
    )

    if not sr_relay_locks:
        return {}

    # Determine existing relays keys for this club
    existing_relay_keys: set[tuple[int, str]] = set()
    for relay in existing_relays:
        if relay.clubsid == club_id:
            age_code_r = _relay_age_code(relay.minage, relay.maxage)
            for ev in relay_events:
                if ev.swimstyleid == relay.stylesid:
                    existing_relay_keys.add((ev.swimeventid, age_code_r))

    # Build virtual teams
    virtual_teams: dict[str, list] = {}
    club_virtual_keys: set[str] = set()

    for sr in sr_relay_locks:
        sr_age_code = sr.age_code or "Open"
        sr_event_id = sr.swimeventid

        # Skip if relays record exists
        if (sr_event_id, sr_age_code) in existing_relay_keys:
            continue

        event_key = f"{sr_event_id}-{sr_age_code}"

        # Skip duplicate for same club
        if event_key in club_virtual_keys:
            continue
        club_virtual_keys.add(event_key)

        # Get relay count from style
        ev = next((e for e in relay_events if e.swimeventid == sr_event_id), None)
        if not ev:
            continue
        style = db_session.query(SwimStyle).get(ev.swimstyleid)
        relaycount = style.relaycount if style else 4

        # Get athlete name
        sr_member = db_session.query(Member).get(sr.athleteid)
        athlete_name = f"{sr_member.lastname}, {sr_member.firstname}" if sr_member else None

        members_arr = []
        for i in range(1, relaycount + 1):
            if i == 1:
                members_arr.append({
                    "position": 1,
                    "athleteId": sr.athleteid,
                    "athleteName": athlete_name,
                })
            else:
                members_arr.append({
                    "position": i,
                    "athleteId": None,
                    "athleteName": None,
                })

        virtual_team = {
            "id": -sr.swimresultid,
            "teamNumber": "A",
            "teamName": None,
            "members": members_arr,
            "isVirtual": True,
            "clubId": club_id,
        }
        virtual_teams.setdefault(event_key, []).append(virtual_team)

    return virtual_teams


def _migrate_virtual_team(db_session, swimresult_id, position, athlete_id):
    """Simulate the migration logic from PUT /api/relay-teams/{negative_id}/members/{pos}.

    Returns (new_relay_id, success).
    """
    sr = db_session.query(SwimResult).get(swimresult_id)
    if not sr:
        return None, False

    event = db_session.query(SwimEvent).get(sr.swimeventid)
    if not event:
        return None, False
    style = db_session.query(SwimStyle).get(event.swimstyleid)
    if not style or not style.relaycount or style.relaycount <= 1:
        return None, False

    sr_member = db_session.query(Member).get(sr.athleteid)
    if not sr_member:
        return None, False
    target_club_id = sr_member.clubsid

    relaycount = style.relaycount
    sr_age_code = sr.age_code or "Open"
    age_min, age_max = _age_code_to_range(sr_age_code)

    # Create relay
    relay = Relay(
        meetsid=1,
        clubsid=target_club_id,
        stylesid=style.swimstyleid,
        teamnumb=1,
        gender=event.gender or 0,
        minage=age_min if age_min else 0,
        maxage=age_max if age_max else 0,
        eventnumb=event.eventnumber,
        eventtyp=0,
        resulttyp=0,
    )
    db_session.add(relay)
    db_session.flush()

    # Create position records
    for pos_num in range(1, relaycount + 1):
        db_session.add(RelayPos(
            relaysid=relay.relaysid,
            numb=pos_num,
            membersid=sr.athleteid if pos_num == 1 else None,
            entrytime=None,
        ))
    db_session.flush()

    # Apply the assignment
    pos_record = db_session.query(RelayPos).filter(
        RelayPos.relaysid == relay.relaysid,
        RelayPos.numb == position,
    ).first()
    if pos_record:
        pos_record.membersid = athlete_id

    # Remove swimresult lock
    db_session.delete(sr)
    db_session.commit()

    return relay.relaysid, True


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestRelayBackwardCompat:
    """Tests for backward compatibility with swimresult relay locks."""

    def test_virtual_team_from_swimresult_lock(self, db_session, seed_data):
        """Req 10.1: When no relays record exists, show swimresult lock athlete in position 1."""
        # Create a swimresult relay lock (athlete1 registered for relay event)
        sr = SwimResult(
            swimresultid=100,
            athleteid=1,
            swimeventid=10,
            agegroupid=1,
            age_code="13-14",
            entrytime=None,
        )
        db_session.add(sr)
        db_session.commit()

        # Simulate the backward compat query
        relay_events = db_session.query(SwimEvent).all()
        existing_relays = db_session.query(Relay).all()

        virtual_teams = _build_virtual_teams_for_club(
            db_session, club_id=1, relay_events=relay_events, existing_relays=existing_relays
        )

        # Should have a virtual team
        assert "10-13-14" in virtual_teams
        teams = virtual_teams["10-13-14"]
        assert len(teams) == 1

        team = teams[0]
        assert team["id"] == -100
        assert team["teamNumber"] == "A"
        assert team["isVirtual"] is True
        assert team["clubId"] == 1
        assert team["members"][0]["position"] == 1
        assert team["members"][0]["athleteId"] == 1
        assert team["members"][0]["athleteName"] == "Aubert, Alice"
        # Positions 2-4 should be empty
        for i in range(1, 4):
            assert team["members"][i]["athleteId"] is None

    def test_prefer_relays_over_swimresult(self, db_session, seed_data):
        """Req 10.2: When both relays and swimresult exist, prefer relays data."""
        # Create a real relay record
        relay = Relay(relaysid=1, meetsid=1, clubsid=1, stylesid=201,
                      teamnumb=1, gender=GENDER_MIXED, minage=13, maxage=14, eventnumb=5)
        db_session.add(relay)
        db_session.flush()
        db_session.add(RelayPos(relaysid=1, numb=1, membersid=2))  # Bob in pos 1
        db_session.add(RelayPos(relaysid=1, numb=2, membersid=None))
        db_session.add(RelayPos(relaysid=1, numb=3, membersid=None))
        db_session.add(RelayPos(relaysid=1, numb=4, membersid=None))

        # ALSO create a swimresult relay lock for the same event/age
        sr = SwimResult(
            swimresultid=100,
            athleteid=1,
            swimeventid=10,
            agegroupid=1,
            age_code="13-14",
            entrytime=None,
        )
        db_session.add(sr)
        db_session.commit()

        # Build virtual teams
        relay_events = db_session.query(SwimEvent).all()
        existing_relays = db_session.query(Relay).all()

        virtual_teams = _build_virtual_teams_for_club(
            db_session, club_id=1, relay_events=relay_events, existing_relays=existing_relays
        )

        # No virtual team should be created — relays record takes priority
        assert "10-13-14" not in virtual_teams

    def test_migrate_virtual_team_on_modification(self, db_session, seed_data):
        """Req 10.4: On coach modification, persist to relays/relayspos and remove swimresult."""
        # Create swimresult relay lock
        sr = SwimResult(
            swimresultid=100,
            athleteid=1,
            swimeventid=10,
            agegroupid=1,
            age_code="13-14",
            entrytime=None,
        )
        db_session.add(sr)
        db_session.commit()

        # Migrate: assign athlete2 to position 2
        new_relay_id, success = _migrate_virtual_team(db_session, 100, position=2, athlete_id=2)
        assert success is True
        assert new_relay_id is not None

        # Verify: swimresult should be deleted
        sr_check = db_session.query(SwimResult).get(100)
        assert sr_check is None

        # Verify: relay record should exist
        relay = db_session.query(Relay).get(new_relay_id)
        assert relay is not None
        assert relay.clubsid == 1
        assert relay.stylesid == 201
        assert relay.minage == 13
        assert relay.maxage == 14

        # Verify: positions should be correct
        positions = db_session.query(RelayPos).filter(
            RelayPos.relaysid == new_relay_id
        ).order_by(RelayPos.numb).all()
        assert len(positions) == 4
        assert positions[0].membersid == 1  # Original lock athlete in position 1
        assert positions[1].membersid == 2  # Newly assigned
        assert positions[2].membersid is None
        assert positions[3].membersid is None

    def test_migrate_preserves_original_athlete_pos1(self, db_session, seed_data):
        """Req 10.4: Migration keeps original lock athlete in position 1."""
        sr = SwimResult(
            swimresultid=101,
            athleteid=3,  # Charlie
            swimeventid=10,
            agegroupid=1,
            age_code="13-14",
            entrytime=None,
        )
        db_session.add(sr)
        db_session.commit()

        # Migrate: assign athlete1 to position 3
        new_relay_id, success = _migrate_virtual_team(db_session, 101, position=3, athlete_id=1)
        assert success is True

        # Position 1 still has the original lock athlete (Charlie)
        pos1 = db_session.query(RelayPos).filter(
            RelayPos.relaysid == new_relay_id, RelayPos.numb == 1
        ).first()
        assert pos1.membersid == 3  # Charlie

    def test_no_virtual_team_when_no_swimresult(self, db_session, seed_data):
        """Req 10.5: No swimresult lock → no virtual team shown."""
        relay_events = db_session.query(SwimEvent).all()
        existing_relays = db_session.query(Relay).all()

        virtual_teams = _build_virtual_teams_for_club(
            db_session, club_id=1, relay_events=relay_events, existing_relays=existing_relays
        )
        assert virtual_teams == {}

    def test_multiple_clubs_virtual_teams_independent(self, db_session, seed_data):
        """Admin mode: virtual teams for different clubs are independent."""
        # Club 1 athlete has a relay lock
        sr1 = SwimResult(
            swimresultid=100,
            athleteid=1,  # Alice (club 1)
            swimeventid=10,
            agegroupid=1,
            age_code="13-14",
            entrytime=None,
        )
        # Club 2 athlete also has a relay lock for the same event
        sr2 = SwimResult(
            swimresultid=101,
            athleteid=4,  # Diana (club 2)
            swimeventid=10,
            agegroupid=1,
            age_code="13-14",
            entrytime=None,
        )
        db_session.add_all([sr1, sr2])
        db_session.commit()

        relay_events = db_session.query(SwimEvent).all()
        existing_relays = db_session.query(Relay).all()

        # Build virtual teams for each club independently
        vt_club1 = _build_virtual_teams_for_club(
            db_session, club_id=1, relay_events=relay_events, existing_relays=existing_relays
        )
        vt_club2 = _build_virtual_teams_for_club(
            db_session, club_id=2, relay_events=relay_events, existing_relays=existing_relays
        )

        # Each club should have its own virtual team
        assert "10-13-14" in vt_club1
        assert vt_club1["10-13-14"][0]["members"][0]["athleteId"] == 1  # Alice
        assert vt_club1["10-13-14"][0]["clubId"] == 1

        assert "10-13-14" in vt_club2
        assert vt_club2["10-13-14"][0]["members"][0]["athleteId"] == 4  # Diana
        assert vt_club2["10-13-14"][0]["clubId"] == 2

    def test_migrate_removes_only_target_swimresult(self, db_session, seed_data):
        """Migration removes only the target swimresult, not others."""
        # Two different swimresult locks
        sr1 = SwimResult(
            swimresultid=100,
            athleteid=1,
            swimeventid=10,
            agegroupid=1,
            age_code="13-14",
            entrytime=None,
        )
        sr2 = SwimResult(
            swimresultid=101,
            athleteid=2,
            swimeventid=10,
            agegroupid=1,
            age_code="13-14",
            entrytime=None,
        )
        db_session.add_all([sr1, sr2])
        db_session.commit()

        # Migrate only sr1
        new_relay_id, success = _migrate_virtual_team(db_session, 100, position=2, athlete_id=3)
        assert success is True

        # sr1 deleted, sr2 still exists
        assert db_session.query(SwimResult).get(100) is None
        assert db_session.query(SwimResult).get(101) is not None

    def test_migrate_with_null_athlete_id(self, db_session, seed_data):
        """Migration with athleteId=None removes position 1 lock athlete."""
        sr = SwimResult(
            swimresultid=100,
            athleteid=1,
            swimeventid=10,
            agegroupid=1,
            age_code="13-14",
            entrytime=None,
        )
        db_session.add(sr)
        db_session.commit()

        # Migrate: set position 1 to None (remove original athlete)
        new_relay_id, success = _migrate_virtual_team(db_session, 100, position=1, athlete_id=None)
        assert success is True

        # Position 1 should now be None (overwritten)
        pos1 = db_session.query(RelayPos).filter(
            RelayPos.relaysid == new_relay_id, RelayPos.numb == 1
        ).first()
        assert pos1.membersid is None

        # Swimresult still deleted
        assert db_session.query(SwimResult).get(100) is None

    def test_create_team_materializes_swimresult_lock(self, db_session, seed_data):
        """Req 10.4: Creating a new team materializes existing swimresult lock first.

        When a coach creates a new team for an event where a swimresult lock exists,
        the lock should be materialized as Team A so the new team gets B.
        """
        # Create swimresult relay lock (Alice in relay event)
        sr = SwimResult(
            swimresultid=100,
            athleteid=1,
            swimeventid=10,
            agegroupid=1,
            age_code="13-14",
            entrytime=None,
        )
        db_session.add(sr)
        db_session.commit()

        # Simulate the create_relay_team materialization logic:
        # Check for swimresult lock when no existing relay teams exist
        style = db_session.query(SwimStyle).get(201)
        age_min, age_max = _age_code_to_range("13-14")

        existing_teams = (
            db_session.query(Relay)
            .filter(
                Relay.clubsid == 1,
                Relay.stylesid == style.swimstyleid,
                Relay.minage == (age_min if age_min else 0),
                Relay.maxage == (age_max if age_max else 0),
            )
            .all()
        )
        assert len(existing_teams) == 0  # No real relay teams yet

        # Materialize the lock (simulating what create_relay_team now does)
        club_member_ids = [
            m.membersid for m in db_session.query(Member).filter(Member.clubsid == 1).all()
        ]
        sr_lock = (
            db_session.query(SwimResult)
            .filter(
                SwimResult.swimeventid == 10,
                SwimResult.athleteid.in_(club_member_ids),
                SwimResult.age_code == "13-14",
            )
            .first()
        )
        assert sr_lock is not None

        # Create materialized relay record (Team A)
        materialized = Relay(
            meetsid=1,
            clubsid=1,
            stylesid=style.swimstyleid,
            teamnumb=1,
            gender=GENDER_MIXED,
            minage=age_min if age_min else 0,
            maxage=age_max if age_max else 0,
            eventnumb=5,
            eventtyp=0,
            resulttyp=0,
        )
        db_session.add(materialized)
        db_session.flush()

        for pos_num in range(1, style.relaycount + 1):
            db_session.add(RelayPos(
                relaysid=materialized.relaysid,
                numb=pos_num,
                membersid=sr_lock.athleteid if pos_num == 1 else None,
                entrytime=None,
            ))

        db_session.delete(sr_lock)
        db_session.flush()

        # Now create the new team (Team B)
        existing_teams = [materialized]
        used_numbers = {t.teamnumb for t in existing_teams}
        next_num = 1
        while next_num in used_numbers:
            next_num += 1
        assert next_num == 2  # Should be B (since A is taken by materialized lock)

        new_relay = Relay(
            meetsid=1,
            clubsid=1,
            stylesid=style.swimstyleid,
            teamnumb=next_num,
            gender=GENDER_MIXED,
            minage=age_min if age_min else 0,
            maxage=age_max if age_max else 0,
            eventnumb=5,
            eventtyp=0,
            resulttyp=0,
        )
        db_session.add(new_relay)
        db_session.flush()

        for pos_num in range(1, style.relaycount + 1):
            db_session.add(RelayPos(
                relaysid=new_relay.relaysid,
                numb=pos_num,
                membersid=None,
                entrytime=None,
            ))
        db_session.commit()

        # Verify: two relay teams exist
        all_relays = db_session.query(Relay).filter(Relay.clubsid == 1).all()
        assert len(all_relays) == 2
        team_numbers = sorted([r.teamnumb for r in all_relays])
        assert team_numbers == [1, 2]  # A and B

        # Verify: materialized team (A) has Alice in position 1
        mat_positions = (
            db_session.query(RelayPos)
            .filter(RelayPos.relaysid == materialized.relaysid)
            .order_by(RelayPos.numb)
            .all()
        )
        assert mat_positions[0].membersid == 1  # Alice

        # Verify: new team (B) has all empty positions
        new_positions = (
            db_session.query(RelayPos)
            .filter(RelayPos.relaysid == new_relay.relaysid)
            .order_by(RelayPos.numb)
            .all()
        )
        for pos in new_positions:
            assert pos.membersid is None

        # Verify: swimresult lock is gone
        assert db_session.query(SwimResult).get(100) is None

        # Verify: virtual team logic no longer shows anything
        relay_events = db_session.query(SwimEvent).all()
        existing_relays_all = db_session.query(Relay).all()
        virtual_teams = _build_virtual_teams_for_club(
            db_session, club_id=1, relay_events=relay_events, existing_relays=existing_relays_all
        )
        assert virtual_teams == {}  # No virtual teams — real ones exist
