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

"""Concurrent meets, follow-up: per-(club, meet) invite/stripe send counts.

`clubs.invite_send_count`/`stripe_send_count` are a single counter per club,
shared across every meet it's ever been invited to — found live while
testing Phase 2 Stage 7 (docs/CONCURRENT_MEETS_PLAN.md): a club invited for
meet A showed as "already invited" on meet B too, since both read/wrote the
same two columns regardless of which meet was selected.

Creates `club_meet_invites` (clubsid, meetsid) -> counts, and backfills
today's existing counts onto whichever open meet actually has registrations
(the best attribution available — the old columns never recorded which meet
an invite was for). Deliberately *not* "whichever open meet has the highest
meetsid": if a second, brand-new meet was created before this migration ran
(exactly what happened testing this fix — two meets were open, one real
with months of registrations, one empty and freshly created with a higher
id), highest-meetsid picks the empty one and silently discards the real
meet's invite history. The old `clubs` columns are left in place, unused,
rather than dropped.

Idempotent: no-op on a fresh install (create_all already builds the final
shape) and on a database that already has the table.
"""
from __future__ import annotations

from sqlalchemy import inspect, text

NAME = "0004_club_meet_invites"


def upgrade(engine) -> None:
    from ...models import Base
    from ... import models_team  # noqa: F401 — registers meets/clubs/club_meet_invites
    from ... import models_live, models_serc  # noqa: F401 — same FK-resolution need as m0001

    insp = inspect(engine)
    already_existed = "club_meet_invites" in insp.get_table_names()

    Base.metadata.create_all(bind=engine)  # creates club_meet_invites; no-op otherwise

    if already_existed or "clubs" not in insp.get_table_names():
        return  # already migrated, or fresh install with nothing to backfill

    with engine.begin() as conn:
        # Postgres and SQLite disagree on boolean literal syntax — mirrors
        # m0003_swimevent_agegroup_composite_pk.py's _backfill_null_meetsid.
        open_expr = "true" if engine.dialect.name == "postgresql" else "1"
        # Pick the open meet with the most registrations, not the highest
        # meetsid — see module docstring. Ties (including "every open meet
        # has zero registrations") fall back to highest meetsid, matching
        # the simpler heuristic this replaces.
        active = conn.execute(text(
            "SELECT m.meetsid, COUNT(r.swimresultid) AS cnt "
            "FROM meets m LEFT JOIN swimresult r ON r.meetsid = m.meetsid "
            f"WHERE m.registration_open = {open_expr} "
            "GROUP BY m.meetsid "
            "ORDER BY cnt DESC, m.meetsid DESC LIMIT 1"
        )).fetchone()
        if active is None:
            return  # no open meet to attribute today's counts to
        meetsid = active[0]

        rows = conn.execute(text(
            "SELECT clubsid, invite_send_count, stripe_send_count FROM clubs "
            "WHERE COALESCE(invite_send_count, 0) > 0 OR COALESCE(stripe_send_count, 0) > 0"
        )).fetchall()
        for clubsid, invite_count, stripe_count in rows:
            conn.execute(text(
                "INSERT INTO club_meet_invites (clubsid, meetsid, invite_send_count, stripe_send_count) "
                "VALUES (:c, :m, :i, :s)"
            ), {"c": clubsid, "m": meetsid, "i": invite_count or 0, "s": stripe_count or 0})
