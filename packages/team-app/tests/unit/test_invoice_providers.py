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
