"""Live results API — push endpoints (from meet-app) and public endpoints (spectators)."""
from __future__ import annotations

import os
import secrets
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from ..database import get_db, is_sqlite
from ..models import BsGlobal
from ..models_live import LiveEvent, LiveResult, LiveSplit, LiveStartlist


def _upsert(db: Session, model, conflict_columns: list[str], values: dict, update_values: dict):
    """Dialect-agnostic upsert: INSERT ... ON CONFLICT DO UPDATE.

    Works on both PostgreSQL and SQLite (3.24+).
    """
    if is_sqlite():
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert
        stmt = sqlite_insert(model).values(**values)
        stmt = stmt.on_conflict_do_update(
            index_elements=conflict_columns,
            set_=update_values,
        )
    else:
        from sqlalchemy.dialects.postgresql import insert as pg_insert
        stmt = pg_insert(model).values(**values)
        # Try constraint name first, fall back to index_elements
        constraint_name = getattr(model, '__table__', None)
        if any('uq_' in str(c.name) for c in model.__table__.constraints if hasattr(c, 'name') and c.name):
            # Find the unique constraint matching our conflict columns
            for c in model.__table__.constraints:
                if hasattr(c, 'columns') and set(col.name for col in c.columns) == set(conflict_columns):
                    stmt = stmt.on_conflict_do_update(constraint=c.name, set_=update_values)
                    break
            else:
                stmt = stmt.on_conflict_do_update(index_elements=conflict_columns, set_=update_values)
        else:
            stmt = stmt.on_conflict_do_update(index_elements=conflict_columns, set_=update_values)
    db.execute(stmt)

router = APIRouter(prefix="/api/live")


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


# ── Auth dependencies ─────────────────────────────────────────────────────────

def require_live_secret(request: Request, db: Session = Depends(get_db)):
    """Validate X-Live-Secret header and ensure live mode is active."""
    secret = request.headers.get("X-Live-Secret", "")
    cfg = db.query(BsGlobal).get("LIVE_PUSH_SECRET")
    if not cfg or not cfg.data or secret != cfg.data:
        raise HTTPException(401, "Invalid live secret")
    enabled = db.query(BsGlobal).get("LIVE_ENABLED")
    if not enabled or enabled.data != "T":
        raise HTTPException(409, "Live mode not active")


def _require_organizer_or_admin(request: Request, db: Session = Depends(get_db)):
    """Reuse the same PIN-based auth as the main API."""
    from .api import _resolve_role, _get_admin_pin
    pin = request.headers.get("X-Club-Pin", "")
    role, _ = _resolve_role(pin, db)
    if role not in ("admin", "organizer"):
        raise HTTPException(403, "Organizer or admin access required")


# ── WebSocket connection manager ──────────────────────────────────────────────

class ConnectionManager:
    def __init__(self, max_connections: int = 500):
        self.active: list[WebSocket] = []
        self.max_connections = max_connections

    async def connect(self, ws: WebSocket) -> bool:
        if len(self.active) >= self.max_connections:
            await ws.close(code=1013)  # Try Again Later
            return False
        await ws.accept()
        self.active.append(ws)
        return True

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, message: dict):
        dead: list[WebSocket] = []
        for ws in self.active:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            if ws in self.active:
                self.active.remove(ws)

    @property
    def count(self) -> int:
        return len(self.active)


manager = ConnectionManager(
    max_connections=int(os.environ.get("LIVE_WS_MAX", "500"))
)


# ── Push endpoints (meet-app → team-app) ─────────────────────────────────────

