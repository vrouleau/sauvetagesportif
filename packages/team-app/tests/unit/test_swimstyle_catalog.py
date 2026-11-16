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

"""Swimstyle catalog correction: historical imports created styles with no
distance and relaycount=1 (even relays), and meet uploads were insert-only.
Meet uploads now correct existing styles, and migration 0007 applies the
bundled templates once (an open meet can't be re-uploaded)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimStyle
from app import models_team, models_live, models_serc  # noqa: F401 — register all tables
from app.events import load_events

POOL_TEMPLATE = Path(__file__).resolve().parent.parent.parent.parent.parent / "config" / "template_pool.lxf"


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()
    engine.dispose()


def _shape(db, sid):
    st = db.get(SwimStyle, sid)
    return st.distance, st.relaycount


def test_meet_upload_fixes_half_empty_styles_and_never_demotes_relays(db):
    # As left by a historical import: no distance, relaycount hard-coded to 1.
    db.add_all([
        SwimStyle(swimstyleid=521, name="4 m Lancer", distance=None, relaycount=1),
        SwimStyle(swimstyleid=523, name="10 m Lancer de la corde", distance=None, relaycount=1),
        SwimStyle(swimstyleid=527, name="4x50 Relais", distance=None, relaycount=4),
    ])
    db.commit()

    load_events(db, POOL_TEMPLATE)
    db.commit()

    assert _shape(db, 521) == (4, 1)
    assert _shape(db, 523) == (10, 2)   # line throw: team of 2
    assert _shape(db, 527) == (50, 4)


def test_migration_0007_corrects_existing_styles_from_the_templates(db):
    from app.migrations.versions import m0007_swimstyle_shape_from_templates as m0007
    db.add_all([
        SwimStyle(swimstyleid=521, name="4 m Lancer", distance=None, relaycount=1),
        SwimStyle(swimstyleid=524, name="12.5m Lancer de la corde", distance=None, relaycount=1),
        SwimStyle(swimstyleid=527, name="4x50 Relais", distance=None, relaycount=1),
    ])
    db.commit()
    before = {sid for (sid,) in db.query(SwimStyle.swimstyleid).all()}

    m0007.upgrade(db.get_bind())
    db.expire_all()

    assert _shape(db, 521) == (4, 1)
    assert _shape(db, 524) == (12, 2)
    assert _shape(db, 527) == (50, 4)
    assert {sid for (sid,) in db.query(SwimStyle.swimstyleid).all()} == before, "must not add styles"
    assert db.get(SwimStyle, 521).name == "4 m Lancer", "names are never touched"


def test_migration_0007_is_a_no_op_on_a_fresh_install(db):
    from app.migrations.versions import m0007_swimstyle_shape_from_templates as m0007
    m0007.upgrade(db.get_bind())
    assert db.query(SwimStyle).count() == 0
