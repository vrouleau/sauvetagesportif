"""Unit tests for pushing an invoice to QuickBooks: customer resolution, the
invoice payload, idempotency, setup lookups (Item, tax code), the router
wiring that records where an invoice went, and migration 0009. QuickBooks is
an in-memory fake behind an httpx MockTransport — no network, no Docker.

Run: `pytest tests/unit/test_quickbooks_push.py -v`
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, BsGlobal
from app import models_team, models_live, models_serc  # noqa: F401 — register tables
from app.models_team import ClubMeetInvite, Meet as TeamMeet, QboCustomer, TeamClub
from app.meet_config import _set_organizer_club_id
from app.invoice_providers import InvoiceContext, ProviderError, quickbooks_auth as qbo
from app.invoice_providers import quickbooks_provider as qp
from app.invoice_providers.quickbooks_provider import QuickBooksProvider, doc_number
from app.invoice_providers.stripe_provider import StripeProvider
from app.invoices import record_invoice_sent
from app.routers import api

REALM = "R1"

# What the fake QuickBooks accepts: ONLY property names that appeared in real
# Intuit sandbox responses (captured 2026-11-23) or in Intuit's documented
# create examples. Anything else is refused with error 2010, like the real API,
# so a misremembered name fails a test instead of the first real push (the
# lesson of "SalesItemLineItemDetail", which Intuit's API does not know).
REAL_INVOICE_PROPS = {
    "Id", "SyncToken", "sparse", "MetaData", "domain", "DocNumber", "TxnDate", "CurrencyRef", "CustomField",
    "LinkedTxn", "Line", "TxnTaxDetail", "CustomerRef", "CustomerMemo", "BillAddr", "ShipAddr", "SalesTermRef",
    "DueDate", "TotalAmt", "ApplyTaxAfterDiscount", "PrintStatus", "EmailStatus", "BillEmail", "Balance",
    "PrivateNote", "AllowOnlinePayment", "AllowIPNPayment", "FreeFormAddress",
}
REAL_LINE_PROPS = {"Id", "LineNum", "Description", "Amount", "DetailType", "SalesItemLineDetail",
                   "SubTotalLineDetail", "DiscountLineDetail", "LinkedTxn", "CustomExtensions"}
REAL_DETAIL_TYPES = {"SalesItemLineDetail", "SubTotalLineDetail", "DiscountLineDetail", "DescriptionOnly"}
REAL_SALES_LINE_PROPS = {"ItemRef", "UnitPrice", "Qty", "ItemAccountRef", "TaxCodeRef", "ServiceDate"}
REAL_CUSTOMER_PROPS = {"Id", "SyncToken", "sparse", "DisplayName", "PrimaryEmailAddr", "CompanyName", "GivenName",
                       "FamilyName", "BillAddr", "Notes", "Active", "CurrencyRef", "DefaultTaxCodeRef"}
REAL_ITEM_PROPS = {"Id", "SyncToken", "sparse", "Name", "Type", "IncomeAccountRef", "Active", "UnitPrice",
                   "Taxable", "Description", "TrackQtyOnHand", "ExpenseAccountRef"}


class FakeQbo:
    """A tiny QuickBooks: customers, items, accounts, tax codes and invoices."""

    def __init__(self):
        self.customers = {}
        self.items = {"7": {"Id": "7", "Name": "Frais d'inscription", "Type": "Service"}}
        self.accounts = {"30": {"Id": "30", "Name": "Revenus - Inscriptions", "AccountType": "Income"},
                         "31": {"Id": "31", "Name": "Banque", "AccountType": "Bank"}}
        self.taxcodes = {"4": {"Id": "4", "Name": "Exempt"}}
        self.invoices = {}
        self.log: list[tuple[str, str]] = []
        self.raw: list[tuple[bytes, str]] = []  # (request body, content-type)
        self.fail_invoice = None
        self.reject_key = None  # reject any invoice body carrying this property
        self.require_tax = False  # reject invoice lines that carry no TaxCodeRef
        self.updates: list[dict] = []  # bodies of invoice updates (POST with an Id)
        self.queries: list[str] = []   # every /query statement received
        self.stale_once = None  # callable(invoice): simulate someone else saving first
        self.urls: list[str] = []
        self._ids = iter(range(100, 10_000))

    def calls(self, method, path):
        return [1 for m, p in self.log if m == method and p.startswith(path)]

    def _fault(self, status, code, message):
        return httpx.Response(status, json={"Fault": {"Error": [{"Message": message, "Detail": "", "code": code}]}})

    @staticmethod
    def _invalid_property(path: str, body: dict):
        """The first property real QuickBooks would not recognise, else None."""
        allowed = {"invoice": REAL_INVOICE_PROPS, "customer": REAL_CUSTOMER_PROPS, "item": REAL_ITEM_PROPS}.get(path)
        if allowed is None:
            return None
        for key in body:
            if key not in allowed:
                return key
        for ref in ("CustomerRef", "IncomeAccountRef"):  # references are {"value": "<string id>"}
            if ref in body and not isinstance(body[ref].get("value"), str):
                return f"{ref}.value"
        if path != "invoice":
            return None
        for line in body.get("Line", []):
            for key in line:
                if key not in REAL_LINE_PROPS:
                    return f"Line.{key}"
            kind = line.get("DetailType")
            if kind not in REAL_DETAIL_TYPES:
                return "Line.DetailType"
            if kind not in line:  # the detail object is named after the type
                return f"Line.{kind}"
            if not isinstance(line.get("Amount"), (int, float)):
                return "Line.Amount"
            if kind == "SalesItemLineDetail":
                detail = line[kind]
                for key in detail:
                    if key not in REAL_SALES_LINE_PROPS:
                        return f"Line.SalesItemLineDetail.{key}"
                for num in ("Qty", "UnitPrice"):
                    if num in detail and not isinstance(detail[num], (int, float)):
                        return f"Line.SalesItemLineDetail.{num}"
                for ref in ("ItemRef", "TaxCodeRef"):
                    if ref in detail and not isinstance(detail[ref].get("value"), str):
                        return f"Line.SalesItemLineDetail.{ref}.value"
        return None

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = urlparse(str(request.url)).path.split(f"/v3/company/{REALM}/", 1)[-1]
        self.log.append((request.method, path))
        self.urls.append(str(request.url))
        self.raw.append((request.content, request.headers.get("content-type", "")))
        body = json.loads(request.content) if request.content else None
        if request.method == "POST" and body is not None:
            bad = self._invalid_property(path.split("?")[0], body)
            if bad:
                return self._fault(400, "2010", f"Request has invalid or unsupported property Property Name:{bad}")

        if request.method == "GET" and path == "query":
            sql = parse_qs(urlparse(str(request.url)).query)["query"][0]
            self.queries.append(sql)
            # the settings dropdowns: a list of active entries, optionally of one kind
            lst = re.fullmatch(r"select (\w+) from (\w+) where Active = true(?: and (\w+) = '(.*)')? maxresults \d+", sql)
            if lst:
                col, entity, field, value = lst.groups()
                pool = {"Item": self.items, "Account": self.accounts, "TaxCode": self.taxcodes}[entity]
                hits = [{col: r[col]} for r in pool.values()
                        if r.get("Active", True) and (field is None or r.get(field) == value)]
                return httpx.Response(200, json={"QueryResponse": {entity: hits} if hits else {}})
            m = re.fullmatch(r"select [\w\s,*]+ from (\w+)(?: where (\w+) (?:= '(.*)'|in \((.*)\)))?", sql)
            assert m, sql
            entity, field, raw, id_list = m.groups()
            pool = {"Customer": self.customers, "Item": self.items, "Account": self.accounts,
                    "TaxCode": self.taxcodes, "Invoice": self.invoices}[entity]
            if field is None:  # no where clause: everything
                hits = list(pool.values())
            elif id_list is not None:  # where Id in ('1', '2')
                wanted = set(re.findall(r"'([^']*)'", id_list))
                hits = [r for r in pool.values() if str(r.get(field)) in wanted]
            else:
                value = re.sub(r"\\(.)", r"\1", raw)  # undo \' and \\
                hits = [r for r in pool.values() if r.get(field) == value and r.get("Active", True)]
            return httpx.Response(200, json={"QueryResponse": {entity: hits} if hits else {}})

        if request.method == "GET" and path.startswith("companyinfo/"):
            return httpx.Response(200, json={"CompanyInfo": {"CompanyName": "Sandbox Co", "Country": "CA"}})

        for kind, pool in (("customer", self.customers), ("invoice", self.invoices)):
            if request.method == "GET" and path.startswith(f"{kind}/"):
                rec = pool.get(path.split("/")[1])
                if not rec:
                    return self._fault(400, "610", "Object Not Found")
                return httpx.Response(200, json={kind.capitalize(): rec})

        if request.method == "POST" and path == "customer":
            cid = str(next(self._ids))
            self.customers[cid] = {"Id": cid, "Active": True, **body}
            return httpx.Response(200, json={"Customer": self.customers[cid]})
        if request.method == "POST" and path == "item":
            iid = str(next(self._ids))
            self.items[iid] = {"Id": iid, **body}
            return httpx.Response(200, json={"Item": self.items[iid]})
        if request.method == "POST" and path == "invoice" and "operation=delete" in str(request.url):
            self.invoices.pop(body["Id"], None)
            return httpx.Response(200, json={"Invoice": {"Id": body["Id"], "status": "Deleted"}})
        if request.method == "POST" and path == "invoice" and body.get("Id"):
            inv = self.invoices.get(body["Id"])
            if not inv:
                return self._fault(400, "610", "Object Not Found")
            if self.stale_once:
                hook, self.stale_once = self.stale_once, None
                inv["SyncToken"] = str(int(inv["SyncToken"]) + 1)  # someone else saved first
                hook(inv)
            if inv["SyncToken"] != body["SyncToken"]:
                return self._fault(400, "5010", "Stale Object Error")
            self.updates.append(body)
            paid = round(inv["TotalAmt"] - inv["Balance"], 2)
            inv["Line"] = body["Line"]  # sparse update: the whole line array is replaced
            inv["TotalAmt"] = round(sum(ln["Amount"] for ln in body["Line"]), 2)
            inv["Balance"] = round(inv["TotalAmt"] - paid, 2)
            inv["SyncToken"] = str(int(inv["SyncToken"]) + 1)
            return httpx.Response(200, json={"Invoice": inv})
        if request.method == "POST" and path == "invoice":
            if self.require_tax and any("TaxCodeRef" not in ln["SalesItemLineDetail"] for ln in body["Line"]):
                return self._fault(400, "2010", "Request has invalid or unsupported property")
            if self.reject_key and self.reject_key in body:
                return self._fault(400, "2010", "Request has invalid or unsupported property")
            if self.fail_invoice:
                return self._fault(400, "6000", self.fail_invoice)
            iid = str(next(self._ids))
            total = round(sum(line["Amount"] for line in body["Line"]), 2)
            self.invoices[iid] = {"Id": iid, "SyncToken": "0", "TotalAmt": total, "Balance": total, **body}
            return httpx.Response(200, json={"Invoice": self.invoices[iid]})
        return httpx.Response(404)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for k in ("INVOICE_PROVIDER", "QBO_ENVIRONMENT", "QBO_API_BASE", "QBO_TOKEN_URL"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SECRET_KEY", "test-secret-key")
    monkeypatch.setenv("QBO_CLIENT_ID", "cid")
    monkeypatch.setenv("QBO_CLIENT_SECRET", "csecret")
    qp._lookup_cache.clear()


@pytest.fixture
def qb(monkeypatch):
    fake = FakeQbo()
    monkeypatch.setattr(qbo, "_transport", httpx.MockTransport(fake.handler))
    return fake


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'push.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    s.add(TeamMeet(meetsid=1, name="M", meetstate=0, registration_open=True))
    s.add(TeamClub(clubsid=10, name="Société", pin="111111", email="soc@x.ca"))
    s.add(TeamClub(clubsid=20, name="Club d'Alma: Nord", pin="222222", email="alma@x.ca"))
    s.add(TeamClub(clubsid=30, name="Club B", pin="333333", email=""))
    s.commit()
    now = time.time()
    # the connection belongs to the organizer club (10), as in the app
    qbo.save_connection(s, qbo.Connection(
        realm_id=REALM, access_token="tok", access_expires_at=now + 3000, refresh_token="rt",
        refresh_expires_at=now + 90 * 86400, environment="sandbox", refreshed_at=now), owner=10)
    yield s
    s.close()
    engine.dispose()


ITEMS = [
    {"event_number": None, "event_name": "TREMBLAY, Anne", "description": "Frais d'athlète $5.00, 2 individuelles",
     "qty": 1, "unit_cents": 2500},
    {"event_number": None, "event_name": "Frais de club", "description": "", "qty": 2, "unit_cents": 1000},
]
TOTAL = 4500


def _ctx(db, club_id=20, items=ITEMS, total=TOTAL, invoice_no="2026-001-0020", prior=None, **kw):
    return InvoiceContext(
        db=db, club=db.get(TeamClub, club_id), org_club=db.get(TeamClub, 10), items=items,
        invoice_no=invoice_no, total_cents=total, meet_name="Championnat", meetsid=1, lang="fr",
        prior_external_id=prior[0] if prior else None, prior_account=prior[1] if prior else None, **kw)


class TestDocNumber:
    def test_strips_revision_suffix(self):
        assert doc_number("2026-012-0045") == "2026-012-0045"
        assert doc_number("2026-012-0045-R2") == "2026-012-0045"
        assert doc_number("2026-012-0045-R13") == "2026-012-0045"


class TestCreate:
    def test_creates_customer_and_invoice_with_the_expected_shape(self, db, qb):
        result = QuickBooksProvider().push(_ctx(db, invoice_no="2026-001-0020-R2"))
        assert result.account == REALM and result.external_id in qb.invoices
        inv = qb.invoices[result.external_id]
        assert inv["DocNumber"] == "2026-001-0020"
        assert inv["TotalAmt"] == 45.0
        assert inv["CustomerMemo"] == {"value": "Championnat"}
        assert inv["BillEmail"] == {"Address": "alma@x.ca"}
        assert "EmailStatus" not in inv  # created only: the Société sends it from QuickBooks
        assert not qb.calls("POST", "invoice/")  # no send endpoint hit
        l1, l2 = inv["Line"]
        assert l1["Description"] == "TREMBLAY, Anne — Frais d'athlète $5.00, 2 individuelles"
        assert l1["Amount"] == 25.0
        d1 = l1["SalesItemLineDetail"]
        assert d1["ItemRef"] == {"value": "7"} and d1["TaxCodeRef"] == {"value": "4"}
        assert (d1["Qty"], d1["UnitPrice"]) == (1, 25.0)
        d2 = l2["SalesItemLineDetail"]
        assert (d2["Qty"], d2["UnitPrice"], l2["Amount"]) == (2, 10.0, 20.0)
        # the customer: ':' is not allowed in a QuickBooks name
        cust = qb.customers[inv["CustomerRef"]["value"]]
        assert cust["DisplayName"] == "Club d'Alma- Nord"
        assert cust["PrimaryEmailAddr"] == {"Address": "alma@x.ca"}

    def test_no_email_means_no_email_fields(self, db, qb):
        result = QuickBooksProvider().push(_ctx(db, club_id=30))
        inv = qb.invoices[result.external_id]
        assert "BillEmail" not in inv
        assert "PrimaryEmailAddr" not in qb.customers[inv["CustomerRef"]["value"]]

    def test_not_connected(self, db, qb):
        db.delete(db.get(BsGlobal, f"{qbo.CONN_KEY}:10"))
        db.commit()
        with pytest.raises(ProviderError):
            QuickBooksProvider().push(_ctx(db))
        assert qb.log == []

    def test_quickbooks_refusal_is_reported(self, db, qb):
        qb.fail_invoice = "Business Validation Error"
        with pytest.raises(ProviderError) as e:
            QuickBooksProvider().push(_ctx(db))
        assert "Business Validation Error" in e.value.message and e.value.status == 400


class TestIdempotency:
    def test_repush_with_recorded_id_creates_nothing(self, db, qb):
        first = QuickBooksProvider().push(_ctx(db))
        again = QuickBooksProvider().push(_ctx(db, prior=(first.external_id, REALM)))
        assert again.external_id == first.external_id
        assert len(qb.invoices) == 1

    def test_finds_an_invoice_it_created_but_never_recorded(self, db, qb):
        first = QuickBooksProvider().push(_ctx(db))
        again = QuickBooksProvider().push(_ctx(db))  # nothing recorded: crash after create
        assert again.external_id == first.external_id and len(qb.invoices) == 1

    def test_recorded_invoice_deleted_in_quickbooks_is_found_by_number_or_recreated(self, db, qb):
        first = QuickBooksProvider().push(_ctx(db))
        del qb.invoices[first.external_id]
        again = QuickBooksProvider().push(_ctx(db, prior=(first.external_id, REALM)))
        assert again.external_id != first.external_id and len(qb.invoices) == 1

    def test_recorded_id_from_another_company_is_ignored(self, db, qb):
        qb.invoices["999"] = {"Id": "999", "TotalAmt": 1.0, "DocNumber": "other"}
        result = QuickBooksProvider().push(_ctx(db, prior=("999", "OTHER-REALM")))
        assert result.external_id != "999"
        assert not [1 for m, p in qb.log if p == "invoice/999"]


class TestUpdate:
    """The club's entries changed after the invoice was pushed."""

    MORE = ITEMS + [{"event_number": None, "event_name": "NEW, Zoe", "description": "Frais d'athlète $5.00",
                     "qty": 1, "unit_cents": 500}]

    def _first(self, db, qb):
        first = QuickBooksProvider().push(_ctx(db))
        return first, (first.external_id, REALM)

    def test_changed_entries_update_the_same_invoice(self, db, qb):
        first, prior = self._first(db, qb)
        result = QuickBooksProvider().push(_ctx(db, items=self.MORE, total=5000, prior=prior,
                                                invoice_no="2026-001-0020-R2"))
        assert result.action == "updated" and result.external_id == first.external_id
        assert len(qb.invoices) == 1
        inv = qb.invoices[first.external_id]
        assert inv["DocNumber"] == "2026-001-0020"  # keeps its number: no -R2 in QuickBooks
        assert inv["TotalAmt"] == 50.0 and len(inv["Line"]) == 3
        update = qb.updates[0]
        assert update["sparse"] is True and set(update) == {"Id", "SyncToken", "sparse", "Line"}

    def test_removed_entries_drop_their_lines(self, db, qb):
        first, prior = self._first(db, qb)
        QuickBooksProvider().push(_ctx(db, items=ITEMS[:1], total=2500, prior=prior))
        assert [ln["Description"] for ln in qb.invoices[first.external_id]["Line"]] == \
            ["TREMBLAY, Anne — Frais d'athlète $5.00, 2 individuelles"]

    def test_same_total_but_different_lines_still_updates(self, db, qb):
        first, prior = self._first(db, qb)
        swapped = [dict(ITEMS[0], event_name="GAGNON, Luc"), ITEMS[1]]
        result = QuickBooksProvider().push(_ctx(db, items=swapped, total=TOTAL, prior=prior))
        assert result.action == "updated"
        assert qb.invoices[first.external_id]["Line"][0]["Description"].startswith("GAGNON, Luc")

    def test_nothing_changed_touches_nothing(self, db, qb):
        first, prior = self._first(db, qb)
        result = QuickBooksProvider().push(_ctx(db, prior=prior))
        assert result.action == "unchanged" and qb.updates == []

    def test_a_payment_blocks_the_update(self, db, qb):
        first, prior = self._first(db, qb)
        qb.invoices[first.external_id]["Balance"] = 20.0  # 25.00 paid
        with pytest.raises(ProviderError) as e:
            QuickBooksProvider().push(_ctx(db, items=self.MORE, total=5000, prior=prior))
        assert e.value.status == 409 and "payment or credit" in e.value.message
        assert qb.updates == [] and len(qb.invoices[first.external_id]["Line"]) == 2

    def test_a_fully_paid_invoice_is_blocked_too(self, db, qb):
        first, prior = self._first(db, qb)
        qb.invoices[first.external_id]["Balance"] = 0.0
        with pytest.raises(ProviderError) as e:
            QuickBooksProvider().push(_ctx(db, items=self.MORE, total=5000, prior=prior))
        assert e.value.status == 409

    def test_a_paid_invoice_with_nothing_to_change_is_fine(self, db, qb):
        first, prior = self._first(db, qb)
        qb.invoices[first.external_id]["Balance"] = 0.0
        assert QuickBooksProvider().push(_ctx(db, prior=prior)).action == "unchanged"

    def test_a_voided_invoice_is_blocked(self, db, qb):
        first, prior = self._first(db, qb)
        inv = qb.invoices[first.external_id]
        inv["TotalAmt"], inv["Balance"], inv["Line"] = 0.0, 0.0, []
        with pytest.raises(ProviderError) as e:
            QuickBooksProvider().push(_ctx(db, prior=prior))
        assert e.value.status == 409 and "voided" in e.value.message

    def test_stale_token_is_retried_with_a_fresh_read(self, db, qb):
        first, prior = self._first(db, qb)
        qb.stale_once = lambda inv: None  # someone saved first; nothing else changed
        result = QuickBooksProvider().push(_ctx(db, items=self.MORE, total=5000, prior=prior))
        assert result.action == "updated" and len(qb.updates) == 1
        assert qb.invoices[first.external_id]["TotalAmt"] == 50.0

    def test_payment_landing_during_a_stale_retry_still_blocks(self, db, qb):
        first, prior = self._first(db, qb)

        def pay(inv):
            inv["Balance"] = 0.0
        qb.stale_once = pay
        with pytest.raises(ProviderError) as e:
            QuickBooksProvider().push(_ctx(db, items=self.MORE, total=5000, prior=prior))
        assert e.value.status == 409 and qb.updates == []

    def test_found_by_number_is_updated_too(self, db, qb):
        first, _ = self._first(db, qb)  # nothing recorded: found through DocNumber
        result = QuickBooksProvider().push(_ctx(db, items=self.MORE, total=5000))
        assert result.action == "updated" and result.external_id == first.external_id


