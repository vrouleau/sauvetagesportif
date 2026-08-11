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

"""Regression tests for relay team export (generate_lxf in export.py).

Bug: when a swimstyle is shared by several events that differ only by
gender/age (e.g. an M and an F relay event of the same distance/stroke),
the exported <RELAY><ENTRIES><ENTRY eventid="..."> used to always pick the
first event of that style found while walking session order — regardless
of which event the team was actually registered for. In practice, every
relay team of a given style collapsed onto a single event once imported
into meet-app.

Uses an in-memory SQLite database — no Docker required.
"""
from __future__ import annotations

import sys
import zipfile
from datetime import datetime
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimEvent, SwimSession, SwimStyle, BsGlobal, GENDER_M, GENDER_F, GENDER_MIXED
from app.models_team import TeamClub, Member, Relay, RelayPos, Meet
from app.export import generate_lxf


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


def _seed_ambiguous_style_meet(db_session):
    """Two relay events sharing one swimstyleid, differing only by gender."""
    db_session.add(BsGlobal(name="age_base_date", data="2026-12-31"))

    db_session.add(Meet(meetsid=1, name="Test Meet", registration_open=True))

    club = TeamClub(clubsid=1, name="Test Club", code="TST", nation="CAN", pin="111111")
    db_session.add(club)

    style = SwimStyle(swimstyleid=301, distance=100, stroke=6, relaycount=2,
                       name="2x50 Relais Libre", code="2x50FR")
    db_session.add(style)

    session = SwimSession(swimsessionid=1, meetsid=1, name="Session 1", sessionnumber=1)
    db_session.add(session)

    # Same style, same session — only gender/eventnumber differ, exactly the
    # real-world shape that used to collapse onto a single exported event.
    event_m = SwimEvent(swimeventid=100, meetsid=1, swimsessionid=1, swimstyleid=301,
                         gender=GENDER_M, round=5, eventnumber=10)
    event_f = SwimEvent(swimeventid=101, meetsid=1, swimsessionid=1, swimstyleid=301,
                         gender=GENDER_F, round=5, eventnumber=11)
    db_session.add_all([event_m, event_f])

    athlete1 = Member(membersid=1, firstname="Alice", lastname="Aubert", gender=GENDER_F,
                       birthdate=datetime(2005, 3, 15), clubsid=1)
    athlete2 = Member(membersid=2, firstname="Bea", lastname="Bernier", gender=GENDER_F,
                       birthdate=datetime(2005, 7, 20), clubsid=1)
    db_session.add_all([athlete1, athlete2])

    db_session.commit()
    return club, event_m, event_f


def _relay_entry_eventids(lxf_bytes: bytes) -> list[tuple[str, str | None]]:
    """Return [(relay name/number, entry eventid)] for every RELAY in the export."""
    with zipfile.ZipFile(BytesIO(lxf_bytes)) as z:
        xml_bytes = z.read("meet.lef")
    root = ET.fromstring(xml_bytes)
    out = []
    for relay in root.iter("RELAY"):
        entry = relay.find("./ENTRIES/ENTRY")
        label = relay.get("name") or relay.get("number")
        out.append((label, entry.get("eventid") if entry is not None else None))
    return out


class TestRelayExportEventMatching:
    def test_relay_exports_its_own_event_not_the_first_same_style_event(self, db_session):
        """The F team registered under the F event must export that event's id,
        not the M event's id just because it comes first in session order."""
        club, event_m, event_f = _seed_ambiguous_style_meet(db_session)

        relay = Relay(relaysid=1, meetsid=1, clubsid=club.clubsid, stylesid=301, teamnumb=1,
                       eventnumb=event_f.eventnumber, gender=GENDER_F, minage=0, maxage=0)
        db_session.add(relay)
        db_session.add_all([
            RelayPos(relaysid=1, numb=1, membersid=1),
            RelayPos(relaysid=1, numb=2, membersid=2),
        ])
        db_session.commit()

        lxf_bytes = generate_lxf(db_session)
        entries = _relay_entry_eventids(lxf_bytes)

        assert len(entries) == 1
        _, eventid = entries[0]
        assert eventid == str(event_f.swimeventid)
        assert eventid != str(event_m.swimeventid)

    def test_multiple_relays_same_style_each_get_their_own_event(self, db_session):
        """Two teams of the same style but different eventnumb (M vs F) must
        resolve to their own distinct swimeventid, not both collapse onto one."""
        club, event_m, event_f = _seed_ambiguous_style_meet(db_session)

        relay_m = Relay(relaysid=1, meetsid=1, clubsid=club.clubsid, stylesid=301, teamnumb=1,
                         eventnumb=event_m.eventnumber, gender=GENDER_M, minage=0, maxage=0)
        relay_f = Relay(relaysid=2, meetsid=1, clubsid=club.clubsid, stylesid=301, teamnumb=1,
                         eventnumb=event_f.eventnumber, gender=GENDER_F, minage=0, maxage=0)
        db_session.add_all([relay_m, relay_f])
        db_session.add_all([
            RelayPos(relaysid=1, numb=1, membersid=1),
            RelayPos(relaysid=1, numb=2, membersid=2),
            RelayPos(relaysid=2, numb=1, membersid=1),
            RelayPos(relaysid=2, numb=2, membersid=2),
        ])
        db_session.commit()

        lxf_bytes = generate_lxf(db_session)
        eventids = {eid for _, eid in _relay_entry_eventids(lxf_bytes)}

        assert eventids == {str(event_m.swimeventid), str(event_f.swimeventid)}

    def test_mixed_gender_relay_exports_gender_x_not_f(self, db_session):
        """relay.gender=GENDER_MIXED must round-trip as "X", not silently become "F"."""
        club, event_m, event_f = _seed_ambiguous_style_meet(db_session)

        relay = Relay(relaysid=1, meetsid=1, clubsid=club.clubsid, stylesid=301, teamnumb=1,
                       eventnumb=event_f.eventnumber, gender=GENDER_MIXED, minage=0, maxage=0)
        db_session.add(relay)
        db_session.add_all([
            RelayPos(relaysid=1, numb=1, membersid=1),
            RelayPos(relaysid=1, numb=2, membersid=2),
        ])
        db_session.commit()

        lxf_bytes = generate_lxf(db_session)
        with zipfile.ZipFile(BytesIO(lxf_bytes)) as z:
            xml_bytes = z.read("meet.lef")
        root = ET.fromstring(xml_bytes)
        relay_elem = next(root.iter("RELAY"))
        assert relay_elem.get("gender") == "X"
