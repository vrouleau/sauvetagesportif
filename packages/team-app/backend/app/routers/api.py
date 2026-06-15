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
    load_best_times, get_best_times, delete_best_times, expire_old_best_times,
    get_best_time_date,
)
from ..export import generate_lxf
from ..export_entries import generate_entries_lxf
from ..invoices import create_invoice_for_club

router = APIRouter(prefix="/api")
_audit = logging.getLogger("audit")

MEET_STORAGE = Path(os.environ.get("MEET_STORAGE", "/app/data/meet.lxf"))
_DEFAULT_ADMIN_PIN = os.environ.get("ADMIN_PIN", "000000")
_BEST_TIME_MAX_AGE_MONTHS = int(os.environ.get("BEST_TIME_MAX_AGE_MONTHS", "18"))


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
    cfg = db.query(BsGlobal).get(key)
    return cfg.data if cfg else None


def _get_meet_type(db: Session) -> str:
    """Get the meet type, checking both team-app key (meet_type) and meet-app key (MEET_TYPE)."""
    return (_get_config(db, "meet_type") or _get_config(db, "MEET_TYPE") or "POOL").upper()


def _set_config(db: Session, key: str, value: str):
    cfg = db.query(BsGlobal).get(key)
    if cfg:
        cfg.data = value
    else:
        db.add(BsGlobal(name=key, data=value))


def _update_meetvalue(db: Session, key: str, typed_value: str):
    """Update a single key in the MEETVALUES blob (Splash format KEY=TYPE;VALUE)."""
    cfg = db.query(BsGlobal).get("MEETVALUES")
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
    cfg = db.query(BsGlobal).get("MEETVALUES")
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