class TestCustomer:
    def test_existing_customer_is_reused_by_name(self, db, qb):
        qb.customers["55"] = {"Id": "55", "Active": True, "DisplayName": "Club d'Alma- Nord"}
        result = QuickBooksProvider().push(_ctx(db))
        assert qb.invoices[result.external_id]["CustomerRef"] == {"value": "55"}
        assert not qb.calls("POST", "customer")

    def test_mapping_is_stored_and_used_next_time(self, db, qb):
        QuickBooksProvider().push(_ctx(db))
        mapped = db.get(QboCustomer, (20, REALM)).customer_id
        queries_before = len(qb.calls("GET", "query"))
        qb.invoices.clear()
        QuickBooksProvider().push(_ctx(db, invoice_no="2026-001-0021"))
        # the second push verified the mapped customer by id, not by name
        assert qb.calls("GET", f"customer/{mapped}")
        assert [r for r in qb.invoices.values()][0]["CustomerRef"] == {"value": mapped}
        # only the invoice-number check queried again: no customer name search
        assert len(qb.calls("GET", "query")) - queries_before == 1

    def test_renamed_club_keeps_its_customer(self, db, qb):
        QuickBooksProvider().push(_ctx(db))
        db.get(TeamClub, 20).name = "Totally New Name"
        db.commit()
        qb.invoices.clear()
        QuickBooksProvider().push(_ctx(db, invoice_no="2026-001-0021"))
        assert len(qb.customers) == 1

    def test_customer_deleted_in_quickbooks_is_resolved_again(self, db, qb):
        QuickBooksProvider().push(_ctx(db))
        qb.customers.clear()
        qb.invoices.clear()
        result = QuickBooksProvider().push(_ctx(db, invoice_no="2026-001-0021"))
        new_id = qb.invoices[result.external_id]["CustomerRef"]["value"]
        assert qb.customers[new_id]["DisplayName"] == "Club d'Alma- Nord"
        assert db.get(QboCustomer, (20, REALM)).customer_id == new_id

    def test_apostrophe_in_a_name_survives_the_query(self, db, qb):
        qb.customers["56"] = {"Id": "56", "Active": True, "DisplayName": "L'Étoile"}
        db.get(TeamClub, 30).name = "L'Étoile"
        db.commit()
        result = QuickBooksProvider().push(_ctx(db, club_id=30))
        assert qb.invoices[result.external_id]["CustomerRef"] == {"value": "56"}


