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

"""Sandbox-only diagnostic: find which invoice field QuickBooks rejects.

QuickBooks often answers "invalid or unsupported property" without naming the
field. This first finds which way of sending a bare invoice the company accepts
(as the app sends it, without minorversion, integer amount, with each of the
company's tax codes), then adds the app's real fields one step at a time and
prints the first step that fails. Every invoice it manages to create is
deleted again.

    docker compose exec backend python -m app.invoice_providers.quickbooks_probe

Refuses to run unless QBO_ENVIRONMENT=sandbox and a connection exists.
"""
from __future__ import annotations

import sys
from typing import Any

from ..database import SessionLocal
from ..models_team import QboCustomer
from . import quickbooks_auth as qbo
from . import quickbooks_provider as qp
from .base import ProviderError

# (label, fields added at this step)
STEPS: list[tuple[str, dict[str, Any]]] = [
    ("minimal: customer + one line", {}),
    ("+ line Description", {"desc": "Athlete fee"}),
    ("+ line Qty and UnitPrice", {"qty": True}),
    ("+ DocNumber", {"DocNumber": "PROBE-{n}"}),
    ("+ TxnDate", {"TxnDate": "2026-11-23"}),
    ("+ CustomerMemo", {"CustomerMemo": {"value": "Probe meet"}}),
    ("+ PrivateNote", {"PrivateNote": "SauvetageTeam probe"}),
    ("+ BillEmail", {"BillEmail": {"Address": "probe@example.org"}}),
    ("+ accents and an em dash in the line text", {"desc": "Néocles — Athlete fee"}),
]


def build_body(step: int, customer_id: str, item_id: str, tax_id: str | None) -> dict[str, Any]:
    """The invoice for STEPS[step]: every field of the steps before it, plus its own."""
    fields: dict[str, Any] = {}
    for _, added in STEPS[: step + 1]:
        fields.update(added)
    detail: dict[str, Any] = {"ItemRef": {"value": item_id}}
    if fields.pop("qty", False):
        detail.update({"Qty": 1, "UnitPrice": 50.0})
    if tax_id:
        detail["TaxCodeRef"] = {"value": tax_id}
    line: dict[str, Any] = {"DetailType": "SalesItemLineItemDetail", "Amount": 50.0,
                            "SalesItemLineItemDetail": detail}
    if "desc" in fields:
        line["Description"] = fields.pop("desc")
    body: dict[str, Any] = {"CustomerRef": {"value": customer_id}, "Line": [line]}
    body.update({k: (v.format(n=step) if isinstance(v, str) else v) for k, v in fields.items()})
    return body


def _post_and_delete(db, body: dict[str, Any], params: dict | None = None) -> None:
    """POST the invoice; if QuickBooks takes it, delete it again. Raises ProviderError."""
    inv = qbo.api_request(db, "POST", "invoice", params=params, json_body=body)["Invoice"]
    qbo.api_request(db, "POST", "invoice", params={"operation": "delete"},
                    json_body={"Id": inv["Id"], "SyncToken": inv["SyncToken"]})


def _variants(customer_id: str, item_id: str, tax_codes: list[dict]):
    """(label, body, query params, tax id used) — the bare invoice sent in the
    ways that could matter: as the app sends it, without minorversion, with an
    integer Amount, and once per tax code the company has."""
    base = lambda tax=None: build_body(0, customer_id, item_id, tax)  # noqa: E731
    yield "minimal, as the app sends it", base(), None, None
    yield "minimal, without minorversion", base(), {"minorversion": None}, None
    int_body = base()
    int_body["Line"][0]["Amount"] = 50
    yield "minimal, Amount as an integer", int_body, None, None
    for tc in tax_codes:
        yield f"minimal + tax code '{tc.get('Name')}' (id {tc.get('Id')})", base(str(tc["Id"])), None, str(tc["Id"])


def main() -> int:
    if qbo.environment() != "sandbox":
        print("Refusing: this probe creates (and deletes) invoices, so it only runs against the sandbox.")
        return 2
    db = SessionLocal()
    try:
        conn = qbo.load_connection(db)
        if not conn or conn.needs_reconnect:
            print("QuickBooks is not connected.")
            return 2
        row = db.query(QboCustomer).filter(QboCustomer.realm_id == conn.realm_id).first()
        if not row:
            print("No QuickBooks customer is mapped yet: push one invoice first so a customer exists.")
            return 2
        item_id = qp._item_id(db, conn.realm_id)
        info = qbo.api_request(db, "GET", f"companyinfo/{conn.realm_id}").get("CompanyInfo") or {}
        codes = (qbo.api_request(db, "GET", "query", params={"query": "select * from TaxCode"})
                 .get("QueryResponse") or {}).get("TaxCode", [])
        print(f"company {conn.realm_id} '{info.get('CompanyName')}', country {info.get('Country')}, "
              f"customer {row.customer_id}, item {item_id}")
        print("tax codes in this company: " + (", ".join(f"'{c.get('Name')}' (id {c.get('Id')})" for c in codes) or "none"))

        # 1. Which way of sending the bare invoice does QuickBooks accept?
        working_tax: str | None = None
        accepted = None
        for label, body, params, tax in _variants(row.customer_id, item_id, codes):
            try:
                _post_and_delete(db, body, params)
            except ProviderError as e:
                print(f"FAIL  {label}")
                print(f"      {e.message}")
                continue
            print(f"ok    {label}")
            accepted, working_tax = label, tax
            break
        if accepted is None:
            print("No variant of the bare invoice was accepted: the problem is not in our fields.")
            return 1
        if working_tax:
            name = next((c.get("Name") for c in codes if str(c.get("Id")) == working_tax), working_tax)
            print(f"==> this company needs a tax code on each line: set QBO_TAX_CODE={name}")

        # 2. With that settled, add our real fields one at a time.
        for i, (label, _) in enumerate(STEPS):
            body = build_body(i, row.customer_id, item_id, working_tax)
            try:
                _post_and_delete(db, body)
            except ProviderError as e:
                print(f"FAIL  step {i}  {label}")
                print(f"      {e.message}")
                print(f"      body: {body}")
                return 1
            print(f"ok    step {i}  {label}")
        print("All steps accepted: the fields are fine on their own.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
