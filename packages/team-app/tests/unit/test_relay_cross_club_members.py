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

"""Relay members listed under another club in the results file.

Regression: relay positions were resolved against the relay's own club only,
so a member listed under a different club (athlete who switched clubs, or a
composite team) was silently dropped from the archived relay. Both results
import paths now resolve positions against every athlete in the file.
"""
from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base  # noqa: E402
from app.models_team import Member, Relay, RelayPos  # noqa: E402
from app.historical_import import import_historical_meet  # noqa: E402
from app.lxf_to_team import import_lxf_as_meet  # noqa: E402

# Club AAA's relay uses Bea, who is listed under club BBB — which comes
# AFTER AAA in the file, so her member id isn't known yet when AAA is read.
_LEF = b"""<?xml version="1.0" encoding="utf-8"?>
<LENEX version="3.0"><MEETS><MEET name="Cross Club" course="LCM" city="X">
 <SESSIONS><SESSION number="1" date="2026-05-02"><EVENTS>
  <EVENT eventid="1" number="1" gender="F" round="TIM">
   <SWIMSTYLE swimstyleid="517" distance="50" relaycount="2" stroke="UNKNOWN"/></EVENT>
 </EVENTS></SESSION></SESSIONS>
 <CLUBS>
  <CLUB name="Club A" code="AAA"><ATHLETES>
   <ATHLETE athleteid="1" firstname="Ann" lastname="Aa" gender="F" birthdate="2005-01-01"/>
  </ATHLETES><RELAYS>
   <RELAY number="1" gender="F" name="Aa/Bb"><RESULTS>
    <RESULT resultid="9" eventid="1" swimtime="00:01:00.00"><RELAYPOSITIONS>
     <RELAYPOSITION athleteid="1" number="1"/>
     <RELAYPOSITION athleteid="2" number="2"/>
    </RELAYPOSITIONS></RESULT>
   </RESULTS></RELAY>
  </RELAYS></CLUB>
  <CLUB name="Club B" code="BBB"><ATHLETES>
   <ATHLETE athleteid="2" firstname="Bea" lastname="Bb" gender="F" birthdate="2005-02-02"/>
  </ATHLETES></CLUB>
 </CLUBS>
</MEET></MEETS></LENEX>"""


def _lxf() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("meet.lef", _LEF)
    return buf.getvalue()


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()
    engine.dispose()


@pytest.mark.parametrize("importer", [import_historical_meet, import_lxf_as_meet])
def test_relay_keeps_member_listed_under_another_club(db_session, importer):
    importer(db_session, _lxf(), force=True)

    relay = db_session.query(Relay).one()
    names = {
        p.numb: db_session.get(Member, p.membersid).firstname
        for p in db_session.query(RelayPos).filter(RelayPos.relaysid == relay.relaysid)
    }
    assert names == {1: "Ann", 2: "Bea"}