class TestSetup:
    def test_missing_item_without_income_account_explains_what_to_do(self, db, qb):
        qb.items.clear()
        with pytest.raises(ProviderError) as e:
            QuickBooksProvider().push(_ctx(db))
        assert "income account" in e.value.message and not qb.invoices

    def test_missing_item_is_created_under_the_configured_account(self, db, qb, monkeypatch):
        qb.items.clear()
        qbo.save_settings(db, 10, {"income_account": "Revenus - Inscriptions"})
        QuickBooksProvider().push(_ctx(db))
        item = [i for i in qb.items.values()][0]
        assert item["Name"] == "Frais d'inscription" and item["Type"] == "Service"
        assert item["IncomeAccountRef"] == {"value": "30"}

    def test_unknown_income_account(self, db, qb, monkeypatch):
        qb.items.clear()
        qbo.save_settings(db, 10, {"income_account": "Nope"})
        with pytest.raises(ProviderError) as e:
            QuickBooksProvider().push(_ctx(db))
        assert "Nope" in e.value.message

    def test_item_name_override(self, db, qb, monkeypatch):
        qb.items["8"] = {"Id": "8", "Name": "Meet fees"}
        qbo.save_settings(db, 10, {"item_name": "Meet fees"})
        result = QuickBooksProvider().push(_ctx(db))
        line = qb.invoices[result.external_id]["Line"][0]
        assert line["SalesItemLineDetail"]["ItemRef"] == {"value": "8"}

    def test_item_and_tax_lookups_are_cached(self, db, qb):
        QuickBooksProvider().push(_ctx(db))
        qb.invoices.clear()
        queries = len(qb.calls("GET", "query"))
        QuickBooksProvider().push(_ctx(db, invoice_no="2026-001-0021"))
        assert len(qb.calls("GET", "query")) - queries == 1  # only the invoice-number check

    def test_missing_tax_code_explains_what_to_do(self, db, qb):
        qb.taxcodes.clear()
        with pytest.raises(ProviderError) as e:
            QuickBooksProvider().push(_ctx(db))
        assert "tax code" in e.value.message and not qb.invoices

    def test_tax_code_name_override(self, db, qb, monkeypatch):
        qb.taxcodes["5"] = {"Id": "5", "Name": "Exonéré"}
        qbo.save_settings(db, 10, {"tax_code": "Exonéré"})
        result = QuickBooksProvider().push(_ctx(db))
        detail = qb.invoices[result.external_id]["Line"][0]["SalesItemLineDetail"]
        assert detail["TaxCodeRef"] == {"value": "5"}

    def test_tax_code_none_omits_it(self, db, qb, monkeypatch):
        qb.taxcodes.clear()
        qbo.save_settings(db, 10, {"tax_code": "none"})
        result = QuickBooksProvider().push(_ctx(db))
        detail = qb.invoices[result.external_id]["Line"][0]["SalesItemLineDetail"]
        assert "TaxCodeRef" not in detail


