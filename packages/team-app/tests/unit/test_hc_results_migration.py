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

"""Unit tests for migration 0002 (HC/EXH resultstatus on the `results` table).

See docs/HORS_CONCOURS_DESIGN.md. No Docker/FastAPI needed.

Run: `pytest tests/unit/test_hc_results_migration.py -v`
"""
from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import create_engine, inspect, text

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base
from app import models_team  # noqa: F401 — ensure `results` is registered
from app import models_live  # noqa: F401
from app import models_serc  # noqa: F401
from app.migrations.versions import m0002_hc_results_status as migration


class TestMigration:
    def test_adds_column_to_existing_install(self):
        """A pre-existing `results` table without `resultstatus` gets it added."""
        engine = create_engine("sqlite:///:memory:")
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    "CREATE TABLE results (resultsid INTEGER PRIMARY KEY, totaltime INTEGER)"
                ))
                conn.execute(text("INSERT INTO results (resultsid, totaltime) VALUES (1, 60000)"))

            migration.upgrade(engine)

            insp = inspect(engine)
            cols = {c["name"] for c in insp.get_columns("results")}
            assert "resultstatus" in cols
            with engine.connect() as conn:
                # Pre-existing row survives, new column defaults to NULL
                row = conn.execute(text("SELECT totaltime, resultstatus FROM results WHERE resultsid=1")).fetchone()
                assert row == (60000, None)
        finally:
            engine.dispose()

    def test_idempotent_on_already_migrated_install(self):
        engine = create_engine("sqlite:///:memory:")
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    "CREATE TABLE results (resultsid INTEGER PRIMARY KEY, resultstatus SMALLINT)"
                ))
            migration.upgrade(engine)  # must not raise (column already present)
            insp = inspect(engine)
            cols = {c["name"] for c in insp.get_columns("results")}
            assert "resultstatus" in cols
        finally:
            engine.dispose()

    def test_fresh_install_is_noop_beyond_create_all(self):
        """No pre-existing `results` table → create_all alone builds the final shape."""
        engine = create_engine("sqlite:///:memory:")
        try:
            Base.metadata.create_all(bind=engine)
            migration.upgrade(engine)
            insp = inspect(engine)
            cols = {c["name"] for c in insp.get_columns("results")}
            assert "resultstatus" in cols
        finally:
            engine.dispose()
