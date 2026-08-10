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

"""Unit tests for Phase 1 of concurrent meets (docs/CONCURRENT_MEETS_PLAN.md).

Covers: the standalone migration tool (app/migrations/), the meetsid-scoped
delete capability it unlocks, and the session-date exclusivity check. No
Docker/FastAPI needed — meet_config.py and app/migrations/ are both free of
the FastAPI/pydantic/stripe dependencies routers/api.py pulls in (see
test_relay_backward_compat.py's note on why that matters for unit tests).

Run: `pytest tests/unit/test_concurrent_meets_migration.py -v`
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text, inspect
from sqlalchemy.orm import sessionmaker

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimEvent, SwimResult, SwimSession, MeetConfig
from app.models_team import Meet as TeamMeet
from app import models_team  # noqa: F401 — ensure all models are registered
from app import models_live  # noqa: F401
from app import models_serc  # noqa: F401
from app.migrations.versions import m0001_concurrent_meets as migration
from app.migrations.runner import apply_pending
from app.meet_config import get_active_meetsid, session_date_conflict
from app.events import load_events

POOL_TEMPLATE = Path(__file__).resolve().parent.parent.parent.parent.parent / "config" / "template_pool.lxf"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def new_engine():
    """A fresh in-memory SQLite engine, no tables yet."""
    engine = create_engine("sqlite:///:memory:")
    yield engine
    engine.dispose()


@pytest.fixture()
def db_session(new_engine):
    """Full current-shape schema (via create_all), session bound to it."""
    Base.metadata.create_all(bind=new_engine)
    TestSession = sessionmaker(bind=new_engine)
    session = TestSession()
    yield session
    session.close()


def _build_pre_phase1_schema(engine) -> None:
    """Hand-build the schema shape that existed before this migration: no
    meetsid columns on the five scoped tables, no meet_config table, no
    meet_type/registration_open on meets, no session_date on live_events.
    Mirrors the real pre-migration production shape closely enough for the
    migration's ALTER/backfill logic to exercise for real.
    """
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE bsglobal (name VARCHAR(50) PRIMARY KEY, data TEXT)"))
        conn.execute(text("CREATE TABLE meets (meetsid INTEGER PRIMARY KEY, name VARCHAR(100))"))
        conn.execute(text("CREATE TABLE swimsession (swimsessionid INTEGER PRIMARY KEY, name VARCHAR(100), startdate DATETIME)"))
        conn.execute(text("CREATE TABLE swimevent (swimeventid INTEGER PRIMARY KEY, comment TEXT)"))
        conn.execute(text("CREATE TABLE agegroup (agegroupid INTEGER PRIMARY KEY, name VARCHAR(50))"))
        conn.execute(text("CREATE TABLE swimresult (swimresultid INTEGER PRIMARY KEY, swimtime INTEGER)"))
        conn.execute(text("CREATE TABLE heat (heatid INTEGER PRIMARY KEY, heatnumber INTEGER)"))
        conn.execute(text("CREATE TABLE secret_links (id INTEGER PRIMARY KEY, token VARCHAR(36))"))
        conn.execute(text("CREATE TABLE live_events (event_id INTEGER PRIMARY KEY, event_name VARCHAR(100))"))


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------

class TestMigration:
    def test_backfills_existing_install(self, new_engine):
        """A pre-existing single-meet install: every row lands on the one
        meet that exists today, the 12 keys move into meet_config, and
        `registration_open` ends up True for it."""
        _build_pre_phase1_schema(new_engine)
        with new_engine.begin() as conn:
            conn.execute(text("INSERT INTO meets (meetsid, name) VALUES (7, 'Test Meet')"))
            conn.execute(text("INSERT INTO swimevent (swimeventid, comment) VALUES (1, 'x')"))
            conn.execute(text("INSERT INTO swimresult (swimresultid, swimtime) VALUES (1, 1000)"))
            for k, v in [
                ("current_meetsid", "7"),
                ("meet_type", "POOL"),
                ("meet_name", "Test Meet"),
                ("organizer_club_id", "3"),
                ("MEETVALUES", "NAME=S;Test"),
                ("admin_pin", "000000"),  # app-level key — must NOT move
            ]:
                conn.execute(text("INSERT INTO bsglobal (name, data) VALUES (:k, :v)"), {"k": k, "v": v})

        migration.upgrade(new_engine)

        with new_engine.connect() as conn:
            assert conn.execute(text("SELECT meetsid FROM swimevent WHERE swimeventid=1")).scalar() == 7
            assert conn.execute(text("SELECT meetsid FROM swimresult WHERE swimresultid=1")).scalar() == 7
            meet_type, reg_open = conn.execute(
                text("SELECT meet_type, registration_open FROM meets WHERE meetsid=7")
            ).fetchone()
            assert meet_type == "POOL"
            assert reg_open == 1

            moved = dict(conn.execute(text("SELECT name, data FROM meet_config WHERE meetsid=7")).fetchall())
            assert moved["meet_name"] == "Test Meet"
            assert moved["organizer_club_id"] == "3"
            assert moved["MEETVALUES"] == "NAME=S;Test"

            remaining = {r[0] for r in conn.execute(text("SELECT name FROM bsglobal")).fetchall()}
            assert "admin_pin" in remaining  # app-level key survives untouched
            assert "meet_name" not in remaining  # relocated key is gone
            assert "organizer_club_id" not in remaining

    def test_fresh_install_is_noop_beyond_create_all(self, new_engine):
        """No pre-existing swimevent table → nothing to backfill; create_all
        alone builds the final shape (meetsid columns, meet_config table)."""
        migration.upgrade(new_engine)
        insp = inspect(new_engine)
        assert "meet_config" in insp.get_table_names()
        cols = {c["name"] for c in insp.get_columns("swimevent")}
        assert "meetsid" in cols
        with new_engine.connect() as conn:
            assert conn.execute(text("SELECT COUNT(*) FROM meet_config")).scalar() == 0


class TestLoadEventsStartupGuard:
    """Regression test: main.py's startup calls events.load_events(), which
    used to only check "is swimevent empty?" before loading the pool
    template. A meet can be registration_open=True with zero events yet
    (empty meet state — see team-app's CLAUDE.md), and on that shape
    load_events would create a *second* registration_open=True Meet row.
    get_active_meetsid() then resolves to whichever has the higher meetsid —
    not necessarily the real one. Caught via live WSL testing, not by any
    prior test."""

    def test_skips_load_when_a_meet_is_already_active_with_no_events(self, db_session):
        db_session.add(TeamMeet(meetsid=7, name="Real Meet", registration_open=True))
        db_session.commit()

        count = load_events(db_session, POOL_TEMPLATE)

        assert count == 0
        assert db_session.query(TeamMeet).count() == 1
        assert get_active_meetsid(db_session) == 7

    def test_loads_when_nothing_is_active(self, db_session):
        count = load_events(db_session, POOL_TEMPLATE)

        assert count > 0
        assert db_session.query(TeamMeet).count() == 1
        assert get_active_meetsid(db_session) is not None


class TestRunner:
    def test_apply_pending_is_idempotent(self, new_engine):
        # Not scoped to migration 0001 specifically — this exercises the real
        # versions/ package, so it picks up every migration that exists (e.g.
        # 0002_hc_results_status), in filename order.
        ran_first = apply_pending(new_engine)
        assert ran_first == ["0001_concurrent_meets", "0002_hc_results_status"]

        ran_second = apply_pending(new_engine)
        assert ran_second == []

        with new_engine.connect() as conn:
            count = conn.execute(text("SELECT COUNT(*) FROM schema_migrations")).scalar()
        assert count == 2


# ---------------------------------------------------------------------------
# Scoped delete — the actual new capability Phase 1 delivers
# ---------------------------------------------------------------------------

class TestScopedDelete:
    def test_deleting_one_meets_data_leaves_the_other_untouched(self, db_session):
        db_session.add_all([
            TeamMeet(meetsid=1, name="Meet A", registration_open=True),
            TeamMeet(meetsid=2, name="Meet B", registration_open=True),
        ])
        db_session.add_all([
            SwimEvent(swimeventid=101, meetsid=1, eventnumber=1),
            SwimEvent(swimeventid=201, meetsid=2, eventnumber=1),
        ])
        db_session.add_all([
            SwimResult(swimresultid=101, meetsid=1, swimeventid=101, athleteid=1),
            SwimResult(swimresultid=201, meetsid=2, swimeventid=201, athleteid=1),
        ])
        db_session.commit()

        db_session.query(SwimResult).filter(SwimResult.meetsid == 1).delete()
        db_session.query(SwimEvent).filter(SwimEvent.meetsid == 1).delete()
        db_session.commit()

        assert db_session.query(SwimEvent).filter(SwimEvent.meetsid == 1).count() == 0
        assert db_session.query(SwimResult).filter(SwimResult.meetsid == 1).count() == 0
        assert db_session.query(SwimEvent).filter(SwimEvent.meetsid == 2).count() == 1
        assert db_session.query(SwimResult).filter(SwimResult.meetsid == 2).count() == 1

    def test_get_active_meetsid_resolves_the_open_one(self, db_session):
        db_session.add_all([
            TeamMeet(meetsid=1, name="Closed", registration_open=False),
            TeamMeet(meetsid=2, name="Open", registration_open=True),
        ])
        db_session.commit()
        assert get_active_meetsid(db_session) == 2

    def test_get_active_meetsid_none_when_nothing_open(self, db_session):
        db_session.add(TeamMeet(meetsid=1, name="Closed", registration_open=False))
        db_session.commit()
        assert get_active_meetsid(db_session) is None


# ---------------------------------------------------------------------------
# Session-date exclusivity
# ---------------------------------------------------------------------------

class TestSessionDateExclusivity:
    def test_colliding_date_across_two_open_meets_is_rejected(self, db_session):
        db_session.add_all([
            TeamMeet(meetsid=1, name="Meet A", registration_open=True),
            TeamMeet(meetsid=2, name="Meet B", registration_open=True),
        ])
        db_session.add(SwimSession(swimsessionid=1, meetsid=1, startdate=date(2027, 2, 6)))
        new_session = SwimSession(swimsessionid=2, meetsid=2, startdate=None)
        db_session.add(new_session)
        db_session.commit()

        conflict = session_date_conflict(db_session, new_session, date(2027, 2, 6))
        assert conflict == "Meet A"

    def test_non_colliding_dates_are_fine(self, db_session):
        db_session.add_all([
            TeamMeet(meetsid=1, name="Meet A", registration_open=True),
            TeamMeet(meetsid=2, name="Meet B", registration_open=True),
        ])
        db_session.add(SwimSession(swimsessionid=1, meetsid=1, startdate=date(2027, 2, 6)))
        new_session = SwimSession(swimsessionid=2, meetsid=2, startdate=None)
        db_session.add(new_session)
        db_session.commit()

        conflict = session_date_conflict(db_session, new_session, date(2027, 2, 20))
        assert conflict is None

    def test_a_session_does_not_conflict_with_its_own_date(self, db_session):
        db_session.add(TeamMeet(meetsid=1, name="Meet A", registration_open=True))
        existing = SwimSession(swimsessionid=1, meetsid=1, startdate=date(2027, 2, 6))
        db_session.add(existing)
        db_session.commit()

        # Re-saving the same session with the same date must not self-conflict.
        conflict = session_date_conflict(db_session, existing, date(2027, 2, 6))
        assert conflict is None

    def test_closed_meets_dates_dont_block(self, db_session):
        """A meet that isn't registration_open (e.g. archived) shouldn't
        count as a collision source."""
        db_session.add_all([
            TeamMeet(meetsid=1, name="Archived", registration_open=False),
            TeamMeet(meetsid=2, name="Meet B", registration_open=True),
        ])
        db_session.add(SwimSession(swimsessionid=1, meetsid=1, startdate=date(2027, 2, 6)))
        new_session = SwimSession(swimsessionid=2, meetsid=2, startdate=None)
        db_session.add(new_session)
        db_session.commit()

        conflict = session_date_conflict(db_session, new_session, date(2027, 2, 6))
        assert conflict is None
