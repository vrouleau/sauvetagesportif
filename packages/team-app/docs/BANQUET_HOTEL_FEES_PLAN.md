# Banquet Ticket & Hotel Room Fees — Analysis & Plan

Status: design confirmed — ready to implement
Branch: `feature/banquet-hotel-fees`

## 1. Goal

Allow an organizer to charge teams for two new, **coach-selected** extras per meet:

1. **Banquet tickets** — a flat **per-ticket** price; the coach enters how many tickets the
   team needs. Billed as `ticket_price × banquet_tickets`.
2. **Hotel (athlete-nights)** — a flat **per-athlete-night** price; the coach enters a single
   total number of **athlete-nights** for the team (e.g. 4 athletes × 3 nights = 12). Billed as
   `nightly_rate × athlete_nights`. The coach does the multiplication and enters the one total;
   the system does not break it down per athlete.

Confirmed decisions (from requirements discussion):

- Both fees are configured per meet in the **fees section**, alongside the existing
  per-club / per-athlete / per-relay fees.
- If a fee is **zero (or unset)**, the corresponding quantity input is **hidden** on the coach's
  registration page. The input appears only when its fee is non-zero.
- Charges flow into the existing **PDF invoice** and the **Stripe invoice**.
- Quantities are **locked at the closure date**, same as registrations. After closure, any
  adjustments are made directly in Stripe by the organizer.
- **No organizer notification email** — the invoice is the sole communication channel.
- **Portal-only.** These charges are not written to LENEX and are not visible to the Electron
  meet-app; they live solely in the team portal's billing.

This document records the Stripe-vs-portal decision (section 2) and the confirmed design
(sections 3–8).

## 2. The two approaches — recommendation

### Approach 1 — handle it in the team portal (recommended)

Capture the quantities in the portal, store them per club+meet, and append them as line items
to the existing invoice pipeline. Both the PDF and the Stripe invoice are built from one
function (`_club_line_items` in `backend/app/invoices.py`), so adding the line items there
makes them appear in **both** outputs automatically, with no manual Stripe work.

### Approach 2 — email the organizer, add the charge manually in Stripe

Stripe has no "intake form → auto line item" feature. The only "easy" Stripe-native option is
Payment Links with adjustable quantities, but those are standalone checkout pages that are
**not** tied to our per-club invoices, our connected-account flow, or our PDF fallback. So this
approach always means the organizer manually editing a draft invoice in the Stripe dashboard
for every team — error-prone, unauditable, and it bypasses the PDF path entirely (teams without
Stripe get nothing). It also doesn't exist natively as a clean workflow; we'd still have to
build the email + the quantity capture somewhere.

### Verdict

Approach 1. We already own the whole billing pipeline, the data model extends cleanly, and the
quantities land in both the PDF and Stripe invoice with a single insertion point. Approach 2's
only advantage (no code) is false — it still needs quantity capture and an email, and it adds
recurring manual work plus a path that silently drops the charge for PDF-only teams.

We can still **optionally** send the organizer a notification email summarizing each team's
banquet/room counts (reusing the existing Resend integration), but as a convenience on top of
Approach 1 — not as the billing mechanism.

## 3. How the current system works (verified)

Monorepo has three packages; this feature lives entirely in **`packages/team-app`** (the
FastAPI + React web portal), with a small shared fee-config addition in `packages/shared-ui`.

### Fees today
- **Per-event fee**: `SwimEvent.fee` (dollars, nullable). Authored in
  `shared-ui/src/pages/EventsPage.tsx` (~L1960) as a numeric input on each event.
- **Meet-level fees**: Splash-compatible `MEETVALUES` keys (`FEECLUB`, `FEEPERSON`, `FEERELAY`,
  `FEELATEINDIVIDUAL`). Authored in the EventsPage "Frais d'inscription" panel via `FeeFieldRow`
  (`EventsPage.tsx` ~L2113, ~L2417). Saved through `MeetConfigContext.saveField(key, value, 'F')`
  → `api.setMeetConfig({ KEY: { type:'F', value } })`.
- Stored in the `bsglobal` key-value store under the `MEETVALUES` blob (format `KEY=TYPE;VALUE`,
  e.g. `FEEPERSON=F;5.00`). Read/written by `backend/app/meet_config.py`
  (`_get_meet_config`, `_update_meetvalue`, `_set_meet_config`).
- Dollar↔cent conversion: `fee_dollars_to_cents` / `fee_cents_to_dollars`
  (`backend/app/models.py` ~L435).

### Registration today
- A registration = one `SwimResult` row (`backend/app/models.py` ~L219), keyed by
  `(meetsid, athleteid, swimeventid, age_code)`. This is **per athlete per event** — the wrong
  grain for banquet/room counts, which are **per club per meet**.
- Endpoints: `POST /api/registrations`, `DELETE /api/registrations/{id}`
  (`backend/app/routers/api.py` ~L2348), gated by `X-Club-Pin` and `_check_closure`.
