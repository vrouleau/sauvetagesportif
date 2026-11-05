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

"""Historical-meet Lieu (city) and Date coverage.

Covers the bug where the admin "Compétitions historiques" table showed "—"
for Lieu/Date:

- Results-import LXFs in the wild carry dates only on <SESSION date=...>,
  never on <MEET startdate/date>. Both import paths must derive meets.mindate
  (meet start) / meets.maxdate (meet end) from the earliest / latest session
  date so the columns are never left NULL. City comes from <MEET city>.

- GET /admin/historical-meets must be history-only (meetstate == 3), excluding
  the current/open meet (which lives in the Open Meets dashboard), and must
  surface meets.place as `city` and meets.mindate as `date`, ordered newest
  start date first.
"""
from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base  # noqa: E402
from app.models_team import Meet, Result  # noqa: E402
from app.historical_import import import_historical_meet  # noqa: E402
from app.lxf_to_team import import_lxf_as_meet  # noqa: E402
from app.routers.api import list_historical_meets  # noqa: E402


# ── LXF builder ───────────────────────────────────────────────────────────────

def _build_lxf(
    *,
    name: str = "Test Meet",
    city: str = "Montréal",
    course: str = "LCM",
    meet_startdate: str | None = None,
    session_dates: list[str | None],
) -> bytes:
    """Build a results LXF (zip with a .lef) with one SESSION per given date.

    `meet_startdate=None` mirrors the real-world files: the <MEET> element has
    no startdate/date, only the <SESSION date> attributes carry the dates.
    """
    lenex = ET.Element("LENEX", version="3.0")
    meets = ET.SubElement(lenex, "MEETS")
    meet_attrs = {"name": name, "course": course, "city": city}
    if meet_startdate is not None:
        meet_attrs["startdate"] = meet_startdate
    meet = ET.SubElement(meets, "MEET", **meet_attrs)

    sessions = ET.SubElement(meet, "SESSIONS")
    for i, d in enumerate(session_dates, start=1):
        sess_attrs = {"number": str(i)}
        if d is not None:
            sess_attrs["date"] = d
        session = ET.SubElement(sessions, "SESSION", **sess_attrs)
        events_el = ET.SubElement(session, "EVENTS")
        event_el = ET.SubElement(
            events_el, "EVENT", eventid=str(i), number=str(i), gender="M", round="TIM"
        )
        ET.SubElement(
            event_el, "SWIMSTYLE", swimstyleid=str(500 + i),
            distance="100", relaycount="1", stroke="FREE",
        )

    clubs_el = ET.SubElement(meet, "CLUBS")
    club_el = ET.SubElement(clubs_el, "CLUB", name="Test Club", code="TST", clubid="1")
    athletes_el = ET.SubElement(club_el, "ATHLETES")
    ath_el = ET.SubElement(
        athletes_el, "ATHLETE", athleteid="1",
        firstname="Jean", lastname="Tremblay", gender="M",
    )
    results_el = ET.SubElement(ath_el, "RESULTS")
    ET.SubElement(results_el, "RESULT", resultid="1", eventid="1", swimtime="00:01:02.34")

    xml_bytes = ET.tostring(lenex, encoding="utf-8", xml_declaration=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("meet.lef", xml_bytes)
    return buf.getvalue()


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


def _only_meet(db) -> Meet:
    meets = db.query(Meet).filter(Meet.name != "__best_times_import__").all()
    assert len(meets) == 1, f"expected exactly one meet, got {len(meets)}"
    return meets[0]


# ── Import populates mindate/maxdate/city from session dates ───────────────────

def test_historical_import_derives_dates_from_sessions(db_session):
    """historical_import: no <MEET startdate>, dates only on sessions ->
    mindate = earliest session, maxdate (via results.eventdate source) set."""
    lxf = _build_lxf(
        name="CSSG",
        city="Gatineau",
        session_dates=["2026-05-03", "2026-05-02", "2026-05-03"],  # out of order
    )
    import_historical_meet(db_session, lxf, force=True)

    m = _only_meet(db_session)
    assert m.place == "Gatineau"
    # Earliest session date, not first-in-document-order.
    assert m.mindate is not None
    assert m.mindate.date().isoformat() == "2026-05-02"
    # eventdate on results is seeded from the derived start date.
    r = db_session.query(Result).filter(Result.meetsid == m.meetsid).first()
    assert r is not None and r.eventdate is not None
    assert r.eventdate.date().isoformat() == "2026-05-02"


def test_historical_import_prefers_meet_level_startdate(db_session):
    """When <MEET startdate> is present it wins over session dates."""
    lxf = _build_lxf(
        meet_startdate="2026-01-10",
        session_dates=["2026-01-31"],
    )
    import_historical_meet(db_session, lxf, force=True)
    m = _only_meet(db_session)
    assert m.mindate.date().isoformat() == "2026-01-10"


def test_lxf_to_team_derives_min_session_date(db_session):
    """lxf_to_team: session-date fallback uses the MINIMUM session date
    (meet start), not the first one encountered."""
    lxf = _build_lxf(
        name="CAEM",
        city="Montréal",
        session_dates=["2025-05-25", "2025-05-24", "2025-05-24"],  # min is 05-24
    )
    import_lxf_as_meet(db_session, lxf, force=True)

    m = _only_meet(db_session)
    assert m.place == "Montréal"
    assert m.mindate is not None
    assert m.mindate.date().isoformat() == "2025-05-24"


def test_import_without_any_date_leaves_mindate_null(db_session):
    """A file with neither <MEET startdate> nor any <SESSION date> can't
    invent a date — mindate stays NULL (correct) rather than guessed."""
    lxf = _build_lxf(session_dates=[None])
    import_historical_meet(db_session, lxf, force=True)
    m = _only_meet(db_session)
    assert m.mindate is None


# ── GET /admin/historical-meets scope, ordering, and field mapping ─────────────

def _add_meet(db, *, meetsid, name, place, mindate, meetstate):
    from datetime import datetime
    md = datetime.fromisoformat(mindate) if mindate else None
    db.add(Meet(meetsid=meetsid, name=name, place=place, mindate=md,
                course=1, meetstate=meetstate))
    db.commit()


def test_historical_endpoint_excludes_current_meet(db_session):
    """Only archived meets (meetstate == 3) appear; the current/open meet
    (meetstate != 3) is excluded — it belongs to Open Meets."""
    _add_meet(db_session, meetsid=1, name="Archived", place="Laval",
              mindate="2026-02-15", meetstate=3)
    _add_meet(db_session, meetsid=2, name="Current Open", place="Québec",
              mindate=None, meetstate=0)

    rows = list_historical_meets(db=db_session)
    names = {r["name"] for r in rows}
    assert names == {"Archived"}


def test_historical_endpoint_maps_place_and_mindate(db_session):
    """city <- meets.place, date <- meets.mindate (YYYY-MM-DD)."""
    _add_meet(db_session, meetsid=1, name="CAEM", place="Montréal",
              mindate="2026-01-31", meetstate=3)
    rows = list_historical_meets(db=db_session)
    assert len(rows) == 1
    assert rows[0]["city"] == "Montréal"
    assert rows[0]["date"] == "2026-01-31"


def test_historical_endpoint_orders_by_mindate_desc_nulls_last(db_session):
    """Newest start date first; rows with no date sink to the bottom."""
    _add_meet(db_session, meetsid=1, name="Jan", place="A", mindate="2026-01-31", meetstate=3)
    _add_meet(db_session, meetsid=2, name="Aug", place="B", mindate="2026-08-15", meetstate=3)
    _add_meet(db_session, meetsid=3, name="May", place="C", mindate="2026-05-02", meetstate=3)
    _add_meet(db_session, meetsid=4, name="NoDate", place="D", mindate=None, meetstate=3)

    rows = list_historical_meets(db=db_session)
    assert [r["name"] for r in rows] == ["Aug", "May", "Jan", "NoDate"]
    assert rows[-1]["date"] is None


def test_historical_endpoint_blank_place_yields_empty_city(db_session):
    """A meet with no place returns city='' (frontend renders this as —)."""
    _add_meet(db_session, meetsid=1, name="CQS Plage", place="",
              mindate="2026-08-15", meetstate=3)
    rows = list_historical_meets(db=db_session)
    assert rows[0]["city"] == ""
