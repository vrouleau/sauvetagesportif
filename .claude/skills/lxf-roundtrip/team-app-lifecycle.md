# team-app meet lifecycle & meet_type

## Meet lifecycle (LXF round-trip)

Full data flow between meet-app and team-app:

| Step | Direction | What | How |
|---|---|---|---|
| 1. Setup | meet-app → team-app | Meet structure (events, sessions, agegroups) | meet-app: File → "Exporter la structure du meet LENEX…" → upload via Organizer page |
| 2. Invitations | team-app | Clubs register athletes | Organizer sends PINs; coaches log in and register |
| 3. Entries | team-app → meet-app | Registrations + entry times | team-app: Organizer → "Télécharger LXF"; meet-app: File → Importer LENEX |
| 4. Competition | meet-app | Run heats, record times | — |
| 5. Results | meet-app → team-app | Final results + athletes | meet-app: File → "Exporter les résultats LENEX…"; team-app: Organizer → "Importer résultats" |

**Step 5 (organizer path) also closes the meet cycle:**
- Archives results as a completed historical meet (`meetstate=3`)
- Resets the current meet (clears registrations, events, bsglobal meet keys) — **both organizer and admin paths trigger reset**
- Regenerates all club PINs (coaches must re-authenticate for next meet)
- Clears `organizer_club_id` (organizer path) — organizer is logged out
- Admin then sets a new organizer for the next meet via Admin page

**Admin import** (`POST /api/import-results-lxf` with admin PIN): same historical archival + reset. Both paths refuse a file with no results (an entries/meet-structure LXF picked by mistake) and ask for confirmation before closing the open meet with a file whose meet name or event ids don't match it. If a completed meet with the same name and start date already exists, its results are replaced rather than duplicated (a dateless file matches by name only when exactly one completed meet has it).

**One results importer:** `import-results-lxf` (`lxf_to_team.import_lxf_as_meet`) and `admin/import-historical` (`historical_import.import_historical_meet`) are thin entry points over `lxf_to_team.archive_results_lxf`; they differ only in policy — the admin one warns when the file looks like the open meet and asks (`needs_force`) before replacing an archived meet, the closing one replaces it silently. Same athlete matching, sessions/events, defusedxml parsing and response keys (`results_imported`, `relays_imported`, `athletes_matched`…) for both. They used to be two copies that drifted (one never wrote `results.eventnumb`); keep any new import rule in `archive_results_lxf`.

**Beach meets are never archived:** the results importer refuses (both entry points) a file with any style `>= BEACH_STYLE_MIN` (`is_beach_results`, decided from the file, not the per-install `meet_type` flag). The Organizer page hides "Importer résultats" for a beach meet; it's closed with "Fermer sans résultats".

**Archived results carry `results.eventnumb`** (the event number): `results.py` groups a historical meet's results by it and the athlete history sorts by it. The Organizer import used to leave it NULL (all events lumped under "event 0").

**Next-meet stub:** when the closed (or deleted) meet was the last open one, `_reload_pool_template` creates the next meet from the pool template with the same meet config as "New meet" (`_init_meet_from_template`: meet_course, filename, masters, currency, fees, AGEDATE, COMBINEAGEGROUPS). It used to get only AGEDATE — no `meet_course` — which hid every relay entry-time suggestion in the next meet.

**MEETVALUES blob** (meet-scoped `meet_config` row, Splash `KEY=TYPE;VALUE` CRLF lines): read and write it only through `meet_config.parse_meetvalues` / `serialize_meetvalues` / `read_meetvalues` / `write_meetvalues` (`keep_type=True` = raw `TYPE;VALUE`, else the prefix is stripped), or `_update_meetvalue` for one key — never hand-split the blob. Team-app twin of meet-app's `parseMeetValues`/`serializeMeetValues` (`db.ts`).

**Meet course (pool length):** stored in three places that must agree — `meet_config.meet_course` (LENEX string, canonical), `meets.course` and MEETVALUES `COURSE` (team-app's own ints 1=LCM, 2=SCY, 3=SCM — **not** Splash's, where 2=SCM, 3=SCY; meet-app stores Splash's). The shared editor and the API (`/meet-config` COURSE, session `course`) use the LENEX name, never the number. Write it only with `meet_config._set_meet_course`, read it only with `_get_meet_course` (never None: a meet with no stored course is LCM, what the meet editor shows). New sessions take the meet's course. **Changing the course in the meet editor** (`set_meet_config` COURSE) moves the meet's sessions to it and recomputes every relay entry time still following the suggestion for the new course (`best_times.refresh_relay_entry_times_for_course`; typed times kept) — an organizer who fixes the pool length late rebuilds nothing. `best_times.suggest_relay_entry_time` is the Python copy of shared-ui's `suggestRelayEntryTime` (same half-up rounding) — keep them in step.

**Meet editor fields in LXF:** every field of the meet editor travels in both directions, mapped by `config/lenex-meet-fields.json` (see `config/CLAUDE.md`): standard LENEX the way Splash writes it (MEET attributes, POOL, FACILITY, QUALIFY, CONTACT, FEES) and the hidden `.meetvalues` entry for the seeding/heat settings. Both exports write it (`export._add_meet_element`, closure date → `deadline`, `meet_currency` on FEEs); a structure upload applies the file's fields and takes its deadline as the closure date; a meet created from a template takes the template's fields (not its deadline) as defaults.

**Empty meet state:** After reset (or fresh install), the meet has no events. Self-invite page shows "no meet planned" when empty; the login screen's meet list skips the nameless/eventless stub and says no meet is planned. Admin or organizer uploads a new meet .lxf to start the next cycle.

## meet_type, swimstyle guard and catalog

`meet_type` is a **cached flag**, not an independent source of truth — the
real signal is always the swimstyleid range (pool 500-531, beach 601-624).
It's recomputed fresh on every `POST /api/upload/meet`, scanning only *that
upload's own* events — deliberately not the SwimStyle catalog (see below),
so a stale historical style can't misclassify a new upload. `POST
/api/admin/new-meet` sets it explicitly from the request body. Historical
imports (`import-historical`, `import-results-lxf`) never touch it.

**Swimstyle id guard:** every LXF upload flags style ids outside `config/swimstyle-ranges.json` (pool 500-531 / beach 601-624) in the same 409 `new_swimstyles` warning as catalog-new ids (`reason` field per style, `?force=true` overrides); a meet structure mixing pool and beach ids is a 400 `mixed_swimstyles` (not overridable). See `config/CLAUDE.md`.

**SwimStyle catalog is never pruned across meets.** Historical events/results
keep referencing old style ids, so once a pool meet has ever run, its 5xx
styles stay in the catalog forever (same in reverse for 6xx beach styles).
Any endpoint that reads the catalog directly (`GET /api/swim-styles`) must
filter by the current `meet_type`, or it'll offer styles from the wrong
sport — this bit us for real once already.

**Full catalog travels with every LXF export** (`generate_lxf`, `generate_meet_lxf_from_db`):
LENEX only carries a SWIMSTYLE inside an EVENT, so the zip also gets a hidden
`.swimstyles` JSON dotfile (`export.current_meet_swimstyles` — the same
meet-type-filtered list `GET /api/swim-styles` returns). meet-app loads it on
import so a last-minute event can use a style no event had. Splash ignores dotfiles.
