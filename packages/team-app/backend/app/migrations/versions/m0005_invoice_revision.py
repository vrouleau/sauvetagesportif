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

"""Deterministic invoice numbers: per-(club, meet) revision tracking.

Adds `invoice_rev` and `invoice_last_total_cents` to `club_meet_invites` so
an invoice number (`YEAR-MEET-CLUB`, see invoices.invoice_number) can get a
`-R2`, `-R3`… suffix when a club's total changes after an invoice was sent.
Both columns are nullable — NULL means "never sent".

Idempotent: no-op on a fresh install (create_all already builds the final
shape) and on a database that already has the columns.
"""
from __future__ import annotations

from sqlalchemy import inspect, text

NAME = "0005_invoice_revision"


def upgrade(engine) -> None:
    insp = inspect(engine)
    if "club_meet_invites" not in insp.get_table_names():
        return  # fresh install — create_all builds the final shape
    cols = {c["name"] for c in insp.get_columns("club_meet_invites")}
    with engine.begin() as conn:
        if "invoice_rev" not in cols:
            conn.execute(text("ALTER TABLE club_meet_invites ADD COLUMN invoice_rev INTEGER"))
        if "invoice_last_total_cents" not in cols:
            conn.execute(text("ALTER TABLE club_meet_invites ADD COLUMN invoice_last_total_cents INTEGER"))
