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

MAX_INVOICES_PER_FILE = 100   # Intuit's limit per import
MAX_ROWS_PER_FILE = 1000      # Intuit's limit per spreadsheet

DEFAULT_ITEM_NAME = "Frais d'inscription"
DEFAULT_TAX_CODE = "Exempt"
DEFAULT_DUE_DAYS = 30

# Column headers of Intuit's sample invoice file. The import wizard also lets
# the user map columns by hand, so a different spelling is not fatal.
INVOICE_HEADERS = [
    "*InvoiceNo", "*Customer", "*InvoiceDate", "*DueDate", "Terms", "Location", "Memo",
    "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "*ItemAmount",
    "*ItemTaxCode", "ItemTaxAmount", "Service Date",
]
CUSTOMER_HEADERS = ["Name", "Company", "Email"]


@dataclass
class ExportOptions:
    item_name: str = DEFAULT_ITEM_NAME   # the product/service every line is booked against
    tax_code: str = DEFAULT_TAX_CODE     # the company's exempt tax code, exactly as it names it
    due_days: int = DEFAULT_DUE_DAYS     # due date = invoice date + this many days


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
    return _clean(" - ".join(parts)) or ("Registration" if lang == "en" else "Inscription")


def invoice_rows(entry: ExportEntry, meet_name: str, today: date, options: ExportOptions,
                 lang: str = "fr") -> list[list[str]]:
    """The CSV rows of one invoice: the header fields repeat on every line."""
    due = today + timedelta(days=max(0, options.due_days))
    customer = customer_name(entry.name)
    rows = []
    for it in entry.items:
        qty, unit = it["qty"], it["unit_cents"]
        rows.append([
            doc_number(entry.invoice_no), customer, _date(today), _date(due), "", "",
            _clean(meet_name)[:1000],
            _clean(options.item_name) or DEFAULT_ITEM_NAME, line_description(it, lang),
            str(qty), _money(unit), _money(qty * unit),
            _clean(options.tax_code), "", "",
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
    if lang == "en":
        return (
            f"QuickBooks Online import - {n_invoices} invoice(s) in {n_files} file(s)\r\n\r\n"
            "1. Settings > Import data > Customers: upload 1-customers.csv.\r\n"
            "   Skip this step for clubs that already exist as customers (QuickBooks cannot\r\n"
            "   import a name that already exists, and the invoice must use the exact same name).\r\n"
            f"2. Make sure the product/service \"{options.item_name}\" exists (create it once, linked to\r\n"
            "   your income account).\r\n"
            "3. Settings > Import data > Invoices: upload each 2-invoices*.csv file, map the columns\r\n"
            f"   if asked, pick the date format dd/MM/yyyy. The tax code on every line is\r\n"
            f"   \"{options.tax_code}\": it must be the exact name of your exempt tax code.\r\n\r\n"
            "Importing the same invoice number twice is refused or duplicated: if a club changes its\r\n"
            "entries afterwards, correct that invoice in QuickBooks.\r\n"
        )
    return (
        f"Import QuickBooks Online - {n_invoices} facture(s) dans {n_files} fichier(s)\r\n\r\n"
        "1. Paramètres > Importer des données > Clients : téléversez 1-customers.csv.\r\n"
        "   Sautez cette étape pour les clubs déjà clients (QuickBooks ne peut pas importer un nom\r\n"
        "   qui existe déjà, et la facture doit porter exactement le même nom).\r\n"
        f"2. Vérifiez que le produit/service \"{options.item_name}\" existe (à créer une fois, lié à\r\n"
        "   votre compte de revenus).\r\n"
        "3. Paramètres > Importer des données > Factures : téléversez chaque fichier 2-invoices*.csv,\r\n"
        "   associez les colonnes au besoin, choisissez le format de date jj/MM/aaaa (dd/MM/yyyy).\r\n"
        f"   Le code de taxe de chaque ligne est \"{options.tax_code}\" : ce doit être le nom exact\r\n"
        "   de votre code de taxe exonéré.\r\n\r\n"
        "Importer deux fois le même numéro de facture est refusé ou crée un doublon : si un club\r\n"
        "modifie ses inscriptions ensuite, corrigez cette facture dans QuickBooks.\r\n"
    )
