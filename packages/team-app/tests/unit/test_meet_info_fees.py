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

"""Meet-info must expose fees configured in Splash-compatible MEETVALUES."""
from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base  # noqa: E402
from app.models_team import Meet as TeamMeet  # noqa: E402
from app.meet_config import _set_meet_config  # noqa: E402
from app.routers.api import meet_info  # noqa: E402


class _NoHeaderRequest:
    headers: dict = {}


def test_meet_info_returns_meetvalues_per_athlete_fee():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    try:
        session.add(TeamMeet(meetsid=1, registration_open=True, meetstate=0))
        _set_meet_config(session, 1, "MEETVALUES", "FEEPERSON=F;50.00")
        session.commit()

        info = meet_info(request=_NoHeaderRequest(), db=session)

        assert info["meet_fees"]["ATHLETE"] == 5000
    finally:
        session.close()
        engine.dispose()
