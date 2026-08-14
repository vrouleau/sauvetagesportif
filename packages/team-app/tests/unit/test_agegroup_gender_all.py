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

"""Regression tests: an age group's gender must always mirror its parent event's
(never independently set — see EventsPage's simplified age-group panel). The
meet-structure LXF import (_load_from_parsed / app.events) used to never set
AgeGroup.gender at all, leaving it NULL for every uploaded meet — invisible
before ALL existed as a value, since every downstream reader fell back to the
parent event's own gender whenever ag.gender wasn't 1 or 2. That fallback was
removed once ag.gender became the single source of truth, so this import path
filling it in correctly is now load-bearing.

Uses an in-memory SQLite database — no Docker required.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, AgeGroup, SwimEvent
from app.meet_parser import MeetSession, MeetEvent, MeetAgeGroup
from app.events import _load_from_parsed


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


def _load(db_session, gender: str):
    meet = type("Meet", (), {})()
    meet.meet_name = "Test Meet"
    meet.course = "LCM"
    meet.masters = False
    meet.sessions = [MeetSession(number=1, name="Samedi", events=[
        MeetEvent(
            eventid=1, number=1, gender=gender, round="TIM", event_type="",
            swimstyleid=500, distance=100, relaycount=1, style_name="Test Style",
            agegroups=[MeetAgeGroup(agegroupid=1, agemin=19, agemax=-1)],
        ),
    ])]
    _load_from_parsed(db_session, meet)
    db_session.commit()


def test_agegroup_gender_mirrors_all_individual_event_on_import(db_session):
    _load(db_session, "ALL")
    ev = db_session.query(SwimEvent).filter_by(swimeventid=1).one()
    ag = db_session.query(AgeGroup).filter_by(agegroupid=1).one()
    assert ev.gender == 0
    assert ag.gender == 0


def test_agegroup_gender_mirrors_gendered_individual_event_on_import(db_session):
    _load(db_session, "M")
    ev = db_session.query(SwimEvent).filter_by(swimeventid=1).one()
    ag = db_session.query(AgeGroup).filter_by(agegroupid=1).one()
    assert ev.gender == 1
    assert ag.gender == 1


def test_gender_int_accepts_spec_conformant_mixed_string(db_session):
    """LENEX's real GENDER enum value is "MIXED", not the "X" our own exporter
    used to write — the parser must accept a genuine Splash-authored file too."""
    ev = MeetEvent(eventid=1, number=1, gender="MIXED", round="TIM", event_type="",
                    swimstyleid=530, distance=100, relaycount=4, style_name="Test Relay")
    assert ev.gender_int == 3
