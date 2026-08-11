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

"""Meet-scoped config helpers — resolving "the current meet" and its
meet_config-backed settings (formerly a flat set of bsglobal keys).

Lives outside routers/ (not in routers/api.py) so routers/live.py,
export.py, invoices.py, and main.py can all import it without a circular
import back through routers/api.py, which itself imports export.py and
invoices.py at module load time. See docs/CONCURRENT_MEETS_PLAN.md.
"""
from __future__ import annotations

from fastapi import HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

from .models import BsGlobal, MeetConfig, SwimSession
from .models_team import ClubMeetInvite, Meet as TeamMeet


def _get_config(db: Session, key: str) -> str | None:
    cfg = db.get(BsGlobal, key)
    return cfg.data if cfg else None


def _set_config(db: Session, key: str, value: str):
    cfg = db.get(BsGlobal, key)
    if cfg:
        cfg.data = value
    else:
        db.add(BsGlobal(name=key, data=value))


def get_active_meetsid(db: Session) -> int | None:
    """Resolve "the current meet" — the one meet with registration_open=True.

    Today exactly one row is ever open (Phase 1 doesn't add any endpoint that
    opens a second one), so this is a drop-in replacement for the old
    bsglobal.current_meetsid pointer.
    """
    meet = (
        db.query(TeamMeet)
        .filter(TeamMeet.registration_open == True)  # noqa: E712
        .order_by(TeamMeet.meetsid.desc())
        .first()
    )
    return meet.meetsid if meet else None


def resolve_meetsid(request: Request, db: Session) -> int | None:
    """Resolve the target meetsid for this request (docs/CONCURRENT_MEETS_PLAN.md,
    Phase 2 stage 3).

    Reads the `X-Meet-Id` header when present, validated against currently
    open meets — every caller, club or admin, already has at least "coach"
    access to every open meet per the stage 2 auth model, so validity is
    just "is this meet open?", not a per-club allowlist. Falls back to
    today's single-open-meet resolution when the header is absent — a
    409-with-candidates only fires if the header is absent *and* more than
    one meet is open, which can't happen yet (no endpoint opens a second
    meet until stage 7) and won't happen once stage 6's meet switcher
    always sends the header whenever there's a real choice.
    """
    open_meets = (
        db.query(TeamMeet)
        .filter(TeamMeet.registration_open == True)  # noqa: E712
        .order_by(TeamMeet.meetsid)
        .all()
    )
    header = request.headers.get("X-Meet-Id")
    if header:
        try:
            requested = int(header)
        except ValueError:
            raise HTTPException(400, "X-Meet-Id must be an integer")
        if not any(m.meetsid == requested for m in open_meets):
            raise HTTPException(404, f"Meet {requested} is not currently open")
        return requested
    if len(open_meets) > 1:
        raise HTTPException(409, {
            "code": "multiple_open_meets",
            "meets": [{"meet_id": m.meetsid, "name": m.name} for m in open_meets],
        })
    return open_meets[0].meetsid if open_meets else None


def _get_meet_config(db: Session, meetsid: int | None, key: str) -> str | None:
    if meetsid is None:
        return None
    cfg = db.get(MeetConfig, (meetsid, key))
    return cfg.data if cfg else None


def _set_meet_config(db: Session, meetsid: int, key: str, value: str):
    cfg = db.get(MeetConfig, (meetsid, key))
    if cfg:
        cfg.data = value
    else:
        db.add(MeetConfig(meetsid=meetsid, name=key, data=value))


def _get_meet_type(db: Session) -> str:
    """Get the meet type, checking both team-app key (meet_type) and meet-app key (MEET_TYPE)."""
    return (_get_config(db, "meet_type") or _get_config(db, "MEET_TYPE") or "POOL").upper()


def _set_meet_type(db: Session, value: str, meetsid: int | None = None):
    """Dual-write: bsglobal (existing behavior — _get_meet_type keeps reading
    it unchanged, this is Phase 1's behavior-preserving rule) plus the new
    meets.meet_type column, so it's correctly populated for Phase 2 to read
    from later without touching the fragile recompute-on-upload logic."""
    _set_config(db, "meet_type", value)
    meetsid = meetsid if meetsid is not None else get_active_meetsid(db)
    if meetsid:
        team_meet = db.get(TeamMeet, meetsid)
        if team_meet:
            team_meet.meet_type = value


