"""Unit tests for routers/api._invoice_email_parties — who an emailed invoice
pays, names as contact, replies to, and sends its batch summary to, for every
caller role × organizer × SUPPORT_EMAIL combination. In-memory SQLite, same
direct-call pattern as test_meet_creation_wipe_scope.py.

The integration suite runs with SUPPORT_EMAIL set (fake Resend stack), so the
"not configured" rows are only reachable here.

Run: `pytest tests/unit/test_invoice_parties.py -v`
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base  # noqa: E402
from app.models_team import Meet as TeamMeet, TeamClub  # noqa: E402
from app.meet_config import _set_organizer_club_id  # noqa: E402
from app.routers import api  # noqa: E402

SUPPORT = "support@x.ca"
ORG_EMAIL = "org@x.ca"


class _Req:
    def __init__(self, pin: str):
        self.headers = {"X-Club-Pin": pin}


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    s = sessionmaker(bind=engine)()
    s.add(TeamMeet(meetsid=1, name="M", meetstate=0, registration_open=True))
    s.add(TeamClub(clubsid=10, name="Org Club", pin="111111", email=ORG_EMAIL))
    s.add(TeamClub(clubsid=20, name="Other", pin="222222", email="o@x.ca"))
    s.commit()
    yield s
    s.close()
    engine.dispose()


def _admin(db):
    return _Req(api._get_admin_pin(db))


def _parties(db, req, support, monkeypatch):
    if support:
        monkeypatch.setenv("SUPPORT_EMAIL", support)
    else:
        monkeypatch.delenv("SUPPORT_EMAIL", raising=False)
    return api._invoice_email_parties(req, db, 1)


def test_organizer_sends(db, monkeypatch):
    _set_organizer_club_id(db, 10, meetsid=1)
    p = _parties(db, _Req("111111"), SUPPORT, monkeypatch)
    assert (p["pay_to"], p["support_contact"], p["reply_to"], p["summary_to"], p["org_name"]) == \
        (ORG_EMAIL, "", ORG_EMAIL, ORG_EMAIL, "Org Club")


def test_admin_sends_with_organizer(db, monkeypatch):
    _set_organizer_club_id(db, 10, meetsid=1)
    p = _parties(db, _admin(db), SUPPORT, monkeypatch)
    assert (p["pay_to"], p["support_contact"], p["reply_to"], p["summary_to"]) == \
        (ORG_EMAIL, SUPPORT, SUPPORT, SUPPORT)


def test_admin_sends_with_organizer_no_support_falls_back(db, monkeypatch):
    _set_organizer_club_id(db, 10, meetsid=1)
    p = _parties(db, _admin(db), "", monkeypatch)
    assert (p["pay_to"], p["support_contact"], p["reply_to"], p["summary_to"]) == \
        (ORG_EMAIL, "", ORG_EMAIL, ORG_EMAIL)


def test_no_organizer_admin_is_organizer(db, monkeypatch):
    p = _parties(db, _admin(db), SUPPORT, monkeypatch)
    assert p["org_club"] is None and p["org_name"] == ""
    assert (p["pay_to"], p["support_contact"], p["reply_to"], p["summary_to"]) == \
        (SUPPORT, SUPPORT, SUPPORT, SUPPORT)


def test_no_organizer_no_support_has_no_recipient(db, monkeypatch):
    """The send endpoint turns this into a 400 before anything is sent."""
    p = _parties(db, _admin(db), "", monkeypatch)
    assert p["pay_to"] == "" and p["summary_to"] == ""


def test_organizer_without_email_has_no_recipient(db, monkeypatch):
    db.get(TeamClub, 10).email = ""
    db.commit()
    _set_organizer_club_id(db, 10, meetsid=1)
    p = _parties(db, _Req("111111"), SUPPORT, monkeypatch)
    assert p["pay_to"] == "" and p["org_club"] is not None
