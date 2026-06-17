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

"""Simulate results in the SauvetageMeet SQLite database.

For each swimresult row without a swimtime:
- SWIMTIME = ENTRYTIME +/- 5% (random), or random 30-180s if NT
- 5% chance of DSQ (resultstatus=3)
- Sets racestatus=5 (official) on affected heats

Usage: python simulate_results.py [path_to_meet.db]
Default: %APPDATA%/SauvetageMeet/meet.db
"""

import os
import random
import sqlite3
import sys


def main():
    if len(sys.argv) > 1:
        db_path = sys.argv[1]
    else:
        db_path = os.path.join(os.environ.get("APPDATA", ""), "SauvetageMeet", "meet.db")

    if not os.path.exists(db_path):
        print(f"ERROR: Database not found: {db_path}")
        sys.exit(1)

    print(f"Database: {db_path}")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # Get all swimresults without a swimtime (unseeded or no result yet)
    rows = conn.execute("""
        SELECT r.swimresultid, r.entrytime, r.heatid, e.internalevent
        FROM swimresult r
        JOIN swimevent e ON e.swimeventid = r.swimeventid
        WHERE (r.swimtime IS NULL OR r.swimtime = 0)
          AND e.internalevent = 'F'
    """).fetchall()

    total = 0
    total_dq = 0
    heat_ids = set()

    for row in rows:
        entry_time = row["entrytime"]

        # Generate swim time
        if entry_time and entry_time > 0 and entry_time < 2147483647:
            variation = entry_time * 0.05
            swim_time = int(entry_time + (random.random() * 2 - 1) * variation)
            if swim_time < 1000:
                swim_time = 1000
        else:
            # No entry time: random between 30s and 180s
            swim_time = int(30000 + random.random() * 150000)

        # 5% DSQ (resultstatus=3 in meet-app encoding: 1=DNS, 2=DNF, 3=DSQ)
        if random.random() < 0.05:
            status = 3
            total_dq += 1
        else:
            status = 0

        conn.execute(
            "UPDATE swimresult SET swimtime=?, resultstatus=? WHERE swimresultid=?",
            (swim_time, status, row["swimresultid"]),
        )
        if row["heatid"]:
            heat_ids.add(row["heatid"])
        total += 1

    # Mark affected heats as official (racestatus=5)
    if heat_ids:
        placeholders = ",".join("?" * len(heat_ids))
        conn.execute(
            f"UPDATE heat SET racestatus=5 WHERE heatid IN ({placeholders})",
            list(heat_ids),
        )

    conn.commit()
    conn.close()

    print(f"  {total} results simulated ({total_dq} DSQ)")
    print(f"  {len(heat_ids)} heats marked as official")
    print("Done.")


if __name__ == "__main__":
    main()