@router.post("/push-results", dependencies=[Depends(require_live_secret)])
async def push_results(data: dict, db: Session = Depends(get_db)):
    """Receive batched results from meet-app. Upserts into live_results."""
    results = data.get("results", [])
    if not results:
        raise HTTPException(400, "No results in payload")

    accepted = 0
    events_touched: set[int] = set()

    for r in results:
        event_id = r.get("event_id")
        heat_number = r.get("heat_number")
        lane = r.get("lane")
        if not all([event_id, heat_number is not None, lane is not None]):
            continue

        # Upsert live_result
        values = dict(
            event_id=event_id,
            heat_number=heat_number,
            lane=lane,
            athlete_id=r.get("athlete_id"),
            athlete_name=r.get("athlete_name"),
            club_name=r.get("club_name"),
            swimtime_ms=r.get("swimtime_ms"),
            reaction_time_ms=r.get("reaction_time_ms"),
            status=r.get("status", ""),
            dsq_reason=r.get("dsq_reason"),
            is_official=r.get("is_official", False),
            pushed_at=datetime.utcnow(),
        )
        update_vals = {
            "athlete_id": r.get("athlete_id"),
            "athlete_name": r.get("athlete_name"),
            "club_name": r.get("club_name"),
            "swimtime_ms": r.get("swimtime_ms"),
            "reaction_time_ms": r.get("reaction_time_ms"),
            "status": r.get("status", ""),
            "dsq_reason": r.get("dsq_reason"),
            "is_official": r.get("is_official", False),
            "pushed_at": datetime.utcnow(),
        }
        _upsert(db, LiveResult, ["event_id", "heat_number", "lane"], values, update_vals)

        # Handle splits
        splits = r.get("splits", [])
        if splits:
            # Get the live_result id for this upserted row
            row = db.query(LiveResult).filter(
                LiveResult.event_id == event_id,
                LiveResult.heat_number == heat_number,
                LiveResult.lane == lane,
            ).first()
            if row:
                # Delete old splits and insert new
                db.query(LiveSplit).filter(LiveSplit.live_result_id == row.id).delete()
                for s in splits:
                    db.add(LiveSplit(
                        live_result_id=row.id,
                        distance=s.get("distance"),
                        swimtime_ms=s.get("swimtime_ms"),
                    ))

        events_touched.add(event_id)
        accepted += 1

    # Update completed_heats count for touched events
    for eid in events_touched:
        completed = db.query(LiveResult.heat_number).filter(
            LiveResult.event_id == eid,
            LiveResult.swimtime_ms.isnot(None),
        ).distinct().count()
        ev = db.query(LiveEvent).get(eid)
        if ev:
            ev.completed_heats = completed

    # Update last push timestamp
    _set_config(db, "LIVE_LAST_PUSH", datetime.utcnow().isoformat())
    db.commit()

    # Send push notifications for DSQ results
    dsq_results = [
        r for r in results
        if r.get("status") == "DSQ"
    ]
    if dsq_results:
        from .push_notifications import send_dsq_notifications
        send_dsq_notifications(db, dsq_results)

    # Broadcast to spectators (include DSQ info for in-page alerts)
    broadcast_msg = {
        "type": "result",
        "events": list(events_touched),
        "count": accepted,
    }
    if dsq_results:
        broadcast_msg["dsq"] = [
            {
                "athlete_name": r.get("athlete_name", ""),
                "club_name": r.get("club_name", ""),
                "dsq_reason": r.get("dsq_reason", ""),
                "status": "DSQ",
            }
            for r in dsq_results
        ]
    await manager.broadcast(broadcast_msg)

    return {"accepted": accepted}


@router.post("/push-events", dependencies=[Depends(require_live_secret)])
async def push_events(data: dict, db: Session = Depends(get_db)):
    """Receive event metadata from meet-app. Upserts into live_events."""
    events = data.get("events", [])
    if not events:
        raise HTTPException(400, "No events in payload")

    accepted = 0
    for e in events:
        event_id = e.get("event_id")
        if not event_id:
            continue

        stmt_values = dict(
            event_id=event_id,
            session_number=e.get("session_number"),
            session_name=e.get("session_name"),
            event_number=e.get("event_number"),
            event_name=e.get("event_name", ""),
            gender=e.get("gender"),
            distance=e.get("distance"),
            round=e.get("round"),
            scheduled_time=e.get("scheduled_time"),
            total_heats=e.get("total_heats", 0),
        )
        stmt_update = {
            "session_number": e.get("session_number"),
            "session_name": e.get("session_name"),
            "event_number": e.get("event_number"),
            "event_name": e.get("event_name", ""),
            "gender": e.get("gender"),
            "distance": e.get("distance"),
            "round": e.get("round"),
            "scheduled_time": e.get("scheduled_time"),
            "total_heats": e.get("total_heats", 0),
        }
        _upsert(db, LiveEvent, ["event_id"], stmt_values, stmt_update)
        accepted += 1

    db.commit()

    await manager.broadcast({"type": "events_updated", "count": accepted})

    return {"accepted": accepted}


