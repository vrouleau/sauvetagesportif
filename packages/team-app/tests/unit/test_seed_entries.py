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

"""Tests: seed_from_lxf must not crash when an entry references an
agegroupid that doesn't exist in the local meet structure.

Reproduces a prod/local-dev scenario: importing an entries .lxf exported
from one meet (or a stale copy) into a database whose current meet structure
doesn't have matching agegroup rows. The event id is still validated and
matched, but the agegroup id was previously written straight onto the new
SwimResult row unchecked, violating the FK and crashing with a 500.
"""
from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimEvent, AgeGroup, SwimResult, SwimStyle
from app.models_team import TeamClub, Member
from app.seed import seed_from_lxf


def _make_db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _lxf(*, eventid: int, agegroupid: int | None) -> bytes:
    lenex = ET.Element("LENEX", version="3.0")
    meets_el = ET.SubElement(lenex, "MEETS")
    meet_el = ET.SubElement(meets_el, "MEET", name="TestMeet", course="LCM")
    clubs_el = ET.SubElement(meet_el, "CLUBS")
    club_el = ET.SubElement(clubs_el, "CLUB", name="Test Club", code="TST", nation="CAN")
    athletes_el = ET.SubElement(club_el, "ATHLETES")
    ath_el = ET.SubElement(athletes_el, "ATHLETE", firstname="Jane", lastname="Doe",
                            gender="F", license="")
    entries_el = ET.SubElement(ath_el, "ENTRIES")
    entry_attrs = {"eventid": str(eventid), "entrytime": "00:30.00"}
    if agegroupid is not None:
        entry_attrs["agegroupid"] = str(agegroupid)
    ET.SubElement(entries_el, "ENTRY", **entry_attrs)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("meet.lef", ET.tostring(lenex, encoding="unicode"))
    return buf.getvalue()


def _add_event(db, eventid: int, *, masters: str = "F") -> None:
    db.add(SwimStyle(swimstyleid=501, name="50m Freestyle", distance=50, relaycount=1))
    db.add(SwimEvent(swimeventid=eventid, swimstyleid=501, gender=2, masters=masters))
    db.commit()


def test_entry_with_unknown_agegroup_does_not_crash():
    db = _make_db()
    _add_event(db, eventid=1075)
    # Deliberately no AgeGroup row for id 1076 — simulates a stale/mismatched
    # local meet structure relative to the imported entries file.
    lxf = _lxf(eventid=1075, agegroupid=1076)

    result = seed_from_lxf(db, lxf)

    assert result["entries_added"] == 1
    sr = db.query(SwimResult).one()
    assert sr.swimeventid == 1075
    assert sr.agegroupid is None
    assert sr.age_code == "Open"


def test_entry_with_known_agegroup_still_resolves_age_code():
    db = _make_db()
    _add_event(db, eventid=1075)
    db.add(AgeGroup(agegroupid=1076, agemin=11, agemax=12))
    db.commit()
    lxf = _lxf(eventid=1075, agegroupid=1076)

    result = seed_from_lxf(db, lxf)

    assert result["entries_added"] == 1
    sr = db.query(SwimResult).one()
    assert sr.agegroupid == 1076
    assert sr.age_code == "11-12"


def test_entry_with_unknown_event_is_skipped_not_crashed():
    db = _make_db()
    # No SwimEvent at all for id 9999 — must be silently skipped.
    lxf = _lxf(eventid=9999, agegroupid=None)

    result = seed_from_lxf(db, lxf)

    assert result["entries_added"] == 0
    assert db.query(SwimResult).count() == 0