class _Req:
    headers = {}


class TestRouter:
    """send_club_invoice end to end: real QuickBooksProvider, fake QuickBooks."""

    @pytest.fixture
    def wired(self, db, qb, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "quickbooks")
        _set_organizer_club_id(db, 10, meetsid=1)
        db.commit()
        state = {"items": ITEMS}
        import app.invoices as invoices
        monkeypatch.setattr(invoices, "_club_line_items", lambda *a, **k: state["items"])
        return state

    def _send(self, db):
        return api.send_club_invoice(20, _Req(), {"lang": "fr"}, db)

    def test_records_where_the_invoice_went(self, db, qb, wired):
        out = self._send(db)
        row = db.get(ClubMeetInvite, (20, 1))
        assert (row.invoice_provider, row.provider_invoice_id, row.provider_account) == \
            ("quickbooks", out["invoice_id"], REALM)
        assert row.stripe_send_count == 1 and row.invoice_last_total_cents == TOTAL
        assert out["total_cents"] == TOTAL

    def test_second_send_reuses_the_invoice(self, db, qb, wired):
        first = self._send(db)
        second = self._send(db)
        assert second["invoice_id"] == first["invoice_id"] and len(qb.invoices) == 1
        assert db.get(ClubMeetInvite, (20, 1)).stripe_send_count == 2

    def test_changed_total_updates_the_invoice_and_the_record(self, db, qb, wired):
        first = self._send(db)
        wired["items"] = ITEMS[:1]
        again = self._send(db)
        assert again["action"] == "updated" and again["invoice_id"] == first["invoice_id"]
        assert len(qb.invoices) == 1 and qb.invoices[first["invoice_id"]]["TotalAmt"] == 25.0
        row = db.get(ClubMeetInvite, (20, 1))
        assert row.invoice_last_total_cents == 2500 and row.invoice_rev == 2 and row.stripe_send_count == 2

    def test_a_paid_invoice_is_a_409_and_records_nothing_new(self, db, qb, wired):
        first = self._send(db)
        qb.invoices[first["invoice_id"]]["Balance"] = 0.0
        wired["items"] = ITEMS[:1]
        with pytest.raises(HTTPException) as e:
            self._send(db)
        assert e.value.status_code == 409 and len(qb.invoices[first["invoice_id"]]["Line"]) == 2
        row = db.get(ClubMeetInvite, (20, 1))
        assert row.invoice_last_total_cents == TOTAL and row.stripe_send_count == 1

    def test_an_id_recorded_by_another_provider_is_not_trusted(self, db, qb, wired):
        db.add(ClubMeetInvite(clubsid=20, meetsid=1, invoice_provider="stripe", provider_invoice_id="in_123"))
        db.commit()
        self._send(db)
        assert not [1 for m, p in qb.log if "in_123" in p]
        assert db.get(ClubMeetInvite, (20, 1)).invoice_provider == "quickbooks"

    def test_failure_records_nothing(self, db, qb, wired):
        qb.fail_invoice = "Nope"
        with pytest.raises(HTTPException) as e:
            self._send(db)
        assert e.value.status_code == 400
        row = db.get(ClubMeetInvite, (20, 1))
        assert row is None or not row.provider_invoice_id


