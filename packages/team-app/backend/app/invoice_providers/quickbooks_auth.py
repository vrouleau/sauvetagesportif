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

"""QuickBooks Online: OAuth2 connection, encrypted token storage and the thin
HTTP client every QuickBooks call goes through.

One QuickBooks connection per *club* (the "owner"): whichever club organizes a
meet connects its own QuickBooks company through Intuit's consent page, and the
invoices of that meet are created there. Owner `0` is the installation-level
slot (diagnostics and tests); the app itself always acts as the organizer club.
The Intuit app (QBO_CLIENT_ID/SECRET) is one and shared: each club authorizes it
for its own company.

Token handling, the parts that bite:
- Access tokens last ~1 h; they are refreshed lazily before use (`get_access_token`).
- Every refresh returns a NEW refresh token and invalidates the old one, so the
  new one is committed to the database before the new access token is used.
- Refreshes are serialized by a process-wide lock, and each one re-reads the
  stored tokens first: a second caller that waited on the lock finds the tokens
  already rotated and does not refresh again (which would burn the token).
  This assumes a single backend process, as deployed (one uvicorn worker, one
  SQLite file).
- The refresh token's 100-day window is extended by every use, so a periodic
  `keepalive` keeps an idle installation connected through the off-season.
- Only an `invalid_grant` answer marks the connection as needing a reconnect;
  network errors and 5xx never do.

Each connection is stored in `bsglobal` (key `qbo_connection:<club id>`), Fernet-
encrypted with a key derived from SECRET_KEY (see secret_box); the per-club
invoice settings (tax code, income account, item) sit beside it, unencrypted
(`qbo_settings:<club id>` — names, not secrets). `status()` never touches
the network. Restoring an older database backup brings back an already-rotated
refresh token: the connection then reports "reconnect required".
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
from dataclasses import asdict, dataclass
from typing import Any, Optional
from urllib.parse import urlencode

import httpx
from sqlalchemy.orm import Session, sessionmaker

from ..meet_config import _get_config, _set_config
from ..models import BsGlobal
from ..secret_box import decrypt_text, encrypt_text
from .base import ProviderError

log = logging.getLogger("quickbooks")

SCOPE = "com.intuit.quickbooks.accounting"
# Pinned so Intuit's response shape doesn't change under us.
MINOR_VERSION = 75

CONN_KEY = "qbo_connection"
SETTINGS_KEY = "qbo_settings"
STATE_PREFIX = "qbo_oauth_state:"
INSTALLATION = 0   # the owner id of the installation-level slot (no club)
STATE_TTL_SECONDS = 600
ACCESS_SKEW_SECONDS = 120            # refresh this long before the access token expires
KEEPALIVE_AFTER_SECONDS = 7 * 86400  # refresh an idle connection at least this often
HTTP_TIMEOUT = 20

_DEFAULT_URLS = {
    "auth": "https://appcenter.intuit.com/connect/oauth2",
    "token": "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    "revoke": "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
}
_API_BASES = {
    "sandbox": "https://sandbox-quickbooks.api.intuit.com",
    "production": "https://quickbooks.api.intuit.com",
}

_refresh_lock = threading.Lock()

# Tests (and a future fake-qbo service) inject an httpx transport here.
_transport: Optional[httpx.BaseTransport] = None


# ---------------------------------------------------------------------------
# Configuration (env)
# ---------------------------------------------------------------------------

def client_id() -> str:
    return (os.environ.get("QBO_CLIENT_ID") or "").strip()


def client_secret() -> str:
    return (os.environ.get("QBO_CLIENT_SECRET") or "").strip()


def configured() -> bool:
    return bool(client_id() and client_secret())


def environment() -> str:
    """`sandbox` or `production`. Defaults to sandbox so a missing setting can
    never reach the real books by accident."""
    env = (os.environ.get("QBO_ENVIRONMENT") or "sandbox").strip().lower()
    return "production" if env == "production" else "sandbox"


def redirect_uri() -> str:
    explicit = (os.environ.get("QBO_REDIRECT_URI") or "").strip()
    if explicit:
        return explicit
    base = (os.environ.get("APP_BASE_URL") or "http://localhost:8001").rstrip("/")
    return f"{base}/api/quickbooks/callback"


def _url(kind: str) -> str:
    """Intuit endpoint `auth` | `token` | `revoke`; QBO_<KIND>_URL overrides."""
    override = (os.environ.get(f"QBO_{kind.upper()}_URL") or "").strip()
    return override or _DEFAULT_URLS[kind]


def api_base() -> str:
    override = (os.environ.get("QBO_API_BASE") or "").strip()
    return override.rstrip("/") if override else _API_BASES[environment()]


def _client() -> httpx.Client:
    return httpx.Client(transport=_transport, timeout=HTTP_TIMEOUT)


# ---------------------------------------------------------------------------
# Stored connection
# ---------------------------------------------------------------------------

def _key(base: str, owner: int) -> str:
    """bsglobal key of an owner's record: the bare name for the installation slot."""
    return base if owner == INSTALLATION else f"{base}:{owner}"


