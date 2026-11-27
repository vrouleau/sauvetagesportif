---
name: roundtrip-test
description: Drive the end-to-end synthetic meet test (entries LXF → meet-app heats → generated results → finals → results export → team-app import). Generates the files, runs the scriptable steps, and guides the user through the GUI-only steps. Use when asked to run/set up the round-trip or end-to-end meet test.
disable-model-invocation: true
argument-hint: "[--type pool|beach] [--clubs N] [--athletes N] [--dsq-pct N] [--seed N]"
---

# End-to-end synthetic meet round-trip

Arguments: `$ARGUMENTS` (defaults: `--type pool --clubs 12 --athletes 300 --dsq-pct 5`; pass `--seed` for reproducibility). Reference: root `README.md` → "End-to-end test with a large meet", and the `lxf-roundtrip` skill.

**Honest scope**: heat generation, qualification/finals seeding, and the LXF import/export menus are meet-app GUI/TypeScript only — they cannot be scripted. This skill automates what can be (file generation, results fill, verification) and gives the user exact prompts for the rest. Tell the user which steps need them; don't pretend to have run GUI steps.

## Steps
1. **Generate entries** (repo root, scriptable):
   `python scripts/generate_entries_lxf.py --clubs N --athletes N --type pool|beach --output entries.lxf [--seed N]`
   Write to the scratchpad or a user-chosen path, not the repo root, unless asked. Confirm the file exists and summarize clubs/athletes.
2. **USER**: launch meet-app (`cd packages/meet-app && npm run dev`, from their own terminal), *File → Nouveau meet* (matching type), *File → Importer LENEX* → `entries.lxf`, then *Générer séries*, then **fully exit** meet-app (SQLite must be unlocked).
3. **Fill results** (scriptable, only after the user confirms the app is closed):
   `cd packages/meet-app && python scripts/generate_results.py --dsq-pct N [--seed N]` (Windows: `scripts\generate_results.bat [db_path] [dsq_pct]`).
   - Default DB is auto-detected: `%APPDATA%\SauvetageMeet-Dev\meet.db` (dev) vs `%APPDATA%\SauvetageMeet\meet.db` (packaged). If both exist it refuses and needs an explicit path — ask which; never guess.
   - Side effect: marks affected heats official (`racestatus=5`). Idempotent: only fills empty rows.
   - Only works where `meet.db` is reachable from this session; in a Linux container it usually is not — then give the user the command to run.
4. **USER**: relaunch meet-app, qualify + *Générer séries* for Final rounds, exit again. (Beach: qualification is by best prelim position.)
5. **Re-run** step 3 to fill the new Final heats.
6. **USER**: relaunch, *File → Exporter résultats* (writes the results LXF, including relay results).
7. **Verify in team-app**: Organizer → *Importer résultats* with that file (or, if a running test stack exists on `http://127.0.0.1:8000`, upload via the API). Check: results archived as a historical meet, relay history present in `relays`/`relayspos`, club PINs regenerated, current meet reset.

## Report
Per step: done by me / needs user / blocked, plus anything suspicious (rows with no heat, DSQ codes missing, athletes without results, relay results absent, swimstyle warnings on import). For automated regression coverage instead of a manual run, point to `/team-tests` and `/meet-tests` (LXF round-trip unit tests live in `test_meet_course_roundtrip.py` and `lenex.test.ts`).

More: `generate-results.md` (generate_results.py details, default DB detection, fixtures).