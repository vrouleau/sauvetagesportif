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
from datetime import datetime
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimSession, SwimEvent, AgeGroup, SwimResult, SwimStyle, SecretLink  # noqa: E402
from app.models_team import (  # noqa: E402
    Meet as TeamMeet, Session as TeamSession, Event as TeamEvent,
    Relay as TeamRelay, RelayPos as TeamRelayPos, TeamClub,
)
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


@pytest.fixture()
def db_session_fk_enforced(tmp_path, monkeypatch):
    """Same as db_session, but with SQLite's FK-enforcement pragma turned on
    — matches the production engine (app/database.py sets `PRAGMA
    foreign_keys=ON` on every connection). Plain create_engine("sqlite:///
    :memory:") leaves FK enforcement off by default, which would silently
    hide any bug that only manifests as a FOREIGN KEY constraint error."""
    engine = create_engine("sqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def _enable_fk(dbapi_conn, _connection_record):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()
    monkeypatch.setattr(api, "MEET_STORAGE", tmp_path / "meet.lxf")
    monkeypatch.setenv("MEET_TEMPLATE_POOL", str(_TEMPLATE_POOL))
    monkeypatch.setenv("MEET_TEMPLATE_BEACH", str(_TEMPLATE_BEACH))
    yield session
    session.close()
    engine.dispose()


class _FakeRequest:
    """Stand-in for FastAPI's Request — resolve_meetsid only reads
    request.headers.get("X-Meet-Id")."""
    def __init__(self, meet_id_header: str | None = None):
        self.headers = {} if meet_id_header is None else {"X-Meet-Id": meet_id_header}


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


# ---------------------------------------------------------------------------
# /api/admin/meets/{id} deletion with leftover secret_links
# ---------------------------------------------------------------------------

class TestDeleteMeetWithSecretLinks:
    """Regression test for a real WSL-logs incident: DELETE
    /admin/meets/{id} (via _flush_meet_data) crashed with `sqlite3.
    IntegrityError: FOREIGN KEY constraint failed` on any meet that had ever
    had an invite email sent for it — every "send invite PIN" click
    (/clubs/{id}/send-pin) writes a secret_links row scoped to meetsid, but
    _flush_meet_data never deleted them and SecretLink.meetsid has no
    ON DELETE CASCADE. Fixed by deleting secret_links explicitly in
    _flush_meet_data.

    Needs db_session_fk_enforced, not the plain db_session fixture — SQLite
    doesn't enforce FK constraints by default, so the bug wouldn't have
    raised anything on the un-enforced in-memory engine the other tests in
    this file use. Only the production engine (app/database.py, `PRAGMA
    foreign_keys=ON`) makes this a real crash, which is exactly why no
    earlier unit test caught it.
    """

    def test_delete_meet_with_secret_links_does_not_raise(self, db_session_fk_enforced):
        db = db_session_fk_enforced
        db.add(TeamMeet(meetsid=600, name="Meet With Invites", meetstate=0, registration_open=True))
        db.add(TeamClub(clubsid=1, name="Club A", pin="123456"))
        db.commit()
        db.add_all([
            SecretLink(token="tok-1", club_id=1, meetsid=600,
                       pin_encrypted="enc", expires_at=datetime.utcnow()),
            SecretLink(token="tok-2", club_id=1, meetsid=600,
                       pin_encrypted="enc", expires_at=datetime.utcnow()),
        ])
        db.commit()

        api.delete_meet(600, db=db)  # must not raise IntegrityError

        assert db.get(TeamMeet, 600) is None
        assert db.query(SecretLink).filter_by(meetsid=600).count() == 0

    def test_flush_meet_data_deletes_secret_links_scoped_to_target_meetsid(self, db_session_fk_enforced):
        """A second meet's secret_links must survive — same wipe-scope
        invariant as every other table _flush_meet_data touches."""
        db = db_session_fk_enforced
        db.add_all([
            TeamMeet(meetsid=601, name="Meet A (untouched)", meetstate=0, registration_open=True),
            TeamMeet(meetsid=602, name="Meet B (being deleted)", meetstate=0, registration_open=True),
            TeamClub(clubsid=1, name="Club A", pin="123456"),
        ])
        db.commit()
        db.add_all([
            SecretLink(token="tok-a", club_id=1, meetsid=601,
                       pin_encrypted="enc", expires_at=datetime.utcnow()),
            SecretLink(token="tok-b", club_id=1, meetsid=602,
                       pin_encrypted="enc", expires_at=datetime.utcnow()),
        ])
        db.commit()

        api.delete_meet(602, db=db)

        assert db.get(TeamMeet, 601) is not None
        assert db.query(SecretLink).filter_by(meetsid=601).count() == 1
        assert db.query(SecretLink).filter_by(meetsid=602).count() == 0


# ---------------------------------------------------------------------------
# /api/meet/reset — in-place full flush of the caller's own current meet
# ---------------------------------------------------------------------------

def _seed_entries(db_session, meetsid: int, event_id: int) -> None:
    """Add one individual entry and one relay team (with a member) hanging
    off an existing meet/event, for reset-wipe-scope assertions."""
    db_session.add(SwimResult(meetsid=meetsid, swimeventid=event_id, athleteid=1, entrytime=None))
    db_session.add(TeamRelay(relaysid=meetsid, meetsid=meetsid, clubsid=1, teamnumb=1,
                              name="TestRelay", stylesid=530, eventnumb=1))
    db_session.add(TeamRelayPos(relaysid=meetsid, numb=1, membersid=1))
    db_session.commit()


class TestResetMeet:
    """/api/meet/reset — the organizer-facing "New Pool/Beach Meet" buttons
    on the /meet page. Unlike /admin/new-meet (create_new_meet, above),
    this never allocates a new meetsid: it's an in-place full flush of the
    caller's own current meet (structure + individual + relay entries),
    scoped via resolve_meetsid/X-Meet-Id so a second, independently-open
    meet is untouched — the same wipe-scope invariant this whole file
    guards for /admin/new-meet and /upload/meet.
    """

    def test_reset_keeps_same_meetsid(self, db_session):
        _make_meet_with_data(db_session, meetsid=500, name="Meet To Reset")
        _seed_entries(db_session, meetsid=500, event_id=500)

        result = api.reset_meet(_FakeRequest(), {"meet_type": "pool"}, db=db_session)

        assert result["meet_id"] == 500
        assert db_session.get(TeamMeet, 500) is not None

    def test_reset_wipes_structure_and_entries(self, db_session):
        _make_meet_with_data(db_session, meetsid=501, name="Meet To Reset")
        _seed_entries(db_session, meetsid=501, event_id=501)

        api.reset_meet(_FakeRequest(), {"meet_type": "pool"}, db=db_session)

        assert db_session.query(SwimSession).filter_by(meetsid=501).count() == 0
        assert db_session.query(SwimEvent).filter_by(meetsid=501).count() == 0
        assert db_session.query(AgeGroup).filter_by(meetsid=501).count() == 0
        assert db_session.query(SwimResult).filter_by(meetsid=501).count() == 0
        assert db_session.query(TeamRelay).filter_by(meetsid=501).count() == 0
        assert db_session.query(TeamRelayPos).count() == 0

    def test_reset_loads_blank_structure_not_template_stub_events(self, db_session):
        """Matches create_new_meet's own semantics: the template's stub
        events only exist to seed the SwimStyle catalog, then get stripped
        — the organizer builds real structure from scratch afterward."""
        _make_meet_with_data(db_session, meetsid=504, name="Meet To Reset")

        api.reset_meet(_FakeRequest(), {"meet_type": "pool"}, db=db_session)

        assert db_session.query(SwimEvent).filter_by(meetsid=504).count() == 0
        assert db_session.query(SwimStyle).count() > 0

    def test_reset_does_not_affect_a_second_open_meet(self, db_session):
        _make_meet_with_data(db_session, meetsid=502, name="Meet A (untouched)")
        _make_meet_with_data(db_session, meetsid=503, name="Meet B (being reset)")
        _seed_entries(db_session, meetsid=502, event_id=502)
        _seed_entries(db_session, meetsid=503, event_id=503)

        api.reset_meet(_FakeRequest(meet_id_header="503"), {"meet_type": "pool"}, db=db_session)

        # Meet A (a different, concurrently-open meet) is completely untouched.
        assert db_session.get(TeamMeet, 502) is not None
        assert db_session.query(SwimEvent).filter_by(meetsid=502).count() == 1
        assert db_session.query(SwimResult).filter_by(meetsid=502).count() == 1
        assert db_session.query(TeamRelay).filter_by(meetsid=502).count() == 1

        # Meet B was fully wiped, but kept its identity.
        assert db_session.get(TeamMeet, 503) is not None
        assert db_session.query(SwimEvent).filter_by(meetsid=503).count() == 0
        assert db_session.query(SwimResult).filter_by(meetsid=503).count() == 0
        assert db_session.query(TeamRelay).filter_by(meetsid=503).count() == 0

    def test_reset_beach_sets_meet_type(self, db_session):
        _make_meet_with_data(db_session, meetsid=506, name="Meet To Reset")

        result = api.reset_meet(_FakeRequest(), {"meet_type": "beach"}, db=db_session)

        assert result["meet_type"] == "beach"
        assert db_session.get(TeamMeet, 506).meet_type == "BEACH"

    def test_reset_invalid_meet_type_raises_400(self, db_session):
        _make_meet_with_data(db_session, meetsid=505, name="Meet")

        with pytest.raises(HTTPException) as exc_info:
            api.reset_meet(_FakeRequest(), {"meet_type": "ocean"}, db=db_session)
        assert exc_info.value.status_code == 400

    def test_reset_with_no_open_meet_raises_404(self, db_session):
        with pytest.raises(HTTPException) as exc_info:
            api.reset_meet(_FakeRequest(), {}, db=db_session)
        assert exc_info.value.status_code == 404
