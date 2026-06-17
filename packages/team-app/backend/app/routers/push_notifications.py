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

"""Web Push notifications for coach DSQ alerts.

Coaches enter their team PIN on the live results page to subscribe.
When a DSQ is pushed for one of their athletes, they receive a mobile
notification even if the browser is in the background.
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import BsGlobal
from ..models_live import PushSubscription
from ..models_team import TeamClub

router = APIRouter(prefix="/api/live")
_log = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_config(db: Session, key: str) -> str | None:
    cfg = db.query(BsGlobal).get(key)
    return cfg.data if cfg else None


def _set_config(db: Session, key: str, value: str):
    cfg = db.query(BsGlobal).get(key)
    if cfg:
        cfg.data = value
    else:
        db.add(BsGlobal(name=key, data=value))


def _get_or_create_vapid_keys(db: Session) -> tuple[str, str]:
    """Return (public_key, private_key) as URL-safe base64. Generate if not yet stored."""
    pub = _get_config(db, "VAPID_PUBLIC_KEY")
    priv = _get_config(db, "VAPID_PRIVATE_KEY")
    if pub and priv:
        return pub, priv

    # Generate new ECDH P-256 key pair for VAPID
    import base64
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization

    private_key = ec.generate_private_key(ec.SECP256R1())

    # Public key: uncompressed point (65 bytes)
    raw_pub = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    # Private key: raw 32-byte scalar
    raw_priv = private_key.private_numbers().private_value.to_bytes(32, 'big')

    pub_key = base64.urlsafe_b64encode(raw_pub).rstrip(b'=').decode()
    priv_key = base64.urlsafe_b64encode(raw_priv).rstrip(b'=').decode()

    _set_config(db, "VAPID_PUBLIC_KEY", pub_key)
    _set_config(db, "VAPID_PRIVATE_KEY", priv_key)
    db.commit()
    return pub_key, priv_key


# ── Request models ────────────────────────────────────────────────────────────

class SubscribeRequest(BaseModel):
    pin: str
    subscription: dict  # PushSubscription JSON from browser


class UnsubscribeRequest(BaseModel):
    endpoint: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/vapid-public-key")
def get_vapid_public_key(db: Session = Depends(get_db)):
    """Return the VAPID public key for the frontend to use when subscribing."""
    pub, _ = _get_or_create_vapid_keys(db)
    return {"public_key": pub}


@router.post("/subscribe")
def subscribe_push(body: SubscribeRequest, db: Session = Depends(get_db)):
    """Validate team PIN and store push subscription for DSQ notifications."""
    from .api import _resolve_role

    role, club_id = _resolve_role(body.pin, db)
    if role == "none" or club_id is None:
        # Admin/organizer without a club can't subscribe to team notifications
        if role in ("admin", "organizer"):
            raise HTTPException(400, "Use a team PIN to subscribe to notifications")
        raise HTTPException(401, "Invalid PIN")

    # Extract subscription fields
    sub = body.subscription
    endpoint = sub.get("endpoint")
    keys = sub.get("keys", {})
    p256dh = keys.get("p256dh")
    auth = keys.get("auth")

    if not endpoint or not p256dh or not auth:
        raise HTTPException(400, "Invalid subscription object")

    # Upsert — same endpoint might re-subscribe (e.g., page reload)
    existing = db.query(PushSubscription).filter(
        PushSubscription.endpoint == endpoint
    ).first()
    if existing:
        existing.club_id = club_id
        existing.p256dh = p256dh
        existing.auth = auth
    else:
        db.add(PushSubscription(
            club_id=club_id,
            endpoint=endpoint,
            p256dh=p256dh,
            auth=auth,
        ))

    db.commit()

    club = db.query(TeamClub).get(club_id)
    club_name = club.name if club else "?"
    return {"ok": True, "club_name": club_name}


@router.post("/unsubscribe")
def unsubscribe_push(body: UnsubscribeRequest, db: Session = Depends(get_db)):
    """Remove a push subscription."""
    db.query(PushSubscription).filter(
        PushSubscription.endpoint == body.endpoint
    ).delete()
    db.commit()
    return {"ok": True}


# ── Notification dispatch (called from push_results) ──────────────────────────

def send_dsq_notifications(db: Session, dsq_results: list[dict]):
    """Send push notifications for DSQ results to subscribed coaches.

    Args:
        dsq_results: list of dicts with keys: athlete_name, club_name, dsq_reason,
                     event_name (optional)
    """
    if not dsq_results:
        return

    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        _log.warning("pywebpush not installed — skipping push notifications")
        return

    _, priv_key = _get_or_create_vapid_keys(db)
    pub_key = _get_config(db, "VAPID_PUBLIC_KEY")

    # Group DSQs by club_name → find matching club_ids
    club_names = {r["club_name"] for r in dsq_results if r.get("club_name")}
    if not club_names:
        return

    # Find club_ids for these club names
    clubs = db.query(TeamClub).filter(TeamClub.name.in_(club_names)).all()
    name_to_id: dict[str, int] = {c.name: c.clubsid for c in clubs}

    # Find subscriptions for affected clubs
    affected_club_ids = set(name_to_id.values())
    if not affected_club_ids:
        return

    subscriptions = db.query(PushSubscription).filter(
        PushSubscription.club_id.in_(affected_club_ids)
    ).all()

    if not subscriptions:
        return

    # Build notification payloads per club
    club_id_to_dsqs: dict[int, list[dict]] = {}
    for r in dsq_results:
        cid = name_to_id.get(r.get("club_name", ""))
        if cid:
            club_id_to_dsqs.setdefault(cid, []).append(r)

    # Enrich DSQs with event name + heat from live_events table
    from ..models_live import LiveEvent
    event_cache: dict[int, LiveEvent] = {}
    for d in dsq_results:
        eid = d.get("event_id")
        if eid and eid not in event_cache:
            ev = db.query(LiveEvent).get(eid)
            if ev:
                event_cache[eid] = ev

    # Send notifications
    dead_endpoints: list[int] = []
    vapid_claims = {"sub": "mailto:noreply@sauvetagesportif.app"}

    for sub in subscriptions:
        dsqs = club_id_to_dsqs.get(sub.club_id, [])
        if not dsqs:
            continue

        # Build message
        d = dsqs[0]
        ev = event_cache.get(d.get("event_id")) if d.get("event_id") else None
        event_label = f"Épr. {ev.event_number} — {ev.event_name}" if ev else ""
        heat_label = f"Série {d['heat_number']}" if d.get("heat_number") else ""

        if len(dsqs) == 1:
            title = f"DSQ · {event_label}" if event_label else "DSQ"
            body = d["athlete_name"]
            if heat_label:
                body += f" · {heat_label}"
            if d.get("dsq_reason"):
                body += f"\n{d['dsq_reason']}"
        else:
            title = f"DSQ ({len(dsqs)})" + (f" · {event_label}" if event_label else "")
            body = "\n".join(
                f"{r['athlete_name']}" + (f" · Série {r['heat_number']}" if r.get("heat_number") else "")
                for r in dsqs[:3]
            )
            if len(dsqs) > 3:
                body += f"\n+{len(dsqs) - 3} autres"

        event_id = d.get("event_id")
        deep_url = f"/results?event={event_id}" if event_id else "/results"

        payload = json.dumps({
            "title": title,
            "body": body,
            "tag": "dsq",  # collapse multiple DSQ notifications
            "data": {"url": deep_url},
        })

        subscription_info = {
            "endpoint": sub.endpoint,
            "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
        }

        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=priv_key,
                vapid_claims=vapid_claims,
            )
        except Exception as e:
            err_str = str(e)
            # 404 or 410 = subscription expired/invalid
            if "404" in err_str or "410" in err_str:
                dead_endpoints.append(sub.id)
            else:
                _log.warning(f"Push notification failed for {sub.endpoint[:50]}…: {e}")

    # Clean up dead subscriptions
    if dead_endpoints:
        db.query(PushSubscription).filter(
            PushSubscription.id.in_(dead_endpoints)
        ).delete(synchronize_session=False)
        db.commit()


def send_announcement_notifications(
    db: Session,
    ann_type: str,
    event_number: int | None,
    event_name: str,
    gender: str,
):
    """Send push notifications for meet announcements to ALL subscribed coaches.

    Unlike DSQ notifications (club-specific), announcements go to everyone.
    """
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        _log.warning("pywebpush not installed — skipping announcement notifications")
        return

    _, priv_key = _get_or_create_vapid_keys(db)

    subscriptions = db.query(PushSubscription).all()
    if not subscriptions:
        return

    # Build notification message
    if ann_type == "call_to_marshall":
        title = "📢 Appel au maréchal"
        body = f"Épr. {event_number} — {event_name}"
        tag = f"marshall-{event_number}"
    elif ann_type == "call_to_scratch":
        title = "✂️ Appel aux scratches"
        body = f"Épr. {event_number} — {event_name} (Finale)"
        tag = f"scratch-{event_number}"
    else:
        return

    if gender:
        gender_label = {"M": "♂", "F": "♀", "X": ""}.get(gender, "")
        if gender_label:
            body += f" {gender_label}"

    payload = json.dumps({
        "title": title,
        "body": body,
        "tag": tag,
        "data": {"url": "/results"},
    })

    vapid_claims = {"sub": "mailto:noreply@sauvetagesportif.app"}
    dead_endpoints: list[int] = []

    for sub in subscriptions:
        subscription_info = {
            "endpoint": sub.endpoint,
            "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=priv_key,
                vapid_claims=vapid_claims,
            )
        except Exception as e:
            err_str = str(e)
            if "404" in err_str or "410" in err_str:
                dead_endpoints.append(sub.id)
            else:
                _log.warning(f"Announcement push failed for {sub.endpoint[:50]}…: {e}")

    if dead_endpoints:
        db.query(PushSubscription).filter(
            PushSubscription.id.in_(dead_endpoints)
        ).delete(synchronize_session=False)
        db.commit()