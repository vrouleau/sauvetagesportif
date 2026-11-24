# QuickBooks Online as an invoice provider (alternative to Stripe)

Status: phases 1-4 implemented and verified against an Intuit sandbox (provider abstraction, OAuth connection, invoice push, update-in-place with the paid/voided-invoice guard). Phase 5 (paid-status read-back on the Organizer page) was built then **removed**: accounting stays in QuickBooks, the app only reads an invoice's balance to refuse updating a settled one. Still to do: the fake-qbo integration service for the Docker tests, and checking the exempt tax code / income account with the Société's accountant. No "Société must be the organizer" guard exists: `INVOICE_PROVIDER` is the only switch, set per installation.

## Goal

Let the Société de sauvetage push each club's meet invoice into its QuickBooks Online (QBO) company, as a configurable alternative to Stripe. The invoice content (per-athlete lines, invoice number, PDF) is unchanged; only the delivery target differs.

## Decisions (confirmed)

| Topic | Decision |
|---|---|
| Tax | Tax-exempt. Every line carries an exempt `TaxCodeRef` (looked up by name on connect, admin-overridable) — Canadian QBO requires a tax code per line when taxes are enabled. |
| Items | No itemization beyond today's PDF/Stripe shape: one line per athlete (+ meet-level fee lines), breakdown in the line description, all against **one** generic service Item ("Frais d'inscription", created on first push if missing). |
| Sending | **Create only.** We never call QBO's send endpoint; the Société sends from QuickBooks. |
| Revisions | When the total changes, **update the same QBO invoice** (sparse update with `SyncToken`, lines replaced, `DocNumber` unchanged). If the invoice already has a payment (Balance != TotalAmt) refuse with a clear message — never rewrite a paid invoice. |
| Organizer | Used only when the Société is the meet organizer. One QBO connection per installation (not per organizer club like Stripe Connect). Meet name goes in the memo; no Class/Department. |
| App ownership | The Société owns the Intuit app / production keys. Code only needs `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET`. |

## Current state

- `routers/api.py::send_club_invoice` builds Stripe customer/invoice/items and sends. Connect onboarding: `/stripe/connect|status|disconnect`. `STRIPE_API_KEY` env; `clubs.stripe_account_id` per organizer club.
- Already provider-neutral: `invoices._club_line_items`, `invoice_number` (`YEAR-MEET-CLUB[-Rn]`), `record_invoice_sent`, PDF renderer, email/Interac path.
- UI: `Organizer.jsx` has a Stripe-specific button, status and connect/disconnect.

## Design

### 1. Provider abstraction (refactor first, no behaviour change)
- New `backend/app/invoice_providers/` with `stripe_provider.py` (existing code moved) and `quickbooks_provider.py`.
- Interface: `status()`, `connect_start()`, `push(club, items, invoice_no, meet_name, lang, org_club)` → `{external_id, invoice_no, total_cents}`.
- `POST /clubs/{id}/invoice` keeps its URL and dispatches on the configured provider.
- `GET /api/invoice-provider` → the env-selected provider (`none | stripe | quickbooks`) + connection status; Organizer button label follows it. The `/stripe/*` and `/quickbooks/*` routes only act when their provider is the selected one.

