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

"""Shared helpers: flag swimstyle IDs in an incoming LXF that are outside the
known pool/beach series (config/swimstyle-ranges.json) or not yet in the
local swimstyle catalog.

The catalog is upserted by id and never wiped (see the create_new_meet /
upload_meet historical-data incident), so importing an LXF from a stale or
foreign template can silently add mismatched style ids to the shared
catalog. Callers use this to ask for confirmation before that happens.

The range check runs independently of the catalog (also on an empty
catalog, and for ids a polluted catalog already contains): an id outside
both series is never one of our templates' styles.
"""
from __future__ import annotations

import json
import os
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path

from sqlalchemy.orm import Session

from .models import SwimStyle

_CONFIG_ENV = "SWIMSTYLE_RANGES_PATH"
_CONFIG_FILENAME = "swimstyle-ranges.json"


def _config_path() -> Path:
    override = os.environ.get(_CONFIG_ENV)
    if override:
        return Path(override)
    # Docker image: COPY config/swimstyle-ranges.json . (backend/Dockerfile)
    docker_path = Path(__file__).resolve().parent.parent / _CONFIG_FILENAME
    if docker_path.exists():
        return docker_path
    # Local/dev: packages/team-app/backend/app -> repo root
    return Path(__file__).resolve().parents[4] / "config" / _CONFIG_FILENAME


@lru_cache(maxsize=1)
def swimstyle_ranges() -> dict[str, tuple[int, int]]:
    """{"POOL": (min, max), "BEACH": (min, max)}, inclusive."""
    with open(_config_path(), "r", encoding="utf-8") as f:
        raw = json.load(f)
    return {k: (int(v["min"]), int(v["max"])) for k, v in raw.items() if not k.startswith("$")}


def style_meet_type(style_id: int | None) -> str | None:
    """'POOL' / 'BEACH' for an id inside a known series, else None."""
    if not style_id:
        return None
    for meet_type, (lo, hi) in swimstyle_ranges().items():
        if lo <= style_id <= hi:
            return meet_type
    return None


def ranges_label() -> str:
    return ", ".join(f"{k.lower()} {lo}-{hi}" for k, (lo, hi) in swimstyle_ranges().items())


def mixed_meet_types(style_ids: Iterable[int | None]) -> bool:
    """True if the ids include both pool-series and beach-series styles."""
    types = {style_meet_type(i) for i in style_ids} - {None}
    return len(types) > 1


def find_new_swimstyles(
    db: Session, styles: Iterable[tuple[int | None, str | None, int | None]]
) -> list[dict]:
    """Return [{"id", "name", "distance", "reason"}] for style ids that are
    outside the known series (reason "out_of_range") or not already present
    in the swimstyle table (reason "not_in_catalog"), deduplicated and sorted
    by id.

    `styles` is an iterable of (swimstyleid, name, distance) tuples pulled
    from the parsed LXF — entries with a falsy id (pause/break placeholders)
    are ignored.
    """
    seen: dict[int, dict] = {}
    for style_id, name, distance in styles:
        if not style_id or style_id in seen:
            continue
        seen[style_id] = {
            "id": style_id,
            "name": name or f"Style {style_id}",
            "distance": distance or 0,
        }
    if not seen:
        return []
    flagged: dict[int, dict] = {
        sid: {**v, "reason": "out_of_range"}
        for sid, v in seen.items() if style_meet_type(sid) is None
    }
    # Bootstrap: an empty catalog has nothing to protect yet — a brand new
    # install's first meet upload naturally introduces "all new" styles, so
    # only the range check applies.
    if db.query(SwimStyle.swimstyleid).first() is not None:
        existing_ids = {
            sid for (sid,) in
            db.query(SwimStyle.swimstyleid).filter(SwimStyle.swimstyleid.in_(seen.keys())).all()
        }
        for sid, v in seen.items():
            if sid not in existing_ids and sid not in flagged:
                flagged[sid] = {**v, "reason": "not_in_catalog"}
    return [flagged[sid] for sid in sorted(flagged)]


def describe_new_swimstyles(styles: list[dict]) -> str:
    """Human-readable summary of find_new_swimstyles' result."""
    out = sum(1 for s in styles if s.get("reason") == "out_of_range")
    new = len(styles) - out
    parts = []
    if out:
        parts.append(f"{out} swimstyle id(s) in this file are outside the known series ({ranges_label()})")
    if new:
        parts.append(f"{new} swimstyle id(s) in this file are not in the local catalog")
    return "; ".join(parts) + "."
