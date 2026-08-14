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

"""Load events from meet .lxf into SwimEvent + SwimStyle + AgeGroup tables."""
from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session
from .models import (
    SwimStyle, SwimSession, SwimEvent, AgeGroup,
    ROUND_PRE, ROUND_TIM, ROUND_FIN,
    fee_cents_to_dollars,
)
from .models_team import Meet, Session as TeamSession, Event as TeamEvent
from .meet_parser import parse_meet_lxf, ParsedMeet
from .meet_config import get_active_meetsid


def _round_from_lenex(round_str: str) -> int:
    """Map Lenex round string to Splash integer encoding."""
    mapping = {"PRE": ROUND_PRE, "SEM": 2, "FIN": ROUND_FIN, "TIM": ROUND_TIM}
    return mapping.get(round_str, ROUND_TIM)


def _load_from_parsed(db: Session, meet: ParsedMeet, reuse_meetsid: int | None = None) -> int:
    """Insert events + age groups + swimstyles from a parsed meet. Returns event count.

    `reuse_meetsid`, when given, updates that existing (open) Meet row in
    place instead of allocating a new meetsid — used when re-uploading a
    corrected structure onto the meet that's already open, so meet_config,
    secret_links, and organizer_club_id (all keyed by meetsid) keep pointing
    at the same meet rather than being orphaned. See docs/CONCURRENT_MEETS_PLAN.md.
    """
    count = 0

    # ── Also create/reuse a Meet row in the Team Manager schema ───────────
    from sqlalchemy import func
    team_meet = db.get(Meet, reuse_meetsid) if reuse_meetsid is not None else None
    if team_meet is not None:
        team_meet.name = meet.meet_name or "Current Meet"
        team_meet.course = {"LCM": 1, "SCM": 3, "SCY": 2}.get(meet.course, 1)
    else:
        next_meet_id = (db.query(func.max(Meet.meetsid)).scalar() or 0) + 1
        team_meet = Meet(
            meetsid=next_meet_id,
            name=meet.meet_name or "Current Meet",
            course={"LCM": 1, "SCM": 3, "SCY": 2}.get(meet.course, 1),
            meetstate=0,  # planned
            # This becomes "the current meet" — see get_active_meetsid in
            # meet_config.py, which resolves it instead of the old bsglobal
            # current_meetsid pointer. meet_type isn't known here (callers set
            # it explicitly afterward — see routers/api.py's _set_meet_type
            # call sites).
            registration_open=True,
        )
        db.add(team_meet)
    db.flush()

    for ses in meet.sessions:
        # Create session (old schema)
        session = SwimSession(
            meetsid=team_meet.meetsid,
            sessionnumber=ses.number,
            name=ses.name,
            course=None,  # will be set from meet-level course if needed
            lanemin=ses.lanemin,
            lanemax=ses.lanemax,
        )
        db.add(session)
        db.flush()

        # Create session (new Team Manager schema)
        next_sess_id = (db.query(func.max(TeamSession.sessionsid)).scalar() or 0) + 1
        team_session = TeamSession(
            sessionsid=next_sess_id,
            meetsid=team_meet.meetsid,
            numb=ses.number,
            name=(ses.name or "")[:50],
        )
        db.add(team_session)
        db.flush()

        for ev in ses.events:
            # Upsert swimstyle (id 0 marks a style-less pause/break event — no real style to store)
            if ev.swimstyleid:
                style = db.get(SwimStyle, ev.swimstyleid)
                if not style:
                    style = SwimStyle(
                        swimstyleid=ev.swimstyleid,
                        distance=ev.distance,
                        name=ev.style_name or f"UID {ev.swimstyleid}",
                        relaycount=ev.relaycount,
                    )
                    db.add(style)
                    db.flush()

            event = SwimEvent(
                swimeventid=ev.eventid,
                meetsid=team_meet.meetsid,
                swimsessionid=session.swimsessionid,
                swimstyleid=ev.swimstyleid or None,
                eventnumber=ev.number,
                gender=ev.gender_int,
                round=_round_from_lenex(ev.round),
                masters="T" if ev.is_masters else "F",
                fee=fee_cents_to_dollars(ev.fee_cents),
                sortcode=count,
                roundname=ev.roundname or None,
                internalevent="T" if ev.is_internal else "F",
                comment=ev.roundname if ev.is_internal else None,
            )
            db.add(event)
            db.flush()

            # Determine age range from age groups for Team Manager event
            minage = None
            maxage = None
            for ag in ev.agegroups:
                db.add(AgeGroup(
                    agegroupid=ag.agegroupid,
                    meetsid=team_meet.meetsid,
                    swimeventid=event.swimeventid,
                    agemin=ag.agemin,
                    agemax=ag.agemax,
                    # An age group's gender is never independently set — it always
                    # mirrors its parent event's (see routers/api.py's update_event
                    # cascade for the same invariant on the edit path).
                    gender=ev.gender_int,
                ))
                if ag.agemin >= 0:
                    if minage is None or ag.agemin < minage:
                        minage = ag.agemin
                if ag.agemax >= 0:
                    if maxage is None or ag.agemax > maxage:
                        maxage = ag.agemax

            # Create event (new Team Manager schema)
            next_ev_id = (db.query(func.max(TeamEvent.eventsid)).scalar() or 0) + 1
            db.add(TeamEvent(
                eventsid=next_ev_id,
                meetsid=team_meet.meetsid,
                sessionnumb=ses.number,
                numb=ev.number,
                stylesid=ev.swimstyleid or None,
                minage=minage,
                maxage=maxage,
                fee=fee_cents_to_dollars(ev.fee_cents) if ev.fee_cents else None,
                gender=ev.gender_int,
                sortcode=count,
            ))
            count += 1

    db.commit()
    return count


def load_events(db: Session, lxf_path: Path) -> int:
    """Load events from meet .lxf on a genuinely empty install.

    Must check for an already-active meet, not just an empty `swimevent`
    table: a meet can be "current" (registration_open=True) with zero events
    loaded yet (see "Empty meet state is supported" in team-app's CLAUDE.md).
    Loading the template on top of that would create a second
    registration_open=True row, and get_active_meetsid() would then resolve
    to whichever one has the higher meetsid — not necessarily the real one.
    """
    if db.query(SwimEvent).first() or get_active_meetsid(db) is not None:
        return 0
    meet = parse_meet_lxf(lxf_path)
    return _load_from_parsed(db, meet)