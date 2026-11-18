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

"""import_lxf_as_meet member matching for athletes without a license.

Regression: members were merged by license only, so every results import
created a new member for each athlete with no license — re-importing a meet
duplicated them. They are now matched by exact name within the club.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.lxf_to_team import import_lxf_as_meet  # noqa: E402
from app.models_team import Member, TeamClub  # noqa: E402

from .test_historical_meet_date_city import _build_lxf, db_session  # noqa: E402,F401


def test_reimport_does_not_duplicate_unlicensed_athlete(db_session):
    lxf = _build_lxf(name="CQS", session_dates=["2026-08-15"])  # Jean Tremblay, no license
    import_lxf_as_meet(db_session, lxf, force=True)
    import_lxf_as_meet(db_session, lxf, force=True)
    members = db_session.query(Member).filter(Member.lastname == "Tremblay").all()
    assert len(members) == 1


def test_unlicensed_athlete_matches_existing_member_in_same_club_only(db_session):
    db_session.add(TeamClub(clubsid=1, name="Test Club", code="TST", pin="111111"))
    db_session.add(TeamClub(clubsid=2, name="Other Club", code="OTH", pin="222222"))
    db_session.add(Member(membersid=50, firstname="Jean", lastname="Tremblay", clubsid=2))
    db_session.add(Member(membersid=60, firstname="Jean", lastname="Tremblay", clubsid=1))
    db_session.commit()

    import_lxf_as_meet(db_session, _build_lxf(session_dates=["2026-08-15"]), force=True)

    ids = sorted(m.membersid for m in db_session.query(Member).filter(Member.lastname == "Tremblay"))
    assert ids == [50, 60]  # matched 60 (club TST), didn't touch 50, created none


def _lxf_with_birthdate(birthdate: str) -> bytes:
    """_build_lxf's athlete (Jean Tremblay, club TST) with a birthdate."""
    import io
    import zipfile
    src = zipfile.ZipFile(io.BytesIO(_build_lxf(session_dates=["2026-08-15"])))
    xml = src.read("meet.lef").replace(
        b'firstname="Jean"', f'firstname="Jean" birthdate="{birthdate}"'.encode())
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("meet.lef", xml)
    return buf.getvalue()


def test_unlicensed_athlete_who_changed_club_matches_by_birthdate(db_session):
    from datetime import datetime
    db_session.add(TeamClub(clubsid=2, name="Other Club", code="OTH", pin="222222"))
    db_session.add(Member(membersid=50, firstname="Jean", lastname="Tremblay", clubsid=2,
                          birthdate=datetime(2005, 3, 4)))
    db_session.commit()

    import_lxf_as_meet(db_session, _lxf_with_birthdate("2005-03-04"), force=True)

    ids = [m.membersid for m in db_session.query(Member).filter(Member.lastname == "Tremblay")]
    assert ids == [50]


def test_same_name_same_club_different_birthdate_is_a_different_athlete(db_session):
    from datetime import datetime
    db_session.add(TeamClub(clubsid=1, name="Test Club", code="TST", pin="111111"))
    db_session.add(Member(membersid=60, firstname="Jean", lastname="Tremblay", clubsid=1,
                          birthdate=datetime(1975, 1, 1)))
    db_session.commit()

    import_lxf_as_meet(db_session, _lxf_with_birthdate("2005-03-04"), force=True)

    assert db_session.query(Member).filter(Member.lastname == "Tremblay").count() == 2
