"""FastAPI application entry point."""
import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .database import engine, SessionLocal
from .models import Base, BsGlobal
from .models_team import TeamClub
from . import models_team  # noqa: F401 — register Team Manager tables with Base.metadata
from . import models_live  # noqa: F401 — register Live results tables with Base.metadata
from .events import load_events
from .routers.api import router
from .routers.live import router as live_router
from .routers.results import router as results_router
from .routers.push_notifications import router as push_router

app = FastAPI(title="Meet Manager", docs_url=None, redoc_url=None)

_cors_origin = os.environ.get("APP_BASE_URL", "http://localhost:8001")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[_cors_origin],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Audit log ---
_audit = logging.getLogger("audit")
_audit.setLevel(logging.INFO)
_audit_handler = logging.FileHandler("/app/data/audit.log")
_audit_handler.setFormatter(logging.Formatter("%(asctime)s  %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
_audit.addHandler(_audit_handler)
_audit.propagate = False


@app.middleware("http")
async def audit_middleware(request: Request, call_next):
    response = await call_next(request)
    if request.method in ("POST", "PUT", "DELETE"):
        ip = request.client.host if request.client else "?"
        path = request.url.path
        if path == "/api/auth":
            pass  # handled in the endpoint itself
        elif response.status_code < 400:
            pin = request.headers.get("X-Club-Pin", "")
            user = _identify_user(pin)
            _audit.info(f"[{user}] {request.method} {path}  (ip={ip})")
    return response


def _identify_user(pin: str) -> str:
    if not pin:
        return "anonymous"
    db = SessionLocal()
    try:
        admin_pin_cfg = db.query(BsGlobal).get("admin_pin")
        admin_pin = admin_pin_cfg.data if admin_pin_cfg else os.environ.get("ADMIN_PIN", "000000")
        if pin == admin_pin:
            return "admin"
        club = db.query(TeamClub).filter(TeamClub.pin == pin).first()
        if not club:
            return "unknown"
        org_cfg = db.query(BsGlobal).get("organizer_club_id")
        if org_cfg and org_cfg.data == str(club.clubsid):
            return f"organizer/{club.name}"
        return f"coach/{club.name}"
    finally:
        db.close()

app.include_router(router)
app.include_router(live_router)
app.include_router(results_router)
app.include_router(push_router)


@app.on_event("startup")
def startup():
    # Refuse to start with the default insecure SECRET_KEY
    if os.environ.get("SECRET_KEY", "change-me-to-a-random-string") == "change-me-to-a-random-string":
        raise RuntimeError("SECRET_KEY must be changed from the default value")

    Base.metadata.create_all(bind=engine)

    # Load events from stored meet .lxf if available and events table is empty
    meet_path = Path(os.environ.get("MEET_STORAGE", "/app/data/meet.lxf"))
    if meet_path.exists():
        db = SessionLocal()
        try:
            count = load_events(db, meet_path)
            if count:
                print(f"Loaded {count} events from {meet_path}")
        finally:
            db.close()

    # Start auto-backup scheduler
    import asyncio
    asyncio.ensure_future(_auto_backup_loop())


async def _auto_backup_loop():
    """Background loop: run pg_dump on schedule, enforce retention."""
    import asyncio
    import subprocess
    from urllib.parse import urlparse
    from .models import BsGlobal

    BACKUP_DIR = Path(os.environ.get("MEET_STORAGE", "/app/data/meet.lxf")).parent / "backups"

    # Wait 60s before first check (let app fully start)
    await asyncio.sleep(60)

    while True:
        try:
            db = SessionLocal()
            try:
                interval_cfg = db.query(BsGlobal).get("backup_interval_days")
                max_cfg = db.query(BsGlobal).get("backup_max_count")
                interval_days = int(interval_cfg.data) if interval_cfg and interval_cfg.data else 1
                max_count = int(max_cfg.data) if max_cfg and max_cfg.data else 7
            finally:
                db.close()

            if interval_days < 1:
                interval_days = 1

            # Check if a backup is needed (last backup older than interval)
            BACKUP_DIR.mkdir(parents=True, exist_ok=True)
            existing = sorted(BACKUP_DIR.glob("auto-*.sql"), key=lambda p: p.stat().st_mtime)
            needs_backup = True
            if existing:
                from datetime import datetime, timedelta
                last_time = datetime.fromtimestamp(existing[-1].stat().st_mtime)
                if datetime.now() - last_time < timedelta(days=interval_days):
                    needs_backup = False

            if needs_backup:
                # Run pg_dump
                db_url = os.environ.get("DATABASE_URL", "")
                parsed = urlparse(db_url)
                env = {**os.environ, "PGPASSWORD": parsed.password or ""}
                cmd = [
                    "pg_dump",
                    "-h", parsed.hostname or "db",
                    "-p", str(parsed.port or 5432),
                    "-U", parsed.username or "meetmgr",
                    "-d", parsed.path.lstrip("/") or "meetmgr",
                    "--no-owner", "--no-acl",
                ]
                result = subprocess.run(cmd, capture_output=True, env=env, timeout=60)
                if result.returncode == 0:
                    from datetime import datetime
                    timestamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
                    filename = f"auto-{timestamp}.sql"
                    (BACKUP_DIR / filename).write_bytes(result.stdout)
                    print(f"Auto-backup created: {filename} ({len(result.stdout)} bytes)")

                    # Enforce retention
                    backups = sorted(BACKUP_DIR.glob("auto-*.sql"), key=lambda p: p.stat().st_mtime)
                    while len(backups) > max_count:
                        removed = backups.pop(0)
                        removed.unlink()
                        print(f"Auto-backup removed (retention): {removed.name}")
                else:
                    print(f"Auto-backup pg_dump failed: {result.stderr.decode()[:200]}")

        except Exception as e:
            print(f"Auto-backup error: {e}")

        # Check every hour (the actual backup decision is based on file timestamps)
        await asyncio.sleep(3600)
