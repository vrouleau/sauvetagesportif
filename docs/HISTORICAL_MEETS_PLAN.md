# Historical Meets — Feature Plan

## Goal

Import past competition results from LXF files into the team-app database as distinct historical meets. This builds a full competition history per athlete and derives best times from actual stored results rather than a JSON blob.

## Current State

### What exists in the schema (ready to use)

The database already has multi-meet support:

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `meets` | `meetsid`, `name`, `mindate`, `maxdate`, `course`, `place` | Meet registry |
| `sessions` | `sessionsid`, `meetsid`, `numb`, `name`, `startdate` | Sessions per meet |
| `events` | `eventsid`, `meetsid`, `stylesid`, `numb`, `gender`, `minage`, `maxage` | Events per meet |
| `results` | `resultsid`, `membersid`, `meetsid`, `stylesid`, `totaltime`, `rank`, `course` | Athlete results per meet |
| `membersmeets` | `membersid`, `meetsid`, `clubsid` | Which athletes participated in which meet |

### What exists in the code

- `seed_from_lxf()` — merges clubs/athletes from LXF (works for any LXF regardless of meet)
- `load_best_times()` — extracts best times into `bsglobal` JSON blobs
- `BsGlobal("current_meetsid")` — tracks which meet is the "active" one
- Meet/Result models with relationships already defined

### What's missing

1. **No endpoint** to import a results LXF as a historical meet (distinct from current meet)
2. **No UI** to browse historical meets or view past results per athlete
3. **Best times** are stored in JSON blobs instead of computed from `results` table
4. **No deduplication** logic for re-importing the same meet

---

## Data Flow (Import)

```
Results .lxf file (from Splash export)
       │
       ▼
Parse MEET element → name, date, course, city
       │
       ▼
Create/find Meet record (dedupe by name + date)
       │
       ▼
Parse CLUBS → merge clubs (by code/name)
       │
       ▼
Parse ATHLETES → merge athletes (by name + club)
       │
       ▼
Link athletes to meet (membersmeets)
       │
       ▼
Parse RESULTS → store in results table
  - Each RESULT gets: membersid, meetsid, stylesid, totaltime, rank, course
       │
       ▼
Recompute best times from all results across all meets
```

---

## Implementation Plan

### Phase 1: Historical Meet Import (Backend)

#### Task 1: New endpoint `POST /admin/import-historical`

**Input**: Results .lxf file  
**Behavior**:
1. Parse the MEET element to extract: name, date(s), course, city/pool
2. Check for existing meet with same name + date (deduplication)
3. Create a new `Meet` record (or update if reimporting)
4. Parse clubs/athletes via existing `seed_from_lxf` logic (merge)
5. Parse EVENT elements → create `Event` records under this meet
6. Parse RESULT elements per athlete → create `Result` records
7. Create `MemberMeet` entries (athlete ↔ meet links)
8. Recompute best times from all `Result` records across all meets

**Response**: `{ meet_id, meet_name, athletes_matched, results_imported }`

#### Task 2: Adapt `seed_from_lxf` to return matched athlete IDs

Currently `seed_from_lxf` creates/matches athletes but doesn't return a mapping of "LXF athlete ID → DB member ID." The historical import needs this mapping to link results to the correct athlete.

**Change**: Return a `lenex_id_to_member` dict alongside the counts.

#### Task 3: Best times recomputation from results table

Replace (or supplement) the current JSON-blob best times with a query:

```sql
SELECT membersid, stylesid, course, MIN(totaltime) as best_time
FROM results
WHERE totaltime IS NOT NULL AND totaltime > 0
GROUP BY membersid, stylesid, course
```

This gives best times derived from actual historical data rather than a manually-imported blob. The existing `bsglobal` JSON approach can be kept as a fallback/cache.

#### Task 4: Meet deduplication

When importing, detect if the same meet was already imported:
- Match by `name` + `mindate` (exact match)
- If found: option to skip, or wipe + reimport that meet's results

---

### Phase 2: Historical Meets API (Read)

#### Task 5: `GET /admin/historical-meets`

Returns list of all meets (excluding current):
```json
[
  { "id": 3, "name": "Championnats Québec 2024", "date": "2024-03-15", "course": "SCM", "resultCount": 180 },
  { "id": 2, "name": "Coupe Gatineau 2023", "date": "2023-11-04", "course": "SCM", "resultCount": 95 }
]
```

#### Task 6: `GET /admin/historical-meets/{meet_id}/results`

Returns results for a given meet, grouped by event:
```json
{
  "meet": { "name": "...", "date": "..." },
  "events": [
    { "number": 1, "name": "200m Obstacle Swim", "gender": "M", "results": [
      { "athleteName": "Tremblay, Marc", "club": "CNQC", "time_ms": 134560, "rank": 1 }
    ]}
  ]
}
```

