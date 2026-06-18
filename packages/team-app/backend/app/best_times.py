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

Best time = fastest totaltime per (member, style, course) from the RESULTS table.
Expiry: results older than N months are excluded.
"""
from __future__ import annotations

import re
from datetime import date
from sqlalchemy import func
from sqlalchemy.orm import Session

from .models_team import Result, Member, TeamClub


# --- Core query functions ---


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
            Result.resulttyp == 0,
        )
        .group_by(Result.stylesid, Result.course)
        .all()
    )

    result: dict[str, dict] = {}
    for row in rows:
        if row.best_date and row.best_date.date() < cutoff:
            continue

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


# Alias for backward compatibility
get_best_times = get_best_times_for_member


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

    row = (
        db.query(
            func.min(Result.totaltime).label("best"),
            func.max(Result.eventdate).label("best_date"),
        )
        .filter(
            Result.membersid == member_id,
            Result.stylesid == style_id,
            Result.course == course_int,
            Result.totaltime.isnot(None),
            Result.totaltime > 0,
            Result.resulttyp == 0,
        )
        .first()
    )

    if not row or not row.best:
        return None

    if row.best_date and row.best_date.date() < cutoff:
        return None

    return row.best


def get_best_time_date(
    db: Session,
    member_id: int,
    style_id: int,
    course: str,
    max_age_months: int = 18,
) -> date | None:
    """Get the date of the best time for a specific member/style/course."""
    course_int = _course_int(course)
    if course_int is None:
        return None

    cutoff = _cutoff_date(max_age_months)

    best_time = (
        db.query(func.min(Result.totaltime))
        .filter(
            Result.membersid == member_id,
            Result.stylesid == style_id,
            Result.course == course_int,
            Result.totaltime.isnot(None),
            Result.totaltime > 0,
            Result.resulttyp == 0,
        )
        .scalar()
    )

    if not best_time:
        return None

    row = (
        db.query(Result.eventdate)
        .filter(
            Result.membersid == member_id,
            Result.stylesid == style_id,
            Result.course == course_int,
            Result.totaltime == best_time,
            Result.resulttyp == 0,
        )
        .order_by(Result.eventdate.desc())
        .first()
    )

    if not row or not row.eventdate:
        return None

    result_date = row.eventdate.date()
    if result_date < cutoff:
        return None

    return result_date


# --- Shared utilities (used by historical_import.py) ---


def _lenex_time_to_ms(t: str) -> int | None:
    """Convert Lenex time 'HH:MM:SS.hh' or 'MM:SS.hh' to ms."""
    if not t or t == "NT":
        return None
    m = re.match(r"(\d+):(\d+):(\d+)\.(\d+)", t)
    if m:
        return (int(m.group(1)) * 3600000 + int(m.group(2)) * 60000
                + int(m.group(3)) * 1000 + int(m.group(4)) * 10)
    m = re.match(r"(\d+):(\d+)\.(\d+)", t)
    if m:
        return (int(m.group(1)) * 60000 + int(m.group(2)) * 1000
                + int(m.group(3)) * 10)
    m = re.match(r"(\d+)\.(\d+)", t)
    if m:
        return int(m.group(1)) * 1000 + int(m.group(2)) * 10
    return None


def _find_or_create_athlete(db: Session, first: str, last: str, license: str, club=None) -> Member | None:
    """Match athlete by license first, then name. Create if not found and club provided."""
    if license:
        member = db.query(Member).filter(Member.license == license).first()
        if member:
            return member
    member = db.query(Member).filter(
        Member.firstname == first, Member.lastname == last
    ).first()
    if member:
        return member
    if not club:
        return None
    member = Member(firstname=first, lastname=last, gender=1, clubsid=club.clubsid, license=license)
    db.add(member)
    db.flush()
    return member


# --- Internal helpers ---


def _cutoff_date(max_age_months: int) -> date:
    """Calculate the cutoff date for expiry."""
    today = date.today()
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