@dataclass
class Connection:
    realm_id: str
    access_token: str
    access_expires_at: float       # epoch seconds
    refresh_token: str
    refresh_expires_at: float      # epoch seconds
    environment: str
    refreshed_at: float            # when the tokens were last obtained
    company_name: Optional[str] = None
    needs_reconnect: bool = False


def load_connection(db: Session, owner: int = INSTALLATION) -> Optional[Connection]:
    raw = _get_config(db, _key(CONN_KEY, owner))
    if not raw:
        return None
    plain = decrypt_text(raw)
    if plain is None:
        return None  # SECRET_KEY changed: unreadable, same as not connected
    try:
        return Connection(**json.loads(plain))
    except (ValueError, TypeError):
        return None


def save_connection(db: Session, conn: Connection, owner: int = INSTALLATION) -> None:
    _set_config(db, _key(CONN_KEY, owner), encrypt_text(json.dumps(asdict(conn))))
    db.commit()


def _usable(conn: Optional[Connection]) -> bool:
    return bool(
        conn and not conn.needs_reconnect and conn.environment == environment()
        and conn.refresh_expires_at > time.time()
    )


def status(db: Session, owner: int = INSTALLATION) -> dict:
    """Connection state for the UI. Local only — no call to Intuit."""
    conn = load_connection(db, owner)
    if not conn or conn.environment != environment():
        return {"connected": False, "reconnect_required": False, "environment": environment()}
    reconnect = conn.needs_reconnect or conn.refresh_expires_at <= time.time()
    return {
        "connected": not reconnect,
        "reconnect_required": reconnect,
        "company_name": conn.company_name,
        "realm_id": conn.realm_id,
        "environment": conn.environment,
    }


# ---------------------------------------------------------------------------
# Connect / callback / disconnect
# ---------------------------------------------------------------------------

def begin_connect(db: Session, owner: int = INSTALLATION) -> str:
    """Store a one-time `state` for this owner and return Intuit's consent-page URL."""
    if not configured():
        raise ProviderError("QBO_CLIENT_ID / QBO_CLIENT_SECRET not configured", 500)
    _purge_states(db)
    nonce = secrets.token_urlsafe(24)
    _set_config(db, STATE_PREFIX + nonce, f"{time.time() + STATE_TTL_SECONDS}|{owner}")
    db.commit()
    return _url("auth") + "?" + urlencode({
        "client_id": client_id(),
        "scope": SCOPE,
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "state": nonce,
    })


def _purge_states(db: Session) -> None:
    """Drop the connect attempts nobody came back from."""
    now = time.time()
    for row in db.query(BsGlobal).filter(BsGlobal.name.like(STATE_PREFIX + "%")).all():
        try:
            if float((row.data or "").partition("|")[0]) <= now:
                db.delete(row)
        except ValueError:
            db.delete(row)
    db.commit()


def consume_state(db: Session, state: str) -> Optional[int]:
    """The owner the `state` was issued for — once, if still fresh — else None.

    The callback is a browser redirect carrying no app credentials, so this
    one-time, server-side state is what ties it to a connect a club's organizer
    started (and tells it which club the connection belongs to). Each connect
    attempt has its own state, so two clubs connecting at once don't collide.
    """
    if not state:
        return None
    cfg = db.get(BsGlobal, STATE_PREFIX + state)
    if not cfg or not cfg.data:
        return None
    raw = cfg.data
    db.delete(cfg)  # single use
    db.commit()
    expires, _, owner = raw.partition("|")
    try:
        if float(expires) <= time.time():
            return None
        return int(owner)
    except ValueError:
        return None


def _token_request(data: dict[str, str]) -> dict[str, Any]:
    """POST to Intuit's token endpoint. Raises ProviderError; an
    `invalid_grant` answer carries status 401 so callers can tell it from a
    transient failure."""
    try:
        with _client() as c:
            resp = c.post(
                _url("token"), data=data, auth=(client_id(), client_secret()),
                headers={"Accept": "application/json"},
            )
    except httpx.HTTPError as e:
        raise ProviderError(f"Could not reach QuickBooks: {e.__class__.__name__}", 502)
    if resp.status_code == 200:
        return resp.json()
    try:
        err = resp.json().get("error", "")
    except ValueError:
        err = ""
    if err == "invalid_grant":
        raise ProviderError("QuickBooks connection expired or revoked — reconnect", 401)
    raise ProviderError(f"QuickBooks token request failed ({resp.status_code})",
                        502 if resp.status_code >= 500 else 400)


