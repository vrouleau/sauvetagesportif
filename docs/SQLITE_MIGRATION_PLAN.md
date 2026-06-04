# SQLite Migration Plan — Team App Backend

## Goal

Replace PostgreSQL with SQLite for the team-app backend to simplify deployment (single container, no DB service). This eliminates the need for managed Postgres in cloud deployments (Fly.io, etc.).

## Current State

- `database.py` already defaults to `sqlite:///./meetmgr.db` — Postgres is only used when `DATABASE_URL` env var is set
- SQLAlchemy ORM abstracts most queries — they work on both dialects
- The meet-app (Electron) already uses SQLite successfully with the same data model

## Impact Assessment

### ✅ No changes needed (works as-is)

- All SQLAlchemy ORM queries (`.query()`, `.filter()`, `.get()`, `.add()`, `.delete()`)
- All model definitions (Column types map cleanly: Integer, String, SmallInteger, DateTime, Text)
- The relay team CRUD endpoints
- Registration endpoints
- Athletes/clubs CRUD
- LXF import/export
- Meet template creation

### ⚠️ Requires adaptation (3 areas)

#### 1. Postgres-specific `pg_insert` with `on_conflict_do_update` (live.py)

**File**: `app/routers/live.py`  
**Lines**: Uses `from sqlalchemy.dialects.postgresql import pg_insert` for upsert operations on `LiveResult`, `LiveEvent`, `LiveStartlist`.

**Fix**: Replace with SQLAlchemy's dialect-agnostic approach:
```python
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

stmt = sqlite_insert(LiveResult).values(...).on_conflict_do_update(...)
```
Or use a try/except pattern:
```python
existing = db.query(LiveResult).filter_by(event_id=..., heat_number=..., lane=...).first()
if existing:
    for k, v in updates.items():
        setattr(existing, k, v)
else:
    db.add(LiveResult(...))
```

**Recommended approach**: Since SQLite 3.24+ supports `INSERT ... ON CONFLICT`, use SQLAlchemy's SQLite dialect insert which supports `on_conflict_do_update`.

#### 2. Postgres sequence resets (`setval`)

**Files**: `app/seed.py` (line 213), `app/routers/api.py` (line 839)  
**Code**: `db.execute(text("SELECT setval('clubs_clubsid_seq', ...)"))`

**Fix**: Already partially handled — `seed.py` line 212 checks `if dialect == "postgresql"`. The `api.py` occurrence needs the same guard:
```python
if db.bind and db.bind.dialect.name == "postgresql":
    db.execute(text("SELECT setval(...)"))
```
SQLite uses ROWID/autoincrement — no sequence reset needed.

#### 3. Backup/restore endpoints (`pg_dump` / `psql`)

**File**: `app/routers/api.py` (lines ~2488-2625), `app/main.py` (auto-backup loop)  
**Endpoints**: `GET /admin/backup-db`, `POST /admin/restore-db`, `POST /admin/backups/create`

**Fix**: Replace `pg_dump` with SQLite file copy:
```python
import shutil

def _create_backup():
    db_path = Path(DATABASE_PATH)
    timestamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    backup_path = BACKUP_DIR / f"manual-{timestamp}.db"
    shutil.copy2(db_path, backup_path)
    return backup_path

def _restore_backup(backup_file: bytes):
    # Write uploaded file to a temp location, then replace DB
    # Need to close all DB connections first
    ...
```

**Alternative**: Use SQLite's `.backup()` API for hot backups (no need to close connections).

### 🔄 Nice-to-have improvements

#### 4. WAL mode for better concurrent reads

```python
engine = create_engine("sqlite:///./meetmgr.db")

@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()
```

WAL (Write-Ahead Logging) allows concurrent reads while a write is in progress — perfectly suitable for your use case.

#### 5. `check_same_thread=False` for FastAPI async

```python
engine = create_engine(
    "sqlite:///./meetmgr.db",
    connect_args={"check_same_thread": False}
)
```

Required because FastAPI may call DB from different threads.

---

## Migration Steps (Implementation Order)

### Phase 1: Make the code SQLite-compatible (no behavior change in Postgres)

- [ ] **Task 1**: Guard `setval` calls with dialect check in `api.py` (already done in `seed.py`)
- [ ] **Task 2**: Replace `pg_insert` in `live.py` with dialect-agnostic upsert
- [ ] **Task 3**: Add SQLite pragmas (WAL, busy_timeout, check_same_thread) to `database.py`
- [ ] **Task 4**: Add SQLite backup/restore alternatives alongside pg_dump (detect dialect)

### Phase 2: Schema initialization for SQLite

- [ ] **Task 5**: Add `Base.metadata.create_all(engine)` for auto-creating tables on first run (SQLite has no migrations — schema is created from models)
- [ ] **Task 6**: Verify all model column types work in SQLite (DateTime, Boolean stored as TEXT/INTEGER — fine with SQLAlchemy)

### Phase 3: Testing

- [ ] **Task 7**: Run full integration test suite with `DATABASE_URL` unset (defaults to SQLite)
- [ ] **Task 8**: Test LXF import, registration, relay team CRUD, export — all on SQLite

### Phase 4: Deployment

- [ ] **Task 9**: Update Dockerfile to remove `postgresql-client` dependency (optional — keep for backward compat)
- [ ] **Task 10**: Update `docker-compose.prod.yml` to offer a SQLite variant (no `db` service)
- [ ] **Task 11**: Create `fly.toml` for single-container deployment
- [ ] **Task 12**: Add persistent volume mount for `/app/data` (holds SQLite DB + LXF files)

---

## Data Migration (existing Postgres → SQLite)

For the one-time migration of existing production data:

```bash
# On the current mini-PC with Postgres running:
pg_dump -U meetmgr -d meetmgr --data-only --inserts > data_dump.sql

# Clean up Postgres-specific syntax:
# - Remove SET statements
# - Remove sequence-related lines
# - Convert boolean 'true'/'false' to 1/0 if needed

# Import into SQLite:
sqlite3 meetmgr.db < schema.sql  # (generated from SQLAlchemy models)
sqlite3 meetmgr.db < data_dump_cleaned.sql
```

Or use a Python script that reads from Postgres and writes to SQLite via SQLAlchemy (cleaner, handles type coercion automatically).

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Concurrent write contention | Low (5-20 coaches, bursty during registration) | WAL mode + busy_timeout |
| Data corruption on crash | Very low (SQLite is ACID, WAL mode is crash-safe) | Periodic file backups |
| Performance regression | None expected (SQLite is faster for read-heavy workloads) | — |
| Feature incompatibility | Already assessed above (3 areas) | Phase 1 tasks |

---

## Decision

SQLite is the right choice for this app because:
1. Single-user-ish workload (one meet at a time, few concurrent coaches)
2. Eliminates an entire service from the deployment
3. File-based backups (simpler than pg_dump orchestration)
4. The meet-app already proves the data model works in SQLite
5. Free cloud deployment becomes trivial (one container + one volume)
