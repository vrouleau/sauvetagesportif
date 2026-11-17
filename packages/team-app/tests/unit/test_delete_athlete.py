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

"""DELETE /api/athletes/{id} for an athlete who sits on a relay team.

Regression: relayspos.membersid references members with no ON DELETE rule,
so deleting any athlete on a relay team (e.g. one archived by a historical
results import) failed with a FOREIGN KEY constraint error (HTTP 500). The
slot is now emptied and the team kept.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base  # noqa: E402
from app.models_team import Meet, Member, MemberMeet, Relay, RelayPos, Result, TeamClub  # noqa: E402
from app.routers import api  # noqa: E402


@pytest.fixture()
def db_session():
    """FK enforcement on, like the production engine (app/database.py)."""
    engine = create_engine("sqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def _enable_fk(dbapi_conn, _record):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()
    engine.dispose()


class _FakeRequest:
    def __init__(self):
        self.headers = {}


def test_delete_athlete_on_relay_team_empties_slot(db_session):
    db = db_session
    db.add(TeamClub(clubsid=1, name="Club", code="CLB", pin="111111"))
    db.add(Meet(meetsid=1, name="Archived", meetstate=3))
    db.add(Member(membersid=10, firstname="Anabelle", lastname="Loyer", clubsid=1))
    db.add(Member(membersid=11, firstname="Alexa", lastname="LeGallee", clubsid=1))
    db.flush()
    db.add(MemberMeet(membersid=10, meetsid=1, clubsid=1))
    db.add(Result(resultsid=1, membersid=10, meetsid=1, totaltime=60000))
    db.add(Relay(relaysid=5, meetsid=1, clubsid=1, teamnumb=1))
    db.flush()
    db.add(RelayPos(relaysid=5, numb=1, membersid=10))
    db.add(RelayPos(relaysid=5, numb=2, membersid=11))
    db.commit()

    assert api.delete_athlete(10, _FakeRequest(), db=db) == {"deleted": True}

    assert db.get(Member, 10) is None
    assert db.get(Relay, 5) is not None
    slots = {p.numb: p.membersid for p in db.query(RelayPos).filter(RelayPos.relaysid == 5)}
    assert slots == {1: None, 2: 11}
    assert db.query(Result).filter(Result.membersid == 10).count() == 0
