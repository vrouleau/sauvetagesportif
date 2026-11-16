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

"""Durable coach best times (athlete_best_times) + the shared resolver.

Rules (see best_times.py):
- a coach best time within the expiry window is authoritative;
- otherwise the fastest eligible historical result within the window;
- coach values are captured from registration entry times at meet close,
  then lowered to that meet's faster official results.
"""
from __future__ import annotations

import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimStyle, SwimSession, SwimEvent, SwimResult, MeetConfig
from app.models_team import Meet, Result, TeamClub, Member, AthleteBestTime
from app.best_times import (
    get_best_times_for_member, get_public_best_times, get_best_time_date,
    capture_coach_best_times, refresh_best_times_from_meet,
)

LCM, SCM = 1, 3
FREE, RELAY = 101, 201
LIVE, OLD = 10, 1


def _ago(days: int) -> datetime:
    return datetime.combine(date.today() - timedelta(days=days), datetime.min.time())


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(TeamClub(clubsid=1, name="Alpha Club", code="ALP"))
    session.add_all([
        SwimStyle(swimstyleid=FREE, code="S101", name="100 Free", distance=100, stroke=1, relaycount=1),
        SwimStyle(swimstyleid=RELAY, code="S201", name="4x50 Free", distance=50, stroke=6, relaycount=4),
    ])
    session.flush()
    session.add(Member(membersid=1, firstname="Ann", lastname="Alpha", clubsid=1, gender=2))
    session.add(Meet(meetsid=OLD, name="Old Meet", meetstate=3, course=LCM))
    session.flush()
    yield session
    session.close()
    engine.dispose()


def _result(db, rid, time_ms, when, course=LCM, style=FREE, meetsid=OLD, status=None):
    db.add(Result(resultsid=rid, membersid=1, meetsid=meetsid, stylesid=style, course=course,
                  totaltime=time_ms, resulttyp=0, eventdate=when, resultstatus=status))
    db.flush()


def _coach(db, time_ms, when, course=LCM, style=FREE):
    db.add(AthleteBestTime(membersid=1, stylesid=style, course=course, time_ms=time_ms, entered_date=when))
    db.flush()


def _live_meet(db, *, course="LCM", meet_type="POOL", start=None):
    """An open (live) meet with one individual + one relay event."""
    start = start or _ago(10)
    db.add(Meet(meetsid=LIVE, name="Live Meet", meetstate=0, meet_type=meet_type, registration_open=True))
    db.flush()
    db.add(MeetConfig(meetsid=LIVE, name="meet_course", data=course))
    db.add(SwimSession(swimsessionid=1, meetsid=LIVE, startdate=start))
    db.add_all([
        SwimEvent(meetsid=LIVE, swimeventid=1, swimsessionid=1, swimstyleid=FREE, eventnumber=1),
        SwimEvent(meetsid=LIVE, swimeventid=2, swimsessionid=1, swimstyleid=RELAY, eventnumber=2),
    ])
    db.flush()
    return start


def _register(db, rid, event_id, entry_ms):
    db.add(SwimResult(swimresultid=rid, meetsid=LIVE, athleteid=1, swimeventid=event_id,
                      age_code="Open", entrytime=entry_ms))
    db.flush()


# ── Resolver ─────────────────────────────────────────────────────────────────

def test_lcm_and_scm_are_resolved_independently(db):
    _coach(db, 61000, _ago(30), course=LCM)
    _result(db, 1, 58000, _ago(60), course=SCM)

    bt = get_best_times_for_member(db, 1)[str(FREE)]
    assert bt["LCM"]["time_ms"] == 61000 and bt["LCM"]["source"] == "coach"
    assert bt["SCM"]["time_ms"] == 58000 and bt["SCM"]["source"] == "result"


def test_valid_coach_time_wins_over_faster_history(db):
    _result(db, 1, 59000, _ago(100))
    _coach(db, 62000, _ago(30))

    bt = get_best_times_for_member(db, 1)[str(FREE)]["LCM"]
    assert bt == {"time_ms": 62000, "date": _ago(30).strftime("%Y-%m-%d"), "source": "coach"}


def test_expired_coach_time_falls_back_to_history(db):
    _coach(db, 55000, _ago(30 * 20))  # 20 months old
    _result(db, 1, 63000, _ago(100))
    _result(db, 2, 61000, _ago(200))

    bt = get_best_times_for_member(db, 1, max_age_months=18)[str(FREE)]["LCM"]
    assert bt["time_ms"] == 61000
    assert bt["date"] == _ago(200).strftime("%Y-%m-%d")
    assert bt["source"] == "result"