@router.post("/upload/meet", dependencies=[Depends(require_organizer_or_admin)])
async def upload_meet(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Upload meet .lxf — sets event structure."""
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 10MB)")
    from ..meet_parser import parse_meet_lxf
    try:
        meet = parse_meet_lxf(content)
    except Exception as e:
        raise HTTPException(400, f"Invalid meet .lxf: {e}")

    MEET_STORAGE.parent.mkdir(parents=True, exist_ok=True)
    MEET_STORAGE.write_bytes(content)

    # Wipe registrations (swimresults with entrytime) then events
    db.query(SwimResult).delete()
    db.query(AgeGroup).delete()
    db.query(SwimEvent).delete()
    db.query(SwimSession).delete()
    # Clear Team Manager event tables BEFORE swimstyle (FK dependency)
    from ..models_team import Event as TeamEvent, Session as TeamSession, Meet as TeamMeet
    db.query(TeamEvent).delete()
    db.query(TeamSession).delete()
    db.query(TeamMeet).delete()
    db.query(SwimStyle).delete()
    db.flush()
    from ..events import _load_from_parsed
    count = _load_from_parsed(db, meet)

    # Regenerate combined events XML after loading event structure
    from ..combined_events import regenerate_combined_events
    from ..point_scores import regenerate_point_scores
    regenerate_combined_events(db)
    regenerate_point_scores(db)

    # Track metadata
    import json as _json
    for key, val in [("meet_filename", file.filename or "meet.lxf"),
                     ("meet_uploaded_at", datetime.utcnow().isoformat()),
                     ("meet_name", meet.meet_name),
                     ("meet_course", meet.course),
                     ("meet_masters", "T" if meet.masters else "F"),
                     ("meet_currency", meet.currency or "CAD"),
                     ("meet_fees_json", _json.dumps(meet.meet_fees)),
                     ("age_base_date", meet.age_base_date)]:
        _set_config(db, key, val)

    # Auto-detect meet type from swim style IDs (>= 600 = beach)
    has_beach = db.query(SwimStyle).filter(SwimStyle.swimstyleid >= 600).first() is not None
    _set_config(db, "meet_type", "BEACH" if has_beach else "POOL")

    # Sync meet identity into MEETVALUES blob for Splash SMB compatibility.
    # Individual bsglobal keys (meet_name, meet_course) are the canonical source;
    # MEETVALUES is kept in sync for interop with the meet-app EventsPage and SMB export.
    if meet.meet_name:
        _update_meetvalue(db, "NAME", f"S;{meet.meet_name}")
    if meet.course:
        course_map = {"LCM": "1", "SCM": "3", "SCY": "2"}
        _update_meetvalue(db, "COURSE", f"I;{course_map.get(meet.course, '1')}")

    # Reset closure date
    _set_config(db, "closure_date", "")

    # Regenerate club PINs
    for club in db.query(TeamClub).all():
        club.pin = ''.join(secrets.choice(string.digits) for _ in range(6))

    db.commit()
    return {"events_loaded": count, "filename": file.filename}


@router.post("/upload/meet-smb", dependencies=[Depends(require_admin)])
async def upload_meet_smb(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Upload meet .smb — full database restore from a Splash Meet Backup (admin only)."""
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 20MB)")

    from ..smb import read_smb, D_NULL_SENTINEL
    try:
        tables = read_smb(content)
    except Exception as e:
        raise HTTPException(400, f"Invalid .smb file: {e}")

    # OLE Automation epoch
    OLE_EPOCH = datetime(1899, 12, 30)

    def ole_to_datetime(val):
        if val is None:
            return None
        if not isinstance(val, (int, float)):
            return None
        if val == D_NULL_SENTINEL or val == 0:
            return None
        int_part = int(val)
        if int_part == -36522 or int_part == 0:
            frac = abs(val) % 1
            if frac == 0:
                return None
            total_minutes = round(frac * 24 * 60)
            hours = total_minutes // 60
            minutes = total_minutes % 60
            return datetime(2000, 1, 1, hours, minutes, 0)
        from datetime import timedelta
        dt = OLE_EPOCH + timedelta(days=val)
        if dt.year < 1900 or dt.year > 2100:
            return None
        return dt

    def ole_to_date_only(val):
        if val is None:
            return None
        if not isinstance(val, (int, float)):
            return None
        if val == D_NULL_SENTINEL or val == 0 or val <= 0:
            return None
        from datetime import timedelta
        dt = OLE_EPOCH + timedelta(days=int(val))
        if dt.year < 1900 or dt.year > 2100:
            return None
        return dt

    # Wipe ALL data (full restore)
    from ..models_team import Relay as RelayWipe, RelayPos as RelayPosWipe
    db.query(RelayPosWipe).delete()
    db.query(RelayWipe).delete()
    db.query(Split).delete()
    db.query(SwimResult).delete()
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
    db.query(Member).delete()
    db.query(TeamClub).delete()
    db.query(BsGlobal).delete()
    db.flush()

    # ── Import BSGLOBAL ────────────────────────────────────────────────────
    for row in tables.get("BSGLOBAL", []):
        name = row.get("name")
        if not name:
            continue
        db.add(BsGlobal(name=name, data=row.get("data") or ""))
    db.flush()

    # ── Import SWIMSTYLE ───────────────────────────────────────────────────
    # Build a remap table: internal SMB swimstyleid → canonical uniqueid (5xx range)
    # Splash uses internal auto-increment IDs in the MDB but exports using uniqueid
    # in Lenex. We remap to uniqueid so our exports match Splash's Lenex output.
    style_id_remap: dict[int, int] = {}  # old_id → new_id (uniqueid)
    styles_imported = 0
    for row in tables.get("SWIMSTYLE", []):
        style_id = row.get("swimstyleid")
        if style_id is None:
            continue
        uid = row.get("uniqueid")
        # Remap if uniqueid exists and differs from swimstyleid
        # (lifesaving styles have uid in 5xx range, generic swim styles have uid < 200)
        canonical_id = style_id
        if uid and uid != style_id and uid >= 500:
            style_id_remap[style_id] = uid
            canonical_id = uid
        db.add(SwimStyle(
            swimstyleid=canonical_id,
            code=row.get("code"),
            distance=row.get("distance"),
            name=row.get("name"),
            relaycount=row.get("relaycount"),
            stroke=row.get("stroke"),
            sortcode=row.get("sortcode"),
            technique=row.get("technique"),
            uniqueid=uid,
        ))
        styles_imported += 1
    db.flush()

    # ── Import CLUB ────────────────────────────────────────────────────────
    clubs_imported = 0
    for row in tables.get("CLUB", []):
        cid = row.get("clubid")
        if cid is None:
            continue
        pin = ''.join(secrets.choice(string.digits) for _ in range(6))
        # Import into clubs table (TeamClub) for auth
        db.add(TeamClub(
            clubsid=cid,
            code=row.get("code") or "",
            name=row.get("name") or "",
            nation=row.get("nation") or "CAN",
            pin=pin,
            email=row.get("contactemail") or "",
        ))
        clubs_imported += 1
    db.flush()

    # ── Import ATHLETE ─────────────────────────────────────────────────────
    athletes_imported = 0
    for row in tables.get("ATHLETE", []):
        aid = row.get("athleteid")
        if aid is None:
            continue
        birthdate = ole_to_date_only(row.get("birthdate"))
        db.add(Member(
            membersid=aid,
            clubsid=row.get("clubid"),
            firstname=row.get("firstname") or "",
            lastname=row.get("lastname") or "",
            gender=row.get("gender"),
            birthdate=birthdate,
            nation=row.get("nation") or "",
            license=row.get("license") or "",
        ))
        athletes_imported += 1
    db.flush()

    # ── Import SWIMSESSION ────────────────────────────────────────────────
    for row in tables.get("SWIMSESSION", []):
        sid = row.get("swimsessionid")
        if sid is None:
            continue
        db.add(SwimSession(
            swimsessionid=sid,
            sessionnumber=row.get("sessionnumber"),
            name=row.get("name"),
            course=row.get("course"),
            daytime=ole_to_datetime(row.get("daytime")),
            startdate=ole_to_date_only(row.get("startdate")),
            endtime=ole_to_datetime(row.get("endtime")),
            lanemin=row.get("lanemin"),
            lanemax=row.get("lanemax"),
            warmupfrom=ole_to_datetime(row.get("warmupfrom")),
            warmupuntil=ole_to_datetime(row.get("warmupuntil")),
            officialmeeting=ole_to_datetime(row.get("officialmeeting")),
            tlmeeting=ole_to_datetime(row.get("tlmeeting")),
        ))
    db.flush()

    # ── Import SWIMEVENT ──────────────────────────────────────────────────
    events_imported = 0
    for row in tables.get("SWIMEVENT", []):
        eid = row.get("swimeventid")
        session_id = row.get("swimsessionid")
        if eid is None or session_id is None:
            continue
        style_id = row.get("swimstyleid")
        # Remap swimstyleid to canonical uniqueid if available
        if style_id and style_id in style_id_remap:
            style_id = style_id_remap[style_id]
        db.add(SwimEvent(
            swimeventid=eid,
            swimsessionid=session_id,
            swimstyleid=style_id if style_id else None,
            eventnumber=row.get("eventnumber"),
            gender=row.get("gender"),
            round=row.get("round"),
            sortcode=row.get("sortcode"),
            daytime=ole_to_datetime(row.get("daytime")),
            duration=ole_to_datetime(row.get("duration")),
            comment=row.get("comment"),
            internalevent=row.get("internalevent"),
            roundname=row.get("roundname"),
            masters=row.get("masters"),
            fee=row.get("fee"),
            combineagegroups=row.get("combineagegroups"),
            splashmecanedit=row.get("splashmecanedit"),
            pfineignore=row.get("pfineignore"),
            preveventid=row.get("preveventid"),
            twoperlane=row.get("twoperlane"),
        ))
        events_imported += 1
    db.flush()

    # ── Normalize Splash MDB round encoding → canonical ──────────────────
    # Splash MDB uses: 1=TimedFinal, 2=Prelim, 9=Final, 11=Break/Pause
    # Our canonical:   1=Prelim(PRE), 2=Semi, 4=Final(FIN), 5=TimedFinal(TIM)
    has_mdb_encoding = db.query(SwimEvent).filter(SwimEvent.round.in_([9, 11])).count() > 0
    if has_mdb_encoding:
        # Mark round=11 (Break/Pause) events as internal before remapping
        for ev in db.query(SwimEvent).filter(SwimEvent.round == 11).all():
            ev.internalevent = 'T'
            ev.round = ROUND_TIM
        db.flush()

        for ev in db.query(SwimEvent).filter(SwimEvent.round == 1).all():
            ev.round = -1
        for ev in db.query(SwimEvent).filter(SwimEvent.round == 2).all():
            ev.round = -2
        for ev in db.query(SwimEvent).filter(SwimEvent.round == 9).all():
            ev.round = -9
        db.flush()
        for ev in db.query(SwimEvent).filter(SwimEvent.round == -1).all():
            ev.round = ROUND_TIM
        for ev in db.query(SwimEvent).filter(SwimEvent.round == -2).all():
            ev.round = ROUND_PRE
        for ev in db.query(SwimEvent).filter(SwimEvent.round == -9).all():
            ev.round = ROUND_FIN
        db.flush()

        # Fix PRE events with gender=0
        pre_events = db.query(SwimEvent).filter(
            SwimEvent.round == ROUND_PRE, SwimEvent.gender == 0,
            SwimEvent.swimstyleid.isnot(None),
        ).all()
        for pre in pre_events:
            tim = db.query(SwimEvent).filter(
                SwimEvent.swimsessionid == pre.swimsessionid,
                SwimEvent.swimstyleid == pre.swimstyleid,
                SwimEvent.round == ROUND_TIM,
                SwimEvent.sortcode == (pre.sortcode or 0) - 1,
            ).first()
            if tim and tim.gender and tim.gender != 0:
                pre.gender = tim.gender
                continue
            fin = db.query(SwimEvent).filter(
                SwimEvent.preveventid == pre.swimeventid,
                SwimEvent.round == ROUND_FIN,
            ).first()
            if fin and fin.gender and fin.gender != 0:
                pre.gender = fin.gender
        db.flush()

        # Fix PRE events with eventnumber=0
        zero_num_prelims = (
            db.query(SwimEvent)
            .join(SwimSession, SwimEvent.swimsessionid == SwimSession.swimsessionid)
            .filter(
                SwimEvent.round == ROUND_PRE,
                SwimEvent.swimstyleid.isnot(None),
                ((SwimEvent.eventnumber == 0) | (SwimEvent.eventnumber.is_(None))),
            )
            .order_by(SwimSession.sessionnumber, SwimEvent.sortcode)
            .all()
        )
        for seq, pre in enumerate(zero_num_prelims, start=1):
            pre.eventnumber = seq
        db.flush()

    # ── Import AGEGROUP ───────────────────────────────────────────────────
    agegroups_imported = 0
    for row in tables.get("AGEGROUP", []):
        agid = row.get("agegroupid")
        event_id = row.get("swimeventid")
        if agid is None or event_id is None:
            continue
        db.add(AgeGroup(
            agegroupid=agid,
            swimeventid=event_id,
            name=row.get("name"),
            code=row.get("code"),
            agemin=row.get("agemin"),
            agemax=row.get("agemax"),
            gender=row.get("gender"),
            heatcount=row.get("heatcount"),
            sortcode=row.get("sortcode"),
            useformedals=row.get("useformedals"),
            useforscoring=row.get("useforscoring"),
            finalseedtype=row.get("finalseedtype"),
        ))
        agegroups_imported += 1
    db.flush()

    # ── Import HEAT ───────────────────────────────────────────────────────
    heats_imported = 0
    for row in tables.get("HEAT", []):
        hid = row.get("heatid")
        if hid is None:
            continue
        db.add(Heat(
            heatid=hid,
            swimeventid=row.get("swimeventid"),
            heatnumber=row.get("heatnumber"),
            racestatus=row.get("racestatus"),
            sortcode=row.get("sortcode"),
        ))
        heats_imported += 1
    db.flush()

    # ── Import SWIMRESULT ─────────────────────────────────────────────────
    results_imported = 0
    for row in tables.get("SWIMRESULT", []):
        rid = row.get("swimresultid")
        if rid is None:
            continue
        db.add(SwimResult(
            swimresultid=rid,
            athleteid=row.get("athleteid"),
            swimeventid=row.get("swimeventid"),
            agegroupid=row.get("agegroupid") or None,
            heatid=row.get("heatid") or None,
            lane=row.get("lane"),
            entrytime=row.get("entrytime"),
            swimtime=row.get("swimtime"),
            entrycourse=row.get("entrycourse"),
            backuptime1=row.get("backuptime1"),
            backuptime2=row.get("backuptime2"),
        ))
        results_imported += 1
    db.flush()

    # ── Import SPLIT ──────────────────────────────────────────────────────
    for row in tables.get("SPLIT", []):
        rid = row.get("swimresultid")
        if rid is None:
            continue
        db.add(Split(
            swimresultid=rid,
            distance=row.get("distance"),
            swimtime=row.get("swimtime"),
        ))
    db.flush()

    # ── Import RELAY ──────────────────────────────────────────────────────
    from ..models_team import Relay, RelayPos
    # Build event→swimstyleid lookup for mapping swimeventid to stylesid
    event_style_map: dict[int, int] = {}
    for ev in db.query(SwimEvent).filter(SwimEvent.swimstyleid.isnot(None)).all():
        event_style_map[ev.swimeventid] = ev.swimstyleid

    relays_imported = 0
    for row in tables.get("RELAY", []):
        rid = row.get("relayid")
        if rid is None:
            continue
        event_id = row.get("swimeventid")
        style_id = event_style_map.get(event_id) if event_id else None
        # Remap swimstyleid if needed (same remap as events)
        if style_id and style_id in style_id_remap:
            style_id = style_id_remap[style_id]
        db.add(Relay(
            relaysid=rid,
            clubsid=row.get("clubid"),
            stylesid=style_id,
            teamnumb=row.get("teamnumber"),
            gender=row.get("gender"),
            minage=row.get("agemin"),
            maxage=row.get("agemax"),
            entrytime=row.get("entrytime"),
            course=row.get("entrycourse"),
        ))
        relays_imported += 1
    db.flush()

    # ── Import RELAYPOSITION ──────────────────────────────────────────────
    for row in tables.get("RELAYPOSITION", []):
        rid = row.get("relayid")
        pos_num = row.get("relaynumber")
        athlete_id = row.get("athleteid")
        if rid is None or pos_num is None:
            continue
        if athlete_id is None or athlete_id == 0:
            continue
        db.add(RelayPos(
            relaysid=rid,
            numb=pos_num,
            membersid=athlete_id,
        ))
    db.flush()

    # ── Extract meet metadata from MEETVALUES ─────────────────────────────
    mv_row = db.query(BsGlobal).get("MEETVALUES")
    if mv_row and mv_row.data:
        mv = {}
        for line in mv_row.data.replace("\\r", "").split("\n"):
            line = line.strip("\r\n ")
            eq = line.find("=")
            if eq >= 0:
                key = line[:eq]
                val_part = line[eq + 1:]
                # Format: TYPE;VALUE
                semi = val_part.find(";")
                if semi >= 0:
                    mv[key] = val_part[semi + 1:]
                else:
                    mv[key] = val_part
        if mv.get("NAME"):
            _set_config(db, "meet_name", mv["NAME"])
        if mv.get("COURSE"):
            course_map = {"1": "LCM", "2": "SCY", "3": "SCM"}
            _set_config(db, "meet_course", course_map.get(mv["COURSE"], "LCM"))
        if mv.get("MASTERS"):
            _set_config(db, "meet_masters", mv["MASTERS"])
        if mv.get("NATION"):
            _set_config(db, "meet_nation", mv["NATION"])
        if mv.get("CITY"):
            _set_config(db, "meet_city", mv["CITY"])
        if mv.get("AGEDATE"):
            # Convert YYYYMMDDHHMMSSMMM → YYYY-MM-DD
            raw = mv["AGEDATE"]
            if len(raw) >= 8:
                _set_config(db, "age_base_date", f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}")
    db.flush()

    # ── Create a Meet row in Team Manager schema (current meet) ───────────
    from ..models_team import Meet as TeamMeet
    from sqlalchemy import func
    meet_name = _get_config(db, "meet_name") or "Current Meet"
    meet_city = _get_config(db, "meet_city") or ""
    course_str = _get_config(db, "meet_course") or "LCM"
    course_int = {"LCM": 1, "SCY": 2, "SCM": 3}.get(course_str, 1)
    next_meet_id = (db.query(func.max(TeamMeet.meetsid)).scalar() or 0) + 1
    db.add(TeamMeet(
        meetsid=next_meet_id,
        name=meet_name,
        place=meet_city,
        course=course_int,
        meetstate=0,  # planned (current)
    ))
    _set_config(db, "current_meetsid", str(next_meet_id))
    db.flush()

    # Set meetsid on all imported relays (they were imported before the meet was created)
    db.query(Relay).filter(Relay.meetsid.is_(None)).update({"meetsid": next_meet_id}, synchronize_session=False)
    db.flush()

    # Regenerate combined events + point scores
    from ..combined_events import regenerate_combined_events
    from ..point_scores import regenerate_point_scores
    regenerate_combined_events(db)
    regenerate_point_scores(db)

    # Store the uploaded SMB for later download
    smb_storage = Path(os.environ.get("MEET_STORAGE", "/app/data/meet.lxf")).parent / "meet.smb"
    smb_storage.parent.mkdir(parents=True, exist_ok=True)
    smb_storage.write_bytes(content)

    # Restore admin PIN from env (since bsglobal was wiped)
    _set_config(db, "admin_pin", _DEFAULT_ADMIN_PIN)

    # Normalize meet_type: the meet-app stores it as MEET_TYPE, team-app reads meet_type
    mt = _get_config(db, "MEET_TYPE")
    if mt and not _get_config(db, "meet_type"):
        _set_config(db, "meet_type", mt.upper())
    # Auto-detect from swim style IDs if neither key is present
    if not _get_config(db, "meet_type"):
        has_beach = db.query(SwimStyle).filter(SwimStyle.swimstyleid >= 600).first() is not None
        _set_config(db, "meet_type", "BEACH" if has_beach else "POOL")

    db.commit()

    # Reset sequences after explicit ID inserts (PostgreSQL only)
    from sqlalchemy import text
    if db.bind and db.bind.dialect.name == "postgresql":
        db.execute(text("SELECT setval('clubs_clubsid_seq', GREATEST(COALESCE((SELECT MAX(clubsid) FROM clubs), 0), 1))"))
        db.execute(text("SELECT setval('members_membersid_seq', GREATEST(COALESCE((SELECT MAX(membersid) FROM members), 0), 1))"))
        db.commit()

    return {
        "events_loaded": events_imported,
        "styles_loaded": styles_imported,
        "agegroups_loaded": agegroups_imported,
        "clubs_loaded": clubs_imported,
        "athletes_loaded": athletes_imported,
        "heats_loaded": heats_imported,
        "results_loaded": results_imported,
        "filename": file.filename,
    }


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

    template_path = Path(os.environ.get(env_var, os.environ.get("MEET_DEFAULT_TEMPLATE", fallback)))
    if not template_path.exists():
        raise HTTPException(404, f"Meet template not found: {template_path}")

    from ..meet_parser import parse_meet_lxf
    try:
        meet = parse_meet_lxf(template_path)
    except Exception as e:
        raise HTTPException(400, f"Invalid template .lxf: {e}")

    # Wipe existing data
    db.query(SwimResult).delete()
    db.query(AgeGroup).delete()
    db.query(SwimEvent).delete()
    db.query(SwimSession).delete()
    # Clear Team Manager event tables BEFORE swimstyle (FK dependency)
    from ..models_team import Event as TeamEvent, Session as TeamSession, Meet as TeamMeet
    db.query(TeamEvent).delete()
    db.query(TeamSession).delete()
    db.query(TeamMeet).delete()
    db.query(SwimStyle).delete()
    db.flush()

    # Import from template
    from ..events import _load_from_parsed
    count = _load_from_parsed(db, meet)

    # Regenerate combined events XML after loading event structure
    from ..combined_events import regenerate_combined_events
    from ..point_scores import regenerate_point_scores
    regenerate_combined_events(db)
    regenerate_point_scores(db)

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
    mv_cfg = db.query(BsGlobal).get("MEETVALUES")
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

    db.commit()
    return {"events_loaded": count, "filename": template_path.name, "meet_type": meet_type}


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
    cfg = db.query(BsGlobal).get("MEETVALUES")
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
    cfg = db.query(BsGlobal).get("MEETVALUES")
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

    meet_fees = _meet_fees(db)
    result = []
    for c in clubs:
        item = {"id": c.clubsid, "name": c.name, "code": c.code,
                "athlete_count": athlete_counts.get(c.clubsid, 0),
                "registered_athlete_count": reg_counts.get(c.clubsid, 0),
                "invite_send_count": c.invite_send_count or 0,
                "stripe_send_count": c.stripe_send_count or 0}
        items = _club_line_items(db, c, meet_fees)
        item["total_fees_cents"] = sum(it["unit_cents"] * it["qty"] for it in items)
        if role in ("admin", "organizer"):
            item["email"] = c.email or ""
        if role == "admin":
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
        # Delete best times from bsglobal
        for aid in athlete_ids:
            delete_best_times(db, aid)
    db.query(Member).filter(Member.clubsid == club_id).delete(synchronize_session=False)
    db.query(SecretLink).filter(SecretLink.club_id == club_id).delete(synchronize_session=False)
    db.query(TeamClub).filter(TeamClub.clubsid == club_id).delete(synchronize_session=False)
    db.commit()
    return {"deleted": True, "athletes_deleted": len(athlete_ids)}


