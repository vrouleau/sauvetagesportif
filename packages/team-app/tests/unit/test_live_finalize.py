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
"""POST /api/live/finalize closes the meet from its live results.

It called `_reset_for_next_meet(db)` without the meet id that function
requires, so every finalize crashed with a TypeError (nothing archived,
the meet never closed). Covers: results archived under a historical meet
with the meet's course, the live meet closed, a next meet with a course,
live tables emptied.

Uses an in-memory SQLite database — no Docker required.
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, BsGlobal, SwimEvent, SwimSession, SwimStyle, GENDER_F  # noqa: E402
from app.models_live import LiveEvent, LiveResult  # noqa: E402
from app.models_team import Meet, Member, Result, TeamClub  # noqa: E402
from app.routers import api, live  # noqa: E402
from app.meet_config import get_active_meetsid, _get_meet_config, _set_meet_config  # noqa: E402

_REPO_ROOT = Path(__file__).parent.parent.parent.parent.parent


@pytest.fixture()
def db(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    monkeypatch.setattr(api, "MEET_STORAGE", tmp_path / "meet.lxf")
    monkeypatch.setenv("MEET_TEMPLATE_POOL", str(_REPO_ROOT / "config" / "template_pool.lxf"))
    monkeypatch.setenv("MEET_TEMPLATE_BEACH", str(_REPO_ROOT / "config" / "template_beach.lxf"))
    yield session
    session.close()
    engine.dispose()


def _seed_live_meet(db):
    db.add(BsGlobal(name="age_base_date", data="2026-12-31"))
    db.add(BsGlobal(name="LIVE_ENABLED", data="T"))
    db.add(Meet(meetsid=1, name="Live Meet", course=3, registration_open=True))
    db.add(TeamClub(clubsid=1, name="Club Un", code="UN", nation="CAN", pin="111111"))
    db.add(Member(membersid=1, firstname="A", lastname="B", gender=GENDER_F,
                  birthdate=datetime(2005, 1, 1), clubsid=1))
    db.add(SwimStyle(swimstyleid=501, distance=50, stroke=1, relaycount=1, name="50 Libre"))
    db.add(SwimSession(swimsessionid=1, meetsid=1, name="S1", sessionnumber=1, course=3))
    db.add(SwimEvent(swimeventid=10, meetsid=1, swimsessionid=1, swimstyleid=501,
                     gender=GENDER_F, round=5, eventnumber=1))
    db.add(LiveEvent(event_id=10, event_number=1, event_name="50 Libre"))
    db.add(LiveResult(event_id=10, heat_number=1, lane=4, athlete_id=1, swimtime_ms=31250))
    db.commit()
    _set_meet_config(db, 1, "meet_name", "Live Meet")
    _set_meet_config(db, 1, "meet_course", "SCM")
    db.commit()


def test_finalize_archives_and_closes_the_meet(db):
    _seed_live_meet(db)

    out = asyncio.run(live.finalize_meet(db=db))

    assert out["ok"] and out["results_archived"] == 1
    archived = db.get(Meet, out["meet_id"])
    assert archived.meetstate == 3 and archived.course == 3
    result = db.query(Result).filter(Result.meetsid == out["meet_id"]).one()
    assert (result.membersid, result.stylesid, result.totaltime, result.course) == (1, 501, 31250, 3)

    # The live meet is closed and the next meet has a course
    assert db.get(Meet, 1) is None
    nxt = get_active_meetsid(db)
    assert nxt not in (None, 1, out["meet_id"])
    assert _get_meet_config(db, nxt, "meet_course") is not None

    # Live state cleared
    assert db.query(LiveResult).count() == 0
    assert db.get(BsGlobal, "LIVE_ENABLED") is None
