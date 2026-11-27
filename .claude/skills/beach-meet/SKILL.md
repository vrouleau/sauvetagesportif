---
name: beach-meet
description: How beach (ranked, not timed) meets differ from pool meets — beach numbers/bibs, MEET_TYPE flag, position entry, heat seeding, ID ranges. Use when touching beachNumber.ts, heat generation, results entry, finals qualification, best times, or anything branching on POOL vs BEACH.
---

# Beach Meets

Beach events are **ranked** (1st, 2nd, 3rd) instead of **timed**. Positions are stored as integer ms (position 1 = 1000 ms, 2 = 2000 ms).

## Meet type flag
- `bsglobal` key `MEET_TYPE` = `POOL` | `BEACH` (default `POOL` if missing).
- Set at creation via "Create Pool" / "Create Beach".
- Auto-detected on LXF import if any `swimstyleid >= 600` → `BEACH` (only when `MEET_TYPE` not already set).
- One meet type per database at a time. Mixed pool/beach swimstyle ids in a structure are refused (see `config/swimstyle-ranges.json`).

## Pool vs beach
| Aspect | Pool | Beach |
|--------|------|-------|
| Results | Time in ms | Position integer (×1000 ms) |
| Lanes | Center-out assignment | No lanes (sequential numbering) |
| Heat capacity | `session.lanemax - lanemin + 1` | `swimevent.maxentries` or `swimstyle.distance` |
| Heat seeding | By entry time (circle/pyramid/straight) | Random assignment |
| Finals qualification | Fastest prelim time | Best prelim position (lowest) |
| Timing input | `M:SS.cc` | Integer position |
| Scanner/OCR tabs | Visible | Hidden |
| Best times | Stored and displayed | Skipped |
| Inscription | Checkbox + best time + entry time | Checkbox only |

## ID ranges (no overlap)
| Entity | Pool | Beach |
|--------|------|-------|
| swimstyleid | 500-531 | 601-624 |
| eventid | 1065-1234 | 6001-6105 |
| agegroupid | 1066-1236 | 6002-6106 |

Templates: `config/template_pool.lxf`, `config/template_beach.lxf`.

## Beach numbers
Each athlete gets a unique bib in `athlete.nameprefix`: **Letter + 3 chars** (e.g. `C201`, or `C A01` for Masters — no space, 4 chars total).

- **Letter (A-Z)**: club identifier (from club code characters, fallback first unused letter).
- **Category char**: a **fixed global code** per (age bracket, sex), not per club. Bracket order (`AGE_CODE_ORDER` in `shared-ui/src/logic/ageGroupCode.ts`): 10-, 11-12, 13-14, 15-18, Open, Masters; each has a female slot then a male slot:
  `10-F=0, 10-M=1, 11-12F=2, 11-12M=3, 13-14F=4, 13-14M=5, 15-18F=6, 15-18M=7, OpenF=8, OpenM=9, MastersF=A, MastersM=B`.
  Bracket comes from the athlete's age group (`agemin`/`agemax`/`name`); sex comes from the athlete's own `gender` (not the age group's, which can be mixed for X relays).
- **Last 2 chars (01-99)**: sequence within category, alphabetical by lastname/firstname.

Source: `packages/meet-app/src/main/beachNumber.ts`
- `generateBeachNumbers(db)` — full idempotent regeneration (clears all, recomputes).
- `assignLateBeachNumber(db, athleteId)` — next available number for one athlete.

Triggers: `importLenex` (when `MEET_TYPE='BEACH'`) → `generateBeachNumbers`; `registerForEvent` (late entry) → `assignLateBeachNumber`; `generateHeats` → `assignLateBeachNumber` for any athlete missing a number.

Constraints: 26 clubs max, 12 categories, 99 athletes per category per club. Properties: deterministic, unique, idempotent, stable (late arrivals don't change existing numbers).

Display: HeatsPage, "Identifiants plage" PDF report.

Concurrency note: beach-number assignment uses `SELECT MAX+1` without locking; safe only because a single station changes event structure per meet.

## Position entry UX (HeatsPage)
- Click empty cell → pre-fills next available position, text selected for override.
- Duplicate position → **swaps** the two athletes' positions.
- Gap prevention: can't enter a position > total athletes with positions.
- Rank column hidden (position IS the result).

More: `meet-app-details.md` (original beach number notes, tests).