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

"""Regression tests for the Phase 2 (Stage 1) meet-creation wipe-scope fix
(docs/CONCURRENT_MEETS_PLAN.md).

Before this fix, `create_new_meet` (/admin/new-meet) and
`_replace_current_meet_structure` (/upload/meet) both wiped *every*
non-archived meet's data before building the new/replacement one — safe
only because exactly one non-archived meet ever existed. Once a second meet
can be independently `registration_open=True` (Phase 2), that blanket wipe
would silently destroy its registrations the moment anyone opened or
re-uploaded a different meet.

Uses an in-memory SQLite database, with real FastAPI/pydantic/stripe
dependencies available (installed alongside tests/requirements-test.txt in
CI — see .github/workflows/ci.yml) so routers/api.py itself can be
imported and its endpoint functions called directly, same pattern as
test_meet_config_sync.py.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimSession, SwimEvent, AgeGroup  # noqa: E402
from app.models_team import Meet as TeamMeet, Session as TeamSession, Event as TeamEvent  # noqa: E402
from app.routers import api  # noqa: E402
from app.meet_config import get_active_meetsid  # noqa: E402


_REPO_ROOT = Path(__file__).parent.parent.parent.parent.parent
_TEMPLATE_POOL = _REPO_ROOT / "config" / "template_pool.lxf"
_TEMPLATE_BEACH = _REPO_ROOT / "config" / "template_beach.lxf"


@pytest.fixture()
def db_session(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()
    # MEET_STORAGE defaults to /app/data/meet.lxf (the Docker container
    # path) — redirect it to a throwaway file for the test process.
    monkeypatch.setattr(api, "MEET_STORAGE", tmp_path / "meet.lxf")
    # MEET_TEMPLATE_POOL/_BEACH are always set explicitly in Docker
    # (docker-compose.yml) — the module's own __file__-relative fallback
    # path is Docker-container-shaped and isn't meant to resolve outside
    # it, so point them at the real repo templates for this test process.
    monkeypatch.setenv("MEET_TEMPLATE_POOL", str(_TEMPLATE_POOL))
    monkeypatch.setenv("MEET_TEMPLATE_BEACH", str(_TEMPLATE_BEACH))
    yield session
    session.close()
    engine.dispose()


def _make_meet_with_data(db_session, meetsid: int, name: str) -> None:
    """Directly seed a meet with a session/event/age-group, bypassing LXF
    parsing — this test only cares about what survives a *different* meet's
    creation/re-upload, not about structure loading itself."""
    db_session.add(TeamMeet(meetsid=meetsid, name=name, meetstate=0, registration_open=True))
    db_session.add(TeamSession(sessionsid=meetsid, meetsid=meetsid, numb=1, name="S1"))
    db_session.add(SwimSession(swimsessionid=meetsid, meetsid=meetsid, sessionnumber=1, name="S1"))
    db_session.add(TeamEvent(eventsid=meetsid, meetsid=meetsid, sessionnumb=1, numb=1, gender=1))
    db_session.add(SwimEvent(swimeventid=meetsid, meetsid=meetsid, swimsessionid=meetsid,
                              eventnumber=1, gender=1, round=0))
    db_session.add(AgeGroup(agegroupid=meetsid, meetsid=meetsid, swimeventid=meetsid, agemin=0, agemax=99))
    db_session.commit()


def test_create_new_meet_does_not_delete_a_second_open_meets_data(db_session):
    """The core Phase 2 regression: opening a brand new meet while another
    one is already open must leave the other meet's rows in place."""
    _make_meet_with_data(db_session, meetsid=100, name="Meet A (still registering)")

    result = api.create_new_meet({"meet_type": "pool"}, db=db_session)
    assert "styles_loaded" in result

    # Meet A's own data survives untouched.
    meet_a = db_session.get(TeamMeet, 100)
    assert meet_a is not None, "Meet A's row was deleted"
    assert db_session.query(SwimSession).filter_by(meetsid=100).count() == 1
    assert db_session.query(SwimEvent).filter_by(meetsid=100).count() == 1
    assert db_session.query(AgeGroup).filter_by(meetsid=100).count() == 1

    # Meet A is closed (not left as an invisible second open meet), but the
    # new meet is what's now active.
    assert meet_a.registration_open is False
    active = get_active_meetsid(db_session)
    assert active is not None and active != 100


