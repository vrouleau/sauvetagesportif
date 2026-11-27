---
name: lxf-roundtrip
description: How LENEX (.lxf) data flows between meet-app and team-app — meet setup, entries, results, meet-level fields (.meetvalues), swimstyle checks, templates, meet reset after results import. Use when touching LXF import/export code in either app, lenex-meet-fields.json, swimstyle-ranges.json, or the meet lifecycle.
---

# LXF round-trip (meet-app ↔ team-app)

| Step | Who exports | Who imports | Content |
|---|---|---|---|
| Meet setup | meet-app (File → Exporter structure) | team-app (Organizer → upload) | Sessions, events, agegroups — no athletes |
| Entries | team-app (Organizer → Télécharger LXF) | meet-app (File → Importer LENEX) | Clubs, athletes, registrations, entry times |
| Results | meet-app (File → Exporter résultats) | team-app (Organizer → Importer résultats) | Athletes + final times → archived as historical meet |

The meet can be set up in either app (team-app → create meet → entries → export → meet-app → heats → run). Organizer import of results also closes the meet cycle: resets current meet (admin and organizer paths), regenerates club PINs, clears organizer role. Empty meet state is supported — self-invite shows "no meet planned". See `docs/MEET_RESET_BEHAVIOR.md`, `docs/LENEX_EXPORT_MATRIX.md`, and `packages/team-app/CLAUDE.md`.

## Meet-level fields: one shared map
`config/lenex-meet-fields.json` is the single source of truth for where each meet editor field (MEETVALUES key) travels. **Add a field there, not in code.**
- Fields LENEX has a place for use Splash's own place/format (MEET attrs, `POOL`, `FACILITY`, `QUALIFY`, `CONTACT`, `FEES/FEE` in cents). Verified against a real Splash export: `packages/team-app/tests/fixtures/meet_template.lxf`.
- `dotfileKeys` (seeding, combine age groups, min per heat, fast heats, seed-last, lane order…) travel in the hidden `.meetvalues` zip entry (`{KEY: "TYPE;value"}`; Splash ignores dotfiles).
- AGEDATE is NOT in the map — each app keeps its own AGEDATE logic (see `config/age-group-rules.json`).
- **team-app**: `backend/app/lenex_meet_fields.py` — `export._add_meet_element` (both exports), `meet_parser.parse_meet_lxf` → `ParsedMeet.meetvalues`, applied by `_replace_current_meet_structure` (upload) and `_init_meet_from_template`. Docker: `COPY config/lenex-meet-fields.json .`
- **meet-app**: `src/main/lenexMeetFields.ts` — `importLenex` (`applyMeetLevelFields`: structure import takes all, entries import fills only empty fields), `exportMeetLenex` (+ `.meetvalues`), `exportLenexResults`. Packaged via `extraResources`.
- Tests: `packages/team-app/tests/unit/test_meet_course_roundtrip.py`, `packages/meet-app/tests/lenex.test.ts` ("meet-level fields").

## Swimstyle id checks (`config/swimstyle-ranges.json`)
Widen a range there when a template gains a style, else every import warns.
- **team-app** (`swimstyle_check.py`): ids outside both series (`out_of_range`) or not in catalog (`not_in_catalog`) → 409 `new_swimstyles` on all LXF uploads; `?force=true` overrides. Mixed pool+beach → 400 `mixed_swimstyles`, not overridable.
- **meet-app** (`swimstyleRanges.ts`, `checkLenexSwimstyles` in `lenex.ts`): the `file:import-lenex` handler pre-scans **before wiping the DB** — mixed → refused; out-of-range → "Import anyway?".
- Fixture `tests/fixtures/meet_template.lxf` has relays at 538-540 → always uploaded with `?force=true`.

## Templates
`config/template_pool.lxf` (500-531), `config/template_beach.lxf` (601-624) are the source of truth for event structure; loaded at meet creation and reloaded (empty) after reset/results import. meet-app: File → Nouveau meet. team-app: Admin → New Meet, env `MEET_TEMPLATE_POOL` / `MEET_TEMPLATE_BEACH`.

## Relay & HC in LXF
Relay teams travel as `RELAY`/`RELAYPOSITION` with `ENTRY@entrytime`; HC = `ENTRY status="EXH"`. Results export writes relay results for history. See the `relay-entry` skill.

## Conventions
- LENEX `GENDER` enum is `ALL|M|F|MIXED`. Old exports wrote `X` for Mixed; still accepted on import.
- LXF files keep the French swimstyle name (Splash expects it).
- Meet type auto-detected on import (see `beach-meet` skill).
- Synthetic round-trip testing: see the `/roundtrip-test` skill.

More detail: `meet-app-details.md` (importLenex/export specifics), `team-app-lifecycle.md` (meet lifecycle, reset, meet_type, swimstyle catalog, MEETVALUES/course helpers).