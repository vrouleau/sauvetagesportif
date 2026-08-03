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

"""API endpoints — Splash-compatible schema."""
from __future__ import annotations

import logging
import os
import secrets
import string
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Body, Depends, UploadFile, File, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.exc import IntegrityError
from collections import defaultdict
import time as _time

from ..database import get_db
from pydantic import BaseModel, Field, field_validator
from ..models import (
    SwimEvent, SwimStyle, SwimSession, AgeGroup, SwimResult, BsGlobal, SecretLink,
    Heat, Split,
    gender_to_str, gender_from_str, fee_dollars_to_cents, fee_cents_to_dollars,
    GENDER_M, GENDER_F, GENDER_MIXED, ROUND_FIN, ROUND_TIM, ROUND_PRE,
)
from ..models_team import TeamClub, Member
from ..seed import seed_from_lxf
from ..best_times import (
    get_best_times_for_member, get_best_time_date,
)
from ..export import generate_lxf
from ..export_entries import generate_entries_lxf
from ..invoices import create_invoice_for_club

router = APIRouter(prefix="/api")
_audit = logging.getLogger("audit")

MEET_STORAGE = Path(os.environ.get("MEET_STORAGE", "/app/data/meet.lxf"))
_DEFAULT_ADMIN_PIN = os.environ.get("ADMIN_PIN", "000000")
_BEST_TIME_MAX_AGE_MONTHS = int(os.environ.get("BEST_TIME_MAX_AGE_MONTHS", "18"))


def _get_pool_template_path() -> Path:
    """Resolve the pool template path from env or fallback to config/."""
    fallback = str(Path(__file__).resolve().parent.parent.parent.parent.parent / "config" / "template_pool.lxf")
    return Path(os.environ.get("MEET_TEMPLATE_POOL", fallback))


# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------

class AthleteCreate(BaseModel):
    first_name: str = Field(..., min_length=1)
    last_name: str = Field(..., min_length=1)
    gender: str = "M"
    birthdate: str | None = None
    license: str = ""
    club_id: int

    @field_validator("gender")
    @classmethod
    def validate_gender(cls, v: str) -> str:
        if v not in ("M", "F"):
            raise ValueError("gender must be M or F")
        return v

    @field_validator("birthdate")
    @classmethod
    def validate_birthdate(cls, v: str | None) -> str | None:
        if v:
            from datetime import date as d
            d.fromisoformat(v)
        return v


