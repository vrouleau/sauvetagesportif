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

"""Property-based test for results import completeness.

# Feature: remove-dual-schema, Property 4: Results Import Completeness

**Validates: Requirements 5.1**

Property 4: For any valid results LXF imported via the organizer path,
every created `results` row SHALL have non-null values for `meetsid`,
`membersid`, `stylesid`, and `course`, and `totaltime` SHALL be non-null
for results with actual swim times.
"""
from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimStyle
from app.models_team import Result, TeamClub, Member, Meet
from app.lxf_to_team import import_lxf_as_meet


# ── Hypothesis strategies ─────────────────────────────────────────────────────

# Generate valid swim times in LENEX format (HH:MM:SS.cc)
_swim_time = st.builds(
    lambda m, s, cs: f"00:{m:02d}:{s:02d}.{cs:02d}",
    m=st.integers(min_value=0, max_value=59),
    s=st.integers(min_value=0, max_value=59),
    cs=st.integers(min_value=1, max_value=99),  # min 1 to ensure non-zero time
)

# Generate athlete names (non-empty ASCII strings)
_name = st.text(
    alphabet=st.characters(whitelist_categories=("L",), whitelist_characters=""),
    min_size=1,
    max_size=20,
)

# Generate event structures
_stroke = st.sampled_from(["FREE", "BACK", "BREAST", "FLY", "MEDLEY"])
_distance = st.sampled_from([50, 100, 200, 400, 800, 1500])
_course = st.sampled_from(["LCM", "SCM", "SCY"])
_gender = st.sampled_from(["M", "F"])


@st.composite
def _athlete_strategy(draw, athlete_id: int, event_ids: list[int]):
    """Generate an athlete with 1+ results referencing given event IDs."""
    firstname = draw(_name)
    lastname = draw(_name)
    gender = draw(_gender)
    # Each athlete gets at least one result
    num_results = draw(st.integers(min_value=1, max_value=min(3, len(event_ids))))
    chosen_events = draw(
        st.lists(
            st.sampled_from(event_ids),
            min_size=num_results,
            max_size=num_results,
            unique=True,
        )
    )
    results = []
    for i, eid in enumerate(chosen_events):
        swimtime = draw(_swim_time)
        results.append({"resultid": str(athlete_id * 100 + i + 1), "eventid": str(eid), "swimtime": swimtime})
    return {
        "athleteid": str(athlete_id),
        "firstname": firstname,
        "lastname": lastname,
        "gender": gender,
        "results": results,
    }


@st.composite
def _lxf_data_strategy(draw):
    """Generate a complete valid LXF data structure."""
    meet_course = draw(_course)
    # Generate 1-3 events
    num_events = draw(st.integers(min_value=1, max_value=3))
    events = []
    for i in range(num_events):
        events.append({
            "eventid": str(i + 1),
            "number": str(i + 1),
            "gender": draw(_gender),
            "swimstyleid": str(500 + i),
            "distance": str(draw(_distance)),
            "stroke": draw(_stroke),
        })

    event_ids = [int(e["eventid"]) for e in events]

    # Generate 1-3 athletes in a single club
    num_athletes = draw(st.integers(min_value=1, max_value=3))
    athletes = []
    for i in range(num_athletes):
        ath = draw(_athlete_strategy(athlete_id=i + 1, event_ids=event_ids))
        athletes.append(ath)

    club_name = draw(_name)
    club_code = draw(st.text(alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ", min_size=2, max_size=4))

    return {
        "meet_course": meet_course,
        "events": events,
        "athletes": athletes,
        "club_name": club_name,
        "club_code": club_code,
    }


def _build_lxf_bytes(data: dict) -> bytes:
    """Build a valid LXF (zip with .lef XML) from generated data."""
    lenex = ET.Element("LENEX", version="3.0")
    meets = ET.SubElement(lenex, "MEETS")
    meet = ET.SubElement(meets, "MEET", name="TestMeet", course=data["meet_course"],
                         startdate="2024-06-15", city="TestCity")

    # Sessions + Events
    sessions = ET.SubElement(meet, "SESSIONS")
    session = ET.SubElement(sessions, "SESSION", number="1", date="2024-06-15")
    events_el = ET.SubElement(session, "EVENTS")
    for ev in data["events"]:
        event_el = ET.SubElement(events_el, "EVENT", eventid=ev["eventid"],
                                 number=ev["number"], gender=ev["gender"], round="TIM")
        ET.SubElement(event_el, "SWIMSTYLE", swimstyleid=ev["swimstyleid"],
                      distance=ev["distance"], relaycount="1", stroke=ev["stroke"])

    # Clubs + Athletes + Results
    clubs_el = ET.SubElement(meet, "CLUBS")
    club_el = ET.SubElement(clubs_el, "CLUB", name=data["club_name"],
                            code=data["club_code"], clubid="1")
    athletes_el = ET.SubElement(club_el, "ATHLETES")
    for ath in data["athletes"]:
        ath_el = ET.SubElement(athletes_el, "ATHLETE", athleteid=ath["athleteid"],
                               firstname=ath["firstname"], lastname=ath["lastname"],
                               gender=ath["gender"])
        results_el = ET.SubElement(ath_el, "RESULTS")
        for res in ath["results"]:
            ET.SubElement(results_el, "RESULT", resultid=res["resultid"],
                          eventid=res["eventid"], swimtime=res["swimtime"])

    # Serialize to XML bytes
    xml_bytes = ET.tostring(lenex, encoding="utf-8", xml_declaration=True)

    # Wrap in a ZIP as .lef file
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("meet.lef", xml_bytes)
    return buf.getvalue()


def _create_db_session():
    """Create an in-memory SQLite database with the full schema."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    return Session()


# ── Property test ─────────────────────────────────────────────────────────────

class TestResultsImportCompleteness:
    """Property 4: Results Import Completeness."""

    @given(data=_lxf_data_strategy())
    @settings(
        max_examples=100,
        suppress_health_check=[HealthCheck.function_scoped_fixture],
        deadline=None,
    )
    def test_all_results_have_required_fields(self, data):
        """For any valid results LXF, every results row has non-null
        meetsid, membersid, stylesid, course. totaltime is non-null
        for results with actual swim times.

        # Feature: remove-dual-schema, Property 4: Results Import Completeness
        **Validates: Requirements 5.1**
        """
        db = _create_db_session()
        try:
            lxf_bytes = _build_lxf_bytes(data)
            result = import_lxf_as_meet(db, lxf_bytes)

            # Verify results were imported
            assert result["results"] > 0, "Expected at least one result to be imported"

            # Query all results rows created
            all_results = db.query(Result).all()
            assert len(all_results) > 0

            for row in all_results:
                # Required non-null fields
                assert row.meetsid is not None, f"Result {row.resultsid} has null meetsid"
                assert row.membersid is not None, f"Result {row.resultsid} has null membersid"
                assert row.stylesid is not None, f"Result {row.resultsid} has null stylesid"
                assert row.course is not None, f"Result {row.resultsid} has null course"

                # totaltime must be non-null for results with actual swim times
                # (all our generated results have valid swim times)
                assert row.totaltime is not None, f"Result {row.resultsid} has null totaltime"
                assert row.totaltime > 0, f"Result {row.resultsid} has totaltime <= 0"
        finally:
            db.close()