def test_create_new_meet_twice_preserves_first_meets_data(db_session):
    """Two sequential admin/new-meet calls (pool then beach) — the same
    shape as the existing TestNewMeetPreservesHistory integration test, but
    asserting the *non-archived* predecessor survives too, not just
    archived history."""
    first = api.create_new_meet({"meet_type": "pool"}, db=db_session)
    first_meetsid = get_active_meetsid(db_session)
    assert first_meetsid is not None

    second = api.create_new_meet({"meet_type": "beach"}, db=db_session)
    second_meetsid = get_active_meetsid(db_session)
    assert second_meetsid is not None
    assert second_meetsid != first_meetsid

    first_meet = db_session.get(TeamMeet, first_meetsid)
    assert first_meet is not None, "First meet's row was deleted by the second new-meet call"
    assert first_meet.registration_open is False


def test_replace_current_meet_structure_scoped_to_target_meetsid(db_session):
    """_replace_current_meet_structure (the /upload/meet path) with an
    explicit target_meetsid must wipe only that meet — a second,
    independently-open meet's data must be untouched."""
    _make_meet_with_data(db_session, meetsid=200, name="Meet A (concurrent, untouched)")
    _make_meet_with_data(db_session, meetsid=201, name="Meet B (being re-uploaded)")

    from app.meet_parser import parse_meet_lxf
    content = _TEMPLATE_POOL.read_bytes()
    meet = parse_meet_lxf(_TEMPLATE_POOL)

    api._replace_current_meet_structure(db_session, meet, content, "meet.lxf", target_meetsid=201)

    # Meet A (a different, concurrently-open meet) is completely untouched.
    assert db_session.get(TeamMeet, 200) is not None
    assert db_session.query(SwimSession).filter_by(meetsid=200).count() == 1
    assert db_session.query(SwimEvent).filter_by(meetsid=200).count() == 1
    assert db_session.query(AgeGroup).filter_by(meetsid=200).count() == 1

    # Meet B kept its identity (same meetsid) but its stub data was replaced
    # by the uploaded template's structure.
    meet_b = db_session.get(TeamMeet, 201)
    assert meet_b is not None, "Meet B's row was deleted instead of reused"
    assert db_session.query(SwimEvent).filter_by(meetsid=201).count() > 0


def test_create_new_meet_still_preserves_archived_meets(db_session):
    """Same invariant as the existing TestNewMeetPreservesHistory integration
    test (test_integration.py) — archived (meetstate=3) meets and their data
    must survive a new-meet call. Covered again here at the unit level since
    this fix touches the exact code path that regression guards."""
    _make_meet_with_data(db_session, meetsid=400, name="Archived meet")
    db_session.get(TeamMeet, 400).meetstate = 3
    db_session.commit()

    api.create_new_meet({"meet_type": "pool"}, db=db_session)

    assert db_session.get(TeamMeet, 400) is not None
    assert db_session.query(SwimSession).filter_by(meetsid=400).count() == 1
    assert db_session.query(SwimEvent).filter_by(meetsid=400).count() == 1


def test_replace_current_meet_structure_default_reuses_active_meet(db_session):
    """No explicit target_meetsid (today's single-meet call sites, before
    Phase 2 wires up X-Meet-Id) must keep replacing "the" active meet in
    place, not create a new one — the common re-upload flow every meet
    cycle starts with must stay behavior-identical."""
    _make_meet_with_data(db_session, meetsid=300, name="Only meet")

    from app.meet_parser import parse_meet_lxf
    content = _TEMPLATE_POOL.read_bytes()
    meet = parse_meet_lxf(_TEMPLATE_POOL)

    api._replace_current_meet_structure(db_session, meet, content, "meet.lxf")

    assert get_active_meetsid(db_session) == 300
    assert db_session.get(TeamMeet, 300) is not None
    assert db_session.query(SwimEvent).filter_by(meetsid=300).count() > 0
