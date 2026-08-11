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

"""Concurrent meets, follow-up: composite PK on swimevent/agegroup.

`swimevent.swimeventid` and `agegroup.agegroupid` are populated verbatim
from the LXF templates (fixed id ranges, same every time a meet is created)
by events.py::_load_from_parsed. Before Phase 2 Stage 1 (see
docs/CONCURRENT_MEETS_PLAN.md), a new meet always wiped the previously
active meet's rows first, so reusing those fixed ids across meets was never
visible. Stage 1 deliberately stopped wiping a still-open meet's data — the
whole point of concurrent meets — so a second meet's insert now collides
with the first meet's still-present rows at the same ids
(psycopg2.errors.UniqueViolation on swimevent_pkey).

Fix: make the primary key (meetsid, swimeventid) / (meetsid, agegroupid)
instead of the bare id, so two different meets can legitimately share the
same numeric id. `meetsid` already exists on every affected table (added by
m0001_concurrent_meets) — this migration only changes constraints, no new
columns except making `swimevent.meetsid`/`agegroup.meetsid` NOT NULL (a
composite PK member can't be nullable).

Two dialect-specific upgrade paths, since the local dev stack defaults to
SQLite (docker-compose.yml) while the Docker test stack and any real
deployment use Postgres:
- Postgres supports ALTER TABLE ... DROP/ADD CONSTRAINT directly.
- SQLite supports neither DROP CONSTRAINT nor ADD PRIMARY KEY/FOREIGN KEY
  after the fact — the standard approach there is the "12-step" table
  rebuild: create a new table with the target schema, copy the data across,
  drop the old table, rename the new one into place. Column lists are
  pulled from the live table via `inspect()` rather than hardcoded, so nothing
  is silently dropped if the physical schema ever drifts from models.py.

Idempotent: no-op on a fresh install (updated models.py + create_all
already builds the composite-PK shape directly) and on a database whose
swimevent PK is already composite.
"""
from __future__ import annotations

from sqlalchemy import inspect, text
from sqlalchemy.schema import CreateTable

NAME = "0003_swimevent_agegroup_composite_pk"

# (table, column referencing swimevent.swimeventid) pairs whose existing
# single-column FK must be dropped before swimevent's single-column PK can go.
_SWIMEVENT_FK_TABLES = ("agegroup", "swimresult", "heat")


def _fk_name(insp, table: str, column: str) -> str | None:
    for fk in insp.get_foreign_keys(table):
        if fk["constrained_columns"] == [column]:
            return fk["name"]
    return None


def upgrade(engine) -> None:
    insp = inspect(engine)
    if "swimevent" not in insp.get_table_names():
        return  # fresh install, create_all already built the final shape

    pk = insp.get_pk_constraint("swimevent")
    if "meetsid" in (pk.get("constrained_columns") or []):
        return  # already composite

    if engine.dialect.name == "sqlite":
        _upgrade_sqlite(engine)
    else:
        _upgrade_postgres(engine)


def _backfill_null_meetsid(conn, meets_open_expr: str) -> None:
    fallback = conn.execute(text(
        f"SELECT meetsid FROM meets WHERE registration_open = {meets_open_expr} "
        "ORDER BY meetsid LIMIT 1"
    )).scalar()
    if fallback is not None:
        conn.execute(text("UPDATE swimevent SET meetsid = :m WHERE meetsid IS NULL"), {"m": fallback})
        conn.execute(text("UPDATE agegroup SET meetsid = :m WHERE meetsid IS NULL"), {"m": fallback})


