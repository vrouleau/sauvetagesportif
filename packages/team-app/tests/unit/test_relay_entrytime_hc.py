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
"""Relay entry time, relay/individual HC, and relay history.

- Entries export: a relay team's entry time and HC flag (ENTRY status="EXH"),
  and an individual HC registration's EXH status, reach the meet-app.
- Results import: relay results are archived as relays (team total, status)
  + relayspos (members) under the historical meet.
- Relay best time: every member is credited with the team's total; HC/DSQ,
  other courses, SERC, expired results and live registrations don't count.
- Migration m0008 adds relays.resultstatus to an existing database.

Uses an in-memory SQLite database — no Docker required.
"""
from __future__ import annotations

import sys
import zipfile
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimEvent, SwimSession, SwimStyle, SwimResult, BsGlobal, GENDER_F, GENDER_MIXED
from app.models_team import TeamClub, Member, Relay, RelayPos, Meet
from app.export import generate_lxf
from app.lxf_to_team import import_lxf_as_meet
from app.best_times import get_relay_best_times


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()
    engine.dispose()


def _seed_open_meet(db):
    db.add(BsGlobal(name="age_base_date", data="2026-12-31"))
    db.add(Meet(meetsid=1, name="Open Meet", registration_open=True))
    db.add(TeamClub(clubsid=1, name="Club Un", code="UN", nation="CAN", pin="111111"))
    db.add(SwimStyle(swimstyleid=506, distance=200, stroke=6, relaycount=4, name="4x50 Relais"))
    db.add(SwimStyle(swimstyleid=530, distance=0, stroke=6, relaycount=4, name="SERC"))
    db.add(SwimStyle(swimstyleid=501, distance=50, stroke=1, relaycount=1, name="50 Libre"))
    db.add(SwimSession(swimsessionid=1, meetsid=1, name="S1", sessionnumber=1))
    db.add(SwimEvent(swimeventid=100, meetsid=1, swimsessionid=1, swimstyleid=506,
                     gender=GENDER_MIXED, round=5, eventnumber=10))
    db.add(SwimEvent(swimeventid=101, meetsid=1, swimsessionid=1, swimstyleid=501,
                     gender=GENDER_F, round=5, eventnumber=11))
    for i in range(1, 6):
        db.add(Member(membersid=i, firstname=f"F{i}", lastname=f"L{i}", gender=GENDER_F,
                      birthdate=datetime(2005, 1, i), clubsid=1, license=f"LIC{i}"))
    db.commit()


def _lef_root(lxf_bytes: bytes) -> ET.Element:
    with zipfile.ZipFile(BytesIO(lxf_bytes)) as z:
        return ET.fromstring(z.read("meet.lef"))


class TestEntriesExport:
    def test_relay_entry_carries_entrytime_and_exh_status(self, db):
        _seed_open_meet(db)
        db.add(Relay(relaysid=1, meetsid=1, clubsid=1, stylesid=506, teamnumb=1, eventnumb=10,
                     gender=GENDER_MIXED, minage=0, maxage=0, entrytime=125430, resultstatus=4))
        db.add(Relay(relaysid=2, meetsid=1, clubsid=1, stylesid=506, teamnumb=2, eventnumb=10,
                     gender=GENDER_MIXED, minage=0, maxage=0))
        db.add_all([RelayPos(relaysid=1, numb=n, membersid=n) for n in range(1, 5)])
        db.commit()

        root = _lef_root(generate_lxf(db))
        entries = {r.get("number"): r.find("./ENTRIES/ENTRY") for r in root.iter("RELAY")}

        assert entries["1"].get("entrytime") == "00:02:05.43"
        assert entries["1"].get("status") == "EXH"
        assert entries["2"].get("entrytime") is None
        assert entries["2"].get("status") is None

    def test_individual_hc_registration_exports_exh_status(self, db):
        _seed_open_meet(db)
        db.add(SwimResult(swimresultid=1, meetsid=1, athleteid=1, swimeventid=101,
                          entrytime=31000, age_code="Open", resultstatus=4))
        db.add(SwimResult(swimresultid=2, meetsid=1, athleteid=2, swimeventid=101,
                          entrytime=32000, age_code="Open"))
        db.commit()

        root = _lef_root(generate_lxf(db))
        status_by_athlete = {
            a.get("lastname"): [e.get("status") for e in a.iter("ENTRY")]
            for a in root.iter("ATHLETE")
        }
        assert status_by_athlete["L1"] == ["EXH"]
        assert status_by_athlete["L2"] == [None]


# ── Results import -> relay history ─────────────────────────────────────────

