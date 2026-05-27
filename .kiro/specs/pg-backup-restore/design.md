# Design: PostgreSQL Backup & Restore

## Overview

A backup/restore system with manual and automatic modes. Backups are plain SQL dumps (`pg_dump --clean`) stored in `/app/data/backups/`. A background scheduler runs daily backups with configurable retention.

## Architecture

```
Admin Page UI
  ├── Manual Backup (download button → GET /api/admin/backup-db)
  ├── Manual Restore (file upload → POST /api/admin/restore-db)
  ├── Auto-Backup Settings (interval + max count → PUT /api/admin/backup-config)
  └── Backup List (GET /api/admin/backups → list with download/delete)

Backend
  ├── /api/admin/backup-db         → pg_dump → stream download
  ├── /api/admin/restore-db        → upload .sql → psql restore
  ├── /api/admin/backup-config     → read/write bsglobal settings
  ├── /api/admin/backups           → list files in /app/data/backups/
  ├── /api/admin/backups/{name}    → download specific backup
  ├── DELETE /api/admin/backups/{name} → delete specific backup
  └── Background scheduler (asyncio task on startup)

Storage: /app/data/backups/
  ├── auto-2026-05-27-030000.sql
  ├── auto-2026-05-26-030000.sql
  └── ...
```

## API Endpoints

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/admin/backup-db` | Download fresh pg_dump | Admin |
| POST | `/api/admin/restore-db` | Upload + restore .sql | Admin |
| GET | `/api/admin/backup-config` | Get auto-backup settings | Admin |
| PUT | `/api/admin/backup-config` | Update auto-backup settings | Admin |
| GET | `/api/admin/backups` | List stored backups | Admin |
| GET | `/api/admin/backups/{filename}` | Download a stored backup | Admin |
| DELETE | `/api/admin/backups/{filename}` | Delete a stored backup | Admin |

## Backend Implementation

### Backup (`pg_dump`)

```python
BACKUP_DIR = Path("/app/data/backups")

def _run_pg_dump() -> bytes:
    """Run pg_dump and return SQL bytes."""
    result = subprocess.run(
        ["pg_dump", "--clean", "--if-exists", "-U", "meetmgr", "-h", "db", "meetmgr"],
        capture_output=True, timeout=60,
        env={**os.environ, "PGPASSWORD": "meetmgr"},
    )
    if result.returncode != 0:
        raise RuntimeError(f"pg_dump failed: {result.stderr.decode()}")
    return result.stdout
```

### Restore (`psql`)

```python
def _run_psql_restore(sql_bytes: bytes):
    """Restore from SQL dump."""
    result = subprocess.run(
        ["psql", "-U", "meetmgr", "-h", "db", "meetmgr"],
        input=sql_bytes, capture_output=True, timeout=120,
        env={**os.environ, "PGPASSWORD": "meetmgr"},
    )
    if result.returncode != 0:
        raise RuntimeError(f"psql restore failed: {result.stderr.decode()}")
```

### Auto-Backup Scheduler

```python
import asyncio
from datetime import datetime

_backup_task: asyncio.Task | None = None

async def _auto_backup_loop():
    """Background loop: run pg_dump on schedule, enforce retention."""
    while True:
        interval = int(_get_config_sync("backup_interval_days") or "1")
        max_count = int(_get_config_sync("backup_max_count") or "7")
        
        await asyncio.sleep(interval * 86400)  # sleep for N days
        
        # Create backup
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        filename = f"auto-{timestamp}.sql"
        sql = _run_pg_dump()
        (BACKUP_DIR / filename).write_bytes(sql)
        
        # Enforce retention
        backups = sorted(BACKUP_DIR.glob("auto-*.sql"), key=lambda p: p.stat().st_mtime)
        while len(backups) > max_count:
            backups.pop(0).unlink()
```

Started on app startup:
```python
@app.on_event("startup")
def startup():
    ...
    # Start auto-backup scheduler
    global _backup_task
    _backup_task = asyncio.create_task(_auto_backup_loop())
```

### bsglobal Settings

| Key | Default | Description |
|-----|---------|-------------|
| `backup_interval_days` | `1` | Days between auto-backups |
| `backup_max_count` | `7` | Max auto-backups to keep |

## Frontend (Admin Page)

### Backup/Restore Section

```jsx
<Section title="Database Backup">
  {/* Manual */}
  <button onClick={downloadBackup}>Download Backup</button>
  <input type="file" accept=".sql" onChange={restoreBackup} />
  
  {/* Auto-backup config */}
  <label>Auto-backup every <input type="number" value={interval} /> day(s)</label>
  <label>Keep last <input type="number" value={maxCount} /> backups</label>
  <button onClick={saveConfig}>Save</button>
  
  {/* Backup list */}
  <table>
    {backups.map(b => (
      <tr>
        <td>{b.filename}</td>
        <td>{b.size_mb} MB</td>
        <td>{b.date}</td>
        <td><button>Download</button> <button>Delete</button></td>
      </tr>
    ))}
  </table>
</Section>
```

## Storage

- Location: `/app/data/backups/` (Docker volume `appdata`)
- Naming: `auto-YYYY-MM-DD-HHMMSS.sql` for auto-backups
- Manual backups are streamed directly (not stored on server)
- Max file size for restore: 100MB

## Error Handling

- `pg_dump` failure: return 500 with stderr message
- `psql` restore failure: return 400 with stderr message (DB may be in inconsistent state — recommend re-restore from a known good backup)
- Scheduler failure: log error, continue loop (don't crash the app)
- Disk full: log error, skip backup creation

## Security

- All endpoints require admin PIN (`require_admin` dependency)
- Backup files contain full database contents (sensitive) — stored in Docker volume only
- No public access to backup files