@router.post("/clubs/{club_id}/reset-pin", dependencies=[Depends(require_admin)])
def reset_club_pin(club_id: int, db: Session = Depends(get_db)):
    club = db.query(TeamClub).get(club_id)
    if not club:
        raise HTTPException(404)
    club.pin = ''.join(secrets.choice(string.digits) for _ in range(6))
    db.commit()
    return {"club": club.name, "pin": club.pin}


@router.put("/clubs/{club_id}", dependencies=[Depends(require_admin)])
def update_club(club_id: int, data: ClubUpdate, db: Session = Depends(get_db)):
    club = db.query(TeamClub).get(club_id)
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

    club = db.query(TeamClub).get(club_id)
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
        org_club = db.query(TeamClub).get(int(org_cfg))
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

    club = db.query(TeamClub).get(club_id)
    if not club:
        raise HTTPException(404, "Club not found")

    if club.email:
        # Club has a configured email — validate it matches
        if email != club.email.strip().lower():
            org_cfg = _get_config(db, "organizer_club_id")
            org_email = ""
            if org_cfg:
                org_club = db.query(TeamClub).get(int(org_cfg))
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

    club = db.query(TeamClub).get(link.club_id)
    return {"pin": pin, "club": club.name if club else ""}


# ---------------------------------------------------------------------------
# Athletes
# ---------------------------------------------------------------------------

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
    member = db.query(Member).get(athlete_id)
    if not member:
        raise HTTPException(404)
    caller_club = _caller_club_id(db, pin)
    if caller_club is not None and member.clubsid != caller_club:
        raise HTTPException(403, "Cannot delete athletes from another club")
    db.query(SwimResult).filter(SwimResult.athleteid == athlete_id).delete()
    delete_best_times(db, athlete_id)
    db.delete(member)
    db.commit()
    return {"deleted": True}


