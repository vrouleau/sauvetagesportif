# DSQ Catalog — Feature Specification

## Overview

Add a `dsqitem` table to the meet-app with pre-populated disqualification codes
for lifesaving sport. Codes are stored in `config/dsq-codes.json` (same pattern
as `combined-events-config.json`) and injected into the meet database on pool/beach
meet creation. When an operator marks a swimmer DSQ in HeatsPage, they select a
reason from the catalog. The reason is stored in `swimresult.dsqitemid` and
automatically pushed to spectators via the live results feature.

## Architecture Decision

**Pattern: JSON config file in `config/` (like combined-events-config.json)**

- `config/dsq-codes.json` — single source of truth, versioned in git
- Contains separate `"pool"` and `"beach"` arrays (codes differ by discipline)
- Injected into `dsqitem` table on meet creation (same as swimstyles from templates)
- Both apps can read it:
  - meet-app: copies to userData on first launch
  - team-app: mounted via Docker volume (`../../config:/app/templates:ro`)
- Editable at runtime without rebuilding
- Independent from SMB files — works for fresh deployments

**Why not embed in LXF templates:**
- DSQ codes are sport-level constants, not meet-specific
- Lenex has no standard `<DSQITEMS>` element
- Pool and beach have different codes — separate from the template structure

## Data Model

```sql
CREATE TABLE IF NOT EXISTS dsqitem (
  dsqitemid INTEGER PRIMARY KEY,
  code      TEXT,        -- Short code number (e.g., "1", "10", "B3")
  lenexcode TEXT,        -- Lenex standard code (same as code for now)
  name      TEXT,        -- Human-readable description (FR)
  name_en   TEXT,        -- English description (future)
  options   TEXT,        -- Reserved
  sortcode  INTEGER      -- Display order
);
```

**ID ranges (no overlap):**
- Pool DSQ codes: `dsqitemid` 4001–4099
- Beach DSQ codes: `dsqitemid` 4101–4199

## Config File Format (`config/dsq-codes.json`)

```json
{
  "pool": [
    {
      "code": "1",
      "name_fr": "Ne complète pas l'épreuve conformément à la description...",
      "name_en": "Does not complete the event according to the general description..."
    },
    ...
  ],
  "beach": [
    {
      "code": "B1",
      "name_fr": "...",
      "name_en": "..."
    },
    ...
  ]
}
```

## Current State

### Pool codes (52 codes) — DONE
Extracted from the Championnats canadiens 2026 SMB file (entered by organizer).
Source: Lifesaving Society Canada pool competition rules.
Stored in `config/dsq-codes.json` → `"pool"` array.

Codes cover:
- General infractions (1–10): incomplete event, doping, late arrival, false start, etc.
- Obstacle violations (11–12): passing over, not surfacing
- Wall/turn violations (13–14): not touching wall
- Mannequin carry (15–25): incorrect position, technique, releasing early
- Rescue tube / bouée tube (26–34): incorrect attachment, pushing instead of towing
- Relay exchanges (35–41): third athlete help, repeating steps, early departure
- Line throw (42–52): leaving zone, incorrect technique, climbing rope

### Beach codes (12 codes) — DONE
Extracted from the ILS Competition Rule Book 2025 Edition, Section 4, §25
"Disqualification Codes for Beach and Ocean Events" (p. S4.63–64) —
`docs/ILS-2025-Competition-Rulebook-Final-081025.pdf` (also confirmed
identical in the May 2026 revised edition).
Stored in `config/dsq-codes.json` → `"beach"` array, codes `"1"`–`"12"`
(same plain-numeric scheme as the pool array).
See `docs/ILS_COMPETITION_REFERENCE.md` §4.6 for the full code table.

Codes cover:
- General infractions (1–10): near-identical restatement of the pool
  section's general codes — incomplete event, unfair competition, late/absent
  at start, venue damage, officials abuse, false start, starter non-compliance,
  disturbing others, wrong start position
- Beach-specific (11–12): baton/flag pick-up violation (Beach Flags only),
  failure to complete the event/course

