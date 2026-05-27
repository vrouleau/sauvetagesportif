# Feature: remove-dual-schema, Property 5: Best Times Computation Correctness
"""Property-based test for best times computation.

**Validates: Requirements 5.2**

Property 5: Best Times Computation Correctness
For any set of results across multiple meets, the best time for a given
(member, swimstyle, course) combination SHALL equal the minimum totaltime
from results where meetstate=3 (completed), resulttyp=0 (official), and
the result date is within the expiry window.
"""
from __future__ import annotations

import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimStyle
from app.models_team import Meet, Result, TeamClub, Member
from app.best_times_v2 import get_best_times_for_member


# ── Strategies ────────────────────────────────────────────────────────────────

# Course: 1=LCM, 3=SCM (valid courses for the function)
course_st = st.sampled_from([1, 3])

# Time in ms: 30s to 5min
time_ms_st = st.integers(min_value=30000, max_value=300000)

# Date within the last 18 months (well within expiry window)
def recent_date_st():
    """Generate a date within the last 12 months (safely within 18-month window)."""
    today = date.today()
    min_date = today - timedelta(days=365)
    return st.dates(min_value=min_date, max_value=today)


# Style IDs (1-5 different styles)
style_id_st = st.integers(min_value=1, max_value=10)


# A single result entry: (style_id, course, time_ms, event_date)
result_entry_st = st.tuples(
    style_id_st,
    course_st,
    time_ms_st,
    recent_date_st(),
)

# Generate 1-20 results for a member
results_list_st = st.lists(result_entry_st, min_size=1, max_size=20)

# Number of meets (1-5)
num_meets_st = st.integers(min_value=1, max_value=5)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _create_engine_and_session():
    """Create an in-memory SQLite engine with all tables."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)
    return engine, session_factory


def _course_str(course_int: int) -> str | None:
    if course_int == 1:
        return "LCM"
    if course_int == 3:
        return "SCM"
    return None


# ── Property Test ─────────────────────────────────────────────────────────────

class TestBestTimesComputation:
    """Property 5: Best Times Computation Correctness."""

    @given(
        results_data=results_list_st,
        num_meets=num_meets_st,
    )
    @settings(
        max_examples=100,
        suppress_health_check=[HealthCheck.function_scoped_fixture],
        deadline=None,
    )
    def test_best_time_equals_minimum_totaltime(self, results_data, num_meets):
        """For any set of results, best time == min(totaltime) for valid results
        within the expiry window, grouped by (member, style, course).

        # Feature: remove-dual-schema, Property 5: Best Times Computation Correctness
        **Validates: Requirements 5.2**
        """
        engine, SessionFactory = _create_engine_and_session()
        db = SessionFactory()

        try:
            # Create a club
            club = TeamClub(clubsid=1, name="Test Club", code="TST")
            db.add(club)
            db.flush()

            # Create a member
            member = Member(
                membersid=100,
                firstname="Test",
                lastname="Swimmer",
                clubsid=1,
                gender=1,
                birthdate=datetime(2000, 1, 1),
            )
            db.add(member)
            db.flush()

            # Create meets (all with meetstate=3, completed)
            meets = []
            for i in range(num_meets):
                meet = Meet(
                    meetsid=i + 1,
                    name=f"Meet {i + 1}",
                    meetstate=3,
                    course=1,
                )
                db.add(meet)
                meets.append(meet)
            db.flush()

            # Create swim styles referenced by results
            style_ids_used = set(r[0] for r in results_data)
            for sid in style_ids_used:
                style = SwimStyle(
                    swimstyleid=sid,
                    code=f"S{sid}",
                    name=f"Style {sid}",
                    distance=100,
                    stroke=1,
                )
                db.add(style)
            db.flush()

            # Distribute results across meets and add them
            for idx, (style_id, course, time_ms, event_date) in enumerate(results_data):
                meet_idx = idx % num_meets
                result = Result(
                    resultsid=idx + 1,
                    membersid=100,
                    meetsid=meets[meet_idx].meetsid,
                    stylesid=style_id,
                    course=course,
                    totaltime=time_ms,
                    resulttyp=0,  # official
                    eventdate=datetime(event_date.year, event_date.month, event_date.day),
                )
                db.add(result)
            db.flush()

            # Call the function under test
            best_times = get_best_times_for_member(db, member_id=100, max_age_months=18)

            # Compute expected best times manually
            # Group by (style_id, course) and find minimum time
            expected: dict[tuple[int, int], int] = {}
            for style_id, course, time_ms, event_date in results_data:
                key = (style_id, course)
                if key not in expected or time_ms < expected[key]:
                    expected[key] = time_ms

            # Verify: for each (style, course) group, the returned best time
            # must equal the minimum totaltime from valid results
            for (style_id, course), expected_min in expected.items():
                style_key = str(style_id)
                course_key = _course_str(course)
                assert course_key is not None

                assert style_key in best_times, (
                    f"Style {style_id} missing from best_times result"
                )
                assert course_key in best_times[style_key], (
                    f"Course {course_key} missing for style {style_id}"
                )
                actual_time = best_times[style_key][course_key]["time_ms"]
                assert actual_time == expected_min, (
                    f"For style={style_id}, course={course_key}: "
                    f"expected {expected_min}ms but got {actual_time}ms"
                )

            # Verify no extra entries beyond what we expect
            for style_key, courses in best_times.items():
                for course_key in courses:
                    style_id = int(style_key)
                    course_int = 1 if course_key == "LCM" else 3
                    assert (style_id, course_int) in expected, (
                        f"Unexpected entry in best_times: style={style_id}, course={course_key}"
                    )

        finally:
            db.close()
            engine.dispose()
