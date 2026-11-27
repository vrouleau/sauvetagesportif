# team-app relay details

## Relay Teams

Full CRUD management for relay team entries (events with `relaycount > 1`).

### Workflow
1. Coach navigates to "Inscriptions relais" tab
2. Selects a relay event → sees existing teams (A, B, C…)
3. Creates a team → assigns members from dropdown (filtered by eligibility)
4. Team age group = the category of the event the team was created under (not computed from members); no per-team label shown, event card header applies
5. Exported in .lxf via `relays`/`relayspos` tables (Team Manager schema)

### Key rules
- Team age group: anchored to the event's own category; members must be that exact category or the single adjacent-younger one (swim-up), ≥2 members must match exactly (1-3/0-4 invalid), any split beyond that is OK (4-0/3-1/2-2) — see `docs/RELAY_TEAM_RULES.md`
- Mixed events: exactly 2M + 2F
- **SERC events (swimstyle 530): NO gender/age restrictions** — any mix allowed
- Member eligibility: same club, registered for individual events, not on another team for same event
- Team naming: auto = concatenated last names; custom name via `PUT /api/relay-teams/{id}/name`
- **HC (exhibition) teams**: no gender/age restrictions (like SERC); exported as relay `ENTRY status="EXH"` (individual HC registrations too, `swimresult.resultstatus=4`)
- **Entry time** (pool, not SERC): exported as the relay `ENTRY@entrytime`; suggested from the members' relay best times (see "Best times storage")
- Closure date and club ownership apply to entry time and HC like every other relay edit

### LXF import
`upload_entries` (seed.py) also imports relay teams from uploaded .lxf files.

## API endpoints (with access levels)

| Endpoint | Purpose | Access |
|---|---|---|
| `GET /api/relay-teams?club_id=X` | Relay page data (events, teams, eligible athletes) | Authenticated |
| `POST /api/relay-teams` | Create relay team | Authenticated |
| `DELETE /api/relay-teams/{id}` | Delete relay team | Authenticated |
| `PUT /api/relay-teams/{id}/members/{pos}` | Assign/remove member at position | Authenticated |
| `PUT /api/relay-teams/{id}/name` | Set custom team name | Authenticated |
| `PUT /api/relay-teams/{id}/entry-time` | Set/clear pool relay entry time `{entryTimeMs}` — 400 on beach/SERC | Authenticated (own club) |
| `PUT /api/relay-teams/{id}/hc` | Set/clear HC `{isHC}` (`relays.resultstatus=4`) | Authenticated (own club) |
| `GET/POST /api/serc/config` | SERC configuration (victims, factors, bystander) | Organizer/Admin |
| `GET /api/serc/teams` | SERC relay teams (swimstyle 530) | Organizer/Admin |
| `PUT /api/serc/score` | Save individual score (0-10 or -10 rough) | Public |
| `GET /api/serc/scores/1` | All scores grouped by team | Public |
| `GET /api/serc/results` | Ranked results (weighted totals) | Public |
| `POST /api/serc/draw-order/1/randomize` | Randomize team draw order | Organizer/Admin |
| `GET /api/serc/print/sheets?lang=fr` | Printable judge sheets (fr/en/bilingual) | Public |