**Fix history (2026-08-08):** the beach array previously held 18 invented
alphanumeric codes (`DQ1`, `DQ2`, `STR`, `STI`, `OBS`, `CRS`, `BAT`, `CHG`,
`LNV`, `ZNV`, `EQP`, `CRF`, `VIC`, `VPK`, `TEM`, `TRN`, `FIN`, `DNF`) that had
no basis in the ILS rule book — wording, numbering, and even the alphanumeric
code scheme itself didn't trace back to any source in this repo. Notably `BAT`
was tagged `RELAY` ("baton not retrieved at finish") but the ILS's actual
baton/flag rule (code 11) applies only to Beach Flags, an *individual* event —
beach relay changeovers use tagging, not batons (CRB §2.7). Replaced with the
real 12-code ILS list; both `config/dsq-codes.json` and `config/dsq-codes.yaml`
were updated in lockstep and re-verified to parse identically.

Code 2's full ILS wording (a 9-bullet list of "competing unfairly" examples,
~750–820 chars) was condensed to fit the real Splash `dsqitem.name` /
`name_en` column width — `VARCHAR(250)` on Postgres, confirmed against
`tests/fixtures/splash-schema.csv` — the same condensation approach already
used for the equivalent pool code 2 entry ("see rule book" instead of listing
every example).

**Open question:** this spec originally planned to source beach codes from
the Lifesaving Society Canada rule book (mirroring how the 52-code pool list
extends beyond the ILS's own shorter pool list) rather than the ILS CRB
directly. No Canadian beach source document is present in this repo to verify
against, so the ILS's 12 codes are what's implemented today. If a Canadian
beach SMB/rulebook source becomes available, the array may need Canada-specific
codes layered on top, the same way pool's list already does.

## Implementation Tasks

All tasks below are implemented except Task 6, which remains explicitly
optional (see its own note). This checklist was previously stale — it still
had every box unchecked despite Tasks 1, 3, 4, and 5 already being live in
`packages/meet-app/src/main/index.ts`, `smb.ts`, `connectionManager.ts`, and
`HeatsPage.tsx`; corrected 2026-08-08 alongside the beach-codes fix above.

### Task 1: Create dsqitem table in meet-app — DONE
- [x] Add `CREATE TABLE IF NOT EXISTS dsqitem` to db.ts schema initialization (`schema.ts`, `connectionManager.ts`)
- [x] On meet creation ("Create Pool" / "Create Beach"), seed from `config/dsq-codes.json` (`seedDsqCodes()` in `index.ts`)
- [x] Use ID range 4001–4099 for pool, 4101–4199 for beach (`index.ts`'s `seedDsqCodes`)
- [x] Include in SMB export/import (`DSQITEM` in `SMB_TABLES` array, `smb.ts`)

### Task 2: Populate beach codes — DONE
- [x] Review the ILS Competition Rule Book beach section (§25 — see "Beach codes" above; the
      Lifesaving Society Canada source originally planned for this task was never located in-repo)
- [x] Add beach DSQ codes to `config/dsq-codes.json` → `"beach"` array (12 codes, matches ILS CRB)
- [x] Add English translations for both pool and beach codes (`name_en` field)

### Task 3: HeatsPage DSQ dialog wiring — DONE
- [x] Load dsqitem catalog on HeatsPage mount (IPC: `db:get-dsq-items`)
- [x] Replace free-text dsqCode input with searchable dropdown from catalog
- [x] On DSQ confirmation, write `dsqitemid` to `swimresult`
- [x] Display selected DSQ code + short description in the heat lane row
- [x] Live push already picks up the reason automatically (no change needed)

### Task 4: IPC + preload — DONE
- [x] Add IPC channel `db:get-dsq-items` — returns all rows from dsqitem table
- [x] Add to preload API: `window.api.db.getDsqItems()`
- [x] Update `saveResult` to accept optional `dsqitemid` parameter

### Task 5: SMB round-trip — DONE
- [x] Add DSQITEM to `SMB_TABLES` array in smb.ts for export
- [x] Import DSQITEM rows on SMB restore (already listed in geologix.ini)
- [x] On SMB restore: SMB's own DSQITEM rows are restored as-is (standard `SMB_TABLES` row
      insert), so a real Splash `.smb` file's codes are preserved rather than overwritten by the
      JSON config — the JSON only seeds a table that comes up empty (new meet, or LXF import,
      neither of which carries DSQITEM data)

### Task 6: LXF export (results) — not done, optional
- [ ] Include `dsqitemid` + code in results LXF export (for reference)
- [ ] Not critical for import (dsqitem table is seeded from config, not from LXF) — Lenex has no
      standard `<DSQITEMS>` element (see "Why not embed in LXF templates" above), so this is a
      nice-to-have annotation on `<RESULT>`, not a round-trip requirement
