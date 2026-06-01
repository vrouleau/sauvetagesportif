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

### Beach codes — TODO
Source: Lifesaving Society Canada beach competition rules
URL: https://www.lifesavingsociety.com/lifesaving-sport/rule-books.aspx

Beach disciplines include:
- Beach flags (drapeaux de plage)
- Beach sprint
- Beach relay
- Surf race / board race / ski race (if applicable to your meets)

Beach-specific infractions to document:
- Head-up start violations (beach flags)
- Lane violations (beach sprint)
- Baton exchange violations (beach relay)
- Interference with other competitors
- Equipment violations

**Action needed:** Review the Lifesaving Society rule book (beach section) and
populate the `"beach"` array in `config/dsq-codes.json`.

## Implementation Tasks

### Task 1: Create dsqitem table in meet-app
- [ ] Add `CREATE TABLE IF NOT EXISTS dsqitem` to db.ts schema initialization
- [ ] On meet creation ("Create Pool" / "Create Beach"), seed from `config/dsq-codes.json`
- [ ] Use ID range 4001–4099 for pool, 4101–4199 for beach
- [ ] Include in SMB export/import (add DSQITEM to SMB_TABLES array in smb.ts)

### Task 2: Populate beach codes
- [ ] Review Lifesaving Society beach competition rules
- [ ] Add beach DSQ codes to `config/dsq-codes.json` → `"beach"` array
- [ ] Add English translations for both pool and beach codes (`name_en` field)

### Task 3: HeatsPage DSQ dialog wiring
- [ ] Load dsqitem catalog on HeatsPage mount (IPC: `db:get-dsq-items`)
- [ ] Replace free-text dsqCode input with searchable dropdown from catalog
- [ ] On DSQ confirmation, write `dsqitemid` to `swimresult`
- [ ] Display selected DSQ code + short description in the heat lane row
- [ ] Live push already picks up the reason automatically (no change needed)

### Task 4: IPC + preload
- [ ] Add IPC channel `db:get-dsq-items` — returns all rows from dsqitem table
- [ ] Add to preload API: `window.api.db.getDsqItems()`
- [ ] Update `saveResult` to accept optional `dsqitemid` parameter

### Task 5: SMB round-trip
- [ ] Add DSQITEM to `SMB_TABLES` array in smb.ts for export
- [ ] Import DSQITEM rows on SMB restore (already listed in geologix.ini)
- [ ] On SMB restore: if SMB has DSQITEM rows, use those (override JSON defaults)

### Task 6: LXF export (results)
- [ ] Include `dsqitemid` + code in results LXF export (for reference)
- [ ] Not critical for import (dsqitem table is seeded from config, not from LXF)