@router.post("/push-startlist", dependencies=[Depends(require_live_secret)])
async def push_startlist(data: dict, db: Session = Depends(get_db)):
    """Receive start list data from meet-app. Upserts into live_startlist."""
    entries = data.get("entries", [])
    if not entries:
        raise HTTPException(400, "No entries in payload")

    accepted = 0
    events_touched: set[int] = set()

    for e in entries:
        event_id = e.get("event_id")
        heat_number = e.get("heat_number")
        lane = e.get("lane")
        if not all([event_id, heat_number is not None, lane is not None]):
            continue

        sl_values = dict(
            event_id=event_id,
            heat_number=heat_number,
            lane=lane,
            athlete_id=e.get("athlete_id"),
            athlete_name=e.get("athlete_name"),
            club_name=e.get("club_name"),
            entry_time_ms=e.get("entry_time_ms"),
        )
        sl_update = {
            "athlete_id": e.get("athlete_id"),
            "athlete_name": e.get("athlete_name"),
            "club_name": e.get("club_name"),
            "entry_time_ms": e.get("entry_time_ms"),
        }
        _upsert(db, LiveStartlist, ["event_id", "heat_number", "lane"], sl_values, sl_update)
        events_touched.add(event_id)
        accepted += 1

    db.commit()

    # Broadcast to spectators
    await manager.broadcast({
        "type": "startlist",
        "events": list(events_touched),
        "count": accepted,
    })

    return {"accepted": accepted}


@router.post("/push-status", dependencies=[Depends(require_live_secret)])
async def push_status(data: dict, db: Session = Depends(get_db)):
    """Receive heat official status update from meet-app."""
    event_id = data.get("event_id")
    heat_number = data.get("heat_number")
    official = data.get("official", False)

    if not event_id or heat_number is None:
        raise HTTPException(400, "event_id and heat_number required")

    # Update all results in this heat
    db.query(LiveResult).filter(
        LiveResult.event_id == event_id,
        LiveResult.heat_number == heat_number,
    ).update({"is_official": official})

    # Update official_heats count
    ev = db.query(LiveEvent).get(event_id)
    if ev:
        official_count = db.query(LiveResult.heat_number).filter(
            LiveResult.event_id == event_id,
            LiveResult.is_official == True,  # noqa: E712
        ).distinct().count()
        ev.official_heats = official_count

    db.commit()

    # Broadcast to spectators
    await manager.broadcast({
        "type": "status",
        "event_id": event_id,
        "heat_number": heat_number,
        "official": official,
    })

    return {"ok": True}


@router.post("/push-announcement", dependencies=[Depends(require_live_secret)])
async def push_announcement(data: dict, db: Session = Depends(get_db)):
    """Receive a meet announcement (call to marshall, call to scratch) from meet-app.

    Broadcasts to all connected spectators via WebSocket and sends push
    notifications to all subscribed coaches.
    """
    ann_type = data.get("type")  # 'call_to_marshall' or 'call_to_scratch'
    event_name = data.get("event_name", "")
    event_number = data.get("event_number")
    gender = data.get("gender", "")

    if ann_type not in ("call_to_marshall", "call_to_scratch"):
        raise HTTPException(400, "Invalid announcement type")

    # Broadcast to spectators via WebSocket
    await manager.broadcast({
        "type": "announcement",
        "announcement_type": ann_type,
        "event_number": event_number,
        "event_name": event_name,
        "gender": gender,
    })

    # Send push notifications to ALL subscribed coaches
    from .push_notifications import send_announcement_notifications
    send_announcement_notifications(db, ann_type, event_number, event_name, gender)

    return {"ok": True}


# ── Public endpoints (spectators) ─────────────────────────────────────────────

@router.get("/status")
def live_status(db: Session = Depends(get_db)):
    """Is a live meet active? Returns meet name, event count."""
    enabled = _get_config(db, "LIVE_ENABLED")
    if enabled != "T":
        return {"active": False}

    meet_name = _get_config(db, "meet_name") or "Competition"
    event_count = db.query(LiveEvent).count()
    last_push = _get_config(db, "LIVE_LAST_PUSH")

    return {
        "active": True,
        "meet_name": meet_name,
        "event_count": event_count,
        "last_push": last_push,
        "spectators": manager.count,
    }


