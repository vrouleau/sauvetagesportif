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
"""The team-app MEETVALUES parser/serializer (meet_config) and its callers."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, MeetConfig  # noqa: E402
from app.models_team import Meet as TeamMeet  # noqa: E402
from app.meet_config import (  # noqa: E402
    parse_meetvalues, serialize_meetvalues, read_meetvalues, write_meetvalues,
    _update_meetvalue, _get_closure_date, _set_meet_config,
)
from app.invoices import _meet_fees  # noqa: E402
from app.lenex_meet_fields import parse_typed_meetvalues  # noqa: E402
from app.routers.api import get_meet_config, set_meet_config  # noqa: E402


class _NoHeaderRequest:
    headers: dict = {}


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(TeamMeet(meetsid=1, registration_open=True, meetstate=0))
    session.commit()
    yield session
    session.close()
    engine.dispose()


def _blob(db) -> str:
    cfg = db.get(MeetConfig, (1, "MEETVALUES"))
    return cfg.data if cfg else ""


# ── parse / serialize ────────────────────────────────────────────────────────

def test_parse_strips_type_or_keeps_it():
    blob = "NAME=S;Test Meet\r\nCOURSE=I;3\nPLAIN=x\r\nbroken line\r\n=S;nokey"
    assert parse_meetvalues(blob) == {"NAME": "Test Meet", "COURSE": "3", "PLAIN": "x"}
    assert parse_meetvalues(blob, keep_type=True) == {"NAME": "S;Test Meet", "COURSE": "I;3", "PLAIN": "x"}


def test_parse_keeps_everything_after_first_separators():
    assert parse_meetvalues("NOTE=S;a;b=c") == {"NOTE": "a;b=c"}


@pytest.mark.parametrize("blob", [None, "", "\r\n"])
def test_parse_empty(blob):
    assert parse_meetvalues(blob) == {}


def test_serialize_round_trip_and_drop_empty():
    raw = {"NAME": "S;X", "EMPTY": "", "DEADLINE": "D;"}
    assert serialize_meetvalues(raw) == "NAME=S;X\r\nEMPTY=\r\nDEADLINE=D;"
    assert serialize_meetvalues(raw, drop_empty=True) == "NAME=S;X\r\nDEADLINE=D;"
    assert parse_meetvalues(serialize_meetvalues(raw), keep_type=True) == raw


def test_read_write(db):
    assert read_meetvalues(db, 1) == {}
    assert read_meetvalues(db, None) == {}
    write_meetvalues(db, 1, {"CITY": "S;Gatineau"})
    assert _blob(db) == "CITY=S;Gatineau"
    assert read_meetvalues(db, 1) == {"CITY": "Gatineau"}
    write_meetvalues(db, None, {"CITY": "S;X"})  # no meet -> no-op
    assert _blob(db) == "CITY=S;Gatineau"


# ── callers keep their own rules ─────────────────────────────────────────────

def test_update_meetvalue_keeps_others_and_drops_empty(db):
    _set_meet_config(db, 1, "MEETVALUES", "NAME=S;A\r\nEMPTY=\r\nCITY=S;B")
    _update_meetvalue(db, "CITY", "S;C", meetsid=1)
    _update_meetvalue(db, "DEADLINE", "D;", meetsid=1)  # typed-but-empty is kept
    assert _blob(db) == "NAME=S;A\r\nCITY=S;C\r\nDEADLINE=D;"


def test_closure_date_falls_back_to_deadline(db):
    _set_meet_config(db, 1, "MEETVALUES", "NAME=S;A\r\nDEADLINE=D;20260410000000000")
    assert _get_closure_date(db, 1) == "2026-04-10"
    _set_meet_config(db, 1, "MEETVALUES", "DEADLINE=D;")
    assert _get_closure_date(db, 1) is None


def test_invoice_fees_read_from_meetvalues(db):
    _set_meet_config(db, 1, "MEETVALUES", "FEECLUB=F;25.00\r\nFEEPERSON=F;12.5\r\nFEERELAY=F;0\r\nNAME=S;X")
    assert _meet_fees(db, 1) == {"CLUB": 2500, "ATHLETE": 1250}


def test_typed_meetvalues_drop_valueless_lines():
    blob = "NAME=S;X\r\nDEADLINE=D;\r\nPLAIN=x\r\nCITY=S;  \r\n STATE =S;QC"
    assert parse_typed_meetvalues(blob) == {"NAME": "S;X", "STATE": "S;QC"}


def test_meet_config_endpoints_round_trip(db):
    _set_meet_config(db, 1, "MEETVALUES", "CITY=S;Gatineau\r\nLANEMIN=I;1")
    set_meet_config({"LANEMAX": {"type": "I", "value": "8"}}, request=_NoHeaderRequest(), db=db)
    assert _blob(db).startswith("CITY=S;Gatineau\r\nLANEMIN=I;1\r\nLANEMAX=I;8")
    cfg = get_meet_config(request=_NoHeaderRequest(), db=db)
    assert cfg["CITY"] == "Gatineau" and cfg["LANEMIN"] == "1" and cfg["LANEMAX"] == "8"