def test_stale_fastest_result_does_not_survive_a_newer_slower_one(db):
    # Regression: min(time) and max(date) used to be aggregated separately,
    # so a 2-year-old fastest time survived behind any recent result.
    _result(db, 1, 55000, _ago(30 * 24))
    _result(db, 2, 64000, _ago(30))

    bt = get_best_times_for_member(db, 1)[str(FREE)]["LCM"]
    assert bt["time_ms"] == 64000
    assert bt["date"] == _ago(30).strftime("%Y-%m-%d")  # the winning row's own date
    assert get_best_time_date(db, 1, FREE, "LCM") == _ago(30).date()


def test_no_eligible_source_means_no_best_time(db):
    _result(db, 1, 55000, _ago(30 * 24))           # expired
    _result(db, 2, 50000, _ago(10), status=4)      # HC/EXH
    _coach(db, 52000, _ago(30 * 24))               # expired

    assert get_best_times_for_member(db, 1) == {}


def test_public_page_uses_the_same_resolver(db):
    _coach(db, 62000, _ago(30), course=LCM)        # coach-only on LCM
    _result(db, 1, 59000, _ago(100), course=LCM)   # overridden by coach
    _result(db, 2, 31000, _ago(100), course=SCM)
    db.commit()

    data = get_public_best_times(db)
    athletes = data["clubs"][0]["athletes"]
    assert athletes == [{"name": "Alpha, Ann", "times": {"101_LCM": 62000, "101_SCM": 31000}}]

    reg = get_best_times_for_member(db, 1)[str(FREE)]
    assert reg["LCM"]["time_ms"] == 62000 and reg["SCM"]["time_ms"] == 31000


def test_public_page_lists_athlete_with_only_a_coach_time(db):
    _coach(db, 62000, _ago(30))
    db.commit()

    data = get_public_best_times(db)
    assert data["styles"] == [{"uid": FREE, "name": "100 Free"}]
    assert data["clubs"][0]["athletes"][0]["times"] == {"101_LCM": 62000}


# ── Capture at meet close ────────────────────────────────────────────────────

def test_capture_stores_changed_entry_time_dated_to_meet_start(db):
    start = _live_meet(db, course="SCM")
    _result(db, 1, 60000, _ago(100), course=SCM)
    _register(db, 1, 1, 58500)

    assert capture_coach_best_times(db, LIVE) == 1
    row = db.get(AthleteBestTime, (1, FREE, SCM))
    assert row.time_ms == 58500 and row.entered_date == start
    assert db.get(AthleteBestTime, (1, FREE, LCM)) is None


def test_capture_ignores_unchanged_prefilled_entry_time(db):
    _live_meet(db)
    _result(db, 1, 60000, _ago(100))
    _register(db, 1, 1, 60000)  # the pre-filled default

    assert capture_coach_best_times(db, LIVE) == 0
    assert db.query(AthleteBestTime).count() == 0


def test_capture_overwrites_previous_coach_value_with_new_entry(db):
    start = _live_meet(db)
    _coach(db, 62000, _ago(200))
    _register(db, 1, 1, 64000)  # coach now claims slower

    capture_coach_best_times(db, LIVE)
    row = db.get(AthleteBestTime, (1, FREE, LCM))
    assert row.time_ms == 64000 and row.entered_date == start


def test_capture_skips_relays_and_empty_entries(db):
    _live_meet(db)
    _register(db, 1, 2, 120000)  # relay
    _register(db, 2, 1, None)    # NT

    assert capture_coach_best_times(db, LIVE) == 0


def test_capture_skips_beach_meets(db):
    _live_meet(db, meet_type="BEACH")
    _register(db, 1, 1, 3000)

    assert capture_coach_best_times(db, LIVE) == 0


# ── Refresh from imported results ────────────────────────────────────────────

def test_faster_meet_result_replaces_captured_coach_time(db):
    start = _live_meet(db)
    _register(db, 1, 1, 62000)
    capture_coach_best_times(db, LIVE)

    # Results import archives the meet with the same date as its first session
    db.add(Meet(meetsid=20, name="Live Meet", meetstate=3, course=LCM, mindate=start))
    db.flush()
    _result(db, 1, 60500, start, meetsid=20)
    _result(db, 2, 61000, start, meetsid=20)  # prelim/final: the faster one wins

    assert refresh_best_times_from_meet(db, 20) == 1
    row = db.get(AthleteBestTime, (1, FREE, LCM))
    assert row.time_ms == 60500 and row.entered_date == start
    assert get_best_times_for_member(db, 1)[str(FREE)]["LCM"]["time_ms"] == 60500


def test_slower_meet_result_keeps_coach_time(db):
    _coach(db, 60000, _ago(10))
    db.add(Meet(meetsid=20, name="M", meetstate=3, course=LCM))
    db.flush()
    _result(db, 1, 61000, _ago(5), meetsid=20)

    assert refresh_best_times_from_meet(db, 20) == 0
    assert db.get(AthleteBestTime, (1, FREE, LCM)).time_ms == 60000


