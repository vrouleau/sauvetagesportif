"""Database connection."""
import os
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

_default_db_path = os.environ.get("SQLITE_DB_PATH", "/app/data/meetmgr.db")
DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{_default_db_path}")

_connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    _connect_args["check_same_thread"] = False

engine = create_engine(DATABASE_URL, connect_args=_connect_args)

# SQLite performance pragmas (WAL mode for concurrent reads, busy timeout for write queuing)
if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

SessionLocal = sessionmaker(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def is_sqlite() -> bool:
    """Return True if the current database is SQLite."""
    return DATABASE_URL.startswith("sqlite")