@router.get("/events")
def live_events(db: Session = Depends(get_db)):
    """All events with completion progress."""
    events = db.query(LiveEvent).order_by(
        LiveEvent.session_number, LiveEvent.event_number
    ).all()

    return [
        {
            "event_id": e.event_id,
            "session_number": e.session_number,
            "session_name": e.session_name,
            "event_number": e.event_number,
            "event_name": e.event_name,
            "gender": e.gender,
            "distance": e.distance,
            "round": e.round,
            "scheduled_time": e.scheduled_time,
            "total_heats": e.total_heats,
            "completed_heats": e.completed_heats,
            "official_heats": e.official_heats,
        }
        for e in events
    ]


@router.get("/results/{event_id}")
def live_results_for_event(event_id: int, db: Session = Depends(get_db)):
    """Results for an event, grouped by heat."""
    results = db.query(LiveResult).filter(
        LiveResult.event_id == event_id
    ).order_by(LiveResult.heat_number, LiveResult.lane).all()

    # Group by heat
    heats: dict[int, list] = {}
    for r in results:
        if r.heat_number not in heats:
            heats[r.heat_number] = []
        heats[r.heat_number].append({
            "lane": r.lane,
            "athlete_id": r.athlete_id,
            "athlete_name": r.athlete_name,
            "club_name": r.club_name,
            "swimtime_ms": r.swimtime_ms,
            "reaction_time_ms": r.reaction_time_ms,
            "status": r.status,
            "dsq_reason": r.dsq_reason,
            "is_official": r.is_official,
        })

    # Sort within each heat by swimtime (rank)
    for heat_num in heats:
        heats[heat_num].sort(key=lambda x: (
            x["swimtime_ms"] if x["swimtime_ms"] and not x["status"] else 9999999
        ))

    return {"event_id": event_id, "heats": heats}


@router.get("/startlist/{event_id}")
def live_startlist_for_event(event_id: int, db: Session = Depends(get_db)):
    """Start list for an event, grouped by heat."""
    entries = db.query(LiveStartlist).filter(
        LiveStartlist.event_id == event_id
    ).order_by(LiveStartlist.heat_number, LiveStartlist.lane).all()

    heats: dict[int, list] = {}
    for e in entries:
        if e.heat_number not in heats:
            heats[e.heat_number] = []
        heats[e.heat_number].append({
            "lane": e.lane,
            "athlete_id": e.athlete_id,
            "athlete_name": e.athlete_name,
            "club_name": e.club_name,
            "entry_time_ms": e.entry_time_ms,
        })

    return {"event_id": event_id, "heats": heats}


# ── Live mode management (organizer/admin) ────────────────────────────────────

@router.post("/enable", dependencies=[Depends(_require_organizer_or_admin)])
def enable_live_mode(db: Session = Depends(get_db)):
    """Enable live mode — generates a new push secret."""
    # Generate a strong random token
    token = secrets.token_hex(16)  # 32-char hex string
    _set_config(db, "LIVE_PUSH_SECRET", token)
    _set_config(db, "LIVE_ENABLED", "T")
    db.commit()
    return {"ok": True, "secret": token}


@router.post("/disable", dependencies=[Depends(_require_organizer_or_admin)])
def disable_live_mode(db: Session = Depends(get_db)):
    """Disable live mode — stops accepting push requests."""
    _set_config(db, "LIVE_ENABLED", "F")
    db.commit()
    return {"ok": True}


@router.get("/config", dependencies=[Depends(_require_organizer_or_admin)])
def live_config(db: Session = Depends(get_db)):
    """Get live mode configuration (for organizer page)."""
    enabled = _get_config(db, "LIVE_ENABLED") == "T"
    secret = _get_config(db, "LIVE_PUSH_SECRET") or ""
    last_push = _get_config(db, "LIVE_LAST_PUSH")

    # Mask secret for display (show first 4 + last 4 chars)
    masked = ""
    if secret:
        masked = secret[:4] + "…" + secret[-4:] if len(secret) > 8 else "****"

    return {
        "enabled": enabled,
        "secret_masked": masked,
        "last_push": last_push,
        "spectators": manager.count,
    }


# ── Finalization ──────────────────────────────────────────────────────────────

