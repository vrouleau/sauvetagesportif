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
    GENDER_M, GENDER_F, ROUND_FIN, ROUND_TIM, ROUND_PRE,
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

    db.commit()

    # Reset sequences after explicit ID inserts
    from sqlalchemy import text
    db.execute(text("SELECT setval('clubs_clubsid_seq', COALESCE((SELECT MAX(clubsid) FROM clubs), 0))"))
    db.execute(text("SELECT setval('members_membersid_seq', COALESCE((SELECT MAX(membersid) FROM members), 0))"))
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
        "meet_type": (_get_config(db, "meet_type") or "POOL").upper(),
    }


@router.get("/meet-config", dependencies=[Depends(require_organizer_or_admin)])
def get_meet_config(db: Session = Depends(get_db)):
    """Return MEETVALUES-style config as a flat dict {KEY: value}."""
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
    # Also include individual bsglobal keys that map to meet info
    name = _get_config(db, "meet_name")
    if name and "NAME" not in result:
        result["NAME"] = name
    course = _get_config(db, "meet_course")
    if course:
        course_map = {"LCM": "1", "SCM": "3", "SCY": "2"}
        result.setdefault("COURSE", course_map.get(course, "1"))
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
        # Sync meet_name for /meet-info compatibility
        if key == "NAME":
            _set_config(db, "meet_name", value)
        # Sync DEADLINE → closure_date
        if key == "DEADLINE" and value:
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
        raise HTTPException(400, "No admin email set for this club")

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
    """Public: list clubs that have an admin email."""
    clubs = (db.query(TeamClub)
             .filter(TeamClub.email != None, TeamClub.email != '')
             .order_by(TeamClub.name).all())
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
    if not club or not club.email:
        raise HTTPException(404, "Club not found")

    if email != (club.email or "").strip().lower():
        org_cfg = _get_config(db, "organizer_club_id")
        org_email = ""
        if org_cfg:
            org_club = db.query(TeamClub).get(int(org_cfg))
            if org_club:
                org_email = org_club.email or ""
        raise HTTPException(403, f"email_mismatch|{org_email}")

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
    meet_type = (_get_config(db, "meet_type") or "POOL").upper()
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
    meet_type = (_get_config(db, "meet_type") or "POOL").upper()
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
    return {**seed_result, **times_result, "events_loaded": events_loaded}


