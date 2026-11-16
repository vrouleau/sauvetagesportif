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

"""Restoring a backup older than the running code must bring the schema up
to date (migrations otherwise only run at container startup).

Regression: a pre-0006 backup restored via POST /admin/restore-db made every
results import fail with "no such table: athlete_best_times".
"""
from __future__ import annotations

import shutil
import sqlite3
import sys
from pathlib import Path

from sqlalchemy import create_engine, inspect, text

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.migrations.run import upgrade_schema


def test_restoring_a_pre_0006_backup_then_upgrading_recreates_the_table(tmp_path):
    live_path = tmp_path / "live.db"
    engine = create_engine(f"sqlite:///{live_path}")
    upgrade_schema(engine)  # live DB at today's schema
    assert "athlete_best_times" in inspect(engine).get_table_names()

    # An "old backup": same schema minus migration 0006, with some data.
    old_path = tmp_path / "old_backup.db"
    shutil.copy(live_path, old_path)
    old = sqlite3.connect(old_path)
    old.execute("DROP TABLE athlete_best_times")
    old.execute("DELETE FROM schema_migrations WHERE name = '0006_athlete_best_times'")
    old.execute("INSERT INTO clubs (clubsid, name, code) VALUES (77, 'Restored Club', 'RST')")
    old.commit()
    old.close()

    # Restore exactly like the SQLite branch of restore-db (backup API into
    # the live database through the engine's pool).
    src = sqlite3.connect(old_path)
    raw = engine.raw_connection()
    src.backup(raw.connection)
    src.close()
    raw.close()
    assert "athlete_best_times" not in inspect(engine).get_table_names()  # the reported state

    ran = upgrade_schema(engine)

    assert ran == ["0006_athlete_best_times"]
    assert "athlete_best_times" in inspect(engine).get_table_names()
    with engine.connect() as c:
        assert c.execute(text("SELECT name FROM clubs WHERE clubsid = 77")).scalar() == "Restored Club"
        names = [r[0] for r in c.execute(text("SELECT name FROM schema_migrations"))]
    assert "0006_athlete_best_times" in names
    engine.dispose()


def test_upgrade_is_a_no_op_on_an_up_to_date_database(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'db.db'}")
    upgrade_schema(engine)
    assert upgrade_schema(engine) == []
    engine.dispose()
