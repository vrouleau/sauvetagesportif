"""Unit tests for the invoice-provider layer: which provider is active
(INVOICE_PROVIDER) and that the Stripe provider makes the same Stripe calls
the old inline code did. No Docker, no network: `stripe` is a recording fake.

Run: `pytest tests/unit/test_invoice_providers.py -v`
"""
from __future__ import annotations

import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.invoice_providers import (
    InvoiceContext, ProviderError, get_provider, selected_provider_name,
)
from app.invoice_providers.stripe_provider import (
    StripeProvider, _club_country_iso2, _public_business_url,
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in ("INVOICE_PROVIDER", "STRIPE_API_KEY", "APP_BASE_URL"):
        monkeypatch.delenv(k, raising=False)


class TestSelection:
    def test_nothing_set_means_no_provider(self):
        assert selected_provider_name() == "none"
        assert get_provider() is None

    def test_legacy_stripe_key_alone_selects_stripe(self, monkeypatch):
        monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")
        assert selected_provider_name() == "stripe"
        assert isinstance(get_provider(), StripeProvider)

    def test_explicit_stripe(self, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", " Stripe ")
        assert selected_provider_name() == "stripe"

    def test_unknown_provider_is_none_not_a_stripe_fallback(self, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "paypal")
        monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")
        assert selected_provider_name() == "none"
        assert get_provider() is None


class TestStripeHelpers:
    def test_country_defaults_to_canada(self):
        assert _club_country_iso2(SimpleNamespace(nation=None)) == "CA"
        assert _club_country_iso2(SimpleNamespace(nation="usa")) == "US"
        assert _club_country_iso2(SimpleNamespace(nation="ZZZ")) == "CA"

    def test_business_url_rejects_local_hosts(self, monkeypatch):
        assert _public_business_url() is None
        monkeypatch.setenv("APP_BASE_URL", "http://localhost:8001")
        assert _public_business_url() is None
        monkeypatch.setenv("APP_BASE_URL", "https://team.example.org")
        assert _public_business_url() == "https://team.example.org"


class _Calls(list):
    def add(self, _label, **kw):
        self.append((_label, kw))
        return SimpleNamespace(id=f"{_label}_{len(self)}", data=[])


def _fake_stripe(calls: _Calls) -> types.ModuleType:
    mod = types.ModuleType("stripe")
    mod.api_key = None

    def endpoint(label):
        return lambda **kw: calls.add(label, **kw)

    mod.Customer = SimpleNamespace(list=endpoint("Customer.list"), create=endpoint("Customer.create"))
    mod.Invoice = SimpleNamespace(
        create=endpoint("Invoice.create"),
        finalize_invoice=lambda iid, **kw: calls.add("Invoice.finalize", id=iid, **kw),
        send_invoice=lambda iid, **kw: calls.add("Invoice.send", id=iid, **kw),
    )
    mod.Product = SimpleNamespace(create=endpoint("Product.create"))
    mod.InvoiceItem = SimpleNamespace(create=endpoint("InvoiceItem.create"))
    return mod


def _ctx(**over):
    base = dict(
        db=None,
        club=SimpleNamespace(clubsid=45, name="Club Alpha", email="alpha@example.org"),
        org_club=SimpleNamespace(name="Société", stripe_account_id="acct_1"),
        items=[
            {"event_number": None, "event_name": "TREMBLAY, Anne", "description": "Frais d'athlète $5.00, 2 individuelles",
             "qty": 1, "unit_cents": 2500},
            {"event_number": None, "event_name": "Frais de club", "description": "", "qty": 1, "unit_cents": 1000},
        ],
        invoice_no="2026-012-0045", total_cents=3500, meet_name="Championnat", meetsid=12, lang="fr",
    )
    base.update(over)
    return InvoiceContext(**base)


class TestStripePush:
    def test_same_calls_as_before(self, monkeypatch):
        calls = _Calls()
        monkeypatch.setitem(sys.modules, "stripe", _fake_stripe(calls))
        monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")

        result = StripeProvider().push(_ctx())

        names = [n for n, _ in calls]
        assert names == [
            "Customer.list", "Customer.create", "Invoice.create",
            "Product.create", "InvoiceItem.create", "Product.create", "InvoiceItem.create",
            "Invoice.finalize", "Invoice.send",
        ]
        by = {n: kw for n, kw in calls}
        assert by["Customer.list"]["stripe_account"] == "acct_1"
        inv = by["Invoice.create"]
        assert inv["currency"] == "cad" and inv["collection_method"] == "send_invoice"
        assert inv["metadata"]["meetmanager_invoice_no"] == "2026-012-0045"
        assert {"name": "N° facture", "value": "2026-012-0045"} in inv["custom_fields"]
        item = [kw for n, kw in calls if n == "InvoiceItem.create"][0]
        assert item["price_data"]["unit_amount"] == 2500 and item["quantity"] == 1
        assert result.external_id.startswith("Invoice.create")

    def test_no_key_is_a_500(self):
        with pytest.raises(ProviderError) as e:
            StripeProvider().push(_ctx())
        assert e.value.status == 500

    def test_organizer_without_account_is_a_400(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "stripe", _fake_stripe(_Calls()))
        monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")
        ctx = _ctx(org_club=SimpleNamespace(name="Société", stripe_account_id=None))
        with pytest.raises(ProviderError) as e:
            StripeProvider().push(ctx)
        assert e.value.status == 400


class _Account:
    def __init__(self, acct_id, charges_enabled=True):
        self.id, self.charges_enabled = acct_id, charges_enabled


class _DB:
    commits = 0

    def commit(self):
        self.commits += 1


class _InvalidRequestError(Exception):
    pass


def _fake_connect_stripe(retrieve=None):
    mod = types.ModuleType("stripe")
    mod.api_key = None
    mod.InvalidRequestError = _InvalidRequestError
    mod.created = []
    mod.Account = SimpleNamespace(
        retrieve=retrieve or (lambda acct: _Account(acct)),
        create=lambda **kw: (mod.created.append(kw), _Account("acct_new"))[1],
    )
    mod.AccountLink = SimpleNamespace(create=lambda **kw: SimpleNamespace(url=f"https://connect.example/{kw['account']}"))
    return mod


class TestStripeConnect:
    def _club(self, account=None, nation="CAN"):
        return SimpleNamespace(name="Société", email="soc@example.org", nation=nation, stripe_account_id=account)

    def test_status_needs_a_key_and_an_account(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "stripe", _fake_connect_stripe())
        assert StripeProvider().status(None, None) == {"connected": False}
        assert StripeProvider().status(None, self._club(account=None)) == {"connected": False}
        assert StripeProvider().status(None, self._club(account="acct_1")) == {"connected": False}  # no key

    def test_status_reports_charges_enabled(self, monkeypatch):
        monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")
        monkeypatch.setitem(sys.modules, "stripe", _fake_connect_stripe(lambda a: _Account(a, charges_enabled=False)))
        assert StripeProvider().status(None, self._club("acct_1")) == {"connected": False, "account_id": "acct_1"}
        monkeypatch.setitem(sys.modules, "stripe", _fake_connect_stripe())
        assert StripeProvider().status(None, self._club("acct_1")) == {"connected": True, "account_id": "acct_1"}

    def test_status_never_raises(self, monkeypatch):
        def boom(acct):
            raise RuntimeError("stripe down")
        monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")
        monkeypatch.setitem(sys.modules, "stripe", _fake_connect_stripe(boom))
        assert StripeProvider().status(None, self._club("acct_1")) == {"connected": False}

    def test_connect_creates_a_prefilled_account_and_returns_the_link(self, monkeypatch):
        monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")
        fake = _fake_connect_stripe()
        monkeypatch.setitem(sys.modules, "stripe", fake)
        club, db = self._club(account=None, nation="USA"), _DB()
        out = StripeProvider().connect_start(db, club)
        assert club.stripe_account_id == "acct_new" and db.commits == 1
        assert out == {"url": "https://connect.example/acct_new"}
        created = fake.created[0]
        assert created["type"] == "standard" and created["country"] == "US" and created["email"] == "soc@example.org"
        assert created["business_profile"]["mcc"] == "8699" and created["business_type"] == "non_profit"

    def test_connect_keeps_a_live_account(self, monkeypatch):
        monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")
        fake = _fake_connect_stripe()
        monkeypatch.setitem(sys.modules, "stripe", fake)
        club = self._club(account="acct_live")
        assert StripeProvider().connect_start(_DB(), club)["url"].endswith("acct_live")
        assert fake.created == []

    def test_connect_replaces_an_account_deleted_on_stripe(self, monkeypatch):
        def gone(acct):
            raise _InvalidRequestError("No such account")
        monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")
        fake = _fake_connect_stripe(gone)
        monkeypatch.setitem(sys.modules, "stripe", fake)
        club = self._club(account="acct_dangling")
        out = StripeProvider().connect_start(_DB(), club)
        assert club.stripe_account_id == "acct_new" and out["url"].endswith("acct_new")

    def test_connect_without_a_key_is_a_500(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "stripe", _fake_connect_stripe())
        with pytest.raises(ProviderError) as e:
            StripeProvider().connect_start(_DB(), self._club())
        assert e.value.status == 500

    def test_disconnect_forgets_the_account(self):
        club, db = self._club(account="acct_1"), _DB()
        StripeProvider().disconnect(db, club)
        assert club.stripe_account_id is None and db.commits == 1

    def test_unknown_nation_falls_back_to_canada(self, monkeypatch):
        monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")
        fake = _fake_connect_stripe()
        monkeypatch.setitem(sys.modules, "stripe", fake)
        StripeProvider().connect_start(_DB(), self._club(nation="ZZZ"))
        assert fake.created[0]["country"] == "CA"
