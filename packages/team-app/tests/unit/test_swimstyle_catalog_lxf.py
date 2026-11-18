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

"""The LXF exports carry the whole swimstyle catalog of the current meet type
in a hidden ``.swimstyles`` dotfile — LENEX only has a SWIMSTYLE inside an
EVENT, so styles no event used never reached meet-app, and a last-minute
event there couldn't pick them.

Uses an in-memory SQLite database — no Docker required.
"""
from __future__ import annotations

import json
import sys
import zipfile
from io import BytesIO
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, BsGlobal, SwimStyle
from app.export import generate_lxf, generate_meet_lxf_from_db


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(BsGlobal(name="age_base_date", data="2026-12-31"))
    session.add_all([
        SwimStyle(swimstyleid=504, distance=50, relaycount=1, name="50m Portage du mannequin plein"),
        SwimStyle(swimstyleid=528, distance=50, relaycount=4, name="4x50m Relais obstacles"),
        SwimStyle(swimstyleid=601, distance=90, relaycount=1, name="Sprint plage"),
    ])
    session.commit()
    yield session
    session.close()
    engine.dispose()


def _catalog(lxf_bytes: bytes) -> list[dict]:
    with zipfile.ZipFile(BytesIO(lxf_bytes)) as z:
        return json.loads(z.read(".swimstyles"))


@pytest.mark.parametrize("generate", [generate_lxf, generate_meet_lxf_from_db])
def test_lxf_carries_every_pool_style_even_unused(db_session, generate):
    styles = _catalog(generate(db_session))
    assert {s["swimstyleid"] for s in styles} == {504, 528}
    relay = next(s for s in styles if s["swimstyleid"] == 528)
    assert relay == {"swimstyleid": 528, "distance": 50, "relaycount": 4,
                     "name": "4x50m Relais obstacles"}


def test_lxf_catalog_follows_meet_type(db_session):
    db_session.add(BsGlobal(name="meet_type", data="BEACH"))
    db_session.commit()
    styles = _catalog(generate_lxf(db_session))
    assert [s["swimstyleid"] for s in styles] == [601]
