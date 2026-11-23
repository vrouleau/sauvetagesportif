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

"""Stripe invoice provider (Stripe Connect: one connected account per
organizer club, stored in clubs.stripe_account_id).

Moved verbatim from routers/api.py — behaviour is unchanged.
"""
from __future__ import annotations

import os
from typing import Optional

from sqlalchemy.orm import Session

from ..models_team import TeamClub
from .base import InvoiceContext, InvoiceProvider, ProviderError, PushResult


# Map the club's 3-letter LENEX/IOC nation code to the ISO-3166 alpha-2 country
# Stripe expects. These clubs are Québec-based, so CA is both the common case
# and the safe fallback for unknown/missing codes.
_NATION_TO_ISO2 = {
    "CAN": "CA", "USA": "US", "FRA": "FR", "GBR": "GB", "MEX": "MX",
    "AUS": "AU", "NZL": "NZ", "GER": "DE", "ESP": "ES", "ITA": "IT",
    "BEL": "BE", "NED": "NL", "SUI": "CH",
}


def _club_country_iso2(club: TeamClub) -> str:
    return _NATION_TO_ISO2.get((club.nation or "").upper(), "CA")


def _public_business_url() -> str | None:
    """APP_BASE_URL only when it's a real public http(s) URL.

    Stripe's business_profile.url rejects localhost / non-public hosts ("Not a
    valid URL"), and APP_BASE_URL defaults to http://localhost:8001 in dev — so
    prefilling it blindly breaks account creation. Return None in that case and
    let Stripe collect the URL during onboarding instead.
    """
    url = (os.environ.get("APP_BASE_URL") or "").strip()
    if not url.startswith(("http://", "https://")):
        return None
    lowered = url.lower()
    if "localhost" in lowered or "127.0.0.1" in lowered or "0.0.0.0" in lowered:
        return None
    return url


def _create_connect_account(stripe, club: TeamClub):
    """Create a Standard connected account, prefilled from the club.

    Prefilling the known club info (business name, email, country, MCC) means
    Stripe's hosted onboarding wizard asks the admin fewer questions. NOTE:
    this platform's risk config requires Stripe to be the losses collector,
    which rules out Express/Custom dashboards — Standard is the only supported
    type here (verified against the Connect API). The win is the prefill +
    deferred (currently_due) fields, not a lighter account type.
    """
    business_profile = {
        "name": (club.name or None),
        "mcc": "8699",  # Membership organisations (sports clubs)
    }
    public_url = _public_business_url()
    if public_url:
        business_profile["url"] = public_url
    return stripe.Account.create(
        type="standard",
        country=_club_country_iso2(club),
        email=(club.email or None),
        business_type="non_profit",
        business_profile=business_profile,
    )


def _api_key() -> Optional[str]:
    return os.environ.get("STRIPE_API_KEY") or None


