"""Combined Events Definition Generator (Python port).

Auto-generates the COMBINEDEVENTS XML stored in BSGLOBAL.
This XML defines cumulative point standings per age group/gender category
for Canadian lifesaving competitions.

Category definitions are loaded from a JSON config file bundled with the app.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from .models import BsGlobal

# ── Config loading ─────────────────────────────────────────────────────────────

CONFIG_PATH = Path(__file__).parent.parent / "combined-events-config.json"
# Fallback for local dev (monorepo layout)
_MONOREPO_CONFIG = Path(__file__).parent.parent.parent.parent.parent / "config" / "combined-events-config.json"


def _load_config() -> list[dict[str, Any]]:
    """Load category configs from the bundled JSON file."""
    path = CONFIG_PATH if CONFIG_PATH.exists() else _MONOREPO_CONFIG
    if not path.exists():
        raise FileNotFoundError(
            f"Combined events config not found at:\n"
            f"  Container: {CONFIG_PATH}\n"
            f"  Monorepo:  {_MONOREPO_CONFIG}"
        )
    data = json.loads(path.read_text("utf-8"))
    return data["categories"]


# ── Event query ────────────────────────────────────────────────────────────────

def _query_events_with_agegroups(db: Session) -> list[dict[str, Any]]:
    """Query individual pool events with their age groups."""
    result = db.execute(text("""
        SELECT e.swimeventid, e.eventnumber, e.gender AS eventgender, e.internalevent,
               ag.agemin, ag.agemax, ag.gender,
               ss.relaycount
        FROM swimevent e
        JOIN agegroup ag ON ag.swimeventid = e.swimeventid
        JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
        WHERE ss.relaycount = 1
          AND ss.distance >= 25
          AND (e.internalevent IS NULL OR e.internalevent = 'F')
          AND e.eventnumber IS NOT NULL
          AND (e.preveventid IS NULL OR e.preveventid < 1)
        ORDER BY e.eventnumber, ag.sortcode
    """))
    return [dict(row._mapping) for row in result]


# ── Event matching ─────────────────────────────────────────────────────────────

def _find_matching_events(
    events: list[dict[str, Any]], category: dict[str, Any]
) -> list[int]:
    """Find event IDs matching a category's age range and gender."""
    matched: set[int] = set()
    cat_age_min = category["ageMin"]
    cat_age_max = category["ageMax"]
    cat_gender = category["gender"]

    for ev in events:
        # Age range match
        if ev["agemin"] != cat_age_min:
            continue
        if cat_age_max == -1:
            if ev["agemax"] not in (-1, 99):
                continue
        else:
            if ev["agemax"] != cat_age_max:
                continue

        # Gender match
        if cat_gender == 0:
            # Mixed category: matches events with event-level gender 0 or 3
            if ev["eventgender"] in (0, 3):
                matched.add(ev["swimeventid"])
        else:
            # Gendered category: matches age groups with same gender
            if ev["gender"] == cat_gender:
                matched.add(ev["swimeventid"])

    return sorted(matched)


# ── XML serialization ──────────────────────────────────────────────────────────

def _escape_xml(s: str) -> str:
    """Escape XML special characters in attribute values."""
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _build_xml(definitions: list[dict[str, Any]]) -> str:
    """Build the COMBINEDEVENTDEFINITION XML string."""
    lines = [
        '<?xml version="1.0" encoding="UTF-16"?>',
        "<COMBINEDEVENTDEFINITION>",
        "  <COMBINEDEVENTS>",
    ]

    for d in definitions:
        attrs = [
            f'combinedeventid="{d["combinedeventid"]}"',
            f'name="{_escape_xml(d["name"])}"',
            f'titleforprints="{_escape_xml(d["name"])}"',
            f'sumtype="2"',
            f'pointsforplaces="{d["pointsforplaces"]}"',
            f'maxresults="100"',
            f'sortbyresfirst="{d["sortbyresfirst"]}"',
            f'penalty="10"',
            f'inpercent="T"',
            f'completedsq="F"',
            f'finalusetype="{d["finalusetype"]}"',
        ]
        if d["event_ids"]:
            attrs.append(f'agegroupeventid="{d["agegroupeventid"]}"')

        attr_str = " ".join(attrs)

        if not d["event_ids"]:
            lines.append(f"    <COMBINEDEVENT {attr_str} />")
        else:
            lines.append(f"    <COMBINEDEVENT {attr_str}>")
            lines.append("      <EVENTS>")
            for eid in d["event_ids"]:
                lines.append(f'        <EVENT eventid="{eid}" mandatory="F" />')
            lines.append("      </EVENTS>")
            lines.append("    </COMBINEDEVENT>")

    lines.append("  </COMBINEDEVENTS>")
    lines.append("</COMBINEDEVENTDEFINITION>")
    return "\r\n".join(lines)


# ── Main orchestrator ──────────────────────────────────────────────────────────

def regenerate_combined_events(db: Session) -> None:
    """Regenerate the COMBINEDEVENTS XML and write it to BSGLOBAL.

    Call this after any event or age group mutation.
    """
    categories = _load_config()
    events = _query_events_with_agegroups(db)

    definitions: list[dict[str, Any]] = []

    for cat in categories:
        if cat.get("isSpecialNoEvents"):
            definitions.append({
                "combinedeventid": 0,
                "name": cat["name"],
                "pointsforplaces": cat["pointsForPlaces"],
                "sortbyresfirst": cat["sortbyresfirst"],
                "finalusetype": cat["finalusetype"],
                "agegroupeventid": 0,
                "event_ids": [],
            })
            continue

        matching = _find_matching_events(events, cat)
        if not matching:
            continue

        first_id = matching[0]
        definitions.append({
            "combinedeventid": first_id,
            "name": cat["name"],
            "pointsforplaces": cat["pointsForPlaces"],
            "sortbyresfirst": cat["sortbyresfirst"],
            "finalusetype": cat["finalusetype"],
            "agegroupeventid": first_id,
            "event_ids": matching,
        })

    xml = _build_xml(definitions)

    # Upsert into bsglobal
    existing = db.query(BsGlobal).filter_by(name="COMBINEDEVENTS").first()
    if existing:
        existing.data = xml
    else:
        db.add(BsGlobal(name="COMBINEDEVENTS", data=xml))
    db.flush()