def _upgrade_postgres(engine) -> None:
    with engine.begin() as conn:
        # Backfill any stray NULL meetsid (shouldn't exist post-Stage-1, but
        # a composite PK member can't be nullable, so be defensive) using
        # whichever meet is currently open.
        _backfill_null_meetsid(conn, "true")

        insp2 = inspect(conn)

        # Drop FKs that depend on swimevent's current single-column PK.
        for table in _SWIMEVENT_FK_TABLES:
            fk_name = _fk_name(insp2, table, "swimeventid")
            if fk_name:
                conn.execute(text(f"ALTER TABLE {table} DROP CONSTRAINT {fk_name}"))

        # Drop the FK that depends on agegroup's current single-column PK.
        fk_name = _fk_name(insp2, "swimresult", "agegroupid")
        if fk_name:
            conn.execute(text(f"ALTER TABLE swimresult DROP CONSTRAINT {fk_name}"))

        # Drop the old single-column PKs.
        swimevent_pk = insp2.get_pk_constraint("swimevent")["name"]
        conn.execute(text(f"ALTER TABLE swimevent DROP CONSTRAINT {swimevent_pk}"))
        agegroup_pk = insp2.get_pk_constraint("agegroup")["name"]
        conn.execute(text(f"ALTER TABLE agegroup DROP CONSTRAINT {agegroup_pk}"))

        # Composite PK members can't be nullable.
        conn.execute(text("ALTER TABLE swimevent ALTER COLUMN meetsid SET NOT NULL"))
        conn.execute(text("ALTER TABLE agegroup ALTER COLUMN meetsid SET NOT NULL"))

        # Add the composite PKs.
        conn.execute(text("ALTER TABLE swimevent ADD PRIMARY KEY (meetsid, swimeventid)"))
        conn.execute(text("ALTER TABLE agegroup ADD PRIMARY KEY (meetsid, agegroupid)"))

        # Re-add the FKs as composite, referencing the new composite PKs.
        conn.execute(text(
            "ALTER TABLE agegroup ADD FOREIGN KEY (meetsid, swimeventid) "
            "REFERENCES swimevent (meetsid, swimeventid) ON DELETE CASCADE"
        ))
        conn.execute(text(
            "ALTER TABLE heat ADD FOREIGN KEY (meetsid, swimeventid) "
            "REFERENCES swimevent (meetsid, swimeventid) ON DELETE CASCADE"
        ))
        conn.execute(text(
            "ALTER TABLE swimresult ADD FOREIGN KEY (meetsid, swimeventid) "
            "REFERENCES swimevent (meetsid, swimeventid)"
        ))
        conn.execute(text(
            "ALTER TABLE swimresult ADD FOREIGN KEY (meetsid, agegroupid) "
            "REFERENCES agegroup (meetsid, agegroupid)"
        ))
        # heat.agegroupid had no FK declared before this migration.
        conn.execute(text(
            "ALTER TABLE heat ADD FOREIGN KEY (meetsid, agegroupid) "
            "REFERENCES agegroup (meetsid, agegroupid)"
        ))

        # uq_swimresult_entry must include meetsid or it blocks the same
        # athlete registering for "event 1065" in two concurrently-open meets.
        uq_name = None
        for uq in insp2.get_unique_constraints("swimresult"):
            if uq["name"] == "uq_swimresult_entry":
                uq_name = uq["name"]
                break
        if uq_name:
            conn.execute(text(f"ALTER TABLE swimresult DROP CONSTRAINT {uq_name}"))
        conn.execute(text(
            "ALTER TABLE swimresult ADD CONSTRAINT uq_swimresult_entry "
            "UNIQUE (meetsid, athleteid, swimeventid, age_code)"
        ))


def _rebuild_table_sqlite(conn, insp, table_name: str, target_table) -> None:
    """Rebuild `table_name` in place to match `target_table`'s schema
    (composite PK/FK, from the current models.py), preserving every row.
    Column list is read from the live table, not hardcoded, so nothing is
    silently dropped if the physical schema ever drifts from models.py.
    """
    cols = [c["name"] for c in insp.get_columns(table_name)]
    tmp_name = f"{table_name}__new"

    # Clone into the *same* metadata target_table already belongs to (models.py's
    # Base.metadata, shared by models_team.py — see models_team.py's "Use the
    # same Base so FK references resolve" comment) rather than a fresh empty
    # one, so string FK references to sibling tables (swimsession, swimstyle,
    # meets, agegroup...) still resolve.
    tmp_table = target_table.to_metadata(target_table.metadata, name=tmp_name)
    conn.execute(text(str(CreateTable(tmp_table).compile(conn))))
    # Drop the clone from the in-memory metadata immediately — it was only
    # needed to compile the CREATE TABLE statement under the temp name, and
    # leaving it registered would collide with a second call in the same
    # process (e.g. running this migration twice in one test session).
    target_table.metadata.remove(tmp_table)

    col_list = ", ".join(cols)
    conn.execute(text(f"INSERT INTO {tmp_name} ({col_list}) SELECT {col_list} FROM {table_name}"))
    conn.execute(text(f"DROP TABLE {table_name}"))
    conn.execute(text(f"ALTER TABLE {tmp_name} RENAME TO {table_name}"))


def _upgrade_sqlite(engine) -> None:
    from ...models import SwimEvent, AgeGroup, Heat, SwimResult
    # SwimEvent.meetsid/AgeGroup.meetsid reference meets.meetsid (models_team.py,
    # same shared Base.metadata) — must be imported so that table is registered
    # before to_metadata() tries to resolve the FK (same pattern m0001 uses).
    from ... import models_team  # noqa: F401

    with engine.begin() as conn:
        # PRAGMA foreign_keys is per-connection and SQLAlchemy's own event
        # listener (database.py) turns it ON for every new connection,
        # including this one — turn it back off for the duration of the
        # rebuild so dropping tables that others reference doesn't trip
        # enforcement mid-migration, then restore it before returning.
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")

        _backfill_null_meetsid(conn, "1")

        insp2 = inspect(conn)
        # Order matters: swimevent and agegroup must reach their final
        # composite-PK shape before heat/swimresult are rebuilt, since the
        # latters' composite FKs reference them by the final table name.
        _rebuild_table_sqlite(conn, insp2, "swimevent", SwimEvent.__table__)
        insp2 = inspect(conn)
        _rebuild_table_sqlite(conn, insp2, "agegroup", AgeGroup.__table__)
        insp2 = inspect(conn)
        _rebuild_table_sqlite(conn, insp2, "heat", Heat.__table__)
        _rebuild_table_sqlite(conn, insp2, "swimresult", SwimResult.__table__)

        conn.exec_driver_sql("PRAGMA foreign_keys=ON")
