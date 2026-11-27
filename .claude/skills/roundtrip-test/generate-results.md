## Generate Results (test script — relay + beach + DSQ codes)

Fills realistic random results into all `swimresult`/`relay` rows that have a heat assigned and no result yet. Useful for end-to-end testing of the results export / finals flow without running a real competition. Handles **individual + relay** results (`relay`/`relayposition`), uses **sequential beach positions** per heat instead of pool times when `MEET_TYPE=BEACH`, assigns a real `dsqitemid` reason code (from the meet's own seeded `dsqitem` table, filtered individual-vs-relay via `dsqitem.options`), and takes the DSQ rate as an argument (default 5%). Pairs with the top-level `scripts/generate_entries_lxf.py` (see root `CLAUDE.md`) as the second half of an end-to-end synthetic-meet testing pipeline. (This replaced the older `simulate_results.py`/`.bat`, a pool-times-only subset, removed 2026-11 — `generate_results.py` is a strict superset.)

- **Script**: `scripts/generate_results.bat` (calls `scripts/generate_results.py`)
- **Default DB**: auto-detects `%APPDATA%\SauvetageMeet-Dev\meet.db` (unpackaged, i.e. `npm run dev` — matches `app.setName()` in `src/main/index.ts`) vs. `%APPDATA%\SauvetageMeet\meet.db` (packaged build). **If both exist, the script refuses to guess and asks for an explicit path** — silently running against the wrong one used to look identical to a real "0 results, nothing to simulate" run (bit us for real once: `npm run dev` writes to `-Dev`, but an old hardcoded default pointed at the non-`-Dev` path).
- **Side effect**: marks affected heats as official (`racestatus=5`).
- **Idempotent**: only fills rows where the result is still NULL/0 — safe to re-run after generating finals.
- **Scope**: does *not* generate heats or seed Finals from qualifiers (that logic — `generateHeats`, `autoQualify`, `seedFinals` — is TypeScript-only, no CLI equivalent). It only fills rows that already have a real `heatid` and no result yet, matching the standard two-pass workflow: generate prelim/timed-final heats in-app → run this script → qualify + generate Final heats in-app → re-run this script.

```bash
# Default path, default 5% DSQ
scripts\generate_results.bat

# Custom path and DSQ rate (percent)
scripts\generate_results.bat "C:\path\to\meet.db" 15
```

End-to-end synthetic meet, from nothing (full step-by-step procedure in the root `README.md`, "End-to-end test with a large meet"):
```bash
python scripts/generate_entries_lxf.py --clubs 8 --athletes 120 --type pool --output entries.lxf
# meet-app: File -> Importer LENEX (entries.lxf), then "Générer séries", then exit
scripts\generate_results.bat
# meet-app: qualify + generate heats for any Finals, then exit
scripts\generate_results.bat
```

## Fixture data

- Generator: `scripts/generate-fixture-smb.ts`
- Output: `fixture_pool.smb`, `fixture_beach.smb` (10 clubs, 150 athletes, events, registrations)
- Usage: File → Restaurer un meet (.smb)
