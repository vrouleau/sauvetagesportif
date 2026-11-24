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

"""Export a meet's club invoices as QuickBooks Online import files.

QuickBooks Online can import invoices (and customers) from a CSV file, so a
club that bills the others from QuickBooks can load the invoices without any
connection between the two systems: Settings > Import data > Customers, then
Invoices. Intuit's limits shape the output (docs: "Import multiple invoices at
once in QuickBooks Online"): at most 100 invoices and 1,000 rows per file, no
negative lines, every line carries an item, an amount and a tax code, and the
customer of an invoice must already exist under exactly that name.

Everything here is pure (no database, no clock of its own): the router gathers
what to export, this turns it into files. The invoice content is the same as
the PDF's — the per-athlete lines of `invoices._club_line_items` and the same
`YEAR-MEET-CLUB` number — so the file and the PDF always agree.
"""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Iterable, Sequence

from .i18n import t

MAX_INVOICES_PER_FILE = 100   # Intuit's limit per import
MAX_ROWS_PER_FILE = 1000      # Intuit's limit per spreadsheet

DEFAULT_ITEM_NAME = "Frais d'inscription"
DEFAULT_TAX_CODE = "Exempt"
DEFAULT_DUE_DAYS = 30

# Column headers of Intuit's own sample invoice file (the Canadian multi-currency
# one, checked against a real download), in its order. The import wizard maps
# columns by header text, so these are kept exactly.
INVOICE_HEADERS = [
    "*InvoiceNo", "*Customer", "*InvoiceDate", "*DueDate", "Terms", "Location", "Memo",
    "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "*ItemAmount",
    "*ItemTaxCode", "ItemTaxAmount", "Currency", "Note to customer",
]
CUSTOMER_HEADERS = ["Name", "Company", "Email"]


@dataclass
class ExportOptions:
    item_name: str = DEFAULT_ITEM_NAME   # the product/service every line is booked against
    tax_code: str = DEFAULT_TAX_CODE     # the company's exempt tax code, exactly as it names it
    due_days: int = DEFAULT_DUE_DAYS     # due date = invoice date + this many days


def options_from(raw: dict | None, base: ExportOptions | None = None) -> ExportOptions:
    """ExportOptions from a loose dict (a request, or what was stored): a missing
    or blank field keeps `base` (default: the defaults); due_days is clamped to
    0..365. Raises ValueError when due_days is not a number."""
    base = base or ExportOptions()
    raw = raw or {}
    item = str(raw.get("item_name") or "").strip()[:100] or base.item_name
    tax = str(raw.get("tax_code") or "").strip()[:100] or base.tax_code
    days = base.due_days
    if raw.get("due_days") not in (None, ""):
        try:
            days = max(0, min(365, int(raw["due_days"])))
        except (TypeError, ValueError):
            raise ValueError("due_days must be a number")
    return ExportOptions(item_name=item, tax_code=tax, due_days=days)


@dataclass
class ExportEntry:
    """One club's invoice, ready to export."""
    name: str                # the club
    email: str
    invoice_no: str
    items: Sequence[dict]    # invoices._club_line_items output


def customer_name(club_name: str, club_id: int | None = None) -> str:
    """The customer name QuickBooks will hold: no ':' (it marks a sub-customer
    there), trimmed, never empty. Used for both files so they always match."""
    name = re.sub(r"\s+", " ", (club_name or "").replace(":", "-")).strip()[:100]
    return name or (f"Club {club_id}" if club_id is not None else "Club")


def doc_number(invoice_no: str) -> str:
    """The invoice number without a `-Rn` revision suffix (QuickBooks keeps the
    original number when an invoice changes; the PDF moves on to -R2)."""
    return re.sub(r"-R\d+$", "", invoice_no)


def _money(cents: int) -> str:
    return f"{cents / 100:.2f}"


def _date(d: date) -> str:
    return d.strftime("%d/%m/%Y")  # dd/MM/yyyy: the unambiguous choice in the import wizard


