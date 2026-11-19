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
"""LENEX GENDER attribute -> our gender encoding (models.LENEX_GENDER)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import LENEX_GENDER, GENDER_ALL, GENDER_M, GENDER_F, GENDER_MIXED  # noqa: E402
from app.meet_parser import MeetEvent  # noqa: E402


def test_mapping():
    assert LENEX_GENDER == {"ALL": GENDER_ALL, "M": GENDER_M, "F": GENDER_F,
                            "MIXED": GENDER_MIXED, "X": GENDER_MIXED}


@pytest.mark.parametrize("raw,expected", [
    ("ALL", 0), ("M", 1), ("f", 2), ("MIXED", 3), ("x", 3), ("", 0), ("??", 0),
])
def test_meet_event_gender_defaults_to_all(raw, expected):
    ev = MeetEvent(eventid=1, number=1, gender=raw, round="TIM", event_type="",
                   swimstyleid=500, distance=50, relaycount=1, style_name="Free")
    assert ev.gender_int == expected