def _apply_tokens(conn: Connection, tok: dict[str, Any]) -> None:
    now = time.time()
    conn.access_token = tok["access_token"]
    conn.access_expires_at = now + float(tok.get("expires_in", 3600))
    conn.refresh_token = tok["refresh_token"]
    conn.refresh_expires_at = now + float(tok.get("x_refresh_token_expires_in", 100 * 86400))
    conn.refreshed_at = now
    conn.needs_reconnect = False


def exchange_code(db: Session, code: str, realm_id: str, owner: int = INSTALLATION) -> Connection:
    """Callback step: trade the authorization code for tokens and store them.

    Connecting to a *different* company than before drops the owner's invoice
    settings: they name things that exist only in the old company file."""
    tok = _token_request({
        "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(),
    })
    conn = Connection(
        realm_id=str(realm_id), access_token="", access_expires_at=0, refresh_token="",
        refresh_expires_at=0, environment=environment(), refreshed_at=0,
    )
    _apply_tokens(conn, tok)
    previous = load_connection(db, owner)
    if previous and previous.realm_id != conn.realm_id:
        clear_settings(db, owner)
    save_connection(db, conn, owner)
    try:  # cosmetic: show the company's name in the UI
        info = api_request(db, "GET", f"companyinfo/{conn.realm_id}", owner=owner)
        conn.company_name = (info.get("CompanyInfo") or {}).get("CompanyName")
        save_connection(db, conn, owner)
    except ProviderError:
        log.warning("QuickBooks connected, but the company name lookup failed", exc_info=True)
    return conn


def disconnect(db: Session, owner: int = INSTALLATION) -> None:
    """Revoke at Intuit (best effort) and forget the owner's connection. Their
    invoice settings stay, so reconnecting the same company needs only consent."""
    conn = load_connection(db, owner)
    if conn and conn.refresh_token and configured():
        try:
            with _client() as c:
                c.post(_url("revoke"), json={"token": conn.refresh_token},
                       auth=(client_id(), client_secret()),
                       headers={"Accept": "application/json"})
        except httpx.HTTPError:
            log.warning("QuickBooks token revoke failed; connection removed locally anyway")
    cfg = db.get(BsGlobal, _key(CONN_KEY, owner))
    if cfg:
        db.delete(cfg)
        db.commit()


# ---------------------------------------------------------------------------
# Per-owner invoice settings (which tax code / income account / item to use)
# ---------------------------------------------------------------------------

SETTING_FIELDS = ("tax_code", "income_account", "item_name")


def load_settings(db: Session, owner: int = INSTALLATION) -> dict[str, str]:
    """`{tax_code, income_account, item_name}`; a field is "" until chosen."""
    try:
        raw = json.loads(_get_config(db, _key(SETTINGS_KEY, owner)) or "{}")
    except ValueError:
        raw = {}
    return {f: str(raw.get(f) or "").strip() for f in SETTING_FIELDS}


def save_settings(db: Session, owner: int, values: dict[str, str]) -> dict[str, str]:
    clean = {f: str(values.get(f) or "").strip() for f in SETTING_FIELDS}
    _set_config(db, _key(SETTINGS_KEY, owner), json.dumps(clean))
    db.commit()
    return clean


def clear_settings(db: Session, owner: int) -> None:
    cfg = db.get(BsGlobal, _key(SETTINGS_KEY, owner))
    if cfg:
        db.delete(cfg)
        db.commit()


def owners_with_connection(db: Session) -> list[int]:
    """Every owner that has a stored connection (for the keepalive)."""
    keys = [k for (k,) in db.query(BsGlobal.name).filter(
        (BsGlobal.name == CONN_KEY) | BsGlobal.name.like(CONN_KEY + ":%")).all()]
    return sorted(INSTALLATION if k == CONN_KEY else int(k.rpartition(":")[2]) for k in keys)


# ---------------------------------------------------------------------------
# Tokens for API calls
# ---------------------------------------------------------------------------

def _fresh_session(db: Session) -> Session:
    """A separate session on the caller's database, so the rotated token is
    committed on its own and the caller's pending work is untouched."""
    return sessionmaker(bind=db.get_bind())()


