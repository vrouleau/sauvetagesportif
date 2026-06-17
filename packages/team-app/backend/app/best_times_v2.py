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

"""Best times computed from historical results (Team Manager schema).

Replaces the JSON-blob approach in bsglobal with a direct query across
all RESULTS rows. Best time = fastest totaltime per (member, style, course).

Expiry: results older than N months are excluded.
"""
from __future__ import annotations

from datetime import date, timedelta
from sqlalchemy import func, and_
from sqlalchemy.orm import Session

from .models_team import Result


def get_best_times_for_member(
    db: Session,
    member_id: int,
    max_age_months: int = 18,
) -> dict[str, dict]:
    """Return best times for a member from historical results.

    Returns: {
        "{stylesid}": {
            "LCM": {"time_ms": int, "date": str},
            "SCM": {"time_ms": int, "date": str},
        }
    }
    """
    cutoff = _cutoff_date(max_age_months)

    rows = (
        db.query(
            Result.stylesid,
            Result.course,
            func.min(Result.totaltime).label("best_time"),
            func.max(Result.eventdate).label("best_date"),
        )
        .filter(
            Result.membersid == member_id,
            Result.totaltime.isnot(None),
            Result.totaltime > 0,
            Result.resulttyp == 0,  # official results only
        )
        .group_by(Result.stylesid, Result.course)
        .all()
    )

    result: dict[str, dict] = {}
    for row in rows:
        if row.best_date and row.best_date.date() < cutoff:
            continue  # expired

        style_key = str(row.stylesid)
        course_key = _course_str(row.course)
        if not course_key:
            continue

        if style_key not in result:
            result[style_key] = {}

        result[style_key][course_key] = {
            "time_ms": row.best_time,
            "date": row.best_date.strftime("%Y-%m-%d") if row.best_date else None,
        }

    return result


def get_best_time(
    db: Session,
    member_id: int,
    style_id: int,
    course: str,
    max_age_months: int = 18,
) -> int | None:
    """Get the best time for a specific member/style/course combination."""
    cutoff = _cutoff_date(max_age_months)
    course_int = _course_int(course)
    if course_int is None:
        return None

    filters = [
        Result.membersid == member_id,
        Result.stylesid == style_id,
        Result.course == course_int,
        Result.totaltime.isnot(None),
        Result.totaltime > 0,
        Result.resulttyp == 0,
    ]

    row = (
        db.query(
            func.min(Result.totaltime).label("best"),
            func.max(Result.eventdate).label("best_date"),
        )
        .filter(*filters)
        .first()
    )

    if not row or not row.best:
        return None

    # Check expiry
    if row.best_date and row.best_date.date() < cutoff:
        return None

    return row.best


def _cutoff_date(max_age_months: int) -> date:
    """Calculate the cutoff date for expiry."""
    today = date.today()
    # Approximate: subtract months
    year = today.year
    month = today.month - max_age_months
    while month <= 0:
        month += 12
        year -= 1
    return date(year, month, today.day if today.day <= 28 else 28)


def _course_str(course_int: int | None) -> str | None:
    """Convert course integer to string."""
    if course_int == 1:
        return "LCM"
    if course_int == 2:
        return "SCY"
    if course_int == 3:
        return "SCM"
    return None


def _course_int(course_str: str) -> int | None:
    """Convert course string to integer."""
    if course_str == "LCM":
        return 1
    if course_str == "SCY":
        return 2
    if course_str == "SCM":
        return 3
    return None