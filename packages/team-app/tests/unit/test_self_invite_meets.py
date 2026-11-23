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

"""GET /api/self-invite/meets — the login screen's list of active meets and
their registration status (so a passed deadline is explained, not just a
vanished "Demander une invitation" link)."""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimSession  # noqa: E402
from app.models_team import Meet as TeamMeet  # noqa: E402
from app.meet_config import _set_meet_config  # noqa: E402
from app.routers.api import self_invite_meets  # noqa: E402


def _db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    return engine, sessionmaker(bind=engine)()


def test_lists_active_meets_with_status_fields_and_skips_archived_and_empty():
    engine, db = _db()
    try:
        db.add_all([
            TeamMeet(meetsid=1, name="Provinciaux", place="Laval", meetstate=0,
                     registration_open=True, mindate=datetime(2026, 12, 5)),
            TeamMeet(meetsid=2, name="Archivé 2025", meetstate=3, registration_open=False),
            TeamMeet(meetsid=3, name="Régional", meetstate=0, registration_open=False),
            TeamMeet(meetsid=4, name=None, meetstate=0, registration_open=False),  # post-reset stub
        ])
        _set_meet_config(db, 1, "closure_date", "2026-11-20")
        db.commit()

        meets = self_invite_meets(db=db)
        by_id = {m["meet_id"]: m for m in meets}

        assert set(by_id) == {1, 3}
        assert by_id[1]["name"] == "Provinciaux"
        assert by_id[1]["place"] == "Laval"
        assert by_id[1]["start_date"] == "2026-12-05"
        assert by_id[1]["registration_open"] is True
        assert by_id[1]["closure_date"] == "2026-11-20"
        assert by_id[3]["registration_open"] is False
        assert by_id[3]["closure_date"] is None
        # Nothing private leaks to this public endpoint.
        assert all(set(m) == {"meet_id", "name", "place", "start_date", "meet_type",
                              "registration_open", "closure_date"} for m in meets)
    finally:
        db.close()
        engine.dispose()


def test_start_date_falls_back_to_first_session_and_name_to_meet_config():
    engine, db = _db()
    try:
        db.add(TeamMeet(meetsid=1, name=None, meetstate=0, registration_open=True))
        db.add(SwimSession(meetsid=1, startdate=datetime(2027, 2, 14)))
        _set_meet_config(db, 1, "meet_name", "Invitation hivernale")
        db.commit()

        [m] = self_invite_meets(db=db)
        assert m["name"] == "Invitation hivernale"
        assert m["start_date"] == "2027-02-14"
    finally:
        db.close()
        engine.dispose()
