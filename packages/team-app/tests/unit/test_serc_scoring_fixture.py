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

"""Cross-language drift test for the SERC weighted-total formula.

compute_serc_total() (backend/app/routers/serc.py) and computeSercTotal()
(frontend/src/sercScoring.js) implement the identical formula in Python and
JS — can't share a module across that boundary, so both are tested against
the same fixture (tests/fixtures/serc_scoring.json). The JS side is checked
by frontend/src/sercScoring.test.js (vitest).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.routers.serc import compute_serc_total  # noqa: E402

FIXTURE_PATH = Path(__file__).parent.parent / "fixtures" / "serc_scoring.json"
with open(FIXTURE_PATH, encoding="utf-8") as f:
    FIXTURE = json.load(f)


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["note"])
def test_compute_serc_total(case):
    result = compute_serc_total(
        case["scores"],
        case["overallFactors"],
        case["bystanderFactors"],
        case["victimFactors"],
        case["hasBystander"],
        case["numVictims"],
    )
    assert result == pytest.approx(case["expectedTotal"]), case["note"]
