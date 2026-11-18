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

"""Database connection (SQLite only)."""
import os
from pathlib import Path
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

DB_PATH = os.environ.get("SQLITE_DB_PATH", "/app/data/meetmgr.db")
DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


# Performance pragmas (WAL mode for concurrent reads, busy timeout for write queuing)
@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


SessionLocal = sessionmaker(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def sqlite_snapshot_bytes(db_path: str = DB_PATH) -> bytes:
    """Return a consistent SQLite snapshot, safe to call while the app is under WAL mode.

    The live database runs with `PRAGMA journal_mode=WAL`, so recent commits can sit in the
    `-wal` file and haven't been merged into the main .db file yet. Reading the main file's
    raw bytes directly (or shutil.copy2) silently omits that data — the backup looks fine
    but is actually a stale snapshot from before the last checkpoint. SQLite's online backup
    API reads through a real connection (main db + WAL merged) and produces a complete,
    self-contained copy regardless of checkpoint timing.
    """
    import sqlite3
    import tempfile
    if not Path(db_path).exists():
        raise FileNotFoundError(f"Database file not found: {db_path}")
    tmp_path = Path(tempfile.mktemp(suffix=".db"))
    try:
        src_conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        dst_conn = sqlite3.connect(str(tmp_path))
        src_conn.backup(dst_conn)
        dst_conn.close()
        src_conn.close()
        return tmp_path.read_bytes()
    finally:
        if tmp_path.exists():
            tmp_path.unlink()
