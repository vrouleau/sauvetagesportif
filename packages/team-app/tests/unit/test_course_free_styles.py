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

"""Throws from the deck (pool style, 0 < distance < 25 m: "Lancer de
précision", "Lancer de la corde") don't depend on the pool's length: one best
time across both courses. Plus the catalog correction that makes the distance
rule usable (meet uploads fix styles historical imports created half-empty).
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
from app import models_live, models_serc  # noqa: F401 — register all tables
from app.models_team import Meet, Result, TeamClub, Member, AthleteBestTime
from app.events import load_events
from app.best_times import (
    course_free_style_ids, get_best_times_for_member, get_public_best_times,
    get_best_time, capture_coach_best_times, refresh_best_times_from_meet,
)

POOL_TEMPLATE = Path(__file__).resolve().parent.parent.parent.parent.parent / "config" / "template_pool.lxf"
LCM, SCM = 1, 3
THROW, SWIM, SERC = 522, 504, 530


def _ago(days: int) -> datetime:
    return datetime.combine(date.today() - timedelta(days=days), datetime.min.time())


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    s.add(TeamClub(clubsid=1, name="Alpha", code="ALP"))
    s.add_all([
        SwimStyle(swimstyleid=THROW, name="7 m Lancer de précision", distance=7, relaycount=1),
        SwimStyle(swimstyleid=SWIM, name="50 m Portage", distance=50, relaycount=1),
        SwimStyle(swimstyleid=SERC, name="SERC", distance=0, relaycount=4),
        SwimStyle(swimstyleid=601, name="Drapeaux", distance=16, relaycount=1),  # beach: participants/heat
    ])
    s.flush()
    s.add(Member(membersid=1, firstname="Ann", lastname="Alpha", clubsid=1, gender=2))
    s.add(Meet(meetsid=1, name="Old", meetstate=3, course=LCM))
    s.flush()
    yield s
    s.close()
    engine.dispose()


def _result(db, rid, ms, when, course, style=THROW, meetsid=1):
    db.add(Result(resultsid=rid, membersid=1, meetsid=meetsid, stylesid=style, course=course,
                  totaltime=ms, resulttyp=0, eventdate=when))
    db.flush()


# ── Which styles are course-free ─────────────────────────────────────────────

def test_only_short_pool_styles_are_course_free(db):
    # 504 (50 m) no; SERC (distance 0 = unknown) no; beach 601 (16 = per heat) no.
    assert course_free_style_ids(db) == {THROW}


# ── One best time across both courses ────────────────────────────────────────

def test_throw_best_time_is_the_fastest_across_courses(db):
    _result(db, 1, 30000, _ago(40), LCM)
    _result(db, 2, 28000, _ago(90), SCM)  # faster, at a 25 m meet

    bt = get_best_times_for_member(db, 1)[str(THROW)]
    assert bt == {"SCM": {"time_ms": 28000, "date": _ago(90).strftime("%Y-%m-%d"), "source": "result"}}
    # Whatever course is asked for, the throw's one best time comes back.
    assert get_best_time(db, 1, THROW, "LCM") == 28000


def test_a_normal_style_keeps_separate_courses(db):
    _result(db, 1, 45000, _ago(40), LCM, style=SWIM)
    _result(db, 2, 42000, _ago(40), SCM, style=SWIM)
    bt = get_best_times_for_member(db, 1)[str(SWIM)]
    assert bt["LCM"]["time_ms"] == 45000 and bt["SCM"]["time_ms"] == 42000
    assert get_best_time(db, 1, SWIM, "LCM") == 45000


def test_latest_coach_value_wins_across_courses(db):
    db.add_all([
        AthleteBestTime(membersid=1, stylesid=THROW, course=SCM, time_ms=27000, entered_date=_ago(200)),
        AthleteBestTime(membersid=1, stylesid=THROW, course=LCM, time_ms=29500, entered_date=_ago(20)),
    ])
    _result(db, 1, 25000, _ago(100), SCM)  # faster history: coach still authoritative
    db.flush()
    bt = get_best_times_for_member(db, 1)[str(THROW)]
    assert list(bt) == ["LCM"] and bt["LCM"]["time_ms"] == 29500 and bt["LCM"]["source"] == "coach"


def test_public_page_flags_course_free_styles(db):
    _result(db, 1, 28000, _ago(90), SCM)
    _result(db, 2, 45000, _ago(40), LCM, style=SWIM)
    db.commit()
    styles = {s["uid"]: s["course_free"] for s in get_public_best_times(db)["styles"]}
    assert styles == {SWIM: False, THROW: True}


# ── Capture / refresh across courses ─────────────────────────────────────────

def _live_meet_registered(db, course_str, entry_ms):
    db.add(Meet(meetsid=10, name="Live", meetstate=0, meet_type="POOL", registration_open=True))
    db.flush()
    db.add(MeetConfig(meetsid=10, name="meet_course", data=course_str))
    db.add(SwimSession(swimsessionid=1, meetsid=10, startdate=_ago(5)))
    db.add(SwimEvent(meetsid=10, swimeventid=1, swimsessionid=1, swimstyleid=THROW, eventnumber=1))
    db.flush()
    db.add(SwimResult(swimresultid=1, meetsid=10, athleteid=1, swimeventid=1, age_code="Open", entrytime=entry_ms))
    db.flush()


def test_prefilled_throw_entry_from_other_course_is_not_captured(db):
    # 50 m meet; the only history is a 25 m throw — the pre-filled entry time
    # is that value, so nothing new to store.
    _result(db, 1, 28000, _ago(90), SCM)
    _live_meet_registered(db, "LCM", 28000)
    assert capture_coach_best_times(db, 10) == 0


def test_faster_throw_result_lowers_a_coach_value_stored_under_the_other_course(db):
    db.add(AthleteBestTime(membersid=1, stylesid=THROW, course=SCM, time_ms=30000, entered_date=_ago(30)))
    db.add(Meet(meetsid=20, name="50 m meet", meetstate=3, course=LCM, mindate=_ago(5)))
    db.flush()
    _result(db, 1, 27500, _ago(5), LCM, meetsid=20)

    assert refresh_best_times_from_meet(db, 20) == 1
    row = db.get(AthleteBestTime, (1, THROW, SCM))
    assert row.time_ms == 27500 and row.entered_date == _ago(5)


# ── With a corrected catalog (see test_swimstyle_catalog.py) ─────────────────

def test_corrected_catalog_recognizes_throws_but_not_line_throw(db):
    db.add_all([
        SwimStyle(swimstyleid=521, name="4 m Lancer", distance=None, relaycount=1),
        SwimStyle(swimstyleid=523, name="10 m Lancer de la corde", distance=None, relaycount=1),
    ])
    db.commit()
    assert 521 not in course_free_style_ids(db)  # unknown distance: not recognized
    load_events(db, POOL_TEMPLATE)
    db.commit()
    # 521 is an individual throw; 523 (line throw) is a team of 2: never a best time.
    assert 521 in course_free_style_ids(db) and 523 not in course_free_style_ids(db)


def test_team_events_never_have_best_times(db):
    # Line throw is a team of 2: no best time, no column — even if a file
    # recorded a team time per athlete.
    db.add(SwimStyle(swimstyleid=524, name="12.5m Lancer de la corde", distance=12, relaycount=2))
    db.flush()
    _result(db, 1, 15000, _ago(30), SCM, style=524)
    _result(db, 2, 28000, _ago(30), SCM)  # precision throw (individual) still counts
    db.commit()

    assert str(524) not in get_best_times_for_member(db, 1)
    assert 524 not in course_free_style_ids(db)
    styles = {s["uid"] for s in get_public_best_times(db)["styles"]}
    assert styles == {THROW}
