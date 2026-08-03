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

"""Regression tests: BSGLOBAL points config used to be written under a key
("POINTSCORES", plural) and schema that Splash never actually reads. Real
Splash's own key is "POINTSCORE" (singular), with a single <POINTSCORE>
element carrying ~20 attributes plus nested <AGEGROUPS>/<PLACEPOINTS> —
verified against 4 real Splash-native .mdb files. Splash's own
points-standings report showed no configured scale at all as a result,
in both a restored .smb and (since regenerate_point_scores runs against
whatever backend is active) a live-shared Postgres database.

Uses an in-memory SQLite database — no Docker required.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, BsGlobal
from app.models_team import Member  # noqa: F401 — needed for FK resolution in create_all
from app.point_scores import regenerate_point_scores


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


def test_writes_singular_pointscore_key_not_plural(db_session):
    regenerate_point_scores(db_session)
    db_session.commit()

    assert db_session.query(BsGlobal).filter_by(name="POINTSCORE").first() is not None
    assert db_session.query(BsGlobal).filter_by(name="POINTSCORES").first() is None


def test_xml_matches_splash_native_schema(db_session):
    regenerate_point_scores(db_session)
    db_session.commit()

    xml = db_session.query(BsGlobal).filter_by(name="POINTSCORE").first().data
    # Single <POINTSCORE> wrapper with the real Splash attribute set (not our old
    # simplified "points=1,2,3" comma-list on multiple named definitions).
    assert '<POINTSCORE pointscoreid=' in xml
    assert 'pointsmaxtimonly="T"' in xml
    assert '<AGEGROUPS>' in xml
    assert '<AGEGROUP from="-1" to="-1" />' in xml
    assert '<PLACEPOINTS>' in xml
    assert '<PLACEPOINT position="1" individual="20" relay="20" />' in xml


def test_cleans_up_stale_plural_key_from_earlier_version(db_session):
    db_session.add(BsGlobal(name="POINTSCORES", data="<stale/>"))
    db_session.commit()

    regenerate_point_scores(db_session)
    db_session.commit()

    assert db_session.query(BsGlobal).filter_by(name="POINTSCORES").first() is None
    assert db_session.query(BsGlobal).filter_by(name="POINTSCORE").first() is not None
