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

"""Swim style names by id (config/swimstyle-names.json) — mirrors meet-app's
src/main/swimstyleNames.ts. LENEX keeps the French name; this supplies the
English one for the UI."""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

_CONFIG_ENV = "SWIMSTYLE_NAMES_PATH"
_CONFIG_FILENAME = "swimstyle-names.json"


def _config_path() -> Path:
    override = os.environ.get(_CONFIG_ENV)
    if override:
        return Path(override)
    # Docker image: COPY config/swimstyle-names.json . (backend/Dockerfile)
    docker_path = Path(__file__).resolve().parent.parent / _CONFIG_FILENAME
    if docker_path.exists():
        return docker_path
    # Local/dev: packages/team-app/backend/app -> repo root
    return Path(__file__).resolve().parents[4] / "config" / _CONFIG_FILENAME


@lru_cache(maxsize=1)
def _english_names() -> dict[int, str]:
    try:
        with open(_config_path(), "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return {}  # missing/invalid file: fall back to the LENEX name
    out: dict[int, str] = {}
    for series in ("pool", "beach"):
        for sid, v in (raw.get(series) or {}).items():
            if v.get("name_en"):
                out[int(sid)] = v["name_en"]
    return out


def swimstyle_name_en(style_id: int | None, fallback: str) -> str:
    """English name for a swim style id, or `fallback` (the LENEX name) if unknown."""
    return (style_id is not None and _english_names().get(int(style_id))) or fallback
