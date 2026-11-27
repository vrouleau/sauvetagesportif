---
name: relay-entry
description: How relay teams, SERC, relay entry times and HC (exhibition) are implemented in meet-app and team-app. Use when touching RelayEntryPage, relay teams/members, team composition rules, SERC scoring/judging, relay entry times or relay history, or the relay IPC/API endpoints.
---

# Relay Entry

Relay team management across both apps. Relay events have `relaycount > 1` (typically 4). Full composition rules: `docs/RELAY_TEAM_RULES.md`.

## Data flow
```
RelayEntryPage.tsx  (packages/shared-ui/src/pages/)
    ↓ useApi()
    ├── meet-app: registrationApiElectron.ts → Electron IPC → SQLite (relay/relayposition tables)
    └── team-app: meetApi.js → HTTP fetch → FastAPI → SQLite (relays/relayspos tables)
```
Both apps show two entry tabs: "Individual Entries" (`IndividualEntryPage`, only `relaycount=1`) and "Relay Entries" (`RelayEntryPage`).

## Team composition rules
- **Age group**: a team's category = the event it was created under (not computed from members). Members must be that exact category or the single adjacent-younger one (swim-up, never the reverse). At least 2 members must match the exact category — 1-3 and 0-4 splits are invalid. Beyond that any split is valid (4-0, 3-1, 2-2); no majority requirement. No per-team age label in the UI.
- **Mixed events** (gender=X/Mixed): exactly 2M + 2F (4-person relay).
- **SERC events** (swimstyle 530): NO gender or age restrictions.
- **HC (exhibition) teams**: no gender or age restrictions, in both apps.
- **Eligibility**: same club, registered for individual events, no duplicate across teams for the same event.
- **Team naming**: concatenated last names ("Tremblay/Gagnon/Roy/Boucher") or custom name.

## meet-app IPC channels
| Channel | Purpose |
|---|---|
| `db:get-clubs` | Real database club IDs |
| `db:get-relay-page-data` | Relay events, teams, eligible athletes |
| `db:create-relay-team` / `db:delete-relay-team` | Create / delete team |
| `db:set-relay-team-member` | Assign/remove member at position |
| `db:set-relay-team-name` | Custom team name |
| `db:set-relay-team-hc` | Set/clear HC — `relay.resultstatus=4` |
| `db:set-relay-team-entry-time` | Set/clear pool relay entry time (ms) — `relay.entrytime` |

## team-app API endpoints
| Endpoint | Purpose |
|---|---|
| `GET /api/relay-teams?club_id=X` | Relay page data |
| `POST /api/relay-teams` | Create team |
| `DELETE /api/relay-teams/{id}` | Delete team |
| `PUT /api/relay-teams/{id}/members/{pos}` | Assign member |
| `PUT /api/relay-teams/{id}/name` | Custom name |
| `PUT /api/relay-teams/{id}/entry-time` | Entry time `{entryTimeMs}` (400 on beach/SERC) |
| `PUT /api/relay-teams/{id}/hc` | HC `{isHC}` — `relays.resultstatus=4` (migration m0008) |

## Relay entry time + HC
- **Entry time** (pool relays only — beach relays are ranked, SERC is judged): typed by the coach on each team card, exported as relay `ENTRY@entrytime`; meet-app seeds relay heats by `relay.entrytime` like individual entries (NT last).
- **Suggested time**: each member's *relay best time* = fastest total of any archived team they swam on, per style/course (`best_times.get_relay_best_times`, team-app; 18-month expiry, HC/DSQ/DNS excluded; Lancer de la corde is course-free). Suggestion = **average of members who have one** (`shared-ui/src/logic/relayEntryTime.ts`), filled in and kept in step as members change — until the coach types a time, which is then kept. A "?" bubble (`RelayEntryTimeHelp`) explains the rule and the team breakdown (breakdown is team-app only; meet-app has no relay history).
- **Relay history**: meet-app's results export writes `RELAY > RESULTS > RESULT` (team total, status, swimmers) and relay-only swimmers as `ATHLETE`s; both team-app results imports archive them into `relays`/`relayspos` under the historical meet (`relay_archive.py`).
- **HC**: set by the coach in either app; Splash encoding (`resultstatus=4`) on `relay`/`relays` and `swimresult`; travels as LXF `ENTRY status="EXH"` (individual and relay). HC teams skip composition rules; heat seeding puts HC entries in the exhibition group (`SEEDEXHLAST`).

## LXF / SMB
- **meet-app** `importLenex` processes `RELAY` and `RELAYPOSITION`, including `ENTRY@entrytime` and `ENTRY@status="EXH"`.
- **team-app** `upload_entries` imports relay teams from LXF (entry time + EXH too).
- meet-app's SMB backup/restore handles `relay`, `relayposition`, `relaysplit` (Splash interop). team-app has no `.smb` support.

## SERC (Simulated Emergency Response Competition)
Judged technical relay (swimstyle 530), teams of 4. No gender/age restrictions, no age labels. **Scoring instead of timing**: judges rate criteria 0-10 (×0.5 steps), weighted by factors. Separate SERC tab in organizer view. team-app only (no meet-app path).

| Component | What |
|---|---|
| `backend/app/models_serc.py` | Models (serc_config, serc_draw_order, serc_score) |
| `backend/app/routers/serc.py` | CRUD API (config, teams, scores, results, draw order, DQ) |
| `backend/app/routers/serc_print.py` | Printable judge sheets (one page per team per section, bilingual) |
| `frontend/src/pages/Serc.jsx` | Organizer page (setup, scoring grid, results, QR codes) |
| `frontend/src/pages/SercJudge.jsx` | Judge tablet form (public, no login, FR/EN) |

| Endpoint | Purpose |
|---|---|
| `GET/POST /api/serc/config` | SERC configuration (victims, factors) |
| `GET /api/serc/teams` | Relay teams for swimstyle 530 |
| `GET/POST /api/serc/draw-order/1/randomize` | Randomize team order |
| `PUT /api/serc/score` | Save one score (draw, team, section, field, value) |
| `GET /api/serc/scores/1` | All scores grouped by team |
| `GET /api/serc/results` | Ranked results |
| `GET /api/serc/print/sheets?lang=fr` | Judge sheets (fr/en/bilingual) |
| `GET /api/serc/dsq-codes`, `PUT /api/serc/disqualification` | SERC DQ (codes from `config/dsq-codes.json` `serc` list) |

Judge URLs (public): `/serc/judge/overall`, `/serc/judge/bystander`, `/serc/judge/victim/1`. A DQ'd (draw, team) contributes 0 to that draw and is excluded from its ranking (rank omitted).

Remember: UI changes to `RelayEntryPage.tsx` / `IndividualEntryPage.tsx` live in shared-ui and affect both apps (see the `shared-ui-change` skill).
