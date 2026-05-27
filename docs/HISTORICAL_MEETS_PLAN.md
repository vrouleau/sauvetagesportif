# Historical Meets — Plan

## Summary

Migrate the team-app from the Meet Manager schema (single-meet) to the Team Manager schema (multi-meet), enabling historical meet tracking and computed best times.

## Scope

1. **Import `Team.mdb`** — one-time migration from Splash Team Manager using `mdbtools`
2. **Import `.smb`** from meet-app — bring in results after a competition, mapped to Team Manager schema
3. **Historical meets UI** — Data Management page: list meets (name, date, location), "R" badge for results, delete
4. **Best times from results** — computed from historical `RESULTS` table, replaces JSON blobs in bsglobal
5. **Backup/restore** — Docker volume / `pg_dump` (no custom format)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  team-app (PostgreSQL — Team Manager schema)            │
│                                                         │
│  MEETS ← SESSIONS, EVENTS, RESULTS                     │
│  CLUBS ← MEMBERS (athletes)                            │
│  SWIMSTYLE (shared, identical in both Splash apps)      │
│                                                         │
│  Import sources:                                        │
│    • Team.mdb (via mdbtools) — one-time migration       │
│    • .smb from meet-app — post-competition results      │
│    • .lxf entries — from meet-app Lenex export          │
│                                                         │
│  Export:                                                 │
│    • .lxf entries — for meet-app import                 │
│    • pg_dump — backup                                   │
└─────────────────────────────────────────────────────────┘
```

## Schema (Team Manager — from real Team.mdb)

### MEETS
```sql
CREATE TABLE meets (
    meetsid         INTEGER PRIMARY KEY,
    name            VARCHAR(100),
    poolname        VARCHAR(50),
    place           VARCHAR(50),
    state           VARCHAR(4),
    nation          VARCHAR(50),
    mindate         TIMESTAMP,
    maxdate         TIMESTAMP,
    agedate         TIMESTAMP,
    course          INTEGER,        -- 1=LCM, 2=SCY, 3=SCM
    meetstate       SMALLINT,
    feeclub         DOUBLE PRECISION,
    feeperson       DOUBLE PRECISION,
    feerelay        DOUBLE PRECISION,
    maxientries     SMALLINT,
    maxrentries     SMALLINT,
    deadline        TIMESTAMP,
    data            TEXT
);
```

### SESSIONS
```sql
CREATE TABLE sessions (
    sessionsid      INTEGER PRIMARY KEY,
    meetsid         INTEGER REFERENCES meets(meetsid) ON DELETE CASCADE,
    numb            INTEGER,
    startdate       TIMESTAMP,
    starttime       TIMESTAMP,
    name            VARCHAR(50),
    feeperson       DOUBLE PRECISION
);
```

### EVENTS
```sql
CREATE TABLE events (
    eventsid        INTEGER PRIMARY KEY,
    meetsid         INTEGER REFERENCES meets(meetsid) ON DELETE CASCADE,
    sessionnumb     INTEGER,
    numb            INTEGER,
    eventtyp        SMALLINT,
    stylesid        INTEGER REFERENCES swimstyle(swimstyleid),
    minage          INTEGER,
    maxage          INTEGER,
    fee             DOUBLE PRECISION,
    gender          INTEGER,
    sortcode        INTEGER
);
```

### MEMBERS (athletes)
```sql
CREATE TABLE members (
    membersid       INTEGER PRIMARY KEY,
    lastname        VARCHAR(120),
    firstname       VARCHAR(60),
    birthdate       TIMESTAMP,
    gender          INTEGER,
    nation          VARCHAR(3),
    license         VARCHAR(20),
    clubsid         INTEGER REFERENCES clubs(clubsid),
    -- team-app extras:
    pin             VARCHAR(20),
    email           VARCHAR(100)
);
```

### CLUBS
```sql
CREATE TABLE clubs (
    clubsid         INTEGER PRIMARY KEY,
    name            VARCHAR(100),
    shortname       VARCHAR(30),
    code            VARCHAR(8),
    nation          VARCHAR(3),
    -- team-app extras:
    pin             VARCHAR(20),
    email           VARCHAR(100)
);
```

### RESULTS
```sql
CREATE TABLE results (
    resultsid       INTEGER PRIMARY KEY,
    membersid       INTEGER REFERENCES members(membersid) ON DELETE CASCADE,
    meetsid         INTEGER REFERENCES meets(meetsid) ON DELETE CASCADE,
    eventdate       TIMESTAMP,
    stylesid        INTEGER REFERENCES swimstyle(swimstyleid),
    totaltime       INTEGER,
    entrytime       INTEGER,
    rank            INTEGER,
    eventnumb       INTEGER,
    eventtyp        SMALLINT,
    resulttyp       SMALLINT,
    course          INTEGER,
    entrytimecourse INTEGER
);
```

### MEMBERSMEETS
```sql
CREATE TABLE membersmeets (
    membersid       INTEGER REFERENCES members(membersid) ON DELETE CASCADE,
    meetsid         INTEGER REFERENCES meets(meetsid) ON DELETE CASCADE,
    clubsid         INTEGER REFERENCES clubs(clubsid),
    PRIMARY KEY (membersid, meetsid)
);
```

### SWIMSTYLE (identical to Meet Manager)
```sql
CREATE TABLE swimstyle (
    swimstyleid     INTEGER PRIMARY KEY,
    code            VARCHAR(10),
    distance        INTEGER,
    name            VARCHAR(50),
    relaycount      INTEGER,
    stroke          INTEGER,
    sortcode        INTEGER,
    technique       INTEGER,
    uniqueid        INTEGER
);
```


## Implementation Phases

### Phase 1: Schema Migration
- New SQLAlchemy models matching Team Manager schema
- Keep `bsglobal` for app config (admin_pin, closure_date, organizer_club_id, etc.)
- Keep `swimstyle` table (identical in both schemas)
- Drop old Meet Manager tables on fresh deploy (migration script for existing deployments)

### Phase 2: MDB Import (via mdbtools)
- Add `mdbtools` to Docker image
- Endpoint: `POST /api/admin/import-mdb` (admin only)
- Reads `.mdb` using `subprocess` + `mdb-export` (CSV output per table)
- Parses CSV → inserts into PostgreSQL
- Tables: MEETS, SESSIONS, EVENTS, MEMBERS, CLUBS, RESULTS, SWIMSTYLE, MEMBERSMEETS

### Phase 3: SMB Import (meet results → team DB)
- Endpoint: `POST /api/admin/import-meet-results` (admin only)
- Reads `.smb` using existing gbin parser
- Creates/updates a MEETS row (from bsglobal MeetName/date in the SMB)
- Maps: CLUB→CLUBS, ATHLETE→MEMBERS, SWIMRESULT→RESULTS
- Athlete matching: by license (primary) or name+birthdate (fallback)

### Phase 4: Historical Meets UI
- Data Management page: "Historical Meets" section
- List: name, date range (MINDATE–MAXDATE), location (PLACE)
- "R" badge on meets with RESULTS.totaltime > 0
- Delete button: cascades sessions, events, results, membersmeets
- Current meet = most recent MINDATE without results (or explicitly marked)

### Phase 5: Best Times from Results
- Remove `bt_{athlete_id}` JSON blobs from bsglobal
- Compute via SQL:
  ```sql
  SELECT membersid, stylesid, course, MIN(totaltime), MAX(eventdate)
  FROM results
  WHERE totaltime > 0 AND resulttyp = 0
  GROUP BY membersid, stylesid, course
  ```
- 18-month expiry based on eventdate
- Registration page queries on demand (no cache needed)

### Phase 6: Adapt Existing Features
- Registration: EVENTS (current meet) + MEMBERSMEETS + RESULTS (entry times)
- Entries export (.lxf): current meet registrations
- Meet structure upload (.lxf): creates MEETS + SESSIONS + EVENTS
- New meet creation: new MEETS row, old becomes historical
- Invitations, closure, fees: scoped to current meet

### Phase 7: Frontend Updates
- EventsPage adapter for new schema
- Registration flow with RESULTS-based entries
- Data Management "Historical Meets" component
- Organizer page updates

## Data Flow

```
┌─────────────────┐         Lenex .lxf          ┌─────────────────┐
│   team-app      │ ──── entries export ───────→ │   meet-app      │
│  (Team schema)  │ ←─── results .smb ────────── │  (Meet schema)  │
│                 │                               │                 │
│  Import:        │                               │  SMB backup     │
│  • Team.mdb     │                               │  (.smb/gbin)    │
│  • .smb results │                               │       ↕         │
│  • .lxf meet    │                               │ Splash Meet Mgr │
│                 │                               └─────────────────┘
│  Backup:        │
│  • pg_dump      │
│  • Docker vol   │
└─────────────────┘
```