def _results_lxf(meet_name: str, relays_xml: str, course: str = "LCM", date: str = "2026-10-01") -> bytes:
    athletes = "".join(
        f'<ATHLETE athleteid="90{i}" firstname="F{i}" lastname="L{i}" gender="F" '
        f'birthdate="2005-01-0{i}" license="LIC{i}"><RESULTS/></ATHLETE>'
        for i in range(1, 6)
    )
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0"><MEETS><MEET name="{meet_name}" city="X" course="{course}">
  <SESSIONS><SESSION number="1" date="{date}"><EVENTS>
    <EVENT eventid="100" number="10" gender="X"><SWIMSTYLE swimstyleid="506" distance="200" relaycount="4" name="4x50 Relais"/></EVENT>
    <EVENT eventid="102" number="12" gender="X"><SWIMSTYLE swimstyleid="530" distance="0" relaycount="4" name="SERC"/></EVENT>
  </EVENTS></SESSION></SESSIONS>
  <CLUBS><CLUB code="UN" name="Club Un" nation="CAN"><ATHLETES>{athletes}</ATHLETES>
    <RELAYS>{relays_xml}</RELAYS>
  </CLUB></CLUBS>
</MEET></MEETS></LENEX>"""
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("meet.lef", xml)
    return buf.getvalue()


def _relay(number: int, members: list[int], swimtime: str | None, status: str | None = None,
           eventid: str = "100") -> str:
    pos = "".join(f'<RELAYPOSITION number="{n}" athleteid="90{m}"/>' for n, m in enumerate(members, 1))
    attrs = f' eventid="{eventid}" resultid="7{number}"'
    if swimtime:
        attrs += f' swimtime="{swimtime}"'
    if status:
        attrs += f' status="{status}"'
    return (f'<RELAY number="{number}" gender="X"><RELAYPOSITIONS>{pos}</RELAYPOSITIONS>'
            f'<RESULTS><RESULT{attrs}><RELAYPOSITIONS>{pos}</RELAYPOSITIONS></RESULT></RESULTS></RELAY>')


class TestRelayArchive:
    def test_results_import_archives_relay_total_and_members(self, db):
        _seed_open_meet(db)
        out = import_lxf_as_meet(db, _results_lxf("Fall Meet", _relay(1, [1, 2, 3, 4], "00:02:01.50")), force=True)

        assert out["relays_imported"] == 1
        relay = db.query(Relay).filter(Relay.meetsid == out["meet_id"]).one()
        assert relay.totaltime == 121500
        assert relay.stylesid == 506
        assert relay.course == 1
        assert relay.resultstatus is None
        members = sorted(p.membersid for p in db.query(RelayPos).filter(RelayPos.relaysid == relay.relaysid))
        assert members == [1, 2, 3, 4]  # matched by license to the existing members

    def test_reimport_replaces_archived_relays(self, db):
        _seed_open_meet(db)
        import_lxf_as_meet(db, _results_lxf("Fall Meet", _relay(1, [1, 2, 3, 4], "00:02:01.50")), force=True)
        out = import_lxf_as_meet(db, _results_lxf("Fall Meet", _relay(1, [1, 2, 3, 4], "00:02:00.00")), force=True)

        relays = db.query(Relay).filter(Relay.meetsid == out["meet_id"]).all()
        assert [r.totaltime for r in relays] == [120000]

    def test_dsq_and_exh_are_archived_with_their_status(self, db):
        _seed_open_meet(db)
        out = import_lxf_as_meet(db, _results_lxf("Fall Meet", (
            _relay(1, [1, 2, 3, 4], "00:02:01.50", "EXH") + _relay(2, [5], None, "DSQ")
        )), force=True)
        status = {r.teamnumb: r.resultstatus for r in db.query(Relay).filter(Relay.meetsid == out["meet_id"])}
        assert status == {1: 4, 2: 3}


class TestHistoricalReimportWithoutDate:
    """Admin historical import (historical_import.py) of a file with no date at all."""

    def _dateless(self, relays_xml: str) -> bytes:
        return _results_lxf("Canadian Meet", relays_xml, date="")

    def test_reimport_replaces_the_existing_meet_and_keeps_its_date(self, db):
        from app.historical_import import import_historical_meet

        _seed_open_meet(db)
        # The meet was archived earlier, dated (e.g. by the organizer close path).
        db.add(Meet(meetsid=4, name="Canadian Meet", meetstate=3, mindate=datetime(2026, 5, 30)))
        db.commit()

        first = import_historical_meet(db, self._dateless(""), force=False)
        assert first.get("needs_force") and first["meet_id"] == 4  # recognized, asks to confirm

        out = import_historical_meet(db, self._dateless(_relay(1, [1, 2, 3, 4], "00:02:01.50")), force=True)

        assert out["meet_id"] == 4
        assert out["relays_imported"] == 1
        assert db.query(Meet).filter(Meet.name == "Canadian Meet").count() == 1
        relay = db.query(Relay).filter(Relay.meetsid == 4).one()
        assert relay.eventdate == datetime(2026, 5, 30)  # dated from the existing meet, so it expires

    def test_ambiguous_name_creates_a_new_meet(self, db):
        """Two completed meets with that name and no date to tell them apart: don't guess."""
        from app.historical_import import import_historical_meet

        _seed_open_meet(db)
        db.add_all([
            Meet(meetsid=4, name="Canadian Meet", meetstate=3, mindate=datetime(2025, 5, 30)),
            Meet(meetsid=5, name="Canadian Meet", meetstate=3, mindate=datetime(2026, 5, 30)),
        ])
        db.commit()

        out = import_historical_meet(db, self._dateless(""), force=False)
        assert out["meet_id"] not in (4, 5)


