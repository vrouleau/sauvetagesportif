"""API endpoints — Splash-compatible schema."""
from __future__ import annotations

import logging
import os
import secrets
import string
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session, joinedload
from collections import defaultdict
import time as _time

from ..database import get_db
from pydantic import BaseModel, Field, field_validator
from ..models import (
    Club, Athlete, SwimEvent, SwimStyle, SwimSession, AgeGroup, SwimResult, BsGlobal, SecretLink,
    gender_to_str, gender_from_str, fee_dollars_to_cents, fee_cents_to_dollars,
    GENDER_M, GENDER_F, ROUND_FIN, ROUND_TIM,
)
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
MEET_TEMPLATE = Path(os.environ.get("MEET_TEMPLATE", "/app/templates/meet.smb"))
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
    if age_min == 19 and age_max == -1:
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
    club = db.query(Club).filter(Club.pin == pin).first()
    if not club:
        return "none", None
    org_cfg = _get_config(db, "organizer_club_id")
    if org_cfg and org_cfg == str(club.clubid):
        return "organizer", club.clubid
    return "coach", club.clubid


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
    club = db.query(Club).filter(Club.pin == pin).first()
    if club:
        org_cfg = _get_config(db, "organizer_club_id")
        if org_cfg and org_cfg == str(club.clubid):
            return
    cfg = _get_config(db, "closure_date")
    if cfg:
        from datetime import date
        if date.today() > date.fromisoformat(cfg):
            raise HTTPException(403, "Inscriptions fermées / Entries closed")


def _caller_club_id(db: Session, pin: str) -> int | None:
    """Return the club_id of the caller, or None if admin."""
    if pin == _get_admin_pin(db):
        return None
    club = db.query(Club).filter(Club.pin == pin).first()
    return club.clubid if club else None


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
    club = db.query(Club).filter(Club.pin == pin).first()
    if not club:
        _audit.info(f"[?] LOGIN_FAILED  (ip={ip})")
        raise HTTPException(401, "Invalid PIN")
    org_cfg = _get_config(db, "organizer_club_id")
    if org_cfg and org_cfg == str(club.clubid):
        _audit.info(f"[organizer/{club.name}] LOGIN  (ip={ip})")
        return {"role": "organizer", "club_id": club.clubid, "club_name": club.name}
    _audit.info(f"[coach/{club.name}] LOGIN  (ip={ip})")
    return {"role": "coach", "club_id": club.clubid, "club_name": club.name}


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
    db.query(SwimStyle).delete()
    db.flush()
    from ..events import _load_from_parsed
    count = _load_from_parsed(db, meet)

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
    for club in db.query(Club).all():
        club.pin = ''.join(secrets.choice(string.digits) for _ in range(6))

    db.commit()
    return {"events_loaded": count, "filename": file.filename}


@router.get("/meet-info")
def meet_info(db: Session = Depends(get_db)):
    import json as _json
    filename = _get_config(db, "meet_filename")
    uploaded = _get_config(db, "meet_uploaded_at")
    name = _get_config(db, "meet_name")
    course = _get_config(db, "meet_course")
    masters = _get_config(db, "meet_masters")
    closure = _get_config(db, "closure_date")
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
    }