- Coach-facing UI is the web portal: `IndividualEntryPage` / `RelayEntryPage` (shared-ui),
  wired through `frontend/src/registrationApi.js` → `/api/*`.

### Billing today
- Single source of truth: **`_club_line_items(db, club, meet_fees, meetsid)`**
  (`backend/app/invoices.py` ~L118). Returns `list[dict]` of
  `{event_number, event_name, description, qty, unit_cents}`.
- Consumed by **both** the PDF (`generate_invoice_pdf`, reportlab, ~L427) and Stripe
  (`_create_draft_for_club` ~L344 and `send_club_invoice` in `routers/api.py` ~L3149).
- Meet-level fees are appended as lines with computed quantities (`qty_for` map).

### Stripe today
- Stripe Connect (standard accounts): `POST /api/stripe/connect|status|disconnect`
  (`routers/api.py` ~L3030). Connected account id on `TeamClub.stripe_account_id`.
- Connected-account invoice send: `POST /api/clubs/{club_id}/invoice` → `send_club_invoice`
  builds items via `_club_line_items`, creates Customer + Invoice + one InvoiceItem per line,
  finalizes and sends.
- **No webhook handler exists.** Payment status is never read back. Not needed for this feature
  (we only add line items; we don't need to track paid/unpaid differently from today).

### Email today
- **Resend** HTTP API via `httpx` (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`). Only sender is
  `POST /api/clubs/{club_id}/send-pin` (`routers/api.py` ~L1137). Reusable pattern for an
  optional organizer summary email.

### Per-club-per-meet precedent
- `ClubMeetInvite` (`models_team.py` ~L250) already models per-club-per-meet counters. The new
  banquet/room quantities follow the same `(clubsid, meetsid)` composite-key pattern.

## 4. Data model changes

### 4a. Fee configuration (two new meet-level fees)

Reuse the existing `MEETVALUES` mechanism — no schema change, Splash-compatible, and it rides
the existing `FeeFieldRow` + `_meet_fees` plumbing. New keys:

| Key            | Meaning                        | Unit          | Format      |
|----------------|--------------------------------|---------------|-------------|
| `FEEBANQUET`   | price per banquet ticket       | per ticket    | `F;dollars` |
| `FEEHOTELNIGHT`| price per athlete-night        | per ath.-night| `F;dollars` |

Extend `_meet_fees()`'s `key_map` in `invoices.py` to map these to logical types `BANQUET` and
`HOTELNIGHT`, and add labels to `MEET_FEE_LABELS`. Note: `_meet_fees` drops zero/empty values, so
"fee is zero → hidden" falls out naturally (the key simply won't be present).

### 4b. Coach-entered quantities (new table)

Banquet-ticket and athlete-night counts are per club per meet, so `SwimResult` (per athlete per
event) is the wrong grain. Both are a single integer total per team, so add a new table:

```python
# models_team.py
class ClubMeetExtras(Base):
    __tablename__ = "club_meet_extras"
    clubsid = Column(Integer, ForeignKey("clubs.clubsid", ondelete="CASCADE"), primary_key=True)
    meetsid = Column(Integer, ForeignKey("meets.meetsid", ondelete="CASCADE"), primary_key=True)
    banquet_tickets = Column(Integer, default=0)   # qty of banquet tickets
    hotel_nights = Column(Integer, default=0)       # total athlete-nights (coach-computed)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
```

This mirrors `ClubMeetInvite`. `hotel_nights` holds the coach-entered athlete-night total (e.g.
12 for 4 athletes × 3 nights); the breakdown is not stored since billing only needs the total.
A generic `(clubsid, meetsid, item_type, qty)` table was considered but rejected: only two fixed
item types exist, and two integer columns keep the line-item builder and the UI dead simple. If
variant pricing (adult/child banquet, etc.) appears later, migrate then.

Table creation follows the project's existing pattern (SQLAlchemy `create_all` / the startup
schema path used for the other team tables; see `backend/app/database.py` and
`db/schema.sql`). Add the DDL to `db/schema.sql` as well for the Postgres path.

## 5. Backend changes

### 5a. Config read (`invoices.py::_meet_fees`)
Add to `key_map`:
```python
"FEEBANQUET": "BANQUET",
"FEEHOTELNIGHT": "HOTELNIGHT",
```
and to `MEET_FEE_LABELS`:
```python
"BANQUET": "Billets de banquet",
"HOTELNIGHT": "Nuitées (hôtel)",
```

### 5b. Quantity endpoints (`routers/api.py`)
- `GET /api/clubs/{club_id}/extras` — returns `{banquet_tickets, hotel_nights}` for the active
  meet (defaults to zeros). Also return the two configured fees (`FEEBANQUET`, `FEEHOTELNIGHT`
  in cents) so the frontend knows which inputs to show.
- `PUT /api/clubs/{club_id}/extras` — upsert the quantities. Reuse the existing `X-Club-Pin`
  auth + `_caller_club_id` ownership check (a coach may only edit their own club) and
  `_check_closure` gating, exactly like `create_registration`. Because closure gating applies,
  the quantities are **locked after the closure date** — post-closure adjustments happen in
  Stripe (confirmed decision). Reject negative quantities.
- A coach-facing convenience alias (no `club_id` in path, derived from the PIN) can wrap the
  same handler for the portal, matching how registrations resolve the caller's club.

### 5c. Line-item builder (`invoices.py::_club_line_items`)
After the existing meet-level fee loop, append banquet/hotel lines from `ClubMeetExtras`:
```python
extras = db.get(ClubMeetExtras, (club.clubsid, meet_id))
for ftype, qty in (("BANQUET", extras.banquet_tickets if extras else 0),
                   ("HOTELNIGHT", extras.hotel_nights if extras else 0)):
    cents = meet_fees.get(ftype, 0)
    if cents and qty and qty > 0:
        meet_items.append({
            "event_number": None,
            "event_name": MEET_FEE_LABELS[ftype],   # e.g. "Nuitées (hôtel)"
            "description": "",
            "qty": qty,                              # tickets, or athlete-nights
            "unit_cents": cents,
        })
```
The hotel line reads `qty = athlete-nights`, `unit_cents = nightly rate`, so the invoice shows
`athlete-nights × nightly rate` — matching the coach-entered total exactly.
Because both the PDF and Stripe paths iterate `_club_line_items`, this is the **only** billing
change needed. `invoice-total` (`routers/api.py` ~L3137) and the Organizer club table's
`total_fees_cents` also pick it up for free.

### 5d. Organizer notification email — NOT included
Decided against (confirmed). The invoice is the sole communication channel. If headcount
visibility is wanted later, the organizer can read it from the per-club totals or a future
summary view, or we add the Resend email then.

## 6. Frontend changes

### 6a. Fee config UI (`shared-ui/src/pages/EventsPage.tsx`)
In the "Frais d'inscription" panel (~L2417), add two more `FeeFieldRow`s:
```tsx
<FeeFieldRow label="Billet de banquet ($)" fieldKey="FEEBANQUET" />
<FeeFieldRow label="Nuitée / athlète ($)" fieldKey="FEEHOTELNIGHT" />
```
No other change — `FeeFieldRow` already saves as type `F` via `MeetConfigContext`.

### 6b. Coach quantity inputs (team-app registration flow)
On the coach's entry page (team-app `frontend`), fetch `GET /clubs/{id}/extras`. Render:
- a **banquet tickets** number input **only if** `FEEBANQUET > 0`;
- an **athlete-nights** number input **only if** `FEEHOTELNIGHT > 0`, with helper text clarifying
  it is the team total (athletes × nights), not a per-athlete value.

If both fees are zero, render nothing (section hidden entirely). Persist on blur via
`PUT /clubs/{id}/extras`, following the debounced-save style already used for entry times.
Show the running line-item cost next to each input (`qty × unit`) for transparency.

### 6c. Organizer visibility (`team-app frontend/src/pages/Organizer.jsx`)
The `FeeSummary` component and the per-club `total_fees_cents` already render whatever
`_club_line_items` produces, so banquet/room totals appear automatically. Optionally add the two
new fees to the `FEE_TYPE_LABEL` map (~L517) and the `FeeSummary` meet-level list for clarity.

## 7. i18n
Add French/English strings for the new labels in the shared-ui translation files and the
team-app frontend translations (banquet ticket, hotel room, and the Organizer summary rows).
The codebase is bilingual (fr default); keep both.

## 8. Testing & verification
- Backend unit test: `_club_line_items` with non-zero `FEEBANQUET`/`FEEHOTELROOM` and non-zero
  quantities produces the expected extra lines with correct `qty × unit_cents`; zero fee or zero
  qty produces none.
- Round-trip test: `invoice-total`, the reportlab PDF, and the Stripe draft all include the new
  lines (Stripe mocked / dry-run).
- Frontend: inputs hidden when fee is zero, shown when non-zero; closure-date gating blocks edits
  after deadline.
- Migration: `club_meet_extras` is created on a fresh DB and on an existing DB without data loss.

## 9. Resolved decisions
1. **Pricing is flat per unit.** Banquet = flat per ticket. Hotel = flat per athlete-night; the
   coach enters a single athlete-nights total (athletes × nights) and is billed `rate × total`.
   No variant pricing. Two-integer `ClubMeetExtras` model.
2. **Quantities lock at the closure date**, like registrations. Post-closure adjustments are
   made in Stripe by the organizer.
3. **No organizer notification email.** Invoice is the sole channel.
4. **Portal-only.** Not written to LENEX; not visible to the Electron meet-app.
