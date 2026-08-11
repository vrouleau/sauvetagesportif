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

"""Tests for age_group_rules.resolve_matching_age, per Règlements des
compétitions de sauvetage sportif au Québec (Édition septembre 2025),
§1.1-1.3. Mirrors packages/meet-app/tests/age-group-rules.test.ts — same
worked examples (taken directly from the rulebook), independent TS/Python
implementations reading the same config/age-group-rules.json (see that
module's docstring for why they can't share code across the language
boundary)."""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.age_group_rules import resolve_matching_age  # noqa: E402


def test_bumped_to_13_14_despite_being_12_at_season_start():
    # Born 2012-11-15: 12 at 1er septembre 2025, but turns 13 before 31
    # décembre 2025 — the rulebook's own example: bumped to 13-14 for the
    # whole season instead of staying in 11-12.
    assert resolve_matching_age(date(2012, 11, 15), "POOL", 2025) == 13


def test_stays_in_11_12_all_season():
    # Born 2013-02-15: 12 at 1er septembre 2025 and still 12 at 31 décembre
    # 2025 — stays in 11-12 all season.
    assert resolve_matching_age(date(2013, 2, 15), "POOL", 2025) == 12


def test_10_ans_et_moins_locked_at_season_start():
    # Born 2014-12-20: 10 at 1er septembre 2025 (birthday hasn't occurred yet
    # that year), turns 11 on Dec 20 — stays in 10 ans et moins regardless,
    # per the explicit "indépendamment de l'âge atteint au 31 décembre" rule
    # (no Dec-31 spill-up exclusion for this bracket, unlike 11-12).
    assert resolve_matching_age(date(2014, 12, 20), "POOL", 2025) == 10


def test_older_brackets_use_year_end_not_season_start():
    # Born 2010-10-15: only 14 at 1er septembre 2025 (birthday hasn't
    # happened yet), turns 15 on Oct 15 2025. The season-start age (14) is
    # irrelevant here since it's outside the 10-/11-12 bracket group — the
    # matching age is the Dec-31 one (15).
    assert resolve_matching_age(date(2010, 10, 15), "POOL", 2025) == 15


def test_beach_season_uses_may_1_not_september_1():
    # Same shape as the 13-14 bump example above, anchored to the beach
    # season-start date (1er mai) instead of pool's 1er septembre.
    assert resolve_matching_age(date(2012, 11, 15), "BEACH", 2025) == 13