def _clean(text: str) -> str:
    """One line of plain text: QuickBooks' importer dislikes line breaks, and the
    em dash our descriptions use elsewhere is a "special character" to it."""
    return re.sub(r"\s+", " ", (text or "").replace("—", "-").replace("–", "-")).strip()


def line_description(item: dict, lang: str = "fr") -> str:
    parts = []
    if item.get("event_number"):
        parts.append(f"#{item['event_number']}")
    if item.get("event_name"):
        parts.append(item["event_name"])
    if item.get("description"):
        parts.append(item["description"])
    return _clean(" - ".join(parts)) or t("invoice.line_fallback", lang)


def invoice_rows(entry: ExportEntry, meet_name: str, today: date, options: ExportOptions,
                 lang: str = "fr") -> list[list[str]]:
    """The CSV rows of one invoice, laid out like Intuit's sample: the invoice
    number on every line, but the customer, dates and memo only on the first one
    (later lines, with no customer, continue the invoice above)."""
    due = today + timedelta(days=max(0, options.due_days))
    customer = customer_name(entry.name)
    number = doc_number(entry.invoice_no)
    rows = []
    for i, it in enumerate(entry.items):
        qty, unit = it["qty"], it["unit_cents"]
        first = i == 0
        rows.append([
            number,
            customer if first else "",
            _date(today) if first else "",
            _date(due) if first else "",
            "", "",                                           # Terms, Location
            _clean(meet_name)[:1000] if first else "",        # Memo
            _clean(options.item_name) or DEFAULT_ITEM_NAME, line_description(it, lang),
            str(qty), _money(unit), _money(qty * unit),
            _clean(options.tax_code), "",                     # ItemTaxCode, ItemTaxAmount
            "", "",                                           # Currency (company default), Note to customer
        ])
    return rows


def _csv(headers: list[str], rows: Iterable[list[str]]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(headers)
    w.writerows(rows)
    return buf.getvalue().encode("utf-8-sig")  # BOM: Excel reads accents correctly


def split_into_files(invoices: list[list[list[str]]]) -> list[list[list[str]]]:
    """Group invoices into files within Intuit's limits. An invoice is never cut
    across two files; one that alone exceeds the row limit gets a file of its own."""
    files: list[list[list[str]]] = []
    current: list[list[str]] = []
    count = 0
    for rows in invoices:
        if current and (count >= MAX_INVOICES_PER_FILE or len(current) + len(rows) > MAX_ROWS_PER_FILE):
            files.append(current)
            current, count = [], 0
        current.extend(rows)
        count += 1
    if current:
        files.append(current)
    return files


def build_files(entries: Sequence[ExportEntry], meet_name: str, today: date,
                options: ExportOptions | None = None, lang: str = "fr") -> dict[str, bytes]:
    """`{filename: bytes}`: the customers file, the invoices file(s) and a short
    how-to. Entries without any line are skipped (nothing to bill)."""
    options = options or ExportOptions()
    billable = [e for e in entries if e.items]
    if not billable:
        raise ValueError("No billable clubs in selection")

    # one customer per distinct name, in a stable order
    seen: dict[str, str] = {}
    for e in billable:
        seen.setdefault(customer_name(e.name), (e.email or "").strip())
    files: dict[str, bytes] = {
        "1-customers.csv": _csv(CUSTOMER_HEADERS, [[n, n, email] for n, email in seen.items()]),
    }
    chunks = split_into_files([invoice_rows(e, meet_name, today, options, lang) for e in billable])
    for i, rows in enumerate(chunks, 1):
        suffix = f"-{i}" if len(chunks) > 1 else ""
        files[f"2-invoices{suffix}.csv"] = _csv(INVOICE_HEADERS, rows)
    files["README.txt"] = readme(len(billable), len(chunks), options, lang).encode("utf-8")
    return files


def readme(n_invoices: int, n_files: int, options: ExportOptions, lang: str = "fr") -> str:
    return t("quickbooks.readme", lang, n_invoices=n_invoices, n_files=n_files,
             item_name=options.item_name, tax_code=options.tax_code)
