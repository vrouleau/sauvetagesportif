#!/usr/bin/env python3

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

"""
generate_results.py — Fill realistic random results into an existing
SauvetageMeet SQLite database, for individual AND relay entries, respecting
meet type (pool times vs. beach sequential positions) and a configurable DSQ
rate. A more capable superset of simulate_results.py (which stays as the
lightweight "just fill missing pool times" option) — this one also handles
relays, beach positions, and DSQ reason codes.

Scope, matching how simulate_results.py already works: this script does NOT
generate heats or seed finals from qualifiers (that logic -- generateHeats,
autoQualify, seedFinals -- lives only in meet-app's TypeScript, no CLI). It
only fills swimtime/resultstatus/dsqitemid on swimresult/relay rows that
already have a heat assigned and no result yet. Intended workflow:

    1. python scripts/generate_entries_lxf.py ... --output entries.lxf
    2. In meet-app: File -> Importer LENEX (import entries.lxf)
    3. In meet-app: "Générer séries" (generate heats) for prelims/timed finals
    4. Exit meet-app, run this script -> fills every heat that now exists
    5. In meet-app: qualify + generate heats for any Finals
    6. Exit meet-app, re-run this script -> fills the new Final heats too
       (idempotent: only touches rows with no swimtime/position yet)

For each swimresult/relay row with a real heatid and no result yet:
  - Pool: swimtime = entrytime +/- 5% (random 30-180s if NT).
  - Beach: positions sequential and gap-free within each heat (1, 2, 3, ...),
    stored as position*1000 ms (see top-level CLAUDE.md, "Beach Meets").
    DSQ'd athletes/teams are excluded from the sequence (no position).
  - --dsq-pct chance (default 5) of DSQ (resultstatus=3), with a dsqitemid
    drawn from the meet's own seeded dsqitem table (config/dsq-codes.json),
    filtered to reason codes valid for individual vs. relay results.

Usage:
    python scripts/generate_results.py [path_to_meet.db] [--dsq-pct 5] [--seed 42]
Default DB path: auto-detects between the packaged app's data dir and the
`npm run dev` data dir, same as simulate_results.py -- see that script's
docstring for why it refuses to guess when both exist.
"""

from __future__ import annotations

import argparse
import os
import random
import sqlite3
import sys
from collections import defaultdict


def _default_db_path() -> str:
    appdata = os.environ.get("APPDATA", "")
    prod = os.path.join(appdata, "SauvetageMeet", "meet.db")
    dev = os.path.join(appdata, "SauvetageMeet-Dev", "meet.db")
    prod_exists = os.path.exists(prod)
    dev_exists = os.path.exists(dev)

    if prod_exists and dev_exists:
        print("ERROR: Both a packaged-app database and a `npm run dev` database exist:")
        print(f"  {prod}")
        print(f"  {dev}")
        print("Pass the path explicitly: python scripts/generate_results.py <path_to_meet.db>")
        sys.exit(1)
    if dev_exists:
        return dev
    return prod


def _get_meet_type(conn: sqlite3.Connection) -> str:
    row = conn.execute("SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'").fetchone()
    return (row[0] if row and row[0] else "POOL").upper()


def _load_dsq_pool(conn: sqlite3.Connection, want: str) -> list[int]:
    """want: 'I' (individual) or 'R' (relay) -- matches dsqitem.options'
    compact encoding ('I'/'R'/'IR'), see index.ts's compactDsqOptions()."""
    rows = conn.execute("SELECT dsqitemid, options FROM dsqitem").fetchall()
    return [dsqitemid for dsqitemid, options in rows if options and want in options]


def _pool_time_ms(entrytime: int | None, rng: random.Random) -> int:
    if entrytime and 0 < entrytime < 2147483647:
        variation = entrytime * 0.05
        swim_time = int(entrytime + (rng.random() * 2 - 1) * variation)
        return max(swim_time, 1000)
    return int(30000 + rng.random() * 150000)


def _fill_pool_rows(conn: sqlite3.Connection, rows: list[sqlite3.Row], dsq_pct: float,
                     dsq_pool: list[int], rng: random.Random, table: str, id_col: str) -> tuple[int, int]:
    total = dsq_total = 0
    for row in rows:
        swim_time = _pool_time_ms(row["entrytime"], rng)
        is_dsq = rng.random() < (dsq_pct / 100)
        status = 3 if is_dsq else 0
        dsqitemid = rng.choice(dsq_pool) if (is_dsq and dsq_pool) else None
        conn.execute(
            f"UPDATE {table} SET swimtime=?, resultstatus=?, dsqitemid=? WHERE {id_col}=?",
            (swim_time, status, dsqitemid, row[id_col]),
        )
        total += 1
        if is_dsq:
            dsq_total += 1
    return total, dsq_total


