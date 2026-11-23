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
from app.invoices import record_invoice_sent
from app.routers import api

REALM = "R1"


class FakeQbo:
    """A tiny QuickBooks: customers, items, accounts, tax codes and invoices."""

    def __init__(self):
        self.customers = {}
        self.items = {"7": {"Id": "7", "Name": "Frais d'inscription"}}
        self.accounts = {"30": {"Id": "30", "Name": "Revenus - Inscriptions"}}
        self.taxcodes = {"4": {"Id": "4", "Name": "Exempt"}}
        self.invoices = {}
        self.log: list[tuple[str, str]] = []
        self.raw: list[tuple[bytes, str]] = []  # (request body, content-type)
        self.fail_invoice = None
        self._ids = iter(range(100, 10_000))

    def calls(self, method, path):
        return [1 for m, p in self.log if m == method and p.startswith(path)]

    def _fault(self, status, code, message):
        return httpx.Response(status, json={"Fault": {"Error": [{"Message": message, "Detail": "", "code": code}]}})

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = urlparse(str(request.url)).path.split(f"/v3/company/{REALM}/", 1)[-1]
        self.log.append((request.method, path))
        self.raw.append((request.content, request.headers.get("content-type", "")))
        body = json.loads(request.content) if request.content else None

        if request.method == "GET" and path == "query":
            sql = parse_qs(urlparse(str(request.url)).query)["query"][0]
            m = re.fullmatch(r"select \* from (\w+) where (\w+) = '(.*)'", sql)
            assert m, sql
            entity, field, raw = m.groups()
            value = re.sub(r"\\(.)", r"\1", raw)  # undo \' and \\
            pool = {"Customer": self.customers, "Item": self.items, "Account": self.accounts,
                    "TaxCode": self.taxcodes, "Invoice": self.invoices}[entity]
            hits = [r for r in pool.values() if r.get(field) == value and r.get("Active", True)]
            return httpx.Response(200, json={"QueryResponse": {entity: hits} if hits else {}})

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
        if request.method == "POST" and path == "invoice":
            if self.fail_invoice:
                return self._fault(400, "6000", self.fail_invoice)
            iid = str(next(self._ids))
            total = round(sum(line["Amount"] for line in body["Line"]), 2)
            self.invoices[iid] = {"Id": iid, "TotalAmt": total, **body}
            return httpx.Response(200, json={"Invoice": self.invoices[iid]})
        return httpx.Response(404)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for k in ("INVOICE_PROVIDER", "QBO_ENVIRONMENT", "QBO_ITEM_NAME", "QBO_INCOME_ACCOUNT",
              "QBO_TAX_CODE", "QBO_API_BASE", "QBO_TOKEN_URL"):
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
    qbo.save_connection(s, qbo.Connection(
        realm_id=REALM, access_token="tok", access_expires_at=now + 3000, refresh_token="rt",
        refresh_expires_at=now + 90 * 86400, environment="sandbox", refreshed_at=now))
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
        d1 = l1["SalesItemLineItemDetail"]
        assert d1["ItemRef"] == {"value": "7"} and d1["TaxCodeRef"] == {"value": "4"}
        assert (d1["Qty"], d1["UnitPrice"]) == (1, 25.0)
        d2 = l2["SalesItemLineItemDetail"]
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
        db.delete(db.get(BsGlobal, qbo.CONN_KEY))
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

    def test_changed_total_is_refused_not_duplicated(self, db, qb):
        first = QuickBooksProvider().push(_ctx(db))
        more = ITEMS + [{"event_number": None, "event_name": "X", "description": "", "qty": 1, "unit_cents": 500}]
        with pytest.raises(ProviderError) as e:
            QuickBooksProvider().push(_ctx(db, items=more, total=5000, prior=(first.external_id, REALM)))
        assert e.value.status == 409 and len(qb.invoices) == 1


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
        assert "QBO_INCOME_ACCOUNT" in e.value.message and not qb.invoices

    def test_missing_item_is_created_under_the_configured_account(self, db, qb, monkeypatch):
        qb.items.clear()
        monkeypatch.setenv("QBO_INCOME_ACCOUNT", "Revenus - Inscriptions")
        QuickBooksProvider().push(_ctx(db))
        item = [i for i in qb.items.values()][0]
        assert item["Name"] == "Frais d'inscription" and item["Type"] == "Service"
        assert item["IncomeAccountRef"] == {"value": "30"}

    def test_unknown_income_account(self, db, qb, monkeypatch):
        qb.items.clear()
        monkeypatch.setenv("QBO_INCOME_ACCOUNT", "Nope")
        with pytest.raises(ProviderError) as e:
            QuickBooksProvider().push(_ctx(db))
        assert "Nope" in e.value.message

    def test_item_name_override(self, db, qb, monkeypatch):
        qb.items["8"] = {"Id": "8", "Name": "Meet fees"}
        monkeypatch.setenv("QBO_ITEM_NAME", "Meet fees")
        result = QuickBooksProvider().push(_ctx(db))
        line = qb.invoices[result.external_id]["Line"][0]
        assert line["SalesItemLineItemDetail"]["ItemRef"] == {"value": "8"}

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
        assert "QBO_TAX_CODE" in e.value.message and not qb.invoices

    def test_tax_code_name_override(self, db, qb, monkeypatch):
        qb.taxcodes["5"] = {"Id": "5", "Name": "Exonéré"}
        monkeypatch.setenv("QBO_TAX_CODE", "Exonéré")
        result = QuickBooksProvider().push(_ctx(db))
        detail = qb.invoices[result.external_id]["Line"][0]["SalesItemLineItemDetail"]
        assert detail["TaxCodeRef"] == {"value": "5"}

    def test_tax_code_none_omits_it(self, db, qb, monkeypatch):
        qb.taxcodes.clear()
        monkeypatch.setenv("QBO_TAX_CODE", "none")
        result = QuickBooksProvider().push(_ctx(db))
        detail = qb.invoices[result.external_id]["Line"][0]["SalesItemLineItemDetail"]
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

    def test_changed_total_is_a_409_and_records_nothing_new(self, db, qb, wired):
        self._send(db)
        wired["items"] = ITEMS[:1]
        with pytest.raises(HTTPException) as e:
            self._send(db)
        assert e.value.status_code == 409 and len(qb.invoices) == 1
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
        qbo.api_request(db, "POST", "customer", json_body={"DisplayName": "X"})
        assert seen == ["Bearer tok", "Bearer fresh"] and refreshes == ["tok"]