def _update_meetvalue(db: Session, key: str, typed_value: str, meetsid: int | None = None):
    """Update a single key in the MEETVALUES blob (Splash format KEY=TYPE;VALUE)."""
    meetsid = meetsid if meetsid is not None else get_active_meetsid(db)
    existing: dict[str, str] = {}
    data_str = _get_meet_config(db, meetsid, "MEETVALUES")
    if data_str:
        for line in data_str.split("\r\n"):
            eq = line.find("=")
            if eq >= 0:
                existing[line[:eq]] = line[eq + 1:]
    existing[key] = typed_value
    data = "\r\n".join(f"{k}={v}" for k, v in existing.items() if v)
    if meetsid:
        _set_meet_config(db, meetsid, "MEETVALUES", data)


def _get_closure_date(db: Session, meetsid: int | None = None) -> str | None:
    """Get closure/deadline date — reads from closure_date key first, falls back to MEETVALUES DEADLINE."""
    meetsid = meetsid if meetsid is not None else get_active_meetsid(db)
    if not meetsid:
        return None
    val = _get_meet_config(db, meetsid, "closure_date")
    if val:
        return val
    # Fall back to MEETVALUES DEADLINE
    data_str = _get_meet_config(db, meetsid, "MEETVALUES")
    if data_str:
        for line in data_str.split("\r\n"):
            if line.startswith("DEADLINE=D;"):
                raw = line[11:]  # after "DEADLINE=D;"
                if raw and len(raw) >= 8:
                    return f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}"
    return None


def _set_closure_date(db: Session, value: str, meetsid: int | None = None):
    meetsid = meetsid if meetsid is not None else get_active_meetsid(db)
    if meetsid:
        _set_meet_config(db, meetsid, "closure_date", value)


def session_date_conflict(db: Session, session: SwimSession, target_date) -> str | None:
    """Would `target_date` collide with another currently-open meet's session date?

    Two meets can genuinely both be registering at once, but their sessions
    can never share a calendar day — this is what keeps that assumption true.
    Returns the conflicting meet's name if one exists, else None.
    """
    this_meetsid = session.meetsid if session.meetsid is not None else get_active_meetsid(db)
    conflict = (
        db.query(TeamMeet)
        .join(SwimSession, SwimSession.meetsid == TeamMeet.meetsid)
        .filter(
            TeamMeet.registration_open == True,  # noqa: E712
            SwimSession.meetsid != this_meetsid,
            SwimSession.swimsessionid != session.swimsessionid,
            func.date(SwimSession.startdate) == target_date.isoformat(),
        )
        .first()
    )
    return conflict.name if conflict else None


def _get_organizer_club_id(db: Session, meetsid: int | None = None) -> str | None:
    meetsid = meetsid if meetsid is not None else get_active_meetsid(db)
    return _get_meet_config(db, meetsid, "organizer_club_id")


def _set_organizer_club_id(db: Session, club_id, meetsid: int | None = None):
    meetsid = meetsid if meetsid is not None else get_active_meetsid(db)
    if meetsid:
        _set_meet_config(db, meetsid, "organizer_club_id", str(club_id))


def increment_club_invite_send_count(db: Session, club_id: int, meetsid: int) -> None:
    row = db.get(ClubMeetInvite, (club_id, meetsid))
    if not row:
        row = ClubMeetInvite(clubsid=club_id, meetsid=meetsid)
        db.add(row)
    row.invite_send_count = (row.invite_send_count or 0) + 1


def increment_club_stripe_send_count(db: Session, club_id: int, meetsid: int) -> None:
    row = db.get(ClubMeetInvite, (club_id, meetsid))
    if not row:
        row = ClubMeetInvite(clubsid=club_id, meetsid=meetsid)
        db.add(row)
    row.stripe_send_count = (row.stripe_send_count or 0) + 1
