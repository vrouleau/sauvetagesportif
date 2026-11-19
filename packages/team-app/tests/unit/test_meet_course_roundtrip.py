# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
#
# This file is part of Sauvetage Sportif.
#
# Sauvetage Sportif is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Sauvetage Sportif is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with Sauvetage Sportif. If not, see <https://www.gnu.org/licenses/>.
"""The meet's course (pool length) survives the whole meet cycle.

Found testing the relay-history loop: a results import closed the meet and
the next-meet stub it created (_reload_pool_template) had no `meet_course`,
so GET /api/relay-teams asked for relay best times with course=None and got
none — no suggested entry time, though the team's 2:00.00 was archived.

- Every meet created from a template (new meet, reset, the stub after a
  results import or a delete) gets the same meet config, course included.
- The course is stored in meet_config, meets.course and MEETVALUES together.
- A meet with no stored course reads as LCM everywhere (relay endpoint too).
- New sessions take the meet's course.
- Both LXF exports carry the meet header meet-app imports: city, course,
  deadline and lanes (#110).

Uses an in-memory SQLite database — no Docker required.
"""
from __future__ import annotations

import sys
import zipfile
from datetime import datetime
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import (  # noqa: E402
    Base, BsGlobal, MeetConfig, SwimEvent, SwimSession, SwimStyle, GENDER_F, GENDER_M, GENDER_MIXED,
)
from app.models_team import Meet, Member, Relay, RelayPos, TeamClub  # noqa: E402
from app.routers import api  # noqa: E402
from app.meet_config import (  # noqa: E402
    get_active_meetsid, _get_meet_config, _get_meet_course, _set_meet_config, _set_closure_date,
)
from app.lxf_to_team import import_lxf_as_meet  # noqa: E402
from app.meet_parser import parse_meet_lxf  # noqa: E402
from app.export import generate_lxf, generate_meet_lxf_from_db  # noqa: E402

_REPO_ROOT = Path(__file__).parent.parent.parent.parent.parent
_TEMPLATE_POOL = _REPO_ROOT / "config" / "template_pool.lxf"
_TEMPLATE_BEACH = _REPO_ROOT / "config" / "template_beach.lxf"
_TEMPLATE_COURSE = parse_meet_lxf(_TEMPLATE_POOL).course  # "SCM" today
_INT = {"LCM": 1, "SCY": 2, "SCM": 3}
_COACH_PIN = "111111"
_RELAY_STYLE = 527  # 4x50m Relais Sauvetage Combiné (distance 50: not course-free)


class _Req:
    def __init__(self, pin: str = "", meet_id: int | None = None):
        self.headers = {"X-Club-Pin": pin}
        if meet_id is not None:
            self.headers["X-Meet-Id"] = str(meet_id)