class TestRelayBestTimes:
    def _archive(self, db, relays_xml, name="Fall Meet", **kw):
        return import_lxf_as_meet(db, _results_lxf(name, relays_xml, **kw), force=True)

    def test_each_member_gets_the_fastest_team_total(self, db):
        _seed_open_meet(db)
        self._archive(db, _relay(1, [1, 2, 3, 4], "00:02:01.50") + _relay(2, [1, 5], "00:01:58.00"))

        bests = get_relay_best_times(db, [1, 2, 3, 4, 5], 506, "LCM")
        assert bests == {1: 118000, 2: 121500, 3: 121500, 4: 121500, 5: 118000}

    def test_hc_dsq_other_course_and_serc_do_not_count(self, db):
        _seed_open_meet(db)
        self._archive(db, _relay(1, [1], "00:01:50.00", "EXH") + _relay(2, [2], "00:01:50.00", "DSQ")
                      + _relay(3, [3], "00:01:50.00", eventid="102"))
        self._archive(db, _relay(1, [4], "00:01:50.00"), name="Short Course Meet", course="SCM")

        assert get_relay_best_times(db, [1, 2, 3, 4], 506, "LCM") == {}
        assert get_relay_best_times(db, [3], 530, "LCM") == {}  # SERC is judged
        assert get_relay_best_times(db, [4], 506, "SCM") == {4: 110000}

    def test_line_throw_is_course_free(self, db):
        """Lancer de la corde (2 people, 12.5 m, thrown from the deck): pool length
        does not matter, so a 25 m pool result counts at a 50 m meet."""
        _seed_open_meet(db)
        db.add(SwimStyle(swimstyleid=524, distance=12, stroke=0, relaycount=2, name="Lancer de la corde 12.5 m"))
        db.add(Relay(relaysid=60, meetsid=1, clubsid=1, stylesid=524, teamnumb=1, course=3,
                     totaltime=25000, eventdate=datetime.now()))
        db.add(RelayPos(relaysid=60, numb=1, membersid=1))
        db.commit()
        assert get_relay_best_times(db, [1], 524, "LCM") == {1: 25000}

    def test_expired_relays_do_not_count(self, db):
        _seed_open_meet(db)
        old = (datetime.now() - timedelta(days=30 * 20)).strftime("%Y-%m-%d")
        self._archive(db, _relay(1, [1], "00:01:50.00"), date=old)
        assert get_relay_best_times(db, [1], 506, "LCM") == {}

    def test_current_meet_registrations_never_count(self, db):
        """Live teams have an entry time but no total: they are not history."""
        _seed_open_meet(db)
        db.add(Relay(relaysid=50, meetsid=1, clubsid=1, stylesid=506, teamnumb=1, course=1, entrytime=100000))
        db.add(RelayPos(relaysid=50, numb=1, membersid=1))
        db.commit()
        assert get_relay_best_times(db, [1], 506, "LCM") == {}


class TestMigration0008:
    def test_adds_resultstatus_to_existing_relays_table(self):
        from app.migrations.versions import m0008_relay_resultstatus as m

        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as conn:
            conn.execute(text("CREATE TABLE relays (relaysid INTEGER PRIMARY KEY, totaltime INTEGER)"))
            conn.execute(text("INSERT INTO relays VALUES (1, 120000)"))
        m.upgrade(engine)
        m.upgrade(engine)  # idempotent
        cols = {c["name"] for c in inspect(engine).get_columns("relays")}
        assert "resultstatus" in cols
        with engine.connect() as conn:
            assert conn.execute(text("SELECT totaltime, resultstatus FROM relays")).one() == (120000, None)
