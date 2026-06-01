"""Public results API — historical meets and best times."""
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


@router.get("/best-times")
def best_times_public(db: Session = Depends(get_db)):
    """Best times per athlete, grouped by club. Replaces /best-times-public."""
    from ..models import BsGlobal, SwimStyle
    from sqlalchemy.orm import joinedload
    import json as _json

    # Gather style names
    cfg = db.query(BsGlobal).get("style_names_json")
    imported_names: dict[int, str] = {int(k): v for k, v in _json.loads(cfg.data).items()} if cfg and cfg.data else {}

    # All best times from bsglobal bt_* entries
    bt_entries = db.query(BsGlobal).filter(BsGlobal.name.like("bt_%")).all()

    all_uids: set[int] = set()
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

    # Group by club
    clubs_map: dict[int, dict] = {}
    for athlete_id, bt_data in athlete_bt.items():
        a = athlete_map.get(athlete_id)
        if not a or not a.club:
            continue
        c = a.club
        if c.clubsid not in clubs_map:
            clubs_map[c.clubsid] = {"name": c.name, "athletes": []}
        times = {}
        for uid_str, val in bt_data.items():
            if isinstance(val, dict):
                if val.get("LCM"):
                    times[f"{uid_str}_LCM"] = val["LCM"]
                if val.get("SCM"):
                    times[f"{uid_str}_SCM"] = val["SCM"]
        clubs_map[c.clubsid]["athletes"].append({
            "name": f"{a.lastname}, {a.firstname}",
            "times": times,
        })

    # Sort clubs and athletes
    clubs = sorted(clubs_map.values(), key=lambda c: c["name"])
    for club in clubs:
        club["athletes"].sort(key=lambda a: a["name"])

    # Determine course
    course_cfg = db.query(BsGlobal).get("meet_course")
    course = course_cfg.data if course_cfg and course_cfg.data else "LCM"

    return {"styles": styles, "clubs": clubs, "course": course}