class TestStorage:
    def test_record_invoice_sent_stores_provider_fields(self, db):
        record_invoice_sent(db, 20, 1, 4500, provider="quickbooks", external_id="42", account=REALM)
        db.commit()
        row = db.get(ClubMeetInvite, (20, 1))
        assert (row.invoice_provider, row.provider_invoice_id, row.provider_account) == ("quickbooks", "42", REALM)

    def test_record_invoice_sent_without_provider_leaves_them_alone(self, db):
        record_invoice_sent(db, 20, 1, 4500)
        db.commit()
        assert db.get(ClubMeetInvite, (20, 1)).provider_invoice_id is None

    def test_migration_0009_adds_the_columns_once(self):
        from app.migrations.versions import m0009_invoice_provider_ids as m

        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as conn:
            conn.execute(text("CREATE TABLE club_meet_invites (clubsid INTEGER, meetsid INTEGER, "
                              "stripe_send_count INTEGER)"))
            conn.execute(text("INSERT INTO club_meet_invites VALUES (1, 1, 3)"))
        m.upgrade(engine)
        m.upgrade(engine)  # idempotent
        cols = {c["name"] for c in inspect(engine).get_columns("club_meet_invites")}
        assert {"invoice_provider", "provider_invoice_id", "provider_account"} <= cols
        with engine.connect() as conn:
            assert conn.execute(text("SELECT stripe_send_count, invoice_provider FROM club_meet_invites")).one() == (3, None)

    def test_migration_0009_is_a_noop_on_a_fresh_install(self):
        from app.migrations.versions import m0009_invoice_provider_ids as m
        m.upgrade(create_engine("sqlite:///:memory:"))


