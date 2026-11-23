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

The OAuth connection lives in quickbooks_auth. `push` creates the club's
invoice in the Société's QuickBooks company — and only creates it: the invoice
is never emailed from here, the Société sends it from QuickBooks.

What a pushed invoice looks like (decisions in docs/QUICKBOOKS_PLAN.md):
- Customer = the club. Found through the stored club -> customer mapping, else
  by exact DisplayName (an existing customer is reused), else created.
- DocNumber = our invoice number without any `-Rn` revision suffix.
- One line per invoice item (per athlete, plus meet-level fees), all against a
  single service Item, tax-exempt, with the breakdown in the line description.
- Idempotent: a re-push finds the invoice it already created (by the id we
  recorded, else by DocNumber) and does not create a second one.
- If the club's entries changed since, that same invoice is updated (its lines
  are replaced; it keeps its number) — unless QuickBooks shows a payment, a
  credit or a void on it, in which case the push is refused (409).
"""
from __future__ import annotations

import os
import re
from datetime import date
from typing import Any, Optional

from sqlalchemy.orm import Session

from ..models_team import QboCustomer, TeamClub
from . import quickbooks_auth as qbo
from .base import InvoiceContext, InvoiceProvider, ProviderError, PushResult

DEFAULT_ITEM_NAME = "Frais d'inscription"
DEFAULT_TAX_CODE = "Exempt"
NOT_FOUND = "610"  # QuickBooks error code: object not found
STALE_OBJECT = "5010"  # QuickBooks error code: the invoice changed since we read it

# (kind, realm, name) -> QuickBooks id. The Item and tax code are looked up
# once per process and company, not once per invoice.
_lookup_cache: dict[tuple[str, str, str], Optional[str]] = {}


def _q(value: str) -> str:
    """Escape a value for a QuickBooks query string literal."""
    return value.replace("\\", "\\\\").replace("'", "\\'")


def _query(db: Session, entity: str, field: str, value: str) -> list[dict]:
    sql = f"select * from {entity} where {field} = '{_q(value)}'"
    out = qbo.api_request(db, "GET", "query", params={"query": sql})
    return (out.get("QueryResponse") or {}).get(entity, [])


def doc_number(invoice_no: str) -> str:
    """The QuickBooks DocNumber: our invoice number minus any `-Rn` suffix.

    A changed total updates the same QuickBooks invoice (it keeps its number),
    whereas the PDF/email numbers move on to `-R2`.
    """
    return re.sub(r"-R\d+$", "", invoice_no)


def _display_name(club: TeamClub) -> str:
    # QuickBooks forbids ':' in names (it marks a sub-customer) and caps them at 500.
    name = (club.name or "").replace(":", "-").strip()[:500]
    return name or f"Club {club.clubsid}"


def _customer_id(db: Session, club: TeamClub, realm: str) -> str:
    row = db.get(QboCustomer, (club.clubsid, realm))
    if row:
        try:
            cust = qbo.api_request(db, "GET", f"customer/{row.customer_id}").get("Customer") or {}
            if cust.get("Active", True):
                return row.customer_id
        except ProviderError as e:
            if e.code != NOT_FOUND:
                raise
        # deleted or deactivated in QuickBooks: resolve again below

    name = _display_name(club)
    found = _query(db, "Customer", "DisplayName", name)
    if found:
        customer_id = str(found[0]["Id"])
    else:
        body: dict[str, Any] = {"DisplayName": name}
        email = (club.email or "").strip()
        if email:
            body["PrimaryEmailAddr"] = {"Address": email}
        customer_id = str(qbo.api_request(db, "POST", "customer", json_body=body)["Customer"]["Id"])

    if row:
        row.customer_id = customer_id
    else:
        db.add(QboCustomer(clubsid=club.clubsid, realm_id=realm, customer_id=customer_id))
    db.commit()  # keep the mapping even if the invoice itself then fails
    return customer_id


def _item_id(db: Session, realm: str) -> str:
    name = (os.environ.get("QBO_ITEM_NAME") or "").strip() or DEFAULT_ITEM_NAME
    key = ("item", realm, name)
    if _lookup_cache.get(key):
        return _lookup_cache[key]
    found = _query(db, "Item", "Name", name)
    if found:
        item_id = str(found[0]["Id"])
    else:
        account_name = (os.environ.get("QBO_INCOME_ACCOUNT") or "").strip()
        if not account_name:
            raise ProviderError(
                f"QuickBooks item '{name}' not found: create it in QuickBooks (a Service item "
                f"linked to the income account), or set QBO_INCOME_ACCOUNT so it can be created", 400)
        accounts = _query(db, "Account", "Name", account_name)
        if not accounts:
            raise ProviderError(f"QuickBooks income account '{account_name}' not found", 400)
        item_id = str(qbo.api_request(db, "POST", "item", json_body={
            "Name": name, "Type": "Service",
            "IncomeAccountRef": {"value": str(accounts[0]["Id"])},
        })["Item"]["Id"])
    _lookup_cache[key] = item_id
    return item_id


def _tax_code_id(db: Session, realm: str) -> Optional[str]:
    """The exempt tax code every line carries; None when QBO_TAX_CODE=none."""
    name = (os.environ.get("QBO_TAX_CODE") or "").strip() or DEFAULT_TAX_CODE
    if name.lower() == "none":
        return None
    key = ("tax", realm, name)
    if _lookup_cache.get(key):
        return _lookup_cache[key]
    found = _query(db, "TaxCode", "Name", name)
    if not found:
        raise ProviderError(
            f"QuickBooks tax code '{name}' not found: set QBO_TAX_CODE to the exact name of the "
            f"exempt tax code in the company file, or to 'none' if it does not track taxes", 400)
    _lookup_cache[key] = str(found[0]["Id"])
    return _lookup_cache[key]


def _line(it: dict, lang: str, item_id: str, tax_id: Optional[str]) -> dict:
    parts = []
    if it.get("event_number"):
        parts.append(f"#{it['event_number']}")
    if it.get("event_name"):
        parts.append(it["event_name"])
    if it.get("description"):
        parts.append(it["description"])
    desc = " — ".join(parts) or ("Registration" if lang == "en" else "Inscription")
    detail: dict[str, Any] = {
        "ItemRef": {"value": item_id},
        "Qty": it["qty"],
        "UnitPrice": round(it["unit_cents"] / 100, 2),
    }
    if tax_id:
        detail["TaxCodeRef"] = {"value": tax_id}
    return {
        "DetailType": "SalesItemLineDetail",
        "Amount": round(it["unit_cents"] * it["qty"] / 100, 2),
        "Description": desc[:4000],
        "SalesItemLineDetail": detail,
    }


def _line_key(line: dict) -> tuple:
    """What makes a sales line the same line: text, amount, quantity, unit price."""
    d = line.get("SalesItemLineDetail") or {}
    return ((line.get("Description") or "").strip(), round(float(line.get("Amount", 0)), 2),
            round(float(d.get("Qty", 1)), 4), round(float(d.get("UnitPrice", 0)), 2))


def _same_lines(invoice: dict, desired: list[dict]) -> bool:
    """Whether the invoice already carries exactly these lines (its automatic
    subtotal line is ignored), so a re-push with nothing changed touches nothing."""
    sales = lambda lines: [_line_key(ln) for ln in lines if ln.get("DetailType") == "SalesItemLineDetail"]  # noqa: E731
    return sales(invoice.get("Line", [])) == sales(desired)


def _cents(value: Any) -> int:
    return round(float(value or 0) * 100)


def _refuse_if_settled(invoice: dict, number: str) -> None:
    """Never rewrite an invoice somebody has started to settle.

    A payment or credit lowers the Balance below the total; a voided invoice
    has both at zero. Either way the books were touched after our push, so the
    Société fixes it in QuickBooks (credit note or new invoice).
    """
    total, balance = _cents(invoice.get("TotalAmt")), _cents(invoice.get("Balance"))
    if total == 0 and balance == 0:
        raise ProviderError(f"Invoice {number} is voided (or zero) in QuickBooks; "
                            f"it cannot be updated from here", 409)
    if balance != total:
        raise ProviderError(f"Invoice {number} already has a payment or credit in QuickBooks; "
                            f"adjust it there instead", 409)


def _sync_existing(db: Session, realm: str, number: str, invoice: dict, lines: list[dict]) -> PushResult:
    """Bring an existing QuickBooks invoice in line with the club's current
    entries: nothing if it already matches, else replace its lines.

    The update is sparse (only `Line`), which replaces the whole line array and
    keeps the DocNumber, date, customer and memo. If QuickBooks says the
    invoice changed meanwhile (stale SyncToken) it is re-read and every check is
    made again — a payment may have landed in between.
    """
    invoice_id = str(invoice["Id"])
    for attempt in (1, 2):
        if _same_lines(invoice, lines):
            return PushResult(external_id=invoice_id, account=realm, action="unchanged")
        _refuse_if_settled(invoice, number)
        try:
            qbo.api_request(db, "POST", "invoice", json_body={
                "Id": invoice_id, "SyncToken": str(invoice["SyncToken"]), "sparse": True, "Line": lines,
            })
            return PushResult(external_id=invoice_id, account=realm, action="updated")
        except ProviderError as e:
            if e.code != STALE_OBJECT or attempt == 2:
                raise
        invoice = qbo.api_request(db, "GET", f"invoice/{invoice_id}")["Invoice"]
    raise AssertionError("unreachable")  # pragma: no cover


def _find_existing(ctx: InvoiceContext, realm: str, number: str) -> Optional[dict]:
    """The invoice an earlier push created, if any: by the id we recorded, else
    by DocNumber (covers a crash between creating it and recording it)."""
    db = ctx.db
    if ctx.prior_external_id and ctx.prior_account == realm:
        try:
            return qbo.api_request(db, "GET", f"invoice/{ctx.prior_external_id}").get("Invoice")
        except ProviderError as e:
            if e.code != NOT_FOUND:
                raise
            # deleted in QuickBooks: fall through and look by number
    found = _query(db, "Invoice", "DocNumber", number)
    return found[0] if found else None


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
        db = ctx.db
        _, realm = qbo.get_access_token(db)  # not connected -> ProviderError
        number = doc_number(ctx.invoice_no)

        item_id = _item_id(db, realm)
        tax_id = _tax_code_id(db, realm)
        lines = [_line(it, ctx.lang, item_id, tax_id) for it in ctx.items]

        existing = _find_existing(ctx, realm, number)
        if existing:
            return _sync_existing(db, realm, number, existing, lines)

        customer_id = _customer_id(db, ctx.club, realm)

        body: dict[str, Any] = {
            "CustomerRef": {"value": customer_id},
            "DocNumber": number,
            "TxnDate": date.today().isoformat(),
            "CustomerMemo": {"value": ctx.meet_name[:1000]},
            "PrivateNote": f"SauvetageTeam — {ctx.meet_name} — club {ctx.club.clubsid}",
            "Line": lines,
        }
        email = (ctx.club.email or "").strip()
        if email:
            body["BillEmail"] = {"Address": email}  # for the Société's later send; nothing is sent now
        out = qbo.api_request(db, "POST", "invoice", json_body=body)
        return PushResult(external_id=str(out["Invoice"]["Id"]), account=realm)
