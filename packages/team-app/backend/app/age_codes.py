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

"""Age-group bounds <-> age codes ("10-", "11-12", "13-14", "15-18", "Open", "Masters").

The canonical category codes shared with shared-ui's ageGroupCode.ts. Two
bounds -> code flavors on purpose: agegroup rows (strict, None when the bounds
aren't one of our categories) and relay rows (lenient, always a code — relay
minage/maxage may be 0 for "unset" and odd bounds still need a label).
"""
from __future__ import annotations


def age_group_code(age_min: int, age_max: int) -> str | None:
    """Category code of an agegroup's bounds, None when they match no category."""
    if age_min <= 10 and age_max == 10:
        return "10-"
    if age_min == 11 and age_max == 12:
        return "11-12"
    if age_min == 13 and age_max == 14:
        return "13-14"
    if age_min == 15 and age_max == 18:
        return "15-18"
    if age_min == 19 and (age_max == -1 or age_max >= 99):
        return "Open"
    return None


def relay_age_code(minage: int | None, maxage: int | None) -> str:
    """Category code of a relay's minage/maxage. Never None: 0/0 (unset) is
    "Open", and unknown bounds become "<min>-<max>" (or "<min>-" if open-ended)."""
    minage = minage or 0
    maxage = maxage or 0
    if minage <= 10 and maxage == 10:
        return "10-"
    if minage == 11 and maxage == 12:
        return "11-12"
    if minage == 13 and maxage == 14:
        return "13-14"
    if minage == 15 and maxage == 18:
        return "15-18"
    if minage == 19 and (maxage == 0 or maxage == -1 or maxage >= 99):
        return "Open"
    if minage == 0 and (maxage == 0 or maxage == -1 or maxage is None):
        return "Open"
    # Fallback: construct from values
    if maxage and maxage > 0 and maxage < 99:
        return f"{minage}-{maxage}"
    return f"{minage}-"


def age_code_to_range(age_code: str) -> tuple[int, int | None]:
    """Convert an age code string to (minage, maxage). maxage=None means open-ended."""
    if age_code == "10-":
        return (0, 10)
    if age_code == "11-12":
        return (11, 12)
    if age_code == "13-14":
        return (13, 14)
    if age_code == "15-18":
        return (15, 18)
    if age_code == "Open":
        return (19, None)
    if age_code == "Masters":
        return (25, None)
    # Try to parse "X-Y" or "X-"
    parts = age_code.split("-")
    if len(parts) == 2:
        minage = int(parts[0]) if parts[0] else 0
        maxage = int(parts[1]) if parts[1] else None
        return (minage, maxage)
    return (0, None)
