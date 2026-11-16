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

"""Pre-import guards for a meet-closing results import (lxf_to_team.py):
count_results_in_lxf (is it a results file?) and meet_mismatch (is it the
open meet's file?)."""
from __future__ import annotations

import sys
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimEvent, MeetConfig
from app.models_team import Meet
from app.lxf_to_team import count_results_in_lxf, meet_mismatch

OPEN = 10


def _lef(meet_name: str, results: list[tuple[int, str | None, str | None]], entries_only: bool = False) -> ET.Element:
    """results: (eventid, swimtime, status)."""
    rs = "".join(
        f'<RESULT eventid="{eid}"' + (f' swimtime="{t}"' if t else "") + (f' status="{st}"' if st else "") + " />"
        for eid, t, st in results
    )
    entries = '<ENTRIES><ENTRY eventid="1" entrytime="00:00:41.43" /></ENTRIES>'
    body = entries if entries_only else f"<RESULTS>{rs}</RESULTS>"
    return ET.fromstring(
        f'<LENEX><MEETS><MEET name="{meet_name}"><CLUBS><CLUB><ATHLETES>'
        f'<ATHLETE firstname="A" lastname="B">{body}</ATHLETE>'
        f"</ATHLETES></CLUB></CLUBS></MEET></MEETS></LENEX>"
    )


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    s.add(Meet(meetsid=OPEN, name="Invitation Novembre", meetstate=0, registration_open=True))
    s.flush()
    s.add(MeetConfig(meetsid=OPEN, name="meet_name", data="Invitation Novembre"))
    s.add_all([SwimEvent(meetsid=OPEN, swimeventid=i, eventnumber=i) for i in (1, 2, 3, 4)])
    s.flush()
    yield s
    s.close()
    engine.dispose()


# ── Is it a results file? ────────────────────────────────────────────────────

def test_entries_file_has_no_results():
    assert count_results_in_lxf(_lef("X", [], entries_only=True)) == 0


def test_results_without_time_or_status_do_not_count():
    assert count_results_in_lxf(_lef("X", [(1, None, None), (2, "NT", None)])) == 0


def test_times_and_statuses_count():
    root = _lef("X", [(1, "00:00:43.00", None), (2, None, "DSQ"), (3, None, "dns"), (4, None, None)])
    assert count_results_in_lxf(root) == 3


# ── Is it the open meet's file? ──────────────────────────────────────────────

def test_same_meet_passes(db):
    root = _lef("  invitation   NOVEMBRE ", [(1, "00:00:43.00", None), (2, "00:01:10.00", None)])
    assert meet_mismatch(db, root, OPEN) is None


def test_other_meet_name_is_flagged(db):
    root = _lef("Championnat 2025", [(1, "00:00:43.00", None), (2, "00:01:10.00", None)])
    d = meet_mismatch(db, root, OPEN)
    assert d["code"] == "meet_mismatch"
    assert d["file_meet"] == "Championnat 2025" and d["open_meet"] == "Invitation Novembre"
    assert (d["events_matched"], d["events_in_file"]) == (2, 2)


def test_same_name_but_foreign_event_ids_is_flagged(db):
    # e.g. last year's edition of the same meet: same name, other event ids
    root = _lef("Invitation Novembre", [(901, "00:00:43.00", None), (902, None, "DSQ"), (1, "00:01:00.00", None)])
    d = meet_mismatch(db, root, OPEN)
    assert d is not None and (d["events_matched"], d["events_in_file"]) == (1, 3)


def test_half_or_more_events_matching_passes(db):
    root = _lef("Invitation Novembre", [(1, "00:00:43.00", None), (999, "00:01:00.00", None)])
    assert meet_mismatch(db, root, OPEN) is None


def test_no_open_meet_means_nothing_to_compare(db):
    assert meet_mismatch(db, _lef("Anything", [(1, "00:00:43.00", None)]), None) is None
