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
"""Tests for backend/app/age_codes.py (age-group bounds <-> category codes)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.age_codes import age_group_code, relay_age_code, age_code_to_range  # noqa: E402

CATEGORIES = [
    ((0, 10), "10-"), ((8, 10), "10-"), ((11, 12), "11-12"), ((13, 14), "13-14"),
    ((15, 18), "15-18"), ((19, 99), "Open"), ((19, -1), "Open"), ((19, 120), "Open"),
]


@pytest.mark.parametrize("bounds,code", CATEGORIES)
def test_known_bounds_agree_in_both_flavors(bounds, code):
    assert age_group_code(*bounds) == code
    assert relay_age_code(*bounds) == code


def test_agegroup_flavor_is_strict():
    assert age_group_code(12, 14) is None
    assert age_group_code(0, 0) is None


def test_relay_flavor_always_labels():
    assert relay_age_code(0, 0) == "Open"        # unset
    assert relay_age_code(None, None) == "Open"
    assert relay_age_code(19, 0) == "Open"
    assert relay_age_code(12, 14) == "12-14"
    assert relay_age_code(30, 0) == "30-"


@pytest.mark.parametrize("code,expected", [
    ("10-", (0, 10)), ("11-12", (11, 12)), ("13-14", (13, 14)), ("15-18", (15, 18)),
    ("Open", (19, None)), ("Masters", (25, None)), ("12-14", (12, 14)), ("30-", (30, None)),
    ("weird", (0, None)),
])
def test_age_code_to_range(code, expected):
    assert age_code_to_range(code) == expected


@pytest.mark.parametrize("code", ["10-", "11-12", "13-14", "15-18"])
def test_round_trip(code):
    assert age_group_code(*age_code_to_range(code)) == code
