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

"""Both historical-results importers (lxf_to_team = Organizer/Admin "Import
results" that closes the meet, historical_import = Admin "Import historical"):

- every archived individual result carries its event number — the results
  import used to leave results.eventnumb NULL, so a historical meet's results
  page lumped all events into one "event 0" group;
- beach results are refused (positions, never best times — a beach meet is
  closed without results).
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
from app.models_team import Meet, Result  # noqa: E402
from app.historical_import import import_historical_meet  # noqa: E402
from app.lxf_to_team import (  # noqa: E402
    import_lxf_as_meet, is_beach_results, BeachResultsNotArchived, _read_lef_xml,
)

IMPORTERS = [
    pytest.param(lambda db, c: import_lxf_as_meet(db, c, force=True), id="results-import"),
    pytest.param(lambda db, c: import_historical_meet(db, c, force=True), id="historical-import"),
]


def _lxf(style_f: int = 503, style_m: int = 503, number_offset: int = 0) -> bytes:
    """Two events sharing a style (F then M, like a real pool meet), one
    athlete of each gender with a result in their own event."""
    n1, n2 = 1 + number_offset, 2 + number_offset
    lef = f"""<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0"><MEETS><MEET name="Eventnumb Meet" city="Laval" course="LCM">
<SESSIONS><SESSION number="1" date="2026-11-28"><EVENTS>
  <EVENT eventid="11" number="{n1}" gender="F"><SWIMSTYLE swimstyleid="{style_f}" distance="200" relaycount="1" name="S" /></EVENT>
  <EVENT eventid="12" number="{n2}" gender="M"><SWIMSTYLE swimstyleid="{style_m}" distance="200" relaycount="1" name="S" /></EVENT>
</EVENTS></SESSION></SESSIONS>
<CLUBS><CLUB clubid="1" code="TST" name="Test Club"><ATHLETES>
  <ATHLETE athleteid="1" firstname="Ana" lastname="Roy" birthdate="2010-01-01" gender="F">
    <RESULTS><RESULT resultid="1" eventid="11" swimtime="00:03:07.00" /></RESULTS></ATHLETE>
  <ATHLETE athleteid="2" firstname="Ben" lastname="Roy" birthdate="2010-01-01" gender="M">
    <RESULTS><RESULT resultid="2" eventid="12" swimtime="00:02:08.00" /></RESULTS></ATHLETE>
</ATHLETES></CLUB></CLUBS>
</MEET></MEETS></LENEX>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("results.lef", lef.encode("utf-8"))
    return buf.getvalue()


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()
    engine.dispose()


@pytest.mark.parametrize("do_import", IMPORTERS)
def test_results_carry_event_number(db, do_import):
    do_import(db, _lxf(number_offset=4))  # numbers 5 and 6, not just 1/2
    by_time = {r.totaltime: r.eventnumb for r in db.query(Result).all()}
    assert by_time == {187000: 5, 128000: 6}


@pytest.mark.parametrize("do_import", IMPORTERS)
def test_beach_results_are_refused(db, do_import):
    with pytest.raises(BeachResultsNotArchived):
        do_import(db, _lxf(style_f=601, style_m=601))
    assert db.query(Meet).count() == 0
    assert db.query(Result).count() == 0


def test_is_beach_results():
    assert not is_beach_results(_read_lef_xml(_lxf()))
    assert is_beach_results(_read_lef_xml(_lxf(style_f=601, style_m=601)))
    # A single beach style anywhere is enough (mixed files are beach-tainted).
    assert is_beach_results(_read_lef_xml(_lxf(style_m=624)))