class AthleteUpdate(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    gender: str | None = None
    birthdate: str | None = None
    license: str | None = None
    handicapex: str | None = None
    club_id: int | None = None

    @field_validator("gender")
    @classmethod
    def validate_gender(cls, v: str | None) -> str | None:
        if v is not None and v not in ("M", "F"):
            raise ValueError("gender must be M or F")
        return v

    @field_validator("birthdate")
    @classmethod
    def validate_birthdate(cls, v: str | None) -> str | None:
        if v:
            from datetime import date as d
            d.fromisoformat(v)
        return v

    @field_validator("first_name", "last_name")
    @classmethod
    def validate_not_empty(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("must not be empty")
        return v


class ClubCreate(BaseModel):
    name: str = Field(..., min_length=1)
    code: str = Field(..., min_length=1)
    nation: str = "CAN"
    pin: str | None = None
    email: str | None = None


class ClubUpdate(BaseModel):
    email: str | None = None


class RegistrationCreate(BaseModel):
    athlete_id: int
    event_id: int
    age_code: str = "Open"
    entry_time_ms: int | None = None

    @field_validator("age_code")
    @classmethod
    def validate_age_code(cls, v: str) -> str:
        if v not in ("10-", "11-12", "13-14", "15-18", "Open", "Masters"):
            raise ValueError("invalid age_code")
        return v

    @field_validator("entry_time_ms")
    @classmethod
    def validate_entry_time(cls, v: int | None) -> int | None:
        if v is not None and v < 0:
            raise ValueError("entry_time_ms must be non-negative")
        return v


class ClosureDateUpdate(BaseModel):
    closure_date: str = ""

    @field_validator("closure_date")
    @classmethod
    def validate_date(cls, v: str) -> str:
        if v:
            from datetime import date as d
            d.fromisoformat(v)
        return v


class PinChange(BaseModel):
    pin: str = Field(..., min_length=4, max_length=20)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_config(db: Session, key: str) -> str | None:
    cfg = db.get(BsGlobal, key)
    return cfg.data if cfg else None


def _get_meet_type(db: Session) -> str:
    """Get the meet type, checking both team-app key (meet_type) and meet-app key (MEET_TYPE)."""
    return (_get_config(db, "meet_type") or _get_config(db, "MEET_TYPE") or "POOL").upper()


def _set_config(db: Session, key: str, value: str):
    cfg = db.get(BsGlobal, key)
    if cfg:
        cfg.data = value
    else:
        db.add(BsGlobal(name=key, data=value))


def _update_meetvalue(db: Session, key: str, typed_value: str):
    """Update a single key in the MEETVALUES blob (Splash format KEY=TYPE;VALUE)."""
    cfg = db.get(BsGlobal, "MEETVALUES")
    existing: dict[str, str] = {}
    if cfg and cfg.data:
        for line in cfg.data.split("\r\n"):
            eq = line.find("=")
            if eq >= 0:
                existing[line[:eq]] = line[eq + 1:]
    existing[key] = typed_value
    data = "\r\n".join(f"{k}={v}" for k, v in existing.items() if v)
    _set_config(db, "MEETVALUES", data)


def _get_closure_date(db: Session) -> str | None:
    """Get closure/deadline date — reads from closure_date key first, falls back to MEETVALUES DEADLINE."""
    val = _get_config(db, "closure_date")
    if val:
        return val
    # Fall back to MEETVALUES DEADLINE
    cfg = db.get(BsGlobal, "MEETVALUES")
    if cfg and cfg.data:
        for line in cfg.data.split("\r\n"):
            if line.startswith("DEADLINE=D;"):
                raw = line[11:]  # after "DEADLINE=D;"
                if raw and len(raw) >= 8:
                    return f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}"
    return None


def _get_admin_pin(db: Session) -> str:
    return _get_config(db, "admin_pin") or _DEFAULT_ADMIN_PIN


_AGE_CODE_ORDER = ("10-", "11-12", "13-14", "15-18", "Open", "Masters")


def _age_group_code(age_min: int, age_max: int) -> str | None:
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


def _age_code_allowed_on_team(candidate_code: str, native_code: str) -> bool:
    """Is candidate_code allowed on a team anchored to native_code (the relay
    event's own age category)? Members must be the exact native category, or the
    single adjacent-younger one (swim-up — never the reverse). Codes not found in
    _AGE_CODE_ORDER never block (can't judge adjacency)."""
    if candidate_code == native_code:
        return True
    if native_code not in _AGE_CODE_ORDER or candidate_code not in _AGE_CODE_ORDER:
        return True
    return _AGE_CODE_ORDER.index(candidate_code) == _AGE_CODE_ORDER.index(native_code) - 1


# A relay team needs at least this many members from the event's own exact
# ("native") category — the rest may swim up from the adjacent-younger category.
_REQUIRED_NATIVE_COUNT = 2


def _would_miss_native_anchor(
    other_assigned_codes: list[str], candidate_code: str, native_code: str, remaining_after_this: int
) -> bool:
    """Would assigning candidate_code to this position make it impossible for the
    team to end up with at least _REQUIRED_NATIVE_COUNT native-category members,
    given how many positions remain to fill after this one?"""
    native_so_far = other_assigned_codes.count(native_code) + (1 if candidate_code == native_code else 0)
    max_possible_native = native_so_far + remaining_after_this
    return max_possible_native < _REQUIRED_NATIVE_COUNT


def _get_event_native_age_code(db: Session, stylesid: int, eventnumb: int | None, gender: int | None) -> str | None:
    """A relay team's own age category — resolved from its SwimEvent (same match
    priority as get_relay_teams: eventnumb first, falling back to style+gender for
    legacy rows without eventnumb). Returns None when the event can't be resolved,
    or has 0 or 2+ distinct age categories (ambiguous — anchor rule doesn't apply)."""
    event = None
    if eventnumb:
        event = (
            db.query(SwimEvent)
            .filter(SwimEvent.swimstyleid == stylesid, SwimEvent.eventnumber == eventnumb)
            .first()
        )
    if not event:
        gender_str = "M" if gender == GENDER_M else "F" if gender == GENDER_F else "X"
        for ev in db.query(SwimEvent).filter(SwimEvent.swimstyleid == stylesid).all():
            ev_gender_str = "M" if ev.gender == GENDER_M else "F" if ev.gender == GENDER_F else "X"
            if ev_gender_str == gender_str:
                event = ev
                break
    if not event:
        return None
    rows = db.query(AgeGroup.agemin, AgeGroup.agemax).filter(AgeGroup.swimeventid == event.swimeventid).distinct().all()
    codes = {_age_group_code(r.agemin, r.agemax) for r in rows}
    codes.discard(None)
    return next(iter(codes)) if len(codes) == 1 else None


def _oldest_age_code(codes: list[str]) -> str:
    """The oldest (highest-index in _AGE_CODE_ORDER) code among codes — this is
    the age category a relay team competes under (younger members swim up)."""
    best = codes[0]
    best_idx = _AGE_CODE_ORDER.index(best) if best in _AGE_CODE_ORDER else -1
    for c in codes[1:]:
        idx = _AGE_CODE_ORDER.index(c) if c in _AGE_CODE_ORDER else -1
        if idx > best_idx:
            best_idx = idx
            best = c
    return best


def _resolve_athlete_age_codes(db: Session, athlete_ids: list[int]) -> dict[int, str]:
    """Resolve each athlete's dominant individual-registration age code.
    Primary path: SwimResult.age_code column (set by team-app registrations).
    Fallback: agegroupid FK join (rows without an age_code, e.g. meet-app imports)."""
    if not athlete_ids:
        return {}
    from sqlalchemy import func as _sqla_func
    result: dict[int, str] = {}
    ac_counts = (
        db.query(SwimResult.athleteid, SwimResult.age_code, _sqla_func.count().label("cnt"))
        .join(SwimEvent, SwimResult.swimeventid == SwimEvent.swimeventid)
        .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
        .filter(
            SwimResult.athleteid.in_(athlete_ids),
            SwimStyle.relaycount == 1,
            SwimResult.age_code.isnot(None),
            SwimResult.age_code != "",
        )
        .group_by(SwimResult.athleteid, SwimResult.age_code)
        .order_by(SwimResult.athleteid, _sqla_func.count().desc())
        .all()
    )
    for row in ac_counts:
        result.setdefault(row.athleteid, row.age_code)

    remaining = [aid for aid in athlete_ids if aid not in result]
    if remaining:
        ag_counts = (
            db.query(SwimResult.athleteid, AgeGroup.agemin, AgeGroup.agemax, _sqla_func.count().label("cnt"))
            .join(AgeGroup, SwimResult.agegroupid == AgeGroup.agegroupid)
            .join(SwimEvent, SwimResult.swimeventid == SwimEvent.swimeventid)
            .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
            .filter(
                SwimResult.athleteid.in_(remaining),
                SwimStyle.relaycount == 1,
            )
            .group_by(SwimResult.athleteid, AgeGroup.agemin, AgeGroup.agemax)
            .order_by(SwimResult.athleteid, _sqla_func.count().desc())
            .all()
        )
        for row in ag_counts:
            result.setdefault(row.athleteid, _relay_age_code(row.agemin, row.agemax))
    return result


# Rate limiting
_auth_attempts: dict[str, list[float]] = defaultdict(list)
_RATE_LIMIT = 5
_RATE_WINDOW = 60


def _check_rate_limit(ip: str):
    now = _time.time()
    attempts = _auth_attempts[ip]
    _auth_attempts[ip] = [t for t in attempts if now - t < _RATE_WINDOW]
    if len(_auth_attempts[ip]) >= _RATE_LIMIT:
        raise HTTPException(429, "Too many attempts. Try again later.")
    _auth_attempts[ip].append(now)


def _reset_rate_limits():
    """Clear all rate limit state (used by tests)."""
    _auth_attempts.clear()


def _resolve_role(pin: str, db: Session) -> tuple[str, int | None]:
    """Return (role, club_id) for a given PIN."""
    if pin == _get_admin_pin(db):
        return "admin", None
    club = db.query(TeamClub).filter(TeamClub.pin == pin).first()
    if not club:
        return "none", None
    org_cfg = _get_config(db, "organizer_club_id")
    if org_cfg and org_cfg == str(club.clubsid):
        return "organizer", club.clubsid
    return "coach", club.clubsid


def require_admin(request: Request, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    if pin != _get_admin_pin(db):
        raise HTTPException(403, "Admin access required")


def require_organizer_or_admin(request: Request, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    role, _ = _resolve_role(pin, db)
    if role not in ("admin", "organizer"):
        raise HTTPException(403, "Organizer or admin access required")


def _check_closure(db: Session, pin: str = ""):
    if pin == _get_admin_pin(db):
        return
    club = db.query(TeamClub).filter(TeamClub.pin == pin).first()
    if club:
        org_cfg = _get_config(db, "organizer_club_id")
        if org_cfg and org_cfg == str(club.clubsid):
            return
    cfg = _get_closure_date(db)
    if cfg:
        from datetime import date
        if date.today() > date.fromisoformat(cfg):
            raise HTTPException(403, "Inscriptions fermées / Entries closed")


def _caller_club_id(db: Session, pin: str) -> int | None:
    """Return the club_id of the caller, or None if admin."""
    if pin == _get_admin_pin(db):
        return None
    club = db.query(TeamClub).filter(TeamClub.pin == pin).first()
    return club.clubsid if club else None


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@router.post("/admin/reset-rate-limits", dependencies=[Depends(require_admin)])
def reset_rate_limits():
    """Reset auth rate limit state (admin-only, used by tests)."""
    _reset_rate_limits()
    return {"ok": True}


@router.post("/auth")
def auth(data: dict, request: Request, db: Session = Depends(get_db)):
    """Validate PIN, return club info."""
    ip = request.client.host if request.client else "?"
    _check_rate_limit(ip)
    pin = data.get("pin", "")
    admin_pin = _get_admin_pin(db)
    if pin == admin_pin:
        _audit.info(f"[admin] LOGIN  (ip={ip})")
        return {"role": "admin", "club_id": None, "club_name": "Admin"}
    club = db.query(TeamClub).filter(TeamClub.pin == pin).first()
    if not club:
        _audit.info(f"[?] LOGIN_FAILED  (ip={ip})")
        raise HTTPException(401, "Invalid PIN")
    org_cfg = _get_config(db, "organizer_club_id")
    if org_cfg and org_cfg == str(club.clubsid):
        _audit.info(f"[organizer/{club.name}] LOGIN  (ip={ip})")
        return {"role": "organizer", "club_id": club.clubsid, "club_name": club.name}
    _audit.info(f"[coach/{club.name}] LOGIN  (ip={ip})")
    return {"role": "coach", "club_id": club.clubsid, "club_name": club.name}


# ---------------------------------------------------------------------------
# Meet upload
# ---------------------------------------------------------------------------

def _replace_current_meet_structure(db: Session, meet, content: bytes, filename: str | None) -> int:
    """Wipe the current (non-historical) meet structure and rebuild it from a
    parsed meet. Shared by /upload/meet and /upload/entries — the latter
    takes this path when its own EVENT/SWIMSTYLE elements describe a meet
    structure not already in the local catalog (see upload_entries).

    Archived meets (meetstate=3) and their results/events/sessions survive,
    same as _reset_for_next_meet.
    """
    MEET_STORAGE.parent.mkdir(parents=True, exist_ok=True)
    MEET_STORAGE.write_bytes(content)

    # Wipe registrations (swimresults with entrytime) then events — current
    # (non-historical) meet only.
    db.query(SwimResult).delete()
    db.query(AgeGroup).delete()
    db.query(SwimEvent).delete()
    db.query(SwimSession).delete()
    # Clear Team Manager event tables BEFORE swimstyle (FK dependency)
    from ..models_team import Event as TeamEvent, Session as TeamSession, Meet as TeamMeet, MemberMeet as TeamMemberMeet
    current_ids = [r for r, in db.query(TeamMeet.meetsid).filter(TeamMeet.meetstate != 3).all()]
    if current_ids:
        db.query(TeamMemberMeet).filter(TeamMemberMeet.meetsid.in_(current_ids)).delete(synchronize_session=False)
        db.query(TeamEvent).filter(TeamEvent.meetsid.in_(current_ids)).delete(synchronize_session=False)
        db.query(TeamSession).filter(TeamSession.meetsid.in_(current_ids)).delete(synchronize_session=False)
        db.query(TeamMeet).filter(TeamMeet.meetsid.in_(current_ids)).delete(synchronize_session=False)
    db.flush()
    # SwimStyle rows are upserted by id in _load_from_parsed (never deleted here) —
    # historical Event/Result rows keep referencing the same style IDs across meets.
    from ..events import _load_from_parsed
    count = _load_from_parsed(db, meet)

    # Track metadata
    import json as _json
    for key, val in [("meet_filename", filename or "meet.lxf"),
                     ("meet_uploaded_at", datetime.utcnow().isoformat()),
                     ("meet_name", meet.meet_name),
                     ("meet_course", meet.course),
                     ("meet_masters", "T" if meet.masters else "F"),
                     ("meet_currency", meet.currency or "CAD"),
                     ("meet_fees_json", _json.dumps(meet.meet_fees)),
                     ("age_base_date", meet.age_base_date)]:
        _set_config(db, key, val)

    # Auto-detect meet type from swim style IDs used in *this* upload (>= 600 = beach).
    # Must look at the parsed meet, not the global SwimStyle table — that table now
    # accumulates styles across meets (never wiped), so a stale/historical beach
    # style would otherwise misclassify a brand new pool meet.
    has_beach = any(
        ev.swimstyleid and ev.swimstyleid >= 600
        for ses in meet.sessions for ev in ses.events
    )
    _set_config(db, "meet_type", "BEACH" if has_beach else "POOL")

    # Sync meet identity into MEETVALUES blob for Splash-format compatibility.
    # Individual bsglobal keys (meet_name, meet_course) are the canonical source;
    # MEETVALUES is kept in sync for interop with the meet-app EventsPage.
    if meet.meet_name:
        _update_meetvalue(db, "NAME", f"S;{meet.meet_name}")
    if meet.course:
        course_map = {"LCM": "1", "SCM": "3", "SCY": "2"}
        _update_meetvalue(db, "COURSE", f"I;{course_map.get(meet.course, '1')}")

    # Reset closure date (clear both the key and MEETVALUES DEADLINE fallback)
    _set_config(db, "closure_date", "")
    _update_meetvalue(db, "DEADLINE", "D;")

    # Regenerate club PINs
    for club in db.query(TeamClub).all():
        club.pin = ''.join(secrets.choice(string.digits) for _ in range(6))

    return count


@router.post("/upload/meet", dependencies=[Depends(require_organizer_or_admin)])
async def upload_meet(file: UploadFile = File(...), force: bool = False, db: Session = Depends(get_db)):
    """Upload meet .lxf — sets event structure.

    Warns (409, pass ?force=true to override) if the LXF references swimstyle
    ids not already in the local catalog — the catalog is shared across all
    meets (historical included) and never wiped, so new ids are worth a
    confirmation rather than a silent add.
    """
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 10MB)")
    from ..meet_parser import parse_meet_lxf
    try:
        meet = parse_meet_lxf(content)
    except Exception as e:
        raise HTTPException(400, f"Invalid meet .lxf: {e}")

    if not force:
        from ..swimstyle_check import find_new_swimstyles
        new_styles = find_new_swimstyles(db, (
            (ev.swimstyleid, ev.style_name, ev.distance)
            for ses in meet.sessions for ev in ses.events
        ))
        if new_styles:
            raise HTTPException(409, {
                "code": "new_swimstyles",
                "message": f"{len(new_styles)} swimstyle id(s) in this file are not in the local catalog.",
                "styles": new_styles,
            })

    count = _replace_current_meet_structure(db, meet, content, file.filename)
    db.commit()
    return {"events_loaded": count, "filename": file.filename}


@router.post("/admin/new-meet", dependencies=[Depends(require_organizer_or_admin)])
def create_new_meet(data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Create a new meet by resetting all data and importing from the appropriate template.

    Accepts optional JSON body: {"meet_type": "pool"|"beach"}
    Defaults to "pool" if not specified.
    """
    meet_type = (data.get("meet_type") or "pool").lower()
    if meet_type not in ("pool", "beach"):
        raise HTTPException(400, f"Invalid meet_type: {meet_type}. Must be 'pool' or 'beach'.")

    # Resolve template path based on meet type
    if meet_type == "beach":
        env_var = "MEET_TEMPLATE_BEACH"
        fallback = str(Path(__file__).resolve().parent.parent.parent.parent.parent / "config" / "template_beach.lxf")
    else:
        env_var = "MEET_TEMPLATE_POOL"
        fallback = str(Path(__file__).resolve().parent.parent.parent.parent.parent / "config" / "template_pool.lxf")

    template_path = Path(os.environ.get(env_var, fallback))
    if not template_path.exists():
        raise HTTPException(404, f"Meet template not found: {template_path}")

    from ..meet_parser import parse_meet_lxf
    try:
        meet = parse_meet_lxf(template_path)
    except Exception as e:
        raise HTTPException(400, f"Invalid template .lxf: {e}")

    # Wipe existing data — current (non-historical) meet only. Archived meets
    # (meetstate=3) and their results/events/sessions must survive, same as
    # the organizer's end-of-meet reset (_reset_for_next_meet).
    db.query(SwimResult).delete()
    db.query(AgeGroup).delete()
    db.query(SwimEvent).delete()
    db.query(SwimSession).delete()
    # Clear Team Manager event tables BEFORE swimstyle (FK dependency)
    from ..models_team import Event as TeamEvent, Session as TeamSession, Meet as TeamMeet, MemberMeet as TeamMemberMeet
    current_ids = [r for r, in db.query(TeamMeet.meetsid).filter(TeamMeet.meetstate != 3).all()]
    if current_ids:
        db.query(TeamMemberMeet).filter(TeamMemberMeet.meetsid.in_(current_ids)).delete(synchronize_session=False)
        db.query(TeamEvent).filter(TeamEvent.meetsid.in_(current_ids)).delete(synchronize_session=False)
        db.query(TeamSession).filter(TeamSession.meetsid.in_(current_ids)).delete(synchronize_session=False)
        db.query(TeamMeet).filter(TeamMeet.meetsid.in_(current_ids)).delete(synchronize_session=False)
    db.flush()

    # Import from template — this seeds the SwimStyle catalog (each style is declared via
    # a stub EVENT, since Lenex has no standalone style catalog outside of events) but we
    # don't want the template's stub session/events themselves in the new meet.
    # SwimStyle rows are upserted by ID in _load_from_parsed (never deleted here) —
    # historical Event/Result rows keep referencing the same style IDs across meets.
    from ..events import _load_from_parsed
    _load_from_parsed(db, meet)
    new_meetsid = int(_get_config(db, "current_meetsid"))
    db.query(AgeGroup).delete()
    db.query(SwimEvent).delete()
    db.query(SwimSession).delete()
    db.query(TeamEvent).filter(TeamEvent.meetsid == new_meetsid).delete(synchronize_session=False)
    db.query(TeamSession).filter(TeamSession.meetsid == new_meetsid).delete(synchronize_session=False)
    db.flush()

    # Store the template as the current meet file
    MEET_STORAGE.parent.mkdir(parents=True, exist_ok=True)
    MEET_STORAGE.write_bytes(template_path.read_bytes())

    # Set meet type in BSGLOBAL
    _set_config(db, "meet_type", meet_type.upper())

    # Track metadata
    import json as _json
    from datetime import date as _date
    year = _date.today().year
    for key, val in [("meet_filename", template_path.name),
                     ("meet_uploaded_at", datetime.utcnow().isoformat()),
                     ("meet_name", meet.meet_name),
                     ("meet_course", meet.course),
                     ("meet_masters", "T" if meet.masters else "F"),
                     ("meet_currency", meet.currency or "CAD"),
                     ("meet_fees_json", _json.dumps(meet.meet_fees)),
                     ("age_base_date", f"{year}-12-31")]:
        _set_config(db, key, val)

    # Set AGEDATE in MEETVALUES so the UI picks it up
    mv_cfg = db.get(BsGlobal, "MEETVALUES")
    mv_data = mv_cfg.data if mv_cfg and mv_cfg.data else ""
    # Append or replace AGEDATE line
    lines = [l for l in mv_data.split("\r\n") if l and not l.startswith("AGEDATE=")]
    lines.append(f"AGEDATE=D;{year}1231000000000")
    _set_config(db, "MEETVALUES", "\r\n".join(lines))

    # Sync meet name and course into MEETVALUES so EventsPage tree picks it up
    if meet.meet_name:
        _update_meetvalue(db, "NAME", f"S;{meet.meet_name}")
    if meet.course:
        course_map = {"LCM": "1", "SCM": "3", "SCY": "2"}
        _update_meetvalue(db, "COURSE", f"I;{course_map.get(meet.course, '1')}")

    # Reset closure date
    _set_config(db, "closure_date", "")

    styles_loaded = db.query(SwimStyle).count()

    db.commit()
    return {"events_loaded": 0, "styles_loaded": styles_loaded, "filename": template_path.name, "meet_type": meet_type}


@router.get("/meet-info")
def meet_info(db: Session = Depends(get_db)):
    import json as _json
    filename = _get_config(db, "meet_filename")
    uploaded = _get_config(db, "meet_uploaded_at")
    name = _get_config(db, "meet_name")
    course = _get_config(db, "meet_course")
    masters = _get_config(db, "meet_masters")
    closure = _get_closure_date(db)
    currency = _get_config(db, "meet_currency")
    fees_json = _get_config(db, "meet_fees_json")
    try:
        meet_fees = _json.loads(fees_json) if fees_json else {}
    except ValueError:
        meet_fees = {}
    events = db.query(SwimEvent).options(
        joinedload(SwimEvent.swimstyle)
    ).order_by(SwimEvent.eventnumber).all()
    event_fees = [
        {
            "event_number": e.eventnumber,
            "style_name": e.swimstyle.name if e.swimstyle else "",
            "distance": e.swimstyle.distance if e.swimstyle else 0,
            "relay_count": e.swimstyle.relaycount if e.swimstyle else 1,
            "fee_cents": fee_dollars_to_cents(e.fee),
        }
        for e in events
    ]
    return {
        "filename": filename,
        "uploaded_at": uploaded,
        "meet_name": name,
        "course": course,
        "masters": (masters == "T") if masters else False,
        "events": db.query(SwimEvent).count(),
        "closure_date": closure,
        "currency": currency or "CAD",
        "meet_fees": meet_fees,
        "event_fees": event_fees,
        "meet_type": _get_meet_type(db),
    }


@router.get("/meet-config", dependencies=[Depends(require_organizer_or_admin)])
def get_meet_config(db: Session = Depends(get_db)):
    """Return MEETVALUES-style config as a flat dict {KEY: value}.

    Individual bsglobal keys (meet_name, meet_course) are canonical and override
    any stale values in the MEETVALUES blob.
    """
    cfg = db.get(BsGlobal, "MEETVALUES")
    result: dict[str, str] = {}
    if cfg and cfg.data:
        for line in cfg.data.split("\r\n"):
            if not line:
                continue
            eq = line.find("=")
            if eq < 0:
                continue
            key = line[:eq]
            rest = line[eq + 1:]
            # Strip type prefix (I;, S;, B;, D;, F;)
            semi = rest.find(";")
            result[key] = rest[semi + 1:] if semi >= 0 else rest
    # Individual bsglobal keys are canonical — override MEETVALUES
    name = _get_config(db, "meet_name")
    if name:
        result["NAME"] = name
    course = _get_config(db, "meet_course")
    if course:
        course_map = {"LCM": "1", "SCM": "3", "SCY": "2"}
        result["COURSE"] = course_map.get(course, "1")
    return result


@router.put("/meet-config", dependencies=[Depends(require_organizer_or_admin)])
def set_meet_config(entries: dict, db: Session = Depends(get_db)):
    """Update MEETVALUES-style config. Body: {KEY: {type, value}}."""
    # Read existing MEETVALUES
    cfg = db.get(BsGlobal, "MEETVALUES")
    existing: dict[str, str] = {}
    if cfg and cfg.data:
        for line in cfg.data.split("\r\n"):
            if not line:
                continue
            eq = line.find("=")
            if eq < 0:
                continue
            existing[line[:eq]] = line[eq + 1:]
    # Apply updates
    for key, entry in entries.items():
        type_code = entry.get("type", "S") if isinstance(entry, dict) else "S"
        value = entry.get("value", "") if isinstance(entry, dict) else str(entry)
        existing[key] = f"{type_code};{value}"
        # Sync canonical individual keys
        if key == "NAME":
            _set_config(db, "meet_name", value)
        elif key == "COURSE":
            course_map = {"1": "LCM", "2": "SCY", "3": "SCM"}
            _set_config(db, "meet_course", course_map.get(value, "LCM"))
        # Sync DEADLINE → closure_date
        elif key == "DEADLINE" and value:
            # Convert YYYYMMDDHHMMSSMMM → YYYY-MM-DD
            raw = value
            if len(raw) >= 8:
                _set_config(db, "closure_date", f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}")
            else:
                _set_config(db, "closure_date", "")
        elif key == "DEADLINE" and not value:
            _set_config(db, "closure_date", "")
    # Serialize back
    data = "\r\n".join(f"{k}={v}" for k, v in existing.items())
    if cfg:
        cfg.data = data
    else:
        db.add(BsGlobal(name="MEETVALUES", data=data))
    db.commit()
    return {"ok": True}


@router.put("/closure-date", dependencies=[Depends(require_organizer_or_admin)])
def set_closure_date(data: ClosureDateUpdate, db: Session = Depends(get_db)):
    val = data.closure_date
    _set_config(db, "closure_date", val)
    # Also sync to MEETVALUES DEADLINE
    if val:
        _update_meetvalue(db, "DEADLINE", f"D;{val.replace('-', '')}000000000")
    else:
        _update_meetvalue(db, "DEADLINE", "D;")
    db.commit()
    return {"closure_date": val}


# ---------------------------------------------------------------------------
# Clubs
# ---------------------------------------------------------------------------

@router.get("/clubs")
def list_clubs(request: Request, db: Session = Depends(get_db)):
    from sqlalchemy import func, distinct
    from ..invoices import _club_line_items, _meet_fees
    from ..models_team import Relay, RelayPos

    pin = request.headers.get("X-Club-Pin", "")
    role, _ = _resolve_role(pin, db)
    clubs = db.query(TeamClub).order_by(TeamClub.name).all()

    # Pre-compute athlete counts per club (from members table)
    athlete_counts = dict(
        db.query(Member.clubsid, func.count(Member.membersid))
        .group_by(Member.clubsid)
        .all()
    )

    # Pre-compute registered athlete counts per club
    reg_counts = dict(
        db.query(Member.clubsid, func.count(distinct(Member.membersid)))
        .join(SwimResult, SwimResult.athleteid == Member.membersid)
        .group_by(Member.clubsid)
        .all()
    )

    # Pre-compute incomplete relay team counts per club (a team is complete once
    # every position up to its style's relaycount has an assigned athlete)
    relay_style_counts = dict(db.query(SwimStyle.swimstyleid, SwimStyle.relaycount).all())
    filled_position_counts = dict(
        db.query(RelayPos.relaysid, func.count(distinct(RelayPos.numb)))
        .filter(RelayPos.membersid.isnot(None))
        .group_by(RelayPos.relaysid)
        .all()
    )
    incomplete_relay_counts: dict[int, int] = {}
    for relaysid, clubsid, stylesid in (
        db.query(Relay.relaysid, Relay.clubsid, Relay.stylesid)
        .filter(Relay.clubsid.isnot(None))
        .all()
    ):
        needed = relay_style_counts.get(stylesid) or 1
        filled = filled_position_counts.get(relaysid, 0)
        if filled < needed:
            incomplete_relay_counts[clubsid] = incomplete_relay_counts.get(clubsid, 0) + 1

    meet_fees = _meet_fees(db)
    result = []
    for c in clubs:
        item = {"id": c.clubsid, "name": c.name, "code": c.code,
                "athlete_count": athlete_counts.get(c.clubsid, 0),
                "registered_athlete_count": reg_counts.get(c.clubsid, 0),
                "invite_send_count": c.invite_send_count or 0,
                "stripe_send_count": c.stripe_send_count or 0,
                "incomplete_relay_count": incomplete_relay_counts.get(c.clubsid, 0)}
        items = _club_line_items(db, c, meet_fees)
        item["total_fees_cents"] = sum(it["unit_cents"] * it["qty"] for it in items)
        if role in ("admin", "organizer"):
            item["email"] = c.email or ""
            item["pin"] = c.pin
        result.append(item)
    return result


@router.post("/clubs", dependencies=[Depends(require_admin)])
def create_club(data: ClubCreate, db: Session = Depends(get_db)):
    pin = data.pin or ''.join(secrets.choice(string.digits) for _ in range(6))
    club = TeamClub(name=data.name, code=data.code, nation=data.nation, pin=pin, email=data.email)
    db.add(club)
    db.commit()
    return {"id": club.clubsid, "pin": club.pin}


@router.delete("/clubs/{club_id}", dependencies=[Depends(require_admin)])
def delete_club(club_id: int, db: Session = Depends(get_db)):
    if not db.query(TeamClub.clubsid).filter(TeamClub.clubsid == club_id).first():
        raise HTTPException(404)
    athlete_ids = [aid for (aid,) in db.query(Member.membersid).filter(Member.clubsid == club_id).all()]
    if athlete_ids:
        db.query(SwimResult).filter(SwimResult.athleteid.in_(athlete_ids)).delete(synchronize_session=False)
    db.query(Member).filter(Member.clubsid == club_id).delete(synchronize_session=False)
    db.query(SecretLink).filter(SecretLink.club_id == club_id).delete(synchronize_session=False)
    db.query(TeamClub).filter(TeamClub.clubsid == club_id).delete(synchronize_session=False)
    db.commit()
    return {"deleted": True, "athletes_deleted": len(athlete_ids)}


@router.post("/clubs/{club_id}/reset-pin", dependencies=[Depends(require_admin)])
def reset_club_pin(club_id: int, db: Session = Depends(get_db)):
    club = db.get(TeamClub, club_id)
    if not club:
        raise HTTPException(404)
    club.pin = ''.join(secrets.choice(string.digits) for _ in range(6))
    db.commit()
    return {"club": club.name, "pin": club.pin}


@router.put("/clubs/{club_id}", dependencies=[Depends(require_admin)])
def update_club(club_id: int, data: ClubUpdate, db: Session = Depends(get_db)):
    club = db.get(TeamClub, club_id)
    if not club:
        raise HTTPException(404)
    if data.email is not None:
        club.email = data.email
    db.commit()
    return {"ok": True}


@router.post("/clubs/{club_id}/send-pin", dependencies=[Depends(require_organizer_or_admin)])
def send_pin(club_id: int, data: dict, db: Session = Depends(get_db)):
    """Create one-time secret link with PIN, send invite email via Resend."""
    import uuid
    from datetime import timedelta
    from cryptography.fernet import Fernet
    import httpx

    club = db.get(TeamClub, club_id)
    if not club:
        raise HTTPException(404)
    if not club.email:
        raise HTTPException(400, "No email set for this club")

    lang = data.get("lang", "fr")
    resend_key = os.environ.get("RESEND_API_KEY")
    if not resend_key:
        raise HTTPException(500, "RESEND_API_KEY not configured")

    fernet_key = os.environ.get("SECRET_KEY")
    if not fernet_key:
        raise HTTPException(500, "SECRET_KEY not configured")
    import hashlib, base64
    key = base64.urlsafe_b64encode(hashlib.sha256(fernet_key.encode()).digest())
    f = Fernet(key)
    pin_encrypted = f.encrypt(club.pin.encode()).decode()

    token = str(uuid.uuid4())
    expires = datetime.utcnow() + timedelta(days=7)
    link = SecretLink(token=token, club_id=club.clubsid,
                      pin_encrypted=pin_encrypted, expires_at=expires, lang=lang)
    db.add(link)
    db.flush()
    db.commit()
    db.refresh(link)

    base_url = os.environ.get("APP_BASE_URL", "http://localhost:8001")
    secret_url = f"{base_url}/secret/{token}"

    meet_name = _get_config(db, "meet_name") or "Meet"
    closure_date = _get_config(db, "closure_date")

    org_cfg = _get_config(db, "organizer_club_id")
    is_organizer = org_cfg and str(club.clubsid) == str(org_cfg)

    org_email = ""
    org_club_name = ""
    if not is_organizer and org_cfg:
        org_club = db.get(TeamClub, int(org_cfg))
        if org_club:
            org_email = org_club.email or ""
            org_club_name = org_club.name or ""

    support_email = os.environ.get("SUPPORT_EMAIL", "")

    # Build footer
    footer_note = "<hr style=\"margin-top:20px\">"
    if is_organizer:
        if lang == "fr":
            if support_email:
                footer_note += (f"<p>Pour toute question, contactez le support : "
                                f"<a href=\"mailto:{support_email}\">{support_email}</a></p>")
        else:
            if support_email:
                footer_note += (f"<p>If you have questions, contact support: "
                                f"<a href=\"mailto:{support_email}\">{support_email}</a></p>")
    else:
        if lang == "fr":
            lines = []
            if org_email:
                lines.append(f"Pour toute question sur la compétition, contactez l'organisateur ({org_club_name}) : "
                             f"<a href=\"mailto:{org_email}\">{org_email}</a>")
            if support_email:
                lines.append(f"Pour de l'aide avec le portail d'inscription, contactez le support : "
                             f"<a href=\"mailto:{support_email}\">{support_email}</a>")
            if lines:
                footer_note += "<p>" + "<br>".join(lines) + "</p>"
        else:
            lines = []
            if org_email:
                lines.append(f"If you have questions about the meet, contact the organizer ({org_club_name}): "
                             f"<a href=\"mailto:{org_email}\">{org_email}</a>")
            if support_email:
                lines.append(f"For help with the registration portal, contact support: "
                             f"<a href=\"mailto:{support_email}\">{support_email}</a>")
            if lines:
                footer_note += "<p>" + "<br>".join(lines) + "</p>"

    if lang == "fr":
        footer_note += "<p style=\"font-size:11px;color:#888\">Ce courriel est envoyé automatiquement. Veuillez ne pas répondre à ce courriel.</p>"
    else:
        footer_note += "<p style=\"font-size:11px;color:#888\">This is an automated message. Please do not reply to this email.</p>"

    # Email content
    if lang == "fr":
        subject = f"Invitation — {meet_name}"
        deadline = (f"<p style=\"color:#c00;font-weight:bold\">⚠️ Date limite d'inscription : {closure_date}. "
                    f"Après cette date, vous ne pourrez plus accéder au portail d'inscription.</p>") if closure_date else ""
        html = (f"<p>Bonjour,</p>"
                f"<p>Vous êtes invité(e) à inscrire les athlètes de votre équipe "
                f"<strong>{club.name}</strong> à la compétition <strong>{meet_name}</strong>"
                f"{f', organisée par <strong>{org_club_name}</strong>' if org_club_name else ''}.</p>"
                f"{deadline}"
                f"<p><strong>Marche à suivre :</strong></p>"
                f"<ol>"
                f"<li><strong>Récupérer votre NIP.</strong> Cliquer sur le lien sécurisé ci-dessous "
                f"pour afficher votre NIP. <em>Le lien est à usage unique et expire dans 7 jours — "
                f"prenez le NIP en note immédiatement, il ne pourra plus être affiché par la suite.</em>"
                f"<br><a href=\"{secret_url}\">{secret_url}</a></li>"
                f"<li><strong>Ouvrir le portail d'inscription</strong> à l'adresse "
                f"<a href=\"{base_url}\">{base_url}</a> et se connecter avec le NIP de votre équipe.</li>"
                f"<li><strong>Inscrire vos athlètes.</strong> Sélectionner un athlète, "
                f"cocher les épreuves, choisir la catégorie (15-18 / Open / Masters) et "
                f"ajuster le temps d'inscription si nécessaire. Répéter pour chaque athlète à inscrire.</li>"
                f"</ol>"
                f"<p>Bonne compétition!</p>"
                f"{footer_note}")
    else:
        subject = f"Invitation — {meet_name}"
        deadline = (f"<p style=\"color:#c00;font-weight:bold\">⚠️ Entry deadline: {closure_date}. "
                    f"After this date, you will no longer be able to access the registration portal.</p>") if closure_date else ""
        html = (f"<p>Hello,</p>"
                f"<p>You are invited to register the athletes of your team "
                f"<strong>{club.name}</strong> for <strong>{meet_name}</strong>"
                f"{f', organized by <strong>{org_club_name}</strong>' if org_club_name else ''}.</p>"
                f"{deadline}"
                f"<p><strong>How to proceed:</strong></p>"
                f"<ol>"
                f"<li><strong>Get your PIN.</strong> Click the secure link below to reveal your PIN. "
                f"<em>The link can only be used once and expires in 7 days — write the PIN down "
                f"immediately, it will not be shown again.</em>"
                f"<br><a href=\"{secret_url}\">{secret_url}</a></li>"
                f"<li><strong>Open the registration portal</strong> at "
                f"<a href=\"{base_url}\">{base_url}</a> and log in with your team's PIN.</li>"
                f"<li><strong>Register your athletes.</strong> Pick an athlete, check the events, "
                f"select the category (15-18 / Open / Masters) and adjust the entry time if needed. "
                f"Repeat for every athlete you want to register.</li>"
                f"</ol>"
                f"<p>Good luck!</p>"
                f"{footer_note}")

    from_email = os.environ.get("RESEND_FROM_EMAIL", "noreply@example.com")
    resp = httpx.post("https://api.resend.com/emails", json={
        "from": from_email,
        "to": [club.email],
        "subject": subject,
        "html": html,
    }, headers={"Authorization": f"Bearer {resend_key}"}, timeout=10)

    if resp.status_code not in (200, 201):
        raise HTTPException(502, f"Resend error: {resp.text}")

    club.invite_send_count = (club.invite_send_count or 0) + 1
    db.commit()

    return {"message": f"Email sent to {club.email}"}


@router.get("/self-invite/clubs")
def self_invite_clubs(db: Session = Depends(get_db)):
    """Public: list all clubs."""
    clubs = db.query(TeamClub).order_by(TeamClub.name).all()
    return [{"id": c.clubsid, "name": c.name} for c in clubs]


@router.post("/self-invite")
def self_invite(data: dict, request: Request, db: Session = Depends(get_db)):
    """Public: a club requests its own invitation email."""
    import httpx
    turnstile_secret = os.environ.get("TURNSTILE_SECRET_KEY", "")
    captcha_token = data.get("captcha_token", "")
    if turnstile_secret:
        if not captcha_token:
            raise HTTPException(400, "CAPTCHA required")
        ip = request.client.host if request.client else ""
        resp = httpx.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", data={
            "secret": turnstile_secret,
            "response": captcha_token,
            "remoteip": ip,
        }, timeout=5)
        if not resp.json().get("success"):
            raise HTTPException(400, "CAPTCHA validation failed")

    club_id = data.get("club_id")
    email = (data.get("email") or "").strip().lower()
    lang = data.get("lang", "fr")
    if not club_id:
        raise HTTPException(400, "club_id required")
    if not email:
        raise HTTPException(400, "email required")

    club = db.get(TeamClub, club_id)
    if not club:
        raise HTTPException(404, "Club not found")

    if club.email:
        # Club has a configured email — validate it matches
        if email != club.email.strip().lower():
            org_cfg = _get_config(db, "organizer_club_id")
            org_email = ""
            if org_cfg:
                org_club = db.get(TeamClub, int(org_cfg))
                if org_club:
                    org_email = org_club.email or ""
            raise HTTPException(403, f"email_mismatch|{org_email}")
    else:
        # Club has no email configured — save the provided one
        club.email = email
        db.commit()

    return send_pin(club_id, {"lang": lang}, db)


@router.post("/secret/{token}")
def reveal_secret(token: str, db: Session = Depends(get_db)):
    """One-time reveal of encrypted PIN."""
    import hashlib, base64
    from cryptography.fernet import Fernet

    link = db.query(SecretLink).filter(SecretLink.token == token).first()
    if not link:
        raise HTTPException(404, "Lien introuvable. / Link not found.")
    if link.viewed:
        raise HTTPException(410, "Ce lien a déjà été utilisé. / This link has already been viewed.")
    if datetime.utcnow() > link.expires_at:
        raise HTTPException(410, "Ce lien est expiré. / This link has expired.")

    fernet_key = os.environ.get("SECRET_KEY")
    if not fernet_key:
        raise HTTPException(500, "SECRET_KEY not configured")
    key = base64.urlsafe_b64encode(hashlib.sha256(fernet_key.encode()).digest())
    f = Fernet(key)
    pin = f.decrypt(link.pin_encrypted.encode()).decode()

    link.viewed = True
    db.commit()

    club = db.get(TeamClub, link.club_id)
    return {"pin": pin, "club": club.name if club else ""}


# ---------------------------------------------------------------------------
# Athletes
# ---------------------------------------------------------------------------

@router.get("/athletes/all-grouped")
def list_athletes_grouped(request: Request, db: Session = Depends(get_db)):
    """Return all athletes grouped by club in a single response (avoids N+1 requests)."""
    pin = request.headers.get("X-Club-Pin", "")
    role, caller_club = _resolve_role(pin, db)
    if role == "none":
        raise HTTPException(401, "Authentication required")

    q = db.query(Member).options(joinedload(Member.club)).order_by(Member.lastname, Member.firstname)
    if role == "coach":
        q = q.filter(Member.clubsid == caller_club)

    athletes = q.all()
    grouped: dict[int, list] = defaultdict(list)
    for a in athletes:
        grouped[a.clubsid].append({
            "id": a.membersid, "first_name": a.firstname, "last_name": a.lastname,
            "gender": gender_to_str(a.gender),
            "birthdate": str(a.birthdate.date()) if a.birthdate else None,
            "license": a.license, "club": a.club.name if a.club else "",
            "club_id": a.clubsid,
        })
    return grouped


@router.get("/athletes")
def list_athletes(request: Request, club_id: int = None, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    role, caller_club = _resolve_role(pin, db)
    if role == "none":
        raise HTTPException(401, "Authentication required")
    if role == "coach":
        club_id = caller_club
    q = db.query(Member).options(joinedload(Member.club))
    if club_id:
        q = q.filter(Member.clubsid == club_id)
    athletes = q.order_by(Member.lastname, Member.firstname).all()
    return [{
        "id": a.membersid, "first_name": a.firstname, "last_name": a.lastname,
        "gender": gender_to_str(a.gender),
        "birthdate": str(a.birthdate.date()) if a.birthdate else None,
        "license": a.license, "club": a.club.name if a.club else "",
        "club_id": a.clubsid,
    } for a in athletes]


@router.post("/athletes")
def create_athlete(data: AthleteCreate, request: Request, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)
    caller_club = _caller_club_id(db, pin)
    if caller_club is not None and data.club_id != caller_club:
        raise HTTPException(403, "Cannot create athletes in another club")
    from datetime import date as d
    member = Member(
        firstname=data.first_name,
        lastname=data.last_name,
        gender=gender_from_str(data.gender),
        birthdate=d.fromisoformat(data.birthdate) if data.birthdate else None,
        license=data.license,
        clubsid=data.club_id,
    )
    db.add(member)
    db.commit()
    return {"id": member.membersid}


@router.delete("/athletes/{athlete_id}")
def delete_athlete(athlete_id: int, request: Request, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)
    member = db.get(Member, athlete_id)
    if not member:
        raise HTTPException(404)
    caller_club = _caller_club_id(db, pin)
    if caller_club is not None and member.clubsid != caller_club:
        raise HTTPException(403, "Cannot delete athletes from another club")
    db.query(SwimResult).filter(SwimResult.athleteid == athlete_id).delete()
    db.delete(member)
    db.commit()
    return {"deleted": True}


@router.put("/athletes/{athlete_id}")
def update_athlete(athlete_id: int, data: AthleteUpdate, request: Request, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)
    member = db.get(Member, athlete_id)
    if not member:
        raise HTTPException(404)
    role, caller_club = _resolve_role(pin, db)
    if caller_club is not None and member.clubsid != caller_club:
        raise HTTPException(403, "Cannot modify athletes from another club")
    if data.first_name is not None:
        member.firstname = data.first_name
    if data.last_name is not None:
        member.lastname = data.last_name
    if data.gender is not None:
        member.gender = gender_from_str(data.gender)
    if data.birthdate is not None:
        from datetime import date as d
        member.birthdate = d.fromisoformat(data.birthdate) if data.birthdate else None
    if data.license is not None:
        member.license = data.license
    if data.handicapex is not None:
        member.handicapex = data.handicapex or None
    if data.club_id is not None and data.club_id != member.clubsid:
        if role not in ("admin", "organizer"):
            raise HTTPException(403, "Only admin or organizer can change an athlete's club")
        target_club = db.get(TeamClub, data.club_id)
        if not target_club:
            raise HTTPException(404, "Target club not found")
        from ..models_team import RelayPos
        on_relay = db.query(RelayPos).filter(RelayPos.membersid == athlete_id).first()
        if on_relay:
            raise HTTPException(409, "Cannot change club while athlete is on a relay team — remove them from all relay teams first")
        member.clubsid = data.club_id
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Sessions (for shared EventsPage)
# ---------------------------------------------------------------------------

@router.get("/sessions")
def list_sessions(db: Session = Depends(get_db)):
    sessions = db.query(SwimSession).order_by(SwimSession.sessionnumber).all()
    result = []
    for s in sessions:
        events_data = []
        for e in sorted(s.events, key=lambda x: x.sortcode or x.eventnumber or 0):
            ags = db.query(AgeGroup).filter(AgeGroup.swimeventid == e.swimeventid).order_by(AgeGroup.sortcode).all()
            is_admin = e.internalevent == "T" or e.swimstyleid is None
            name = (e.comment or "Pause") if is_admin else (e.roundname or (e.swimstyle.name if e.swimstyle else ""))
            events_data.append({
                "id": e.swimeventid,
                "sessionId": s.swimsessionid,
                "number": e.eventnumber or 0,
                "nameFr": name,
                "nameEn": name,
                "gender": "M" if e.gender == 1 else "F" if e.gender == 2 else "X",
                "distance": e.swimstyle.distance if e.swimstyle else 0,
                "phase": "Eliminatoire" if e.round == 1 else "Finale" if e.round == 4 else "Finale directe",
                "isAdmin": is_admin,
                "swimstyleId": e.swimstyleid,
                "fee": e.fee,
                "masters": e.masters == "T",
                "maxEntries": e.maxentries,
                "finalOrder": e.finalorder,
                "scheduledTime": e.daytime.strftime("%H:%M") if e.daytime else None,
                "duration": e.duration.strftime("%H:%M") if e.duration else None,
                "ageGroups": [{
                    "id": ag.agegroupid,
                    "number": i + 1,
                    "name": ag.name or (f"{ag.agemin}-{ag.agemax}" if ag.agemin is not None else "???"),
                    "minAge": ag.agemin or 0,
                    # agemax uses -1 or >=99 as a Splash "Open" (no upper limit) sentinel — normalize to null
                    "maxAge": None if ag.agemax is None or ag.agemax < 0 or ag.agemax >= 99 else ag.agemax,
                    "gender": "M" if ag.gender == 1 else "F" if ag.gender == 2 else ("M" if e.gender == 1 else "F" if e.gender == 2 else "X"),
                    "numHeats": ag.heatcount or 1,
                    "ranking": "By time",
                    "countForMedalStats": ag.useformedals == "T",
                    "usedForCombined": False,
                    "alwaysSwimPrelims": True,
                    "advanceByTime": False,
                    "laneOrderInFinals": "By time",
                } for i, ag in enumerate(ags)],
            })
        result.append({
            "id": s.swimsessionid,
            "number": s.sessionnumber or 0,
            "name": s.name or "",
            "date": s.startdate.isoformat() if s.startdate else None,
            "time": s.daytime.strftime("%H:%M") if s.daytime else None,
            "endTime": s.endtime.strftime("%H:%M") if s.endtime else None,
            "poolSize": 50 if s.course == 1 else 25,
            "laneMin": s.lanemin,
            "laneMax": s.lanemax,
            "warmupFrom": s.warmupfrom.strftime("%H:%M") if s.warmupfrom else None,
            "warmupUntil": s.warmupuntil.strftime("%H:%M") if s.warmupuntil else None,
            "officialMeeting": s.officialmeeting.strftime("%H:%M") if s.officialmeeting else None,
            "remarks": s.remarks,
            "remarksJury": s.remarksjury,
            "maxEntriesAthlete": s.maxentriesathlete,
            "maxEntriesRelay": s.maxentriesrelay,
            "feeAthlete": s.feeathlete,
            "timing": s.timing,
            "touchpadMode": s.touchpadmode,
            "roundToTenths": s.roundtotenths == "T",
            "events": events_data,
        })
    return result


@router.put("/sessions/{session_id}", dependencies=[Depends(require_organizer_or_admin)])
def update_session(session_id: int, data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Update session fields (name, date, times, lanes, etc.)."""
    session = db.get(SwimSession, session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    field_map = {
        "name": "name",
        "sessionnumber": "sessionnumber",
        "startdate": "startdate",
        "daytime": "daytime",
        "endtime": "endtime",
        "course": "course",
        "lanemin": "lanemin",
        "lanemax": "lanemax",
        "warmupfrom": "warmupfrom",
        "warmupuntil": "warmupuntil",
        "officialmeeting": "officialmeeting",
        "remarks": "remarks",
        "remarksjury": "remarksjury",
        "maxentriesathlete": "maxentriesathlete",
        "maxentriesrelay": "maxentriesrelay",
        "feeathlete": "feeathlete",
        "timing": "timing",
        "touchpadmode": "touchpadmode",
        "roundtotenths": "roundtotenths",
    }

    for key, col in field_map.items():
        if key in data:
            val = data[key]
            if key == "roundtotenths":
                val = "T" if val else "F"
            elif key == "startdate" and val:
                from datetime import date as _d
                try:
                    val = _d.fromisoformat(val)
                except (ValueError, TypeError):
                    val = None
            elif key in ("daytime", "endtime", "warmupfrom", "warmupuntil", "officialmeeting") and val:
                if ":" in str(val) and "-" not in str(val):
                    val = datetime(2000, 1, 1, *[int(x) for x in str(val).split(":")[:2]])
            setattr(session, col, val if val != "" else None)

    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

@router.get("/events")
def list_events(db: Session = Depends(get_db)):
    events = db.query(SwimEvent).options(
        joinedload(SwimEvent.swimstyle)
    ).order_by(SwimEvent.eventnumber).all()
    return [{
        "id": e.swimeventid,
        "style_uid": e.swimstyleid,
        "style_name": e.swimstyle.name if e.swimstyle else "",
        "distance": e.swimstyle.distance if e.swimstyle else 0,
        "relay_count": e.swimstyle.relaycount if e.swimstyle else 1,
        "gender": e.gender,
        "event_number": e.eventnumber,
        "round": e.round,
        "masters": e.masters == "T",
    } for e in events]


@router.get("/swim-styles")
def list_swim_styles(db: Session = Depends(get_db)):
    """Swim styles for the current meet only.

    The style catalog is never pruned across meets (historical events/results
    keep referencing old style ids — see create_new_meet), so without this
    filter a beach meet would still offer every pool style ever loaded, and
    vice versa. Pool/beach ids never overlap (501-540 vs 601-605).
    """
    styles = db.query(SwimStyle).order_by(SwimStyle.distance, SwimStyle.stroke).all()
    if _get_meet_type(db) == "BEACH":
        styles = [s for s in styles if s.swimstyleid and s.swimstyleid >= 600]
    else:
        styles = [s for s in styles if s.swimstyleid and s.swimstyleid < 600]
    return [{
        "id": s.swimstyleid,
        "distance": s.distance or 0,
        "stroke": s.stroke or 1,
        "name": s.name or "",
        "relaycount": s.relaycount or 1,
    } for s in styles]


# ---------------------------------------------------------------------------
# Session / Event / AgeGroup CRUD (organizer + admin)
# ---------------------------------------------------------------------------

@router.post("/sessions", dependencies=[Depends(require_organizer_or_admin)])
def create_session(data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Create a new session."""
    from sqlalchemy import func
    next_id = (db.query(func.max(SwimSession.swimsessionid)).scalar() or 0) + 1
    name = data.get("name", "New Session")
    number = data.get("number", 1)
    session = SwimSession(swimsessionid=next_id, name=name, sessionnumber=number,
                          course=1, following='F', poolglobal='F', roundtotenths='F')
    db.add(session)
    db.commit()
    return {"id": next_id}


@router.delete("/sessions/{session_id}", dependencies=[Depends(require_organizer_or_admin)])
def delete_session(session_id: int, db: Session = Depends(get_db)):
    """Delete a session and all its events."""
    session = db.get(SwimSession, session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    # Delete events in this session (cascades to agegroups, heats, results)
    db.query(AgeGroup).filter(
        AgeGroup.swimeventid.in_(
            db.query(SwimEvent.swimeventid).filter(SwimEvent.swimsessionid == session_id)
        )
    ).delete(synchronize_session=False)
    db.query(SwimEvent).filter(SwimEvent.swimsessionid == session_id).delete()
    db.delete(session)
    db.commit()
    return {"ok": True}


@router.post("/events", dependencies=[Depends(require_organizer_or_admin)])
def create_event(data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Create a new event in a session, or a pause/break marker.

    Accepts: sessionId, number, gender, phase, swimstyleId (optional).
    If no swimstyleId provided, picks the first available style not already used in the meet.
    isBreak=true creates a pause/break marker instead (internalevent='T', no swimstyle);
    breakName sets its display name.
    """
    from sqlalchemy import func

    session_id = data.get("sessionId") or data.get("session_id")
    if not session_id:
        raise HTTPException(400, "sessionId required")

    number = data.get("number", 1)
    gender_str = data.get("gender", "X")
    gender_int = {"M": GENDER_M, "F": GENDER_F, "X": GENDER_MIXED}.get(gender_str, GENDER_MIXED)
    phase = data.get("phase", "Finale directe")
    round_int = {"Eliminatoire": 1, "Finale": 4, "Finale directe": 5}.get(phase, 5)

    if data.get("isBreak"):
        max_sort = db.query(func.max(SwimEvent.sortcode)).filter(
            SwimEvent.swimsessionid == session_id
        ).scalar() or 0
        next_id = (db.query(func.max(SwimEvent.swimeventid)).scalar() or 0) + 1
        break_name = data.get("breakName") or "Pause"

        event = SwimEvent(
            swimeventid=next_id,
            swimsessionid=session_id,
            eventnumber=number,
            gender=gender_int,
            round=round_int,
            swimstyleid=None,
            sortcode=max_sort + 1,
            internalevent='T',
            comment=break_name,
            splashmecanedit='F',
            masters='F',
            pfineignore='F',
        )
        db.add(event)
        db.commit()
        return {"id": next_id, "name": break_name, "distance": 0, "swimstyleId": None}

    # Determine swimstyle
    swimstyle_id = data.get("swimstyleId") or data.get("swimstyleid")
    if not swimstyle_id:
        # Pick the next available style not yet used in this meet.
        # If all styles are used, pick the next one after the last event's style
        # in the target session (cycling through the style list).
        used_styles = [e.swimstyleid for e in db.query(SwimEvent).filter(
            SwimEvent.swimstyleid.isnot(None)
        ).all()]
        used_set = set(used_styles)

        all_individual_styles = db.query(SwimStyle).filter(
            SwimStyle.relaycount == 1,
        ).order_by(SwimStyle.sortcode, SwimStyle.swimstyleid).all()

        if not all_individual_styles:
            swimstyle_id = None
        else:
            # Try to find an unused style first
            unused = [s for s in all_individual_styles if s.swimstyleid not in used_set]
            if unused:
                swimstyle_id = unused[0].swimstyleid
            else:
                # All used — cycle: find the last style used in this session and pick the next one
                last_event = db.query(SwimEvent).filter(
                    SwimEvent.swimsessionid == session_id,
                    SwimEvent.swimstyleid.isnot(None),
                ).order_by(SwimEvent.sortcode.desc()).first()

                style_ids = [s.swimstyleid for s in all_individual_styles]
                if last_event and last_event.swimstyleid in style_ids:
                    idx = style_ids.index(last_event.swimstyleid)
                    next_idx = (idx + 1) % len(style_ids)
                    swimstyle_id = style_ids[next_idx]
                else:
                    swimstyle_id = style_ids[0]

    # Get next sort code
    max_sort = db.query(func.max(SwimEvent.sortcode)).filter(
        SwimEvent.swimsessionid == session_id
    ).scalar() or 0

    next_id = (db.query(func.max(SwimEvent.swimeventid)).scalar() or 0) + 1

    event = SwimEvent(
        swimeventid=next_id,
        swimsessionid=session_id,
        eventnumber=number,
        gender=gender_int,
        round=round_int,
        swimstyleid=swimstyle_id,
        sortcode=max_sort + 1,
        internalevent='F',
        splashmecanedit='F',
        masters='F',
        pfineignore='F',
    )
    db.add(event)
    db.commit()

    # Return event info including name from swimstyle
    style = db.get(SwimStyle, swimstyle_id) if swimstyle_id else None
    return {
        "id": next_id,
        "name": style.name if style else "",
        "distance": style.distance if style else 0,
        "swimstyleId": swimstyle_id,
    }


@router.put("/events/reorder", dependencies=[Depends(require_organizer_or_admin)])
def reorder_events(data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Reorder events: accepts {updates: [{eventId, sessionId, sortcode}]}."""
    updates = data.get("updates", [])
    for u in updates:
        event = db.get(SwimEvent, u["eventId"])
        if event:
            event.swimsessionid = u.get("sessionId", event.swimsessionid)
            event.sortcode = u["sortcode"]
    db.commit()
    return {"ok": True}


@router.put("/events/{event_id}", dependencies=[Depends(require_organizer_or_admin)])
def update_event(event_id: int, data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Update event fields (gender, swimstyle, number, round, maxentries, etc.)."""
    event = db.get(SwimEvent, event_id)
    if not event:
        raise HTTPException(404, "Event not found")

    field_map = {
        "gender": "gender",
        "eventnumber": "eventnumber",
        "round": "round",
        "swimstyleid": "swimstyleid",
        "maxentries": "maxentries",
        "fee": "fee",
        "sortcode": "sortcode",
        "comment": "comment",
        "masters": "masters",
        "internalevent": "internalevent",
        "finalorder": "finalorder",
        "preveventid": "preveventid",
        "daytime": "daytime",
        "duration": "duration",
    }

    for key, col in field_map.items():
        if key in data:
            val = data[key]
            # Convert gender string to int if needed
            if key == "gender" and isinstance(val, str):
                val = {"M": 1, "F": 2, "X": 0}.get(val, 0)
            elif key in ("daytime", "duration") and val:
                if ":" in str(val) and "-" not in str(val):
                    val = datetime(2000, 1, 1, *[int(x) for x in str(val).split(":")[:2]])
            setattr(event, col, val)

    db.commit()
    return {"ok": True}


@router.delete("/events/{event_id}", dependencies=[Depends(require_organizer_or_admin)])
def delete_event(event_id: int, db: Session = Depends(get_db)):
    """Delete an event and its age groups."""
    event = db.get(SwimEvent, event_id)
    if not event:
        raise HTTPException(404, "Event not found")
    db.query(AgeGroup).filter(AgeGroup.swimeventid == event_id).delete()
    db.delete(event)
    db.commit()
    return {"ok": True}


@router.post("/age-groups", dependencies=[Depends(require_organizer_or_admin)])
def create_age_group(data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Create an age group for an event."""
    from sqlalchemy import func
    event_id = data.get("eventId") or data.get("event_id")
    if not event_id:
        raise HTTPException(400, "eventId required")

    next_id = (db.query(func.max(AgeGroup.agegroupid)).scalar() or 0) + 1
    name = data.get("name", "")
    min_age = data.get("minAge", 0)
    max_age = data.get("maxAge")
    gender_str = data.get("gender", "X")
    gender_int = {"M": GENDER_M, "F": GENDER_F, "X": GENDER_MIXED}.get(gender_str, GENDER_MIXED)

    max_sort = db.query(func.max(AgeGroup.sortcode)).filter(
        AgeGroup.swimeventid == event_id
    ).scalar() or 0

    ag = AgeGroup(
        agegroupid=next_id,
        swimeventid=event_id,
        name=name,
        agemin=min_age,
        agemax=max_age if max_age and max_age > 0 else -1,
        gender=gender_int,
        sortcode=max_sort + 1,
    )
    db.add(ag)
    db.commit()
    return {"id": next_id}


@router.put("/age-groups/{agegroup_id}", dependencies=[Depends(require_organizer_or_admin)])
def update_age_group(agegroup_id: int, data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Update age group fields."""
    ag = db.get(AgeGroup, agegroup_id)
    if not ag:
        raise HTTPException(404, "Age group not found")
    for key in ("name", "agemin", "agemax", "gender", "heatcount", "sortcode"):
        if key in data:
            setattr(ag, key, data[key])
    db.commit()
    return {"ok": True}


@router.put("/age-groups/{agegroup_id}/move", dependencies=[Depends(require_organizer_or_admin)])
def move_age_group(agegroup_id: int, data: dict = Body(default={}), db: Session = Depends(get_db)):
    """
    Move an age group (and every entry registered under it) to a different
    event of the same swim style, without losing entries. Used to split an
    event that hosts multiple age brackets — recreating the age group under
    a new event would orphan its swimresult rows, which are keyed by
    (swimeventid, agegroupid).

    Entries seeded into heats are unseeded as part of the move (heats are
    per-event; moving them across events risks heat-number collisions), so
    both the source and target events need heats regenerated afterward.
    """
    target_event_id = data.get("targetEventId") or data.get("target_event_id")
    if not target_event_id:
        raise HTTPException(400, "targetEventId required")

    ag = db.get(AgeGroup, agegroup_id)
    if not ag:
        raise HTTPException(404, "Age group not found")

    source_event_id = ag.swimeventid
    if source_event_id == target_event_id:
        return {"ok": True}

    source_event = db.get(SwimEvent, source_event_id)
    target_event = db.get(SwimEvent, target_event_id)
    if not target_event:
        raise HTTPException(404, "Target event not found")
    if not source_event or source_event.swimstyleid != target_event.swimstyleid:
        raise HTTPException(400, "Target event must be the same swim style as the age group's current event")

    source_style = db.get(SwimStyle, source_event.swimstyleid)
    target_style = db.get(SwimStyle, target_event.swimstyleid)
    if (source_style and source_style.relaycount > 1) or (target_style and target_style.relaycount > 1):
        raise HTTPException(400, "Moving age groups is only supported for individual events, not relays")

    # Registrations in this schema aren't linked via agegroupid (that column is
    # only populated by historical/LXF imports) — the live coach-registration
    # flow stamps swimresult.age_code with an event-independent string code
    # ("15-18", "Open", etc. — see _age_group_code) instead. Match on that
    # (plus the athlete's gender, in case one event hosts the same age
    # bracket for two genders) to find the entries that actually belong here.
    age_code = _age_group_code(ag.agemin, ag.agemax)
    if age_code is None:
        raise HTTPException(400, "Cannot determine the age code for this age group")

    matching_query = db.query(SwimResult).join(Member, SwimResult.athleteid == Member.membersid).filter(
        SwimResult.swimeventid == source_event_id,
        SwimResult.age_code == age_code,
    )
    if ag.gender in (GENDER_M, GENDER_F):
        matching_query = matching_query.filter(Member.gender == ag.gender)

    validated = (
        matching_query
        .join(Heat, SwimResult.heatid == Heat.heatid)
        .filter(Heat.racestatus == 5)
        .first()
    )
    if validated:
        raise HTTPException(409, "Cannot move: some heats for this age group are already validated. Invalidate them first.")

    matching_ids = [r.swimresultid for r in matching_query.all()]
    if matching_ids:
        try:
            db.query(SwimResult).filter(SwimResult.swimresultid.in_(matching_ids)).update(
                {SwimResult.swimeventid: target_event_id, SwimResult.heatid: None, SwimResult.lane: None},
                synchronize_session=False,
            )
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "Cannot move: an athlete is already registered for this age bracket on the target event")

    from sqlalchemy import func
    max_sort = db.query(func.max(AgeGroup.sortcode)).filter(AgeGroup.swimeventid == target_event_id).scalar() or 0
    ag.swimeventid = target_event_id
    ag.sortcode = max_sort + 1

    db.commit()
    return {"ok": True, "movedRegistrations": len(matching_ids)}


@router.delete("/age-groups/{agegroup_id}", dependencies=[Depends(require_organizer_or_admin)])
def delete_age_group(agegroup_id: int, db: Session = Depends(get_db)):
    """Delete an age group."""
    ag = db.get(AgeGroup, agegroup_id)
    if not ag:
        raise HTTPException(404, "Age group not found")
    db.delete(ag)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Registration detail (athlete entry page)
# ---------------------------------------------------------------------------

@router.get("/athletes/{athlete_id}/registration")
def get_registration(athlete_id: int, db: Session = Depends(get_db)):
    member = db.query(Member).options(joinedload(Member.club)).get(athlete_id)
    if not member:
        raise HTTPException(404, "Athlete not found")

    # Get all registrations for this athlete
    regs = db.query(SwimResult).filter(
        SwimResult.athleteid == athlete_id,
    ).all()
    reg_map = {(r.swimeventid, r.age_code): r for r in regs}

    # Get best times — try new system (historical results) first, fall back to JSON blobs
    best_map_lcm: dict[int, int] = {}
    best_map_scm: dict[int, int] = {}

    if member.membersid:
        bt_data = get_best_times_for_member(db, member.membersid, _BEST_TIME_MAX_AGE_MONTHS)
        for uid_key, style_data in bt_data.items():
            uid = int(uid_key)
            if "LCM" in style_data:
                best_map_lcm[uid] = style_data["LCM"]["time_ms"]
            if "SCM" in style_data:
                best_map_scm[uid] = style_data["SCM"]["time_ms"]

    events = db.query(SwimEvent).options(
        joinedload(SwimEvent.agegroups),
        joinedload(SwimEvent.swimstyle),
    ).order_by(SwimEvent.eventnumber).all()

    ath_gender_int = member.gender

    # Build style groups
    styles: dict[int, dict] = {}

    for ev in events:
        if ev.round == ROUND_FIN:  # skip finals
            continue
        style = ev.swimstyle
        if not style:
            continue
        relay_count = style.relaycount or 1
        # Individual-event gender filter
        if relay_count == 1 and ev.gender not in (0, 3) and ev.gender != ath_gender_int:
            continue

        is_masters = ev.masters == "T"
        if is_masters:
            event_codes = ["Masters"]
        else:
            event_codes = []
            for ag in ev.agegroups:
                code = _age_group_code(ag.agemin, ag.agemax)
                if code and code not in event_codes:
                    event_codes.append(code)
        if not event_codes:
            continue

        if ev.swimstyleid not in styles:
            styles[ev.swimstyleid] = {
                "style_uid": ev.swimstyleid,
                "style_name": style.name or "",
                "distance": style.distance or 0,
                "relay_count": relay_count,
                "categories": [],
            }
        style_group = styles[ev.swimstyleid]

        for code in event_codes:
            if any(c["age_code"] == code for c in style_group["categories"]):
                continue
            reg = reg_map.get((ev.swimeventid, code))
            style_group["categories"].append({
                "event_id": ev.swimeventid,
                "age_code": code,
                "registered": reg is not None,
                "registration_id": reg.swimresultid if reg else None,
                "entry_time_ms": reg.entrytime if reg else None,
            })

    # Sort categories
    order_idx = {c: i for i, c in enumerate(_AGE_CODE_ORDER)}
    for s in styles.values():
        s["categories"].sort(key=lambda c: order_idx.get(c["age_code"], 99))

    individual_events = [s for s in styles.values() if s["relay_count"] == 1]
    relay_events = [s for s in styles.values() if s["relay_count"] > 1]

    # Add best times
    for s in individual_events + relay_events:
        s["best_time_lcm_ms"] = best_map_lcm.get(s["style_uid"])
        s["best_time_scm_ms"] = best_map_scm.get(s["style_uid"])

    # Relay locks
    relay_uids = [s["style_uid"] for s in relay_events]
    locked_by: dict[int, str] = {}
    if relay_uids:
        other_relay_regs = (
            db.query(Member, SwimEvent)
            .join(SwimResult, SwimResult.athleteid == Member.membersid)
            .join(SwimEvent, SwimResult.swimeventid == SwimEvent.swimeventid)
            .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
            .filter(
                Member.clubsid == member.clubsid,
                Member.membersid != athlete_id,
                SwimEvent.swimstyleid.in_(relay_uids),
                SwimStyle.relaycount > 1,
            )
            .all()
        )
        for ath, ev in other_relay_regs:
            locked_by.setdefault(ev.swimstyleid, f"{ath.firstname} {ath.lastname}")
    for s in relay_events:
        s["locked_by_name"] = locked_by.get(s["style_uid"])

    # Club athletes for relay teammate selection
    club_athletes = db.query(Member).filter(
        Member.clubsid == member.clubsid,
        Member.membersid != athlete_id,
    ).order_by(Member.lastname).all()

    # Suggested age_code
    suggested_age_code = "Open"
    if member.birthdate:
        from datetime import date as d
        age_base_val = _get_config(db, "age_base_date")
        age_base = d.fromisoformat(age_base_val) if age_base_val else d(d.today().year, 12, 31)
        age = age_base.year - member.birthdate.year
        if age <= 10:
            suggested_age_code = "10-"
        elif 11 <= age <= 12:
            suggested_age_code = "11-12"
        elif 13 <= age <= 14:
            suggested_age_code = "13-14"
        elif 15 <= age <= 18:
            suggested_age_code = "15-18"

    meet_course = _get_config(db, "meet_course") or "LCM"
    meet_type = _get_meet_type(db)
    closure = _get_closure_date(db)

    return {
        "athlete": {
            "id": member.membersid, "first_name": member.firstname,
            "last_name": member.lastname, "gender": gender_to_str(member.gender),
            "birthdate": str(member.birthdate.date()) if member.birthdate else "",
            "license": member.license or "",
            "club": member.club.name, "club_id": member.clubsid,
            "handicapex": member.handicapex or "",
        },
        "suggested_age_code": suggested_age_code,
        "meet_course": meet_course,
        "meet_type": meet_type,
        "closure_date": closure,
        "individual_events": individual_events,
        "relay_events": relay_events,
        "club_athletes": [{"id": a.membersid, "name": f"{a.lastname}, {a.firstname}"}
                          for a in club_athletes],
    }


# ---------------------------------------------------------------------------
# Registrations (CRUD)
# ---------------------------------------------------------------------------

def _update_exception(db: Session, athlete_id: int):
    """Set handicapex='X' if member has any Masters registration."""
    has_masters = db.query(SwimResult).filter(
        SwimResult.athleteid == athlete_id,
        SwimResult.age_code == "Masters",
    ).first() is not None
    member = db.get(Member, athlete_id)
    if member:
        member.handicapex = "X" if has_masters else None


@router.get("/athletes/{athlete_id}/history")
def get_athlete_history(athlete_id: int, db: Session = Depends(get_db)):
    """Return an athlete's results across all historical meets."""
    from ..models_team import Meet, Result, Member as TMember

    member = db.get(TMember, athlete_id)
    if not member:
        raise HTTPException(404, "Athlete not found")

    # Get all results for this athlete, grouped by meet
    results = (
        db.query(Result)
        .filter(Result.membersid == athlete_id, Result.totaltime.isnot(None), Result.totaltime > 0)
        .order_by(Result.meetsid, Result.eventnumb)
        .all()
    )

    # Load meet info and style names
    meet_ids = list({r.meetsid for r in results})
    meets_map = {}
    if meet_ids:
        for m in db.query(Meet).filter(Meet.meetsid.in_(meet_ids)).all():
            if m.name == "__best_times_import__":
                continue
            meets_map[m.meetsid] = {
                "id": m.meetsid,
                "name": m.name,
                "date": m.mindate.strftime("%Y-%m-%d") if m.mindate else None,
                "course": {1: "LCM", 2: "SCY", 3: "SCM"}.get(m.course, "LCM"),
            }

    # Load style names
    import json as _json
    style_names_cfg = db.get(BsGlobal, "style_names_json")
    style_names: dict[int, str] = {}
    if style_names_cfg and style_names_cfg.data:
        try:
            style_names = {int(k): v for k, v in _json.loads(style_names_cfg.data).items()}
        except (ValueError, TypeError):
            pass
    # Also check swimstyle table
    for s in db.query(SwimStyle).all():
        if s.swimstyleid not in style_names and s.name:
            style_names[s.swimstyleid] = s.name

    # Build response grouped by meet
    meets_data = []
    for meet_id, meet_info in sorted(meets_map.items(), key=lambda x: x[1].get("date") or "", reverse=True):
        meet_results = [r for r in results if r.meetsid == meet_id]
        events = []
        for r in meet_results:
            events.append({
                "eventNumber": r.eventnumb,
                "style": style_names.get(r.stylesid, f"Style {r.stylesid}") if r.stylesid else "?",
                "styleId": r.stylesid,
                "time_ms": r.totaltime,
                "rank": r.rank,
                "course": {1: "LCM", 2: "SCY", 3: "SCM"}.get(r.course, "?"),
            })
        meets_data.append({**meet_info, "results": events})

    # Compute best times from historical results
    best_times = []
    style_best: dict[tuple[int, int], tuple[int, str, str | None]] = {}  # (style, course) → (time, meet_name, date)
    for r in results:
        if r.meetsid not in meets_map or not r.stylesid:
            continue
        key = (r.stylesid, r.course or 1)
        if key not in style_best or r.totaltime < style_best[key][0]:
            mi = meets_map[r.meetsid]
            style_best[key] = (r.totaltime, mi["name"], mi.get("date"))

    for (style_id, course_int), (time_ms, meet_name, meet_date) in sorted(style_best.items()):
        best_times.append({
            "style": style_names.get(style_id, f"Style {style_id}"),
            "styleId": style_id,
            "course": {1: "LCM", 2: "SCY", 3: "SCM"}.get(course_int, "?"),
            "time_ms": time_ms,
            "meetName": meet_name,
            "meetDate": meet_date,
        })

    return {
        "athlete": {
            "id": member.membersid,
            "name": f"{member.lastname}, {member.firstname}",
            "club": member.club.name if member.club else "",
            "gender": "M" if member.gender == 1 else "F",
        },
        "meets": meets_data,
        "bestTimes": best_times,
    }


@router.post("/registrations")
def create_registration(data: RegistrationCreate, request: Request, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)
    athlete_id = data.athlete_id
    event_id = data.event_id
    age_code = data.age_code
    entry_time_ms = data.entry_time_ms

    caller_club = _caller_club_id(db, pin)
    member = db.get(Member, athlete_id)
    if not member:
        raise HTTPException(404, "Athlete not found")
    if caller_club is not None and member.clubsid != caller_club:
        raise HTTPException(403, "Cannot register athletes from another club")

    event = db.get(SwimEvent, event_id)
    if not event:
        raise HTTPException(404, "Event not found")

    # Validate age_code
    if age_code == "Masters":
        if event.masters != "T":
            raise HTTPException(422, "Event does not accept Masters category")
    else:
        valid_codes = [_age_group_code(ag.agemin, ag.agemax)
                       for ag in db.query(AgeGroup).filter(AgeGroup.swimeventid == event_id).all()]
        if age_code not in valid_codes:
            raise HTTPException(422, f"age_code '{age_code}' not valid for this event")

    # Relay lock
    style = db.get(SwimStyle, event.swimstyleid)
    if style and style.relaycount and style.relaycount > 1:
        club_member_ids = [m.membersid for m in db.query(Member).filter(Member.clubsid == member.clubsid).all()]
        existing_relay = db.query(SwimResult).filter(
            SwimResult.swimeventid == event_id,
            SwimResult.athleteid.in_(club_member_ids),
            SwimResult.athleteid != athlete_id,
        ).first()
        if existing_relay:
            raise HTTPException(409, "Relay already has a registration from this club")

    existing = db.query(SwimResult).filter(
        SwimResult.athleteid == athlete_id,
        SwimResult.swimeventid == event_id,
        SwimResult.age_code == age_code,
    ).first()

    if existing:
        existing.entrytime = entry_time_ms
        db.commit()
        _update_exception(db, athlete_id)
        db.commit()
        return {"id": existing.swimresultid, "updated": True}

    result = SwimResult(
        athleteid=athlete_id,
        swimeventid=event_id,
        age_code=age_code,
        entrytime=entry_time_ms,
    )
    db.add(result)
    db.flush()

    db.commit()
    _update_exception(db, athlete_id)
    db.commit()
    return {"id": result.swimresultid, "updated": False}


@router.delete("/registrations/{reg_id}")
def delete_registration(reg_id: int, request: Request, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)
    reg = db.get(SwimResult, reg_id)
    if not reg:
        raise HTTPException(404)
    caller_club = _caller_club_id(db, pin)
    if caller_club is not None:
        member = db.get(Member, reg.athleteid)
        if not member or member.clubsid != caller_club:
            raise HTTPException(403, "Cannot modify registrations from another club")
    athlete_id = reg.athleteid
    db.delete(reg)
    db.commit()
    _update_exception(db, athlete_id)
    db.commit()
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Upload endpoints
# ---------------------------------------------------------------------------

@router.post("/upload/preview", dependencies=[Depends(require_admin)])
async def upload_preview(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Parse a Lenex .lxf and return counts without writing."""
    from ..seed import parse_lxf
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 10MB)")
    try:
        clubs_data = parse_lxf(content)
    except Exception as e:
        raise HTTPException(400, f"Invalid Lenex .lxf: {e}")

    clubs_new = 0
    athletes_new = 0
    for cd in clubs_data:
        if cd.get("code"):
            club = db.query(TeamClub).filter(TeamClub.code == cd["code"]).first()
        else:
            club = db.query(TeamClub).filter(TeamClub.name == cd["name"]).first()
        if not club:
            clubs_new += 1
            athletes_new += len(cd["athletes"])
        else:
            for ad in cd["athletes"]:
                existing = db.query(Member).filter(
                    Member.firstname == ad["first_name"],
                    Member.lastname == ad["last_name"],
                    Member.clubsid == club.clubsid,
                ).first()
                if not existing:
                    athletes_new += 1
    return {
        "clubs_new": clubs_new,
        "athletes_new": athletes_new,
        "clubs_in_file": len(clubs_data),
        "athletes_in_file": sum(len(cd["athletes"]) for cd in clubs_data),
    }


@router.post("/upload/entries", dependencies=[Depends(require_admin)])
async def upload_entries(file: UploadFile = File(...), force: bool = False, db: Session = Depends(get_db)):
    """Upload .lxf — seeds clubs + athletes and populates best times.

    If this file's own EVENT/SWIMSTYLE elements describe events not already
    in the local catalog — an empty catalog (first-time bootstrap), or a
    combined meet+entries export referencing a different meet than what's
    currently loaded — the current meet structure is replaced from this
    file's own definitions first (same wipe+rebuild as /upload/meet), so
    entries aren't silently dropped for referencing unknown event ids. Warns
    first (409, ?force=true to override) since this replaces the current
    meet's events/sessions/registrations and resets club PINs.
    """
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 10MB)")

    from ..meet_parser import parse_meet_lxf
    try:
        events_meet = parse_meet_lxf(content)
    except Exception:
        events_meet = None

    needs_reload = False
    missing_ids: set[int] = set()
    if events_meet and events_meet.all_events:
        existing_ids = {eid for (eid,) in db.query(SwimEvent.swimeventid).all()}
        file_ids = {ev.eventid for ses in events_meet.sessions for ev in ses.events}
        missing_ids = file_ids - existing_ids
        needs_reload = bool(missing_ids)

    if needs_reload and not force:
        from ..swimstyle_check import find_new_swimstyles
        new_styles = find_new_swimstyles(db, (
            (ev.swimstyleid, ev.style_name, ev.distance)
            for ses in events_meet.sessions for ev in ses.events
        ))
        message = (
            f"This file's meet structure doesn't match the current catalog "
            f"({len(missing_ids)} event id(s) not found locally). Importing will "
            f"replace the current meet's events, sessions and registrations with "
            f"this file's own structure, and reset club PINs."
        )
        if new_styles:
            message += f" It also introduces {len(new_styles)} new swimstyle id(s)."
        raise HTTPException(409, {
            "code": "new_swimstyles",
            "message": message,
            "styles": new_styles,
        })

    events_loaded = 0
    if needs_reload:
        events_loaded = _replace_current_meet_structure(db, events_meet, content, file.filename)
        db.flush()

    # Events must be in place before entries can resolve their eventid.
    seed_result = seed_from_lxf(db, content)

    # Import relay teams from LXF
    relays_imported = _import_relays_from_lxf(db, content)
    db.commit()

    return {**seed_result, "events_loaded": events_loaded, "relays_imported": relays_imported}


@router.post("/upload/results", dependencies=[Depends(require_admin)])
async def upload_results(file: UploadFile = File(...), force: bool = False, db: Session = Depends(get_db)):
    """Upload results .lxf to populate best times for the current meet.

    Warns if the LXF meet name doesn't match the current meet
    (suggesting to use the historical import endpoint instead).
    """
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 10MB)")

    # Cross-validation: warn if this looks like a different (historical) meet
    if not force:
        import zipfile
        from io import BytesIO
        from defusedxml.ElementTree import fromstring as _safe_parse
        try:
            with zipfile.ZipFile(BytesIO(content)) as z:
                lef_name = next(n for n in z.namelist() if n.endswith(".lef"))
                xml_root = _safe_parse(z.read(lef_name))
            meet_el = xml_root.find(".//MEET")
            if meet_el is not None:
                lxf_meet_name = meet_el.get("name", "").strip()
                current_meet_name = (_get_config(db, "meet_name") or "").strip()
                if lxf_meet_name and current_meet_name and lxf_meet_name.lower() != current_meet_name.lower():
                    raise HTTPException(409, (
                        f"This LXF is from '{lxf_meet_name}' but your current meet is "
                        f"'{current_meet_name}'. Use Admin → Import Historical instead. "
                        f"Pass ?force=true to override."
                    ))

            def _to_int(s):
                try:
                    return int(s)
                except (TypeError, ValueError):
                    return None

            from ..swimstyle_check import find_new_swimstyles
            new_styles = find_new_swimstyles(db, (
                (_to_int(ss.get("swimstyleid")), ss.get("name"), _to_int(ss.get("distance")))
                for ss in xml_root.iter("SWIMSTYLE")
            ))
            if new_styles:
                raise HTTPException(409, {
                    "code": "new_swimstyles",
                    "message": f"{len(new_styles)} swimstyle id(s) in this file are not in the local catalog.",
                    "styles": new_styles,
                })
        except (zipfile.BadZipFile, StopIteration, HTTPException) as e:
            if isinstance(e, HTTPException):
                raise
            # If we can't parse, just continue with the import

    seed_result = seed_from_lxf(db, content)

    # Store results in the historical Result table so best times can be computed
    from ..historical_import import import_historical_meet
    try:
        import_result = import_historical_meet(db, content, force=True)
        seed_result["results_imported"] = import_result.get("results_imported", 0)
    except Exception:
        seed_result["results_imported"] = 0

    return seed_result


@router.post("/admin/import-historical", dependencies=[Depends(require_admin)])
async def import_historical(file: UploadFile = File(...), force: bool = False, db: Session = Depends(get_db)):
    """Import a results LXF as a historical meet record.

    Stores the meet, events, and individual results separately from the current meet.
    Warns if the LXF meet name matches the current meet (use /upload/results instead).
    Pass ?force=true to override warnings.
    """
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 10MB)")
    from ..historical_import import import_historical_meet
    result = import_historical_meet(db, content, force=force)
    if result.get("needs_force"):
        if result.get("new_swimstyles"):
            raise HTTPException(409, {
                "code": "new_swimstyles",
                "message": result["warning"],
                "styles": result["new_swimstyles"],
            })
        raise HTTPException(409, result["warning"])
    return result


@router.get("/admin/historical-meets", dependencies=[Depends(require_admin)])
def list_historical_meets(db: Session = Depends(get_db)):
    """List all historical meets (excludes __best_times_import__ internal meet)."""
    from ..models_team import Meet, Result
    meets = (
        db.query(Meet)
        .filter(Meet.name != "__best_times_import__")
        .order_by(Meet.mindate.desc())
        .all()
    )
    result = []
    for m in meets:
        count = db.query(Result).filter(Result.meetsid == m.meetsid).count()
        result.append({
            "id": m.meetsid,
            "name": m.name,
            "date": m.mindate.strftime("%Y-%m-%d") if m.mindate else None,
            "course": {1: "LCM", 2: "SCY", 3: "SCM"}.get(m.course, "LCM"),
            "city": m.place or "",
            "resultCount": count,
        })
    return result


@router.delete("/admin/historical-meets/{meet_id}", dependencies=[Depends(require_admin)])
def delete_historical_meet(meet_id: int, db: Session = Depends(get_db)):
    """Delete a historical meet and all its results."""
    from ..models_team import Meet, Result, MemberMeet, Event
    meet = db.get(Meet, meet_id)
    if not meet:
        raise HTTPException(404, "Meet not found")
    # Don't allow deleting the __best_times_import__ pseudo-meet
    if meet.name == "__best_times_import__":
        raise HTTPException(400, "Cannot delete the best-times import record")
    db.query(Result).filter(Result.meetsid == meet_id).delete()
    db.query(MemberMeet).filter(MemberMeet.meetsid == meet_id).delete()
    db.query(Event).filter(Event.meetsid == meet_id).delete()
    db.delete(meet)
    db.commit()
    return {"ok": True, "deleted_meet": meet.name}


@router.get("/status")
def status(db: Session = Depends(get_db)):
    from ..models_team import Result
    # Count distinct (member, style, course) combinations with valid results
    bt_count = (
        db.query(Result.membersid, Result.stylesid, Result.course)
        .filter(
            Result.totaltime.isnot(None),
            Result.totaltime > 0,
            Result.resulttyp == 0,
        )
        .distinct()
        .count()
    )
    return {
        "clubs": db.query(TeamClub).count(),
        "athletes": db.query(Member).count(),
        "events": db.query(SwimEvent).count(),
        "registrations": db.query(SwimResult).count(),
        "best_times": bt_count,
    }


@router.delete("/registrations", dependencies=[Depends(require_admin)])
def flush_meet(db: Session = Depends(get_db)):
    """Flush meet: delete registrations, events, meet config. Reloads pool template."""
    reg_count = db.query(SwimResult).delete()
    db.query(Heat).delete()
    db.query(AgeGroup).delete()
    db.query(SwimEvent).delete()
    db.query(SwimSession).delete()
    # Clear Team Manager event tables BEFORE swimstyle (FK dependency)
    from ..models_team import Event as TeamEvent, Session as TeamSession, Meet as TeamMeet
    db.query(TeamEvent).delete()
    db.query(TeamSession).delete()
    db.query(TeamMeet).delete()
    db.query(SwimStyle).delete()
    for key in ("meet_filename", "meet_uploaded_at", "meet_name", "meet_course",
                "meet_masters", "meet_currency", "meet_fees_json", "closure_date",
                "organizer_club_id", "current_meetsid", "MEETVALUES",
                "meet_nation", "meet_city"):
        cfg = db.get(BsGlobal, key)
        if cfg:
            db.delete(cfg)
    # Reset age_base_date to Dec 31 of current year
    from datetime import date as _date
    year = _date.today().year
    _set_config(db, "age_base_date", f"{year}-12-31")
    _set_config(db, "MEETVALUES", f"AGEDATE=D;{year}1231000000000")
    db.query(TeamClub).update({TeamClub.invite_send_count: 0, TeamClub.stripe_send_count: 0})
    # Remove stored meet files
    if MEET_STORAGE.exists():
        MEET_STORAGE.unlink()
    # Reload pool template's swimstyle catalog only (no events — see _reload_pool_template)
    _reload_pool_template(db)
    db.commit()
    return {"deleted": reg_count}


def _reload_pool_template(db: Session) -> None:
    """Reload the pool template's swimstyle catalog into an empty meet.

    Only seeds SwimStyle (via the template's stub events, since Lenex has no standalone
    style catalog outside of events) — the stub session/events themselves are discarded,
    matching "New Pool/Beach meet" behavior. Real sessions/events are built by the organizer.
    """
    template_path = _get_pool_template_path()
    if not template_path.exists():
        print(f"[WARN] Pool template not found at {template_path}, skipping style reload")
        return
    from ..meet_parser import parse_meet_lxf
    from ..events import _load_from_parsed
    from ..models_team import Event as TeamEvent, Session as TeamSession
    meet = parse_meet_lxf(template_path)
    _load_from_parsed(db, meet)
    db.query(AgeGroup).delete()
    db.query(SwimEvent).delete()
    db.query(SwimSession).delete()
    db.query(TeamEvent).delete()
    db.query(TeamSession).delete()
    styles_loaded = db.query(SwimStyle).count()
    print(f"Reloaded {styles_loaded} swimstyles from pool template (no events)")


def _reset_for_next_meet(db: Session) -> None:
    """Flush current meet and prepare system for the next meet cycle.

    Called after an organizer closes the meet by importing final results.
    Preserves historical meets (meetstate=3), clubs, members, and best times.
    """
    # Clear Team Manager current (non-historical) meets first (FK to swimstyle)
    from ..models_team import (
        Event as TeamEvent, Session as TeamSession,
        Meet as TeamMeet, MemberMeet as TeamMemberMeet,
    )
    current_ids = [r for r, in db.query(TeamMeet.meetsid).filter(TeamMeet.meetstate != 3).all()]
    if current_ids:
        db.query(TeamMemberMeet).filter(TeamMemberMeet.meetsid.in_(current_ids)).delete(synchronize_session=False)
        db.query(TeamEvent).filter(TeamEvent.meetsid.in_(current_ids)).delete(synchronize_session=False)
        db.query(TeamSession).filter(TeamSession.meetsid.in_(current_ids)).delete(synchronize_session=False)
        db.query(TeamMeet).filter(TeamMeet.meetsid.in_(current_ids)).delete(synchronize_session=False)
    db.flush()

    # Clear Meet Manager schema (registrations + event structure). SwimStyle is
    # never wiped here — it's a shared catalog (upserted by id), and historical
    # Team Manager Event/Result rows we just preserved above still reference it.
    db.query(SwimResult).delete()
    db.query(Heat).delete()
    db.query(AgeGroup).delete()
    db.query(SwimEvent).delete()
    db.query(SwimSession).delete()

    # Clear bsglobal meet config.
    # Intentionally preserved: admin_pin, GEMINI_KEY_FREE, GEMINI_KEY_PAID, bt_* best-time keys.
    for key in ("meet_filename", "meet_uploaded_at", "meet_name", "meet_course",
                "meet_masters", "meet_currency", "meet_fees_json", "closure_date",
                "organizer_club_id", "current_meetsid", "MEETVALUES",
                "meet_nation", "meet_city"):
        cfg = db.get(BsGlobal, key)
        if cfg:
            db.delete(cfg)

    # Reset age_base_date to Dec 31 of current year
    from datetime import date as _date
    year = _date.today().year
    _set_config(db, "age_base_date", f"{year}-12-31")
    _set_config(db, "MEETVALUES", f"AGEDATE=D;{year}1231000000000")

    # Regenerate all club PINs and reset invite/payment counters
    for club in db.query(TeamClub).all():
        club.pin = ''.join(secrets.choice(string.digits) for _ in range(6))
    db.query(TeamClub).update({TeamClub.invite_send_count: 0, TeamClub.stripe_send_count: 0})

    # Remove stored meet files so startup doesn't re-load them
    if MEET_STORAGE.exists():
        MEET_STORAGE.unlink()

    # Reload pool template's swimstyle catalog only (no events — see _reload_pool_template)
    _reload_pool_template(db)


@router.post("/clubs/regenerate-pins", dependencies=[Depends(require_admin)])
def regenerate_pins(db: Session = Depends(get_db)):
    clubs = db.query(TeamClub).all()
    for club in clubs:
        club.pin = ''.join(secrets.choice(string.digits) for _ in range(6))
    db.commit()
    return {"regenerated": len(clubs)}


@router.post("/organizer/clubs/invite-all", dependencies=[Depends(require_organizer_or_admin)])
def invite_all_clubs(data: dict, request: Request, db: Session = Depends(get_db)):
    lang = data.get("lang", "fr")
    clubs = db.query(TeamClub).filter(TeamClub.email != None, TeamClub.email != "").all()
    sent = 0
    errors = []
    for club in clubs:
        try:
            send_pin(club.clubsid, {"lang": lang}, db)
            sent += 1
        except Exception as e:
            errors.append({"club": club.name, "error": str(e)})
    return {"sent": sent, "errors": errors}


@router.get("/admin/organizer", dependencies=[Depends(require_admin)])
def get_organizer(db: Session = Depends(get_db)):
    cfg = _get_config(db, "organizer_club_id")
    if not cfg:
        return {"club_id": None, "club_name": None}
    club = db.get(TeamClub, int(cfg))
    if not club:
        return {"club_id": None, "club_name": None}
    return {"club_id": club.clubsid, "club_name": club.name}


@router.post("/admin/set-organizer", dependencies=[Depends(require_admin)])
def set_organizer(data: dict, db: Session = Depends(get_db)):
    club_id = data.get("club_id")
    if club_id is None:
        raise HTTPException(400, "club_id required")
    if not db.get(TeamClub, club_id):
        raise HTTPException(404, "Club not found")
    _set_config(db, "organizer_club_id", str(club_id))
    db.commit()
    return {"ok": True, "organizer_club_id": club_id}


@router.post("/admin/change-pin", dependencies=[Depends(require_admin)])
def change_admin_pin(data: PinChange, db: Session = Depends(get_db)):
    _set_config(db, "admin_pin", data.pin)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Gemini API Keys
# ---------------------------------------------------------------------------

@router.get("/admin/gemini-keys", dependencies=[Depends(require_admin)])
def get_gemini_keys(db: Session = Depends(get_db)):
    """Get Gemini API keys (masked)."""
    free_key = _get_config(db, "GEMINI_KEY_FREE") or ""
    paid_key = _get_config(db, "GEMINI_KEY_PAID") or ""
    return {
        "freeKey": ("***" + free_key[-4:]) if free_key else "",
        "paidKey": ("***" + paid_key[-4:]) if paid_key else "",
        "hasFreeKey": bool(free_key),
        "hasPaidKey": bool(paid_key),
    }


@router.post("/admin/gemini-keys", dependencies=[Depends(require_admin)])
def set_gemini_keys(data: dict, db: Session = Depends(get_db)):
    """Set Gemini API keys. Pass null to keep existing value."""
    free_key = data.get("freeKey")
    paid_key = data.get("paidKey")
    if free_key is not None:
        _set_config(db, "GEMINI_KEY_FREE", free_key)
    if paid_key is not None:
        _set_config(db, "GEMINI_KEY_PAID", paid_key)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Stripe
# ---------------------------------------------------------------------------

@router.post("/stripe/connect", dependencies=[Depends(require_organizer_or_admin)])
def stripe_connect_start(db: Session = Depends(get_db)):
    import stripe
    stripe.api_key = os.environ.get("STRIPE_API_KEY")
    if not stripe.api_key:
        raise HTTPException(500, "STRIPE_API_KEY not configured")

    org_cfg = _get_config(db, "organizer_club_id")
    if not org_cfg:
        raise HTTPException(400, "No organizer club set")
    club = db.get(TeamClub, int(org_cfg))
    if not club:
        raise HTTPException(404, "Organizer club not found")

    if not club.stripe_account_id:
        account = stripe.Account.create(type="standard")
        club.stripe_account_id = account.id
        db.commit()

    base_url = os.environ.get("APP_BASE_URL", "http://localhost:8001")
    link = stripe.AccountLink.create(
        account=club.stripe_account_id,
        refresh_url=f"{base_url}/organizer?stripe=refresh",
        return_url=f"{base_url}/organizer?stripe=success",
        type="account_onboarding",
    )
    return {"url": link.url}


@router.get("/stripe/status", dependencies=[Depends(require_organizer_or_admin)])
def stripe_connect_status(db: Session = Depends(get_db)):
    import stripe
    org_cfg = _get_config(db, "organizer_club_id")
    if not org_cfg:
        return {"connected": False}
    club = db.get(TeamClub, int(org_cfg))
    if not club or not club.stripe_account_id:
        return {"connected": False}
    stripe.api_key = os.environ.get("STRIPE_API_KEY")
    if not stripe.api_key:
        return {"connected": False}
    try:
        acct = stripe.Account.retrieve(club.stripe_account_id)
        return {"connected": acct.charges_enabled, "account_id": club.stripe_account_id}
    except Exception:
        return {"connected": False}


@router.post("/stripe/disconnect", dependencies=[Depends(require_organizer_or_admin)])
def stripe_disconnect(db: Session = Depends(get_db)):
    org_cfg = _get_config(db, "organizer_club_id")
    if not org_cfg:
        raise HTTPException(400, "No organizer club set")
    club = db.get(TeamClub, int(org_cfg))
    if not club:
        raise HTTPException(404, "Organizer club not found")
    club.stripe_account_id = None
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Invoices
# ---------------------------------------------------------------------------

@router.get("/clubs/{club_id}/invoice-pdf", dependencies=[Depends(require_organizer_or_admin)])
def club_invoice_pdf(club_id: int, db: Session = Depends(get_db)):
    from ..invoices import generate_invoice_pdf
    try:
        pdf = generate_invoice_pdf(db, club_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    club = db.get(TeamClub, club_id)
    name = club.name.replace(" ", "_") if club else "club"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="invoice_{name}.pdf"'})


@router.post("/invoices/pdf-zip", dependencies=[Depends(require_organizer_or_admin)])
def invoices_pdf_zip(data: dict, db: Session = Depends(get_db)):
    import zipfile
    from io import BytesIO
    from ..invoices import generate_invoice_pdf

    club_ids = data.get("club_ids", [])
    if not club_ids:
        raise HTTPException(400, "No clubs selected")

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for cid in club_ids:
            try:
                pdf = generate_invoice_pdf(db, cid)
            except ValueError:
                continue
            club = db.get(TeamClub, cid)
            name = club.name.replace(" ", "_") if club else f"club_{cid}"
            zf.writestr(f"invoice_{name}.pdf", pdf)

    if buf.tell() == 0:
        raise HTTPException(400, "No billable clubs in selection")
    buf.seek(0)
    return Response(content=buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="invoices.zip"'})


@router.get("/clubs/{club_id}/invoice-total", dependencies=[Depends(require_organizer_or_admin)])
def club_invoice_total(club_id: int, db: Session = Depends(get_db)):
    from ..invoices import _club_line_items, _meet_fees
    club = db.get(TeamClub, club_id)
    if not club:
        raise HTTPException(404)
    items = _club_line_items(db, club, _meet_fees(db))
    total = sum(it["unit_cents"] * it["qty"] for it in items)
    return {"club_id": club_id, "total_cents": total}


@router.post("/clubs/{club_id}/invoice", dependencies=[Depends(require_organizer_or_admin)])
def send_club_invoice(club_id: int, db: Session = Depends(get_db)):
    """Create and send a Stripe invoice for a club on the organizer's connected account."""
    import stripe
    stripe.api_key = os.environ.get("STRIPE_API_KEY")
    if not stripe.api_key:
        raise HTTPException(500, "STRIPE_API_KEY not configured")

    org_cfg = _get_config(db, "organizer_club_id")
    if not org_cfg:
        raise HTTPException(400, "No organizer club set")
    org_club = db.get(TeamClub, int(org_cfg))
    if not org_club or not org_club.stripe_account_id:
        raise HTTPException(400, "Organizer has no connected Stripe account")

    club = db.get(TeamClub, club_id)
    if not club:
        raise HTTPException(404, "Club not found")

    from ..invoices import _club_line_items, _meet_fees, _meet_name
    items = _club_line_items(db, club, _meet_fees(db))
    if not items:
        raise HTTPException(400, "No billable items for this club")

    acct = org_club.stripe_account_id
    meet_name = _meet_name(db)

    email = (club.email or "").strip()
    customer = None
    if email:
        existing = stripe.Customer.list(email=email, limit=1, stripe_account=acct)
        if existing.data:
            customer = existing.data[0]
    if not customer:
        customer = stripe.Customer.create(
            name=club.name,
            email=email or None,
            metadata={"meetmanager_club_id": str(club.clubsid)},
            stripe_account=acct,
        )

    invoice = stripe.Invoice.create(
        customer=customer.id,
        auto_advance=False,
        currency="cad",
        collection_method="send_invoice",
        days_until_due=30,
        description=f"{meet_name} — Inscriptions",
        metadata={"meetmanager_club_id": str(club.clubsid), "meetmanager_meet": meet_name},
        pending_invoice_items_behavior="exclude",
        stripe_account=acct,
    )

    for it in items:
        desc_parts = []
        if it.get("event_number"):
            desc_parts.append(f"#{it['event_number']}")
        if it.get("event_name"):
            desc_parts.append(it["event_name"])
        if it.get("description"):
            desc_parts.append(it["description"])
        stripe.InvoiceItem.create(
            customer=customer.id,
            invoice=invoice.id,
            currency="cad",
            amount=it["unit_cents"] * it["qty"],
            description=" — ".join(desc_parts) or "Inscription",
            stripe_account=acct,
        )

    stripe.Invoice.finalize_invoice(invoice.id, stripe_account=acct)
    stripe.Invoice.send_invoice(invoice.id, stripe_account=acct)

    club.stripe_send_count = (club.stripe_send_count or 0) + 1
    db.commit()

    return {
        "club": club.name,
        "invoice_id": invoice.id,
        "total_cents": sum(it["unit_cents"] * it["qty"] for it in items),
    }


@router.post("/clubs/{club_id}/create-invoice", dependencies=[Depends(require_organizer_or_admin)])
def create_club_invoice(club_id: int, db: Session = Depends(get_db)):
    try:
        return create_invoice_for_club(db, club_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

@router.get("/export", dependencies=[Depends(require_admin)])
def export_lenex(db: Session = Depends(get_db)):
    import zipfile
    from io import BytesIO

    lxf_bytes = generate_lxf(db)
    scripts_dir = Path(__file__).resolve().parent.parent.parent / "scripts"

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("inscriptions.lxf", lxf_bytes)
        for name in ("simulate_results.vbs", "simulate_results.bat"):
            p = scripts_dir / name
            if p.exists():
                z.writestr(name, p.read_bytes())

    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=inscriptions_bundle.zip"},
    )


@router.get("/export/entries", dependencies=[Depends(require_admin)])
def export_entries_lxf(db: Session = Depends(get_db)):
    data = generate_entries_lxf(db)
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=entries.lxf"},
    )


@router.get("/export/meet-lxf", dependencies=[Depends(require_organizer_or_admin)])
def export_meet_lxf(db: Session = Depends(get_db)):
    """Download the meet structure as a Lenex .lxf (stored file or generated from DB)."""
    from ..export import generate_meet_lxf_from_db
    if MEET_STORAGE.exists():
        content = MEET_STORAGE.read_bytes()
    else:
        content = generate_meet_lxf_from_db(db)
    return Response(
        content=content,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=meet.lxf"},
    )


@router.get("/export/registrations-lxf", dependencies=[Depends(require_organizer_or_admin)])
def export_registrations_lxf(db: Session = Depends(get_db)):
    """Download registrations as a Lenex .lxf (entries file for import into meet-app)."""
    data = generate_lxf(db)
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=inscriptions.lxf"},
    )


# ---------------------------------------------------------------------------
# Database backup / restore (pg_dump / psql or SQLite file copy)
# ---------------------------------------------------------------------------

@router.get("/admin/backup-db", dependencies=[Depends(require_admin)])
def backup_db():
    """Download a full database backup (pg_dump SQL for Postgres, raw .db file for SQLite)."""
    from ..database import is_sqlite, DATABASE_URL, sqlite_snapshot_bytes
    if is_sqlite():
        db_path = DATABASE_URL.replace("sqlite:///", "")
        try:
            content = sqlite_snapshot_bytes(db_path)
        except FileNotFoundError:
            raise HTTPException(404, "Database file not found")
        return Response(
            content=content,
            media_type="application/octet-stream",
            headers={"Content-Disposition": "attachment; filename=team_backup.db"},
        )
    else:
        import subprocess
        db_url = os.environ.get("DATABASE_URL", "")
        from urllib.parse import urlparse
        parsed = urlparse(db_url)
        env = {**os.environ, "PGPASSWORD": parsed.password or ""}
        cmd = [
            "pg_dump",
            "-h", parsed.hostname or "db",
            "-p", str(parsed.port or 5432),
            "-U", parsed.username or "meetmgr",
            "-d", parsed.path.lstrip("/") or "meet",
            "--no-owner", "--no-acl",
        ]
        result = subprocess.run(cmd, capture_output=True, env=env, timeout=60)
        if result.returncode != 0:
            raise HTTPException(500, f"pg_dump failed: {result.stderr.decode()[:500]}")
        return Response(
            content=result.stdout,
            media_type="application/sql",
            headers={"Content-Disposition": "attachment; filename=team_backup.sql"},
        )


@router.post("/admin/restore-db", dependencies=[Depends(require_admin)])
async def restore_db(file: UploadFile = File(...)):
    """Restore database from a backup file (.db for SQLite, .sql for Postgres)."""
    from ..database import is_sqlite, DATABASE_URL
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 50MB)")

    if is_sqlite():
        # SQLite restore: use the backup API to safely replace the contents
        # of the live database without file-level replacement
        import sqlite3 as _sqlite3
        import tempfile

        # Validate that the uploaded file is a valid SQLite database
        if not content[:16].startswith(b"SQLite format 3"):
            raise HTTPException(400, "Invalid SQLite database file")

        # Write uploaded file to a temp path
        tmp_path = Path(tempfile.mktemp(suffix=".db"))
        tmp_path.write_bytes(content)

        try:
            # Open the source (uploaded backup) using raw sqlite3
            src_conn = _sqlite3.connect(str(tmp_path))

            # Get a raw connection to the LIVE database through SQLAlchemy's pool
            from ..database import engine
            raw_conn = engine.raw_connection()
            dst_conn = raw_conn.connection  # underlying sqlite3 connection

            # Use SQLite backup API: copies source into destination (overwrites all data)
            src_conn.backup(dst_conn)
            src_conn.close()
            raw_conn.close()
        finally:
            if tmp_path.exists():
                tmp_path.unlink()

        return {"ok": True, "filename": file.filename}

    import subprocess
    db_url = os.environ.get("DATABASE_URL", "")
    from urllib.parse import urlparse
    parsed = urlparse(db_url)
    dbname = parsed.path.lstrip("/") or "meet"
    env = {**os.environ, "PGPASSWORD": parsed.password or ""}
    host_args = ["-h", parsed.hostname or "db", "-p", str(parsed.port or 5432),
                 "-U", parsed.username or "meetmgr"]
    # Drop and recreate the database
    subprocess.run(["psql", *host_args, "-d", "postgres",
                    "-c", f"DROP DATABASE IF EXISTS {dbname}"],
                   env=env, capture_output=True, timeout=30)
    subprocess.run(["psql", *host_args, "-d", "postgres",
                    "-c", f"CREATE DATABASE {dbname}"],
                   env=env, capture_output=True, timeout=30)
    # Restore from dump
    result = subprocess.run(["psql", *host_args, "-d", dbname],
                            input=content, capture_output=True, env=env, timeout=120)
    if result.returncode != 0:
        stderr = result.stderr.decode()[:500]
        # psql often returns non-zero for warnings; check if it's fatal
        if "FATAL" in stderr or "could not connect" in stderr:
            raise HTTPException(500, f"Restore failed: {stderr}")
    return {"ok": True, "filename": file.filename}


# ---------------------------------------------------------------------------
# Auto-backup: config + list + download + delete
# ---------------------------------------------------------------------------

BACKUP_DIR = Path(os.environ.get("DATA_DIR", "/app/data")) / "backups"


def _run_pg_dump_bytes() -> bytes:
    """Run pg_dump and return SQL bytes (Postgres) or read .db file (SQLite)."""
    from ..database import is_sqlite, DATABASE_URL, sqlite_snapshot_bytes
    if is_sqlite():
        db_path = DATABASE_URL.replace("sqlite:///", "")
        return sqlite_snapshot_bytes(db_path)
    import subprocess
    from urllib.parse import urlparse
    db_url = os.environ.get("DATABASE_URL", "")
    parsed = urlparse(db_url)
    env = {**os.environ, "PGPASSWORD": parsed.password or ""}
    cmd = [
        "pg_dump",
        "-h", parsed.hostname or "db",
        "-p", str(parsed.port or 5432),
        "-U", parsed.username or "meetmgr",
        "-d", parsed.path.lstrip("/") or "meetmgr",
        "--no-owner", "--no-acl",
    ]
    result = subprocess.run(cmd, capture_output=True, env=env, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"pg_dump failed: {result.stderr.decode()[:500]}")
    return result.stdout


@router.get("/admin/backup-config", dependencies=[Depends(require_admin)])
def get_backup_config(db: Session = Depends(get_db)):
    """Get auto-backup configuration."""
    interval = _get_config(db, "backup_interval_days") or "1"
    max_count = _get_config(db, "backup_max_count") or "7"
    return {"interval_days": int(interval), "max_count": int(max_count)}


@router.put("/admin/backup-config", dependencies=[Depends(require_admin)])
def set_backup_config(data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Update auto-backup configuration."""
    if "interval_days" in data:
        val = max(1, int(data["interval_days"]))
        _set_config(db, "backup_interval_days", str(val))
    if "max_count" in data:
        val = max(1, int(data["max_count"]))
        _set_config(db, "backup_max_count", str(val))
    db.commit()
    return get_backup_config(db=db)


@router.get("/admin/backups", dependencies=[Depends(require_admin)])
def list_backups():
    """List all stored auto-backups."""
    if not BACKUP_DIR.exists():
        return []
    backups = []
    # Include both .sql (pg_dump) and .db (SQLite copy) backup files
    backup_files = list(BACKUP_DIR.glob("*.sql")) + list(BACKUP_DIR.glob("*.db"))
    for f in sorted(backup_files, key=lambda p: p.stat().st_mtime, reverse=True):
        stat = f.stat()
        backups.append({
            "filename": f.name,
            "size_bytes": stat.st_size,
            "size_mb": round(stat.st_size / 1024 / 1024, 2),
            "date": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })
    return backups


@router.post("/admin/backups/create", dependencies=[Depends(require_admin)])
def create_backup_now():
    """Create a manual backup and store it."""
    from ..database import is_sqlite
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    ext = "db" if is_sqlite() else "sql"
    filename = f"manual-{timestamp}.{ext}"
    sql = _run_pg_dump_bytes()
    (BACKUP_DIR / filename).write_bytes(sql)
    return {"filename": filename, "size_bytes": len(sql)}


@router.get("/admin/backups/{filename}", dependencies=[Depends(require_admin)])
def download_backup(filename: str):
    """Download a specific backup file."""
    # Sanitize filename to prevent path traversal
    safe_name = Path(filename).name
    filepath = BACKUP_DIR / safe_name
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(404, "Backup not found")
    return Response(
        content=filepath.read_bytes(),
        media_type="application/sql",
        headers={"Content-Disposition": f"attachment; filename={safe_name}"},
    )


@router.delete("/admin/backups/{filename}", dependencies=[Depends(require_admin)])
def delete_backup(filename: str):
    """Delete a specific backup file."""
    safe_name = Path(filename).name
    filepath = BACKUP_DIR / safe_name
    if not filepath.exists():
        raise HTTPException(404, "Backup not found")
    filepath.unlink()
    return {"deleted": safe_name}


# ---------------------------------------------------------------------------
# Team Manager MDB Import (historical meets)
# ---------------------------------------------------------------------------

@router.post("/admin/import-mdb", dependencies=[Depends(require_admin)])
async def import_team_mdb_endpoint(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import a Splash Team Manager .mdb file (admin only).

    This imports historical meets, members, results, clubs, and swim styles
    from the Team Manager database into the new team-schema tables.
    """
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 50MB)")

    from ..mdb_import import import_team_mdb
    try:
        counts = import_team_mdb(db, content)
    except Exception as e:
        raise HTTPException(400, f"MDB import failed: {e}")

    return {"ok": True, "tables": counts, "filename": file.filename}


@router.get("/admin/historical-meets", dependencies=[Depends(require_admin)])
def list_historical_meets(db: Session = Depends(get_db)):
    """List all meets in the Team Manager schema (historical + current)."""
    from ..models_team import Meet, Result
    meets = db.query(Meet).order_by(Meet.mindate.desc()).all()
    current_id = _get_config(db, "current_meetsid")
    meet_city = _get_config(db, "meet_city") or ""
    result = []
    for m in meets:
        has_results = db.query(Result).filter(
            Result.meetsid == m.meetsid,
            Result.totaltime.isnot(None),
            Result.totaltime > 0,
        ).limit(1).count() > 0
        place = m.place or ""
        # For current meet, fall back to bsglobal meet_city
        if not place and current_id and str(m.meetsid) == current_id:
            place = meet_city
        result.append({
            "id": m.meetsid,
            "name": m.name,
            "place": place,
            "mindate": m.mindate.isoformat() if m.mindate else None,
            "maxdate": m.maxdate.isoformat() if m.maxdate else None,
            "course": m.course,
            "has_results": has_results,
        })
    return result


@router.delete("/admin/historical-meets/{meet_id}", dependencies=[Depends(require_admin)])
def delete_historical_meet(meet_id: int, db: Session = Depends(get_db)):
    """Delete a historical meet and all its associated data."""
    from ..models_team import Meet
    meet = db.get(Meet, meet_id)
    if not meet:
        raise HTTPException(404, "Meet not found")
    db.delete(meet)  # cascades to sessions, events, results, membersmeets
    db.commit()
    return {"ok": True, "deleted": meet.name}



@router.get("/admin/historical-best-times/{member_id}", dependencies=[Depends(require_admin)])
def get_historical_best_times(member_id: int, db: Session = Depends(get_db)):
    """Get best times for a member computed from historical results."""
    bt = get_best_times_for_member(db, member_id)
    return {"member_id": member_id, "best_times": bt}



@router.post("/import-results-lxf", dependencies=[Depends(require_organizer_or_admin)])
async def import_results_lxf(request: Request, file: UploadFile = File(...), force: bool = False,
                              db: Session = Depends(get_db)):
    """Import a meet-app results .lxf as a historical meet.

    - Organizer: archives meet as historical, then resets current meet,
      regenerates all club PINs, and clears the organizer role so an admin
      can invite the next organizer.  Returns reset=true.
    - Admin: creates or updates a historical meet record only.  No reset.
      Returns reset=false.

    meet-app exports via File → "Exporter les résultats LENEX…".
    Clubs/athletes are merged by code/license; if a completed meet with the
    same name already exists its results are replaced rather than duplicated.
    Warns (409, pass ?force=true to override) about swimstyle ids not already
    in the local catalog.
    """
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 50MB)")

    from ..lxf_to_team import import_lxf_as_meet
    from ..models_live import LiveResult, LiveSplit, LiveStartlist, LiveEvent

    # LXF import is authoritative — clear any live results if present
    db.query(LiveSplit).delete()
    db.query(LiveResult).delete()
    db.query(LiveStartlist).delete()
    db.query(LiveEvent).delete()
    # Clear live mode keys
    for key in ("LIVE_PUSH_SECRET", "LIVE_ENABLED", "LIVE_LAST_PUSH"):
        cfg = db.get(BsGlobal, key)
        if cfg:
            db.delete(cfg)
    db.flush()

    try:
        counts = import_lxf_as_meet(db, content, force=force)
    except Exception as e:
        raise HTTPException(400, f"LXF import failed: {e}")

    if counts.get("needs_force"):
        raise HTTPException(409, {
            "code": "new_swimstyles",
            "message": counts["warning"],
            "styles": counts["new_swimstyles"],
        })

    pin = request.headers.get("X-Club-Pin", "")
    role, _ = _resolve_role(pin, db)
    did_reset = False
    if role in ("organizer", "admin"):
        _reset_for_next_meet(db)
        # Admin stays connected — restore organizer_club_id clearing only for organizer
        if role == "admin":
            # Admin doesn't lose their session; no organizer role to clear
            pass
        db.commit()
        did_reset = True

    return {"ok": True, **counts, "filename": file.filename, "reset": did_reset, "role": role}


# ---------------------------------------------------------------------------
# Relay Teams CRUD
# ---------------------------------------------------------------------------

class RelayTeamCreate(BaseModel):
    event_id: int
    age_code: str
    club_id: int | None = None


class RelayMemberUpdate(BaseModel):
    athleteId: int | None = None


class RelayTeamNameUpdate(BaseModel):
    name: str | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str | None) -> str | None:
        if v is not None and len(v) > 50:
            raise ValueError("name must be at most 50 characters")
        return v


def _team_number_to_letter(n: int) -> str:
    """Convert 1-based team number to letter: 1->A, 2->B, etc."""
    if n < 1 or n > 26:
        return str(n)
    return chr(ord('A') + n - 1)


def _get_current_meet_id(db: Session) -> int | None:
    val = _get_config(db, "current_meetsid")
    return int(val) if val else None


def _import_relays_from_lxf(db: "Session", file_bytes: bytes) -> int:
    """Parse RELAY elements from LXF and import them into the relays/relayspos tables."""
    import zipfile
    import io
    from xml.etree import ElementTree as ET
    from ..models_team import Relay, RelayPos, TeamClub, Member

    # Extract XML from zip
    try:
        z = zipfile.ZipFile(io.BytesIO(file_bytes))
        xml_data = z.read(z.namelist()[0])
    except Exception:
        xml_data = file_bytes

    root = ET.fromstring(xml_data)

    # Build club code → clubsid lookup
    club_by_code: dict[str, int] = {}
    for c in db.query(TeamClub).all():
        if c.code:
            club_by_code[c.code.upper()] = c.clubsid

    # Build athlete mapping: lenex athleteid → membersid
    # The LXF uses its own athlete IDs; we need to match by name+club
    # First try direct ID match (if IDs were preserved during seed)
    member_ids: set[int] = {m.membersid for m in db.query(Member.membersid).all()}

    # Build event swimstyleid/eventnumber lookups. eventnumber is needed so
    # get_relay_teams can disambiguate events that share the same style+gender.
    event_style: dict[int, int] = {}
    event_number: dict[int, int] = {}
    for ev in db.query(SwimEvent).filter(SwimEvent.swimstyleid.isnot(None)).all():
        event_style[ev.swimeventid] = ev.swimstyleid
        event_number[ev.swimeventid] = ev.eventnumber

    # Get current meet ID
    meet_id_str = db.get(BsGlobal, "current_meetsid")
    meet_id = int(meet_id_str.data) if meet_id_str and meet_id_str.data else None

    # Find next relay ID
    from sqlalchemy import func as sqla_func
    max_relay_id = db.query(sqla_func.max(Relay.relaysid)).scalar() or 0

    # Clear existing relays for this meet before re-importing
    if meet_id:
        db.query(RelayPos).filter(
            RelayPos.relaysid.in_(
                db.query(Relay.relaysid).filter(Relay.meetsid == meet_id)
            )
        ).delete(synchronize_session=False)
        db.query(Relay).filter(Relay.meetsid == meet_id).delete(synchronize_session=False)
        db.flush()

    relays_imported = 0
    ns = ''  # handle namespaced XML
    # Try to find namespace
    if root.tag.startswith('{'):
        ns = root.tag.split('}')[0] + '}'

    for club_el in root.iter(f"{ns}CLUB"):
        club_code = (club_el.get("code") or "").upper()
        club_id = club_by_code.get(club_code)
        if not club_id:
            # Try by name
            club_name = club_el.get("name", "")
            for c in db.query(TeamClub).filter(TeamClub.name == club_name).all():
                club_id = c.clubsid
                break
        if not club_id:
            continue

        # Build athlete ID mapping for this club from the ATHLETES section
        athlete_id_map: dict[str, int] = {}  # lenex athleteid string → membersid
        for ath_el in club_el.iter(f"{ns}ATHLETE"):
            lenex_id = ath_el.get("athleteid", "")
            # Try direct ID match first
            int_id = int(lenex_id) if lenex_id.isdigit() else 0
            if int_id in member_ids:
                athlete_id_map[lenex_id] = int_id
            else:
                # Match by name + club
                fname = ath_el.get("firstname", "")
                lname = ath_el.get("lastname", "")
                m = db.query(Member).filter(
                    Member.clubsid == club_id,
                    Member.firstname == fname,
                    Member.lastname == lname,
                ).first()
                if m:
                    athlete_id_map[lenex_id] = m.membersid

        for relay_el in club_el.iter(f"{ns}RELAY"):
            team_number = int(relay_el.get("number", "1"))
            gender_str = relay_el.get("gender", "X")
            gender_int = {"M": 1, "F": 2, "X": 3}.get(gender_str, 3)
            agemin = int(relay_el.get("agemin", "0")) if relay_el.get("agemin") else None
            agemax = int(relay_el.get("agemax", "0")) if relay_el.get("agemax") else None

            for entry_el in relay_el.iter(f"{ns}ENTRY"):
                event_id = int(entry_el.get("eventid", "0"))
                if not event_id:
                    continue
                style_id = event_style.get(event_id)

                max_relay_id += 1
                relay = Relay(
                    relaysid=max_relay_id,
                    meetsid=meet_id,
                    clubsid=club_id,
                    stylesid=style_id,
                    teamnumb=team_number,
                    gender=gender_int,
                    minage=agemin,
                    maxage=agemax,
                    eventnumb=event_number.get(event_id),
                )
                db.add(relay)
                db.flush()

                # Import positions
                for pos_el in entry_el.iter(f"{ns}RELAYPOSITION"):
                    pos_num = int(pos_el.get("number", "0"))
                    ath_id_str = pos_el.get("athleteid", "")
                    if not pos_num or not ath_id_str:
                        continue
                    member_id = athlete_id_map.get(ath_id_str)
                    if not member_id:
                        # Try direct int match
                        try:
                            direct_id = int(ath_id_str)
                            if direct_id in member_ids:
                                member_id = direct_id
                        except ValueError:
                            pass
                    if member_id:
                        db.add(RelayPos(
                            relaysid=max_relay_id,
                            numb=pos_num,
                            membersid=member_id,
                        ))

                relays_imported += 1

    db.commit()
    return relays_imported


def _relay_age_code(minage: int | None, maxage: int | None) -> str:
    """Convert relay minage/maxage to an age code string."""
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


def _age_code_to_range(age_code: str) -> tuple[int, int | None]:
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


@router.get("/relay-teams")
def get_relay_teams(request: Request, club_id: int | None = None, db: Session = Depends(get_db)):
    """Return RelayPageData: relay events grouped by age category, teams, eligible athletes."""
    from ..models_team import Relay, RelayPos
    from datetime import date as d

    pin = request.headers.get("X-Club-Pin", "")
    role, caller_club = _resolve_role(pin, db)

    # Determine which club to show data for
    if role == "coach":
        # Coach can only see their own club
        target_club_id = caller_club
    elif club_id is not None:
        # Admin/organizer filtering by a specific club
        target_club_id = club_id
    else:
        # Admin/organizer viewing all — we still need a club context for eligible athletes
        target_club_id = None

    # Get closure info
    closure_date_str = _get_closure_date(db)
    is_closed = False
    if closure_date_str:
        is_closed = d.today() > d.fromisoformat(closure_date_str)

    # Get current meet ID
    meet_id = _get_current_meet_id(db)

    # Get all relay events (relaycount > 1) with their age groups
    relay_events = (
        db.query(SwimEvent)
        .options(joinedload(SwimEvent.swimstyle), joinedload(SwimEvent.agegroups))
        .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
        .filter(SwimStyle.relaycount > 1)
        .filter(SwimEvent.round != ROUND_FIN)  # skip finals
        .order_by(SwimEvent.eventnumber)
        .all()
    )

    # Build age categories and event groups
    age_categories_map: dict[str, dict] = {}  # age_code -> category data
    event_groups_by_key: dict[str, dict] = {}  # "${eventId}-${ageCode}" -> event group

    for ev in relay_events:
        style = ev.swimstyle
        if not style:
            continue
        # Process each age group for this event
        if not ev.agegroups:
            # If no age groups defined, use "Open"
            age_code = "Open"
            age_min = 0
            age_max = None
            _process_relay_event_age_group(
                ev, style, age_code, age_min, age_max,
                age_categories_map, event_groups_by_key
            )
        else:
            for ag in ev.agegroups:
                age_code = _age_group_code(ag.agemin, ag.agemax) or _relay_age_code(ag.agemin, ag.agemax)
                age_min = ag.agemin or 0
                age_max = ag.agemax if (ag.agemax and ag.agemax > 0 and ag.agemax < 99) else None
                _process_relay_event_age_group(
                    ev, style, age_code, age_min, age_max,
                    age_categories_map, event_groups_by_key
                )

    # Sort age categories by age range
    sorted_categories = sorted(
        age_categories_map.values(),
        key=lambda c: c["ageMin"]
    )

    # Build teams by event key
    teams_by_event: dict[str, list] = {}

    # Query existing relay teams
    relay_query = db.query(Relay)
    if meet_id:
        relay_query = relay_query.filter(Relay.meetsid == meet_id)
    if target_club_id:
        relay_query = relay_query.filter(Relay.clubsid == target_club_id)

    existing_relays = relay_query.all()

    # Get all relay positions for those relays
    relay_ids = [r.relaysid for r in existing_relays]
    relay_positions: dict[int, list] = {}
    if relay_ids:
        positions = db.query(RelayPos).filter(RelayPos.relaysid.in_(relay_ids)).all()
        for pos in positions:
            relay_positions.setdefault(pos.relaysid, []).append(pos)

    # Get member names for display
    member_ids_in_positions = set()
    for positions_list in relay_positions.values():
        for pos in positions_list:
            if pos.membersid:
                member_ids_in_positions.add(pos.membersid)
    member_names: dict[int, str] = {}
    if member_ids_in_positions:
        members = db.query(Member).filter(Member.membersid.in_(list(member_ids_in_positions))).all()
        for m in members:
            member_names[m.membersid] = f"{m.lastname}, {m.firstname}"

    # Load custom team names (from relay.name column, fallback to bsglobal for backward compat)
    custom_names: dict[int, str] = {}
    for r in existing_relays:
        if r.name:
            custom_names[r.relaysid] = r.name
    # Backward compat: check bsglobal for relays without a name column value
    missing_name_relays = [r for r in existing_relays if r.relaysid not in custom_names]
    if missing_name_relays:
        relay_name_keys = [f"relay_name_{r.relaysid}" for r in missing_name_relays]
        name_configs = db.query(BsGlobal).filter(BsGlobal.name.in_(relay_name_keys)).all()
        for cfg in name_configs:
            rid = int(cfg.name.replace("relay_name_", ""))
            custom_names[rid] = cfg.data

    # Build club names lookup for admin all-clubs view
    club_names: dict[int, str] = {}
    if not target_club_id:
        # Load all clubs (admin viewing all clubs needs names for display)
        all_clubs = db.query(TeamClub).all()
        for c in all_clubs:
            club_names[c.clubsid] = c.name or c.shortname or str(c.clubsid)

    # Map relays to event keys
    # Compute each member's registered age group from individual entries (majority rule)
    # Map membersid → most common age code from their individual event registrations
    # Primary path: use age_code column directly (set by team-app registrations).
    # Fallback: agegroupid FK join, for rows without an age_code (e.g. meet-app imports).
    member_age_group_map: dict[int, str] = {}
    if member_ids_in_positions:
        from sqlalchemy import func as sqla_func
        ac_counts = (
            db.query(
                SwimResult.athleteid,
                SwimResult.age_code,
                sqla_func.count().label("cnt"),
            )
            .join(SwimEvent, SwimResult.swimeventid == SwimEvent.swimeventid)
            .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
            .filter(
                SwimResult.athleteid.in_(list(member_ids_in_positions)),
                SwimStyle.relaycount == 1,  # only individual events
                SwimResult.age_code.isnot(None),
                SwimResult.age_code != "",
            )
            .group_by(SwimResult.athleteid, SwimResult.age_code)
            .order_by(SwimResult.athleteid, sqla_func.count().desc())
            .all()
        )
        seen_members: set[int] = set()
        for row in ac_counts:
            if row.athleteid in seen_members:
                continue
            seen_members.add(row.athleteid)
            member_age_group_map[row.athleteid] = row.age_code

        remaining_ids = [mid for mid in member_ids_in_positions if mid not in seen_members]
        if remaining_ids:
            age_group_counts = (
                db.query(
                    SwimResult.athleteid,
                    AgeGroup.agemin,
                    AgeGroup.agemax,
                    sqla_func.count().label("cnt"),
                )
                .join(AgeGroup, SwimResult.agegroupid == AgeGroup.agegroupid)
                .join(SwimEvent, SwimResult.swimeventid == SwimEvent.swimeventid)
                .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
                .filter(
                    SwimResult.athleteid.in_(remaining_ids),
                    SwimStyle.relaycount == 1,  # only individual events
                )
                .group_by(SwimResult.athleteid, AgeGroup.agemin, AgeGroup.agemax)
                .order_by(SwimResult.athleteid, sqla_func.count().desc())
                .all()
            )
            for row in age_group_counts:
                if row.athleteid in seen_members:
                    continue
                seen_members.add(row.athleteid)
                member_age_group_map[row.athleteid] = _relay_age_code(row.agemin, row.agemax)

    for relay in existing_relays:
        age_code = _relay_age_code(relay.minage, relay.maxage)
        # Find the event key. Prefer an exact eventnumb match — style+gender alone
        # is ambiguous when two distinct relay events share the same style and
        # gender (e.g. the same relay offered at two age categories), which used
        # to attribute every such relay's teams to whichever event sorted first.
        # Age code on the relay is the computed team age, not the event category.
        relay_gender_str = "M" if relay.gender == GENDER_M else "F" if relay.gender == GENDER_F else "X"
        event_key = None
        if relay.eventnumb:
            for key, group in event_groups_by_key.items():
                if (
                    group["swimstyleId"] == relay.stylesid
                    and group["gender"] == relay_gender_str
                    and group["eventNumber"] == relay.eventnumb
                ):
                    event_key = key
                    break
        if not event_key:
            # Legacy rows without eventnumb — fall back to the old ambiguous match
            for key, group in event_groups_by_key.items():
                if group["swimstyleId"] == relay.stylesid and group["gender"] == relay_gender_str:
                    event_key = key
                    break

        if not event_key:
            continue

        relaycount = event_groups_by_key[event_key]["relaycount"]
        positions_list = relay_positions.get(relay.relaysid, [])

        # Build members array
        members_arr = []
        member_age_codes_for_team: list[str] = []
        for i in range(1, relaycount + 1):
            pos = next((p for p in positions_list if p.numb == i), None)
            athlete_id = pos.membersid if pos else None
            athlete_name = member_names.get(athlete_id) if athlete_id else None
            members_arr.append({
                "position": i,
                "athleteId": athlete_id,
                "athleteName": athlete_name,
            })
            if athlete_id and athlete_id in member_age_group_map:
                member_age_codes_for_team.append(member_age_group_map[athlete_id])

        # Compute team age group (informational only — no longer shown in the UI,
        # which now just relies on the event's own category): the oldest category
        # present among members' individual registrations.
        computed_age_group = age_code  # fallback
        if member_age_codes_for_team:
            computed_age_group = _oldest_age_code(member_age_codes_for_team)

        team_data = {
            "id": relay.relaysid,
            "teamNumber": _team_number_to_letter(relay.teamnumb or 1),
            "teamName": custom_names.get(relay.relaysid),
            "ageGroup": computed_age_group,
            "members": members_arr,
            "clubId": relay.clubsid,
            "clubName": club_names.get(relay.clubsid) if relay.clubsid else None,
        }
        teams_by_event.setdefault(event_key, []).append(team_data)

    # Sort teams within each event by team number letter
    for key in teams_by_event:
        teams_by_event[key].sort(key=lambda t: t["teamNumber"])

    # ─── Backward compatibility: swimresult relay locks (Requirement 10) ───────
    # For relay events where a club has a swimresult registration but no relays
    # record, create a "virtual" team with the registering athlete in position 1.
    # These virtual teams use negative IDs (negated swimresultid).
    # Req 10.1: Display athlete in position 1 when no relays record exists.
    # Req 10.2: Prefer relays/relayspos data when both exist.
    # Req 10.5: Fall back to swimresult lock only when no relays record exists.

    relay_event_ids = [ev.swimeventid for ev in relay_events]

    if relay_event_ids:
        # Batch query: find all swimresult rows for relay events
        if target_club_id:
            club_member_ids_list = [
                m.membersid for m in db.query(Member).filter(Member.clubsid == target_club_id).all()
            ]
            sr_relay_locks = (
                db.query(SwimResult)
                .filter(
                    SwimResult.swimeventid.in_(relay_event_ids),
                    SwimResult.athleteid.in_(club_member_ids_list),
                )
                .all()
            ) if club_member_ids_list else []
        else:
            # Admin viewing all clubs — batch query all swimresults for relay events
            sr_relay_locks = (
                db.query(SwimResult)
                .filter(SwimResult.swimeventid.in_(relay_event_ids))
                .all()
            )

        if sr_relay_locks:
            # Build a lookup of member → club and member → name
            sr_athlete_ids = {sr.athleteid for sr in sr_relay_locks}
            sr_members = db.query(Member).filter(Member.membersid.in_(list(sr_athlete_ids))).all()
            athlete_club_map: dict[int, int] = {m.membersid: m.clubsid for m in sr_members}
            athlete_name_map: dict[int, str] = {
                m.membersid: f"{m.lastname}, {m.firstname}" for m in sr_members
            }

            # Determine which (event_id, age_code, club_id) combos already have relays records
            existing_relay_keys: set[tuple[int, str, int]] = set()
            for relay in existing_relays:
                age_code_r = _relay_age_code(relay.minage, relay.maxage)
                if relay.eventnumb:
                    for ev in relay_events:
                        if ev.swimstyleid == relay.stylesid and ev.eventnumber == relay.eventnumb:
                            existing_relay_keys.add((ev.swimeventid, age_code_r, relay.clubsid))
                else:
                    # Legacy rows without eventnumb — fall back to the old ambiguous match
                    for ev in relay_events:
                        if ev.swimstyleid == relay.stylesid:
                            existing_relay_keys.add((ev.swimeventid, age_code_r, relay.clubsid))

            # Track which (event_key, club_id) combos we've already handled
            handled_virtual_keys: set[tuple[str, int]] = set()

            # Build virtual teams for swimresult locks without relays entries
            for sr in sr_relay_locks:
                sr_age_code = sr.age_code or "Open"
                sr_event_id = sr.swimeventid
                sr_club_id = athlete_club_map.get(sr.athleteid)

                if not sr_club_id:
                    continue

                # Filter by target club when in coach mode
                if target_club_id and sr_club_id != target_club_id:
                    continue

                # Skip if a relays record already exists for this club/event/age_code
                if (sr_event_id, sr_age_code, sr_club_id) in existing_relay_keys:
                    continue

                # Find the matching event_key
                event_key = f"{sr_event_id}-{sr_age_code}"
                if event_key not in event_groups_by_key:
                    continue

                # Skip if we already added a virtual team for this club+event_key
                # (only one swimresult lock per club/event is expected)
                if (event_key, sr_club_id) in handled_virtual_keys:
                    continue
                handled_virtual_keys.add((event_key, sr_club_id))

                relaycount = event_groups_by_key[event_key]["relaycount"]

                # Get athlete name from pre-loaded map
                athlete_name = athlete_name_map.get(sr.athleteid)

                # Build members array: athlete in position 1, rest empty
                members_arr = []
                for i in range(1, relaycount + 1):
                    if i == 1:
                        members_arr.append({
                            "position": 1,
                            "athleteId": sr.athleteid,
                            "athleteName": athlete_name,
                        })
                    else:
                        members_arr.append({
                            "position": i,
                            "athleteId": None,
                            "athleteName": None,
                        })

                virtual_team = {
                    "id": -sr.swimresultid,  # Negative ID signals virtual team
                    "teamNumber": "A",
                    "teamName": None,
                    "members": members_arr,
                    "isVirtual": True,  # Flag for frontend awareness
                    "clubId": sr_club_id,  # Needed for admin view grouping
                    "clubName": club_names.get(sr_club_id),
                }
                teams_by_event.setdefault(event_key, []).append(virtual_team)

    # Build eligible athletes per event/category
    eligible_athletes: dict[str, list] = {}

    if target_club_id:
        # Get age base date
        age_base_val = _get_config(db, "age_base_date")
        age_base = d.fromisoformat(age_base_val) if age_base_val else d(d.today().year, 12, 31)

        # Get all athletes for this club
        club_members = db.query(Member).filter(Member.clubsid == target_club_id).all()

        # Compute each athlete's registration age group from individual entries
        # (dominant age group from non-relay swimresults)
        # Uses age_code directly when set, falls back to agegroup FK join
        club_member_ids = [m.membersid for m in club_members]
        athlete_age_group_map: dict[int, str] = {}
        if club_member_ids:
            from sqlalchemy import func as sqla_func2
            # Primary path: use age_code column directly (set by team-app registrations)
            ac_counts = (
                db.query(
                    SwimResult.athleteid,
                    SwimResult.age_code,
                    sqla_func2.count().label("cnt"),
                )
                .join(SwimEvent, SwimResult.swimeventid == SwimEvent.swimeventid)
                .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
                .filter(
                    SwimResult.athleteid.in_(club_member_ids),
                    SwimStyle.relaycount == 1,  # only individual events
                    SwimResult.age_code.isnot(None),
                    SwimResult.age_code != "",
                )
                .group_by(SwimResult.athleteid, SwimResult.age_code)
                .order_by(SwimResult.athleteid, sqla_func2.count().desc())
                .all()
            )
            seen_ag: set[int] = set()
            for row in ac_counts:
                if row.athleteid in seen_ag:
                    continue
                seen_ag.add(row.athleteid)
                athlete_age_group_map[row.athleteid] = row.age_code

            # Fallback: for athletes not found via age_code, try agegroupid FK
            remaining_ids = [mid for mid in club_member_ids if mid not in seen_ag]
            if remaining_ids:
                ag_counts = (
                    db.query(
                        SwimResult.athleteid,
                        AgeGroup.agemin,
                        AgeGroup.agemax,
                        sqla_func2.count().label("cnt"),
                    )
                    .join(AgeGroup, SwimResult.agegroupid == AgeGroup.agegroupid)
                    .join(SwimEvent, SwimResult.swimeventid == SwimEvent.swimeventid)
                    .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
                    .filter(
                        SwimResult.athleteid.in_(remaining_ids),
                        SwimStyle.relaycount == 1,
                    )
                    .group_by(SwimResult.athleteid, AgeGroup.agemin, AgeGroup.agemax)
                    .order_by(SwimResult.athleteid, sqla_func2.count().desc())
                    .all()
                )
                for row in ag_counts:
                    if row.athleteid in seen_ag:
                        continue
                    seen_ag.add(row.athleteid)
                    athlete_age_group_map[row.athleteid] = _relay_age_code(row.agemin, row.agemax)

        for key, group in event_groups_by_key.items():
            parts = key.split("-", 1)
            if len(parts) != 2:
                continue
            age_code = parts[1]
            event_gender = group["gender"]  # 'M', 'F', or 'X'

            eligible = []
            for m in club_members:
                # Gender filter only — age group is determined by team composition, not pre-filtered
                if event_gender == 'M' and m.gender != GENDER_M:
                    continue
                if event_gender == 'F' and m.gender != GENDER_F:
                    continue

                gender_str = "M" if m.gender == GENDER_M else "F"
                age_group_str = athlete_age_group_map.get(m.membersid)
                entry: dict = {
                    "id": m.membersid,
                    "name": f"{m.lastname}, {m.firstname}",
                    "gender": gender_str,
                }
                if age_group_str:
                    entry["ageGroup"] = age_group_str
                eligible.append(entry)

            eligible.sort(key=lambda a: a["name"])
            eligible_athletes[key] = eligible

    return {
        "ageCategories": sorted_categories,
        "teamsByEvent": teams_by_event,
        "eligibleAthletes": eligible_athletes,
        "closureDate": closure_date_str,
        "isClosed": is_closed and role == "coach",
    }


def _process_relay_event_age_group(
    ev: SwimEvent, style: SwimStyle, age_code: str,
    age_min: int, age_max: int | None,
    age_categories_map: dict, event_groups_by_key: dict
):
    """Helper to process a relay event + age group into the response structure."""
    from ..models_team import GENDER_M as TM_GENDER_M, GENDER_F as TM_GENDER_F

    # Determine gender string
    if ev.gender == GENDER_M:
        gender_str = 'M'
    elif ev.gender == GENDER_F:
        gender_str = 'F'
    else:
        gender_str = 'X'

    # Add/update age category
    if age_code not in age_categories_map:
        age_categories_map[age_code] = {
            "ageCode": age_code,
            "ageMin": age_min,
            "ageMax": age_max,
            "events": [],
        }

    event_key = f"{ev.swimeventid}-{age_code}"
    if event_key not in event_groups_by_key:
        event_group = {
            "eventId": ev.swimeventid,
            "eventName": style.name or "",
            "swimstyleId": style.swimstyleid,
            "relaycount": style.relaycount or 4,
            "gender": gender_str,
            "eventNumber": ev.eventnumber or 0,
        }
        event_groups_by_key[event_key] = event_group
        age_categories_map[age_code]["events"].append(event_group)


@router.post("/relay-teams")
def create_relay_team(data: RelayTeamCreate, request: Request, db: Session = Depends(get_db)):
    """Create a new relay team. Returns teamId and teamNumber letter."""
    from ..models_team import Relay, RelayPos

    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)

    role, caller_club = _resolve_role(pin, db)

    # Determine target club
    if role == "coach":
        target_club_id = caller_club
    elif data.club_id is not None:
        target_club_id = data.club_id
    elif role == "organizer" and caller_club:
        target_club_id = caller_club
    else:
        raise HTTPException(400, "club_id required for admin")

    if not target_club_id:
        raise HTTPException(400, "Cannot determine club")

    # Resolve event
    event = db.query(SwimEvent).options(joinedload(SwimEvent.swimstyle)).get(data.event_id)
    if not event:
        raise HTTPException(404, "Event not found")
    style = event.swimstyle
    if not style or not style.relaycount or style.relaycount <= 1:
        raise HTTPException(400, "Event is not a relay event")

    # Resolve age range
    age_min, age_max = _age_code_to_range(data.age_code)

    # Get current meet ID
    meet_id = _get_current_meet_id(db)

    # Determine next team number
    existing_teams = (
        db.query(Relay)
        .filter(
            Relay.clubsid == target_club_id,
            Relay.stylesid == style.swimstyleid,
            Relay.minage == (age_min if age_min else 0),
            Relay.maxage == (age_max if age_max else 0),
        )
    )
    if meet_id:
        existing_teams = existing_teams.filter(Relay.meetsid == meet_id)
    existing_teams = existing_teams.all()

    # ─── Backward compatibility: materialize swimresult relay lock (Req 10) ────
    # If no relays record exists but a swimresult lock does, materialize it first
    # so that the lock athlete is preserved as Team A and the new team gets B.
    if not existing_teams:
        # Check for swimresult relay locks for this club/event/age
        sr_age_code = data.age_code
        club_member_ids = [
            m.membersid for m in db.query(Member).filter(Member.clubsid == target_club_id).all()
        ]
        if club_member_ids:
            sr_lock = (
                db.query(SwimResult)
                .filter(
                    SwimResult.swimeventid == data.event_id,
                    SwimResult.athleteid.in_(club_member_ids),
                    SwimResult.age_code == sr_age_code,
                )
                .first()
            )
            if sr_lock:
                # Materialize the swimresult lock as Team A (teamnumb=1)
                gender_int = event.gender or 0
                materialized_relay = Relay(
                    meetsid=meet_id,
                    clubsid=target_club_id,
                    stylesid=style.swimstyleid,
                    teamnumb=1,
                    gender=gender_int,
                    minage=age_min if age_min else 0,
                    maxage=age_max if age_max else 0,
                    eventnumb=event.eventnumber,
                    eventtyp=0,
                    resulttyp=0,
                )
                db.add(materialized_relay)
                db.flush()

                # Create position records: lock athlete in position 1, rest empty
                for pos_num in range(1, style.relaycount + 1):
                    db.add(RelayPos(
                        relaysid=materialized_relay.relaysid,
                        numb=pos_num,
                        membersid=sr_lock.athleteid if pos_num == 1 else None,
                        entrytime=None,
                    ))

                # Remove the legacy swimresult lock row
                db.delete(sr_lock)
                db.flush()

                # Update existing_teams list to include the materialized team
                existing_teams = [materialized_relay]

    if len(existing_teams) >= 26:
        raise HTTPException(400, "Maximum 26 teams per event/category/club")

    # Find next available team number
    used_numbers = {t.teamnumb for t in existing_teams}
    next_num = 1
    while next_num in used_numbers:
        next_num += 1

    # Determine gender int for relay record
    gender_int = event.gender or 0

    # Create relay record
    relay = Relay(
        meetsid=meet_id,
        clubsid=target_club_id,
        stylesid=style.swimstyleid,
        teamnumb=next_num,
        gender=gender_int,
        minage=age_min if age_min else 0,
        maxage=age_max if age_max else 0,
        eventnumb=event.eventnumber,
        eventtyp=0,
        resulttyp=0,
    )
    db.add(relay)
    db.flush()  # Get the ID

    # Create empty position records
    for pos_num in range(1, style.relaycount + 1):
        db.add(RelayPos(
            relaysid=relay.relaysid,
            numb=pos_num,
            membersid=None,
            entrytime=None,
        ))

    db.commit()

    return {"teamId": relay.relaysid, "teamNumber": _team_number_to_letter(next_num)}


@router.delete("/relay-teams/{team_id}")
def delete_relay_team(team_id: int, request: Request, db: Session = Depends(get_db)):
    """Delete a relay team and all its positions."""
    from ..models_team import Relay, RelayPos

    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)

    role, caller_club = _resolve_role(pin, db)

    # ─── Handle virtual teams from swimresult relay locks (Requirement 10) ─────
    if team_id < 0:
        swimresult_id = -team_id
        sr = db.get(SwimResult, swimresult_id)
        if not sr:
            raise HTTPException(404, "Relay team not found (legacy lock missing)")

        # Determine club from the swimresult athlete for authorization
        sr_member = db.get(Member, sr.athleteid)
        if not sr_member:
            raise HTTPException(404, "Athlete from legacy relay lock not found")

        if role == "coach" and sr_member.clubsid != caller_club:
            raise HTTPException(403, "Cannot modify another club's relay teams")

        # Delete the swimresult lock row
        db.delete(sr)
        db.commit()
        return {"deleted": True}

    relay = db.get(Relay, team_id)
    if not relay:
        raise HTTPException(404, "Relay team not found")

    # Authorization: coach can only delete own club's teams
    if role == "coach" and relay.clubsid != caller_club:
        raise HTTPException(403, "Cannot modify another club's relay teams")

    # Delete positions first (cascade should handle this, but be explicit)
    db.query(RelayPos).filter(RelayPos.relaysid == team_id).delete(synchronize_session=False)
    db.delete(relay)
    db.commit()

    return {"deleted": True}


