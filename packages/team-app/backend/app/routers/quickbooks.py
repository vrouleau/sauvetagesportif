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

"""QuickBooks OAuth callback (it also tells the club when its connection changes).

The only QuickBooks route that is not behind require_organizer_or_admin: Intuit
sends the user's browser here after the consent page, and a browser redirect
carries none of the app's credentials (the PIN header). It is authenticated by
the one-time `state` issued when the connect started (quickbooks_auth.consume_state).
Connect / status / disconnect go through the generic /api/invoice-provider routes.
"""
from __future__ import annotations

import logging
from typing import Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Depends
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..invoice_providers import ProviderError, selected_provider_name
from ..invoice_providers import quickbooks_auth as qbo

log = logging.getLogger("quickbooks")
router = APIRouter(prefix="/api")


def _back(result: str, reason: Optional[str] = None) -> RedirectResponse:
    """Send the browser back to the Organizer page. Relative on purpose: it
    resolves against whatever public origin the callback was reached on. The
    reason is a short code, never Intuit's raw text."""
    query = {"quickbooks": result}
    if reason:
        query["reason"] = reason
    return RedirectResponse(f"/organizer?{urlencode(query)}", status_code=303)


def _notify(db: Session, owner: int, event: str, company: Optional[str]) -> None:
    """Tell the club (or the installation's support address) that its QuickBooks
    connection changed. Best effort: the connection itself is already stored."""
    import os
    from datetime import datetime, timezone
    from ..emailing import build_quickbooks_notice, send_email
    from ..models_team import TeamClub
    club = db.get(TeamClub, owner) if owner else None
    to = ((club.email if club else "") or "").strip() or os.environ.get("SUPPORT_EMAIL", "").strip()
    if not to:
        log.warning("QuickBooks %s for owner %s: nobody to notify", event, owner)
        return
    subject, html = build_quickbooks_notice(
        club_name=club.name if club else "SauvetageTeam", event=event, company=company,
        when=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))
    try:
        send_email(to, subject, html)
    except Exception:  # noqa: BLE001 — a mail outage must not undo a connection
        log.warning("QuickBooks %s notice to owner %s could not be sent", event, owner, exc_info=True)


@router.get("/quickbooks/callback")
def quickbooks_callback(
    code: Optional[str] = None,
    state: Optional[str] = None,
    realmId: Optional[str] = None,
    error: Optional[str] = None,
    db: Session = Depends(get_db),
):
    if selected_provider_name() != "quickbooks":
        return _back("error", "not_enabled")
    # Consume the state first so it is single-use even when the user declined.
    # It also says which club's connection this is.
    owner = qbo.consume_state(db, state or "")
    if owner is None:
        return _back("error", "state")
    if error:
        return _back("error", "denied")
    if not code or not realmId:
        return _back("error", "invalid")
    previous = qbo.load_connection(db, owner)
    try:
        conn = qbo.exchange_code(db, code, realmId, owner)
    except ProviderError:
        log.warning("QuickBooks code exchange failed", exc_info=True)
        return _back("error", "token")
    # A club must hear about it whenever its books change hands.
    if previous is None or previous.realm_id != conn.realm_id:
        _notify(db, owner, "connected" if previous is None else "changed", conn.company_name)
    return _back("success")
