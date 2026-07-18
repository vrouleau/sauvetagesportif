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

"""Shared helper: detect swimstyle IDs referenced by an incoming LXF that
aren't yet in the local swimstyle catalog.

The catalog is upserted by id and never wiped (see the create_new_meet /
upload_meet historical-data incident), so importing an LXF from a stale or
foreign template can silently add mismatched style ids to the shared
catalog. Callers use this to ask for confirmation before that happens.
"""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy.orm import Session

from .models import SwimStyle


def find_new_swimstyles(
    db: Session, styles: Iterable[tuple[int | None, str | None, int | None]]
) -> list[dict]:
    """Return [{"id", "name", "distance"}] for style ids not already present
    in the swimstyle table, deduplicated and sorted by id.

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
    # Bootstrap: an empty catalog has nothing to protect yet — a brand new
    # install's first meet upload naturally introduces "all new" styles, so
    # there's nothing meaningful to confirm against.
    if db.query(SwimStyle.swimstyleid).first() is None:
        return []
    existing_ids = {
        sid for (sid,) in
        db.query(SwimStyle.swimstyleid).filter(SwimStyle.swimstyleid.in_(seen.keys())).all()
    }
    return [v for sid, v in sorted(seen.items()) if sid not in existing_ids]
