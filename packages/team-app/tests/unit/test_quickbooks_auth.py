"""Unit tests for the QuickBooks OAuth connection: consent URL + one-time state,
code exchange, encrypted token storage, refresh/rotation (including under
concurrency), reconnect detection, keepalive, disconnect, and the public
callback route. Intuit is an httpx MockTransport — no network, no Docker.

Run: `pytest tests/unit/test_quickbooks_auth.py -v`
"""
from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, BsGlobal
from app import models_team, models_live, models_serc  # noqa: F401 — register tables
from app.database import get_db
from app.invoice_providers import (
    ProviderError, get_provider, quickbooks_auth as qbo, selected_provider_name,
)
from app.invoice_providers.quickbooks_provider import QuickBooksProvider
from app.routers.quickbooks import router as qbo_router


class FakeIntuit:
    """Records every request and answers like Intuit's token + accounting APIs."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.token_status = 200
        self.token_error = None            # e.g. "invalid_grant"
        self.api_status = [200]            # statuses served in turn (last repeats)
        self.delay = 0.0
        self._n = 0
        self.lock = threading.Lock()

    def handler(self, request: httpx.Request) -> httpx.Response:
        with self.lock:
            self.requests.append(request)
        url = str(request.url)
        if "/tokens/bearer" in url:
            if self.delay:
                time.sleep(self.delay)
            if self.token_status != 200:
                body = {"error": self.token_error} if self.token_error else {}
                return httpx.Response(self.token_status, json=body)
            with self.lock:
                self._n += 1
                n = self._n
            return httpx.Response(200, json={
                "access_token": f"access-{n}", "refresh_token": f"refresh-{n}",
                "expires_in": 3600, "x_refresh_token_expires_in": 8726400,
            })
        if "/tokens/revoke" in url:
            return httpx.Response(200, json={})
        if "/companyinfo/" in url:
            with self.lock:
                status = self.api_status.pop(0) if len(self.api_status) > 1 else self.api_status[0]
            if status == 401:
                return httpx.Response(401, json={"fault": "AuthenticationFailed"})
            if status >= 400:
                return httpx.Response(status, json={"Fault": {"Error": [
                    {"Message": "Boom", "Detail": "detail"}]}})
            return httpx.Response(200, json={"CompanyInfo": {"CompanyName": "Société de sauvetage"}})
        return httpx.Response(404)

    def token_requests(self):
        return [r for r in self.requests if "/tokens/bearer" in str(r.url)]

    def form(self, req: httpx.Request) -> dict:
        return {k: v[0] for k, v in parse_qs(req.content.decode()).items()}


@pytest.fixture
def intuit(monkeypatch):
    fake = FakeIntuit()
    monkeypatch.setattr(qbo, "_transport", httpx.MockTransport(fake.handler))
    return fake


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for k in ("INVOICE_PROVIDER", "STRIPE_API_KEY", "QBO_ENVIRONMENT", "QBO_REDIRECT_URI",
              "QBO_AUTH_URL", "QBO_TOKEN_URL", "QBO_REVOKE_URL", "QBO_API_BASE", "APP_BASE_URL"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SECRET_KEY", "test-secret-key")
    monkeypatch.setenv("QBO_CLIENT_ID", "cid")
    monkeypatch.setenv("QBO_CLIENT_SECRET", "csecret")


@pytest.fixture
def engine(tmp_path):
    # A file, not :memory:, so the concurrency test's threads share one database.
    eng = create_engine(f"sqlite:///{tmp_path / 'qbo.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    return eng


@pytest.fixture
def db(engine):
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def _connect(db, intuit, realm="123"):
    """A completed connection, as the callback would leave it."""
    qbo.begin_connect(db)
    return qbo.exchange_code(db, "the-code", realm)


def _age(db, **changes):
    conn = qbo.load_connection(db)
    for k, v in changes.items():
        setattr(conn, k, v)
    qbo.save_connection(db, conn)


class TestConsent:
    def test_url_carries_client_scope_redirect_and_state(self, db):
        url = qbo.begin_connect(db)
        parsed = urlparse(url)
        q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        assert parsed.netloc == "appcenter.intuit.com"
        assert q["client_id"] == "cid" and q["response_type"] == "code"
        assert q["scope"] == "com.intuit.quickbooks.accounting"
        assert q["redirect_uri"] == "http://localhost:8001/api/quickbooks/callback"
        assert qbo.consume_state(db, q["state"]) is True

    def test_redirect_uri_follows_env(self, db, monkeypatch):
        monkeypatch.setenv("APP_BASE_URL", "https://team.example.org/")
        assert qbo.redirect_uri() == "https://team.example.org/api/quickbooks/callback"
        monkeypatch.setenv("QBO_REDIRECT_URI", "https://elsewhere.example/cb")
        assert qbo.redirect_uri() == "https://elsewhere.example/cb"

    def test_not_configured(self, db, monkeypatch):
        monkeypatch.delenv("QBO_CLIENT_ID")
        with pytest.raises(ProviderError) as e:
            qbo.begin_connect(db)
        assert e.value.status == 500

    def test_state_is_single_use(self, db):
        state = parse_qs(urlparse(qbo.begin_connect(db)).query)["state"][0]
        assert qbo.consume_state(db, state) is True
        assert qbo.consume_state(db, state) is False

    def test_wrong_state_is_rejected_and_burns_the_real_one(self, db):
        state = parse_qs(urlparse(qbo.begin_connect(db)).query)["state"][0]
        assert qbo.consume_state(db, "forged") is False
        assert qbo.consume_state(db, state) is False

    def test_expired_state(self, db, monkeypatch):
        state = parse_qs(urlparse(qbo.begin_connect(db)).query)["state"][0]
        real = time.time()
        monkeypatch.setattr(qbo.time, "time", lambda: real + qbo.STATE_TTL_SECONDS + 1)
        assert qbo.consume_state(db, state) is False

    def test_no_state_issued(self, db):
        assert qbo.consume_state(db, "anything") is False


class TestExchangeAndStorage:
    def test_exchange_stores_encrypted_connection_and_company_name(self, db, intuit):
        conn = _connect(db, intuit, realm="9130")
        form = intuit.form(intuit.token_requests()[0])
        assert form["grant_type"] == "authorization_code" and form["code"] == "the-code"
        assert form["redirect_uri"] == "http://localhost:8001/api/quickbooks/callback"
        auth = intuit.token_requests()[0].headers["authorization"]
        assert auth.startswith("Basic ")
        info_req = [r for r in intuit.requests if "/companyinfo/" in str(r.url)][0]
        assert "/v3/company/9130/companyinfo/9130" in str(info_req.url)
        assert "minorversion=75" in str(info_req.url)
        assert info_req.headers["authorization"] == "Bearer access-1"
        assert conn.company_name == "Société de sauvetage"

        raw = db.get(BsGlobal, qbo.CONN_KEY).data
        assert "access-1" not in raw and "refresh-1" not in raw  # encrypted at rest
        loaded = qbo.load_connection(db)
        assert loaded.refresh_token == "refresh-1" and loaded.realm_id == "9130"

    def test_status(self, db, intuit):
        assert qbo.status(db)["connected"] is False
        _connect(db, intuit)
        st = qbo.status(db)
        assert st["connected"] is True and st["company_name"] == "Société de sauvetage"
        assert st["environment"] == "sandbox" and st["reconnect_required"] is False

    def test_status_makes_no_network_call(self, db, intuit):
        _connect(db, intuit)
        before = len(intuit.requests)
        qbo.status(db)
        assert len(intuit.requests) == before

    def test_other_environment_counts_as_not_connected(self, db, intuit, monkeypatch):
        _connect(db, intuit)
        monkeypatch.setenv("QBO_ENVIRONMENT", "production")
        assert qbo.status(db)["connected"] is False
        with pytest.raises(ProviderError):
            qbo.get_access_token(db)

    def test_changed_secret_key_means_not_connected(self, db, intuit, monkeypatch):
        _connect(db, intuit)
        monkeypatch.setenv("SECRET_KEY", "a-different-key")
        assert qbo.load_connection(db) is None
        assert qbo.status(db)["connected"] is False

    def test_name_lookup_failure_does_not_fail_the_connect(self, db, intuit):
        intuit.api_status = [500]
        conn = _connect(db, intuit)
        assert conn.company_name is None
        assert qbo.status(db)["connected"] is True

    def test_token_endpoint_refusal(self, db, intuit):
        intuit.token_status, intuit.token_error = 400, "invalid_client"
        qbo.begin_connect(db)
        with pytest.raises(ProviderError) as e:
            qbo.exchange_code(db, "bad", "1")
        assert e.value.status == 400
        assert qbo.load_connection(db) is None


class TestRefresh:
    def test_fresh_token_is_not_refreshed(self, db, intuit):
        _connect(db, intuit)
        assert qbo.get_access_token(db) == ("access-1", "123")
        assert len(intuit.token_requests()) == 1

    def test_expired_token_refreshes_and_persists_the_rotated_refresh_token(self, db, intuit):
        _connect(db, intuit)
        _age(db, access_expires_at=time.time() - 10)
        assert qbo.get_access_token(db) == ("access-2", "123")
        form = intuit.form(intuit.token_requests()[1])
        assert form == {"grant_type": "refresh_token", "refresh_token": "refresh-1"}
        stored = qbo.load_connection(db)
        assert stored.refresh_token == "refresh-2" and stored.access_token == "access-2"

    def test_invalid_grant_flags_reconnect_and_stops_calling_intuit(self, db, intuit):
        _connect(db, intuit)
        _age(db, access_expires_at=time.time() - 10)
        intuit.token_status, intuit.token_error = 400, "invalid_grant"
        with pytest.raises(ProviderError):
            qbo.get_access_token(db)
        st = qbo.status(db)
        assert st["connected"] is False and st["reconnect_required"] is True
        calls = len(intuit.requests)
        with pytest.raises(ProviderError):
            qbo.get_access_token(db)
        assert len(intuit.requests) == calls

    def test_transient_failure_never_flags_reconnect(self, db, intuit):
        _connect(db, intuit)
        _age(db, access_expires_at=time.time() - 10)
        intuit.token_status = 503
        with pytest.raises(ProviderError) as e:
            qbo.get_access_token(db)
        assert e.value.status == 502
        assert qbo.status(db)["connected"] is True
        intuit.token_status = 200
        assert qbo.get_access_token(db)[0] == "access-2"

    def test_expired_refresh_token_reports_reconnect(self, db, intuit):
        _connect(db, intuit)
        _age(db, refresh_expires_at=time.time() - 1)
        st = qbo.status(db)
        assert st["connected"] is False and st["reconnect_required"] is True

    def test_concurrent_callers_refresh_once(self, engine, intuit):
        setup = sessionmaker(bind=engine)()
        _connect(setup, intuit)
        _age(setup, access_expires_at=time.time() - 10)
        setup.close()
        intuit.delay = 0.15  # widen the race window
        results, errors = [], []

        def worker():
            s = sessionmaker(bind=engine)()
            try:
                results.append(qbo.get_access_token(s)[0])
            except Exception as e:  # pragma: no cover - would fail the asserts below
                errors.append(e)
            finally:
                s.close()

        threads = [threading.Thread(target=worker) for _ in range(8)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        assert not errors
        assert set(results) == {"access-2"}
        assert len(intuit.token_requests()) == 2  # the connect + exactly one refresh


class TestApiRequest:
    def test_401_refreshes_once_and_retries(self, db, intuit):
        _connect(db, intuit)
        intuit.api_status = [401, 200]
        out = qbo.api_request(db, "GET", "companyinfo/123")
        assert out["CompanyInfo"]["CompanyName"] == "Société de sauvetage"
        assert len(intuit.token_requests()) == 2
        assert intuit.requests[-1].headers["authorization"] == "Bearer access-2"

    def test_refusal_message_comes_from_the_fault(self, db, intuit):
        _connect(db, intuit)
        intuit.api_status = [400]
        with pytest.raises(ProviderError) as e:
            qbo.api_request(db, "GET", "companyinfo/123")
        assert "Boom" in e.value.message and e.value.status == 400

    def test_server_error_is_a_502(self, db, intuit):
        _connect(db, intuit)
        intuit.api_status = [500]
        with pytest.raises(ProviderError) as e:
            qbo.api_request(db, "GET", "companyinfo/123")
        assert e.value.status == 502

    def test_not_connected(self, db, intuit):
        with pytest.raises(ProviderError):
            qbo.api_request(db, "GET", "companyinfo/1")
        assert intuit.requests == []

    def test_api_base_follows_environment(self, monkeypatch):
        assert qbo.api_base() == "https://sandbox-quickbooks.api.intuit.com"
        monkeypatch.setenv("QBO_ENVIRONMENT", "production")
        assert qbo.api_base() == "https://quickbooks.api.intuit.com"
        monkeypatch.setenv("QBO_API_BASE", "http://fake-qbo:9000/")
        assert qbo.api_base() == "http://fake-qbo:9000"


class TestKeepalive:
    def test_recent_connection_is_left_alone(self, db, intuit):
        _connect(db, intuit)
        assert qbo.keepalive(db) is False
        assert len(intuit.token_requests()) == 1

    def test_idle_connection_is_refreshed(self, db, intuit):
        _connect(db, intuit)
        _age(db, refreshed_at=time.time() - 8 * 86400)
        assert qbo.keepalive(db) is True
        assert qbo.load_connection(db).refresh_token == "refresh-2"

    def test_not_connected(self, db, intuit):
        assert qbo.keepalive(db) is False

    def test_failure_does_not_raise(self, db, intuit):
        _connect(db, intuit)
        _age(db, refreshed_at=time.time() - 8 * 86400)
        intuit.token_status = 503
        assert qbo.keepalive(db) is False


class TestDisconnect:
    def test_revokes_and_forgets(self, db, intuit):
        _connect(db, intuit)
        qbo.disconnect(db)
        revoke = [r for r in intuit.requests if "/tokens/revoke" in str(r.url)][0]
        assert json.loads(revoke.content) == {"token": "refresh-1"}
        assert db.get(BsGlobal, qbo.CONN_KEY) is None
        assert qbo.status(db)["connected"] is False

    def test_forgets_even_when_revoke_fails(self, db, intuit, monkeypatch):
        _connect(db, intuit)

        def boom(request):
            raise httpx.ConnectError("down")
        monkeypatch.setattr(qbo, "_transport", httpx.MockTransport(boom))
        qbo.disconnect(db)
        assert db.get(BsGlobal, qbo.CONN_KEY) is None

    def test_when_nothing_is_connected(self, db, intuit):
        qbo.disconnect(db)
        assert intuit.requests == []


class TestProvider:
    def test_selected_by_env(self, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "quickbooks")
        assert selected_provider_name() == "quickbooks"
        assert isinstance(get_provider(), QuickBooksProvider)

    def test_status_when_unconfigured(self, db, monkeypatch):
        monkeypatch.delenv("QBO_CLIENT_SECRET")
        assert QuickBooksProvider().status(db, None) == {"connected": False, "reconnect_required": False}

    def test_connect_start_returns_the_consent_url(self, db):
        out = QuickBooksProvider().connect_start(db, org_club=None)
        assert out["url"].startswith("https://appcenter.intuit.com/connect/oauth2?")


class TestCallbackRoute:
    @pytest.fixture
    def client(self, engine, intuit, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "quickbooks")
        app = FastAPI()
        app.include_router(qbo_router)
        Session = sessionmaker(bind=engine)

        def _get_db():
            s = Session()
            try:
                yield s
            finally:
                s.close()
        app.dependency_overrides[get_db] = _get_db
        self.Session = Session
        return TestClient(app, follow_redirects=False)

    def _state(self):
        s = self.Session()
        try:
            return parse_qs(urlparse(qbo.begin_connect(s)).query)["state"][0]
        finally:
            s.close()

    def test_success_needs_no_pin_header(self, client, intuit):
        state = self._state()
        r = client.get("/api/quickbooks/callback", params={"code": "c", "state": state, "realmId": "55"})
        assert r.status_code == 303 and r.headers["location"] == "/organizer?quickbooks=success"
        s = self.Session()
        assert qbo.load_connection(s).realm_id == "55"
        s.close()

    def test_forged_state_is_refused_before_any_token_call(self, client, intuit):
        self._state()
        r = client.get("/api/quickbooks/callback", params={"code": "c", "state": "forged", "realmId": "55"})
        assert r.headers["location"] == "/organizer?quickbooks=error&reason=state"
        assert intuit.token_requests() == []

    def test_replayed_callback_is_refused(self, client, intuit):
        state = self._state()
        params = {"code": "c", "state": state, "realmId": "55"}
        client.get("/api/quickbooks/callback", params=params)
        again = client.get("/api/quickbooks/callback", params=params)
        assert again.headers["location"].endswith("reason=state")

    def test_user_declined(self, client, intuit):
        state = self._state()
        r = client.get("/api/quickbooks/callback", params={"error": "access_denied", "state": state})
        assert r.headers["location"] == "/organizer?quickbooks=error&reason=denied"
        assert intuit.token_requests() == []

    def test_missing_code(self, client, intuit):
        state = self._state()
        r = client.get("/api/quickbooks/callback", params={"state": state})
        assert r.headers["location"].endswith("reason=invalid")

    def test_token_exchange_failure(self, client, intuit):
        state = self._state()
        intuit.token_status, intuit.token_error = 400, "invalid_client"
        r = client.get("/api/quickbooks/callback", params={"code": "c", "state": state, "realmId": "1"})
        assert r.headers["location"].endswith("reason=token")

    def test_ignored_when_quickbooks_is_not_the_provider(self, client, intuit, monkeypatch):
        monkeypatch.setenv("INVOICE_PROVIDER", "stripe")
        r = client.get("/api/quickbooks/callback", params={"code": "c", "state": "s", "realmId": "1"})
        assert r.headers["location"].endswith("reason=not_enabled")
        assert intuit.requests == []