class StripeProvider(InvoiceProvider):
    name = "stripe"

    def configured(self) -> bool:
        return bool(_api_key())

    def status(self, db: Session, org_club: Optional[TeamClub]) -> dict:
        if not org_club or not org_club.stripe_account_id or not _api_key():
            return {"connected": False}
        import stripe
        stripe.api_key = _api_key()
        try:
            acct = stripe.Account.retrieve(org_club.stripe_account_id)
            return {"connected": acct.charges_enabled, "account_id": org_club.stripe_account_id}
        except Exception:
            return {"connected": False}

    def connect_start(self, db: Session, org_club: TeamClub) -> dict:
        import stripe
        stripe.api_key = _api_key()
        if not stripe.api_key:
            raise ProviderError("STRIPE_API_KEY not configured", 500)

        # If we have a stored account id, make sure it still exists on Stripe. An
        # account that was deleted/closed in the Stripe dashboard leaves a dangling
        # id here, and AccountLink.create would then 404 ("No such account"),
        # bricking the connect button. Treat a missing account as "not connected"
        # and fall through to creating a fresh one.
        if org_club.stripe_account_id:
            try:
                stripe.Account.retrieve(org_club.stripe_account_id)
            except stripe.InvalidRequestError:
                org_club.stripe_account_id = None
                db.commit()

        if not org_club.stripe_account_id:
            account = _create_connect_account(stripe, org_club)
            org_club.stripe_account_id = account.id
            db.commit()

        base_url = os.environ.get("APP_BASE_URL", "http://localhost:8001")
        link = stripe.AccountLink.create(
            account=org_club.stripe_account_id,
            refresh_url=f"{base_url}/organizer?stripe=refresh",
            return_url=f"{base_url}/organizer?stripe=success",
            type="account_onboarding",
            # Collect only what's due right now; optional fields are deferred to the
            # first payout, letting the admin finish the initial flow faster.
            collection_options={"fields": "currently_due"},
        )
        return {"url": link.url}

    def disconnect(self, db: Session, org_club: TeamClub) -> None:
        org_club.stripe_account_id = None
        db.commit()

    def push(self, ctx: InvoiceContext) -> PushResult:
        """Create and send a Stripe invoice for a club on the organizer's connected account."""
        import stripe
        stripe.api_key = _api_key()
        if not stripe.api_key:
            raise ProviderError("STRIPE_API_KEY not configured", 500)
        acct = ctx.org_club.stripe_account_id
        if not acct:
            raise ProviderError("Organizer has no connected Stripe account", 400)

        club, org_club, lang = ctx.club, ctx.org_club, ctx.lang
        meet_name, invoice_no = ctx.meet_name, ctx.invoice_no

        email = (club.email or "").strip()
        customer = None
        if email:
            existing = stripe.Customer.list(email=email, limit=1, stripe_account=acct)
            if existing.data:
                customer = existing.data[0]
        if not customer:
            customer = stripe.Customer.create(
                name=club.name,
                email=email or None,
                metadata={"meetmanager_club_id": str(club.clubsid)},
                stripe_account=acct,
            )

        # Surface the organising club on the invoice/PDF. Stripe locks the big
        # header title to the connected account's business name/website (that's
        # where "meetmanager.vrouleau.app" comes from and it can't be overridden
        # per-invoice), so we add the organiser as a labelled custom field instead.
        # Stripe caps custom_fields name/value at 30 chars each.
        # The invoice number is the same deterministic one used on the PDF and
        # the email invoice (invoices.invoice_number), independent of Stripe's own.
        custom_fields = [
            {"name": "Organisateur"[:30], "value": (org_club.name or "")[:30]},
            {"name": "N° facture"[:30], "value": invoice_no[:30]},
        ]

        invoice = stripe.Invoice.create(
            customer=customer.id,
            auto_advance=False,
            currency="cad",
            collection_method="send_invoice",
            days_until_due=30,
            description=f"{meet_name} — {'Registrations' if lang == 'en' else 'Inscriptions'}",
            custom_fields=custom_fields,
            metadata={"meetmanager_club_id": str(club.clubsid), "meetmanager_meet": meet_name,
                      "meetmanager_invoice_no": invoice_no},
            pending_invoice_items_behavior="exclude",
            stripe_account=acct,
        )

        for it in ctx.items:
            desc_parts = []
            if it.get("event_number"):
                desc_parts.append(f"#{it['event_number']}")
            if it.get("event_name"):
                desc_parts.append(it["event_name"])
            if it.get("description"):
                desc_parts.append(it["description"])
            # Use price_data (unit_amount + quantity via an inline product) instead
            # of a pre-multiplied `amount`. A lump `amount` makes Stripe render
            # Qty 1 with the unit price equal to the whole line total — that's why
            # "Frais par athlète" showed Qty 1 / CA$200 instead of Qty 4 / CA$50.
            # The product must live on the same connected account as the invoice.
            line_desc = " — ".join(desc_parts) or ("Registration" if lang == "en" else "Inscription")
            product = stripe.Product.create(name=line_desc[:250], stripe_account=acct)
            stripe.InvoiceItem.create(
                customer=customer.id,
                invoice=invoice.id,
                price_data={
                    "currency": "cad",
                    "product": product.id,
                    "unit_amount": it["unit_cents"],
                },
                quantity=it["qty"],
                description=line_desc,
                stripe_account=acct,
            )

        stripe.Invoice.finalize_invoice(invoice.id, stripe_account=acct)
        stripe.Invoice.send_invoice(invoice.id, stripe_account=acct)
        return PushResult(external_id=invoice.id)