@router.put("/athletes/{athlete_id}")
def update_athlete(athlete_id: int, data: AthleteUpdate, request: Request, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)
    member = db.query(Member).get(athlete_id)
    if not member:
        raise HTTPException(404)
    caller_club = _caller_club_id(db, pin)
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
                "ageGroups": [{
                    "id": ag.agegroupid,
                    "number": i + 1,
                    "name": ag.name or (f"{ag.agemin}-{ag.agemax}" if ag.agemin is not None else "???"),
                    "minAge": ag.agemin or 0,
                    "maxAge": ag.agemax,
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
            "poolSize": 50 if s.course == 1 else 25,
            "events": events_data,
        })
    return result


@router.put("/sessions/{session_id}", dependencies=[Depends(require_organizer_or_admin)])
def update_session(session_id: int, data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Update session fields (name, date, times, lanes, etc.)."""
    session = db.query(SwimSession).get(session_id)
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
    styles = db.query(SwimStyle).order_by(SwimStyle.distance, SwimStyle.stroke).all()
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
    session = db.query(SwimSession).get(session_id)
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
    """Create a new event in a session.

    Accepts: sessionId, number, gender, phase, swimstyleId (optional).
    If no swimstyleId provided, picks the first available style not already used in the meet.
    """
    from sqlalchemy import func

    session_id = data.get("sessionId") or data.get("session_id")
    if not session_id:
        raise HTTPException(400, "sessionId required")

    number = data.get("number", 1)
    gender_str = data.get("gender", "X")
    gender_int = {"M": 1, "F": 2, "X": 0}.get(gender_str, 0)
    phase = data.get("phase", "Finale directe")
    round_int = {"Eliminatoire": 1, "Finale": 4, "Finale directe": 5}.get(phase, 5)

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
    style = db.query(SwimStyle).get(swimstyle_id) if swimstyle_id else None
    return {
        "id": next_id,
        "name": style.name if style else "",
        "distance": style.distance if style else 0,
        "swimstyleId": swimstyle_id,
    }


@router.put("/events/{event_id}", dependencies=[Depends(require_organizer_or_admin)])
def update_event(event_id: int, data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Update event fields (gender, swimstyle, number, round, maxentries, etc.)."""
    event = db.query(SwimEvent).get(event_id)
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
            setattr(event, col, val)

    db.commit()
    return {"ok": True}


@router.delete("/events/{event_id}", dependencies=[Depends(require_organizer_or_admin)])
def delete_event(event_id: int, db: Session = Depends(get_db)):
    """Delete an event and its age groups."""
    event = db.query(SwimEvent).get(event_id)
    if not event:
        raise HTTPException(404, "Event not found")
    db.query(AgeGroup).filter(AgeGroup.swimeventid == event_id).delete()
    db.delete(event)
    db.commit()
    return {"ok": True}


@router.put("/events/reorder", dependencies=[Depends(require_organizer_or_admin)])
def reorder_events(data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Reorder events: accepts {updates: [{eventId, sessionId, sortcode}]}."""
    updates = data.get("updates", [])
    for u in updates:
        event = db.query(SwimEvent).get(u["eventId"])
        if event:
            event.swimsessionid = u.get("sessionId", event.swimsessionid)
            event.sortcode = u["sortcode"]
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
    gender_int = {"M": 1, "F": 2, "X": 0}.get(gender_str, 0)

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
    ag = db.query(AgeGroup).get(agegroup_id)
    if not ag:
        raise HTTPException(404, "Age group not found")
    for key in ("name", "agemin", "agemax", "gender", "heatcount", "sortcode"):
        if key in data:
            setattr(ag, key, data[key])
    db.commit()
    return {"ok": True}


@router.delete("/age-groups/{agegroup_id}", dependencies=[Depends(require_organizer_or_admin)])
def delete_age_group(agegroup_id: int, db: Session = Depends(get_db)):
    """Delete an age group."""
    ag = db.query(AgeGroup).get(agegroup_id)
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

    # Try to find matching member in Team Manager schema (by license)
    from ..best_times_v2 import get_best_times_for_member
    if member.membersid:
        # Use computed best times from historical results
        bt_data = get_best_times_for_member(db, member.membersid, _BEST_TIME_MAX_AGE_MONTHS)
        for uid_key, style_data in bt_data.items():
            uid = int(uid_key)
            if "LCM" in style_data:
                best_map_lcm[uid] = style_data["LCM"]["time_ms"]
            if "SCM" in style_data:
                best_map_scm[uid] = style_data["SCM"]["time_ms"]

    # Also check old JSON blob system (transition: results may not be in Team schema yet)
    if not best_map_lcm and not best_map_scm:
        expired = expire_old_best_times(db, athlete_id, _BEST_TIME_MAX_AGE_MONTHS)
        if expired:
            db.commit()
        bt_data = get_best_times(db, athlete_id)
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
    member = db.query(Member).get(athlete_id)
    if member:
        member.handicapex = "X" if has_masters else None


@router.get("/athletes/{athlete_id}/history")
def get_athlete_history(athlete_id: int, db: Session = Depends(get_db)):
    """Return an athlete's results across all historical meets."""
    from ..models_team import Meet, Result, Member as TMember

    member = db.query(TMember).get(athlete_id)
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
    style_names_cfg = db.query(BsGlobal).get("style_names_json")
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
    member = db.query(Member).get(athlete_id)
    if not member:
        raise HTTPException(404, "Athlete not found")
    if caller_club is not None and member.clubsid != caller_club:
        raise HTTPException(403, "Cannot register athletes from another club")

    event = db.query(SwimEvent).get(event_id)
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
    style = db.query(SwimStyle).get(event.swimstyleid)
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
    reg = db.query(SwimResult).get(reg_id)
    if not reg:
        raise HTTPException(404)
    caller_club = _caller_club_id(db, pin)
    if caller_club is not None:
        member = db.query(Member).get(reg.athleteid)
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
async def upload_entries(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Upload .lxf — seeds clubs + athletes and populates best times."""
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 10MB)")
    seed_result = seed_from_lxf(db, content)
    # Skip best-time import for beach meets (positions are not times)
    meet_type = _get_meet_type(db)
    if meet_type != "BEACH":
        times_result = load_best_times(db, content, source=file.filename or "upload")
    else:
        times_result = {"times_updated": 0, "athletes_skipped": 0, "athletes_created": 0}
    events_loaded = 0
    if not db.query(SwimEvent).first():
        from ..meet_parser import parse_meet_lxf
        from ..events import _load_from_parsed
        try:
            meet = parse_meet_lxf(content)
            if meet.all_events:
                events_loaded = _load_from_parsed(db, meet)
        except Exception:
            pass

    # Import relay teams from LXF
    relays_imported = _import_relays_from_lxf(db, content)

    return {**seed_result, **times_result, "events_loaded": events_loaded, "relays_imported": relays_imported}


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
        except (zipfile.BadZipFile, StopIteration, HTTPException) as e:
            if isinstance(e, HTTPException):
                raise
            # If we can't parse, just continue with the import

    seed_result = seed_from_lxf(db, content)
    # Skip best-time import for beach meets (positions are not times)
    meet_type = _get_meet_type(db)
    if meet_type != "BEACH":
        times_result = load_best_times(db, content, source=file.filename or "upload")
    else:
        times_result = {"times_updated": 0, "athletes_skipped": 0, "athletes_created": 0}
    return {**seed_result, **times_result}


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
    meet = db.query(Meet).get(meet_id)
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
    import json as _json
    # Count total best time entries (each athlete can have multiple style/course pairs)
    bt_count = 0
    bt_entries = db.query(BsGlobal).filter(BsGlobal.name.like("bt_%")).all()
    for entry in bt_entries:
        try:
            data = _json.loads(entry.data)
            for style_data in data.values():
                bt_count += len(style_data)  # count each course entry
        except (ValueError, TypeError):
            pass
    return {
        "clubs": db.query(TeamClub).count(),
        "athletes": db.query(Member).count(),
        "events": db.query(SwimEvent).count(),
        "registrations": db.query(SwimResult).count(),
        "best_times": bt_count,
    }


@router.delete("/registrations", dependencies=[Depends(require_admin)])
def flush_meet(db: Session = Depends(get_db)):
    """Flush meet: delete registrations, events, meet config."""
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
    for key in ("meet_filename", "meet_uploaded_at", "meet_name", "meet_course",
                "meet_masters", "meet_currency", "meet_fees_json", "closure_date",
                "organizer_club_id", "COMBINEDEVENTS", "current_meetsid",
                "POINTSCORES", "MEETVALUES",
                "meet_nation", "meet_city"):
        cfg = db.query(BsGlobal).get(key)
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
    smb_path = MEET_STORAGE.parent / "meet.smb"
    if smb_path.exists():
        smb_path.unlink()
    db.commit()
    return {"deleted": reg_count}


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

    # Clear Meet Manager schema (registrations + event structure, keep swimstyle)
    db.query(SwimResult).delete()
    db.query(Heat).delete()
    db.query(AgeGroup).delete()
    db.query(SwimEvent).delete()
    db.query(SwimSession).delete()

    # Clear bsglobal meet config.
    # Intentionally preserved: admin_pin, GEMINI_KEY_FREE, GEMINI_KEY_PAID, bt_* best-time keys.
    for key in ("meet_filename", "meet_uploaded_at", "meet_name", "meet_course",
                "meet_masters", "meet_currency", "meet_fees_json", "closure_date",
                "organizer_club_id", "COMBINEDEVENTS", "current_meetsid",
                "POINTSCORES", "MEETVALUES",
                "meet_nation", "meet_city"):
        cfg = db.query(BsGlobal).get(key)
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
    smb_path = MEET_STORAGE.parent / "meet.smb"
    if smb_path.exists():
        smb_path.unlink()


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
    club = db.query(TeamClub).get(int(cfg))
    if not club:
        return {"club_id": None, "club_name": None}
    return {"club_id": club.clubsid, "club_name": club.name}


@router.post("/admin/set-organizer", dependencies=[Depends(require_admin)])
def set_organizer(data: dict, db: Session = Depends(get_db)):
    club_id = data.get("club_id")
    if club_id is None:
        raise HTTPException(400, "club_id required")
    if not db.query(TeamClub).get(club_id):
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
    club = db.query(TeamClub).get(int(org_cfg))
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
    club = db.query(TeamClub).get(int(org_cfg))
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
    club = db.query(TeamClub).get(int(org_cfg))
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
    club = db.query(TeamClub).get(club_id)
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
            club = db.query(TeamClub).get(cid)
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
    club = db.query(TeamClub).get(club_id)
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
    org_club = db.query(TeamClub).get(int(org_cfg))
    if not org_club or not org_club.stripe_account_id:
        raise HTTPException(400, "Organizer has no connected Stripe account")

    club = db.query(TeamClub).get(club_id)
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


@router.get("/export/meet-smb", dependencies=[Depends(require_admin)])
def export_meet_smb(db: Session = Depends(get_db)):
    """Generate and download an .smb from the current database state."""
    from ..generate_smb import generate_smb_from_db
    content = generate_smb_from_db(db)
    # Derive filename from meet name if available
    meet_name = _get_config(db, "meet_name") or "meet"
    safe_name = "".join(c for c in meet_name if c.isalnum() or c in " _-").strip().replace(" ", "_")
    filename = f"{safe_name or 'meet'}.smb"
    return Response(
        content=content,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
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
    from ..database import is_sqlite, DATABASE_URL
    if is_sqlite():
        import shutil
        # Extract file path from sqlite:///path
        db_path = DATABASE_URL.replace("sqlite:///", "")
        if not Path(db_path).exists():
            raise HTTPException(404, "Database file not found")
        content = Path(db_path).read_bytes()
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
    """Restore database from a pg_dump SQL file. Wipes all existing data."""
    import subprocess
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 50MB)")
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

BACKUP_DIR = Path(os.environ.get("MEET_STORAGE", "/app/data/meet.lxf")).parent / "backups"


def _run_pg_dump_bytes() -> bytes:
    """Run pg_dump and return SQL bytes (Postgres) or read .db file (SQLite)."""
    from ..database import is_sqlite, DATABASE_URL
    if is_sqlite():
        db_path = DATABASE_URL.replace("sqlite:///", "")
        return Path(db_path).read_bytes()
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
    for f in sorted(BACKUP_DIR.glob("*.sql"), key=lambda p: p.stat().st_mtime, reverse=True):
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
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    filename = f"manual-{timestamp}.sql"
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


@router.post("/best-times-public")
def best_times_public(data: dict, request: Request, db: Session = Depends(get_db)):
    """Public: return all best times grouped by club with style columns."""
    import httpx
    import json as _json

    turnstile_secret = os.environ.get("TURNSTILE_SECRET_KEY", "")
    if turnstile_secret:
        captcha_token = data.get("captcha_token", "")
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

    # Gather style names
    cfg = db.query(BsGlobal).get("style_names_json")
    imported_names: dict[int, str] = {int(k): v for k, v in _json.loads(cfg.data).items()} if cfg and cfg.data else {}

    # All best times from bsglobal bt_* entries
    bt_entries = db.query(BsGlobal).filter(BsGlobal.name.like("bt_%")).all()

    # Collect unique styles and build clubs_map
    all_uids: set[int] = set()
    # athlete_id -> bt_data
    athlete_bt: dict[int, dict] = {}
    for entry in bt_entries:
        try:
            athlete_id = int(entry.name.replace("bt_", ""))
            bt_data = _json.loads(entry.data)
            athlete_bt[athlete_id] = bt_data
            for uid_key in bt_data:
                all_uids.add(int(uid_key))
        except (ValueError, TypeError):
            pass

    style_uids = sorted(all_uids)
    styles = []
    for uid in style_uids:
        style = db.query(SwimStyle).get(uid)
        name = style.name if style else imported_names.get(uid, f"ID{uid}")
        styles.append({"uid": uid, "name": name})

    # Load athletes with clubs
    athlete_ids = list(athlete_bt.keys())
    athletes_db = db.query(Member).options(
        joinedload(Member.club)
    ).filter(Member.membersid.in_(athlete_ids)).all() if athlete_ids else []
    athlete_map = {a.membersid: a for a in athletes_db}

    # Group by club then athlete
    clubs_map: dict[int, dict] = {}
    for athlete_id, bt_data in athlete_bt.items():
        a = athlete_map.get(athlete_id)
        if not a or not a.club:
            continue
        c = a.club
        if c.clubsid not in clubs_map:
            clubs_map[c.clubsid] = {"name": c.name, "athletes": {}}
        if a.membersid not in clubs_map[c.clubsid]["athletes"]:
            clubs_map[c.clubsid]["athletes"][a.membersid] = {
                "name": f"{a.lastname}, {a.firstname}",
                "times": {},
            }
        for uid_key, style_data in bt_data.items():
            for course, entry in style_data.items():
                key = f"{uid_key}_{course}"
                time_ms = entry.get("time_ms")
                if time_ms:
                    existing = clubs_map[c.clubid]["athletes"][a.athleteid]["times"].get(key)
                    if not existing or time_ms < existing:
                        clubs_map[c.clubid]["athletes"][a.athleteid]["times"][key] = time_ms

    # Build response
    clubs_list = []
    for cid in sorted(clubs_map, key=lambda x: clubs_map[x]["name"]):
        cm = clubs_map[cid]
        athletes_list = sorted(cm["athletes"].values(), key=lambda a: a["name"])
        clubs_list.append({"name": cm["name"], "athletes": athletes_list})

    course = _get_config(db, "meet_course")
    return {"styles": styles, "clubs": clubs_list, "course": course or "LCM"}


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
    meet = db.query(Meet).get(meet_id)
    if not meet:
        raise HTTPException(404, "Meet not found")
    db.delete(meet)  # cascades to sessions, events, results, membersmeets
    db.commit()
    return {"ok": True, "deleted": meet.name}



@router.get("/admin/historical-best-times/{member_id}", dependencies=[Depends(require_admin)])
def get_historical_best_times(member_id: int, db: Session = Depends(get_db)):
    """Get best times for a member computed from historical results."""
    from ..best_times_v2 import get_best_times_for_member
    bt = get_best_times_for_member(db, member_id)
    return {"member_id": member_id, "best_times": bt}



@router.post("/import-results-lxf", dependencies=[Depends(require_organizer_or_admin)])
async def import_results_lxf(request: Request, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import a meet-app results .lxf as a historical meet.

    - Organizer: archives meet as historical, then resets current meet,
      regenerates all club PINs, and clears the organizer role so an admin
      can invite the next organizer.  Returns reset=true.
    - Admin: creates or updates a historical meet record only.  No reset.
      Returns reset=false.

    meet-app exports via File → "Exporter les résultats LENEX…".
    Clubs/athletes are merged by code/license; if a completed meet with the
    same name already exists its results are replaced rather than duplicated.
    """
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 50MB)")

    from ..lxf_to_team import import_lxf_as_meet
    from ..best_times import load_best_times
    from ..models_live import LiveResult, LiveSplit, LiveStartlist, LiveEvent

    # LXF import is authoritative — clear any live results if present
    db.query(LiveSplit).delete()
    db.query(LiveResult).delete()
    db.query(LiveStartlist).delete()
    db.query(LiveEvent).delete()
    # Clear live mode keys
    for key in ("LIVE_PUSH_SECRET", "LIVE_ENABLED", "LIVE_LAST_PUSH"):
        cfg = db.query(BsGlobal).get(key)
        if cfg:
            db.delete(cfg)
    db.flush()

    try:
        counts = import_lxf_as_meet(db, content)
    except Exception as e:
        raise HTTPException(400, f"LXF import failed: {e}")

    try:
        load_best_times(db, content, source=file.filename or "import")
    except Exception:
        pass  # best-times update is best-effort

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


@router.post("/admin/import-meet-results", dependencies=[Depends(require_admin)])
async def import_meet_results(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import a meet-app .smb file as a historical meet with results.

    Maps Meet Manager schema (CLUB, ATHLETE, SWIMRESULT) to Team Manager
    schema (CLUBS, MEMBERS, RESULTS). Creates a new MEETS row.
    """
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 50MB)")

    from ..smb_to_team import import_smb_as_meet
    try:
        counts = import_smb_as_meet(db, content)
    except Exception as e:
        raise HTTPException(400, f"SMB import failed: {e}")

    return {"ok": True, **counts, "filename": file.filename}


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

    # Build event swimstyleid lookup
    event_style: dict[int, int] = {}
    for ev in db.query(SwimEvent).filter(SwimEvent.swimstyleid.isnot(None)).all():
        event_style[ev.swimeventid] = ev.swimstyleid

    # Get current meet ID
    meet_id_str = db.query(BsGlobal).get("current_meetsid")
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
    member_age_group_map: dict[int, str] = {}
    if member_ids_in_positions:
        from sqlalchemy import func as sqla_func
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
                SwimResult.athleteid.in_(list(member_ids_in_positions)),
                SwimStyle.relaycount == 1,  # only individual events
            )
            .group_by(SwimResult.athleteid, AgeGroup.agemin, AgeGroup.agemax)
            .order_by(SwimResult.athleteid, sqla_func.count().desc())
            .all()
        )
        seen_members: set[int] = set()
        for row in age_group_counts:
            if row.athleteid in seen_members:
                continue
            seen_members.add(row.athleteid)
            member_age_group_map[row.athleteid] = _relay_age_code(row.agemin, row.agemax)

    for relay in existing_relays:
        age_code = _relay_age_code(relay.minage, relay.maxage)
        # Find the event key by matching stylesid + gender to the event groups
        # Age code on the relay is the computed team age, not the event category
        relay_gender_str = "M" if relay.gender == GENDER_M else "F" if relay.gender == GENDER_F else "X"
        event_key = None
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

        # Compute team age group from majority of members' registered age groups
        computed_age_group = age_code  # fallback
        if member_age_codes_for_team:
            from collections import Counter
            counts = Counter(member_age_codes_for_team)
            computed_age_group = counts.most_common(1)[0][0]

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
        sr = db.query(SwimResult).get(swimresult_id)
        if not sr:
            raise HTTPException(404, "Relay team not found (legacy lock missing)")

        # Determine club from the swimresult athlete for authorization
        sr_member = db.query(Member).get(sr.athleteid)
        if not sr_member:
            raise HTTPException(404, "Athlete from legacy relay lock not found")

        if role == "coach" and sr_member.clubsid != caller_club:
            raise HTTPException(403, "Cannot modify another club's relay teams")

        # Delete the swimresult lock row
        db.delete(sr)
        db.commit()
        return {"deleted": True}

    relay = db.query(Relay).get(team_id)
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
        sr = db.query(SwimResult).get(swimresult_id)
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
        sr_member = db.query(Member).get(sr.athleteid)
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
            member = db.query(Member).get(athlete_id)
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
                    conflict_relay = db.query(Relay).get(conflict.relaysid)
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
    relay = db.query(Relay).get(team_id)
    if not relay:
        raise HTTPException(404, "Relay team not found")

    # Authorization
    if role == "coach" and relay.clubsid != caller_club:
        raise HTTPException(403, "Cannot modify another club's relay teams")

    # Validate position
    style = db.query(SwimStyle).get(relay.stylesid)
    relaycount = style.relaycount if style else 4
    if position < 1 or position > relaycount:
        raise HTTPException(400, f"Invalid position {position}. Must be between 1 and {relaycount}")

    athlete_id = data.athleteId

    if athlete_id is not None:
        # Check athlete exists
        member = db.query(Member).get(athlete_id)
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
                conflict_relay = db.query(Relay).get(conflict.relaysid)
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
                pos_member = db.query(Member).get(rp.membersid)
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

        # Age group majority validation:
        # Adding this athlete must not make it impossible for any single age group
        # to achieve a strict majority (≥ relaycount/2 + 1) once all positions are filled.
        # SERC events skip this check.
        from sqlalchemy import func as sqla_func_ag
        required_majority = relaycount // 2 + 1

        # Get age groups of currently assigned members (excluding current position)
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

        # Get the new athlete's registration age group (non-relay individual entries)
        new_athlete_ag_row = (
            db.query(AgeGroup.agemin, AgeGroup.agemax, sqla_func_ag.count().label("cnt"))
            .join(SwimResult, SwimResult.agegroupid == AgeGroup.agegroupid)
            .join(SwimEvent, SwimResult.swimeventid == SwimEvent.swimeventid)
            .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
            .filter(
                SwimResult.athleteid == athlete_id,
                SwimStyle.relaycount == 1,
            )
            .group_by(AgeGroup.agemin, AgeGroup.agemax)
            .order_by(sqla_func_ag.count().desc())
            .first()
        )
        new_athlete_age_code = (
            _relay_age_code(new_athlete_ag_row.agemin, new_athlete_ag_row.agemax)
            if new_athlete_ag_row else None
        )

        if new_athlete_age_code and current_member_ids and not is_serc:
            # Get age groups for current team members
            existing_ag_rows = (
                db.query(SwimResult.athleteid, AgeGroup.agemin, AgeGroup.agemax, sqla_func_ag.count().label("cnt"))
                .join(AgeGroup, SwimResult.agegroupid == AgeGroup.agegroupid)
                .join(SwimEvent, SwimResult.swimeventid == SwimEvent.swimeventid)
                .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
                .filter(
                    SwimResult.athleteid.in_(current_member_ids),
                    SwimStyle.relaycount == 1,
                )
                .group_by(SwimResult.athleteid, AgeGroup.agemin, AgeGroup.agemax)
                .order_by(SwimResult.athleteid, sqla_func_ag.count().desc())
                .all()
            )
            # Take the dominant age group per member
            member_age_codes: list[str] = []
            seen_ids: set[int] = set()
            for row in existing_ag_rows:
                if row.athleteid in seen_ids:
                    continue
                seen_ids.add(row.athleteid)
                member_age_codes.append(_relay_age_code(row.agemin, row.agemax))

            # Simulate adding the new athlete
            all_age_codes = member_age_codes + [new_athlete_age_code]
            remaining_positions = relaycount - len(all_age_codes)

            # Count occurrences
            from collections import Counter
            counts = Counter(all_age_codes)
            max_count = max(counts.values())

            if max_count + remaining_positions < required_majority:
                raise HTTPException(
                    400,
                    f"Cannot assign: adding this athlete would make it impossible to achieve "
                    f"an age group majority ({required_majority} of {relaycount} required)"
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
        sr = db.query(SwimResult).get(swimresult_id)
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
        sr_member = db.query(Member).get(sr.athleteid)
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

    relay = db.query(Relay).get(team_id)
    if not relay:
        raise HTTPException(404, "Relay team not found")

    # Authorization
    if role == "coach" and relay.clubsid != caller_club:
        raise HTTPException(403, "Cannot modify another club's relay teams")

    # Store name directly on the relay row
    relay.name = data.name or None

    db.commit()
    return {"ok": True}
