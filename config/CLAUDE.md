# Config — Shared Configuration Files

## Age Group Rules (`age-group-rules.json`)

Single source of truth for the season-reference dates used to determine an athlete's age-group bracket, per *Règlements des compétitions de sauvetage sportif au Québec* (Édition septembre 2025), §1.1-1.3 — full text in `docs/Reglements-Competitions-Sauvetage-Sportif-Quebec-Edition-Septembre-2025.pdf`. Holds only the two constants the rule actually varies by — not a rules engine, the branching logic itself lives in each app's own reader:
- `seasonStartDate` — `{month, day}` for `POOL` (1er septembre) and `BEACH` (1er mai). Used for the `10-` and `11-12` brackets.
- `yearEndDate` — `{month, day}`, currently Dec 31 (ILS rule). Used for `13-14`, `15-18`, `Open` (Senior), `Masters`.
- `seasonStartBrackets` — which bracket codes use the season-start date instead of year-end.

Both reference dates are anchored to a single "season year" (fixed once at meet setup, not derived from wall-clock time — see each reader below) so an athlete's bracket stays locked for the whole season even if a birthday would otherwise bump them mid-season. The `10-`/`11-12` brackets get one extra rule baked into both readers' logic: an athlete who is 11 or 12 at season start but will turn 13 by year end is bumped straight to `13-14` for the season instead of staying in `11-12` — the season-start date is *not* an unconditional floor, only `10-` gets that (see the worked examples in each test suite, taken from the rulebook itself).