@router.put("/relay-teams/{team_id}/members/{position}")
def set_relay_team_member(
    team_id: int, position: int,
    data: RelayMemberUpdate,
    request: Request, db: Session = Depends(get_db)
):
    """Assign or remove an athlete from a relay team position."""
    from ..models_team import Relay, RelayPos

    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)

    role, caller_club = _resolve_role(pin, db)

    # ─── Handle virtual teams from swimresult relay locks (Requirement 10) ─────
    # Negative team_id means this is a virtual team backed by a swimresult lock.
    # We need to "materialize" it into relays/relayspos and remove the swimresult.
    if team_id < 0:
        swimresult_id = -team_id
        sr = db.get(SwimResult, swimresult_id)
        if not sr:
            raise HTTPException(404, "Relay team not found (legacy lock missing)")

        # Resolve event and style
        event = db.query(SwimEvent).options(joinedload(SwimEvent.swimstyle)).get(sr.swimeventid)
        if not event or not event.swimstyle:
            raise HTTPException(404, "Event not found for legacy relay lock")
        style = event.swimstyle
        if not style or not style.relaycount or style.relaycount <= 1:
            raise HTTPException(400, "Event is not a relay event")

        # Determine club from the swimresult athlete
        sr_member = db.get(Member, sr.athleteid)
        if not sr_member:
            raise HTTPException(404, "Athlete from legacy relay lock not found")
        target_club_id = sr_member.clubsid

        # Authorization
        if role == "coach" and target_club_id != caller_club:
            raise HTTPException(403, "Cannot modify another club's relay teams")

        # Validate position
        relaycount = style.relaycount
        if position < 1 or position > relaycount:
            raise HTTPException(400, f"Invalid position {position}. Must be between 1 and {relaycount}")

        # Resolve age range from swimresult age_code
        sr_age_code = sr.age_code or "Open"
        age_min, age_max = _age_code_to_range(sr_age_code)
        meet_id = _get_current_meet_id(db)

        # Determine gender int
        gender_int = event.gender or 0

        # Create real relay record
        relay = Relay(
            meetsid=meet_id,
            clubsid=target_club_id,
            stylesid=style.swimstyleid,
            teamnumb=1,
            gender=gender_int,
            minage=age_min if age_min else 0,
            maxage=age_max if age_max else 0,
            eventnumb=event.eventnumber,
            eventtyp=0,
            resulttyp=0,
        )
        db.add(relay)
        db.flush()  # Get the relay ID

        # Create position records: original athlete stays in position 1
        for pos_num in range(1, relaycount + 1):
            if pos_num == 1:
                db.add(RelayPos(
                    relaysid=relay.relaysid,
                    numb=pos_num,
                    membersid=sr.athleteid,
                    entrytime=None,
                ))
            else:
                db.add(RelayPos(
                    relaysid=relay.relaysid,
                    numb=pos_num,
                    membersid=None,
                    entrytime=None,
                ))

        # Now apply the actual member assignment for the requested position
        athlete_id = data.athleteId
        if athlete_id is not None:
            # Check athlete exists and belongs to club
            member = db.get(Member, athlete_id)
            if not member:
                raise HTTPException(404, "Athlete not found")
            if member.clubsid != target_club_id:
                raise HTTPException(400, "Athlete does not belong to the relay team's club")

            # Intra-team uniqueness: can't assign same athlete as position 1 to another position
            if athlete_id == sr.athleteid and position != 1:
                raise HTTPException(409, f"Athlete is already assigned to position 1 on this team")

            # Cross-team uniqueness: athlete not on another team for same event/age/club
            other_relays_query = (
                db.query(Relay)
                .filter(
                    Relay.clubsid == target_club_id,
                    Relay.stylesid == style.swimstyleid,
                    Relay.minage == (age_min if age_min else 0),
                    Relay.maxage == (age_max if age_max else 0),
                    Relay.relaysid != relay.relaysid,
                )
            )
            if meet_id:
                other_relays_query = other_relays_query.filter(Relay.meetsid == meet_id)
            other_relay_ids = [r.relaysid for r in other_relays_query.all()]

            if other_relay_ids:
                conflict = (
                    db.query(RelayPos)
                    .filter(
                        RelayPos.relaysid.in_(other_relay_ids),
                        RelayPos.membersid == athlete_id,
                    )
                    .first()
                )
                if conflict:
                    conflict_relay = db.get(Relay, conflict.relaysid)
                    team_letter = _team_number_to_letter(conflict_relay.teamnumb) if conflict_relay else "?"
                    athlete_name = f"{member.lastname}, {member.firstname}"
                    raise HTTPException(
                        409,
                        f"Athlete '{athlete_name}' is already assigned to Team {team_letter} for this event"
                    )

        # Update the requested position (overwrite what we just set)
        # Need to flush first to ensure the RelayPos rows are in DB
        db.flush()
        pos_record = db.query(RelayPos).filter(
            RelayPos.relaysid == relay.relaysid,
            RelayPos.numb == position,
        ).first()
        if pos_record:
            pos_record.membersid = athlete_id

        # Remove the legacy swimresult lock row
        db.delete(sr)
        db.commit()

        return {"ok": True, "migratedTeamId": relay.relaysid}

    # ─── Normal flow: existing relays record ───────────────────────────────────
    relay = db.get(Relay, team_id)
    if not relay:
        raise HTTPException(404, "Relay team not found")

    # Authorization
    if role == "coach" and relay.clubsid != caller_club:
        raise HTTPException(403, "Cannot modify another club's relay teams")

    # Validate position
    style = db.get(SwimStyle, relay.stylesid)
    relaycount = style.relaycount if style else 4
    if position < 1 or position > relaycount:
        raise HTTPException(400, f"Invalid position {position}. Must be between 1 and {relaycount}")

    athlete_id = data.athleteId

    if athlete_id is not None:
        # Check athlete exists
        member = db.get(Member, athlete_id)
        if not member:
            raise HTTPException(404, "Athlete not found")

        # Check athlete belongs to same club
        if member.clubsid != relay.clubsid:
            raise HTTPException(400, "Athlete does not belong to the relay team's club")

        # Intra-team uniqueness: athlete not already on another position of same team
        existing_on_team = (
            db.query(RelayPos)
            .filter(
                RelayPos.relaysid == team_id,
                RelayPos.membersid == athlete_id,
                RelayPos.numb != position,
            )
            .first()
        )
        if existing_on_team:
            raise HTTPException(409, f"Athlete is already assigned to position {existing_on_team.numb} on this team")

        # Cross-team uniqueness: athlete not on another team for same event/age/club
        # Find all other relay teams for same style/age/club
        meet_id = _get_current_meet_id(db)
        other_relays_query = (
            db.query(Relay)
            .filter(
                Relay.clubsid == relay.clubsid,
                Relay.stylesid == relay.stylesid,
                Relay.minage == relay.minage,
                Relay.maxage == relay.maxage,
                Relay.relaysid != team_id,
            )
        )
        if meet_id:
            other_relays_query = other_relays_query.filter(Relay.meetsid == meet_id)
        other_relay_ids = [r.relaysid for r in other_relays_query.all()]

        if other_relay_ids:
            conflict = (
                db.query(RelayPos)
                .filter(
                    RelayPos.relaysid.in_(other_relay_ids),
                    RelayPos.membersid == athlete_id,
                )
                .first()
            )
            if conflict:
                # Find which team
                conflict_relay = db.get(Relay, conflict.relaysid)
                team_letter = _team_number_to_letter(conflict_relay.teamnumb) if conflict_relay else "?"
                athlete_name = f"{member.lastname}, {member.firstname}"
                raise HTTPException(
                    409,
                    f"Athlete '{athlete_name}' is already assigned to Team {team_letter} for this event"
                )

        # Cross-team uniqueness: also check swimresult relay locks (virtual teams)
        # If this athlete has a swimresult lock for the same relay event, they are
        # already shown as position 1 on a virtual team — block the assignment.
        sr_conflict = (
            db.query(SwimResult)
            .join(SwimEvent, SwimResult.swimeventid == SwimEvent.swimeventid)
            .filter(
                SwimEvent.swimstyleid == relay.stylesid,
                SwimResult.athleteid == athlete_id,
                SwimResult.age_code == _relay_age_code(relay.minage, relay.maxage),
            )
            .first()
        )
        if sr_conflict:
            athlete_name = f"{member.lastname}, {member.firstname}"
            raise HTTPException(
                409,
                f"Athlete '{athlete_name}' already has a relay registration (legacy lock) for this event. "
                f"Modify the existing team instead."
            )

        # Gender balance validation for mixed (X) events:
        # Exactly N/2 men and N/2 women required (e.g., 2M+2F for 4-person relay)
        # In the DB, gender=1 is M-only, gender=2 is F-only, anything else (0/3/None) is mixed
        # SERC events (swimstyle 530) have NO gender/age restrictions
        is_serc = relay.stylesid == 530
        if not is_serc and relay.gender not in (GENDER_M, GENDER_F):
            max_per_gender = relaycount // 2

            # Count current gender assignments on this team (excluding current position)
            current_positions = (
                db.query(RelayPos)
                .filter(
                    RelayPos.relaysid == team_id,
                    RelayPos.numb != position,
                    RelayPos.membersid.isnot(None),
                )
                .all()
            )
            m_count = 0
            f_count = 0
            for rp in current_positions:
                pos_member = db.get(Member, rp.membersid)
                if pos_member:
                    if pos_member.gender == GENDER_M:
                        m_count += 1
                    elif pos_member.gender == GENDER_F:
                        f_count += 1

            if member.gender == GENDER_M and m_count >= max_per_gender:
                raise HTTPException(
                    400,
                    f"Cannot add another man: mixed relay requires exactly {max_per_gender} men and {max_per_gender} women"
                )
            if member.gender == GENDER_F and f_count >= max_per_gender:
                raise HTTPException(
                    400,
                    f"Cannot add another woman: mixed relay requires exactly {max_per_gender} men and {max_per_gender} women"
                )

        # Age group composition validation: a team is anchored to the event's own
        # age category — members must be from that exact category, or the single
        # adjacent-younger one (swim-up), and at least 1 member must match the
        # exact category. SERC events skip this check.
        if not is_serc:
            native_code = _get_event_native_age_code(db, relay.stylesid, relay.eventnumb, relay.gender)
            new_athlete_age_code = _resolve_athlete_age_codes(db, [athlete_id]).get(athlete_id)

            if native_code and new_athlete_age_code:
                if not _age_code_allowed_on_team(new_athlete_age_code, native_code):
                    raise HTTPException(
                        400,
                        f"Cannot assign: must be from the event's own age category "
                        f"({native_code}) or the next-younger category"
                    )

                current_positions_ag = (
                    db.query(RelayPos)
                    .filter(
                        RelayPos.relaysid == team_id,
                        RelayPos.numb != position,
                        RelayPos.membersid.isnot(None),
                    )
                    .all()
                )
                current_member_ids = [rp.membersid for rp in current_positions_ag]
                member_age_codes = list(_resolve_athlete_age_codes(db, current_member_ids).values())

                remaining_after_this = relaycount - len(current_positions_ag) - 1
                if _would_miss_native_anchor(member_age_codes, new_athlete_age_code, native_code, remaining_after_this):
                    raise HTTPException(
                        400,
                        f"Cannot assign: this team must include at least {_REQUIRED_NATIVE_COUNT} "
                        f"members from the event's own age category ({native_code})"
                    )

    # Upsert the position record
    existing_pos = db.query(RelayPos).filter(
        RelayPos.relaysid == team_id,
        RelayPos.numb == position,
    ).first()

    if existing_pos:
        existing_pos.membersid = athlete_id
    else:
        db.add(RelayPos(
            relaysid=team_id,
            numb=position,
            membersid=athlete_id,
            entrytime=None,
        ))

    db.commit()
    return {"ok": True}


