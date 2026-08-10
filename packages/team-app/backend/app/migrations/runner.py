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

"""Generic migration runner.

Deliberately knows nothing about the app's own tables (meets/swimevent/etc.)
— that knowledge lives in each migration module under versions/. This file
is just: find migration modules, track which ones already ran (via a small
schema_migrations table), run the rest in filename order.
"""
from __future__ import annotations

import importlib
import pkgutil
from datetime import datetime

from sqlalchemy import text


def _ensure_tracking_table(engine) -> None:
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "name TEXT PRIMARY KEY, applied_at TEXT)"
        ))


def _applied_names(engine) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT name FROM schema_migrations")).fetchall()
    return {r[0] for r in rows}


def _discover_versions() -> list:
    from . import versions
    modules = []
    for info in sorted(pkgutil.iter_modules(versions.__path__), key=lambda m: m.name):
        if info.name.startswith("_"):
            continue
        modules.append(importlib.import_module(f"{versions.__name__}.{info.name}"))
    return modules


def apply_pending(engine) -> list[str]:
    """Run every not-yet-applied migration in versions/, in filename order.

    Returns the names of migrations that were actually applied (empty list
    if the database was already up to date).
    """
    _ensure_tracking_table(engine)
    applied = _applied_names(engine)
    ran = []
    for module in _discover_versions():
        name = module.NAME
        if name in applied:
            continue
        module.upgrade(engine)
        with engine.begin() as conn:
            conn.execute(
                text("INSERT INTO schema_migrations (name, applied_at) VALUES (:n, :t)"),
                {"n": name, "t": datetime.utcnow().isoformat()},
            )
        ran.append(name)
    return ran
