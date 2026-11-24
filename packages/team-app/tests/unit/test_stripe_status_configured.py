"""GET /stripe/status says whether Stripe is configured at all, so the Organizer
page can hide every Stripe button when the server has no STRIPE_API_KEY."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from app.models import Base
from app import models_team, models_live, models_serc  # noqa: F401 — register tables
from app.models_team import Meet as TeamMeet, TeamClub
from app.meet_config import _set_organizer_club_id
from app.routers import api


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 's.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    s.add(TeamMeet(meetsid=1, name="M", meetstate=0, registration_open=True))
    s.add(TeamClub(clubsid=10, name="Org", pin="111111", email="o@x.ca", stripe_account_id="acct_1"))
    s.commit()
    yield s
    s.close()


def test_not_configured_without_a_key(db, monkeypatch):
    monkeypatch.delenv("STRIPE_API_KEY", raising=False)
    assert api.stripe_connect_status(db) == {"configured": False, "connected": False}   # no organizer
    _set_organizer_club_id(db, 10, meetsid=1)
    db.commit()
    assert api.stripe_connect_status(db) == {"configured": False, "connected": False}   # account id but no key


def test_configured_with_a_key_even_when_not_connected(db, monkeypatch):
    monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")
    assert api.stripe_connect_status(db) == {"configured": True, "connected": False}    # no organizer yet
    db.get(TeamClub, 10).stripe_account_id = None
    _set_organizer_club_id(db, 10, meetsid=1)
    db.commit()
    assert api.stripe_connect_status(db) == {"configured": True, "connected": False}    # organizer, no account


def test_connected_reports_the_account(db, monkeypatch):
    import stripe
    monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")
    monkeypatch.setattr(stripe.Account, "retrieve", staticmethod(lambda acct: type("A", (), {"charges_enabled": True})()))
    _set_organizer_club_id(db, 10, meetsid=1)
    db.commit()
    assert api.stripe_connect_status(db) == {"configured": True, "connected": True, "account_id": "acct_1"}


def test_a_stripe_error_is_just_not_connected(db, monkeypatch):
    import stripe
    monkeypatch.setenv("STRIPE_API_KEY", "sk_test_x")

    def boom(acct):
        raise RuntimeError("down")
    monkeypatch.setattr(stripe.Account, "retrieve", staticmethod(boom))
    _set_organizer_club_id(db, 10, meetsid=1)
    db.commit()
    assert api.stripe_connect_status(db) == {"configured": True, "connected": False}
