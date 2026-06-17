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

"""Point Scores Definition Generator (Python port).

Auto-generates the POINTSCORES XML stored in BSGLOBAL.
This XML defines point scoring scales (points per placement) and assigns
them to age group categories for Canadian lifesaving competitions.

Definitions are loaded from a JSON config file bundled with the app.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from .models import BsGlobal

# ── Config loading ─────────────────────────────────────────────────────────────

CONFIG_PATH = Path(__file__).parent.parent / "point-scores-config.json"
# Fallback for local dev (monorepo layout)
_MONOREPO_CONFIG = Path(__file__).parent.parent.parent.parent.parent / "config" / "point-scores-config.json"


def _load_config() -> dict[str, Any]:
    """Load point scores config from the bundled JSON file."""
    path = CONFIG_PATH if CONFIG_PATH.exists() else _MONOREPO_CONFIG
    if not path.exists():
        raise FileNotFoundError(
            f"Point scores config not found at:\n"
            f"  Container: {CONFIG_PATH}\n"
            f"  Monorepo:  {_MONOREPO_CONFIG}"
        )
    return json.loads(path.read_text("utf-8"))


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
    """Build the POINTSCOREDEFINITION XML string."""
    lines = [
        '<?xml version="1.0" encoding="UTF-16"?>',
        "<POINTSCOREDEFINITION>",
        "  <POINTSCORES>",
    ]

    for d in definitions:
        points_str = ",".join(str(p) for p in d["points"])
        lines.append(
            f'    <POINTSCORE pointscoreid="{d["pointscoreid"]}" '
            f'name="{_escape_xml(d["name"])}" '
            f'points="{points_str}" />'
        )

    lines.append("  </POINTSCORES>")
    lines.append("</POINTSCOREDEFINITION>")
    return "\r\n".join(lines)


# ── Age group assignment ───────────────────────────────────────────────────────

def _apply_assignments(db: Session, assignments: list[dict[str, Any]]) -> None:
    """Apply scoretype to age groups based on the assignment config."""
    for a in assignments:
        age_max = 99 if a["ageMax"] == -1 else a["ageMax"]
        db.execute(
            text(
                "UPDATE agegroup SET scoretype = :scoretype "
                "WHERE agemin = :agemin AND agemax = :agemax AND gender = :gender"
            ),
            {
                "scoretype": a["pointscoreid"],
                "agemin": a["ageMin"],
                "agemax": age_max,
                "gender": a["gender"],
            },
        )
        # Also handle -1 stored as -1 in the DB
        if a["ageMax"] == -1:
            db.execute(
                text(
                    "UPDATE agegroup SET scoretype = :scoretype "
                    "WHERE agemin = :agemin AND agemax = -1 AND gender = :gender"
                ),
                {
                    "scoretype": a["pointscoreid"],
                    "agemin": a["ageMin"],
                    "gender": a["gender"],
                },
            )


# ── Main orchestrator ──────────────────────────────────────────────────────────

def regenerate_point_scores(db: Session) -> None:
    """Regenerate the POINTSCORES XML and write it to BSGLOBAL.

    Also applies scoretype assignments to matching age groups.
    Call this when creating a meet from scratch or after age group mutations.
    """
    config = _load_config()

    # Build XML from definitions
    xml = _build_xml(config["definitions"])

    # Upsert into bsglobal
    existing = db.query(BsGlobal).filter_by(name="POINTSCORES").first()
    if existing:
        existing.data = xml
    else:
        db.add(BsGlobal(name="POINTSCORES", data=xml))
    db.flush()

    # Apply scoretype assignments to age groups
    _apply_assignments(db, config["assignments"])
    db.flush()