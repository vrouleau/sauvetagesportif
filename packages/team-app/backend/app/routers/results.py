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

"""Public results API — historical meets and best times."""
from __future__ import annotations

import os

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session, joinedload

from ..database import get_db
from ..models import SwimStyle
from ..models_team import Meet, Result, Member, TeamClub
from ..best_times import get_best_times_for_member

router = APIRouter(prefix="/api/results")

_BEST_TIME_MAX_AGE_MONTHS = int(os.environ.get("BEST_TIME_MAX_AGE_MONTHS", "18"))


@router.get("/meets")
def list_meets(db: Session = Depends(get_db)):
    """List all historical (completed) meets."""
    meets = db.query(Meet).filter(Meet.meetstate == 3).order_by(Meet.maxdate.desc()).all()
    return [
        {
            "id": m.meetsid,
            "name": m.name,
            "place": m.place,
            "date": m.maxdate.strftime("%Y-%m-%d") if m.maxdate else None,
            "course": {1: "LCM", 2: "SCY", 3: "SCM"}.get(m.course, "LCM"),
        }
        for m in meets
    ]


@router.get("/meets/{meet_id}")
def get_meet_results(meet_id: int, db: Session = Depends(get_db)):
    """All results for a historical meet, grouped by event number."""
    meet = db.query(Meet).get(meet_id)
    if not meet:
        from fastapi import HTTPException
        raise HTTPException(404, "Meet not found")

    results = (
        db.query(Result)
        .filter(Result.meetsid == meet_id, Result.totaltime.isnot(None), Result.totaltime > 0)
        .order_by(Result.eventnumb, Result.totaltime)
        .all()
    )

    # Group by event number
    events: dict[int, list] = {}
    for r in results:
        evnum = r.eventnumb or 0
        if evnum not in events:
            events[evnum] = []

        member = db.query(Member).get(r.membersid) if r.membersid else None
        club = db.query(TeamClub).get(member.clubsid) if member and member.clubsid else None

        events[evnum].append({
            "athlete_name": f"{member.lastname}, {member.firstname}" if member else "?",
            "club_name": club.name if club else "",
            "time_ms": r.totaltime,
            "rank": r.rank,
        })

    return {
        "meet_id": meet_id,
        "meet_name": meet.name,
        "events": events,
    }


@router.get("/best-times")
def best_times_public(db: Session = Depends(get_db)):
    """Best times per athlete, grouped by club, computed from historical results
    (same source as the per-athlete registration page — see best_times.py)."""
    from ..models import BsGlobal

    # Members with at least one qualifying historical result
    member_ids = [
        row[0] for row in db.query(Result.membersid).filter(
            Result.membersid.isnot(None),
            Result.totaltime.isnot(None),
            Result.totaltime > 0,
            Result.resulttyp == 0,
        ).distinct().all()
    ]

    all_uids: set[int] = set()
    athlete_bt: dict[int, dict] = {}
    for member_id in member_ids:
        bt_data = get_best_times_for_member(db, member_id, _BEST_TIME_MAX_AGE_MONTHS)
        if not bt_data:
            continue
        athlete_bt[member_id] = bt_data
        for uid_key in bt_data:
            all_uids.add(int(uid_key))

    style_uids = sorted(all_uids)
    styles = []
    for uid in style_uids:
        style = db.query(SwimStyle).get(uid)
        name = style.name if style else f"ID{uid}"
        styles.append({"uid": uid, "name": name})

    # Load athletes with clubs
    athlete_ids = list(athlete_bt.keys())
    athletes_db = db.query(Member).options(
        joinedload(Member.club)
    ).filter(Member.membersid.in_(athlete_ids)).all() if athlete_ids else []
    athlete_map = {a.membersid: a for a in athletes_db}

    # Group by club
    clubs_map: dict[int, dict] = {}
    for athlete_id, bt_data in athlete_bt.items():
        a = athlete_map.get(athlete_id)
        if not a or not a.club:
            continue
        c = a.club
        if c.clubsid not in clubs_map:
            clubs_map[c.clubsid] = {"name": c.name, "athletes": []}
        times = {}
        for uid_str, style_data in bt_data.items():
            if "LCM" in style_data:
                times[f"{uid_str}_LCM"] = style_data["LCM"]["time_ms"]
            if "SCM" in style_data:
                times[f"{uid_str}_SCM"] = style_data["SCM"]["time_ms"]
        clubs_map[c.clubsid]["athletes"].append({
            "name": f"{a.lastname}, {a.firstname}",
            "times": times,
        })

    # Sort clubs and athletes
    clubs = sorted(clubs_map.values(), key=lambda c: c["name"])
    for club in clubs:
        club["athletes"].sort(key=lambda a: a["name"])

    # Determine course (current meet's course, used to pick LCM vs SCM when both exist)
    course_cfg = db.query(BsGlobal).get("meet_course")
    course = course_cfg.data if course_cfg and course_cfg.data else "LCM"

    return {"styles": styles, "clubs": clubs, "course": course}
