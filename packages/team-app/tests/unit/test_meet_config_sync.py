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

"""set_meet_config's AGEDATE -> age_base_date sync (routers/api.py).

Before this fix, editing the "Date for age calculation" field in the shared
EventsPage.tsx meet-config panel only touched the MEETVALUES blob — the
actual age-group suggestion logic (age_group_rules.resolve_matching_age)
reads age_base_date, a separate bsglobal key that never got updated. Same
bug class as the DEADLINE -> closure_date sync a few lines above it, which
already worked correctly; AGEDATE was just missing the equivalent case.
Uses an in-memory SQLite database — no Docker required.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base  # noqa: E402
from app.models_team import Meet as TeamMeet  # noqa: E402
from app.routers.api import set_meet_config  # noqa: E402


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()
    session.add(TeamMeet(meetsid=1, registration_open=True, meetstate=0))
    session.commit()
    yield session
    session.close()
    engine.dispose()


def _get_bsglobal(db_session, key: str) -> str | None:
    from app.models import BsGlobal
    cfg = db_session.get(BsGlobal, key)
    return cfg.data if cfg else None


def _get_meetvalues(db_session) -> str:
    # MEETVALUES is meet-scoped (MeetConfig table, keyed by meetsid), unlike
    # age_base_date which is an app-level BsGlobal key — see _set_meet_config
    # vs _set_config in meet_config.py.
    from app.models import MeetConfig
    cfg = db_session.get(MeetConfig, (1, "MEETVALUES"))
    return cfg.data if cfg else ""


def test_agedate_syncs_to_age_base_date(db_session):
    set_meet_config({"AGEDATE": {"type": "D", "value": "20260901000000000"}}, db=db_session)
    assert _get_bsglobal(db_session, "age_base_date") == "2026-09-01"


def test_agedate_still_written_to_meetvalues_blob(db_session):
    # The MEETVALUES sync (Splash/LENEX interop) must keep working alongside
    # the new age_base_date sync, not be replaced by it.
    set_meet_config({"AGEDATE": {"type": "D", "value": "20260901000000000"}}, db=db_session)
    assert "AGEDATE=D;20260901000000000" in _get_meetvalues(db_session)


def test_clearing_agedate_clears_age_base_date(db_session):
    set_meet_config({"AGEDATE": {"type": "D", "value": "20260901000000000"}}, db=db_session)
    set_meet_config({"AGEDATE": {"type": "D", "value": ""}}, db=db_session)
    assert _get_bsglobal(db_session, "age_base_date") == ""


def test_other_fields_unaffected(db_session):
    set_meet_config({"NAME": {"type": "S", "value": "Championnat"}}, db=db_session)
    assert _get_bsglobal(db_session, "age_base_date") is None
