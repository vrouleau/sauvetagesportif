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

"""Regression tests: session lanemin/lanemax used to be silently dropped by
the meet-app <-> team-app LENEX pipeline. Neither generate_lxf's <SESSION>
element nor parse_meet_lxf read/wrote the attribute, so a value set in one
app's EventsPage session panel never survived an entries download/upload
round trip to the other app.

Uses an in-memory SQLite database — no Docker required.
"""
from __future__ import annotations

import sys
import zipfile
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimSession, BsGlobal
from app.export import generate_lxf
from app.meet_parser import parse_meet_lxf, MeetSession
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


def _session_attrs(lxf_bytes: bytes) -> list[dict]:
    with zipfile.ZipFile(BytesIO(lxf_bytes)) as z:
        xml_bytes = z.read("meet.lef")
    root = ET.fromstring(xml_bytes)
    return [el.attrib for el in root.iter("SESSION")]


def test_generate_lxf_writes_session_lanemin_lanemax_when_set(db_session):
    db_session.add(BsGlobal(name="age_base_date", data="2026-12-31"))
    db_session.add(SwimSession(swimsessionid=1, name="Samedi", sessionnumber=1,
                                lanemin=1, lanemax=40))
    db_session.commit()

    lxf_bytes = generate_lxf(db_session)
    attrs = _session_attrs(lxf_bytes)
    assert len(attrs) == 1
    assert attrs[0]["lanemin"] == "1"
    assert attrs[0]["lanemax"] == "40"


def test_generate_lxf_omits_lanemin_lanemax_when_unset(db_session):
    db_session.add(BsGlobal(name="age_base_date", data="2026-12-31"))
    db_session.add(SwimSession(swimsessionid=1, name="Samedi", sessionnumber=1))
    db_session.commit()

    lxf_bytes = generate_lxf(db_session)
    attrs = _session_attrs(lxf_bytes)
    assert len(attrs) == 1
    assert "lanemin" not in attrs[0]
    assert "lanemax" not in attrs[0]


def test_parse_meet_lxf_reads_session_lanemin_lanemax(db_session):
    db_session.add(BsGlobal(name="age_base_date", data="2026-12-31"))
    db_session.add(SwimSession(swimsessionid=1, name="Samedi", sessionnumber=1,
                                lanemin=1, lanemax=40))
    db_session.commit()

    lxf_bytes = generate_lxf(db_session)
    meet = parse_meet_lxf(lxf_bytes)

    assert len(meet.sessions) == 1
    assert meet.sessions[0].lanemin == 1
    assert meet.sessions[0].lanemax == 40


def test_load_from_parsed_persists_session_lanemin_lanemax(db_session):
    meet = type("Meet", (), {})()
    meet.meet_name = "Test Meet"
    meet.course = "LCM"
    meet.masters = False
    meet.sessions = [MeetSession(number=1, name="Samedi", lanemin=1, lanemax=40, events=[])]

    _load_from_parsed(db_session, meet)
    db_session.commit()

    row = db_session.query(SwimSession).filter_by(sessionnumber=1).one()
    assert row.lanemin == 1
    assert row.lanemax == 40
