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

"""The one results importer (lxf_to_team.archive_results_lxf) behind both
entry points: Organizer "Import results" (import_lxf_as_meet, replaces an
archived copy silently) and Admin "Import historical" (import_historical_meet,
asks first). Rules both used to apply differently, now shared.
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
from app.models_team import Meet, Result, Event, Session as MeetSession, TeamClub  # noqa: E402
from app.historical_import import import_historical_meet  # noqa: E402
from app.lxf_to_team import import_lxf_as_meet, _lenex_time_to_ms  # noqa: E402

IMPORTERS = [
    pytest.param(lambda db, c: import_lxf_as_meet(db, c, force=True), id="results-import"),
    pytest.param(lambda db, c: import_historical_meet(db, c, force=True), id="historical-import"),
]


def _lxf(*, name="Invitation Laval", date="2026-02-15", results=None, club_code="TST") -> bytes:
    results = results if results is not None else '<RESULT resultid="1" eventid="1" swimtime="00:01:02.34" />'
    code_attr = f' code="{club_code}"' if club_code else ""
    lef = f"""<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0"><MEETS><MEET name="{name}" city="Laval" course="LCM">
<SESSIONS><SESSION number="1" date="{date}" name="Samedi"><EVENTS>
  <EVENT eventid="1" number="3" gender="M"><SWIMSTYLE swimstyleid="503" distance="200" relaycount="1" name="S" /></EVENT>
</EVENTS></SESSION></SESSIONS>
<CLUBS><CLUB name="Test Club"{code_attr}><ATHLETES>
  <ATHLETE athleteid="1" firstname="Jean" lastname="Tremblay" birthdate="2005-03-04" gender="M">
    <RESULTS>{results}</RESULTS></ATHLETE>
</ATHLETES></CLUB></CLUBS>
</MEET></MEETS></LENEX>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("meet.lef", lef.encode("utf-8"))
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
def test_same_name_held_another_year_is_a_separate_meet(db, do_import):
    """Regression (Organizer path): an archived meet was matched by name
    only, so next year's meet of the same name overwrote last year's."""
    do_import(db, _lxf(date="2025-02-15"))
    do_import(db, _lxf(date="2026-02-15"))
    years = sorted(m.mindate.year for m in db.query(Meet).all())
    assert years == [2025, 2026]
    assert db.query(Result).count() == 2


def test_results_import_replaces_an_archived_copy_silently(db):
    first = import_lxf_as_meet(db, _lxf(), force=True)
    again = import_lxf_as_meet(db, _lxf(results='<RESULT eventid="1" swimtime="00:01:01.00" />'))
    assert again["meet_id"] == first["meet_id"] and again["reimported"] is True
    assert [r.totaltime for r in db.query(Result).all()] == [61000]


def test_historical_import_asks_before_replacing(db):
    first = import_historical_meet(db, _lxf(), force=True)
    ask = import_historical_meet(db, _lxf(), force=False)
    assert ask["needs_force"] and ask["meet_id"] == first["meet_id"]
    assert db.query(Result).count() == 1  # nothing written


@pytest.mark.parametrize("do_import", IMPORTERS)
def test_same_response_shape_from_both_entry_points(db, do_import):
    out = do_import(db, _lxf())
    assert out == {
        "meet_id": out["meet_id"], "meet_name": "Invitation Laval", "meet_date": "2026-02-15",
        "course": "LCM", "reimported": False,
        "sessions_created": 1, "events_created": 1,
        "clubs_matched": 1, "clubs_created": 1,
        "athletes_matched": 1, "athletes_created": 1,
        "results_imported": 1, "relays_imported": 0,
    }


@pytest.mark.parametrize("do_import", IMPORTERS)
def test_sessions_and_event_session_numbers_are_archived(db, do_import):
    """The admin import used to drop sessions."""
    out = do_import(db, _lxf())
    sess = db.query(MeetSession).filter(MeetSession.meetsid == out["meet_id"]).one()
    assert (sess.numb, sess.name) == (1, "Samedi")
    ev = db.query(Event).filter(Event.meetsid == out["meet_id"]).one()
    assert (ev.numb, ev.sessionnumb, ev.stylesid, ev.gender) == (3, 1, 503, 1)


@pytest.mark.parametrize("do_import", IMPORTERS)
def test_results_without_a_time_are_not_archived(db, do_import):
    """The admin import used to store DSQ/no-time rows with a NULL time."""
    do_import(db, _lxf(results=(
        '<RESULT eventid="1" status="DSQ" />'
        '<RESULT eventid="1" swimtime="NT" />'
    )))
    assert db.query(Result).count() == 0


@pytest.mark.parametrize("do_import", IMPORTERS)
def test_club_without_code_is_matched_by_name(db, do_import):
    """The Organizer path matched clubs by code only: a code-less club was
    created again on every import."""
    db.add(TeamClub(clubsid=7, name="Test Club", code="", pin="123456"))
    db.commit()
    do_import(db, _lxf(club_code=None))
    assert db.query(TeamClub).count() == 1


def test_time_formats():
    assert _lenex_time_to_ms("00:01:02.34") == 62340
    assert _lenex_time_to_ms("01:02.34") == 62340
    assert _lenex_time_to_ms("41.23") == 41230  # seconds only (admin parser accepted it)
    assert _lenex_time_to_ms("NT") is None


def test_time_formats_shared_with_entries_seed():
    """Entries (seed.py) and results imports parse LENEX times the same way."""
    from app import seed
    assert seed._lenex_time_to_ms is _lenex_time_to_ms
    assert _lenex_time_to_ms("NT") is None
    assert _lenex_time_to_ms("0") is None             # zero time = no time
    assert _lenex_time_to_ms("") is None
    assert _lenex_time_to_ms("1:02.5") == 62500       # one-digit fraction = tenths
    assert _lenex_time_to_ms("00:01:02.50") == 62500


@pytest.mark.parametrize("do_import", IMPORTERS)
def test_xml_entities_are_refused(db, do_import):
    """Uploaded files are parsed with defusedxml (the Organizer path used the
    stdlib parser)."""
    lef = (b'<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa">]>'
           b'<LENEX><MEETS><MEET name="&a;"/></MEETS></LENEX>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("meet.lef", lef)
    with pytest.raises(Exception, match="(?i)entit"):
        do_import(db, buf.getvalue())
    assert db.query(Meet).count() == 0