class TestErrorReporting:
    def test_error_names_the_failing_call_and_logs_the_request(self, db, qb, caplog):
        qb.fail_invoice = "failed to parse json object"
        with caplog.at_level("WARNING", logger="quickbooks"):
            with pytest.raises(ProviderError) as e:
                QuickBooksProvider().push(_ctx(db))
        assert e.value.message.startswith("QuickBooks POST invoice: ")
        assert "failed to parse json object" in e.value.message
        logged = " ".join(r.getMessage() for r in caplog.records)
        assert "POST invoice" in logged and '"DocNumber": "2026-001-0020"' in logged
        assert "tok" not in logged.replace("TotalAmt", "")  # the access token is never logged


class TestEncoding:
    def test_body_is_ascii_json_even_with_accents_and_dashes(self, db, qb):
        items = [{"event_number": None, "event_name": "ALVES PEREIRA NETO, Néocles",
                  "description": "Frais d'athlète — 2 relais", "qty": 1, "unit_cents": 5000}]
        db.get(TeamClub, 20).name = "Société Équipe"
        db.commit()
        result = QuickBooksProvider().push(_ctx(db, items=items, total=5000))
        posted = [(raw, ct) for raw, ct in qb.raw if raw and b"DocNumber" in raw]
        assert posted, "the invoice POST was not captured"
        raw, content_type = posted[0]
        assert raw.isascii() and content_type == "application/json"
        # ...and it still round-trips to the exact text
        line = qb.invoices[result.external_id]["Line"][0]
        assert line["Description"] == "ALVES PEREIRA NETO, Néocles — Frais d'athlète — 2 relais"
        assert qb.customers[qb.invoices[result.external_id]["CustomerRef"]["value"]]["DisplayName"] == "Société Équipe"

    def test_retry_after_401_uses_the_refreshed_token(self, db, qb, monkeypatch):
        seen = []

        def first_call_is_401(request):
            seen.append(request.headers.get("authorization"))
            if len(seen) == 1:
                return httpx.Response(401, json={})
            return qb.handler(request)

        refreshes = []

        def fake_refresh(*args, **kwargs):
            refreshes.append(kwargs.get("rejected"))
            return type("Conn", (), {"access_token": "fresh"})()

        monkeypatch.setattr(qbo, "_transport", httpx.MockTransport(first_call_is_401))
        monkeypatch.setattr(qbo, "_refresh", fake_refresh)
        qbo.api_request(db, "POST", "customer", owner=10, json_body={"DisplayName": "X"})
        assert seen == ["Bearer tok", "Bearer fresh"] and refreshes == ["tok"]


class TestProbe:
    @pytest.fixture
    def probe(self, db, qb, monkeypatch):
        from app.invoice_providers import quickbooks_probe as probe
        monkeypatch.setattr(probe, "SessionLocal", sessionmaker(bind=db.get_bind()))
        db.add(QboCustomer(clubsid=20, realm_id=REALM, customer_id="58"))
        db.commit()
        return probe

    def test_every_step_accepted_and_nothing_left_behind(self, probe, qb, capsys):
        assert probe.main() == 0
        out = capsys.readouterr().out
        assert "country CA" in out and "tax codes in this company: 'Exempt' (id 4)" in out
        assert "ok    minimal, as the app sends it" in out and "All steps accepted" in out
        assert "QuickBooks settings" not in out
        assert qb.invoices == {}  # each probe invoice was deleted again

    def test_finds_that_the_company_needs_a_tax_code(self, probe, qb, capsys):
        qb.require_tax = True
        assert probe.main() == 0
        out = capsys.readouterr().out
        assert "FAIL  minimal, as the app sends it" in out
        assert "ok    minimal + tax code 'Exempt' (id 4)" in out
        assert "==> this company needs a tax code on each line: choose the tax code 'Exempt' in the QuickBooks settings" in out
        assert "All steps accepted" in out and qb.invoices == {}

    def test_names_the_first_field_step_that_fails(self, probe, qb, capsys):
        qb.reject_key = "BillEmail"
        assert probe.main() == 1
        out = capsys.readouterr().out
        assert "FAIL  step 7  + BillEmail" in out and "ok    step 6" in out
        assert qb.invoices == {}

    def test_reports_when_even_the_bare_invoice_is_refused(self, probe, qb, capsys):
        qb.fail_invoice = "nope"
        assert probe.main() == 1
        assert "not in our fields" in capsys.readouterr().out

    def test_a_none_query_parameter_is_dropped(self, db, qb):
        qbo.api_request(db, "GET", "companyinfo/1", owner=10, params={"minorversion": None})
        qbo.api_request(db, "GET", "companyinfo/1", owner=10)
        assert "minorversion" not in qb.urls[-2] and "minorversion=75" in qb.urls[-1]

    def test_steps_add_fields_cumulatively(self, probe):
        minimal = probe.build_body(0, "58", "7", None)
        assert set(minimal) == {"CustomerRef", "Line"}
        assert "Description" not in minimal["Line"][0]
        full = probe.build_body(len(probe.STEPS) - 1, "58", "7", "4")
        assert {"DocNumber", "TxnDate", "CustomerMemo", "PrivateNote", "BillEmail"} <= set(full)
        assert full["Line"][0]["SalesItemLineDetail"]["TaxCodeRef"] == {"value": "4"}
        assert "é" in full["Line"][0]["Description"]

    def test_refuses_outside_the_sandbox(self, probe, qb, monkeypatch, capsys):
        monkeypatch.setenv("QBO_ENVIRONMENT", "production")
        assert probe.main() == 2
        assert "sandbox" in capsys.readouterr().out and qb.log == []


class TestProviderFlags:
    def test_quickbooks_creates_only_stripe_sends(self):
        assert StripeProvider.sends_invoice is True and QuickBooksProvider.sends_invoice is False


class _ReqWithMeet:
    headers = {}


class TestProviderInfo:
    @pytest.fixture
    def wired(self, db, qb, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "quickbooks")
        _set_organizer_club_id(db, 10, meetsid=1)
        db.commit()
        monkeypatch.setattr(__import__("app.invoices", fromlist=["x"]), "_club_line_items",
                            lambda *a, **k: ITEMS)

    def test_provider_info_advertises_the_capabilities(self, db, qb, wired):
        info = api.invoice_provider_status(db)
        assert info["provider"] == "quickbooks" and "supports_status" not in info
        assert info["sends_invoice"] is False and info["connected"] is True

    def test_no_provider(self, db, monkeypatch):
        monkeypatch.delenv("INVOICE_PROVIDER", raising=False)
        monkeypatch.delenv("STRIPE_API_KEY", raising=False)
        assert api.invoice_provider_status(db) == {"provider": "none", "connected": False}


