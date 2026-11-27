# meet-app relay details

## Relay Entry

Relay team management for events with `relaycount > 1`.

### UI
- `RelayEntryPageWrapper` in renderer wraps the shared `RelayEntryPage` component
- Two entry tabs: "Inscriptions individuelles" (individual) / "Inscriptions relais" (relay)

### Data flow
```
RelayEntryPage (shared-ui)
  → registrationApiElectron.ts
    → IPC: db:get-relay-page-data, db:create-relay-team, db:delete-relay-team,
           db:set-relay-team-member, db:set-relay-team-name,
           db:set-relay-team-hc, db:set-relay-team-entry-time
      → SQLite: relay, relayposition tables
```

### Schema
- `relay` table — team records (event, club, letter)
- `relayposition` table — member assignments (position 1-4)
- `relaysplit` table — relay split times
- All three included in SMB save/restore (`SMB_TABLES`)

### LXF import
`importLenex` processes `RELAY` and `RELAYPOSITION` elements, creating relay teams from imported .lxf files.

### Team composition
Age group: a team's category = the event it was created under. Members must be that exact category or the single adjacent-younger one (swim-up); ≥2 members must match exactly (1-3/0-4 invalid). No per-team age label shown in UI. See `docs/RELAY_TEAM_RULES.md` for full rules (any split valid beyond the anchor — 4-0/3-1/2-2 — 2M+2F for mixed).