Independently implemented in both apps (can't share code across the TS/Python boundary) — keep them in sync if this file's shape changes:
- **meet-app**: `src/main/ageGroupRules.ts` — `resolveMatchingAge()`, used by the `db:register` IPC handler (`index.ts`), `addLateEntry` (`db.ts`), and the `db:get-matching-age` IPC channel (called from the renderer's `registrationApiElectron.ts` to drive the registration panel's suggested category) — all three used to compute age from wall-clock `new Date()` instead of a season reference date. Season year comes from `bsglobal.AGEDATE` (`getSeasonYear()`).
- **team-app**: `backend/app/age_group_rules.py` — `resolve_matching_age()`, used by `suggested_age_code` computation in `routers/api.py`. Season year comes from the `age_base_date` config key, which is now kept in sync with the "Date for age calculation" UI field (`set_meet_config`'s `AGEDATE` case, `routers/api.py`) — before this sync existed, that field only ever touched the `MEETVALUES` blob and silently had no effect on the actual suggestion, the same disconnect that once left Splash's own `AGEDATE` unset and broke its Results tab age-group labels at a real meet.
- Tests: `packages/meet-app/tests/age-group-rules.test.ts` and `packages/team-app/tests/unit/test_age_group_rules.py` — same worked examples in both, taken directly from the rulebook (a 12-year-old who turns 13 before Dec 31 gets bumped to 13-14; one who doesn't stays in 11-12; a 10-and-under who turns 11 by Dec 31 stays 10-and-under all season). `packages/team-app/tests/unit/test_meet_config_sync.py` covers the `AGEDATE` → `age_base_date` sync specifically.

## Combined Events (`combined-events-config.json`)

Single source of truth for cumulative point standings, consumed by meet-app (TypeScript `src/main/combinedEvents.ts`). Defines 10 categories for Canadian lifesaving with points scales and age/gender matching rules. **Editable at runtime without rebuild.** team-app had a Python port (`combined_events.py`) at one point; it was replaced (2026-06-16) and the replacement removed as dead code (2026-08-03) — see `packages/team-app/CLAUDE.md`'s "Combined Events" section. team-app has no implementation of this today.

### Event filtering (what gets included)
- Individual events only (`relaycount = 1`)
- Pool events only (`distance >= 25` — excludes throwing events like "Lancer de précision")
- No admin/internal events (`internalevent != 'T'`)
- No finals linked to prelims (`preveventid < 1` — excludes separate final rounds)
- Must have an event number (`eventnumber IS NOT NULL`)

### Category matching
An event matches a category when its age group has:
- Same `agemin` as the category
- Same `agemax` (with -1 meaning no upper limit)
- Same gender (or event gender=0 for a combined/open category, e.g. "10 and under - girls and boys" — an individual event's gender=0 means ALL/unrestricted; gender=3, Mixed, is also matched here for backward compatibility with pre-ALL meets, since Mixed was the only non-M/F choice available for an individual event before ALL existed as an option)

## DSQ Codes (`dsq-codes.json` → `dsq.xml`)

`dsq-codes.json` is the single source of truth for disqualification codes, organized by meet type (`pool`, `beach`) plus a `serc` list. Each entry has a code, French/English names, and applicable options (`INDIVIDUAL`, `RELAY`).

`dsq.xml` is the generated Splash Meet Manager import file (Windows-1252, `<DSQITEMS>` format), built from the `pool`/`beach` lists only. Regenerate it with:

```bash
python scripts/generate_dsq_xml.py [--lang fr|en] [--type pool|beach] [--output FILE]
```

The `serc` list (4 codes, Règlements Québec Annexe 3 — §5.14.5) is a separate, fixed set never fed into `dsq.xml`: SERC is a team-app-only judged event with no Splash/meet-app path at all. It's read at runtime by team-app's `backend/app/routers/serc.py` (`GET /api/serc/dsq-codes`) the same way `age-group-rules.json` is read by `age_group_rules.py` — see that file's `_config_path()`-style loader — and backs `PUT /api/serc/disqualification`, which lets the organizer/chief-judge flag a team DQ'd for a given SERC draw. A DQ'd (draw, team) contributes 0 to that draw's total and is excluded from that draw's ranking (rank omitted, not just last), per §2.4's "no rank or time" rule; the team's overall total simply doesn't include that draw's contribution.

## Swim style names (`swimstyle-names.json`)

English/French name per swimstyleid (pool 500-531, beach 601-624; ids with no entry fall back to the LENEX name). `name_fr` mirrors `SWIMSTYLE@name` in the templates; LENEX files keep the French name (Splash expects it). Both apps fill the event `nameEn` from it and the shared UI shows it via `eventDisplayName(event, lang)` (`shared-ui/src/logic/eventName.ts`). English names are drafts from `docs/ILS_COMPETITION_REFERENCE.md`, to be reviewed.
- **meet-app**: `src/main/swimstyleNames.ts` (packaged via `extraResources`)
- **team-app**: `backend/app/swimstyle_names.py` (Docker: `COPY config/swimstyle-names.json .`)

## Meet editor fields in LXF (`lenex-meet-fields.json`)

Single source of truth for where each meet editor field (MEETVALUES key) travels in LENEX, so a meet set up in either app arrives whole in the other (team-app → create meet → entries → export → meet-app → heats). Every field LENEX has a place for uses Splash's own place and format (checked against a real Splash export, `packages/team-app/tests/fixtures/meet_template.lxf`): MEET attributes (`name.en`, `city`, `state`, `nation`, `course`, `deadline`, `reservecount`, `startmethod`, `timing="AUTOMATIC"`, `touchpad="ONESIDE"`, `masters`, `organizer(.url)`, `hostclub`, `result.url`, `number`, `type`), `POOL` (lanes, name), `FACILITY` (name, street, city, state, nation), `QUALIFY` (from/until), `CONTACT`, `FEES/FEE` (cents). `dotfileKeys` are the Meet Manager settings LENEX has no place for (seeding, combine age groups, min per heat, fast heats, seed-last options, lane order…): they travel in the hidden `.meetvalues` zip entry (`{KEY: "TYPE;value"}`, Splash ignores dotfiles). AGEDATE is not in the map — both apps keep their own `<AGEDATE>` logic.

Read by both apps for every LXF they write and read — add a field here, not in code:
- **team-app**: `backend/app/lenex_meet_fields.py` — `export._add_meet_element` (both exports), `meet_parser.parse_meet_lxf` → `ParsedMeet.meetvalues`, applied by `_replace_current_meet_structure` (upload) and `_init_meet_from_template`. Docker: `COPY config/lenex-meet-fields.json .`
- **meet-app**: `src/main/lenexMeetFields.ts` — `importLenex` (`applyMeetLevelFields`: structure import takes all, entries import fills only empty fields), `exportMeetLenex` (+ `.meetvalues`), `exportLenexResults`. Packaged via `extraResources`.
- Tests: `packages/team-app/tests/unit/test_meet_course_roundtrip.py` (`TestExportMeetHeader`, `TestSplashFile`), `packages/meet-app/tests/lenex.test.ts` ("meet-level fields").

## Meet templates

| File | Type | swimstyleid range |
|---|---|---|
| `template_pool.lxf` | Pool (winter) | 500-531 |
| `template_beach.lxf` | Beach (summer) | 601-624 |

## Swimstyle ID ranges (`swimstyle-ranges.json`)

The known id series above, as data (`POOL`/`BEACH` → `{min, max}`, inclusive). **Widen a range here when a template gains a new style** — otherwise every import of that template warns. LXF imports in both apps check incoming `SWIMSTYLE` ids against it:
- **team-app** (`backend/app/swimstyle_check.py`): `find_new_swimstyles` flags ids outside both series (`reason: "out_of_range"`, even on an empty catalog or when a polluted catalog already has the id) alongside ids not in the catalog (`reason: "not_in_catalog"`). All LXF uploads (meet, entries, historical, results) → 409 `new_swimstyles`, `?force=true` overrides. A meet structure mixing pool and beach ids → 400 `mixed_swimstyles`, not overridable (`_replace_current_meet_structure`, checked before any write).
- **meet-app** (`src/main/swimstyleRanges.ts` + `checkLenexSwimstyles` in `lenex.ts`): the `file:import-lenex` handler pre-scans the file **before** it wipes the database — mixed pool/beach → refused; out-of-range ids → "Import anyway?" dialog. Packaged via `extraResources` in `package.json`.
- Tests: `packages/team-app/tests/unit/test_swimstyle_check.py`, `packages/meet-app/tests/swimstyle-ranges.test.ts` (includes "both shipped templates pass cleanly").
- Note: the team-app integration fixture `tests/fixtures/meet_template.lxf` is an older meet with relays at 538-540 — it's always uploaded with `?force=true`.

Templates are the single source of truth for event structure. They are loaded at meet creation
and reloaded (empty meet, no registrations) after a meet reset or result import:
- **meet-app**: File → Nouveau meet
- **team-app**: Admin → New Meet (pool/beach button), env vars `MEET_TEMPLATE_POOL` / `MEET_TEMPLATE_BEACH`
- **team-app reset**: After result import or admin flush, pool template is reloaded automatically