# A real invoice, as the Intuit sandbox returned it on 2026-11-23 (trimmed to the
# parts that matter): note DetailType "SalesItemLineDetail", integer UnitPrice,
# the automatic SubTotalLineDetail line and QuickBooks' own TotalAmt/Balance.
REAL_INVOICE = {
    "Id": "130", "SyncToken": "0", "DocNumber": "1037", "TxnDate": "2026-10-28",
    "Line": [
        {"Id": "1", "LineNum": 1, "Description": "Rock Fountain", "Amount": 275.0, "DetailType": "SalesItemLineDetail",
         "SalesItemLineDetail": {"ItemRef": {"value": "5", "name": "Rock Fountain"}, "UnitPrice": 275, "Qty": 1,
                                 "TaxCodeRef": {"value": "TAX"}}},
        {"Id": "3", "LineNum": 3, "Description": "Concrete for fountain installation", "Amount": 47.5,
         "DetailType": "SalesItemLineDetail",
         "SalesItemLineDetail": {"ItemRef": {"value": "3", "name": "Concrete"}, "UnitPrice": 9.5, "Qty": 5,
                                 "TaxCodeRef": {"value": "TAX"}}},
        {"Amount": 322.5, "DetailType": "SubTotalLineDetail", "SubTotalLineDetail": {}},
    ],
    "TotalAmt": 362.07, "Balance": 362.07, "DueDate": "2026-11-27", "EmailStatus": "NotSet",
}


class TestFakeIsAsStrictAsQuickBooks:
    """Guard the guard: the fake must keep refusing what real QuickBooks refused."""

    def _post(self, db, qb, body, path="invoice"):
        return qbo.api_request(db, "POST", path, owner=10, json_body=body)

    def _line(self, **over):
        line = {"DetailType": "SalesItemLineDetail", "Amount": 1.0,
                "SalesItemLineDetail": {"ItemRef": {"value": "7"}}}
        line.update(over)
        return line

    def test_the_wrong_name_we_once_shipped_is_refused(self, db, qb):
        bad = {"CustomerRef": {"value": "1"}, "Line": [{
            "DetailType": "SalesItemLineItemDetail", "Amount": 1.0,
            "SalesItemLineItemDetail": {"ItemRef": {"value": "7"}}}]}
        with pytest.raises(ProviderError) as e:
            self._post(db, qb, bad)
        assert e.value.code == "2010" and "Line.SalesItemLineItemDetail" in e.value.message

    def test_a_detail_object_not_matching_its_type_is_refused(self, db, qb):
        # says it is a sales line, but carries the detail object of another type
        line = {"DetailType": "SalesItemLineDetail", "Amount": 1.0, "SubTotalLineDetail": {}}
        with pytest.raises(ProviderError) as e:
            self._post(db, qb, {"CustomerRef": {"value": "1"}, "Line": [line]})
        assert "Line.SalesItemLineDetail" in e.value.message

    def test_unknown_properties_are_refused_at_every_level(self, db, qb):
        for body, where in (
            ({"CustomerRef": {"value": "1"}, "Line": [], "Memo": "x"}, "Memo"),
            ({"CustomerRef": {"value": "1"}, "Line": [self._line(Memo="x")]}, "Line.Memo"),
            ({"CustomerRef": {"value": "1"},
              "Line": [self._line(SalesItemLineDetail={"ItemRef": {"value": "7"}, "Tax": 1})]},
             "Line.SalesItemLineDetail.Tax"),
        ):
            with pytest.raises(ProviderError) as e:
                self._post(db, qb, body)
            assert where in e.value.message

    def test_numbers_and_ids_must_have_the_right_type(self, db, qb):
        for body, where in (
            ({"CustomerRef": {"value": 1}, "Line": []}, "CustomerRef.value"),
            ({"CustomerRef": {"value": "1"}, "Line": [self._line(Amount="1.00")]}, "Line.Amount"),
            ({"CustomerRef": {"value": "1"},
              "Line": [self._line(SalesItemLineDetail={"ItemRef": {"value": 7}})]},
             "Line.SalesItemLineDetail.ItemRef.value"),
            ({"CustomerRef": {"value": "1"},
              "Line": [self._line(SalesItemLineDetail={"ItemRef": {"value": "7"}, "Qty": "1"})]},
             "Line.SalesItemLineDetail.Qty"),
        ):
            with pytest.raises(ProviderError) as e:
                self._post(db, qb, body)
            assert where in e.value.message

    def test_customers_and_items_are_validated_too(self, db, qb):
        with pytest.raises(ProviderError) as e:
            self._post(db, qb, {"DisplayName": "X", "Email": "a@b.ca"}, "customer")
        assert "Email" in e.value.message
        with pytest.raises(ProviderError) as e:
            self._post(db, qb, {"Name": "X", "Type": "Service", "IncomeAccount": "30"}, "item")
        assert "IncomeAccount" in e.value.message

    def test_what_the_app_really_sends_is_accepted(self, db, qb):
        """The strict fake does not break the happy path: every push test above
        already goes through it, this one just says so explicitly."""
        result = QuickBooksProvider().push(_ctx(db))
        assert result.external_id in qb.invoices


class TestRealShapes:
    """Our parsing against responses shaped exactly like Intuit's."""

    def test_real_invoice_is_recognised_as_unchanged(self):
        from app.invoice_providers.quickbooks_provider import _same_lines
        desired = [dict(ln) for ln in REAL_INVOICE["Line"] if ln["DetailType"] == "SalesItemLineDetail"]
        assert _same_lines(REAL_INVOICE, desired) is True

    def test_subtotal_line_and_integer_unit_price_do_not_confuse_the_comparison(self):
        from app.invoice_providers.quickbooks_provider import _line_key, _same_lines
        assert _line_key(REAL_INVOICE["Line"][0]) == ("Rock Fountain", 275.0, 1.0, 275.0)
        ours = [{"DetailType": "SalesItemLineDetail", "Amount": 275.0, "Description": "Rock Fountain",
                 "SalesItemLineDetail": {"ItemRef": {"value": "5"}, "Qty": 1, "UnitPrice": 275.0}}]
        assert _same_lines(REAL_INVOICE, ours) is False  # the second real line is missing from ours

    def test_description_whitespace_from_quickbooks_is_ignored(self):
        from app.invoice_providers.quickbooks_provider import _same_lines
        stored = {"Line": [{"DetailType": "SalesItemLineDetail", "Description": " A — b ", "Amount": 1.0,
                            "SalesItemLineDetail": {"Qty": 1, "UnitPrice": 1}}]}
        ours = [{"DetailType": "SalesItemLineDetail", "Description": "A — b", "Amount": 1.0,
                 "SalesItemLineDetail": {"Qty": 1, "UnitPrice": 1.0}}]
        assert _same_lines(stored, ours) is True

    def test_the_real_invoice_counts_as_open(self):
        from app.invoice_providers.quickbooks_provider import _cents, _refuse_if_settled, invoice_state
        assert invoice_state(_cents(REAL_INVOICE["TotalAmt"]), _cents(REAL_INVOICE["Balance"])) == "open"
        _refuse_if_settled(REAL_INVOICE, "1037")  # does not raise

    def test_fault_in_the_real_shape_is_parsed(self, db, monkeypatch):
        fault = {"Fault": {"Error": [{"Message": "Stale Object Error",
                                      "Detail": "Stale Object Error : You and Craig Carlson were working on this at the same time.",
                                      "code": "5010", "element": ""}], "type": "ValidationFault"},
                 "time": "2026-11-23T14:28:19.345-08:00"}
        monkeypatch.setattr(qbo, "_transport", httpx.MockTransport(lambda request: httpx.Response(400, json=fault)))
        with pytest.raises(ProviderError) as e:
            qbo.api_request(db, "POST", "invoice", owner=10, json_body={"Id": "1"})
        assert e.value.code == "5010" and "Craig Carlson" in e.value.message and e.value.status == 400


