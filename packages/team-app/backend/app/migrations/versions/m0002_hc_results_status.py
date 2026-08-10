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

"""HC (hors concours / exhibition) support for historical results.

Adds `resultstatus` to the Team Manager `results` table (mirrors meet-app's
`swimresult.resultstatus` / Splash's own encoding — NULL/0=normal, 4=HC/EXH)
so best_times.py can exclude exhibition swims from best-times computation.
See packages/meet-app/docs/HORS_CONCOURS_DESIGN.md.

Idempotent: no-op on a fresh install (create_all already builds the final
shape) and on a database that already has the column.
"""
from __future__ import annotations

from sqlalchemy import inspect, text

NAME = "0002_hc_results_status"


def upgrade(engine) -> None:
    insp = inspect(engine)
    if "results" not in insp.get_table_names():
        return  # fresh install, nothing pre-existing to migrate
    cols = {c["name"] for c in insp.get_columns("results")}
    if "resultstatus" in cols:
        return  # already the final shape (create_all built it directly)

    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE results ADD COLUMN resultstatus SMALLINT"))
