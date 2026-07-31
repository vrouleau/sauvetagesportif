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

"""Cross-language drift test for the relay age-composition rule.

_age_code_allowed_on_team / _would_miss_native_anchor (this file) are a Python
port of the TS functions in shared-ui/src/logic/relayRules.ts (used by
meet-app's main process and RelayEntryPage.tsx) — the two can't share a module
across the language boundary, so both test suites iterate the same fixture
(tests/fixtures/relay_age_rules.json) instead. See
docs/SHARED_LOGIC_CONSOLIDATION_PLAN.md.

Python's _age_code_allowed_on_team doesn't take an `order` parameter — it's
always checked against the fixed _AGE_CODE_ORDER tuple, which is exactly what
the fixture's "order" field lists, so both languages exercise the same rule.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.routers.api import (  # noqa: E402
    _AGE_CODE_ORDER,
    _age_code_allowed_on_team,
    _would_miss_native_anchor,
)

FIXTURE_PATH = Path(__file__).parent.parent / "fixtures" / "relay_age_rules.json"
with open(FIXTURE_PATH, encoding="utf-8") as f:
    FIXTURE = json.load(f)


def test_order_matches_python_constant():
    assert list(_AGE_CODE_ORDER) == FIXTURE["order"]


@pytest.mark.parametrize(
    "case",
    FIXTURE["isAgeCodeAllowedOnTeam"],
    ids=lambda c: f"{c['candidateCode']}_on_{c['nativeCode']}_team",
)
def test_age_code_allowed_on_team(case):
    assert _age_code_allowed_on_team(case["candidateCode"], case["nativeCode"]) == case["expected"], case["note"]


@pytest.mark.parametrize(
    "case",
    FIXTURE["wouldMissNativeAnchor"],
    ids=lambda c: f"{c['candidateCode']}_native_{c['nativeCode']}_remaining_{c['remainingAfterThis']}",
)
def test_would_miss_native_anchor(case):
    result = _would_miss_native_anchor(
        case["otherAssignedCodes"], case["candidateCode"], case["nativeCode"], case["remainingAfterThis"]
    )
    assert result == case["expected"], case["note"]