@router.put("/relay-teams/{team_id}/name")
def set_relay_team_name(
    team_id: int,
    data: RelayTeamNameUpdate,
    request: Request, db: Session = Depends(get_db)
):
    """Set or clear a custom team name (stored on relay.name column)."""
    from ..models_team import Relay

    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)

    role, caller_club = _resolve_role(pin, db)

    # ─── Handle virtual teams from swimresult relay locks (Requirement 10) ─────
    # Virtual teams (negative IDs) must be materialized before naming.
    if team_id < 0:
        swimresult_id = -team_id
        sr = db.get(SwimResult, swimresult_id)
        if not sr:
            raise HTTPException(404, "Relay team not found (legacy lock missing)")

        # Resolve event and style
        event = db.query(SwimEvent).options(joinedload(SwimEvent.swimstyle)).get(sr.swimeventid)
        if not event or not event.swimstyle:
            raise HTTPException(404, "Event not found for legacy relay lock")
        style = event.swimstyle
        if not style or not style.relaycount or style.relaycount <= 1:
            raise HTTPException(400, "Event is not a relay event")

        # Determine club from the swimresult athlete
        sr_member = db.get(Member, sr.athleteid)
        if not sr_member:
            raise HTTPException(404, "Athlete from legacy relay lock not found")
        target_club_id = sr_member.clubsid

        # Authorization
        if role == "coach" and target_club_id != caller_club:
            raise HTTPException(403, "Cannot modify another club's relay teams")

        # Resolve age range from swimresult age_code
        sr_age_code = sr.age_code or "Open"
        age_min, age_max = _age_code_to_range(sr_age_code)
        meet_id = _get_current_meet_id(db)
        gender_int = event.gender or 0
        relaycount = style.relaycount

        # Create real relay record (materialize virtual team)
        from ..models_team import RelayPos
        relay = Relay(
            meetsid=meet_id,
            clubsid=target_club_id,
            stylesid=style.swimstyleid,
            teamnumb=1,
            gender=gender_int,
            minage=age_min if age_min else 0,
            maxage=age_max if age_max else 0,
            eventnumb=event.eventnumber,
            eventtyp=0,
            resulttyp=0,
        )
        db.add(relay)
        db.flush()

        # Create position records: original athlete stays in position 1
        for pos_num in range(1, relaycount + 1):
            if pos_num == 1:
                db.add(RelayPos(
                    relaysid=relay.relaysid,
                    numb=pos_num,
                    membersid=sr.athleteid,
                    entrytime=None,
                ))
            else:
                db.add(RelayPos(
                    relaysid=relay.relaysid,
                    numb=pos_num,
                    membersid=None,
                    entrytime=None,
                ))

        # Remove the legacy swimresult lock row
        db.delete(sr)
        db.flush()

        # Store the custom name on the relay row
        relay.name = data.name or None

        db.commit()
        return {"ok": True, "migratedTeamId": relay.relaysid}

    relay = db.get(Relay, team_id)
    if not relay:
        raise HTTPException(404, "Relay team not found")

    # Authorization
    if role == "coach" and relay.clubsid != caller_club:
        raise HTTPException(403, "Cannot modify another club's relay teams")

    # Store name directly on the relay row
    relay.name = data.name or None

    db.commit()
    return {"ok": True}
