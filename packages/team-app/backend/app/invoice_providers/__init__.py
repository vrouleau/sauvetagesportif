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

"""Invoice providers: the one place the active provider is chosen.

Stripe and QuickBooks are never used together. The choice is the
INVOICE_PROVIDER env var (`stripe` | `quickbooks`). Unset keeps the historic
behaviour: Stripe when STRIPE_API_KEY is set, otherwise no provider.
"""
from __future__ import annotations

import os
from typing import Optional

from .base import InvoiceContext, InvoiceProvider, ProviderError, PushResult

__all__ = [
    "InvoiceContext", "InvoiceProvider", "ProviderError", "PushResult",
    "PROVIDER_NONE", "selected_provider_name", "get_provider",
]

PROVIDER_NONE = "none"
_KNOWN = ("stripe", "quickbooks")


def selected_provider_name() -> str:
    """The active provider's name, or PROVIDER_NONE.

    An explicit but unknown INVOICE_PROVIDER is treated as none rather than
    silently falling back to Stripe: the operator asked for something else.
    """
    raw = (os.environ.get("INVOICE_PROVIDER") or "").strip().lower()
    if raw:
        return raw if raw in _KNOWN else PROVIDER_NONE
    return "stripe" if os.environ.get("STRIPE_API_KEY") else PROVIDER_NONE


def get_provider() -> Optional[InvoiceProvider]:
    """The active provider instance, or None when there is none."""
    name = selected_provider_name()
    if name == "stripe":
        from .stripe_provider import StripeProvider
        return StripeProvider()
    if name == "quickbooks":
        from .quickbooks_provider import QuickBooksProvider
        return QuickBooksProvider()
    return None