#### Task 7: `GET /athletes/{id}/history`

Returns an athlete's results across all historical meets:
```json
{
  "athlete": { "name": "Tremblay, Marc", "club": "CNQC" },
  "meets": [
    { "name": "Championnats 2024", "date": "2024-03-15", "results": [
      { "event": "200m Obstacle Swim", "time_ms": 134560, "rank": 1 }
    ]}
  ],
  "bestTimes": [
    { "style": "200m Obstacle Swim", "course": "SCM", "time_ms": 132100, "meetName": "Coupe Gatineau 2023" }
  ]
}
```

#### Task 8: `DELETE /admin/historical-meets/{meet_id}`

Deletes a historical meet and all its results. Does not touch athletes/clubs.

---

### Phase 3: UI (Data Management Page)

#### Task 9: Historical Meets section in admin Data Management page

- List all historical meets with date, name, result count
- "Import" button → file picker for results .lxf
- "Delete" button per meet (with confirmation)
- Click meet → expand to show results summary

#### Task 10: Athlete detail panel — history tab

- Show past results per meet in the athlete detail view
- Show best time progression chart (optional)

---

### Phase 4: Best Times Migration

#### Task 11: Derive best times from results table

Once historical meets are imported, best times should come from the `results` table:
- At import time: scan all `Result` records for the athlete and update best time if faster
- At query time: `MIN(totaltime)` grouped by `(membersid, stylesid, course)` across all meets
- Keep the `bsglobal` JSON as a cache/fallback for performance

#### Task 12: Update `/upload/results` to also store in results table

The current `/upload/results` imports best times into JSON blobs. After this migration, it should also:
1. Create a Meet record for the imported results
2. Store individual results in the `results` table
3. Derive best times from the results table

This makes `/upload/results` and `/admin/import-historical` converge on the same behavior.

---

## LXF Results File Structure (Reference)

```xml
<LENEX>
  <MEETS>
    <MEET name="Championnats QC 2024" course="SCM" city="Gatineau"
          startdate="2024-03-15" stopdate="2024-03-17">
      <SESSIONS>
        <SESSION number="1" date="2024-03-15" name="Session 1">
          <EVENTS>
            <EVENT eventid="101" number="1" gender="M">
              <SWIMSTYLE distance="200" stroke="UNKNOWN" swimstyleid="519" name="200m Obstacle" relaycount="1"/>
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
      <CLUBS>
        <CLUB code="CNQC" name="Club Nautique QC">
          <ATHLETES>
            <ATHLETE athleteid="1001" firstname="Marc" lastname="Tremblay"
                     gender="M" birthdate="2005-06-12">
              <RESULTS>
                <RESULT eventid="101" swimtime="00:02:14.56" status=""
                        points="0" reactiontime="0.72"/>
              </RESULTS>
            </ATHLETE>
          </ATHLETES>
        </CLUB>
      </CLUBS>
    </MEET>
  </MEETS>
</LENEX>
```

Key elements to extract:
- **MEET**: name, course, startdate, city → `meets` table
- **EVENT**: eventid, number, gender, SWIMSTYLE → `events` table
- **ATHLETE**: firstname, lastname, gender, birthdate → merge into `members`
- **RESULT**: eventid, swimtime, status, rank → `results` table (linked via `meetsid` + `membersid` + `stylesid`)

---

## Deduplication Rules

| Entity | Match By | On Conflict |
|--------|----------|-------------|
| Meet | name + startdate | Skip or re-import (user choice) |
| Club | code (or name if no code) | Update name/nation |
| Athlete | firstname + lastname + club | Update birthdate/gender if missing |
| Result | membersid + meetsid + stylesid + eventnumb | Update time if reimporting |

---

## Impact on Current Features

| Feature | Impact |
|---------|--------|
| Current meet registration | None — current meet uses `swimresult` table, history uses `results` table |
| Relay teams | None — relay operates on current meet only |
| Best times display | Enhanced — can show source meet name |
| Export | None — exports current meet only |
| SMB upload | Unchanged — still wipes and restores current meet only |

---

## Priority and Effort

| Phase | Effort | Value |
|-------|--------|-------|
| Phase 1 (import) | 1-2 days | High — enables building the history |
| Phase 2 (API) | 1 day | Medium — makes history queryable |
| Phase 3 (UI) | 1 day | Medium — makes it user-friendly |
| Phase 4 (best times) | Half day | High — single source of truth for best times |

**Recommended order**: Phase 1 → Phase 4 → Phase 2 → Phase 3

Start with import + best times derivation (immediate practical value for your 4 meets), then add the browse UI later.
