# meet-app LXF details

### LXF round-trip details

**Import (`importLenex`):**
- Swimstyle id guard (`file:import-lenex` handler, runs before the DB wipe): ids outside `config/swimstyle-ranges.json` (pool 500-531 / beach 601-624) → confirmation dialog; pool+beach mixed → refused. See `config/CLAUDE.md`.
- Loads team-app's `.swimstyles` zip dotfile (full style catalog, incl. styles no event uses) before the events; an event's own SWIMSTYLE still wins
- Remaps `swimstyleid` via `uniqueid` attribute (Splash uses internal auto-increment IDs in MDB but canonical 5xx UIDs in Lenex)
- Break/pause events (`internalevent="T"`) get Splash's round `11`; other rounds map LENEX ↔ Splash codes via `rounds.ts`
- Meet editor fields (`applyMeetLevelFields`): every field mapped by `config/lenex-meet-fields.json` (`lenexMeetFields.ts`, shared with team-app — see `config/CLAUDE.md`), read from Splash's own places (MEET attributes, POOL, FACILITY, QUALIFY, CONTACT, FEES) plus the `.meetvalues` dotfile's heat settings; lanes fall back to the first SESSION's. Mirrored into `MeetName/MeetCity/MeetNation/MeetCourse/MeetOrganizer(Url)/PoolLaneMin/Max`. A structure import takes them all; an entries import into an existing meet fills only the empty ones (locally edited values kept — it used to skip them all, #110). AGEDATE is always synced.
- Session course = `SESSION@course`, else `MEET@course`, else LCM (was always LCM). New sessions created in the app take the meet's course.
- Auto-detects `MEET_TYPE` from swim style IDs: if any `swimstyleid >= 600` → `BEACH`, else `POOL` (only when not already set)

**Export (`exportMeetLenex`, `exportLenexResults`):**
- Includes pause event names in the output
- Uses correct swimstyleids (canonical UIDs)
- Writes the whole meet editor from MEETVALUES via `config/lenex-meet-fields.json` (`meetHeaderXml`) — the same header team-app writes; `exportMeetLenex` also ships the `.meetvalues` heat settings
- Writes `preveventid` on every `<EVENT>` (own row's value, or `-1` if unset) — real Splash
  crashes with an access violation opening a Final whose `preveventid` link was never
  established (see "Prelim/Final event numbering" above). This was missed when the
  attribute was first added (only `importLenex`'s read side and team-app's export.py got it —
  see a1e9d3e); a Final created via "Convert to Final" in meet-app and re-exported straight
  to a real Splash `.mdb` reproduced the crash until both meet-app export functions were
  fixed to write it too.
