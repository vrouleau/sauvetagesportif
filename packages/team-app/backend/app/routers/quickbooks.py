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

"""QuickBooks OAuth callback.

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
    if not qbo.consume_state(db, state or ""):
        return _back("error", "state")
    if error:
        return _back("error", "denied")
    if not code or not realmId:
        return _back("error", "invalid")
    try:
        qbo.exchange_code(db, code, realmId)
    except ProviderError:
        log.warning("QuickBooks code exchange failed", exc_info=True)
        return _back("error", "token")
    return _back("success")
