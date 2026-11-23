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
field. This posts the same invoice in growing steps — a bare minimum first,
then one more field each time — and prints the first step that fails. Every
invoice it manages to create is deleted again.

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
        tax_id = qp._tax_code_id(db, conn.realm_id)
        print(f"company {conn.realm_id}, customer {row.customer_id}, item {item_id}, tax code {tax_id}")
        for i, (label, _) in enumerate(STEPS):
            body = build_body(i, row.customer_id, item_id, tax_id)
            try:
                inv = qbo.api_request(db, "POST", "invoice", json_body=body)["Invoice"]
            except ProviderError as e:
                print(f"FAIL  step {i}  {label}\n      {e.message}")
                print(f"      body: {body}")
                return 1
            print(f"ok    step {i}  {label}")
            qbo.api_request(db, "POST", "invoice", params={"operation": "delete"},
                            json_body={"Id": inv["Id"], "SyncToken": inv["SyncToken"]})
        print("All steps accepted: the fields are fine on their own.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
