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

"""scripts/merge_duplicate_athletes.py against the real team-app schema."""
from __future__ import annotations

import csv
import importlib.util
import sqlite3
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base  # noqa: E402
import app.models_team  # noqa: E402,F401  (registers clubs/members/meets/... on Base)

_SCRIPT = Path(__file__).parents[4] / "scripts" / "merge_duplicate_athletes.py"
_spec = importlib.util.spec_from_file_location("merge_duplicate_athletes", _SCRIPT)
merge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(merge)


@pytest.fixture()
def con(tmp_path):
    path = tmp_path / "t.db"
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(bind=engine)
    engine.dispose()
    c = sqlite3.connect(path, isolation_level=None)
    x = c.execute
    x("INSERT INTO clubs (clubsid, name, code) VALUES (1,'A','A'), (2,'B','B')")
    x("INSERT INTO meets (meetsid, name, meetstate) VALUES (1,'M1',3), (2,'M2',3)")
    x("INSERT INTO swimstyle (swimstyleid, name) VALUES (501,'S')")
    x("INSERT INTO members (membersid, firstname, lastname, clubsid, license, birthdate) VALUES "
      "(10,'Jo','Roy',1,'',NULL), (20,'Jo','Roy',2,'L20','2005-01-01 00:00:00'), (30,'','',1,'',NULL)")
    x("INSERT INTO membersmeets (membersid, meetsid, clubsid) VALUES (10,1,1), (20,1,2), (20,2,2), (30,1,1)")
    x("INSERT INTO results (resultsid, membersid, meetsid, stylesid, eventnumb, totaltime) VALUES "
      "(1,10,1,501,1,60000), (2,20,1,501,1,60000), (3,20,2,501,1,59000)")
    x("INSERT INTO relays (relaysid, meetsid, clubsid) VALUES (7,1,1)")
    x("INSERT INTO relayspos (relaysid, numb, membersid) VALUES (7,1,10), (7,2,20)")
    x("INSERT INTO athlete_best_times (membersid, stylesid, course, time_ms, entered_date) VALUES "
      "(10,501,1,61000,'2025-01-01 00:00:00'), (20,501,1,58000,'2026-01-01 00:00:00')")
    yield c
    c.close()


def test_merge_moves_everything_and_resolves_clashes(con):
    con.execute("BEGIN")
    merge.run(con, [(10, [20])], [30], delete_blank=True, log=lambda *_: None)
    con.execute("COMMIT")
    q = lambda s: con.execute(s).fetchall()  # noqa: E731

    assert q("SELECT membersid FROM members ORDER BY membersid") == [(10,)]
    # identical result (same meet/style/event/time) dropped, the other moved
    assert q("SELECT resultsid, membersid FROM results ORDER BY resultsid") == [(1, 10), (3, 10)]
    # meet 1 already linked -> dropped; meet 2 moved with the club it was swum for
    assert q("SELECT meetsid, clubsid FROM membersmeets ORDER BY meetsid") == [(1, 1), (2, 2)]
    # keeper already on relay 7 -> the duplicate's slot is emptied
    assert q("SELECT numb, membersid FROM relayspos ORDER BY numb") == [(1, 10), (2, None)]
    # best-time clash: most recently entered wins
    assert q("SELECT membersid, time_ms FROM athlete_best_times") == [(10, 58000)]
    # keeper's empty fields filled, own club kept
    assert q("SELECT license, substr(birthdate,1,10), clubsid FROM members") == [("L20", "2005-01-01", 1)]


def test_plan_requires_exactly_one_keeper(tmp_path):
    plan = tmp_path / "plan.csv"
    with open(plan, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["group", "label", "suggest_keep", "membersid"])
        w.writerows([["A", "jo roy", "", "10"], ["A", "jo roy", "", "20"]])
    with pytest.raises(SystemExit, match="exactly one"):
        merge.load_plan(str(plan))
