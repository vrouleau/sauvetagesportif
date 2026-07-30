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

"""Public results API — historical meets."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..models_team import Meet, Result, Member, TeamClub

router = APIRouter(prefix="/api/results")


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
