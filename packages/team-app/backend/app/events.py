"""Load events from meet .lxf into SwimEvent + SwimStyle + AgeGroup tables."""
from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session
from .models import (
    SwimStyle, SwimSession, SwimEvent, AgeGroup,
    ROUND_PRE, ROUND_TIM, ROUND_FIN,
    fee_cents_to_dollars,
)
from .meet_parser import parse_meet_lxf, ParsedMeet


def _round_from_lenex(round_str: str) -> int:
    """Map Lenex round string to Splash integer encoding."""
    mapping = {"PRE": ROUND_PRE, "SEM": 2, "FIN": ROUND_FIN, "TIM": ROUND_TIM}
    return mapping.get(round_str, ROUND_TIM)


def _load_from_parsed(db: Session, meet: ParsedMeet) -> int:
    """Insert events + age groups + swimstyles from a parsed meet. Returns event count."""
    count = 0

    for ses in meet.sessions:
        # Create session
        session = SwimSession(
            sessionnumber=ses.number,
            name=ses.name,
            course=None,  # will be set from meet-level course if needed
        )
        db.add(session)
        db.flush()

        for ev in ses.events:
            # Upsert swimstyle
            style = db.query(SwimStyle).get(ev.swimstyleid)
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
                swimsessionid=session.swimsessionid,
                swimstyleid=ev.swimstyleid,
                eventnumber=ev.number,
                gender=ev.gender_int,
                round=_round_from_lenex(ev.round),
                masters="T" if ev.is_masters else "F",
                fee=fee_cents_to_dollars(ev.fee_cents),
            )
            db.add(event)
            db.flush()

            for ag in ev.agegroups:
                db.add(AgeGroup(
                    agegroupid=ag.agegroupid,
                    swimeventid=event.swimeventid,
                    agemin=ag.agemin,
                    agemax=ag.agemax,
                ))
            count += 1

    db.commit()
    return count


def load_events(db: Session, lxf_path: Path) -> int:
    """Load events from meet .lxf if table is empty. Returns count."""
    if db.query(SwimEvent).first():
        return 0
    meet = parse_meet_lxf(lxf_path)
    return _load_from_parsed(db, meet)
