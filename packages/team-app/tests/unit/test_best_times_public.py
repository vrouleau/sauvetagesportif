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

"""GET /api/results/best-times must read from the live `results` table
(via best_times.get_best_times_for_member), not from the dead bsglobal
`bt_*` rows nothing in the codebase writes anymore.
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimStyle, BsGlobal
from app.models_team import Meet, Result, TeamClub, Member
from app.routers.results import best_times_public


def _create_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)(), engine


def test_aggregates_across_clubs_from_results_table():
    db, engine = _create_session()
    try:
        db.add_all([
            TeamClub(clubsid=1, name="Alpha Club", code="ALP"),
            TeamClub(clubsid=2, name="Beta Club", code="BET"),
        ])
        db.add(SwimStyle(swimstyleid=101, code="S101", name="100 Free", distance=100, stroke=1))
        db.flush()

        db.add_all([
            Member(membersid=1, firstname="Ann", lastname="Alpha", clubsid=1, gender=2),
            Member(membersid=2, firstname="Bob", lastname="Beta", clubsid=2, gender=1),
        ])
        db.add(Meet(meetsid=1, name="Old Meet", meetstate=3, course=1))
        db.flush()

        db.add_all([
            Result(resultsid=1, membersid=1, meetsid=1, stylesid=101, course=1,
                   totaltime=60000, resulttyp=0, eventdate=datetime(2026, 1, 1)),
            Result(resultsid=2, membersid=2, meetsid=1, stylesid=101, course=1,
                   totaltime=65000, resulttyp=0, eventdate=datetime(2026, 1, 1)),
        ])
        db.commit()

        data = best_times_public(db=db)

        assert data["styles"] == [{"uid": 101, "name": "100 Free"}]
        assert [c["name"] for c in data["clubs"]] == ["Alpha Club", "Beta Club"]

        alpha = data["clubs"][0]["athletes"]
        assert alpha == [{"name": "Alpha, Ann", "times": {"101_LCM": 60000}}]

        beta = data["clubs"][1]["athletes"]
        assert beta == [{"name": "Beta, Bob", "times": {"101_LCM": 65000}}]
    finally:
        db.close()
        engine.dispose()


def test_excludes_unofficial_results_and_athletes_without_a_club():
    db, engine = _create_session()
    try:
        db.add(TeamClub(clubsid=1, name="Alpha Club", code="ALP"))
        db.add(SwimStyle(swimstyleid=101, code="S101", name="100 Free", distance=100, stroke=1))
        db.flush()

        # Member 1: unofficial result only (resulttyp != 0) — must not appear
        # Member 2: no club — must not appear even though the result is valid
        db.add_all([
            Member(membersid=1, firstname="Unofficial", lastname="Only", clubsid=1, gender=2),
            Member(membersid=2, firstname="No", lastname="Club", clubsid=None, gender=1),
        ])
        db.add(Meet(meetsid=1, name="Meet", meetstate=3, course=1))
        db.flush()

        db.add_all([
            Result(resultsid=1, membersid=1, meetsid=1, stylesid=101, course=1,
                   totaltime=60000, resulttyp=3, eventdate=datetime(2026, 1, 1)),
            Result(resultsid=2, membersid=2, meetsid=1, stylesid=101, course=1,
                   totaltime=60000, resulttyp=0, eventdate=datetime(2026, 1, 1)),
        ])
        db.commit()

        data = best_times_public(db=db)

        assert data["clubs"] == []
    finally:
        db.close()
        engine.dispose()


def test_returns_configured_meet_course():
    db, engine = _create_session()
    try:
        db.add(BsGlobal(name="meet_course", data="SCM"))
        db.commit()

        data = best_times_public(db=db)

        assert data["course"] == "SCM"
        assert data["clubs"] == []
        assert data["styles"] == []
    finally:
        db.close()
        engine.dispose()
