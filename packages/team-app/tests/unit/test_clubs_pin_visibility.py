"""GET /clubs: only the admin may read club PINs.

A PIN identifies a club completely (role and club), so an organizer who could
read the other clubs' PINs could log in as any of them.
"""
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


class _Req:
    def __init__(self, pin: str):
        self.headers = {"X-Club-Pin": pin}
        self.query_params = {}


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'pins.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    s.add(TeamMeet(meetsid=1, name="M", meetstate=0, registration_open=True))
    s.add(TeamClub(clubsid=10, name="Organizer club", pin="111111", email="org@x.ca"))
    s.add(TeamClub(clubsid=20, name="Other club", pin="222222", email="other@x.ca"))
    s.commit()
    _set_organizer_club_id(s, 10, meetsid=1)
    s.commit()
    yield s
    s.close()


def _admin_pin(db) -> str:
    return api._get_admin_pin(db)


def test_admin_sees_every_pin(db):
    out = api.list_clubs(_Req(_admin_pin(db)), db)
    assert {c["id"]: c["pin"] for c in out} == {10: "111111", 20: "222222"}


def test_organizer_sees_emails_but_no_pin(db):
    assert api._resolve_role("111111", db)[0] == "organizer"
    out = api.list_clubs(_Req("111111"), db)
    assert all("pin" not in c for c in out)
    assert {c["id"]: c["email"] for c in out} == {10: "org@x.ca", 20: "other@x.ca"}


def test_coach_sees_neither(db):
    assert api._resolve_role("222222", db)[0] == "coach"
    out = api.list_clubs(_Req("222222"), db)
    assert all("pin" not in c and "email" not in c for c in out)
