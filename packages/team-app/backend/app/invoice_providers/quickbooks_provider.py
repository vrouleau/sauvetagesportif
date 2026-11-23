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

"""QuickBooks Online invoice provider.

Phase 2: the OAuth connection (connect / status / disconnect). `push` — creating
the invoice in QuickBooks — comes in phase 3; see docs/QUICKBOOKS_PLAN.md.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from ..models_team import TeamClub
from . import quickbooks_auth as qbo
from .base import InvoiceContext, InvoiceProvider, ProviderError, PushResult


class QuickBooksProvider(InvoiceProvider):
    name = "quickbooks"

    def configured(self) -> bool:
        return qbo.configured()

    def status(self, db: Session, org_club: Optional[TeamClub]) -> dict:
        if not qbo.configured():
            return {"connected": False, "reconnect_required": False}
        return qbo.status(db)

    def connect_start(self, db: Session, org_club: TeamClub) -> dict:
        return {"url": qbo.begin_connect(db)}

    def disconnect(self, db: Session, org_club: TeamClub) -> None:
        qbo.disconnect(db)

    def push(self, ctx: InvoiceContext) -> PushResult:
        raise ProviderError("Pushing invoices to QuickBooks is not available yet", 501)
