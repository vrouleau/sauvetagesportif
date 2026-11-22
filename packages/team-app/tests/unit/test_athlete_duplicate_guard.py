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

"""Add-athlete duplicate guard: POST /api/athletes answers 409 possible_duplicate
when a similar athlete exists in any club, and move-club answers it."""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base  # noqa: E402
from app.models_team import Member, TeamClub  # noqa: E402
from app.athlete_dupes import find_similar_members  # noqa: E402
from app.routers import api  # noqa: E402


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    s = sessionmaker(bind=engine)()
    s.add(TeamClub(clubsid=1, name="CSRN", code="CSRN", pin="111111"))
    s.add(TeamClub(clubsid=2, name="Other", code="OTH", pin="222222"))
    s.add(Member(membersid=10, firstname="Sandra", lastname="Laurendeau", clubsid=2,
                 birthdate=date(2008, 5, 4), license="QC123456"))
    s.commit()
    yield s
    s.close()
    engine.dispose()


class _Req:
    def __init__(self, pin):
        self.headers = {"X-Club-Pin": pin}


def _create(db, **kw):
    body = dict(first_name="Sandra", last_name="Laurendeau", gender="F",
                birthdate="2008-05-04", license="", club_id=1)
    body.update(kw)
    return api.create_athlete(api.AthleteCreate(**body), _Req("111111"), db=db)


def test_typo_and_accents_match_with_birthdate(db):
    m = find_similar_members(db, "sandra", "Laurendau", date(2008, 5, 4), "")
    assert [x["id"] for x in m] == [10] and m[0]["club"] == "Other"
    assert find_similar_members(db, "Sándra", "LAURENDEAU", None, "")


def test_swapped_names_match(db):
    assert find_similar_members(db, "Laurendeau", "Sandra", date(2008, 5, 4), "")


def test_license_matches_even_if_name_differs(db):
    m = find_similar_members(db, "Sandy", "Smith", None, "qc 123456")
    assert m and m[0]["reason"] == "license"


def test_different_person_not_flagged(db):
    assert not find_similar_members(db, "Marc", "Tremblay", date(2008, 5, 4), "")
    # similar-ish name but clearly different birthdate: not flagged
    assert not find_similar_members(db, "Sandra", "Laurent", date(1990, 1, 1), "")


def test_create_blocked_then_forced(db):
    with pytest.raises(HTTPException) as e:
        _create(db)
    assert e.value.status_code == 409 and e.value.detail["code"] == "possible_duplicate"
    assert e.value.detail["matches"][0]["id"] == 10
    assert db.query(Member).count() == 1
    _create(db, force=True)
    assert db.query(Member).count() == 2


def test_coach_moves_athlete_into_own_club(db):
    out = api.move_athlete_club(10, _Req("111111"), body={}, db=db)
    assert out == {"ok": True, "moved": True}
    assert db.get(Member, 10).clubsid == 1