def test_older_historical_meet_never_overrides_coach_time(db):
    _coach(db, 60000, _ago(10))
    _result(db, 1, 55000, _ago(100))  # imported old meet, faster

    assert refresh_best_times_from_meet(db, OLD) == 0
    assert db.get(AthleteBestTime, (1, FREE, LCM)).time_ms == 60000


def test_hc_meet_result_does_not_replace_coach_time(db):
    _coach(db, 60000, _ago(10))
    db.add(Meet(meetsid=20, name="M", meetstate=3, course=LCM))
    db.flush()
    _result(db, 1, 50000, _ago(5), meetsid=20, status=4)

    assert refresh_best_times_from_meet(db, 20) == 0


# ── Undated results fall back to their meet's date ───────────────────────────

def test_undated_result_expires_by_its_meet_date(db):
    # Most historical rows have no per-result eventdate, only meets.mindate.
    db.add(Meet(meetsid=30, name="Old champs", meetstate=3, course=LCM, mindate=_ago(30 * 24)))
    db.add(Meet(meetsid=31, name="Recent", meetstate=3, course=LCM, mindate=_ago(40)))
    db.flush()
    _result(db, 1, 55000, None, meetsid=30)  # fast but 2 years old (via its meet)
    _result(db, 2, 64000, None, meetsid=31)

    bt = get_best_times_for_member(db, 1)[str(FREE)]["LCM"]
    assert bt["time_ms"] == 64000
    assert bt["date"] == _ago(40).strftime("%Y-%m-%d")


def test_result_and_meet_both_undated_is_kept(db):
    _result(db, 1, 60000, None)  # OLD meet has no mindate either
    assert get_best_times_for_member(db, 1)[str(FREE)]["LCM"]["time_ms"] == 60000


def test_undated_result_from_older_meet_never_overrides_coach_time(db):
    _coach(db, 60000, _ago(10))
    db.add(Meet(meetsid=30, name="Old champs", meetstate=3, course=LCM, mindate=_ago(100)))
    db.flush()
    _result(db, 1, 55000, None, meetsid=30)

    assert refresh_best_times_from_meet(db, 30) == 0
    assert db.get(AthleteBestTime, (1, FREE, LCM)).time_ms == 60000


def test_undated_result_from_newer_meet_replaces_coach_time_with_meet_date(db):
    _coach(db, 62000, _ago(20))
    db.add(Meet(meetsid=30, name="This meet", meetstate=3, course=LCM, mindate=_ago(5)))
    db.flush()
    _result(db, 1, 60500, None, meetsid=30)

    assert refresh_best_times_from_meet(db, 30) == 1
    row = db.get(AthleteBestTime, (1, FREE, LCM))
    assert row.time_ms == 60500 and row.entered_date == _ago(5)


# ── Beach meets are ranked, not timed ────────────────────────────────────────

BEACH = 601


def _beach_style(db):
    db.add(SwimStyle(swimstyleid=BEACH, code="S601", name="Drapeaux", distance=16, stroke=0, relaycount=1))
    db.flush()


def test_beach_positions_are_never_best_times(db):
    # A beach "result" is a finishing position stored as ms (1st = 1000).
    _beach_style(db)
    _result(db, 1, 1000, _ago(30), style=BEACH)
    _result(db, 2, 61000, _ago(30))  # a real pool time
    db.commit()

    bt = get_best_times_for_member(db, 1)
    assert str(BEACH) not in bt
    assert bt[str(FREE)]["LCM"]["time_ms"] == 61000

    data = get_public_best_times(db)
    assert data["styles"] == [{"uid": FREE, "name": "100 Free"}]
    assert data["clubs"][0]["athletes"][0]["times"] == {"101_LCM": 61000}


def test_athlete_with_only_beach_results_is_not_on_the_public_page(db):
    _beach_style(db)
    _result(db, 1, 2000, _ago(30), style=BEACH)
    db.commit()
    assert get_public_best_times(db)["clubs"] == []


def test_beach_result_never_refreshes_a_coach_row(db):
    _beach_style(db)
    db.add(AthleteBestTime(membersid=1, stylesid=BEACH, course=LCM, time_ms=5000, entered_date=_ago(10)))
    db.add(Meet(meetsid=40, name="Plage", meetstate=3, course=LCM, mindate=_ago(5)))
    db.flush()
    _result(db, 1, 1000, _ago(5), meetsid=40, style=BEACH)

    assert refresh_best_times_from_meet(db, 40) == 0
    assert str(BEACH) not in get_best_times_for_member(db, 1)  # stray beach coach row ignored too