@router.post("/upload/results", dependencies=[Depends(require_admin)])
async def upload_results(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Upload results .lxf to populate best times."""
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 10MB)")
    seed_result = seed_from_lxf(db, content)
    # Skip best-time import for beach meets (positions are not times)
    meet_type = (_get_config(db, "meet_type") or "POOL").upper()
    if meet_type != "BEACH":
        times_result = load_best_times(db, content, source=file.filename or "upload")
    else:
        times_result = {"times_updated": 0, "athletes_skipped": 0, "athletes_created": 0}
    return {**seed_result, **times_result}


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
def export_meet_smb():
    smb_storage = Path(os.environ.get("MEET_STORAGE", "/app/data/meet.lxf")).parent / "meet.smb"
    if not smb_storage.exists():
        raise HTTPException(404, "No SMB backup available")
    return Response(
        content=smb_storage.read_bytes(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": "attachment; filename=meet.smb"},
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
# Database backup / restore (pg_dump / psql)
# ---------------------------------------------------------------------------

@router.get("/admin/backup-db", dependencies=[Depends(require_admin)])
def backup_db():
    """Download a full PostgreSQL dump (plain SQL)."""
    import subprocess
    db_url = os.environ.get("DATABASE_URL", "")
    # Parse DATABASE_URL: postgresql://user:pass@host:port/dbname
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
    """Run pg_dump and return SQL bytes."""
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


# ---------------------------------------------------------------------------
# Data management
# ---------------------------------------------------------------------------

@router.get("/data-management/styles", dependencies=[Depends(require_admin)])
def get_styles(db: Session = Depends(get_db)):
    """List all unique style_uids from meet events and best_times."""
    import json as _json
    cfg = db.query(BsGlobal).get("style_names_json")
    imported_names: dict[int, str] = {int(k): v for k, v in _json.loads(cfg.data).items()} if cfg and cfg.data else {}

    all_uids: set[int] = set()

    # Styles used in the current meet's events
    for (uid,) in db.query(SwimEvent.swimstyleid).distinct().all():
        if uid is not None:
            all_uids.add(int(uid))

    # Styles referenced in best_times entries (old JSON blobs)
    bt_entries = db.query(BsGlobal).filter(BsGlobal.name.like("bt_%")).all()
    for entry in bt_entries:
        try:
            data = _json.loads(entry.data)
            for uid_key in data:
                all_uids.add(int(uid_key))
        except (ValueError, TypeError):
            pass

    # Styles referenced in Team Manager Result table
    from ..models_team import Result as TeamResult
    for (uid,) in db.query(TeamResult.stylesid).distinct().all():
        if uid is not None:
            all_uids.add(int(uid))

    result = []
    for uid in all_uids:
        style = db.query(SwimStyle).get(uid)
        name = style.name if style else imported_names.get(uid, f"ID{uid}")
        result.append({"uid": uid, "name": name})
    return sorted(result, key=lambda x: x["uid"])


@router.post("/data-management/merge-clubs", dependencies=[Depends(require_admin)])
def merge_clubs(data: dict, db: Session = Depends(get_db)):
    """Merge clubs: move all athletes to the target club, delete the source club."""
    import json as _json
    merges = data.get("merges", [])
    merged = 0
    for m in merges:
        from_id = int(m["from_id"])
        to_id = int(m["to_id"])
        if from_id == to_id:
            continue
        from_club = db.query(TeamClub).filter(TeamClub.clubsid == from_id).first()
        to_club = db.query(TeamClub).filter(TeamClub.clubsid == to_id).first()
        if not from_club or not to_club:
            continue

        # Move athletes from source club to target club
        from_athletes = db.query(Member).filter(Member.clubsid == from_id).all()
        for ath in from_athletes:
            existing = db.query(Member).filter(
                Member.firstname == ath.firstname,
                Member.lastname == ath.lastname,
                Member.clubsid == to_id,
            ).first()
            if not existing:
                ath.clubsid = to_id
            else:
                # Merge best times: load both athletes' bt data
                from_bt = get_best_times(db, ath.membersid)
                to_bt = get_best_times(db, existing.membersid)
                for uid_key, style_data in from_bt.items():
                    if uid_key not in to_bt:
                        to_bt[uid_key] = style_data
                    else:
                        for course, entry in style_data.items():
                            if course not in to_bt[uid_key]:
                                to_bt[uid_key][course] = entry
                            elif entry["time_ms"] < to_bt[uid_key][course]["time_ms"]:
                                to_bt[uid_key][course] = entry
                from ..best_times import _save_best_times
                _save_best_times(db, existing.membersid, to_bt)
                delete_best_times(db, ath.membersid)
                # Delete registrations for the duplicate athlete
                db.query(SwimResult).filter(SwimResult.athleteid == ath.membersid).delete()
                db.flush()
                # Delete the duplicate member
                db.query(Member).filter(Member.membersid == ath.membersid).delete(synchronize_session=False)

        db.flush()
        db.delete(from_club)
        merged += 1

    db.commit()
    return {"merged": merged}


@router.post("/data-management/merge-styles", dependencies=[Depends(require_admin)])
def merge_styles(data: dict, db: Session = Depends(get_db)):
    """Remap swimstyleid from one style to another across all tables."""
    merges = data.get("merges", [])
    preview = data.get("preview", False)

    changes = []
    for m in merges:
        from_uid = int(m["from_uid"])
        to_uid = int(m["to_uid"])
        if from_uid == to_uid:
            continue
        from ..models_team import Result as TeamResult
        results_count = db.query(TeamResult).filter(TeamResult.stylesid == from_uid).count()
        events_count = db.query(SwimEvent).filter(SwimEvent.swimstyleid == from_uid).count()
        from_style = db.query(SwimStyle).get(from_uid)
        to_style = db.query(SwimStyle).get(to_uid)
        changes.append({
            "from_uid": from_uid,
            "to_uid": to_uid,
            "from_name": from_style.name if from_style else f"UID {from_uid}",
            "to_name": to_style.name if to_style else f"UID {to_uid}",
            "results_affected": results_count,
            "events_affected": events_count,
        })

    if preview:
        return {"changes": changes}

    # Execute the merge
    merged_count = 0
    for m in merges:
        from_uid = int(m["from_uid"])
        to_uid = int(m["to_uid"])
        if from_uid == to_uid:
            continue

        # Remap in Team Manager results (all historical meets)
        from ..models_team import Result as TeamResult
        merged_count += db.query(TeamResult).filter(
            TeamResult.stylesid == from_uid
        ).update({TeamResult.stylesid: to_uid}, synchronize_session=False)

        # Remap in current meet events (swimevent.swimstyleid)
        merged_count += db.query(SwimEvent).filter(
            SwimEvent.swimstyleid == from_uid
        ).update({SwimEvent.swimstyleid: to_uid}, synchronize_session=False)

    db.commit()
    return {"merged_count": merged_count}


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
