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

"""Concurrent meets, Phase 1: meetsid scoping for the Meet Manager tables.

Adds `meetsid` to swimsession/swimevent/agegroup/swimresult/heat/secret_links,
`session_date` to live_events, and `meet_type`/`registration_open` to meets.
Creates meet_config (a meetsid-scoped equivalent of bsglobal) and relocates
12 meet-scoped bsglobal keys into it. See docs/CONCURRENT_MEETS_PLAN.md.

Idempotent: on a fresh install (no pre-existing `swimevent` table data —
create_all builds the final shape directly) this is a no-op beyond creating
meet_config. On an existing install, backfills every row to the one meet
that exists today (current_meetsid — there is, by construction, only one).
"""
from __future__ import annotations

from sqlalchemy import inspect, text

NAME = "0001_concurrent_meets"

_SCOPED_TABLES = ("swimsession", "swimevent", "agegroup", "swimresult", "heat")

# 'current_meetsid' is deliberately excluded — it's retired, not relocated:
# superseded by resolving the active meet via meets.registration_open
# (routers/api.py's get_active_meetsid), not carried forward as data.
_RELOCATED_KEYS = (
    "meet_filename", "meet_uploaded_at", "meet_name", "meet_course",
    "meet_masters", "meet_currency", "meet_fees_json", "closure_date",
    "organizer_club_id", "MEETVALUES", "meet_nation", "meet_city",
)


def _bsglobal(conn, key: str) -> str | None:
    row = conn.execute(text("SELECT data FROM bsglobal WHERE name = :k"), {"k": key}).fetchone()
    return row[0] if row else None


def upgrade(engine) -> None:
    from ...models import Base
    # Import every module that registers tables on Base.metadata (same set
    # main.py imports) — without these, create_all below wouldn't know about
    # `meets` (models_team) and meet_config's FK to it would fail to resolve.
    from ... import models_team  # noqa: F401
    from ... import models_live  # noqa: F401
    from ... import models_serc  # noqa: F401

    Base.metadata.create_all(bind=engine)  # creates meet_config (new table); no-op otherwise

    insp = inspect(engine)
    if "swimevent" not in insp.get_table_names():
        return  # fresh install, nothing pre-existing to migrate
    cols = {c["name"] for c in insp.get_columns("swimevent")}
    if "meetsid" in cols:
        return  # already the final shape (create_all above built it directly)

    with engine.begin() as conn:
        for table in _SCOPED_TABLES:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN meetsid INTEGER REFERENCES meets(meetsid)"))
        conn.execute(text("ALTER TABLE secret_links ADD COLUMN meetsid INTEGER REFERENCES meets(meetsid)"))
        conn.execute(text("ALTER TABLE live_events ADD COLUMN session_date DATE"))
        conn.execute(text("ALTER TABLE meets ADD COLUMN meet_type VARCHAR(5)"))
        conn.execute(text("ALTER TABLE meets ADD COLUMN registration_open BOOLEAN"))

        current_meetsid = _bsglobal(conn, "current_meetsid")
        if current_meetsid is None:
            return  # defensive no-op — see module docstring

        meet_type = _bsglobal(conn, "meet_type") or _bsglobal(conn, "MEET_TYPE") or "POOL"
        for table in (*_SCOPED_TABLES, "secret_links"):
            conn.execute(text(f"UPDATE {table} SET meetsid = :m"), {"m": current_meetsid})
        conn.execute(
            text("UPDATE meets SET meet_type = :t, registration_open = 1 WHERE meetsid = :m"),
            {"t": meet_type, "m": current_meetsid},
        )

        for key in _RELOCATED_KEYS:
            val = _bsglobal(conn, key)
            if val is not None:
                conn.execute(
                    text("INSERT INTO meet_config (meetsid, name, data) VALUES (:m, :k, :v)"),
                    {"m": current_meetsid, "k": key, "v": val},
                )
                conn.execute(text("DELETE FROM bsglobal WHERE name = :k"), {"k": key})
