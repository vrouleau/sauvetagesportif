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

"""Printable entries report (entries_print.build_entries_html): club and
section filtering used by the Individual / Relay entries pages' Print button
(a coach only sees their own club; each page prints its own section).

In-memory SQLite — no Docker required.
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimEvent, SwimResult, SwimSession, SwimStyle, GENDER_M, GENDER_MIXED
from app.models_team import TeamClub, Member, Relay, RelayPos, Meet
from app.routers.entries_print import build_entries_html


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    s = sessionmaker(bind=engine)()
    s.add(Meet(meetsid=1, name="Test Meet", registration_open=True))
    s.add_all([
        TeamClub(clubsid=1, name="Alpha Club", code="ALP", pin="111111"),
        TeamClub(clubsid=2, name="Bravo Club", code="BRV", pin="222222"),
        SwimStyle(swimstyleid=501, distance=50, stroke=1, relaycount=1, name="50 Obstacles"),
        SwimStyle(swimstyleid=510, distance=200, stroke=1, relaycount=4, name="4x50 Obstacles"),
        SwimSession(swimsessionid=1, meetsid=1, name="S1", sessionnumber=1),
        SwimEvent(swimeventid=10, meetsid=1, swimsessionid=1, swimstyleid=501,
                  gender=GENDER_M, eventnumber=1),
        SwimEvent(swimeventid=20, meetsid=1, swimsessionid=1, swimstyleid=510,
                  gender=GENDER_MIXED, eventnumber=2),
        Member(membersid=1, firstname="Ann", lastname="Alphaname", gender=GENDER_M,
               birthdate=datetime(2008, 1, 1), clubsid=1),
        Member(membersid=2, firstname="Bob", lastname="Bravoname", gender=GENDER_M,
               birthdate=datetime(2008, 1, 1), clubsid=2),
    ])
    s.flush()
    s.add_all([
        SwimResult(meetsid=1, athleteid=1, swimeventid=10, entrytime=31000),
        SwimResult(meetsid=1, athleteid=2, swimeventid=10, entrytime=32000),
        Relay(relaysid=1, meetsid=1, clubsid=1, stylesid=510, teamnumb=1, eventnumb=2,
              name="AlphaRelay", minage=15, maxage=18),
        Relay(relaysid=2, meetsid=1, clubsid=2, stylesid=510, teamnumb=1, eventnumb=2,
              name="BravoRelay", minage=15, maxage=18),
        RelayPos(relaysid=1, numb=1, membersid=1),
        RelayPos(relaysid=2, numb=1, membersid=2),
    ])
    s.commit()
    yield s
    s.close()
    engine.dispose()


def test_all_clubs_all_sections(db):
    html = build_entries_html(db, 1, "en")
    for text in ("Alpha Club", "Bravo Club", "Individual entries", "Relay entries",
                 "AlphaRelay", "BravoRelay", "31.00", "32.00"):
        assert text in html


def test_coach_club_only(db):
    html = build_entries_html(db, 1, "en", club_id=1)
    assert "Alpha Club" in html and "AlphaRelay" in html and "Alphaname" in html
    assert "Bravo Club" not in html and "BravoRelay" not in html and "Bravoname" not in html


def test_individual_section_only(db):
    html = build_entries_html(db, 1, "en", club_id=1, section="individual")
    assert "Individual entries" in html and "31.00" in html
    assert "Relay entries" not in html and "AlphaRelay" not in html


def test_relay_section_only(db):
    html = build_entries_html(db, 1, "en", section="relays")
    assert "Relay entries" in html and "AlphaRelay" in html and "BravoRelay" in html
    assert "Individual entries" not in html and "31.00" not in html


def test_coach_with_no_entries_still_gets_their_club_page(db):
    db.query(RelayPos).delete()
    db.query(Relay).delete()
    db.commit()
    html = build_entries_html(db, 1, "fr", club_id=2, section="relays")
    assert "Bravo Club" in html and "Aucune inscription relais." in html
    assert "Alpha Club" not in html


def test_individual_entry_counts_skip_team_events(db):
    """`entry_count` on /api/athletes marks athletes on the Individual entries
    page — team-event rows (relaycount > 1) must not count."""
    from app.routers.api import _individual_entry_counts
    db.add(SwimResult(meetsid=1, athleteid=2, swimeventid=20))  # team style
    db.add(Member(membersid=3, firstname="Cy", lastname="Nobody", gender=GENDER_M,
                  birthdate=datetime(2008, 1, 1), clubsid=1))
    db.commit()
    counts = _individual_entry_counts(db, 1)
    assert counts == {1: 1, 2: 1}
    assert _individual_entry_counts(db, None) == {}