def _fill_beach_rows(conn: sqlite3.Connection, rows: list[sqlite3.Row], dsq_pct: float,
                      dsq_pool: list[int], rng: random.Random, table: str, id_col: str) -> tuple[int, int]:
    by_heat: dict[int, list[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        by_heat[row["heatid"]].append(row)

    total = dsq_total = 0
    for heat_rows in by_heat.values():
        shuffled = list(heat_rows)
        rng.shuffle(shuffled)
        position = 0
        for row in shuffled:
            is_dsq = rng.random() < (dsq_pct / 100)
            if is_dsq:
                dsqitemid = rng.choice(dsq_pool) if dsq_pool else None
                conn.execute(
                    f"UPDATE {table} SET swimtime=0, resultstatus=3, dsqitemid=? WHERE {id_col}=?",
                    (dsqitemid, row[id_col]),
                )
                dsq_total += 1
            else:
                position += 1
                conn.execute(
                    f"UPDATE {table} SET swimtime=?, resultstatus=0, dsqitemid=NULL WHERE {id_col}=?",
                    (position * 1000, row[id_col]),
                )
            total += 1
    return total, dsq_total


def main() -> None:
    parser = argparse.ArgumentParser(description="Fill realistic results into a SauvetageMeet SQLite database.")
    parser.add_argument("db_path", nargs="?", default=None, help="Path to meet.db (auto-detected if omitted)")
    parser.add_argument("--dsq-pct", type=float, default=5.0, help="Percent chance of DSQ per result (default 5)")
    parser.add_argument("--seed", type=int, default=None, help="Random seed (reproducible output)")
    args = parser.parse_args()

    if not (0 <= args.dsq_pct <= 100):
        parser.error("--dsq-pct must be between 0 and 100")

    db_path = args.db_path or _default_db_path()
    if not os.path.exists(db_path):
        print(f"ERROR: Database not found: {db_path}")
        sys.exit(1)

    print(f"Database: {db_path}")
    rng = random.Random(args.seed)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    meet_type = _get_meet_type(conn)
    print(f"Meet type: {meet_type}")

    dsq_pool_individual = _load_dsq_pool(conn, "I")
    dsq_pool_relay = _load_dsq_pool(conn, "R")
    if not dsq_pool_individual and not dsq_pool_relay:
        print("WARNING: no dsqitem rows found -- DSQ results will have resultstatus=3 but no dsqitemid.")

    # Individual results: rows with a real heat assigned and no time/position yet.
    individual_rows = conn.execute("""
        SELECT sr.swimresultid, sr.entrytime, sr.heatid
        FROM swimresult sr
        JOIN swimevent e ON e.swimeventid = sr.swimeventid
        WHERE (sr.swimtime IS NULL OR sr.swimtime = 0)
          AND sr.heatid IS NOT NULL AND sr.heatid != 0
          AND e.internalevent = 'F'
    """).fetchall()

    # Relay results: same shape, from the relay table.
    relay_rows = conn.execute("""
        SELECT r.relayid, r.entrytime, r.heatid
        FROM relay r
        JOIN swimevent e ON e.swimeventid = r.swimeventid
        WHERE (r.swimtime IS NULL OR r.swimtime = 0)
          AND r.heatid IS NOT NULL AND r.heatid != 0
          AND e.internalevent = 'F'
    """).fetchall()

    if meet_type == "BEACH":
        ind_total, ind_dsq = _fill_beach_rows(conn, individual_rows, args.dsq_pct, dsq_pool_individual,
                                               rng, "swimresult", "swimresultid")
        relay_total, relay_dsq = _fill_beach_rows(conn, relay_rows, args.dsq_pct, dsq_pool_relay,
                                                   rng, "relay", "relayid")
    else:
        ind_total, ind_dsq = _fill_pool_rows(conn, individual_rows, args.dsq_pct, dsq_pool_individual,
                                              rng, "swimresult", "swimresultid")
        relay_total, relay_dsq = _fill_pool_rows(conn, relay_rows, args.dsq_pct, dsq_pool_relay,
                                                  rng, "relay", "relayid")

    heat_ids = {row["heatid"] for row in individual_rows} | {row["heatid"] for row in relay_rows}
    if heat_ids:
        placeholders = ",".join("?" * len(heat_ids))
        conn.execute(f"UPDATE heat SET racestatus=5 WHERE heatid IN ({placeholders})", list(heat_ids))

    conn.commit()
    conn.close()

    print(f"  {ind_total} individual results simulated ({ind_dsq} DSQ)")
    print(f"  {relay_total} relay results simulated ({relay_dsq} DSQ)")
    print(f"  {len(heat_ids)} heats marked as official")
    print("Done.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
