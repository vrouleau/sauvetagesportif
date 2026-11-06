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

"""Regression tests: event/pause start time (daytime) and duration used to be
silently dropped by the LENEX pipeline. The MeetEvent dataclass had no
daytime/duration fields, parse_meet_lxf never read EVENT @daytime/@duration,
_load_from_parsed never wrote them, and both exporters omitted them — so any
start time / duration set on an event or pause was lost through a .lxf
export/import round trip in BOTH apps.

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

from app.models import Base, SwimSession, SwimEvent, SwimStyle, BsGlobal
from app.models_team import Meet
from app.export import generate_meet_lxf_from_db
from app.meet_parser import parse_meet_lxf, MeetSession, MeetEvent
from app.events import _load_from_parsed


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


def _event_attrs(lxf_bytes: bytes) -> list[dict]:
    with zipfile.ZipFile(BytesIO(lxf_bytes)) as z:
        xml_bytes = z.read("meet.lef")
    root = ET.fromstring(xml_bytes)
    return [el.attrib for el in root.iter("EVENT")]


def _seed_active_meet(db_session, *, with_pause=False):
    """One open meet, one session, one real event (daytime/duration set), and
    optionally one pause (internalevent='T', also with daytime/duration)."""
    db_session.add(BsGlobal(name="age_base_date", data="2026-12-31"))
    db_session.add(Meet(meetsid=1, name="Test Meet", registration_open=True))
    db_session.add(SwimSession(swimsessionid=1, meetsid=1, name="Samedi", sessionnumber=1))
    db_session.add(SwimStyle(swimstyleid=500, distance=50, name="Style", relaycount=1, stroke=1))
    db_session.add(SwimEvent(
        swimeventid=1, meetsid=1, swimsessionid=1, swimstyleid=500,
        eventnumber=1, gender=1, round=5, sortcode=1,
        daytime=datetime(2000, 1, 1, 9, 30),
        duration=datetime(2000, 1, 1, 0, 15),
    ))
    if with_pause:
        db_session.add(SwimEvent(
            swimeventid=2, meetsid=1, swimsessionid=1, swimstyleid=None,
            eventnumber=2, gender=0, round=5, sortcode=2,
            internalevent="T", comment="Pause déjeuner",
            daytime=datetime(2000, 1, 1, 10, 0),
            duration=datetime(2000, 1, 1, 0, 30),
        ))
    db_session.commit()


# ── Export ──────────────────────────────────────────────────────────────────

def test_export_writes_event_daytime_duration(db_session):
    _seed_active_meet(db_session)
    attrs = _event_attrs(generate_meet_lxf_from_db(db_session, meetsid=1))
    assert len(attrs) == 1
    assert attrs[0]["daytime"] == "09:30"
    assert attrs[0]["duration"] == "00:15"


def test_export_writes_pause_daytime_duration(db_session):
    _seed_active_meet(db_session, with_pause=True)
    attrs = _event_attrs(generate_meet_lxf_from_db(db_session, meetsid=1))
    pause = next(a for a in attrs if a.get("internalevent") == "T")
    assert pause["daytime"] == "10:00"
    assert pause["duration"] == "00:30"


def test_export_omits_daytime_duration_when_unset(db_session):
    db_session.add(BsGlobal(name="age_base_date", data="2026-12-31"))
    db_session.add(Meet(meetsid=1, name="Test Meet", registration_open=True))
    db_session.add(SwimSession(swimsessionid=1, meetsid=1, name="Samedi", sessionnumber=1))
    db_session.add(SwimStyle(swimstyleid=500, distance=50, name="Style", relaycount=1, stroke=1))
    db_session.add(SwimEvent(swimeventid=1, meetsid=1, swimsessionid=1, swimstyleid=500,
                             eventnumber=1, gender=1, round=5, sortcode=1))
    db_session.commit()
    attrs = _event_attrs(generate_meet_lxf_from_db(db_session, meetsid=1))
    assert len(attrs) == 1
    assert "daytime" not in attrs[0]
    assert "duration" not in attrs[0]


# ── Parse ─────────────────────────────────────────────────────────────────────

def test_parse_reads_event_daytime_duration(db_session):
    _seed_active_meet(db_session, with_pause=True)
    meet = parse_meet_lxf(generate_meet_lxf_from_db(db_session, meetsid=1))
    evs = meet.sessions[0].events
    real = next(e for e in evs if not e.is_internal)
    pause = next(e for e in evs if e.is_internal)
    assert real.daytime == "09:30"
    assert real.duration == "00:15"
    assert pause.daytime == "10:00"
    assert pause.duration == "00:30"


# ── Load ────────────────────────────────────────────────────────────────────

def test_load_persists_event_daytime_duration(db_session):
    meet = type("Meet", (), {})()
    meet.meet_name = "Test Meet"
    meet.course = "LCM"
    meet.masters = False
    meet.sessions = [MeetSession(number=1, name="Samedi", events=[
        MeetEvent(eventid=1, number=1, gender="M", round="TIM", event_type="",
                  swimstyleid=500, distance=50, relaycount=1, style_name="Style",
                  daytime="09:30", duration="00:15"),
    ])]

    _load_from_parsed(db_session, meet)
    db_session.commit()

    row = db_session.query(SwimEvent).filter_by(swimeventid=1).one()
    assert row.daytime is not None and row.daytime.strftime("%H:%M") == "09:30"
    assert row.duration is not None and row.duration.strftime("%H:%M") == "00:15"


# ── Full round trip (DB -> export -> parse -> load -> DB) ──────────────────────

def test_full_roundtrip_preserves_event_and_pause_times(db_session):
    _seed_active_meet(db_session, with_pause=True)

    lxf = generate_meet_lxf_from_db(db_session, meetsid=1)
    meet = parse_meet_lxf(lxf)

    # Load into a fresh DB and confirm the times survived.
    engine2 = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine2)
    db2 = sessionmaker(bind=engine2)()
    try:
        _load_from_parsed(db2, meet)
        db2.commit()
        rows = {e.swimeventid: e for e in db2.query(SwimEvent).all()}
        assert rows[1].daytime.strftime("%H:%M") == "09:30"
        assert rows[1].duration.strftime("%H:%M") == "00:15"
        assert rows[2].daytime.strftime("%H:%M") == "10:00"
        assert rows[2].duration.strftime("%H:%M") == "00:30"
    finally:
        db2.close()
        engine2.dispose()


# ── _parse_event_time: no-crash parsing (regression for a 500 on update_event) ─
# update_event used to do datetime(2000,1,1,*map(int, val.split(":")[:2])),
# which raised ValueError -> HTTP 500 for an hour >= 24 (e.g. a large "minutes"
# duration) or any non-numeric part. _parse_event_time must tolerate all of it.

from app.routers.api import _parse_event_time  # noqa: E402


def test_parse_event_time_basic_hh_mm():
    assert _parse_event_time("09:30") == datetime(2000, 1, 1, 9, 30)
    assert _parse_event_time("00:15") == datetime(2000, 1, 1, 0, 15)


def test_parse_event_time_minute_overflow_carries_into_hours():
    # "0:90" -> 1:30
    assert _parse_event_time("0:90") == datetime(2000, 1, 1, 1, 30)


def test_parse_event_time_hour_ge_24_is_clamped_not_crashing():
    # The exact class that used to 500: hour >= 24.
    assert _parse_event_time("25:00") == datetime(2000, 1, 1, 23, 0)
    assert _parse_event_time("30:15") == datetime(2000, 1, 1, 23, 15)


def test_parse_event_time_empty_and_none_are_none():
    assert _parse_event_time("") is None
    assert _parse_event_time(None) is None


def test_parse_event_time_malformed_is_none_not_crash():
    assert _parse_event_time("abc") is None
    assert _parse_event_time("9") is None       # no minutes part
    assert _parse_event_time("9:xx") is None     # non-numeric minutes


# ── parse_meet_lxf robustness: distance="None" must not 500 the import ────────
# A team-app export of a style with NULL distance used to write
# distance="None"; ElementTree.get("distance", 0) returns that string (attr is
# present), so int("None") raised ValueError -> "Invalid meet .lxf: invalid
# literal for int() with base 10: 'None'". The parser must tolerate it.

import zipfile as _zipfile  # noqa: E402
from io import BytesIO as _BytesIO  # noqa: E402


def _lxf_bytes(xml: str) -> bytes:
    buf = _BytesIO()
    with _zipfile.ZipFile(buf, "w") as z:
        z.writestr("meet.lef", xml)
    return buf.getvalue()


def test_parse_tolerates_distance_none_literal():
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0"><MEETS><MEET name="M" course="LCM">
  <SESSIONS><SESSION number="1" name="S1">
    <EVENTS>
      <EVENT eventid="1" number="1" gender="F" round="TIM" preveventid="-1">
        <SWIMSTYLE stroke="UNKNOWN" distance="None" relaycount="None" swimstyleid="503" name="X" />
      </EVENT>
    </EVENTS>
  </SESSION></SESSIONS>
</MEET></MEETS></LENEX>"""
    meet = parse_meet_lxf(_lxf_bytes(xml))  # must not raise
    ev = meet.sessions[0].events[0]
    assert ev.distance == 0
    assert ev.relaycount == 1
    assert ev.swimstyleid == 503


def test_export_never_emits_distance_none_for_null_distance_style(db_session):
    db_session.add(BsGlobal(name="age_base_date", data="2026-12-31"))
    db_session.add(Meet(meetsid=1, name="Test Meet", registration_open=True))
    db_session.add(SwimSession(swimsessionid=1, meetsid=1, name="S1", sessionnumber=1))
    # A style whose distance/relaycount are NULL (as lifesaving styles often are).
    db_session.add(SwimStyle(swimstyleid=503, distance=None, name="200m Obstacles", relaycount=None, stroke=1))
    db_session.add(SwimEvent(swimeventid=1, meetsid=1, swimsessionid=1, swimstyleid=503,
                             eventnumber=1, gender=2, round=5, sortcode=1))
    db_session.commit()
    lxf = generate_meet_lxf_from_db(db_session, meetsid=1)
    xml = _zipfile.ZipFile(_BytesIO(lxf)).read("meet.lef").decode("utf-8")
    assert 'distance="None"' not in xml
    assert 'relaycount="None"' not in xml
    # And it must re-import cleanly.
    meet = parse_meet_lxf(lxf)
    assert meet.sessions[0].events[0].swimstyleid == 503