class TestHelpers:
    def test_query_escaping(self):
        assert qp._q("Club d'Alma") == "Club d\\'Alma"
        assert qp._q("a\\b") == "a\\\\b"
        assert qp._q("plain") == "plain"

    def test_display_name_rules(self):
        from types import SimpleNamespace
        name = lambda n: qp._display_name(SimpleNamespace(name=n, clubsid=7))  # noqa: E731
        assert name("A:B") == "A-B" and name("  Club  ") == "Club"
        assert name("") == "Club 7" and name(None) == "Club 7"
        assert len(name("x" * 900)) == 500

    def test_line_description_rules(self):
        line = qp._line({"event_number": 12, "event_name": "50m", "description": "x", "qty": 1, "unit_cents": 100},
                        "fr", "7", None)
        assert line["Description"] == "#12 — 50m — x"
        assert qp._line({"qty": 1, "unit_cents": 100}, "fr", "7", None)["Description"] == "Inscription"
        assert qp._line({"qty": 1, "unit_cents": 100}, "en", "7", None)["Description"] == "Registration"

    def test_cents_rounding_is_exact_for_money(self):
        line = qp._line({"event_name": "x", "qty": 3, "unit_cents": 1999}, "fr", "7", None)
        assert line["Amount"] == 59.97 and line["SalesItemLineDetail"]["UnitPrice"] == 19.99
        assert qp._cents(0.1 + 0.2) == 30 and qp._cents(None) == 0 and qp._cents("12.34") == 1234


class TestProviderRoutes:
    """The generic /invoice-provider routes with QuickBooks behind them."""

    def test_connect_returns_the_consent_url(self, db, qb, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "quickbooks")
        _set_organizer_club_id(db, 10, meetsid=1)
        db.commit()
        assert api.invoice_provider_connect(db)["url"].startswith("https://appcenter.intuit.com/connect/oauth2?")

    def test_connect_needs_an_organizer(self, db, qb, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "quickbooks")
        with pytest.raises(HTTPException) as e:
            api.invoice_provider_connect(db)
        assert e.value.status_code == 400

    def test_connect_without_a_provider(self, db, monkeypatch):
        monkeypatch.delenv("INVOICE_PROVIDER", raising=False)
        monkeypatch.delenv("STRIPE_API_KEY", raising=False)
        with pytest.raises(HTTPException) as e:
            api.invoice_provider_connect(db)
        assert e.value.status_code == 400 and "No invoice provider" in e.value.detail

    def test_a_provider_error_becomes_an_http_error(self, db, qb, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "quickbooks")
        monkeypatch.delenv("QBO_CLIENT_SECRET")
        _set_organizer_club_id(db, 10, meetsid=1)
        db.commit()
        with pytest.raises(HTTPException) as e:
            api.invoice_provider_connect(db)
        assert e.value.status_code == 500 and "QBO_CLIENT_ID" in e.value.detail

    def test_disconnect_forgets_the_connection(self, db, qb, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "quickbooks")
        _set_organizer_club_id(db, 10, meetsid=1)
        db.commit()
        assert api.invoice_provider_disconnect(db) == {"ok": True}
        assert db.get(BsGlobal, f"{qbo.CONN_KEY}:10") is None
        assert api.invoice_provider_status(db)["connected"] is False

    def test_connecting_needs_an_email_to_notify(self, db, qb, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "quickbooks")
        db.get(TeamClub, 10).email = ""
        _set_organizer_club_id(db, 10, meetsid=1)
        db.commit()
        with pytest.raises(HTTPException) as e:
            api.invoice_provider_connect(db)
        assert e.value.status_code == 400 and "email" in e.value.detail.lower()

    def test_disconnect_notifies_the_club(self, db, qb, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "quickbooks")
        _set_organizer_club_id(db, 10, meetsid=1)
        db.commit()
        sent = []
        monkeypatch.setattr("app.emailing.send_email", lambda to, subject, html, **kw: sent.append((to, subject)))
        api.invoice_provider_disconnect(db)
        assert sent == [("soc@x.ca", "QuickBooks déconnecté / QuickBooks disconnected")]
        sent.clear()
        api.invoice_provider_disconnect(db)       # nothing left to disconnect: nothing to announce
        assert sent == []

    def test_settings_are_validated_against_the_companys_own_lists(self, db, qb, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "quickbooks")
        _set_organizer_club_id(db, 10, meetsid=1)
        db.commit()
        opts = api.invoice_provider_settings_options(db)
        assert "Exempt" in opts["tax_codes"] and opts["income_accounts"] == ["Revenus - Inscriptions"]  # no bank account
        assert opts["items"] == ["Frais d'inscription"]
        saved = api.invoice_provider_save_settings({"tax_code": "Exempt", "income_account": "Revenus - Inscriptions",
                                                    "item_name": "Frais d'inscription"}, db)
        assert saved["tax_code"] == "Exempt"
        assert api.invoice_provider_status(db)["settings"]["income_account"] == "Revenus - Inscriptions"
        with pytest.raises(HTTPException) as e:
            api.invoice_provider_save_settings({"tax_code": "Made up"}, db)
        assert e.value.status_code == 400

    def test_disconnect_without_a_provider(self, db, monkeypatch):
        monkeypatch.delenv("INVOICE_PROVIDER", raising=False)
        monkeypatch.delenv("STRIPE_API_KEY", raising=False)
        with pytest.raises(HTTPException) as e:
            api.invoice_provider_disconnect(db)
        assert e.value.status_code == 400
