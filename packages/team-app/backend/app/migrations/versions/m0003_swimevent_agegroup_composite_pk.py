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

Idempotent: no-op on a fresh install (updated models.py + create_all
already builds the composite-PK shape directly) and on a database whose
swimevent PK is already composite.
"""
from __future__ import annotations

from sqlalchemy import inspect, text

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

    with engine.begin() as conn:
        # Backfill any stray NULL meetsid (shouldn't exist post-Stage-1, but
        # a composite PK member can't be nullable, so be defensive) using
        # whichever meet is currently open.
        fallback = conn.execute(text(
            "SELECT meetsid FROM meets WHERE registration_open = true "
            "ORDER BY meetsid LIMIT 1"
        )).scalar()
        if fallback is not None:
            conn.execute(text("UPDATE swimevent SET meetsid = :m WHERE meetsid IS NULL"), {"m": fallback})
            conn.execute(text("UPDATE agegroup SET meetsid = :m WHERE meetsid IS NULL"), {"m": fallback})

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