@pytest.fixture()
def db(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    monkeypatch.setattr(api, "MEET_STORAGE", tmp_path / "meet.lxf")
    monkeypatch.setenv("MEET_TEMPLATE_POOL", str(_TEMPLATE_POOL))
    monkeypatch.setenv("MEET_TEMPLATE_BEACH", str(_TEMPLATE_BEACH))
    yield session
    session.close()
    engine.dispose()


def _seed_open_meet(db):
    """Open meet 1 (LCM) with one club and four members (2M + 2F)."""
    db.add(BsGlobal(name="age_base_date", data="2026-12-31"))
    db.add(Meet(meetsid=1, name="Fall Meet", course=1, registration_open=True))
    db.add(TeamClub(clubsid=1, name="Club Un", code="UN", nation="CAN", pin=_COACH_PIN))
    db.add(SwimStyle(swimstyleid=_RELAY_STYLE, distance=50, stroke=1, relaycount=4,
                     name="4x50m Relais Sauvetage Combiné"))
    for i, g in enumerate([GENDER_M, GENDER_F, GENDER_M, GENDER_F], start=1):
        db.add(Member(membersid=i, firstname=f"F{i}", lastname=f"L{i}", gender=g,
                      birthdate=datetime(2000, 1, i), clubsid=1, license=f"LIC{i}"))
    db.commit()
    _set_meet_config(db, 1, "meet_course", "LCM")
    db.commit()


def _results_lxf(course: str = "LCM") -> bytes:
    """meet-app results export: one Mixed relay team, 2:00.00."""
    athletes = "".join(
        f'<ATHLETE athleteid="90{i}" firstname="F{i}" lastname="L{i}" gender="{"M" if i % 2 else "F"}" '
        f'birthdate="2000-01-0{i}" license="LIC{i}"><RESULTS/></ATHLETE>'
        for i in range(1, 5)
    )
    pos = "".join(f'<RELAYPOSITION number="{n}" athleteid="90{n}"/>' for n in range(1, 5))
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0"><MEETS><MEET name="Fall Meet" city="X" course="{course}">
  <SESSIONS><SESSION number="1" date="2026-10-01"><EVENTS>
    <EVENT eventid="100" number="2" gender="MIXED"><SWIMSTYLE swimstyleid="{_RELAY_STYLE}" distance="50" relaycount="4" name="Relais"/></EVENT>
  </EVENTS></SESSION></SESSIONS>
  <CLUBS><CLUB code="UN" name="Club Un" nation="CAN"><ATHLETES>{athletes}</ATHLETES>
    <RELAYS><RELAY number="1" gender="MIXED"><RELAYPOSITIONS>{pos}</RELAYPOSITIONS>
      <RESULTS><RESULT eventid="100" resultid="71" swimtime="00:02:00.00"><RELAYPOSITIONS>{pos}</RELAYPOSITIONS></RESULT></RESULTS>
    </RELAY></RELAYS>
  </CLUB></CLUBS>
</MEET></MEETS></LENEX>"""
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("results.lef", xml)
    return buf.getvalue()


def _close_meet_with_results(db) -> int:
    """What POST /api/import-results-lxf does: archive, then reset for the next meet."""
    import_lxf_as_meet(db, _results_lxf(), force=True)
    api._reset_for_next_meet(db, 1)
    db.commit()
    stub = get_active_meetsid(db)
    assert stub is not None and stub != 1
    return stub


def _add_relay_team(db, meetsid: int) -> None:
    """The organizer builds a Mixed relay event; the coach enters the same four."""
    db.add(SwimSession(swimsessionid=900, meetsid=meetsid, name="S1", sessionnumber=1, course=1))
    db.add(SwimEvent(swimeventid=901, meetsid=meetsid, swimsessionid=900, swimstyleid=_RELAY_STYLE,
                     gender=GENDER_MIXED, round=5, eventnumber=1))
    db.flush()
    relay = Relay(meetsid=meetsid, clubsid=1, teamnumb=1, stylesid=_RELAY_STYLE, gender=GENDER_MIXED,
                  eventnumb=1)
    db.add(relay)
    db.flush()
    for n in range(1, 5):
        db.add(RelayPos(relaysid=relay.relaysid, numb=n, membersid=n))
    db.commit()


def _relay_best_times(db, meetsid: int) -> list:
    data = api.get_relay_teams(_Req(_COACH_PIN, meetsid), club_id=None, db=db)
    found: list = []

    def walk(node):
        if isinstance(node, dict):
            if "relayBestTimeMs" in node:
                found.append(node["relayBestTimeMs"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(data)
    return found


def _mv(db, meetsid: int) -> str:
    return _get_meet_config(db, meetsid, "MEETVALUES") or ""


# ── The meet created after a results import ─────────────────────────────────

class TestNextMeetAfterResultsImport:
    def test_next_meet_gets_a_course_everywhere(self, db):
        _seed_open_meet(db)
        stub = _close_meet_with_results(db)
        assert _get_meet_config(db, stub, "meet_course") == _TEMPLATE_COURSE
        assert db.get(Meet, stub).course == _INT[_TEMPLATE_COURSE]
        assert f"COURSE=I;{_INT[_TEMPLATE_COURSE]}" in _mv(db, stub)

    def test_next_meet_gets_the_same_config_as_a_new_meet(self, db):
        _seed_open_meet(db)
        stub = _close_meet_with_results(db)
        for key in ("meet_filename", "meet_uploaded_at", "meet_name", "meet_masters",
                    "meet_currency", "meet_fees_json"):
            assert _get_meet_config(db, stub, key) is not None, key
        assert "AGEDATE=D;" in _mv(db, stub)
        assert "COMBINEAGEGROUPS=B;T" in _mv(db, stub)
        assert db.get(Meet, stub).meet_type == "POOL"

    def test_relay_suggestion_in_the_next_meet(self, db):
        """The reported bug: CSRN team A had swum 2:00.00 (LCM); the next meet,
        set to 50 m by the organizer, must suggest it."""
        _seed_open_meet(db)
        stub = _close_meet_with_results(db)
        api.set_meet_config({"COURSE": {"type": "I", "value": "1"}}, request=_Req(meet_id=stub), db=db)
        db.commit()
        _add_relay_team(db, stub)
        assert _relay_best_times(db, stub) == [120000] * 4

    def test_other_course_does_not_suggest_it(self, db):
        _seed_open_meet(db)
        stub = _close_meet_with_results(db)
        api.set_meet_config({"COURSE": {"type": "I", "value": "3"}}, request=_Req(meet_id=stub), db=db)
        db.commit()
        _add_relay_team(db, stub)
        assert _relay_best_times(db, stub) == [None] * 4

    def test_meet_without_a_stored_course_reads_as_lcm(self, db):
        """A stub created before this fix has no meet_course at all."""
        _seed_open_meet(db)
        stub = _close_meet_with_results(db)
        db.query(MeetConfig).filter(MeetConfig.meetsid == stub, MeetConfig.name == "meet_course").delete()
        db.commit()
        assert _get_meet_course(db, stub) == "LCM"
        _add_relay_team(db, stub)
        assert _relay_best_times(db, stub) == [120000] * 4

    def test_stub_after_deleting_the_last_open_meet_gets_a_course(self, db):
        _seed_open_meet(db)
        api._flush_meet_data(db, 1)
        db.commit()
        stub = get_active_meetsid(db)
        assert stub is not None
        assert _get_meet_config(db, stub, "meet_course") == _TEMPLATE_COURSE


# ── One course, three places ────────────────────────────────────────────────

class TestCourseStorage:
    def test_new_meet_and_reset_store_the_course(self, db):
        out = api.create_new_meet({"meet_type": "pool"}, db=db)
        mid = out["meet_id"]
        assert _get_meet_config(db, mid, "meet_course") == _TEMPLATE_COURSE
        assert db.get(Meet, mid).course == _INT[_TEMPLATE_COURSE]
        api.reset_meet(_Req(meet_id=mid), {"meet_type": "pool"}, db=db)
        assert _get_meet_config(db, mid, "meet_course") == _TEMPLATE_COURSE
        assert f"COURSE=I;{_INT[_TEMPLATE_COURSE]}" in _mv(db, mid)

    def test_meet_editor_course_updates_all_three(self, db):
        mid = api.create_new_meet({"meet_type": "pool"}, db=db)["meet_id"]
        api.set_meet_config({"COURSE": {"type": "I", "value": "1"}}, request=_Req(meet_id=mid), db=db)
        db.commit()
        assert _get_meet_config(db, mid, "meet_course") == "LCM"
        assert db.get(Meet, mid).course == 1
        assert "COURSE=I;1" in _mv(db, mid)
        assert api.get_meet_config(_Req(meet_id=mid), db=db)["COURSE"] == "1"

    def test_new_session_takes_the_meet_course(self, db):
        mid = api.create_new_meet({"meet_type": "pool"}, db=db)["meet_id"]
        api.set_meet_config({"COURSE": {"type": "I", "value": "3"}}, request=_Req(meet_id=mid), db=db)
        db.commit()
        api.create_session(_Req(meet_id=mid), {"name": "S1", "number": 1}, db=db)
        ses = db.query(SwimSession).filter(SwimSession.meetsid == mid).one()
        assert ses.course == 3
        listed = api.list_sessions(_Req(meet_id=mid), db=db)
        listed = listed["sessions"] if isinstance(listed, dict) else listed
        assert listed[0]["course"] == 3
        assert listed[0]["poolSize"] == 25

    def test_session_without_course_shows_50m(self, db):
        """It used to show 25 m (`50 if course == 1 else 25`)."""
        mid = api.create_new_meet({"meet_type": "pool"}, db=db)["meet_id"]
        db.add(SwimSession(swimsessionid=950, meetsid=mid, name="S1", sessionnumber=1, course=None))
        db.commit()
        listed = api.list_sessions(_Req(meet_id=mid), db=db)
        listed = listed["sessions"] if isinstance(listed, dict) else listed
        assert listed[0]["poolSize"] == 50


# ── Meet header in the LXF exports (#110) ───────────────────────────────────

def _meet_el(lxf: bytes) -> ET.Element:
    with zipfile.ZipFile(BytesIO(lxf)) as z:
        name = next(n for n in z.namelist() if n.endswith(".lef"))
        root = ET.fromstring(z.read(name))
    return root.find("MEETS/MEET")


class TestExportMeetHeader:
    def _meet(self, db) -> int:
        mid = api.create_new_meet({"meet_type": "pool"}, db=db)["meet_id"]
        api.set_meet_config({
            "COURSE": {"type": "I", "value": "1"},
            "CITY": {"type": "S", "value": "Laval"},
            "NATION": {"type": "S", "value": "CAN"},
            "LANEMIN": {"type": "I", "value": "1"},
            "LANEMAX": {"type": "I", "value": "8"},
        }, request=_Req(meet_id=mid), db=db)
        _set_closure_date(db, "2027-03-15", meetsid=mid)
        db.add(SwimSession(swimsessionid=960, meetsid=mid, name="S1", sessionnumber=1, course=1,
                           startdate=datetime(2027, 4, 1)))
        db.commit()
        return mid

    @pytest.mark.parametrize("export", [generate_lxf, generate_meet_lxf_from_db])
    def test_meet_header(self, db, export):
        mid = self._meet(db)
        meet = _meet_el(export(db, mid))
        assert meet.get("course") == "LCM"
        assert meet.get("city") == "Laval"
        assert meet.get("nation") == "CAN"
        assert meet.get("deadline") == "2027-03-15"
        pool = meet.find("POOL")
        assert pool is not None and pool.get("lanemin") == "1" and pool.get("lanemax") == "8"
        assert meet.find("SESSIONS/SESSION").get("course") == "LCM"

    _EDITOR = {
        "NAMEEN": ("S", "Meet EN"), "CITYEN": ("S", "Montreal"), "STATE": ("S", "Québec"),
        "MEETNUMBER": ("I", "12"), "MEETTYPE": ("S", "PROVINCIAL"), "MASTERS": ("B", "F"),
        "RESERVECOUNT": ("I", "2"), "STARTMETHOD": ("S", "1"), "TIMING": ("I", "2"), "TOUCHPADMODE": ("I", "1"),
        "ORGANIZER": ("S", "CSRN"), "ORGANIZERURL": ("S", "https://o.example"), "HOSTCLUB": ("S", "Club Hôte"),
        "RESULTURL": ("S", "https://r.example"),
        "FACILITYNAME": ("S", "Centre sportif du Parc Olympique"), "FACILITYSTREET": ("S", "3200 rue Viau"),
        "QUALIFROM": ("S", "2025-09-01"), "QUALITO": ("S", "2026-04-01"),
        "CONTACTNAME": ("S", "Nathalie"), "CONTACTEMAIL": ("S", "n@example.ca"), "CONTACTINTERNET": ("S", "https://c.example"),
        "FEECLUB": ("F", "25"), "FEEPERSON": ("F", "12.5"), "FEERELAY": ("F", "20"),
        "SEEDMETHOD": ("I", "1"), "COMBINEAGEGROUPS": ("B", "F"), "MINPERHEAT": ("I", "3"),
    }

    def _full_meet(self, db) -> int:
        mid = self._meet(db)
        api.set_meet_config({k: {"type": t, "value": v} for k, (t, v) in self._EDITOR.items()},
                            request=_Req(meet_id=mid), db=db)
        db.commit()
        return mid

    @pytest.mark.parametrize("export", [generate_lxf, generate_meet_lxf_from_db])
    def test_header_is_standard_lenex_like_splash(self, db, export):
        """The places a real Splash export uses (tests/fixtures/meet_template.lxf)."""
        meet = _meet_el(export(db, self._full_meet(db)))
        assert meet.get("name.en") == "Meet EN" and meet.get("city.en") == "Montreal"
        assert meet.get("state") == "Québec" and meet.get("number") == "12" and meet.get("type") == "PROVINCIAL"
        assert meet.get("timing") == "AUTOMATIC" and meet.get("touchpad") == "ONESIDE"
        assert meet.get("reservecount") == "2" and meet.get("startmethod") == "1"
        assert meet.get("organizer.url") == "https://o.example" and meet.get("hostclub") == "Club Hôte"
        assert meet.get("result.url") == "https://r.example"
        fac = meet.find("FACILITY")
        assert fac.get("name") == "Centre sportif du Parc Olympique" and fac.get("street") == "3200 rue Viau"
        assert fac.get("city") == "Laval" and fac.get("state") == "Québec"
        assert meet.find("POOL").get("name") == "Centre sportif du Parc Olympique"
        assert meet.find("QUALIFY").attrib == {"from": "2025-09-01", "until": "2026-04-01"}
        assert meet.find("CONTACT").get("email") == "n@example.ca"
        fees = {f.get("type"): (f.get("value"), f.get("currency")) for f in meet.iterfind("FEES/FEE")}
        assert fees == {"CLUB": ("2500", "CAD"), "ATHLETE": ("1250", "CAD"), "RELAY": ("2000", "CAD")}
        # MEET children in Splash's order, before SESSIONS
        assert [c.tag for c in meet][:7] == ["AGEDATE", "POOL", "FACILITY", "QUALIFY", "CONTACT", "FEES", "SESSIONS"]

    @pytest.mark.parametrize("export", [generate_lxf, generate_meet_lxf_from_db])
    def test_dotfile_carries_only_the_heat_settings(self, db, export):
        import json
        with zipfile.ZipFile(BytesIO(export(db, self._full_meet(db)))) as z:
            mv = json.loads(z.read(".meetvalues"))
        assert mv == {"SEEDMETHOD": "I;1", "COMBINEAGEGROUPS": "B;F", "MINPERHEAT": "I;3"}

    def test_round_trip_through_a_structure_upload(self, db):
        """Export a meet, upload it as another meet's structure: every editor field comes back."""
        from app.lenex_meet_fields import parse_typed_meetvalues
        src = self._full_meet(db)
        lxf = generate_meet_lxf_from_db(db, src)
        dst = api.create_new_meet({"meet_type": "pool", "close_other_meets": False}, db=db)["meet_id"]
        api._replace_current_meet_structure(db, parse_meet_lxf(lxf), lxf, "rt.lxf", target_meetsid=dst)
        db.commit()
        mv = parse_typed_meetvalues(_get_meet_config(db, dst, "MEETVALUES"))
        for key, (t, v) in self._EDITOR.items():
            assert mv.get(key) == f"{t};{v}", key
        assert mv["CITY"] == "S;Laval" and mv["LANEMAX"] == "I;8"
        assert _get_meet_config(db, dst, "closure_date") == "2027-03-15"
        assert _get_meet_course(db, dst) == "LCM"


class TestSplashFile:
    """A real Splash Meet Manager export (tests/fixtures/meet_template.lxf)."""

    def test_parser_reads_every_field_splash_writes(self):
        mv = parse_meet_lxf(Path(__file__).parent.parent / "fixtures" / "meet_template.lxf").meetvalues
        assert mv["CITY"] == "S;Gatineau"
        assert mv["NAMEEN"] == "S;CQS 2026 (pool) - Lifesaving - CSSG"
        assert mv["COURSE"] == "I;3"
        assert mv["DEADLINE"] == "D;20260410000000000"
        assert mv["HOSTCLUB"] == "S;Club de sauvetage sportif de Gatineau"
        assert mv["ORGANIZERURL"] == "S;https://cssgatineau.ca/accueil"
        assert mv["RESERVECOUNT"] == "I;2" and mv["STARTMETHOD"] == "S;1"
        assert mv["TIMING"] == "I;2" and mv["TOUCHPADMODE"] == "I;1"
        assert mv["STATE"] == "S;QC" and mv["NATION"] == "S;CAN" and mv["MASTERS"] == "B;F"
        assert mv["FACILITYNAME"] == "S;Centre sportif de Gatineau"
        assert mv["FACILITYSTREET"] == "S;850, boul. de La Gappe"
        assert mv["LANEMIN"] == "I;1" and mv["LANEMAX"] == "I;8"
        assert mv["QUALIFROM"] == "S;2024-09-01" and mv["QUALITO"] == "S;2026-04-01"
        assert mv["CONTACTNAME"] == "S;Nathalie Plante" and mv["CONTACTEMAIL"] == "S;fp107@ncf.ca"

    def test_no_lanes_no_deadline_no_pool(self, db):
        mid = api.create_new_meet({"meet_type": "pool"}, db=db)["meet_id"]
        meet = _meet_el(generate_meet_lxf_from_db(db, mid))
        assert meet.find("POOL") is None
        assert meet.get("deadline") is None
        assert meet.get("course") == _TEMPLATE_COURSE


# ── Fixing the pool length late ─────────────────────────────────────────────

class TestCourseChangedLate:
    """The organizer builds the next meet (25 m, the template's default), coaches
    enter relay teams — their entry times filled from 25 m relay history — then
    the organizer notices the meet is really 50 m and fixes it in the meet editor."""

    def _scenario(self, db, entry_time):
        _seed_open_meet(db)
        stub = _close_meet_with_results(db)  # archives 2:00.00 in 50 m
        # Older 25 m history for the same four: 2:09.26
        db.add(Meet(meetsid=50, name="Old 25 m meet", course=3, meetstate=3, mindate=datetime.now()))
        old = Relay(meetsid=50, clubsid=1, teamnumb=1, stylesid=_RELAY_STYLE, course=3, totaltime=129260,
                    resulttyp=0, eventdate=datetime.now())
        db.add(old)
        db.flush()
        for n in range(1, 5):
            db.add(RelayPos(relaysid=old.relaysid, numb=n, membersid=n))
        db.commit()
        assert _get_meet_course(db, stub) == "SCM"
        _add_relay_team(db, stub)
        db.query(SwimSession).filter(SwimSession.meetsid == stub).update({SwimSession.course: 3})
        team = db.query(Relay).filter(Relay.meetsid == stub).one()
        team.entrytime = entry_time
        db.commit()
        api.set_meet_config({"COURSE": {"type": "I", "value": "1"}}, request=_Req(meet_id=stub), db=db)
        db.commit()
        db.refresh(team)
        return stub, team

    def test_suggested_entry_time_follows_the_course(self, db):
        stub, team = self._scenario(db, entry_time=129260)  # the 25 m suggestion
        assert team.entrytime == 120000
        assert _relay_best_times(db, stub) == [120000] * 4

    def test_empty_entry_time_gets_the_new_suggestion(self, db):
        _, team = self._scenario(db, entry_time=None)
        assert team.entrytime == 120000

    def test_typed_entry_time_is_kept(self, db):
        _, team = self._scenario(db, entry_time=115000)
        assert team.entrytime == 115000

    def test_sessions_take_the_new_course(self, db):
        stub, _ = self._scenario(db, entry_time=None)
        assert {s.course for s in db.query(SwimSession).filter(SwimSession.meetsid == stub)} == {1}


def test_suggestion_rounds_like_the_shared_ui():
    """Half-up to the hundredth, like JS Math.round in relayEntryTime.ts —
    Python's round() would give 120000 (round half to even)."""
    from app.best_times import suggest_relay_entry_time
    assert suggest_relay_entry_time([120000, 120010]) == 120010
    assert suggest_relay_entry_time([120000, None, 0]) == 120000
    assert suggest_relay_entry_time([None]) is None