@router.post("/finalize", dependencies=[Depends(_require_organizer_or_admin)])
async def finalize_meet(db: Session = Depends(get_db)):
    """Promote live results → historical, trigger close-meet lifecycle.

    1. Create historical Meet row (meetstate=3)
    2. Convert live_results → Result rows (Team Manager schema)
    3. Recompute best times
    4. Call _reset_for_next_meet (existing function)
    5. Clear live-specific bsglobal keys
    6. Truncate live tables
    7. Broadcast meet_finalized via WebSocket
    """
    from ..models_team import Meet as TeamMeet, Result as TeamResult, Member
    from ..models import SwimStyle
    from sqlalchemy import func

    # Check there are live results to finalize
    result_count = db.query(LiveResult).filter(
        LiveResult.swimtime_ms.isnot(None),
        LiveResult.swimtime_ms > 0,
    ).count()
    if result_count == 0:
        raise HTTPException(400, "No live results to finalize")

    # 1. Create historical Meet row
    meet_name = _get_config(db, "meet_name") or "Competition"
    meet_city = _get_config(db, "meet_city") or ""
    course_str = _get_config(db, "meet_course") or "LCM"
    course_int = {"LCM": 1, "SCY": 2, "SCM": 3}.get(course_str, 1)

    next_meet_id = (db.query(func.max(TeamMeet.meetsid)).scalar() or 0) + 1
    new_meet = TeamMeet(
        meetsid=next_meet_id,
        name=meet_name,
        place=meet_city,
        course=course_int,
        meetstate=3,  # completed
    )
    db.add(new_meet)
    db.flush()

    # 2. Convert live_results → Result rows
    # Group by event to compute ranks
    live_events_list = db.query(LiveEvent).all()
    event_style_map: dict[int, int | None] = {}
    for le in live_events_list:
        # Try to find the swimstyleid from swimevent table
        from ..models import SwimEvent
        ev = db.query(SwimEvent).get(le.event_id)
        event_style_map[le.event_id] = ev.swimstyleid if ev else None

    results_archived = 0
    all_live_results = db.query(LiveResult).filter(
        LiveResult.swimtime_ms.isnot(None),
        LiveResult.swimtime_ms > 0,
    ).order_by(LiveResult.event_id, LiveResult.swimtime_ms).all()

    # Compute ranks per event
    current_event_id = None
    rank_counter = 0
    for lr in all_live_results:
        if lr.event_id != current_event_id:
            current_event_id = lr.event_id
            rank_counter = 0
        rank_counter += 1

        # Find the event number from live_events
        le = db.query(LiveEvent).get(lr.event_id)
        event_number = le.event_number if le else None

        db.add(TeamResult(
            membersid=lr.athlete_id,
            meetsid=next_meet_id,
            stylesid=event_style_map.get(lr.event_id),
            totaltime=lr.swimtime_ms,
            rank=rank_counter,
            eventnumb=event_number,
            course=course_int,
            resulttyp=0,  # official
        ))
        results_archived += 1

    db.flush()

    # 3. Recompute best times
    try:
        from ..best_times_v2 import recompute_all_best_times
        recompute_all_best_times(db)
    except ImportError:
        pass  # best_times_v2 may not exist yet — skip gracefully

    # 4. Call _reset_for_next_meet
    from .api import _reset_for_next_meet
    _reset_for_next_meet(db)

    # 5. Clear live-specific bsglobal keys
    for key in ("LIVE_PUSH_SECRET", "LIVE_ENABLED", "LIVE_LAST_PUSH"):
        cfg = db.query(BsGlobal).get(key)
        if cfg:
            db.delete(cfg)

    # 6. Truncate live tables
    db.query(LiveSplit).delete()
    db.query(LiveResult).delete()
    db.query(LiveStartlist).delete()
    db.query(LiveEvent).delete()
    # Clear push subscriptions (they're per-meet)
    from ..models_live import PushSubscription
    db.query(PushSubscription).delete()

    db.commit()

    # 7. Broadcast meet_finalized
    await manager.broadcast({"type": "meet_finalized"})

    return {"ok": True, "results_archived": results_archived, "meet_id": next_meet_id}


# ── WebSocket endpoint ────────────────────────────────────────────────────────

@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """WebSocket for spectators to receive real-time updates."""
    connected = await manager.connect(ws)
    if not connected:
        return
    try:
        while True:
            # Keep connection alive — client can send pings
            await ws.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(ws)
    except Exception:
        manager.disconnect(ws)