### 2. Configuration
- Stripe and QuickBooks are **never used together**. The provider is chosen by one env var, `INVOICE_PROVIDER=stripe|quickbooks` (no admin toggle, no `bsglobal` setting). Unset → `stripe` when `STRIPE_API_KEY` is set (today's behaviour), else none.
- Env: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT` (`sandbox`|`production`), `QBO_REDIRECT_URI` (defaults from `APP_BASE_URL`).
- `realmId`, access + refresh tokens stored in `bsglobal`, encrypted with a key derived from `SECRET_KEY` (refresh token rotates, so not an env var; never plaintext).

### 3. OAuth2 connection
- `GET /api/quickbooks/connect` → redirect to Intuit with a signed `state`.
- `GET /api/quickbooks/callback` → exempt from PIN auth (a browser redirect carries no app auth header); authenticated by the signed `state` only. Exchanges the code, stores tokens.
- `GET /api/quickbooks/status`, `POST /api/quickbooks/disconnect`.
- Refresh tokens last 100 days, extended on use; each refresh returns a **new** refresh token and invalidates the old one → persist atomically and serialize refreshes with a lock. Access tokens last ~1 h; refresh lazily before each push.
- Scheduler loop in `main.py` also refreshes periodically so the connection doesn't lapse off-season.
- Dead connection → `status` = `reconnect_required`, shown in the UI instead of failing mid-batch.

### 4. Push
Plain `requests` against `/v3/company/{realm}/…`, `minorversion` pinned (no `python-quickbooks` dependency).
- **Customer**: stored mapping `club_id → qbo_customer_id`; else query by `DisplayName` (unique in QBO; escape quotes); else create with club name + email.
- **Invoice**: `DocNumber` = our `invoice_no` (≤16 chars, QBO limit 21) → idempotent: query by `DocNumber` before create. One sales `Line` per item referencing the generic Item, exempt tax code, CAD, memo = meet name.
- **Re-push after a total change**: fetch invoice (fresh `SyncToken`), sparse update with new lines; refuse if partially/fully paid.
- **Bookkeeping**: `record_invoice_sent` as today; new migration adds `invoice_provider`, `qbo_invoice_id`, `qbo_synctoken` to `club_meet_invites`, plus the customer mapping.
- Note: our own PDF/email numbers still get `-Rn`; the QBO invoice keeps its original `DocNumber`.

### 5. UI & docs
- One set of invoice buttons on the Organizer page, never two: the Stripe button **becomes** the QuickBooks button ("Envoyer à QuickBooks" / "Push to QuickBooks") when `INVOICE_PROVIDER=quickbooks`. Label, status indicator and connect/disconnect all follow `GET /api/invoice-provider`; the page has no provider-specific code beyond that. QuickBooks connect/disconnect lives in the same spot the Stripe one does today (installation-wide connection). FR/EN i18n.
- Update team-app `CLAUDE.md` invoices section, `.env_template`, organizer guides, README, CHANGELOG.

### 6. Tests
- Unit: line→QBO mapping, `DocNumber` idempotency, token rotation + lock, query escaping, paid-invoice refusal.
- Integration: `fake-qbo` service in `docker-compose.test.yml` (like `fake-resend`).
- Manual: OAuth round trip + push against an Intuit Canadian sandbox company.

## Possible later: Société as broker for club-hosted meets

Idea (not in v1; accountant input needed — see `docs/QUICKBOOKS_COMPTABLE_FR.md`): for a meet hosted by another club, the Société collects every club's fees and remits the total to the host club afterwards.

- Accounting: likely funds held for a third party (liability), not income → invoices would post to a liability Item/account instead of the income Item, possibly with a retained commission.
- Needs per-meet tracking: a QBO Class (or similar) per meet so the amount to remit is a simple total. This reverses the "no Class" decision above for that mode only.
- Needs relaxing the "Société must be the organizer" guard, and a per-meet remittance statement (total invoiced, collected, commission, net due) generated by the app.
- Invoice wording must name the host club (memo; maybe PDF) while the Société is the issuer. Note the existing Interac path pays the organizer club's email, so broker mode is a different payee model.

## Phases
1. Extract provider interface; Stripe behind it; existing tests green.
2. OAuth connection, encrypted token storage, admin connect UI.
3. Push (customer, invoice, idempotency, migration, Organizer UI).
4. Revisions (update same invoice) + paid-invoice guard.
5. ~~Read back paid/balance status for the Organizer list~~ — dropped (accounting is done in QuickBooks, not here).

## Dev/test setup
- Intuit developer account → sandbox company (Canada if offered) → app with `com.intuit.quickbooks.accounting` scope; development keys, `QBO_ENVIRONMENT=sandbox`.
- Redirect URI must match exactly what is registered in the Intuit app. Development keys allow `http://localhost`; production requires HTTPS.
- Keys go in the untracked `.env`, never in the repo.

## Open items to verify during implementation
- Exact `minorversion` to pin; whether sparse update is the right call for replacing lines (vs full update).
- Canadian exempt tax code name in the Société's real company (differs per company).
- Intuit production-keys questionnaire (privacy-policy / EULA URLs) — owned by the Société.
