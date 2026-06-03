"""Relay team helper functions.

Provides eligible athlete computation for relay team member assignment.
Used by the relay CRUD endpoints to populate athlete dropdowns.
"""
from __future__ import annotations

from datetime import date

from sqlalchemy.orm import Session

from .models import BsGlobal, GENDER_M, GENDER_F, GENDER_MIXED
from .models_team import Member


def _get_age_base_date(db: Session) -> date:
    """Return the meet's age base date, defaulting to Dec 31 of current year."""
    cfg = db.get(BsGlobal, "age_base_date")
    if cfg and cfg.data:
        return date.fromisoformat(cfg.data)
    return date(date.today().year, 12, 31)


def compute_age(birthdate: date, age_base_date: date) -> int:
    """Compute athlete age as of the age base date using year difference.

    This matches the existing age computation pattern used throughout the
    team-app backend (age = age_base.year - birthdate.year).
    """
    return age_base_date.year - birthdate.year


def get_eligible_athletes(
    db: Session,
    club_id: int,
    event_gender: int,
    age_min: int,
    age_max: int | None,
) -> list[dict]:
    """Compute eligible athletes for a relay event/age category.

    Queries club members, filters by age range and event gender,
    and returns athletes sorted by last name then first name.

    Args:
        db: Database session.
        club_id: The club whose members to consider.
        event_gender: Gender restriction for the event (1=M, 2=F, 3=Mixed).
        age_min: Minimum age (inclusive) for the age category.
        age_max: Maximum age (inclusive) for the age category, or None for open-ended.

    Returns:
        List of dicts with keys: id, name (\"LastName, FirstName\"), gender (\"M\" or \"F\").
    """
    age_base_date = _get_age_base_date(db)

    # Query all members for the club
    members = (
        db.query(Member)
        .filter(Member.clubsid == club_id)
        .order_by(Member.lastname, Member.firstname)
        .all()
    )

    eligible: list[dict] = []
    for member in members:
        # Skip members without a birthdate (cannot determine age)
        if not member.birthdate:
            continue

        # Compute age using year difference (matches existing codebase pattern)
        birthdate = member.birthdate
        if hasattr(birthdate, "date"):
            # birthdate is stored as DateTime, extract the date part
            birthdate = birthdate.date()
        age = compute_age(birthdate, age_base_date)

        # Filter by age range
        if age < age_min:
            continue
        if age_max is not None and age > age_max:
            continue

        # Filter by gender (skip if event is mixed - include all)
        if event_gender != GENDER_MIXED:
            if member.gender != event_gender:
                continue

        # Build the eligible athlete entry
        gender_str = "M" if member.gender == GENDER_M else "F"
        eligible.append({
            "id": member.membersid,
            "name": f"{member.lastname}, {member.firstname}",
            "gender": gender_str,
        })

    return eligible
