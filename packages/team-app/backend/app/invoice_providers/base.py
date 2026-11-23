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

"""The contract every invoice provider (Stripe, QuickBooks…) implements.

Exactly one provider is active per installation, chosen by the
INVOICE_PROVIDER env var (see invoice_providers/__init__.py). The router
(routers/api.py) owns everything provider-neutral — which meet, which club,
the line items, the invoice number, recording the send — and hands a finished
InvoiceContext to the provider's `push`.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from ..models_team import TeamClub


class ProviderError(Exception):
    """A provider refused or failed; the router turns it into an HTTP error."""

    def __init__(self, message: str, status: int = 400, code: Optional[str] = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code  # the provider's own error code, when it gave one


@dataclass
class InvoiceContext:
    """Everything a provider needs to push one club's invoice."""
    db: Session
    club: TeamClub                  # the club being billed
    org_club: TeamClub              # the meet's organizer club (issuer)
    items: list[dict]               # invoices._club_line_items output
    invoice_no: str                 # invoices.invoice_number (YEAR-MEET-CLUB[-Rn])
    total_cents: int
    meet_name: str
    meetsid: Optional[int]
    lang: str = "fr"
    # What the last successful push of this club's invoice for this meet
    # recorded (same provider only), so a re-push finds its invoice instead of
    # creating a second one.
    prior_external_id: Optional[str] = None
    prior_account: Optional[str] = None


@dataclass
class PushResult:
    external_id: str                # the provider's own invoice id
    account: Optional[str] = None   # the provider account it lives in (QuickBooks realm)
    action: str = "created"         # created | updated | unchanged


class InvoiceProvider:
    """Base class. `name` is the INVOICE_PROVIDER value and the UI's key."""

    name: str = ""
    # Whether the provider itself emails the invoice to the club (Stripe) or only
    # creates it for the organizer to send (QuickBooks) — drives the wording of
    # the batch result message.
    sends_invoice: bool = True
    # Whether `invoice_statuses` can report payment state.
    supports_status: bool = False

    def invoice_statuses(self, db: Session, refs: dict[int, tuple[str, Optional[str]]]) -> dict[int, dict]:
        """Payment state of invoices already pushed: `{club_id: {...}}` from
        `refs = {club_id: (provider invoice id, provider account)}`. Raises
        ProviderError when the provider can't be reached."""
        return {}

    def configured(self) -> bool:
        """Whether the server-side credentials (env vars) are present."""
        raise NotImplementedError

    def status(self, db: Session, org_club: Optional[TeamClub]) -> dict:
        """`{"connected": bool, ...}` — never raises."""
        raise NotImplementedError

    def connect_start(self, db: Session, org_club: TeamClub) -> dict:
        """Begin connecting; returns `{"url": ...}` to send the browser to."""
        raise NotImplementedError

    def disconnect(self, db: Session, org_club: TeamClub) -> None:
        raise NotImplementedError

    def push(self, ctx: InvoiceContext) -> PushResult:
        """Create (and, for providers that send, send) the club's invoice.

        Raises ProviderError on any refusal. The caller records the send
        (invoices.record_invoice_sent) only when this returns.
        """
        raise NotImplementedError
