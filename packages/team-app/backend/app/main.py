"""FastAPI application entry point."""
import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .database import engine, SessionLocal
from .models import Base, Club, BsGlobal
from .events import load_events
from .routers.api import router

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
        club = db.query(Club).filter(Club.pin == pin).first()
        if not club:
            return "unknown"
        org_cfg = db.query(BsGlobal).get("organizer_club_id")
        if org_cfg and org_cfg.data == str(club.clubid):
            return f"organizer/{club.name}"
        return f"coach/{club.name}"
    finally:
        db.close()

app.include_router(router)


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
