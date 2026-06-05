"""SERC (Simulated Emergency Response Competition) API endpoints.

Teams are pulled from relay entries for the SERC event (swimstyle 530).
"""
from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models_serc import SercConfig, SercDrawOrder, SercScore
from ..models_team import Relay, RelayPos, Member, TeamClub
from ..models import SwimStyle

router = APIRouter(prefix="/api/serc")

# SERC swimstyle ID (configured in template_pool.lxf)
SERC_STYLE_ID = 530


# ── Config ────────────────────────────────────────────────────────────────────

@router.get("/config")
def get_config(db: Session = Depends(get_db)):
    """Get the current SERC configuration."""
    config = db.query(SercConfig).order_by(SercConfig.id.desc()).first()
    if not config:
        return None
    return _config_to_dict(config)


@router.post("/config")
def upsert_config(data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Create or update SERC configuration."""
    config = db.query(SercConfig).order_by(SercConfig.id.desc()).first()
    if not config:
        config = SercConfig(created_at=datetime.utcnow().isoformat())
        db.add(config)
        db.flush()

    if "num_victims" in data:
        config.num_victims = max(1, min(16, int(data["num_victims"])))
    if "num_draws" in data:
        config.num_draws = max(1, min(6, int(data["num_draws"])))
    if "has_bystander" in data:
        config.has_bystander = 1 if data["has_bystander"] else 0
    if "overall_factors" in data:
        config.overall_factors_json = json.dumps(data["overall_factors"])
    if "bystander_factors" in data:
        config.bystander_factors_json = json.dumps(data["bystander_factors"])
    if "victim_factors" in data:
        config.victim_factors_json = json.dumps(data["victim_factors"])

    db.commit()
    return _config_to_dict(config)


# ── Teams (from relay entries) ────────────────────────────────────────────────

@router.get("/teams")
def list_teams(db: Session = Depends(get_db)):
    """List SERC relay teams (from relays table with SERC swimstyle)."""
    # Find relay teams for the SERC swimstyle
    relays = db.query(Relay).filter(Relay.stylesid == SERC_STYLE_ID).order_by(Relay.teamnumb).all()

    teams = []
    for relay in relays:
        # Get team members
        positions = db.query(RelayPos).filter(RelayPos.relaysid == relay.relaysid).order_by(RelayPos.numb).all()
        members = []
        for pos in positions:
            if pos.membersid:
                member = db.query(Member).get(pos.membersid)
                if member:
                    members.append(f"{member.lastname}, {member.firstname}")
                else:
                    members.append("")
            else:
                members.append("")

        # Get club name
        club_name = ""
        if relay.clubsid:
            club = db.query(TeamClub).get(relay.clubsid)
            if club:
                club_name = club.name or club.code or ""

        # Build team name (from relay custom name or generated)
        team_name = ""
        if members:
            team_name = "/".join(m.split(",")[0].strip() for m in members if m)

        teams.append({
            "relay_team_id": relay.relaysid,
            "team_number": chr(64 + (relay.teamnumb or 1)),  # A, B, C...
            "name": team_name,
            "club": club_name,
            "members": members,
        })

    return teams


# ── Draw Order ────────────────────────────────────────────────────────────────

@router.get("/draw-order/{draw_number}")
def get_draw_order(draw_number: int, db: Session = Depends(get_db)):
    """Get team order for a specific draw."""
    config = _get_config(db)
    if not config:
        return []
    orders = (
        db.query(SercDrawOrder)
        .filter(SercDrawOrder.config_id == config.id, SercDrawOrder.draw_number == draw_number)
        .order_by(SercDrawOrder.position)
        .all()
    )
    return [{"position": o.position, "relay_team_id": o.relay_team_id} for o in orders]


@router.put("/draw-order/{draw_number}")
def set_draw_order(draw_number: int, data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Set draw order. Accepts {team_ids: [relay_team_id1, ...]}."""
    config = _get_or_create_config(db)
    team_ids = data.get("team_ids", [])

    db.query(SercDrawOrder).filter(
        SercDrawOrder.config_id == config.id,
        SercDrawOrder.draw_number == draw_number,
    ).delete()

    for pos, tid in enumerate(team_ids, start=1):
        db.add(SercDrawOrder(config_id=config.id, draw_number=draw_number, position=pos, relay_team_id=tid))
    db.commit()
    return {"ok": True, "count": len(team_ids)}


@router.post("/draw-order/{draw_number}/randomize")
def randomize_draw_order(draw_number: int, db: Session = Depends(get_db)):
    """Randomize draw order using all SERC relay teams."""
    import random
    config = _get_or_create_config(db)

    relays = db.query(Relay).filter(Relay.stylesid == SERC_STYLE_ID).all()
    team_ids = [r.relaysid for r in relays]
    random.shuffle(team_ids)

    db.query(SercDrawOrder).filter(
        SercDrawOrder.config_id == config.id,
        SercDrawOrder.draw_number == draw_number,
    ).delete()

    for pos, tid in enumerate(team_ids, start=1):
        db.add(SercDrawOrder(config_id=config.id, draw_number=draw_number, position=pos, relay_team_id=tid))
    db.commit()
    return {"ok": True, "order": team_ids}


# ── Scores ────────────────────────────────────────────────────────────────────

@router.put("/score")
def set_score(data: dict = Body(default={}), db: Session = Depends(get_db)):
    """Set a single score. Accepts {draw, relay_team_id, section, field, value}."""
    config = _get_or_create_config(db)
    draw = int(data["draw"])
    relay_team_id = int(data["relay_team_id"])
    section = data["section"]
    field = data["field"]
    value = data.get("value")

    if value is not None and value != "":
        value = float(value)
    else:
        value = None

    # Rough handling can only be 0 or -10
    if field == "rough" and value is not None and value not in (0, -10, 0.0, -10.0):
        raise HTTPException(status_code=422, detail="Rough handling must be 0 or -10")

    existing = db.query(SercScore).filter(
        SercScore.config_id == config.id,
        SercScore.draw_number == draw,
        SercScore.relay_team_id == relay_team_id,
        SercScore.section == section,
        SercScore.field == field,
    ).first()

    if value is None:
        if existing:
            db.delete(existing)
    elif existing:
        existing.value = value
    else:
        db.add(SercScore(
            config_id=config.id,
            draw_number=draw,
            relay_team_id=relay_team_id,
            section=section,
            field=field,
            value=value,
        ))
    db.commit()
    return {"ok": True}


@router.get("/scores/{draw_number}")
def get_scores_for_draw(draw_number: int, db: Session = Depends(get_db)):
    """Get all scores for a draw, grouped by relay_team_id."""
    config = _get_config(db)
    if not config:
        return {}
    scores = db.query(SercScore).filter(
        SercScore.config_id == config.id,
        SercScore.draw_number == draw_number,
    ).all()

    result: dict = {}
    for s in scores:
        tid = str(s.relay_team_id)
        if tid not in result:
            result[tid] = {}
        if s.section not in result[tid]:
            result[tid][s.section] = {}
        result[tid][s.section][s.field] = s.value
    return result


# ── Results ───────────────────────────────────────────────────────────────────

@router.get("/results")
def get_results(db: Session = Depends(get_db)):
    """Compute ranked results for all draws + overall."""
    config = _get_config(db)
    if not config:
        return {"draws": [], "overall": []}

    # Get teams
    relays = db.query(Relay).filter(Relay.stylesid == SERC_STYLE_ID).all()
    all_scores = db.query(SercScore).filter(SercScore.config_id == config.id).all()

    # Parse factors
    overall_factors = json.loads(config.overall_factors_json) if config.overall_factors_json else {}
    bystander_factors = json.loads(config.bystander_factors_json) if config.bystander_factors_json else {}
    victim_factors = json.loads(config.victim_factors_json) if config.victim_factors_json else []

    # Index scores
    score_map: dict[tuple, float] = {}
    for s in all_scores:
        score_map[(s.draw_number, s.relay_team_id, s.section, s.field)] = s.value

    # Team info
    team_info: dict[int, dict] = {}
    for relay in relays:
        club = db.query(TeamClub).get(relay.clubsid) if relay.clubsid else None
        positions = db.query(RelayPos).filter(RelayPos.relaysid == relay.relaysid).order_by(RelayPos.numb).all()
        members = []
        for pos in positions:
            if pos.membersid:
                m = db.query(Member).get(pos.membersid)
                if m:
                    members.append(f"{m.lastname}, {m.firstname}")
        team_info[relay.relaysid] = {
            "name": "/".join(m.split(",")[0].strip() for m in members) if members else f"Team {relay.teamnumb}",
            "club": club.name if club else "",
        }

    def calc_team_draw(team_id: int, draw: int) -> float:
        total = 0.0
        for field in ("assessment", "control", "communication", "search", "teamwork"):
            raw = score_map.get((draw, team_id, "overall", field), 0) or 0
            total += raw * overall_factors.get(field, 1)
        total += score_map.get((draw, team_id, "overall", "rough"), 0) or 0

        if config.has_bystander:
            for field in ("approach", "info", "directions", "monitoring", "encouragement"):
                raw = score_map.get((draw, team_id, "bystander", field), 0) or 0
                total += raw * bystander_factors.get(field, 1)
            total += score_map.get((draw, team_id, "bystander", "rough"), 0) or 0

        for vi in range(config.num_victims):
            vf = victim_factors[vi] if vi < len(victim_factors) else {}
            section = f"victim_{vi}"
            for field in ("approach", "rescue", "control", "landing", "care"):
                raw = score_map.get((draw, team_id, section, field), 0) or 0
                total += raw * vf.get(field, 1)
            total += score_map.get((draw, team_id, section, "rough"), 0) or 0

        return round(total, 2)

    # Per-draw results
    draw_results = []
    for d in range(1, config.num_draws + 1):
        entries = []
        for relay in relays:
            total = calc_team_draw(relay.relaysid, d)
            info = team_info.get(relay.relaysid, {})
            entries.append({"relay_team_id": relay.relaysid, "name": info.get("name", ""), "club": info.get("club", ""), "total": total})
        entries.sort(key=lambda x: x["total"], reverse=True)
        for i, e in enumerate(entries):
            e["rank"] = i + 1
        draw_results.append({"draw": d, "results": entries})

    # Overall
    overall = []
    for relay in relays:
        total = sum(calc_team_draw(relay.relaysid, d) for d in range(1, config.num_draws + 1))
        info = team_info.get(relay.relaysid, {})
        overall.append({"relay_team_id": relay.relaysid, "name": info.get("name", ""), "club": info.get("club", ""), "total": round(total, 2)})
    overall.sort(key=lambda x: x["total"], reverse=True)
    for i, e in enumerate(overall):
        e["rank"] = i + 1

    return {"draws": draw_results, "overall": overall}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_config(db: Session) -> SercConfig | None:
    return db.query(SercConfig).order_by(SercConfig.id.desc()).first()


def _get_or_create_config(db: Session) -> SercConfig:
    config = _get_config(db)
    if not config:
        config = SercConfig(
            num_victims=9,
            num_draws=4,
            has_bystander=1,
            overall_factors_json=json.dumps({"assessment": 1, "control": 1, "communication": 1.25, "search": 1.5, "teamwork": 1}),
            bystander_factors_json=json.dumps({"approach": 1, "info": 1, "directions": 1, "monitoring": 1, "encouragement": 1}),
            victim_factors_json=json.dumps([
                {"type": "Non Swimmer", "approach": 1.25, "rescue": 1.5, "control": 1, "landing": 1.25, "care": 1.25},
                {"type": "Non Swimmer", "approach": 1.25, "rescue": 1.25, "control": 1, "landing": 1.25, "care": 1.25},
                {"type": "Weak Swimmer", "approach": 1.25, "rescue": 1.25, "control": 1.25, "landing": 1.5, "care": 1},
                {"type": "Weak Swimmer", "approach": 1, "rescue": 1.5, "control": 1.25, "landing": 1.5, "care": 1},
                {"type": "Injured Swimmer", "approach": 1, "rescue": 1.25, "control": 1, "landing": 1.25, "care": 1.25},
                {"type": "Injured Swimmer", "approach": 1, "rescue": 1.5, "control": 1.5, "landing": 1.25, "care": 1.25},
                {"type": "Injured Swimmer", "approach": 1.5, "rescue": 1, "control": 1, "landing": 1.25, "care": 1.25},
                {"type": "Injured Swimmer", "approach": 1.25, "rescue": 1, "control": 1, "landing": 1.25, "care": 1.25},
                {"type": "Unconscious Non-Breathing", "approach": 1.5, "rescue": 1, "control": 1, "landing": 1, "care": 1.5},
            ]),
            created_at=datetime.utcnow().isoformat(),
        )
        db.add(config)
        db.commit()
    return config


def _config_to_dict(config: SercConfig) -> dict:
    return {
        "id": config.id,
        "num_victims": config.num_victims,
        "num_draws": config.num_draws,
        "has_bystander": bool(config.has_bystander),
        "overall_factors": json.loads(config.overall_factors_json) if config.overall_factors_json else {},
        "bystander_factors": json.loads(config.bystander_factors_json) if config.bystander_factors_json else {},
        "victim_factors": json.loads(config.victim_factors_json) if config.victim_factors_json else [],
    }