def _refresh(db: Session, owner: int = INSTALLATION, *, rejected: Optional[str] = None,
             force: bool = False) -> Connection:
    """Refresh under the lock; a no-op when another caller already did.

    `rejected`: an access token Intuit just answered 401 to — refresh only if
    it is still the stored one. `force`: refresh regardless (keepalive).
    """
    with _refresh_lock:
        s = _fresh_session(db)
        try:
            conn = load_connection(s, owner)
            if not _usable(conn):
                raise ProviderError("QuickBooks is not connected", 400)
            if force:
                needed = True
            elif rejected is not None:
                needed = conn.access_token == rejected
            else:
                needed = conn.access_expires_at - ACCESS_SKEW_SECONDS <= time.time()
            if not needed:
                return conn
            try:
                tok = _token_request({"grant_type": "refresh_token",
                                      "refresh_token": conn.refresh_token})
            except ProviderError as e:
                if e.status == 401:  # invalid_grant: only a reconnect can fix this
                    conn.needs_reconnect = True
                    save_connection(s, conn, owner)
                    raise ProviderError("QuickBooks connection expired — reconnect", 400)
                raise
            _apply_tokens(conn, tok)
            save_connection(s, conn, owner)  # persist the rotated refresh token first
            return conn
        finally:
            s.close()


def get_access_token(db: Session, owner: int = INSTALLATION) -> tuple[str, str]:
    """`(access_token, realm_id)` of the owner's company, refreshing first if it
    is about to expire."""
    conn = load_connection(db, owner)
    if not _usable(conn):
        raise ProviderError("QuickBooks is not connected", 400)
    if conn.access_expires_at - ACCESS_SKEW_SECONDS <= time.time():
        conn = _refresh(db, owner)
    return conn.access_token, conn.realm_id


def keepalive(db: Session, owner: int = INSTALLATION) -> bool:
    """Refresh an idle connection so its refresh token never lapses.
    True if it refreshed. Never raises."""
    try:
        conn = load_connection(db, owner)
        if not _usable(conn) or time.time() - conn.refreshed_at < KEEPALIVE_AFTER_SECONDS:
            return False
        _refresh(db, owner, force=True)
        return True
    except ProviderError:
        log.warning("QuickBooks keepalive refresh failed (owner %s)", owner, exc_info=True)
        return False


def keepalive_all(db: Session) -> int:
    """`keepalive` for every club's connection; how many refreshed."""
    return sum(1 for owner in owners_with_connection(db) if keepalive(db, owner))


# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------

def _fault(resp: httpx.Response) -> tuple[str, Optional[str]]:
    """`(message, code)` from a QuickBooks Fault body, else the bare HTTP status."""
    try:
        errs = resp.json().get("Fault", {}).get("Error", [])
        if errs:
            e = errs[0]
            return f"{e.get('Message', '')} {e.get('Detail', '')}".strip(), e.get("code")
    except ValueError:
        pass
    return f"HTTP {resp.status_code}", None


def api_request(db: Session, method: str, path: str, *, owner: int = INSTALLATION,
                params: Optional[dict] = None, json_body: Optional[dict] = None) -> dict:
    """Call `/v3/company/{realm}/{path}` as the owner's connected company.

    Refreshes the token first when needed, and once more on a 401 (revoked or
    rotated elsewhere). Errors become ProviderError: 400 for a refusal, 502
    when QuickBooks or the network failed.
    """
    token, realm = get_access_token(db, owner)
    url = f"{api_base()}/v3/company/{realm}/{path.lstrip('/')}"
    # a None value drops that query parameter (the probe tries "no minorversion")
    query = {k: v for k, v in {"minorversion": MINOR_VERSION, **(params or {})}.items() if v is not None}
    resp = None
    # The body is sent ASCII-only (accents and dashes as \uXXXX escapes) with a
    # bare application/json type: QuickBooks answered "failed to parse json
    # object" to raw UTF-8 text (club names, "—"), and escapes are valid JSON
    # whatever charset it assumes.
    content = json.dumps(json_body) if json_body is not None else None
    for attempt in (1, 2):
        # rebuilt each pass: a 401 retry carries the refreshed token
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        if content is not None:
            headers["Content-Type"] = "application/json"
        try:
            with _client() as c:
                resp = c.request(method, url, params=query, content=content, headers=headers)
        except httpx.HTTPError as e:
            raise ProviderError(f"Could not reach QuickBooks: {e.__class__.__name__}", 502)
        if resp.status_code == 401 and attempt == 1:
            token = _refresh(db, owner, rejected=token).access_token
            continue
        break
    if resp.status_code >= 400:
        message, code = _fault(resp)
        # QuickBooks often omits which field it rejected, so say which call failed
        # and keep the exact request for the logs (failures only; it holds a
        # club's name/email, never a token).
        log.warning("QuickBooks %s %s -> HTTP %s code=%s: %s | request body as sent: %s",
                    method, path, resp.status_code, code, message, content)
        raise ProviderError(f"QuickBooks {method} {path}: {message}",
                            502 if resp.status_code >= 500 else 400, code)
    return resp.json()