@router.put("/closure-date", dependencies=[Depends(require_organizer_or_admin)])
def set_closure_date(data: ClosureDateUpdate, db: Session = Depends(get_db)):
    val = data.closure_date
    _set_config(db, "closure_date", val)
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
    clubs = db.query(Club).order_by(Club.name).all()

    # Pre-compute registered athlete counts per club
    reg_counts = dict(
        db.query(Athlete.clubid, func.count(distinct(Athlete.athleteid)))
        .join(SwimResult, SwimResult.athleteid == Athlete.athleteid)
        .group_by(Athlete.clubid)
        .all()
    )

    meet_fees = _meet_fees(db)
    result = []
    for c in clubs:
        item = {"id": c.clubid, "name": c.name, "code": c.code,
                "athlete_count": len(c.athletes),
                "registered_athlete_count": reg_counts.get(c.clubid, 0),
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
    club = Club(name=data.name, code=data.code, nation=data.nation, pin=pin, email=data.email)
    db.add(club)
    db.commit()
    return {"id": club.clubid, "pin": club.pin}


@router.delete("/clubs/{club_id}", dependencies=[Depends(require_admin)])
def delete_club(club_id: int, db: Session = Depends(get_db)):
    if not db.query(Club.clubid).filter(Club.clubid == club_id).first():
        raise HTTPException(404)
    athlete_ids = [aid for (aid,) in db.query(Athlete.athleteid).filter(Athlete.clubid == club_id).all()]
    if athlete_ids:
        db.query(SwimResult).filter(SwimResult.athleteid.in_(athlete_ids)).delete(synchronize_session=False)
        # Delete best times from bsglobal
        for aid in athlete_ids:
            delete_best_times(db, aid)
    db.query(Athlete).filter(Athlete.clubid == club_id).delete(synchronize_session=False)
    db.query(SecretLink).filter(SecretLink.club_id == club_id).delete(synchronize_session=False)
    db.query(Club).filter(Club.clubid == club_id).delete(synchronize_session=False)
    db.commit()
    return {"deleted": True, "athletes_deleted": len(athlete_ids)}


@router.post("/clubs/{club_id}/reset-pin", dependencies=[Depends(require_admin)])
def reset_club_pin(club_id: int, db: Session = Depends(get_db)):
    club = db.query(Club).get(club_id)
    if not club:
        raise HTTPException(404)
    club.pin = ''.join(secrets.choice(string.digits) for _ in range(6))
    db.commit()
    return {"club": club.name, "pin": club.pin}


@router.put("/clubs/{club_id}", dependencies=[Depends(require_admin)])
def update_club(club_id: int, data: ClubUpdate, db: Session = Depends(get_db)):
    club = db.query(Club).get(club_id)
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

    club = db.query(Club).get(club_id)
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
    link = SecretLink(token=token, club_id=club.clubid,
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
    is_organizer = org_cfg and str(club.clubid) == str(org_cfg)

    org_email = ""
    org_club_name = ""
    if not is_organizer and org_cfg:
        org_club = db.query(Club).get(int(org_cfg))
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
    clubs = (db.query(Club)
             .filter(Club.email != None, Club.email != '')
             .order_by(Club.name).all())
    return [{"id": c.clubid, "name": c.name} for c in clubs]


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

    club = db.query(Club).get(club_id)
    if not club or not club.email:
        raise HTTPException(404, "Club not found")

    if email != (club.email or "").strip().lower():
        org_cfg = _get_config(db, "organizer_club_id")
        org_email = ""
        if org_cfg:
            org_club = db.query(Club).get(int(org_cfg))
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

    club = db.query(Club).get(link.club_id)
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
    q = db.query(Athlete).options(joinedload(Athlete.club))
    if club_id:
        q = q.filter(Athlete.clubid == club_id)
    athletes = q.order_by(Athlete.lastname, Athlete.firstname).all()
    return [{
        "id": a.athleteid, "first_name": a.firstname, "last_name": a.lastname,
        "gender": gender_to_str(a.gender),
        "birthdate": str(a.birthdate.date()) if a.birthdate else None,
        "license": a.license, "club": a.club.name,
        "club_id": a.clubid,
    } for a in athletes]


@router.post("/athletes")
def create_athlete(data: AthleteCreate, request: Request, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)
    caller_club = _caller_club_id(db, pin)
    if caller_club is not None and data.club_id != caller_club:
        raise HTTPException(403, "Cannot create athletes in another club")
    from datetime import date as d
    ath = Athlete(
        firstname=data.first_name,
        lastname=data.last_name,
        gender=gender_from_str(data.gender),
        birthdate=d.fromisoformat(data.birthdate) if data.birthdate else None,
        license=data.license,
        clubid=data.club_id,
    )
    db.add(ath)
    db.commit()
    return {"id": ath.athleteid}


@router.delete("/athletes/{athlete_id}")
def delete_athlete(athlete_id: int, request: Request, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)
    athlete = db.query(Athlete).get(athlete_id)
    if not athlete:
        raise HTTPException(404)
    caller_club = _caller_club_id(db, pin)
    if caller_club is not None and athlete.clubid != caller_club:
        raise HTTPException(403, "Cannot delete athletes from another club")
    db.query(SwimResult).filter(SwimResult.athleteid == athlete_id).delete()
    delete_best_times(db, athlete_id)
    db.delete(athlete)
    db.commit()
    return {"deleted": True}


@router.put("/athletes/{athlete_id}")
def update_athlete(athlete_id: int, data: AthleteUpdate, request: Request, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)
    athlete = db.query(Athlete).get(athlete_id)
    if not athlete:
        raise HTTPException(404)
    caller_club = _caller_club_id(db, pin)
    if caller_club is not None and athlete.clubid != caller_club:
        raise HTTPException(403, "Cannot modify athletes from another club")
    if data.first_name is not None:
        athlete.firstname = data.first_name
    if data.last_name is not None:
        athlete.lastname = data.last_name
    if data.gender is not None:
        athlete.gender = gender_from_str(data.gender)
    if data.birthdate is not None:
        from datetime import date as d
        athlete.birthdate = d.fromisoformat(data.birthdate) if data.birthdate else None
    if data.license is not None:
        athlete.license = data.license
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


# ---------------------------------------------------------------------------
# Registration detail (athlete entry page)
# ---------------------------------------------------------------------------

@router.get("/athletes/{athlete_id}/registration")
def get_registration(athlete_id: int, db: Session = Depends(get_db)):
    athlete = db.query(Athlete).options(joinedload(Athlete.club)).get(athlete_id)
    if not athlete:
        raise HTTPException(404, "Athlete not found")

    # Get all registrations for this athlete
    regs = db.query(SwimResult).filter(
        SwimResult.athleteid == athlete_id,
    ).all()
    reg_map = {(r.swimeventid, r.age_code): r for r in regs}

    # Get best times and handle expiry
    expired = expire_old_best_times(db, athlete_id, _BEST_TIME_MAX_AGE_MONTHS)
    if expired:
        db.commit()

    bt_data = get_best_times(db, athlete_id)
    best_map_lcm: dict[int, int] = {}
    best_map_scm: dict[int, int] = {}
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

    ath_gender_int = athlete.gender

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
        if relay_count == 1 and ev.gender != 0 and ev.gender != ath_gender_int:
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
            db.query(Athlete, SwimEvent)
            .join(SwimResult, SwimResult.athleteid == Athlete.athleteid)
            .join(SwimEvent, SwimResult.swimeventid == SwimEvent.swimeventid)
            .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
            .filter(
                Athlete.clubid == athlete.clubid,
                Athlete.athleteid != athlete_id,
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
    club_athletes = db.query(Athlete).filter(
        Athlete.clubid == athlete.clubid,
        Athlete.athleteid != athlete_id,
    ).order_by(Athlete.lastname).all()

    # Suggested age_code
    suggested_age_code = "Open"
    if athlete.birthdate:
        from datetime import date as d
        age_base_val = _get_config(db, "age_base_date")
        age_base = d.fromisoformat(age_base_val) if age_base_val else d(d.today().year, 12, 31)
        age = age_base.year - athlete.birthdate.year
        if age <= 10:
            suggested_age_code = "10-"
        elif 11 <= age <= 12:
            suggested_age_code = "11-12"
        elif 13 <= age <= 14:
            suggested_age_code = "13-14"
        elif 15 <= age <= 18:
            suggested_age_code = "15-18"

    meet_course = _get_config(db, "meet_course") or "LCM"
    closure = _get_config(db, "closure_date")

    return {
        "athlete": {
            "id": athlete.athleteid, "first_name": athlete.firstname,
            "last_name": athlete.lastname, "gender": gender_to_str(athlete.gender),
            "birthdate": str(athlete.birthdate.date()) if athlete.birthdate else "",
            "license": athlete.license or "",
            "club": athlete.club.name, "club_id": athlete.clubid,
        },
        "suggested_age_code": suggested_age_code,
        "meet_course": meet_course,
        "closure_date": closure,
        "individual_events": individual_events,
        "relay_events": relay_events,
        "club_athletes": [{"id": a.athleteid, "name": f"{a.lastname}, {a.firstname}"}
                          for a in club_athletes],
    }


# ---------------------------------------------------------------------------
# Registrations (CRUD)
# ---------------------------------------------------------------------------

def _update_exception(db: Session, athlete_id: int):
    """Set exception='X' if athlete has any Masters registration."""
    has_masters = db.query(SwimResult).filter(
        SwimResult.athleteid == athlete_id,
        SwimResult.age_code == "Masters",
    ).first() is not None
    athlete = db.query(Athlete).get(athlete_id)
    if athlete:
        athlete.exception = "X" if has_masters else None


@router.post("/registrations")
def create_registration(data: RegistrationCreate, request: Request, db: Session = Depends(get_db)):
    pin = request.headers.get("X-Club-Pin", "")
    _check_closure(db, pin)
    athlete_id = data.athlete_id
    event_id = data.event_id
    age_code = data.age_code
    entry_time_ms = data.entry_time_ms

    caller_club = _caller_club_id(db, pin)
    athlete = db.query(Athlete).get(athlete_id)
    if not athlete:
        raise HTTPException(404, "Athlete not found")
    if caller_club is not None and athlete.clubid != caller_club:
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
        club_athlete_ids = [a.athleteid for a in db.query(Athlete).filter(Athlete.clubid == athlete.clubid).all()]
        existing_relay = db.query(SwimResult).filter(
            SwimResult.swimeventid == event_id,
            SwimResult.athleteid.in_(club_athlete_ids),
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
        athlete = db.query(Athlete).get(reg.athleteid)
        if not athlete or athlete.clubid != caller_club:
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
            club = db.query(Club).filter(Club.code == cd["code"]).first()
        else:
            club = db.query(Club).filter(Club.name == cd["name"]).first()
        if not club:
            clubs_new += 1
            athletes_new += len(cd["athletes"])
        else:
            for ad in cd["athletes"]:
                existing = db.query(Athlete).filter(
                    Athlete.firstname == ad["first_name"],
                    Athlete.lastname == ad["last_name"],
                    Athlete.clubid == club.clubid,
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
    times_result = load_best_times(db, content, source=file.filename or "upload")
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
    times_result = load_best_times(db, content, source=file.filename or "upload")
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
        "clubs": db.query(Club).count(),
        "athletes": db.query(Athlete).count(),
        "events": db.query(SwimEvent).count(),
        "registrations": db.query(SwimResult).count(),
        "best_times": bt_count,
    }


@router.delete("/registrations", dependencies=[Depends(require_admin)])
def flush_meet(db: Session = Depends(get_db)):
    """Flush meet: delete registrations, events, meet config."""
    reg_count = db.query(SwimResult).delete()
    db.query(AgeGroup).delete()
    db.query(SwimEvent).delete()
    db.query(SwimSession).delete()
    db.query(SwimStyle).delete()
    for key in ("meet_filename", "meet_uploaded_at", "meet_name", "meet_course",
                "meet_masters", "meet_currency", "meet_fees_json", "closure_date",
                "organizer_club_id"):
        cfg = db.query(BsGlobal).get(key)
        if cfg:
            db.delete(cfg)
    db.query(Club).update({Club.invite_send_count: 0, Club.stripe_send_count: 0})
    db.commit()
    return {"deleted": reg_count}


@router.post("/clubs/regenerate-pins", dependencies=[Depends(require_admin)])
def regenerate_pins(db: Session = Depends(get_db)):
    clubs = db.query(Club).all()
    for club in clubs:
        club.pin = ''.join(secrets.choice(string.digits) for _ in range(6))
    db.commit()
    return {"regenerated": len(clubs)}


@router.post("/organizer/clubs/invite-all", dependencies=[Depends(require_organizer_or_admin)])
def invite_all_clubs(data: dict, request: Request, db: Session = Depends(get_db)):
    lang = data.get("lang", "fr")
    clubs = db.query(Club).filter(Club.email != None, Club.email != "").all()
    sent = 0
    errors = []
    for club in clubs:
        try:
            send_pin(club.clubid, {"lang": lang}, db)
            sent += 1
        except Exception as e:
            errors.append({"club": club.name, "error": str(e)})
    return {"sent": sent, "errors": errors}


@router.get("/admin/organizer", dependencies=[Depends(require_admin)])
def get_organizer(db: Session = Depends(get_db)):
    cfg = _get_config(db, "organizer_club_id")
    if not cfg:
        return {"club_id": None, "club_name": None}
    club = db.query(Club).get(int(cfg))
    if not club:
        return {"club_id": None, "club_name": None}
    return {"club_id": club.clubid, "club_name": club.name}


@router.post("/admin/set-organizer", dependencies=[Depends(require_admin)])
def set_organizer(data: dict, db: Session = Depends(get_db)):
    club_id = data.get("club_id")
    if club_id is None:
        raise HTTPException(400, "club_id required")
    if not db.query(Club).get(club_id):
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
    club = db.query(Club).get(int(org_cfg))
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
    club = db.query(Club).get(int(org_cfg))
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
    club = db.query(Club).get(int(org_cfg))
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
    club = db.query(Club).get(club_id)
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
            club = db.query(Club).get(cid)
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
    club = db.query(Club).get(club_id)
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
    org_club = db.query(Club).get(int(org_cfg))
    if not org_club or not org_club.stripe_account_id:
        raise HTTPException(400, "Organizer has no connected Stripe account")

    club = db.query(Club).get(club_id)
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
            metadata={"meetmanager_club_id": str(club.clubid)},
            stripe_account=acct,
        )

    invoice = stripe.Invoice.create(
        customer=customer.id,
        auto_advance=False,
        currency="cad",
        collection_method="send_invoice",
        days_until_due=30,
        description=f"{meet_name} — Inscriptions",
        metadata={"meetmanager_club_id": str(club.clubid), "meetmanager_meet": meet_name},
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


@router.get("/export/meet-smb", dependencies=[Depends(require_organizer_or_admin)])
def export_meet_smb():
    if not MEET_TEMPLATE.exists():
        raise HTTPException(404, "Meet template not found")
    return Response(
        content=MEET_TEMPLATE.read_bytes(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": "attachment; filename=meet.smb"},
    )


# ---------------------------------------------------------------------------
# Data management
# ---------------------------------------------------------------------------

@router.get("/data-management/styles", dependencies=[Depends(require_admin)])
def get_styles(db: Session = Depends(get_db)):
    """List all unique style_uids present in best_times with display names."""
    import json as _json
    cfg = db.query(BsGlobal).get("style_names_json")
    imported_names: dict[int, str] = {int(k): v for k, v in _json.loads(cfg.data).items()} if cfg and cfg.data else {}

    # Collect all style_uids from bsglobal bt_* entries
    bt_entries = db.query(BsGlobal).filter(BsGlobal.name.like("bt_%")).all()
    all_uids: set[int] = set()
    for entry in bt_entries:
        try:
            data = _json.loads(entry.data)
            for uid_key in data:
                all_uids.add(int(uid_key))
        except (ValueError, TypeError):
            pass

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
        from_club = db.query(Club).filter(Club.clubid == from_id).first()
        to_club = db.query(Club).filter(Club.clubid == to_id).first()
        if not from_club or not to_club:
            continue

        for ath in list(from_club.athletes):
            existing = db.query(Athlete).filter(
                Athlete.firstname == ath.firstname,
                Athlete.lastname == ath.lastname,
                Athlete.clubid == to_id,
            ).first()
            if not existing:
                ath.clubid = to_id
            else:
                # Merge best times: load both athletes' bt data
                from_bt = get_best_times(db, ath.athleteid)
                to_bt = get_best_times(db, existing.athleteid)
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
                _save_best_times(db, existing.athleteid, to_bt)
                delete_best_times(db, ath.athleteid)
                # Delete registrations for the duplicate athlete
                db.query(SwimResult).filter(SwimResult.athleteid == ath.athleteid).delete()
                db.flush()
                db.delete(ath)

        db.flush()
        db.expire(from_club)
        db.delete(from_club)
        merged += 1

    db.commit()
    return {"merged": merged}


@router.post("/data-management/merge-styles", dependencies=[Depends(require_admin)])
def merge_styles(data: dict, db: Session = Depends(get_db)):
    """Remap best_time entries from one style_uid to another, keeping the faster time."""
    import json as _json
    merges = data.get("merges", [])
    merged_rows = 0
    for m in merges:
        from_uid = int(m["from_uid"])
        to_uid = int(m["to_uid"])
        if from_uid == to_uid:
            continue
        from_key = str(from_uid)
        to_key = str(to_uid)
        # Iterate all bt_* entries in bsglobal
        bt_entries = db.query(BsGlobal).filter(BsGlobal.name.like("bt_%")).all()
        for entry in bt_entries:
            try:
                bt_data = _json.loads(entry.data)
            except (ValueError, TypeError):
                continue
            if from_key not in bt_data:
                continue
            from_style = bt_data.pop(from_key)
            if to_key not in bt_data:
                bt_data[to_key] = from_style
                merged_rows += sum(1 for _ in from_style)
            else:
                for course, val in from_style.items():
                    if course not in bt_data[to_key]:
                        bt_data[to_key][course] = val
                        merged_rows += 1
                    elif val["time_ms"] < bt_data[to_key][course]["time_ms"]:
                        bt_data[to_key][course] = val
                        merged_rows += 1
                    else:
                        merged_rows += 1
            entry.data = _json.dumps(bt_data)

    db.commit()
    return {"merged_rows": merged_rows}


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
    athletes_db = db.query(Athlete).options(
        joinedload(Athlete.club)
    ).filter(Athlete.athleteid.in_(athlete_ids)).all() if athlete_ids else []
    athlete_map = {a.athleteid: a for a in athletes_db}

    # Group by club then athlete
    clubs_map: dict[int, dict] = {}
    for athlete_id, bt_data in athlete_bt.items():
        a = athlete_map.get(athlete_id)
        if not a or not a.club:
            continue
        c = a.club
        if c.clubid not in clubs_map:
            clubs_map[c.clubid] = {"name": c.name, "athletes": {}}
        if a.athleteid not in clubs_map[c.clubid]["athletes"]:
            clubs_map[c.clubid]["athletes"][a.athleteid] = {
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
