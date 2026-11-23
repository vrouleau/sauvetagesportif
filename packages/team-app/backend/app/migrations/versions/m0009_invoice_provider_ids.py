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

"""Remember where a club's invoice went: which provider took it and its id.

Adds `invoice_provider`, `provider_invoice_id` and `provider_account` to
`club_meet_invites` so re-pushing an invoice (QuickBooks) finds the one already
created instead of duplicating it. All nullable — NULL means "never pushed to a
provider". The new `qbo_customers` table is built by create_all.

Idempotent: no-op on a fresh install (create_all builds the final shape) and on
a database that already has the columns.
"""
from __future__ import annotations

from sqlalchemy import inspect, text

NAME = "0009_invoice_provider_ids"

_COLUMNS = {
    "invoice_provider": "VARCHAR(20)",
    "provider_invoice_id": "VARCHAR(100)",
    "provider_account": "VARCHAR(100)",
}


def upgrade(engine) -> None:
    insp = inspect(engine)
    if "club_meet_invites" not in insp.get_table_names():
        return  # fresh install — create_all builds the final shape
    cols = {c["name"] for c in insp.get_columns("club_meet_invites")}
    with engine.begin() as conn:
        for name, ddl in _COLUMNS.items():
            if name not in cols:
                conn.execute(text(f"ALTER TABLE club_meet_invites ADD COLUMN {name} {ddl}"))
