# Config — Shared Configuration Files

## Age Group Rules (`age-group-rules.json`)

Single source of truth for the season-reference dates used to determine an athlete's age-group bracket, per *Règlements des compétitions de sauvetage sportif au Québec* (Édition septembre 2025), §1.1-1.3. Holds only the two constants the rule actually varies by — not a rules engine, the branching logic itself lives in each app's own reader:
- `seasonStartDate` — `{month, day}` for `POOL` (1er septembre) and `BEACH` (1er mai). Used for the `10-` and `11-12` brackets.
- `yearEndDate` — `{month, day}`, currently Dec 31 (ILS rule). Used for `13-14`, `15-18`, `Open` (Senior), `Masters`.
- `seasonStartBrackets` — which bracket codes use the season-start date instead of year-end.

Both reference dates are anchored to a single "season year" (fixed once at meet setup, not derived from wall-clock time — see each reader below) so an athlete's bracket stays locked for the whole season even if a birthday would otherwise bump them mid-season. The `10-`/`11-12` brackets get one extra rule baked into both readers' logic: an athlete who is 11 or 12 at season start but will turn 13 by year end is bumped straight to `13-14` for the season instead of staying in `11-12` — the season-start date is *not* an unconditional floor, only `10-` gets that (see the worked examples in each test suite, taken from the rulebook itself).

Independently implemented in both apps (can't share code across the TS/Python boundary) — keep them in sync if this file's shape changes:
- **meet-app**: `src/main/ageGroupRules.ts` — `resolveMatchingAge()`, used by the `db:register` IPC handler (`index.ts`), `addLateEntry` (`db.ts`), and the `db:get-matching-age` IPC channel (called from the renderer's `registrationApiElectron.ts` to drive the registration panel's suggested category) — all three used to compute age from wall-clock `new Date()` instead of a season reference date. Season year comes from `bsglobal.AGEDATE` (`getSeasonYear()`).
- **team-app**: `backend/app/age_group_rules.py` — `resolve_matching_age()`, used by `suggested_age_code` computation in `routers/api.py`. Season year comes from the `age_base_date` config key.
- Tests: `packages/meet-app/tests/age-group-rules.test.ts` and `packages/team-app/tests/unit/test_age_group_rules.py` — same worked examples in both, taken directly from the rulebook (a 12-year-old who turns 13 before Dec 31 gets bumped to 13-14; one who doesn't stays in 11-12; a 10-and-under who turns 11 by Dec 31 stays 10-and-under all season).

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
- Same gender (or event gender=0/3 for mixed categories)

## DSQ Codes (`dsq-codes.json` → `dsq.xml`)

`dsq-codes.json` is the single source of truth for disqualification codes, organized by meet type (`pool`, `beach`). Each entry has a code, French/English names, and applicable options (`INDIVIDUAL`, `RELAY`).

`dsq.xml` is the generated Splash Meet Manager import file (Windows-1252, `<DSQITEMS>` format). Regenerate it with:

```bash
python scripts/generate_dsq_xml.py [--lang fr|en] [--type pool|beach] [--output FILE]
```

## Meet templates

| File | Type | swimstyleid range |
|---|---|---|
| `template_pool.lxf` | Pool (winter) | 500-531 |
| `template_beach.lxf` | Beach (summer) | 601-624 |

Templates are the single source of truth for event structure. They are loaded at meet creation
and reloaded (empty meet, no registrations) after a meet reset or result import:
- **meet-app**: File → Nouveau meet
- **team-app**: Admin → New Meet (pool/beach button), env vars `MEET_TEMPLATE_POOL` / `MEET_TEMPLATE_BEACH`
- **team-app reset**: After result import or admin flush, pool template is reloaded automatically
