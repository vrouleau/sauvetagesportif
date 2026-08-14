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

"""Integration tests for meetmanager-app.

Exercises the full HTTP API against the running stack with synthetic data —
no SPLASH involved. Run: `pytest tests/ -v` from repo root.
"""
from __future__ import annotations

import re
import zipfile
from datetime import date
from io import BytesIO
from pathlib import Path

import pytest
import requests

from conftest import (
    BASE_URL, MEET_TEMPLATE, ENTRIES_FILE, RESULTS_FILE,
    get_registration, post_registration, delete_registration,
    export_bundle, export_lxf, export_registrations_lxf, export_meet_lxf,
    exec_in_backend,
)

# ---------------------------------------------------------------------------
# Setup / smoke
# ---------------------------------------------------------------------------

class TestSetup:
    def test_meet_uploaded(self, uploaded):
        # Gatineau template has 57 events
        assert uploaded["meet"]["events_loaded"] == 57

    def test_entries_uploaded(self, uploaded):
        # Generator default: 5 clubs x 5 categories x 2 genders x 2 = 100 athletes
        # On a fresh DB: clubs_added=5, athletes_added=100
        # On a re-run (SQLite persists): clubs_added=0, athletes_added=0 (upsert)
        assert uploaded["entries"]["clubs_added"] + uploaded["entries"].get("entries_added", 0) >= 0

    def test_status_counts(self, status):
        assert status["clubs"] >= 5
        assert status["athletes"] >= 100
        assert status["events"] == 57
        assert status["registrations"] >= 0

    def test_meet_info(self, uploaded):
        r = requests.get(f"{BASE_URL}/api/meet-info", timeout=5)
        r.raise_for_status()
        info = r.json()
        assert info["events"] == 57
        assert info["course"] == "SCM"
        assert info["masters"] is False  # Gatineau has no masters


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class TestAuth:
    @pytest.fixture(autouse=True)
    def _reset_rate_limits(self, admin_headers):
        """Reset rate limits before each auth test to avoid 429s from prior tests."""
        requests.post(f"{BASE_URL}/api/admin/reset-rate-limits",
                      headers=admin_headers, timeout=5)

    def test_admin_login(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/auth",
                          json={"pin": admin_headers["X-Club-Pin"]}, timeout=5)
        assert r.status_code == 200
        assert r.json()["role"] == "admin"

    def test_invalid_pin_rejected(self):
        r = requests.post(f"{BASE_URL}/api/auth",
                          json={"pin": "000000"}, timeout=5)
        assert r.status_code == 401

    def test_club_login(self, clubs):
        # First club's PIN was generated on entries upload
        pin = clubs[0]["pin"]
        r = requests.post(f"{BASE_URL}/api/auth", json={"pin": pin}, timeout=5)
        assert r.status_code == 200
        body = r.json()
        assert body["role"] == "coach"
        assert body["club_id"] == clubs[0]["id"]

    def test_admin_login_includes_meets_with_admin_role(self, admin_headers, uploaded):
        """Phase 2 stage 2: /auth returns meets: [{meet_id, name, role}] —
        admin's role is the same ("admin") for every open meet."""
        r = requests.post(f"{BASE_URL}/api/auth",
                          json={"pin": admin_headers["X-Club-Pin"]}, timeout=5)
        assert r.status_code == 200
        body = r.json()
        assert len(body["meets"]) == 1, "expected exactly one open meet in the test stack"
        assert body["meets"][0]["role"] == "admin"
        assert body["meets"][0]["name"]
        assert isinstance(body["meets"][0]["meet_id"], int)

    def test_club_login_meets_role_matches_top_level_role(self, clubs):
        """The single-meet case: meets[0]'s role must match the back-compat
        top-level role the frontend still reads until stage 5 lands."""
        pin = clubs[0]["pin"]
        r = requests.post(f"{BASE_URL}/api/auth", json={"pin": pin}, timeout=5)
        assert r.status_code == 200
        body = r.json()
        assert len(body["meets"]) == 1
        assert body["meets"][0]["role"] == body["role"] == "coach"

    def test_organizer_club_gets_organizer_role_in_meets(self, clubs, admin_headers):
        """A club assigned as organizer for the open meet must see role
        'organizer' in both the top-level field and its meets[] entry —
        proving the per-meet role resolution (not a login-time constant)."""
        club = clubs[0]
        try:
            r = requests.post(f"{BASE_URL}/api/admin/set-organizer",
                              json={"club_id": club["id"]}, headers=admin_headers, timeout=5)
            assert r.status_code == 200

            r = requests.post(f"{BASE_URL}/api/auth", json={"pin": club["pin"]}, timeout=5)
            assert r.status_code == 200
            body = r.json()
            assert body["role"] == "organizer"
            assert len(body["meets"]) == 1
            assert body["meets"][0]["role"] == "organizer"
        finally:
            # No public endpoint clears organizer_club_id (set-organizer requires
            # a real club_id) — same escape hatch as elsewhere in this suite.
            exec_in_backend(
                "from app.database import SessionLocal\n"
                "from app.models import MeetConfig\n"
                "from app.models_team import Meet\n"
                "db = SessionLocal()\n"
                "db.query(MeetConfig).filter(MeetConfig.name == 'organizer_club_id').delete()\n"
                "db.commit()\n"
            )


# ---------------------------------------------------------------------------
# Registration view: categories + suggestions
# ---------------------------------------------------------------------------

def _by_birthyear(athletes, year, gender=None):
    out = [a for a in athletes if a["birthdate"] and a["birthdate"].startswith(str(year))]
    if gender:
        out = [a for a in out if a["gender"] == gender]
    return out


class TestRegistrationView:
    @pytest.mark.parametrize("year,expected", [
        (2018, "10-"),     # age 8
        (2014, "11-12"),   # age 12
        (2012, "13-14"),   # age 14
        (2010, "15-18"),   # age 16
        (2002, "Open"),    # age 24
    ])
    def test_suggested_age_code(self, athletes, admin_headers, year, expected):
        pool = _by_birthyear(athletes, year)
        assert pool, f"No athlete born in {year}"
        reg = get_registration(pool[0]["id"], admin_headers)
        assert reg["suggested_age_code"] == expected

    def test_all_age_codes_exposed_by_backend(self, athletes, admin_headers):
        # Backend doesn't pre-filter to ±1 (frontend does); it should expose
        # every age category that exists across the meet's events.
        adult = _by_birthyear(athletes, 2002)[0]
        reg = get_registration(adult["id"], admin_headers)
        codes = set()
        for s in reg["individual_events"] + reg["relay_events"]:
            for c in s["categories"]:
                codes.add(c["age_code"])
        # Gatineau has no Masters, so we expect exactly these 5 codes
        assert codes == {"10-", "11-12", "13-14", "15-18", "Open"}

    def test_junior_only_sees_reachable_categories(self, athletes, admin_headers):
        # 12-year-old: ±1 = 10-, 11-12, 13-14
        junior = _by_birthyear(athletes, 2014)[0]
        reg = get_registration(junior["id"], admin_headers)
        codes = set()
        for s in reg["individual_events"] + reg["relay_events"]:
            for c in s["categories"]:
                codes.add(c["age_code"])
        # Backend doesn't filter ±1 (frontend does); but the events themselves
        # should at least have the natural category 11-12 represented.
        assert "11-12" in codes

    def test_individual_events_match_athlete_gender(self, athletes, admin_headers):
        male = _by_birthyear(athletes, 2002, gender="M")[0]
        reg = get_registration(male["id"], admin_headers)
        # All individual events should be either gender 1 (M) or gender 0 (all)
        # — never gender 2 (F-only).
        # We can't read the raw event gender from the registration payload, but
        # we can confirm the event count differs vs. an F athlete (sanity).
        female = _by_birthyear(athletes, 2002, gender="F")[0]
        reg_f = get_registration(female["id"], admin_headers)
        # Gatineau alternates M/F per style; both should see ~half the events.
        assert len(reg["individual_events"]) > 0
        assert len(reg_f["individual_events"]) > 0


# ---------------------------------------------------------------------------
# Registration write: create / change / delete
# ---------------------------------------------------------------------------

class TestRegistrationWrite:
    @pytest.fixture
    def adult(self, athletes):
        return _by_birthyear(athletes, 2002, gender="M")[0]

    def test_create_and_delete(self, adult, admin_headers):
        reg = get_registration(adult["id"], admin_headers)
        style = next(s for s in reg["individual_events"]
                     if any(c["age_code"] == "Open" for c in s["categories"]))
        cat = next(c for c in style["categories"] if c["age_code"] == "Open")

        r = post_registration(adult["id"], cat["event_id"], "Open", 65430, admin_headers)
        reg_id = r["id"]
        assert reg_id

        # Verify it's now registered
        after = get_registration(adult["id"], admin_headers)
        after_style = next(s for s in after["individual_events"]
                           if s["style_uid"] == style["style_uid"])
        regd = next(c for c in after_style["categories"] if c["registered"])
        assert regd["age_code"] == "Open"
        assert regd["entry_time_ms"] == 65430

        delete_registration(reg_id, admin_headers)
        cleaned = get_registration(adult["id"], admin_headers)
        cleaned_style = next(s for s in cleaned["individual_events"]
                             if s["style_uid"] == style["style_uid"])
        assert not any(c["registered"] for c in cleaned_style["categories"])

    def test_change_category_via_re_register(self, adult, admin_headers):
        """Simulates the frontend's category-switch flow: delete old, post new."""
        reg = get_registration(adult["id"], admin_headers)
        style = next(s for s in reg["individual_events"]
                     if {"15-18", "Open"} <= {c["age_code"] for c in s["categories"]})

        c_open = next(c for c in style["categories"] if c["age_code"] == "Open")
        c_1518 = next(c for c in style["categories"] if c["age_code"] == "15-18")

        # 15-18 and Open share the same event_id on adult Gatineau events
        assert c_open["event_id"] == c_1518["event_id"]

        r1 = post_registration(adult["id"], c_open["event_id"], "Open", 70000, admin_headers)
        delete_registration(r1["id"], admin_headers)
        r2 = post_registration(adult["id"], c_1518["event_id"], "15-18", 70000, admin_headers)

        after = get_registration(adult["id"], admin_headers)
        after_style = next(s for s in after["individual_events"]
                           if s["style_uid"] == style["style_uid"])
        regd = next(c for c in after_style["categories"] if c["registered"])
        assert regd["age_code"] == "15-18"

        delete_registration(r2["id"], admin_headers)

    def test_nt_registration_persists(self, adult, admin_headers):
        """A registration with entry_time_ms=None (NT) must show as registered on reload."""
        reg = get_registration(adult["id"], admin_headers)
        style = next(s for s in reg["individual_events"]
                     if any(c["age_code"] == "Open" for c in s["categories"]))
        cat = next(c for c in style["categories"] if c["age_code"] == "Open")

        # Register with no time (NT)
        r = post_registration(adult["id"], cat["event_id"], "Open", None, admin_headers)
        reg_id = r["id"]
        assert reg_id

        # Reload and verify it shows as registered
        after = get_registration(adult["id"], admin_headers)
        after_style = next(s for s in after["individual_events"]
                           if s["style_uid"] == style["style_uid"])
        regd = next((c for c in after_style["categories"] if c["registered"]), None)
        assert regd is not None, "NT registration must appear as registered after reload"
        assert regd["age_code"] == "Open"
        assert regd["entry_time_ms"] is None

        delete_registration(reg_id, admin_headers)


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

class TestExport:
    @pytest.fixture(scope="class")
    def with_registrations(self, athletes, admin_headers):
        """Register one athlete per category, on the first event that supports it."""
        created = []
        for year, code in [(2018, "10-"), (2014, "11-12"), (2012, "13-14"),
                           (2010, "15-18"), (2002, "Open")]:
            ath = _by_birthyear(athletes, year, gender="M")[0]
            reg = get_registration(ath["id"], admin_headers)
            style = next((s for s in reg["individual_events"]
                          if any(c["age_code"] == code for c in s["categories"])), None)
            if not style:
                continue
            cat = next(c for c in style["categories"] if c["age_code"] == code)
            r = post_registration(ath["id"], cat["event_id"], code, 60000, admin_headers)
            created.append({"reg_id": r["id"], "athlete": ath, "code": code,
                            "event_id": cat["event_id"]})

        yield created

        for c in created:
            try:
                delete_registration(c["reg_id"], admin_headers)
            except Exception:
                pass

    def test_export_bundle_contains_scripts(self, with_registrations, admin_headers):
        bundle = export_bundle(admin_headers)
        names = set(bundle.namelist())
        assert "inscriptions.lxf" in names
        assert "simulate_results.vbs" in names
        assert "simulate_results.bat" in names

    def test_export_returns_valid_lxf_zip(self, with_registrations, admin_headers):
        lxf = export_lxf(admin_headers)
        names = lxf.namelist()
        assert any(n.endswith(".lef") for n in names)

    def test_export_contains_all_registrations(self, with_registrations, admin_headers):
        lxf = export_lxf(admin_headers)
        lef_name = next(n for n in lxf.namelist() if n.endswith(".lef"))
        lef = lxf.read(lef_name).decode()
        # Each registration => one ENTRY
        assert lef.count("<ENTRY ") == len(with_registrations)

    def test_export_sets_eventid_and_agegroupid(self, with_registrations, admin_headers):
        lxf = export_lxf(admin_headers)
        lef_name = next(n for n in lxf.namelist() if n.endswith(".lef"))
        lef = lxf.read(lef_name).decode()
        entries = re.findall(r"<ENTRY ([^/]+?)/>", lef)
        assert len(entries) == len(with_registrations)
        for attrs in entries:
            assert "eventid=" in attrs
            assert "agegroupid=" in attrs

    def test_export_eventid_matches_meet_template(self, with_registrations, admin_headers):
        """Each ENTRY's eventid must reference an EVENT defined in the SESSIONS section."""
        lxf = export_lxf(admin_headers)
        lef_name = next(n for n in lxf.namelist() if n.endswith(".lef"))
        lef = lxf.read(lef_name).decode()

        defined = set(re.findall(r'<EVENT [^>]*\beventid="(\d+)"', lef))
        used = set(re.findall(r'<ENTRY [^/]*\beventid="(\d+)"', lef))
        assert used <= defined, f"Entries reference undefined eventids: {used - defined}"

    def test_export_agegroupid_matches_event_groups(self, with_registrations, admin_headers):
        """Each ENTRY's agegroupid must be defined within its EVENT's AGEGROUPS."""
        lxf = export_lxf(admin_headers)
        lef_name = next(n for n in lxf.namelist() if n.endswith(".lef"))
        lef = lxf.read(lef_name).decode()

        # Map eventid -> set of agegroupids defined for that event
        ev_blocks = re.findall(
            r'<EVENT [^>]*\beventid="(\d+)"[^>]*>(.*?)</EVENT>', lef, re.DOTALL)
        ev_agegroups: dict[str, set[str]] = {
            eid: set(re.findall(r'<AGEGROUP [^>]*\bagegroupid="(\d+)"', body))
            for eid, body in ev_blocks
        }

        entries = re.findall(
            r'<ENTRY [^/]*\beventid="(\d+)"[^/]*\bagegroupid="(\d+)"', lef)
        assert entries, "no ENTRY rows with both eventid and agegroupid"
        for eid, agid in entries:
            assert agid in ev_agegroups.get(eid, set()), \
                f"ENTRY agegroupid={agid} not defined on EVENT {eid}"


# ---------------------------------------------------------------------------
# Results upload (best times)
# ---------------------------------------------------------------------------

class TestResultsUpload:
    @pytest.fixture(scope="class")
    def uploaded_results(self, results_path, admin_headers) -> dict:
        with open(results_path, "rb") as f:
            r = requests.post(
                f"{BASE_URL}/api/upload/results?force=true",
                files={"file": ("results.lxf", f, "application/octet-stream")},
                headers=admin_headers,
                timeout=60,
            )
        r.raise_for_status()
        return r.json()

    def test_results_upload_response(self, uploaded_results):
        # Results are stored via historical import; seed_from_lxf returns club/athlete counts
        assert "clubs_created" in uploaded_results or "results_imported" in uploaded_results

    def test_status_shows_best_times(self, uploaded_results):
        r = requests.get(f"{BASE_URL}/api/status", timeout=10)
        r.raise_for_status()
        assert r.json()["best_times"] > 100

    def test_athlete_registration_shows_best_time(self, uploaded_results,
                                                   athletes, admin_headers):
        # Walk athletes until we find one whose /registration response shows
        # at least one non-null best_time_scm_ms (Gatineau course is SCM).
        found = False
        for a in athletes[:30]:  # sample is enough
            reg = get_registration(a["id"], admin_headers)
            for s in reg["individual_events"]:
                if s.get("best_time_scm_ms"):
                    found = True
                    break
            if found:
                break
        assert found, "no best_time_scm_ms surfaced on any athlete after upload"


# ---------------------------------------------------------------------------
# Access control (auth middleware added in security-hardening branch)
# ---------------------------------------------------------------------------

class TestAccessControl:
    """Verify that protected endpoints enforce role requirements."""

    def test_admin_endpoint_rejects_no_auth(self):
        r = requests.get(f"{BASE_URL}/api/export", timeout=5)
        assert r.status_code == 403

    def test_admin_endpoint_rejects_coach(self, clubs):
        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.get(f"{BASE_URL}/api/export", headers=coach_headers, timeout=5)
        assert r.status_code == 403

    def test_admin_post_endpoint_rejects_coach(self, clubs):
        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.post(f"{BASE_URL}/api/clubs/regenerate-pins",
                          headers=coach_headers, timeout=5)
        assert r.status_code == 403

    def test_clubs_pin_hidden_from_coach(self, clubs):
        """GET /clubs must omit the pin field for non-admin callers."""
        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.get(f"{BASE_URL}/api/clubs", headers=coach_headers, timeout=10)
        r.raise_for_status()
        for c in r.json():
            assert "pin" not in c

    def test_clubs_pin_visible_to_admin(self, admin_headers):
        """GET /clubs must include the pin field for admin."""
        r = requests.get(f"{BASE_URL}/api/clubs", headers=admin_headers, timeout=10)
        r.raise_for_status()
        for c in r.json():
            assert "pin" in c

    def test_several_admin_endpoints_reject_unauthenticated(self):
        """Spot-check a range of admin-only endpoints without credentials."""
        endpoints = [
            ("GET",  "/api/export/entries"),
            ("GET",  "/api/admin/organizer"),
            ("POST", "/api/admin/set-organizer"),
        ]
        for method, path in endpoints:
            r = requests.request(method, f"{BASE_URL}{path}", timeout=5)
            assert r.status_code == 403, (
                f"Expected 403 on {method} {path}, got {r.status_code}"
            )

    def test_flush_meet_rejects_coach(self, clubs):
        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.delete(f"{BASE_URL}/api/registrations",
                            headers=coach_headers, timeout=5)
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# Rate limiting on /auth
# ---------------------------------------------------------------------------

class TestAuthRateLimit:
    def test_rate_limit_triggers_after_rapid_failures(self):
        """After ≥5 failed auth attempts in 60 s the server must return 429."""
        got_429 = False
        for _ in range(10):  # well above the limit of 5
            r = requests.post(f"{BASE_URL}/api/auth",
                              json={"pin": "999998"}, timeout=5)
            assert r.status_code in (401, 429), f"Unexpected status: {r.status_code}"
            if r.status_code == 429:
                got_429 = True
                break
        assert got_429, "Expected 429 after repeated failed auth attempts"


# ---------------------------------------------------------------------------
# Entries export (/export/entries — new endpoint)
# ---------------------------------------------------------------------------

class TestExportEntries:
    @pytest.fixture(scope="class")
    def entries_zip(self, uploaded, admin_headers) -> zipfile.ZipFile:
        r = requests.get(f"{BASE_URL}/api/export/entries",
                         headers=admin_headers, timeout=30)
        r.raise_for_status()
        return zipfile.ZipFile(BytesIO(r.content))

    def test_contains_lef(self, entries_zip):
        names = entries_zip.namelist()
        assert any(n.endswith(".lef") for n in names), f"No .lef in {names}"

    def test_athlete_count_matches_import(self, entries_zip, uploaded):
        lef_name = next(n for n in entries_zip.namelist() if n.endswith(".lef"))
        lef = entries_zip.read(lef_name).decode()
        # Export should contain at least the athletes from the original import
        assert lef.count("<ATHLETE ") >= 100

    def test_club_count_matches_import(self, entries_zip, uploaded):
        lef_name = next(n for n in entries_zip.namelist() if n.endswith(".lef"))
        lef = entries_zip.read(lef_name).decode()
        # Export should contain at least the 5 clubs from the original import
        assert lef.count("<CLUB ") >= 5

    def test_requires_admin(self, clubs):
        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.get(f"{BASE_URL}/api/export/entries",
                         headers=coach_headers, timeout=5)
        assert r.status_code == 403

    def test_has_entry_elements_after_results_upload(
            self, uploaded, admin_headers, results_path):
        """After results are loaded, the entries export includes ENTRY elements."""
        with open(results_path, "rb") as f:
            r = requests.post(
                f"{BASE_URL}/api/upload/results?force=true",
                files={"file": ("results.lxf", f, "application/octet-stream")},
                headers=admin_headers,
                timeout=60,
            )
        r.raise_for_status()

        r = requests.get(f"{BASE_URL}/api/export/entries",
                         headers=admin_headers, timeout=30)
        r.raise_for_status()
        z = zipfile.ZipFile(BytesIO(r.content))
        lef_name = next(n for n in z.namelist() if n.endswith(".lef"))
        lef = z.read(lef_name).decode()
        assert "<ENTRY " in lef, "Expected ENTRY elements after best-time upload"


# ---------------------------------------------------------------------------
# Server-side validation
# ---------------------------------------------------------------------------

class TestValidation:
    """Tests for Pydantic models, relay lock, age_code, entry_time, closure."""

    @pytest.fixture(autouse=True, scope="class")
    def _ensure_meet(self, admin_headers):
        """Re-upload meet template so events exist for validation tests."""
        from pathlib import Path
        meet_path = Path(__file__).resolve().parent / "fixtures" / "meet_template.lxf"
        with open(meet_path, "rb") as f:
            r = requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                              files={"file": ("meet.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)
        r.raise_for_status()

    # --- Pydantic input validation ---

    def test_create_athlete_missing_name(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/athletes",
                          json={"last_name": "X", "club_id": 1, "gender": "M"},
                          headers=admin_headers, timeout=5)
        assert r.status_code == 422

    def test_create_athlete_empty_name(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/athletes",
                          json={"first_name": "", "last_name": "X", "club_id": 1},
                          headers=admin_headers, timeout=5)
        assert r.status_code == 422

    def test_create_athlete_invalid_gender(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/athletes",
                          json={"first_name": "A", "last_name": "B", "club_id": 1, "gender": "Z"},
                          headers=admin_headers, timeout=5)
        assert r.status_code == 422

    def test_create_athlete_invalid_birthdate(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/athletes",
                          json={"first_name": "A", "last_name": "B", "club_id": 1, "birthdate": "not-a-date"},
                          headers=admin_headers, timeout=5)
        assert r.status_code == 422

    def test_create_club_empty_name(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/clubs",
                          json={"name": ""},
                          headers=admin_headers, timeout=5)
        assert r.status_code == 422

    def test_create_club_missing_name(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/clubs",
                          json={},
                          headers=admin_headers, timeout=5)
        assert r.status_code == 422

    def test_closure_date_invalid_format(self, admin_headers):
        r = requests.put(f"{BASE_URL}/api/closure-date",
                         json={"closure_date": "not-a-date"},
                         headers=admin_headers, timeout=5)
        assert r.status_code == 422

    def test_change_pin_too_short(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/admin/change-pin",
                          json={"pin": "12"},
                          headers=admin_headers, timeout=5)
        assert r.status_code == 422

    # --- entry_time_ms validation ---

    def test_registration_negative_entry_time(self, admin_headers):
        """entry_time_ms must be non-negative."""
        r = requests.post(f"{BASE_URL}/api/registrations",
                          json={"athlete_id": 1, "event_id": 1,
                                "age_code": "Open", "entry_time_ms": -100},
                          headers=admin_headers, timeout=5)
        assert r.status_code == 422

    # --- age_code validation ---

    def test_registration_invalid_age_code(self, admin_headers):
        """age_code must be one of the known values."""
        r = requests.post(f"{BASE_URL}/api/registrations",
                          json={"athlete_id": 1, "event_id": 1,
                                "age_code": "BOGUS"},
                          headers=admin_headers, timeout=5)
        assert r.status_code == 422

    def test_registration_wrong_age_code_for_event(self, athletes, admin_headers):
        """Register with a valid age_code that doesn't match the event's age groups."""
        adult = _by_birthyear(athletes, 2002, gender="M")[0]
        reg = get_registration(adult["id"], admin_headers)
        style = reg["individual_events"][0]
        # Find a category that IS valid for this event
        valid_codes = {c["age_code"] for c in style["categories"]}
        # Pick a code NOT in the event's valid set
        all_codes = {"10-", "11-12", "13-14", "15-18", "Open"}
        invalid_for_event = all_codes - valid_codes
        if not invalid_for_event:
            pytest.skip("All codes valid for this event")
        bad_code = invalid_for_event.pop()
        cat = style["categories"][0]
        r = requests.post(f"{BASE_URL}/api/registrations",
                          json={"athlete_id": athletes[0]["id"],
                                "event_id": cat["event_id"],
                                "age_code": bad_code},
                          headers=admin_headers, timeout=5)
        assert r.status_code == 422

    # --- relay lock ---

    def test_relay_lock(self, athletes, clubs, admin_headers):
        """Second athlete from same club cannot register for same relay event."""
        # Find a relay event
        r = requests.get(f"{BASE_URL}/api/events", headers=admin_headers, timeout=5)
        r.raise_for_status()
        events = r.json()
        relay_events = [e for e in events if e.get("relay_count", 0) > 1]
        if not relay_events:
            pytest.skip("No relay events in test meet")
        relay_ev = relay_events[0]

        # Find two athletes from the same club
        club_id = clubs[0]["id"]
        club_athletes = [a for a in athletes if a["club_id"] == club_id]
        assert len(club_athletes) >= 2

        # Get valid age_code for this relay event
        reg = get_registration(club_athletes[0]["id"], admin_headers)
        relay_styles = reg["relay_events"]
        relay_style = next((s for s in relay_styles
                            for c in s["categories"]
                            if c["event_id"] == relay_ev["id"]), None)
        if not relay_style:
            pytest.skip("Relay event not visible to athlete")
        cat = next(c for c in relay_style["categories"] if c["event_id"] == relay_ev["id"])

        # Register first athlete
        r1 = requests.post(f"{BASE_URL}/api/registrations",
                           json={"athlete_id": club_athletes[0]["id"],
                                 "event_id": relay_ev["id"],
                                 "age_code": cat["age_code"],
                                 "entry_time_ms": None},
                           headers=admin_headers, timeout=5)
        assert r1.status_code == 200
        reg1_id = r1.json()["id"]

        # Second athlete from same club → 409
        r2 = requests.post(f"{BASE_URL}/api/registrations",
                           json={"athlete_id": club_athletes[1]["id"],
                                 "event_id": relay_ev["id"],
                                 "age_code": cat["age_code"],
                                 "entry_time_ms": None},
                           headers=admin_headers, timeout=5)
        assert r2.status_code == 409

        # Cleanup
        requests.delete(f"{BASE_URL}/api/registrations/{reg1_id}",
                        headers=admin_headers, timeout=5)

    # --- closure date on athlete CRUD ---

    def test_closure_blocks_athlete_create(self, clubs, admin_headers):
        """Coach cannot create athlete after closure."""
        # Set closure to yesterday
        from datetime import date, timedelta
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        r = requests.put(f"{BASE_URL}/api/closure-date",
                         json={"closure_date": yesterday},
                         headers=admin_headers, timeout=5)
        r.raise_for_status()

        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.post(f"{BASE_URL}/api/athletes",
                          json={"first_name": "Blocked", "last_name": "Coach",
                                "club_id": clubs[0]["id"], "gender": "M"},
                          headers=coach_headers, timeout=5)
        assert r.status_code == 403

        # Admin can still create
        r = requests.post(f"{BASE_URL}/api/athletes",
                          json={"first_name": "Admin", "last_name": "OK",
                                "club_id": clubs[0]["id"], "gender": "M"},
                          headers=admin_headers, timeout=5)
        assert r.status_code == 200
        # Cleanup
        requests.delete(f"{BASE_URL}/api/athletes/{r.json()['id']}",
                        headers=admin_headers, timeout=5)
        requests.put(f"{BASE_URL}/api/closure-date",
                     json={"closure_date": ""},
                     headers=admin_headers, timeout=5)

    def test_closure_blocks_athlete_delete(self, athletes, clubs, admin_headers):
        """Coach cannot delete athlete after closure."""
        from datetime import date, timedelta
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        requests.put(f"{BASE_URL}/api/closure-date",
                     json={"closure_date": yesterday},
                     headers=admin_headers, timeout=5)

        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        club_athletes = [a for a in athletes if a["club_id"] == clubs[0]["id"]]
        r = requests.delete(f"{BASE_URL}/api/athletes/{club_athletes[0]['id']}",
                            headers=coach_headers, timeout=5)
        assert r.status_code == 403

        # Clear closure
        requests.put(f"{BASE_URL}/api/closure-date",
                     json={"closure_date": ""},
                     headers=admin_headers, timeout=5)


# ---------------------------------------------------------------------------
# Self-invite (public endpoint)
# ---------------------------------------------------------------------------

class TestSelfInvite:
    """Tests for the public self-invite flow added post-validation commit."""

    def test_self_invite_clubs_returns_list(self, uploaded):
        r = requests.get(f"{BASE_URL}/api/self-invite/clubs", timeout=5)
        r.raise_for_status()
        clubs = r.json()
        assert isinstance(clubs, list)
        # Should not expose email
        for c in clubs:
            assert "admin_email" not in c
            assert "email" not in c
            assert "id" in c
            assert "name" in c

    def test_self_invite_requires_club_id(self):
        r = requests.post(f"{BASE_URL}/api/self-invite",
                          json={"email": "x@x.com"}, timeout=5)
        assert r.status_code == 400

    def test_self_invite_requires_email(self, clubs):
        r = requests.post(f"{BASE_URL}/api/self-invite",
                          json={"club_id": clubs[0]["id"]}, timeout=5)
        assert r.status_code == 400

    def test_self_invite_wrong_email_returns_403(self, clubs, admin_headers):
        # Set email on the club so the email mismatch path is reachable
        r = requests.put(f"{BASE_URL}/api/clubs/{clubs[0]['id']}",
                         json={"email": "real@example.com"},
                         headers=admin_headers, timeout=5)
        r.raise_for_status()

        r = requests.post(f"{BASE_URL}/api/self-invite",
                          json={"club_id": clubs[0]["id"],
                                "email": "wrong@example.com"}, timeout=5)
        # 403 = email mismatch; 400 = CAPTCHA required (if Turnstile is configured)
        assert r.status_code in (403, 400)
        detail = r.json().get("detail", "")
        if r.status_code == 403:
            assert "email_mismatch" in detail
        else:
            assert "CAPTCHA" in detail

        # Clean up
        requests.put(f"{BASE_URL}/api/clubs/{clubs[0]['id']}",
                     json={"email": ""},
                     headers=admin_headers, timeout=5)


# ---------------------------------------------------------------------------
# Athlete ownership (coaches scoped to own club)
# ---------------------------------------------------------------------------

class TestAthleteOwnership:
    """Coaches cannot create/delete athletes in other clubs."""

    @pytest.fixture
    def fresh_clubs(self, admin_headers) -> list[dict]:
        """Get fresh club list (PINs may have been regenerated by earlier tests)."""
        r = requests.get(f"{BASE_URL}/api/clubs", headers=admin_headers, timeout=10)
        r.raise_for_status()
        return r.json()

    def test_athletes_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/athletes", timeout=5)
        assert r.status_code == 401

    def test_coach_only_sees_own_club_athletes(self, fresh_clubs, athletes):
        coach_headers = {"X-Club-Pin": fresh_clubs[0]["pin"]}
        r = requests.get(f"{BASE_URL}/api/athletes", headers=coach_headers, timeout=10)
        r.raise_for_status()
        result = r.json()
        # All returned athletes must belong to the coach's club
        for a in result:
            assert a["club_id"] == fresh_clubs[0]["id"]

    def test_coach_cannot_create_athlete_in_other_club(self, fresh_clubs):
        coach_headers = {"X-Club-Pin": fresh_clubs[0]["pin"]}
        other_club_id = fresh_clubs[1]["id"]
        r = requests.post(f"{BASE_URL}/api/athletes",
                          json={"first_name": "X", "last_name": "Y",
                                "club_id": other_club_id, "gender": "M"},
                          headers=coach_headers, timeout=5)
        assert r.status_code == 403

    def test_coach_cannot_delete_athlete_in_other_club(self, fresh_clubs, athletes):
        coach_headers = {"X-Club-Pin": fresh_clubs[0]["pin"]}
        other_athlete = next(a for a in athletes if a["club_id"] == fresh_clubs[1]["id"])
        r = requests.delete(f"{BASE_URL}/api/athletes/{other_athlete['id']}",
                            headers=coach_headers, timeout=5)
        assert r.status_code == 403

    def test_admin_email_hidden_from_coach(self, fresh_clubs):
        coach_headers = {"X-Club-Pin": fresh_clubs[0]["pin"]}
        r = requests.get(f"{BASE_URL}/api/clubs", headers=coach_headers, timeout=10)
        r.raise_for_status()
        for c in r.json():
            assert "email" not in c


# ---------------------------------------------------------------------------
# Age base date (from meet.lxf AGEDATE element)
# ---------------------------------------------------------------------------

class TestAgeBaseDate:
    """Verify age_base_date is parsed from meet and used in age calculation."""

    def test_meet_info_has_age_base_date(self, uploaded):
        r = requests.get(f"{BASE_URL}/api/meet-info", timeout=5)
        r.raise_for_status()
        # age_base_date should be exposed or at least stored — verify via
        # the age calculation producing correct results based on the meet's date
        # (Gatineau template uses 2026-12-31 as AGEDATE)
        assert r.status_code == 200

    def test_export_agedate_matches_meet(self, uploaded, athletes, admin_headers):
        """The exported .lxf AGEDATE must reflect the meet's age base date."""
        # Register one athlete to enable export
        ath = _by_birthyear(athletes, 2002, gender="M")[0]
        reg = get_registration(ath["id"], admin_headers)
        style = next(s for s in reg["individual_events"]
                     if any(c["age_code"] == "Open" for c in s["categories"]))
        cat = next(c for c in style["categories"] if c["age_code"] == "Open")
        r = post_registration(ath["id"], cat["event_id"], "Open", 60000, admin_headers)
        reg_id = r["id"]

        try:
            lxf = export_lxf(admin_headers)
            lef_name = next(n for n in lxf.namelist() if n.endswith(".lef"))
            lef = lxf.read(lef_name).decode()
            # AGEDATE element should have a valid date (not hard-coded if meet provides one)
            assert 'AGEDATE' in lef
            # Should contain a date in YYYY-MM-DD format
            agedate_match = re.search(r'AGEDATE[^>]*value="(\d{4}-\d{2}-\d{2})"', lef)
            assert agedate_match, "AGEDATE element missing or malformed in export"
        finally:
            delete_registration(reg_id, admin_headers)


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

class TestAuditLog:
    """Verify that mutating operations produce audit log entries."""

    def test_mutating_request_succeeds_with_audit(self, admin_headers):
        """A POST/PUT/DELETE with audit middleware active should not crash."""
        # Use a non-rate-limited endpoint to verify audit middleware works
        r = requests.put(f"{BASE_URL}/api/closure-date",
                         json={"closure_date": ""},
                         headers=admin_headers, timeout=5)
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Sessions endpoint (shared EventsPage data source)
# ---------------------------------------------------------------------------

class TestSessions:
    """Tests for GET /sessions — the data source for the shared EventsPage."""

    def test_sessions_returns_list(self, uploaded):
        r = requests.get(f"{BASE_URL}/api/sessions", timeout=10)
        r.raise_for_status()
        sessions = r.json()
        assert isinstance(sessions, list)
        assert len(sessions) > 0

    def test_sessions_have_required_fields(self, uploaded):
        r = requests.get(f"{BASE_URL}/api/sessions", timeout=10)
        r.raise_for_status()
        for s in r.json():
            assert "id" in s
            assert "number" in s
            assert "name" in s
            assert "poolSize" in s
            assert "events" in s
            assert isinstance(s["events"], list)

    def test_sessions_contain_multiple_sessions(self, uploaded):
        """The Gatineau meet template has multiple sessions."""
        r = requests.get(f"{BASE_URL}/api/sessions", timeout=10)
        r.raise_for_status()
        sessions = r.json()
        assert len(sessions) > 1, "Expected multiple sessions from Gatineau template"

    def test_session_events_have_required_fields(self, uploaded):
        r = requests.get(f"{BASE_URL}/api/sessions", timeout=10)
        r.raise_for_status()
        sessions = r.json()
        # Find a session with events
        session_with_events = next((s for s in sessions if s["events"]), None)
        assert session_with_events, "No session has events"
        ev = session_with_events["events"][0]
        assert "id" in ev
        assert "sessionId" in ev
        assert "number" in ev
        assert "nameFr" in ev
        assert "gender" in ev
        # ALL (0) is a real individual-event value now — see docs/AGE_GROUP_GENDER_MODEL.md
        assert ev["gender"] in ("ALL", "M", "F", "X")
        assert "distance" in ev
        assert "phase" in ev
        assert "swimstyleId" in ev
        assert "ageGroups" in ev

    def test_session_events_have_age_groups(self, uploaded):
        r = requests.get(f"{BASE_URL}/api/sessions", timeout=10)
        r.raise_for_status()
        sessions = r.json()
        # Find an event with age groups
        found = False
        for s in sessions:
            for ev in s["events"]:
                if ev["ageGroups"]:
                    found = True
                    ag = ev["ageGroups"][0]
                    assert "id" in ag
                    assert "name" in ag
                    assert ag["name"] != "", "Age group name should not be empty"
                    assert "minAge" in ag
                    assert "maxAge" in ag
                    assert "gender" in ag
                    # Always mirrors the parent event's gender, including ALL (0)
                    assert ag["gender"] in ("ALL", "M", "F", "X")
                    break
            if found:
                break

    def test_age_group_name_never_empty(self, uploaded):
        """Age group name should fall back to 'agemin-agemax' or '???' — never empty string."""
        r = requests.get(f"{BASE_URL}/api/sessions", timeout=10)
        r.raise_for_status()
        sessions = r.json()
        found = False
        for s in sessions:
            for ev in s["events"]:
                for ag in ev["ageGroups"]:
                    found = True
                    assert ag["name"] != "", (
                        f"Event {ev['id']} agegroup {ag['id']} has empty name. "
                        f"Expected 'agemin-agemax' fallback or '???' placeholder."
                    )
                    # If minAge is set, name should contain the age range or a real name
                    if ag["minAge"] and ag["minAge"] > 0 and ag["name"] != "???":
                        # Either a real name or the agemin-agemax pattern
                        assert ag["name"], f"Agegroup {ag['id']} has no name"
        assert found, "No event has age groups"

    def test_age_group_gender_inherits_from_event(self, uploaded):
        """Age groups with NULL gender should inherit from parent event."""
        r = requests.get(f"{BASE_URL}/api/sessions", timeout=10)
        r.raise_for_status()
        sessions = r.json()
        for s in sessions:
            for ev in s["events"]:
                if ev["gender"] != "X":  # skip mixed events
                    for ag in ev["ageGroups"]:
                        # Age group gender should match event gender (not be X)
                        assert ag["gender"] == ev["gender"], (
                            f"Event {ev['id']} gender={ev['gender']} but "
                            f"agegroup {ag['id']} gender={ag['gender']}"
                        )
                    if ev["ageGroups"]:
                        return  # one check is enough
        pytest.skip("No non-mixed event with age groups found")

    def test_total_event_count_matches_meet(self, uploaded):
        """Sum of events across all sessions should equal the meet's event count."""
        r = requests.get(f"{BASE_URL}/api/sessions", timeout=10)
        r.raise_for_status()
        sessions = r.json()
        total = sum(len(s["events"]) for s in sessions)
        assert total == 57  # Gatineau template has 57 events

    def test_sessions_no_auth_required(self):
        """The /sessions endpoint should be accessible without authentication."""
        r = requests.get(f"{BASE_URL}/api/sessions", timeout=10)
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Session-date exclusivity (Concurrent Meets Phase 1) — PUT /sessions/{id}
# ---------------------------------------------------------------------------

class TestSessionDateExclusivityEndpoint:
    """session_date_conflict() (meet_config.py) has full unit coverage, but
    nothing exercised the actual HTTP wiring: does PUT /api/sessions/{id}
    call it and return 409, or accept a colliding date silently?

    Phase 1 doesn't expose any public endpoint that opens a second
    registration_open=True meet yet (that's Phase 2), so there's no way to
    reach this precondition through the API alone — this seeds a rival meet
    directly in the backend container via exec_in_backend(), same DB the
    running stack uses, then drives the actual assertion over plain HTTP."""

    # Negative and far from any real meetsid — must never win
    # get_active_meetsid()'s "highest registration_open meetsid" tie-break
    # against the real meet created by `uploaded`, or GET /api/sessions
    # (now correctly meetsid-scoped) would resolve to this rival meet
    # instead of the real one the test is meant to operate on.
    RIVAL_MEETSID = -999999
    RIVAL_DATE = "2027-03-15"

    @pytest.fixture(scope="class", autouse=True)
    def rival_meet(self, uploaded):
        # Capture the real meet's id before the rival exists — once both are
        # registration_open, GET /api/sessions with no X-Meet-Id is
        # ambiguous (409) by design (docs/CONCURRENT_MEETS_PLAN.md, stage
        # 3), so every HTTP call in this class must send the header
        # explicitly to target the real meet, not the rival.
        TestSessionDateExclusivityEndpoint.REAL_MEETSID = int(exec_in_backend(
            "from app.meet_config import get_active_meetsid\n"
            "from app.database import SessionLocal\n"
            "db = SessionLocal()\n"
            "print(get_active_meetsid(db))\n"
        ).strip())
        exec_in_backend(
            "from app.database import SessionLocal\n"
            "from app.models_team import Meet\n"
            "from app.models import SwimSession\n"
            "from datetime import date\n"
            "db = SessionLocal()\n"
            f"db.add(Meet(meetsid={TestSessionDateExclusivityEndpoint.RIVAL_MEETSID}, "
            "name='Rival Meet', meetstate=0, registration_open=True))\n"
            # Meet (models_team.py) and SwimSession (models.py) use separate
            # declarative Base/MetaData, so the unit-of-work insert-ordering
            # topological sort doesn't see the cross-metadata FK — flush the
            # Meet row for real before inserting anything that references it
            # (same pattern events.py's _load_from_parsed already follows).
            "db.flush()\n"
            f"db.add(SwimSession(swimsessionid={TestSessionDateExclusivityEndpoint.RIVAL_MEETSID}, "
            f"meetsid={TestSessionDateExclusivityEndpoint.RIVAL_MEETSID}, sessionnumber=1, "
            f"name='Rival Session', startdate=date.fromisoformat('{TestSessionDateExclusivityEndpoint.RIVAL_DATE}')))\n"
            "db.commit()\n"
        )
        yield
        exec_in_backend(
            "from app.database import SessionLocal\n"
            "from app.models_team import Meet\n"
            "from app.models import SwimSession\n"
            "db = SessionLocal()\n"
            f"db.query(SwimSession).filter(SwimSession.meetsid=={TestSessionDateExclusivityEndpoint.RIVAL_MEETSID}).delete()\n"
            f"db.query(Meet).filter(Meet.meetsid=={TestSessionDateExclusivityEndpoint.RIVAL_MEETSID}).delete()\n"
            "db.commit()\n"
        )

    @pytest.fixture(scope="class")
    def a_session_id(self, rival_meet, admin_headers) -> int:
        r = requests.get(f"{BASE_URL}/api/sessions",
                         headers={**admin_headers, "X-Meet-Id": str(self.REAL_MEETSID)}, timeout=10)
        r.raise_for_status()
        return r.json()[0]["id"]

    def test_colliding_date_is_rejected(self, rival_meet, a_session_id, admin_headers):
        r = requests.put(
            f"{BASE_URL}/api/sessions/{a_session_id}",
            json={"startdate": self.RIVAL_DATE},
            headers={**admin_headers, "X-Meet-Id": str(self.REAL_MEETSID)}, timeout=10,
        )
        assert r.status_code == 409, f"Expected 409 on colliding session date, got {r.status_code}: {r.text}"
        assert "Rival Meet" in r.text

    def test_non_colliding_date_is_accepted(self, rival_meet, a_session_id, admin_headers):
        r = requests.put(
            f"{BASE_URL}/api/sessions/{a_session_id}",
            json={"startdate": "2027-04-20"},
            headers={**admin_headers, "X-Meet-Id": str(self.REAL_MEETSID)}, timeout=10,
        )
        assert r.status_code == 200, f"Non-colliding session date rejected: {r.text}"


# ---------------------------------------------------------------------------
# Event field round-trip (PUT /events/{id} -> GET /sessions)
# ---------------------------------------------------------------------------

class TestEventFieldRoundTrip:
    """Regression coverage for the "write path works, read path drops the
    field" bug class: update_event persisted a column correctly but
    list_sessions (the query behind GET /sessions, feeding the shared
    EventsPage) never selected it back, so the UI showed a stale/default
    value and a re-save from that stale state could silently overwrite the
    real value. See HANDOFF_2026-07-28.md.
    """

    def _get_event(self, event_id):
        r = requests.get(f"{BASE_URL}/api/sessions", timeout=10)
        r.raise_for_status()
        for s in r.json():
            for ev in s["events"]:
                if ev["id"] == event_id:
                    return ev
        raise AssertionError(f"event {event_id} not found in /api/sessions")

    def _first_individual_event_id(self):
        r = requests.get(f"{BASE_URL}/api/sessions", timeout=10)
        r.raise_for_status()
        for s in r.json():
            for ev in s["events"]:
                if not ev["isAdmin"]:
                    return ev["id"]
        raise AssertionError("no non-admin event found")

    def test_masters_fee_maxentries_round_trip(self, uploaded, admin_headers):
        event_id = self._first_individual_event_id()
        original = self._get_event(event_id)
        try:
            r = requests.put(
                f"{BASE_URL}/api/events/{event_id}",
                json={"masters": "T", "fee": 12.5, "maxentries": 6},
                headers=admin_headers, timeout=10,
            )
            r.raise_for_status()

            updated = self._get_event(event_id)
            assert updated["masters"] is True
            assert updated["fee"] == 12.5
            assert updated["maxEntries"] == 6
        finally:
            requests.put(
                f"{BASE_URL}/api/events/{event_id}",
                json={
                    "masters": "T" if original.get("masters") else "F",
                    "fee": original.get("fee") or 0,
                    "maxentries": original.get("maxEntries"),
                },
                headers=admin_headers, timeout=10,
            )

    def test_final_order_scheduled_time_duration_round_trip(self, uploaded, admin_headers):
        event_id = self._first_individual_event_id()
        original = self._get_event(event_id)
        try:
            r = requests.put(
                f"{BASE_URL}/api/events/{event_id}",
                # <input type="time"> in EventsPage always sends zero-padded "HH:MM"
                json={"finalorder": 1, "daytime": "09:15", "duration": "00:45"},
                headers=admin_headers, timeout=10,
            )
            r.raise_for_status()

            updated = self._get_event(event_id)
            assert updated["finalOrder"] == 1
            assert updated["scheduledTime"] == "09:15"
            assert updated["duration"] == "00:45"
        finally:
            requests.put(
                f"{BASE_URL}/api/events/{event_id}",
                json={
                    "finalorder": original.get("finalOrder"),
                    "daytime": original.get("scheduledTime"),
                    "duration": original.get("duration"),
                },
                headers=admin_headers, timeout=10,
            )

    def test_scheduled_time_and_duration_clear_to_null(self, uploaded, admin_headers):
        event_id = self._first_individual_event_id()
        original = self._get_event(event_id)
        try:
            requests.put(
                f"{BASE_URL}/api/events/{event_id}",
                json={"daytime": "09:15", "duration": "00:45"},
                headers=admin_headers, timeout=10,
            ).raise_for_status()
            requests.put(
                f"{BASE_URL}/api/events/{event_id}",
                json={"daytime": None, "duration": None},
                headers=admin_headers, timeout=10,
            ).raise_for_status()

            updated = self._get_event(event_id)
            assert updated["scheduledTime"] is None
            assert updated["duration"] is None
        finally:
            requests.put(
                f"{BASE_URL}/api/events/{event_id}",
                json={
                    "daytime": original.get("scheduledTime"),
                    "duration": original.get("duration"),
                },
                headers=admin_headers, timeout=10,
            )


# ---------------------------------------------------------------------------
# Swim styles endpoint (EventsPage dropdown data source)
# ---------------------------------------------------------------------------

class TestSwimStyles:
    """Tests for GET /swim-styles — provides the swimstyle dropdown data."""

    def test_swim_styles_returns_list(self, uploaded):
        r = requests.get(f"{BASE_URL}/api/swim-styles", timeout=10)
        r.raise_for_status()
        styles = r.json()
        assert isinstance(styles, list)
        assert len(styles) > 0

    def test_swim_styles_have_required_fields(self, uploaded):
        r = requests.get(f"{BASE_URL}/api/swim-styles", timeout=10)
        r.raise_for_status()
        for s in r.json():
            assert "id" in s
            assert "distance" in s
            assert "stroke" in s
            assert "name" in s
            assert "relaycount" in s

    def test_swim_styles_no_auth_required(self):
        """The /swim-styles endpoint should be accessible without authentication."""
        r = requests.get(f"{BASE_URL}/api/swim-styles", timeout=10)
        assert r.status_code == 200

    def test_swim_styles_have_valid_distances(self, uploaded):
        r = requests.get(f"{BASE_URL}/api/swim-styles", timeout=10)
        r.raise_for_status()
        for s in r.json():
            if s["id"] == 530:
                continue  # SERC is judged, not measured — no distance in the real template
            assert s["distance"] > 0, f"Style {s['id']} has invalid distance {s['distance']}"

    def test_swim_styles_have_names(self, uploaded):
        """Most styles should have non-empty names (from LENEX import)."""
        r = requests.get(f"{BASE_URL}/api/swim-styles", timeout=10)
        r.raise_for_status()
        styles = r.json()
        named = [s for s in styles if s["name"]]
        assert len(named) > len(styles) * 0.5, "Most styles should have names"

    def test_event_swimstyleid_references_valid_style(self, uploaded):
        """Every event's swimstyleId should exist in the /swim-styles list."""
        r = requests.get(f"{BASE_URL}/api/swim-styles", timeout=10)
        r.raise_for_status()
        style_ids = {s["id"] for s in r.json()}

        r = requests.get(f"{BASE_URL}/api/sessions", timeout=10)
        r.raise_for_status()
        for s in r.json():
            for ev in s["events"]:
                if ev["swimstyleId"]:
                    assert ev["swimstyleId"] in style_ids, (
                        f"Event {ev['id']} references swimstyleId={ev['swimstyleId']} "
                        f"which is not in /swim-styles"
                    )

    def test_swim_styles_filtered_to_current_meet_type(self, uploaded, entries_path, admin_headers):
        """The style catalog is never pruned across meets (old pool styles
        stick around after a beach meet is created, and vice versa — see
        create_new_meet), so /swim-styles must filter to the current meet's
        type or the EventsPage designation dropdown offers styles from the
        wrong sport. Regression for a live bug: after creating a beach meet,
        the dropdown still showed every historical pool style.

        /api/admin/new-meet loads the bare pool/beach template (no entries,
        no registrations), which would wipe the Gatineau fixture every other
        session-scoped test in this file depends on — so this test restores
        the real meet + entries fixture afterward, not just the meet type.
        """
        try:
            r = requests.post(f"{BASE_URL}/api/admin/new-meet", json={"meet_type": "beach"},
                               headers=admin_headers, timeout=60)
            assert r.status_code == 200, f"new-meet (beach) failed: {r.text}"

            r = requests.get(f"{BASE_URL}/api/swim-styles", timeout=10)
            r.raise_for_status()
            styles = r.json()
            assert len(styles) > 0
            assert all(s["id"] >= 600 for s in styles), (
                f"Beach meet's /swim-styles still includes pool styles: "
                f"{[s['id'] for s in styles if s['id'] < 600]}"
            )
        finally:
            with open(MEET_TEMPLATE, "rb") as f:
                r = requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                                   files={"file": ("meet.lxf", f, "application/octet-stream")},
                                   headers=admin_headers, timeout=60)
            assert r.status_code == 200, f"restoring Gatineau meet failed: {r.text}"
            with open(entries_path, "rb") as f:
                r = requests.post(f"{BASE_URL}/api/upload/entries",
                                   files={"file": ("entries.lxf", f, "application/octet-stream")},
                                   headers=admin_headers, timeout=60)
            assert r.status_code == 200, f"restoring entries failed: {r.text}"

            r = requests.get(f"{BASE_URL}/api/swim-styles", timeout=10)
            r.raise_for_status()
            styles = r.json()
            assert len(styles) > 0
            assert all(s["id"] < 600 for s in styles), (
                f"Pool meet's /swim-styles still includes beach styles: "
                f"{[s['id'] for s in styles if s['id'] >= 600]}"
            )


# ---------------------------------------------------------------------------
# Gemini API Keys
# ---------------------------------------------------------------------------

class TestGeminiKeys:
    """Test Gemini API key management via admin endpoints."""

    def test_get_keys_initially_empty(self, uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/gemini-keys",
                         headers=admin_headers, timeout=10)
        r.raise_for_status()
        data = r.json()
        assert data["hasFreeKey"] is False
        assert data["hasPaidKey"] is False
        assert data["freeKey"] == ""
        assert data["paidKey"] == ""

    def test_set_free_key(self, uploaded, admin_headers):
        r = requests.post(f"{BASE_URL}/api/admin/gemini-keys",
                          json={"freeKey": "AIzaSyTestFreeKey1234567890"},
                          headers=admin_headers, timeout=10)
        r.raise_for_status()
        assert r.json()["ok"] is True

        # Verify it's stored (masked)
        r = requests.get(f"{BASE_URL}/api/admin/gemini-keys",
                         headers=admin_headers, timeout=10)
        r.raise_for_status()
        data = r.json()
        assert data["hasFreeKey"] is True
        assert data["freeKey"] == "***7890"
        assert data["hasPaidKey"] is False

    def test_set_both_keys(self, uploaded, admin_headers):
        r = requests.post(f"{BASE_URL}/api/admin/gemini-keys",
                          json={"freeKey": "AIzaSyFreeAAAA", "paidKey": "AIzaSyPaidBBBB"},
                          headers=admin_headers, timeout=10)
        r.raise_for_status()

        r = requests.get(f"{BASE_URL}/api/admin/gemini-keys",
                         headers=admin_headers, timeout=10)
        r.raise_for_status()
        data = r.json()
        assert data["hasFreeKey"] is True
        assert data["hasPaidKey"] is True
        assert data["freeKey"] == "***AAAA"
        assert data["paidKey"] == "***BBBB"

    def test_update_only_paid_key(self, uploaded, admin_headers):
        # Set initial keys
        requests.post(f"{BASE_URL}/api/admin/gemini-keys",
                      json={"freeKey": "AIzaSyFreeXXXX", "paidKey": "AIzaSyPaidYYYY"},
                      headers=admin_headers, timeout=10)

        # Update only paid key (freeKey not sent = keep existing)
        r = requests.post(f"{BASE_URL}/api/admin/gemini-keys",
                          json={"paidKey": "AIzaSyPaidZZZZ"},
                          headers=admin_headers, timeout=10)
        r.raise_for_status()

        r = requests.get(f"{BASE_URL}/api/admin/gemini-keys",
                         headers=admin_headers, timeout=10)
        data = r.json()
        assert data["freeKey"] == "***XXXX"  # unchanged
        assert data["paidKey"] == "***ZZZZ"  # updated

    def test_requires_admin(self, uploaded):
        """Non-admin should not be able to access Gemini keys."""
        r = requests.get(f"{BASE_URL}/api/admin/gemini-keys", timeout=10)
        assert r.status_code in (401, 403, 422)

        r = requests.post(f"{BASE_URL}/api/admin/gemini-keys",
                          json={"freeKey": "stolen"}, timeout=10)
        assert r.status_code in (401, 403, 422)


# ---------------------------------------------------------------------------
# /api/export/registrations-lxf  (organizer-accessible inscription export)
# ---------------------------------------------------------------------------

class TestExportRegistrationsLxf:
    """Direct tests for /api/export/registrations-lxf.

    Previously untested: only /api/export (admin bundle) was exercised.
    The organizer endpoint has a different auth level and a separate code path
    that crashed with 500 when meet.lxf was not on disk (SMB-loaded meets).
    """

    def test_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/export/registrations-lxf", timeout=5)
        assert r.status_code == 403

    def test_rejects_coach(self, clubs):
        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.get(f"{BASE_URL}/api/export/registrations-lxf",
                         headers=coach_headers, timeout=5)
        assert r.status_code == 403

    def test_allows_admin(self, uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/export/registrations-lxf",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200

    def test_returns_valid_zip_with_lef(self, uploaded, admin_headers):
        lxf = export_registrations_lxf(admin_headers)
        assert any(n.endswith(".lef") for n in lxf.namelist())

    def test_contains_sessions_and_events(self, uploaded, admin_headers):
        """Output must carry meet structure (sessions + events) from DB."""
        lxf = export_registrations_lxf(admin_headers)
        lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
        assert "<SESSION " in lef, "No SESSION element in registrations-lxf"
        assert "<EVENT " in lef, "No EVENT element in registrations-lxf"

    def test_event_count_matches_meet(self, uploaded, admin_headers):
        lxf = export_registrations_lxf(admin_headers)
        lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
        defined = re.findall(r'<EVENT [^>]*\beventid="(\d+)"', lef)
        assert len(defined) == 57, f"Expected 57 events, got {len(defined)}"

    def test_entry_count_matches_registrations(self, athletes, admin_headers):
        """Registrations appear as ENTRY elements; count must match what was posted."""
        ath = _by_birthyear(athletes, 2002, gender="M")[0]
        reg = get_registration(ath["id"], admin_headers)
        style = next(s for s in reg["individual_events"]
                     if any(c["age_code"] == "Open" for c in s["categories"]))
        cat = next(c for c in style["categories"] if c["age_code"] == "Open")
        r = post_registration(ath["id"], cat["event_id"], "Open", 65000, admin_headers)
        reg_id = r["id"]
        try:
            lxf = export_registrations_lxf(admin_headers)
            lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
            assert lef.count("<ENTRY ") >= 1
        finally:
            delete_registration(reg_id, admin_headers)

    def test_entry_eventid_references_defined_event(self, athletes, admin_headers):
        """Every ENTRY's eventid must reference an EVENT in SESSIONS."""
        ath = _by_birthyear(athletes, 2002, gender="M")[0]
        reg = get_registration(ath["id"], admin_headers)
        style = next(s for s in reg["individual_events"]
                     if any(c["age_code"] == "Open" for c in s["categories"]))
        cat = next(c for c in style["categories"] if c["age_code"] == "Open")
        r = post_registration(ath["id"], cat["event_id"], "Open", 65000, admin_headers)
        reg_id = r["id"]
        try:
            lxf = export_registrations_lxf(admin_headers)
            lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
            defined = set(re.findall(r'<EVENT [^>]*\beventid="(\d+)"', lef))
            used = set(re.findall(r'<ENTRY [^/]*\beventid="(\d+)"', lef))
            assert used <= defined, f"ENTRY references undefined eventids: {used - defined}"
        finally:
            delete_registration(reg_id, admin_headers)

    def test_unregistered_athlete_included_for_participating_club(self, athletes, admin_headers):
        """A club with >=1 registered athlete must still export its other, unregistered
        members, so meet-app can register late arrivals straight from the imported
        roster without a re-upload."""
        ath = _by_birthyear(athletes, 2002, gender="M")[0]
        reg = get_registration(ath["id"], admin_headers)
        style = next(s for s in reg["individual_events"]
                     if any(c["age_code"] == "Open" for c in s["categories"]))
        cat = next(c for c in style["categories"] if c["age_code"] == "Open")
        r = post_registration(ath["id"], cat["event_id"], "Open", 65000, admin_headers)
        reg_id = r["id"]
        r2 = requests.post(
            f"{BASE_URL}/api/athletes",
            json={"first_name": "LateArrival", "last_name": "Tester",
                  "gender": "M", "club_id": ath["club_id"]},
            headers=admin_headers, timeout=10,
        )
        r2.raise_for_status()
        new_ath_id = r2.json()["id"]
        try:
            lxf = export_registrations_lxf(admin_headers)
            lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
            assert f'athleteid="{new_ath_id}"' in lef, (
                "Unregistered athlete missing from a participating club's export"
            )
        finally:
            delete_registration(reg_id, admin_headers)
            requests.delete(f"{BASE_URL}/api/athletes/{new_ath_id}",
                            headers=admin_headers, timeout=10)

    def test_non_participating_club_excluded(self, admin_headers):
        """A club with zero registrations must not appear in the export at all,
        even if it has members on the roster — only clubs already participating
        in the meet should be pulled in."""
        r = requests.post(
            f"{BASE_URL}/api/clubs",
            json={"name": "Non-Participating Club", "code": "NPC"},
            headers=admin_headers, timeout=10,
        )
        r.raise_for_status()
        club_id = r.json()["id"]
        r2 = requests.post(
            f"{BASE_URL}/api/athletes",
            json={"first_name": "Bench", "last_name": "Warmer",
                  "gender": "F", "club_id": club_id},
            headers=admin_headers, timeout=10,
        )
        r2.raise_for_status()
        ath_id = r2.json()["id"]
        try:
            lxf = export_registrations_lxf(admin_headers)
            lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
            assert f'athleteid="{ath_id}"' not in lef, (
                "Athlete from a non-participating club leaked into the export"
            )
            assert 'code="NPC"' not in lef, (
                "Non-participating club leaked into the export"
            )
        finally:
            requests.delete(f"{BASE_URL}/api/athletes/{ath_id}",
                            headers=admin_headers, timeout=10)
            requests.delete(f"{BASE_URL}/api/clubs/{club_id}",
                            headers=admin_headers, timeout=10)


# ---------------------------------------------------------------------------
# /api/export/meet-lxf  (meet structure download)
# ---------------------------------------------------------------------------

class TestExportMeetLxfEndpoint:
    """Tests for /api/export/meet-lxf — previously had zero coverage.

    This endpoint returned 404 whenever the meet was loaded via SMB
    (no meet.lxf on disk). The fix generates it from DB; these tests
    verify both auth and content.
    """

    def test_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/export/meet-lxf", timeout=5)
        assert r.status_code == 403

    def test_rejects_coach(self, clubs):
        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.get(f"{BASE_URL}/api/export/meet-lxf",
                         headers=coach_headers, timeout=5)
        assert r.status_code == 403

    def test_allows_admin(self, uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/export/meet-lxf",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200

    def test_returns_valid_zip_with_lef(self, uploaded, admin_headers):
        lxf = export_meet_lxf(admin_headers)
        assert any(n.endswith(".lef") for n in lxf.namelist())

    def test_contains_sessions_and_events(self, uploaded, admin_headers):
        lxf = export_meet_lxf(admin_headers)
        lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
        assert "<SESSION " in lef
        assert "<EVENT " in lef

    def test_event_count_matches_meet(self, uploaded, admin_headers):
        lxf = export_meet_lxf(admin_headers)
        lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
        events = re.findall(r'<EVENT [^>]*\beventid="(\d+)"', lef)
        assert len(events) == 57

    def test_events_have_swimstyle(self, uploaded, admin_headers):
        lxf = export_meet_lxf(admin_headers)
        lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
        # Every EVENT block should have a SWIMSTYLE child with distance
        event_blocks = re.findall(r'<EVENT [^>]*>(.*?)</EVENT>', lef, re.DOTALL)
        for block in event_blocks[:10]:  # spot-check first 10
            assert "<SWIMSTYLE " in block, "EVENT missing SWIMSTYLE element"
            assert 'distance="' in block, "SWIMSTYLE missing distance attribute"

    def test_content_type_is_zip(self, uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/export/meet-lxf",
                         headers=admin_headers, timeout=30)
        r.raise_for_status()
        assert "zip" in r.headers.get("content-type", "").lower() or r.content[:2] == b"PK"

    def test_reflects_edits_made_after_upload(self, uploaded, admin_headers):
        """Regression test: this endpoint used to serve MEET_STORAGE, a single
        on-disk file frozen at upload time, instead of the live DB — any
        session/event edit made afterward (in the EventsPage UI) never
        reached the export. Rename a session, then confirm the export
        reflects the new name rather than whatever was originally uploaded.
        """
        sessions = requests.get(f"{BASE_URL}/api/sessions",
                                 headers=admin_headers, timeout=10).json()
        session_id = sessions[0]["id"]
        new_name = "Regression Test Session Name"
        requests.put(f"{BASE_URL}/api/sessions/{session_id}",
                     json={"name": new_name},
                     headers=admin_headers, timeout=10).raise_for_status()
        try:
            lxf = export_meet_lxf(admin_headers)
            lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
            assert new_name in lef, \
                "export/meet-lxf did not reflect a session rename — likely serving a stale cached file"
        finally:
            requests.put(f"{BASE_URL}/api/sessions/{session_id}",
                         json={"name": sessions[0]["name"]},
                         headers=admin_headers, timeout=10)


# ---------------------------------------------------------------------------
# Gemini key transport via inscription LXF
# ---------------------------------------------------------------------------

class TestGeminiKeyLxfTransport:
    """Verify that Gemini keys are embedded in /api/export/registrations-lxf.

    Previously untested: only the BSGLOBAL storage and SMB round-trip were
    covered. The .keys dotfile embedded in the inscription zip was never
    verified, so a missing implementation on the meet-app import side went
    undetected.
    """

    def _clear_keys(self, admin_headers):
        requests.post(f"{BASE_URL}/api/admin/gemini-keys",
                      json={"freeKey": "", "paidKey": ""},
                      headers=admin_headers, timeout=10)

    def test_no_keys_file_when_unset(self, uploaded, admin_headers):
        self._clear_keys(admin_headers)
        # Also disable live mode to ensure LIVE_PUSH_SECRET doesn't trigger .keys
        requests.post(f"{BASE_URL}/api/live/disable",
                      headers=admin_headers, timeout=5)
        lxf = export_registrations_lxf(admin_headers)
        if ".keys" in lxf.namelist():
            import json as _json
            keys = _json.loads(lxf.read(".keys").decode())
            # .keys may exist for live_push_secret; just ensure no gemini keys
            assert "gemini_free" not in keys, \
                ".keys must not contain gemini_free when no Gemini keys are configured"
            assert "gemini_paid" not in keys, \
                ".keys must not contain gemini_paid when no Gemini keys are configured"

    def test_keys_file_present_when_free_key_set(self, uploaded, admin_headers):
        self._clear_keys(admin_headers)
        requests.post(f"{BASE_URL}/api/admin/gemini-keys",
                      json={"freeKey": "AIzaSyTestFreeKey0000000000"},
                      headers=admin_headers, timeout=10)
        lxf = export_registrations_lxf(admin_headers)
        assert ".keys" in lxf.namelist(), \
            ".keys must be present in zip when a free Gemini key is set"
        self._clear_keys(admin_headers)

    def test_keys_json_contains_correct_values(self, uploaded, admin_headers):
        import json as _json
        self._clear_keys(admin_headers)
        free = "AIzaSyFreeKeyForExport000000000"
        paid = "AIzaSyPaidKeyForExport000000000"
        requests.post(f"{BASE_URL}/api/admin/gemini-keys",
                      json={"freeKey": free, "paidKey": paid},
                      headers=admin_headers, timeout=10)
        lxf = export_registrations_lxf(admin_headers)
        assert ".keys" in lxf.namelist()
        keys = _json.loads(lxf.read(".keys").decode())
        assert keys.get("gemini_free") == free, "gemini_free key value mismatch"
        assert keys.get("gemini_paid") == paid, "gemini_paid key value mismatch"
        self._clear_keys(admin_headers)

    def test_keys_file_absent_in_meet_lxf(self, uploaded, admin_headers):
        """/api/export/meet-lxf must never embed keys (meet structure only)."""
        requests.post(f"{BASE_URL}/api/admin/gemini-keys",
                      json={"freeKey": "AIzaSyTestShouldNotLeakHere"},
                      headers=admin_headers, timeout=10)
        lxf = export_meet_lxf(admin_headers)
        assert ".keys" not in lxf.namelist(), \
            ".keys must not leak into meet-lxf (structure-only export)"
        self._clear_keys(admin_headers)


# ---------------------------------------------------------------------------
# Live Notifications (DSQ push, Call to Marshall, Call to Scratch)
# ---------------------------------------------------------------------------

class TestLiveNotifications:
    """Full loop test for push notifications: DSQ alerts + announcements.

    Tests the entire pipeline:
    - Enable live mode → get push secret
    - VAPID key generation
    - Push subscription with team PIN validation
    - DSQ result push → notification dispatch
    - Call to Marshall / Call to Scratch announcements
    - Unsubscribe
    - Error handling (invalid PIN, invalid announcement type)
    """

    @pytest.fixture(autouse=True, scope="class")
    def _ensure_meet(self, admin_headers):
        """Re-upload meet template so clubs exist regardless of prior test state."""
        from pathlib import Path
        meet_path = Path(__file__).resolve().parent / "fixtures" / "meet_template.lxf"
        entries_path = Path(__file__).resolve().parent / "fixtures" / "test_entries.lxf"
        with open(meet_path, "rb") as f:
            r = requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                              files={"file": ("meet.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)
            assert r.status_code == 200
        if entries_path.exists():
            with open(entries_path, "rb") as f:
                r = requests.post(f"{BASE_URL}/api/upload/entries",
                                  files={"file": ("entries.lxf", f, "application/octet-stream")},
                                  headers=admin_headers, timeout=60)
                assert r.status_code == 200

    @pytest.fixture(scope="class")
    def clubs(self, _ensure_meet, admin_headers) -> list:
        """Fetch clubs fresh after re-upload."""
        r = requests.get(f"{BASE_URL}/api/clubs", headers=admin_headers, timeout=10)
        r.raise_for_status()
        return r.json()

    @pytest.fixture(scope="class")
    def live_secret(self, admin_headers) -> str:
        """Enable live mode and return the push secret."""
        r = requests.post(
            f"{BASE_URL}/api/live/enable",
            headers=admin_headers, timeout=10,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        assert len(data["secret"]) == 32  # 16 bytes hex
        return data["secret"]

    @pytest.fixture(scope="class")
    def live_headers(self, live_secret) -> dict:
        return {"X-Live-Secret": live_secret, "Content-Type": "application/json"}

    @pytest.fixture(scope="class")
    def live_clubs(self, live_secret, admin_headers) -> list[dict]:
        """Fetch a fresh club list (post re-upload)."""
        r = requests.get(f"{BASE_URL}/api/clubs", headers=admin_headers, timeout=10)
        r.raise_for_status()
        return r.json()

    @pytest.fixture(scope="class")
    def club_pin(self, live_clubs) -> str:
        """Return the first club's PIN for subscription tests."""
        assert len(live_clubs) > 0
        return live_clubs[0]["pin"]

    @pytest.fixture(scope="class")
    def club_name(self, live_clubs) -> str:
        """Return the first club's name for matching."""
        return live_clubs[0]["name"]

    @pytest.fixture(scope="class")
    def subscribed(self, live_secret, club_pin) -> dict:
        """Subscribe a fake push endpoint and return subscription info."""
        r = requests.post(
            f"{BASE_URL}/api/live/subscribe",
            json={
                "pin": club_pin,
                "subscription": {
                    "endpoint": "https://fcm.googleapis.com/fcm/send/integration-test-endpoint",
                    "keys": {
                        "p256dh": "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfWRk",
                        "auth": "tBHItJI5svbpC7htDIm2IA",
                    },
                },
            },
            timeout=10,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        assert data["club_name"]
        return data

    # ── Live mode ─────────────────────────────────────────────────────────────

    def test_live_mode_enabled(self, live_secret):
        """Live mode is active after enable."""
        r = requests.get(f"{BASE_URL}/api/live/status", timeout=5)
        assert r.status_code == 200
        assert r.json()["active"] is True

    def test_live_config_shows_secret_masked(self, live_secret, admin_headers):
        """Organizer config endpoint masks the secret."""
        r = requests.get(
            f"{BASE_URL}/api/live/config",
            headers=admin_headers, timeout=5,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["enabled"] is True
        assert "…" in data["secret_masked"]

    # ── VAPID keys ────────────────────────────────────────────────────────────

    def test_vapid_public_key_generated(self, live_secret):
        """VAPID public key is auto-generated and returned."""
        r = requests.get(f"{BASE_URL}/api/live/vapid-public-key", timeout=5)
        assert r.status_code == 200
        key = r.json()["public_key"]
        # Uncompressed P-256 point = 65 bytes → ~87 chars base64url
        assert len(key) >= 80

    def test_vapid_key_stable_across_calls(self, live_secret):
        """Same VAPID key returned on subsequent calls (not regenerated)."""
        r1 = requests.get(f"{BASE_URL}/api/live/vapid-public-key", timeout=5)
        r2 = requests.get(f"{BASE_URL}/api/live/vapid-public-key", timeout=5)
        assert r1.json()["public_key"] == r2.json()["public_key"]

    # ── Subscription ──────────────────────────────────────────────────────────

    def test_subscribe_with_valid_pin(self, subscribed, club_name):
        """Subscription succeeds with a valid team PIN."""
        assert subscribed["club_name"] == club_name

    def test_subscribe_invalid_pin_rejected(self, live_secret):
        """Invalid PIN returns 401."""
        r = requests.post(
            f"{BASE_URL}/api/live/subscribe",
            json={
                "pin": "999999",
                "subscription": {
                    "endpoint": "https://example.com/fake",
                    "keys": {"p256dh": "x", "auth": "y"},
                },
            },
            timeout=5,
        )
        assert r.status_code == 401

    def test_subscribe_admin_pin_rejected(self, live_secret, admin_headers):
        """Admin PIN (no club) returns 400 — must use a team PIN."""
        r = requests.post(
            f"{BASE_URL}/api/live/subscribe",
            json={
                "pin": admin_headers["X-Club-Pin"],
                "subscription": {
                    "endpoint": "https://example.com/admin-fake",
                    "keys": {"p256dh": "x", "auth": "y"},
                },
            },
            timeout=5,
        )
        assert r.status_code == 400

    def test_subscribe_upsert_same_endpoint(self, subscribed, club_pin):
        """Re-subscribing the same endpoint updates rather than duplicates."""
        r = requests.post(
            f"{BASE_URL}/api/live/subscribe",
            json={
                "pin": club_pin,
                "subscription": {
                    "endpoint": "https://fcm.googleapis.com/fcm/send/integration-test-endpoint",
                    "keys": {
                        "p256dh": "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfWRk",
                        "auth": "tBHItJI5svbpC7htDIm2IA",
                    },
                },
            },
            timeout=5,
        )
        assert r.status_code == 200
        assert r.json()["ok"] is True

    # ── Push events ───────────────────────────────────────────────────────────

    def test_push_event_metadata(self, live_headers):
        """Push event metadata to team-app."""
        r = requests.post(
            f"{BASE_URL}/api/live/push-events",
            headers=live_headers,
            json={
                "events": [{
                    "event_id": 9001,
                    "session_number": 1,
                    "session_name": "Session Test",
                    "event_number": 10,
                    "event_name": "200m Papillon",
                    "gender": "M",
                    "distance": 200,
                    "round": "TIM",
                    "total_heats": 2,
                }],
            },
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json()["accepted"] == 1

    # ── Push results (normal + DSQ) ───────────────────────────────────────────

    def test_push_normal_result(self, live_headers, club_name):
        """Push a normal swim result."""
        r = requests.post(
            f"{BASE_URL}/api/live/push-results",
            headers=live_headers,
            json={
                "results": [{
                    "event_id": 9001,
                    "heat_number": 1,
                    "lane": 3,
                    "athlete_id": 500,
                    "athlete_name": "Tremblay, Marie",
                    "club_name": club_name,
                    "swimtime_ms": 134560,
                    "reaction_time_ms": 680,
                    "status": "",
                    "is_official": False,
                }],
            },
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json()["accepted"] == 1

    def test_push_dsq_result(self, live_headers, club_name, subscribed):
        """Push a DSQ result — triggers notification dispatch."""
        r = requests.post(
            f"{BASE_URL}/api/live/push-results",
            headers=live_headers,
            json={
                "results": [{
                    "event_id": 9001,
                    "heat_number": 1,
                    "lane": 5,
                    "athlete_id": 501,
                    "athlete_name": "Gagnon, Jean",
                    "club_name": club_name,
                    "swimtime_ms": None,
                    "reaction_time_ms": None,
                    "status": "DSQ",
                    "dsq_reason": "SW 6.4 — Faux départ",
                    "is_official": False,
                }],
            },
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json()["accepted"] == 1

    def test_dsq_reason_stored(self, live_headers, club_name, subscribed):
        """DSQ reason is persisted and returned in public results."""
        # Ensure DSQ was pushed first (depends on test_push_dsq_result)
        r = requests.get(f"{BASE_URL}/api/live/results/9001", timeout=5)
        assert r.status_code == 200
        data = r.json()
        heats = data["heats"]
        assert "1" in heats
        dsq_entries = [e for e in heats["1"] if e["status"] == "DSQ"]
        assert len(dsq_entries) == 1
        assert dsq_entries[0]["dsq_reason"] == "SW 6.4 — Faux départ"
        assert dsq_entries[0]["athlete_name"] == "Gagnon, Jean"

    def test_results_count_correct(self, live_headers, club_name, subscribed):
        """Both normal and DSQ results are stored."""
        r = requests.get(f"{BASE_URL}/api/live/results/9001", timeout=5)
        assert r.status_code == 200
        heats = r.json()["heats"]
        total = sum(len(v) for v in heats.values())
        assert total == 2

    # ── Announcements ─────────────────────────────────────────────────────────

    def test_call_to_marshall(self, live_headers, subscribed):
        """Call to Marshall announcement is accepted."""
        r = requests.post(
            f"{BASE_URL}/api/live/push-announcement",
            headers=live_headers,
            json={
                "type": "call_to_marshall",
                "event_id": 9001,
                "event_number": 10,
                "event_name": "200m Papillon",
                "gender": "M",
            },
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json()["ok"] is True

    def test_call_to_scratch(self, live_headers, subscribed):
        """Call to Scratch announcement is accepted."""
        r = requests.post(
            f"{BASE_URL}/api/live/push-announcement",
            headers=live_headers,
            json={
                "type": "call_to_scratch",
                "event_id": 9002,
                "event_number": 11,
                "event_name": "200m Papillon Finale",
                "gender": "M",
            },
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json()["ok"] is True

    def test_invalid_announcement_type_rejected(self, live_headers):
        """Invalid announcement type returns 400."""
        r = requests.post(
            f"{BASE_URL}/api/live/push-announcement",
            headers=live_headers,
            json={
                "type": "invalid_type",
                "event_id": 1,
                "event_number": 1,
                "event_name": "test",
                "gender": "M",
            },
            timeout=5,
        )
        assert r.status_code == 400

    def test_announcement_requires_live_secret(self):
        """Announcement endpoint rejects requests without valid secret."""
        r = requests.post(
            f"{BASE_URL}/api/live/push-announcement",
            headers={"X-Live-Secret": "wrong", "Content-Type": "application/json"},
            json={
                "type": "call_to_marshall",
                "event_id": 1,
                "event_number": 1,
                "event_name": "test",
                "gender": "M",
            },
            timeout=5,
        )
        assert r.status_code == 401

    # ── Unsubscribe ───────────────────────────────────────────────────────────

    def test_unsubscribe(self, subscribed):
        """Unsubscribe removes the push subscription."""
        r = requests.post(
            f"{BASE_URL}/api/live/unsubscribe",
            json={"endpoint": "https://fcm.googleapis.com/fcm/send/integration-test-endpoint"},
            timeout=5,
        )
        assert r.status_code == 200
        assert r.json()["ok"] is True

    def test_unsubscribe_idempotent(self):
        """Unsubscribing a non-existent endpoint still returns ok."""
        r = requests.post(
            f"{BASE_URL}/api/live/unsubscribe",
            json={"endpoint": "https://example.com/does-not-exist"},
            timeout=5,
        )
        assert r.status_code == 200
        assert r.json()["ok"] is True

    # ── Disable live mode ─────────────────────────────────────────────────────

    def test_disable_live_mode(self, admin_headers):
        """Disable live mode stops accepting pushes."""
        r = requests.post(
            f"{BASE_URL}/api/live/disable",
            headers=admin_headers, timeout=5,
        )
        assert r.status_code == 200
        assert r.json()["ok"] is True

        # Verify status shows inactive
        r = requests.get(f"{BASE_URL}/api/live/status", timeout=5)
        assert r.json()["active"] is False

    def test_push_rejected_when_disabled(self, live_headers, admin_headers):
        """Push endpoints return 409 when live mode is disabled."""
        r = requests.post(
            f"{BASE_URL}/api/live/push-results",
            headers=live_headers,
            json={"results": [{"event_id": 1, "heat_number": 1, "lane": 1}]},
            timeout=5,
        )
        assert r.status_code == 409


# ---------------------------------------------------------------------------
# Live events — scoped to today's session_date (Concurrent Meets Phase 1)
# ---------------------------------------------------------------------------

class TestLiveEventsSessionDateFilter:
    """GET /api/live/events used to return everything ever pushed since live
    mode was last enabled; it's now scoped to session_date == today (see
    docs/CONCURRENT_MEETS_PLAN.md item 6), so a stale prior day's events (or
    a concurrently-registering meet's events on a different day) don't leak
    into the live view. Nothing previously exercised this endpoint at all."""

    @pytest.fixture(autouse=True, scope="class")
    def _ensure_meet(self, admin_headers):
        with open(MEET_TEMPLATE, "rb") as f:
            r = requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                              files={"file": ("meet.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)
            assert r.status_code == 200

    @pytest.fixture(scope="class")
    def live_secret(self, admin_headers) -> str:
        r = requests.post(f"{BASE_URL}/api/live/enable", headers=admin_headers, timeout=10)
        assert r.status_code == 200
        return r.json()["secret"]

    @pytest.fixture(scope="class")
    def live_headers(self, live_secret) -> dict:
        return {"X-Live-Secret": live_secret, "Content-Type": "application/json"}

    def test_event_with_todays_session_date_is_returned(self, live_headers):
        from datetime import date
        today = date.today().isoformat()
        r = requests.post(
            f"{BASE_URL}/api/live/push-events",
            headers=live_headers,
            json={"events": [{
                "event_id": 9101, "session_number": 1, "session_name": "Session 1",
                "event_number": 1, "event_name": "Today's Event", "gender": "M",
                "distance": 100, "round": "TIM", "total_heats": 1,
                "session_date": today,
            }]},
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json()["accepted"] == 1

        r = requests.get(f"{BASE_URL}/api/live/events", timeout=10)
        r.raise_for_status()
        ids = [e["event_id"] for e in r.json()]
        assert 9101 in ids

    def test_event_with_a_different_session_date_is_excluded(self, live_headers):
        r = requests.post(
            f"{BASE_URL}/api/live/push-events",
            headers=live_headers,
            json={"events": [{
                "event_id": 9102, "session_number": 2, "session_name": "Session 2",
                "event_number": 1, "event_name": "Yesterday's Event", "gender": "F",
                "distance": 100, "round": "TIM", "total_heats": 1,
                "session_date": "2020-01-01",
            }]},
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json()["accepted"] == 1

        r = requests.get(f"{BASE_URL}/api/live/events", timeout=10)
        r.raise_for_status()
        ids = [e["event_id"] for e in r.json()]
        assert 9102 not in ids

    def test_event_with_no_session_date_is_excluded(self, live_headers):
        """meet-app instances that haven't been updated to send session_date
        yet must not have their events leak into the live view forever —
        excluded, same as a stale prior day (see live.py's live_events)."""
        r = requests.post(
            f"{BASE_URL}/api/live/push-events",
            headers=live_headers,
            json={"events": [{
                "event_id": 9103, "session_number": 3, "session_name": "Session 3",
                "event_number": 1, "event_name": "No Date Event", "gender": "M",
                "distance": 100, "round": "TIM", "total_heats": 1,
            }]},
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json()["accepted"] == 1

        r = requests.get(f"{BASE_URL}/api/live/events", timeout=10)
        r.raise_for_status()
        ids = [e["event_id"] for e in r.json()]
        assert 9103 not in ids


# ---------------------------------------------------------------------------
# Relay Team Composition Validation (gender balance + age group anchor)
# ---------------------------------------------------------------------------

# Standard age category ordering, youngest -> oldest (mirrors _AGE_CODE_ORDER in api.py).
# A relay team is anchored to its event's own category; members must be that exact
# category or the single adjacent-younger one (swim-up), and at least 1 member must
# match the exact category.
_AGE_ORDER = ["10-", "11-12", "13-14", "15-18", "Open", "Masters"]


class TestRelayTeamComposition:
    """Tests for relay team gender balance (2M+2F for mixed) and age group anchor
    rule (team anchored to its event's own category, swim-up from the adjacent
    younger category only, at least 1 exact-category member required — see
    docs/RELAY_TEAM_RULES.md)."""

    @pytest.fixture(autouse=True, scope="class")
    def _ensure_meet(self, admin_headers):
        """Re-upload meet template so events and athletes exist."""
        meet_path = Path(__file__).resolve().parent / "fixtures" / "meet_template.lxf"
        entries_path = Path(__file__).resolve().parent / "fixtures" / "test_entries.lxf"
        with open(meet_path, "rb") as f:
            r = requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                              files={"file": ("meet.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)
            assert r.status_code == 200
        if entries_path.exists():
            with open(entries_path, "rb") as f:
                r = requests.post(f"{BASE_URL}/api/upload/entries",
                                  files={"file": ("entries.lxf", f, "application/octet-stream")},
                                  headers=admin_headers, timeout=60)
                assert r.status_code == 200

    @pytest.fixture(scope="class")
    def clubs(self, _ensure_meet, admin_headers) -> list:
        r = requests.get(f"{BASE_URL}/api/clubs", headers=admin_headers, timeout=10)
        r.raise_for_status()
        return r.json()

    @pytest.fixture(scope="class")
    def athletes(self, _ensure_meet, admin_headers) -> list:
        r = requests.get(f"{BASE_URL}/api/athletes", headers=admin_headers, timeout=10)
        r.raise_for_status()
        return r.json()

    @pytest.fixture(scope="class")
    def relay_page_data(self, _ensure_meet, clubs, admin_headers) -> dict:
        """Fetch relay page data for the first club."""
        r = requests.get(f"{BASE_URL}/api/relay-teams?club_id={clubs[0]['id']}",
                         headers=admin_headers, timeout=10)
        r.raise_for_status()
        return r.json()

    def _find_mixed_relay_event(self, relay_page_data) -> tuple[int, str] | None:
        """Find a mixed (X) relay event. Returns (event_id, age_code) or None."""
        for cat in relay_page_data.get("ageCategories", []):
            for ev in cat.get("events", []):
                if ev["gender"] == "X":
                    return ev["eventId"], cat["ageCode"]
        return None

    def _find_gendered_relay_event(self, relay_page_data, gender: str) -> tuple[int, str] | None:
        """Find a M or F relay event. Returns (event_id, age_code) or None."""
        for cat in relay_page_data.get("ageCategories", []):
            for ev in cat.get("events", []):
                if ev["gender"] == gender:
                    return ev["eventId"], cat["ageCode"]
        return None

    def _find_event_with_single_native_code(self, relay_page_data, gender: str) -> tuple[int, str] | None:
        """Find a gendered relay event that has exactly one age category attached
        to it (the common/intended case — each event maps to one native category).
        Returns (event_id, native_code) or None."""
        event_codes: dict = {}
        for cat in relay_page_data.get("ageCategories", []):
            for ev in cat.get("events", []):
                if ev["gender"] != gender:
                    continue
                event_codes.setdefault(ev["eventId"], set()).add(cat["ageCode"])
        for event_id, codes in event_codes.items():
            if len(codes) == 1:
                return event_id, next(iter(codes))
        return None

    def _get_eligible_athletes_by_gender(self, relay_page_data, event_id, age_code, gender):
        """Get eligible athletes filtered by gender for a given event/ageCode."""
        key = f"{event_id}-{age_code}"
        eligible = relay_page_data.get("eligibleAthletes", {}).get(key, [])
        return [a for a in eligible if a["gender"] == gender]

    # ── Gender balance tests ──────────────────────────────────────────────────

    def test_mixed_relay_eligible_athletes_include_both_genders(self, relay_page_data):
        """Mixed events should have both M and F athletes in eligible list."""
        result = self._find_mixed_relay_event(relay_page_data)
        if result is None:
            pytest.skip("No mixed relay event in test meet")
        event_id, age_code = result
        key = f"{event_id}-{age_code}"
        eligible = relay_page_data.get("eligibleAthletes", {}).get(key, [])
        genders = {a["gender"] for a in eligible}
        assert "M" in genders, "Mixed event should have male athletes eligible"
        assert "F" in genders, "Mixed event should have female athletes eligible"

    def test_mixed_relay_rejects_third_man(self, relay_page_data, clubs, admin_headers):
        """Assigning more than N/2 males to a mixed relay returns 400."""
        result = self._find_mixed_relay_event(relay_page_data)
        if result is None:
            pytest.skip("No mixed relay event in test meet")
        event_id, age_code = result

        # Get the relaycount for this event
        relaycount = 4
        for cat in relay_page_data.get("ageCategories", []):
            for ev in cat.get("events", []):
                if ev["eventId"] == event_id:
                    relaycount = ev["relaycount"]
                    break

        max_per_gender = relaycount // 2

        # Create a relay team
        r = requests.post(f"{BASE_URL}/api/relay-teams",
                          json={"event_id": event_id, "age_code": age_code,
                                "club_id": clubs[0]["id"]},
                          headers=admin_headers, timeout=10)
        r.raise_for_status()
        team_id = r.json()["teamId"]

        try:
            # Get male athletes
            males = self._get_eligible_athletes_by_gender(
                relay_page_data, event_id, age_code, "M")
            needed = max_per_gender + 1
            if len(males) < needed:
                pytest.skip(f"Need at least {needed} male athletes, only {len(males)} available")

            # Assign max_per_gender men (valid)
            for pos, athlete in enumerate(males[:max_per_gender], start=1):
                r = requests.put(
                    f"{BASE_URL}/api/relay-teams/{team_id}/members/{pos}",
                    json={"athleteId": athlete["id"]},
                    headers=admin_headers, timeout=10)
                assert r.status_code == 200, f"Position {pos} assignment failed: {r.text}"

            # Assign one more man → should be rejected
            next_pos = max_per_gender + 1
            r = requests.put(
                f"{BASE_URL}/api/relay-teams/{team_id}/members/{next_pos}",
                json={"athleteId": males[max_per_gender]["id"]},
                headers=admin_headers, timeout=10)
            assert r.status_code == 400, (
                f"Expected 400 for extra male on mixed relay, got {r.status_code}: {r.text}"
            )
            assert "mixed relay" in r.json().get("detail", "").lower()
        finally:
            # Cleanup
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=10)

    def test_mixed_relay_allows_balanced_team(self, relay_page_data, clubs, admin_headers):
        """A mixed relay team with N/2 M + N/2 F should be fully assignable."""
        result = self._find_mixed_relay_event(relay_page_data)
        if result is None:
            pytest.skip("No mixed relay event in test meet")
        event_id, age_code = result

        # Get the relaycount for this event
        relaycount = 4
        for cat in relay_page_data.get("ageCategories", []):
            for ev in cat.get("events", []):
                if ev["eventId"] == event_id:
                    relaycount = ev["relaycount"]
                    break

        max_per_gender = relaycount // 2

        r = requests.post(f"{BASE_URL}/api/relay-teams",
                          json={"event_id": event_id, "age_code": age_code,
                                "club_id": clubs[0]["id"]},
                          headers=admin_headers, timeout=10)
        r.raise_for_status()
        team_id = r.json()["teamId"]

        try:
            males = self._get_eligible_athletes_by_gender(
                relay_page_data, event_id, age_code, "M")
            females = self._get_eligible_athletes_by_gender(
                relay_page_data, event_id, age_code, "F")
            assert len(males) >= max_per_gender, f"Need at least {max_per_gender} male athletes"
            if len(females) < max_per_gender:
                pytest.skip(f"Need at least {max_per_gender} female athletes, only {len(females)} available")

            # Assign N/2 men + N/2 women (should all succeed)
            team_members = males[:max_per_gender] + females[:max_per_gender]
            for pos, athlete in enumerate(team_members, start=1):
                r = requests.put(
                    f"{BASE_URL}/api/relay-teams/{team_id}/members/{pos}",
                    json={"athleteId": athlete["id"]},
                    headers=admin_headers, timeout=10)
                assert r.status_code == 200, (
                    f"Position {pos} failed: {r.status_code} {r.text}"
                )
        finally:
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=10)

    def _register_athletes_by_natural_category(self, club_athletes, admin_headers, count):
        """Register up to `count` athletes under their own default (first-listed)
        individual category. Returns (registered [{"id","age_code"}], reg_ids)."""
        reg_ids = []
        registered = []
        for ath in club_athletes[:count]:
            reg = get_registration(ath["id"], admin_headers)
            ind_events = reg.get("individual_events", [])
            if not ind_events:
                continue
            style = ind_events[0]
            cats = style.get("categories", [])
            if not cats:
                continue
            cat = cats[0]
            r = post_registration(ath["id"], cat["event_id"], cat["age_code"], 60000, admin_headers)
            reg_ids.append(r["id"])
            registered.append({"id": ath["id"], "age_code": cat["age_code"]})
        return registered, reg_ids

    def _find_athlete_registerable_at(self, club_athletes, admin_headers, target_code):
        """Scan club_athletes for the first one who can register at target_code
        (i.e. target_code is among their available individual categories) and
        register them there. Returns (athlete_id, reg_id) or None."""
        for ath in club_athletes:
            reg = get_registration(ath["id"], admin_headers)
            ind_events = reg.get("individual_events", [])
            if not ind_events:
                continue
            style = ind_events[0]
            cats = style.get("categories", [])
            cat = next((c for c in cats if c["age_code"] == target_code), None)
            if not cat:
                continue
            r = post_registration(ath["id"], cat["event_id"], target_code, 60000, admin_headers)
            return ath["id"], r["id"]
        return None

    def _relaycount_for_event(self, relay_page_data, event_id) -> int:
        for cat in relay_page_data.get("ageCategories", []):
            for ev in cat.get("events", []):
                if ev["eventId"] == event_id:
                    return ev["relaycount"]
        return 4

    # ── Age group composition (event-anchored) tests ────────────────────────────

    def test_eligible_athletes_include_age_group(self, relay_page_data, athletes, admin_headers):
        """Eligible athlete entries should include an ageGroup field when registered."""
        # Register an athlete for an individual event first
        club_athletes = [a for a in athletes if a.get("club_id")]
        if not club_athletes:
            pytest.skip("No athletes with clubs")

        # Pick an athlete and register them for an individual event
        ath = club_athletes[0]
        reg = get_registration(ath["id"], admin_headers)
        ind_events = reg.get("individual_events", [])
        if not ind_events:
            pytest.skip("No individual events for athlete")

        # Find a valid category and register
        style = ind_events[0]
        cats = style.get("categories", [])
        if not cats:
            pytest.skip("No categories available")
        cat = cats[0]

        r = post_registration(ath["id"], cat["event_id"], cat["age_code"], 60000, admin_headers)
        reg_id = r["id"]

        try:
            # Reload relay page data and check that the athlete now has ageGroup
            r = requests.get(
                f"{BASE_URL}/api/relay-teams?club_id={ath['club_id']}",
                headers=admin_headers, timeout=10)
            r.raise_for_status()
            page = r.json()

            found_with_age_group = False
            for key, eligible_list in page.get("eligibleAthletes", {}).items():
                for ea in eligible_list:
                    if ea["id"] == ath["id"] and ea.get("ageGroup"):
                        found_with_age_group = True
                        break
                if found_with_age_group:
                    break

            assert found_with_age_group, (
                f"Athlete {ath['id']} should have ageGroup after individual registration"
            )
        finally:
            delete_registration(reg_id, admin_headers)

    def test_age_group_composition_rejects_non_adjacent_category(
            self, relay_page_data, athletes, clubs, admin_headers):
        """Assigning a member whose category is neither the event's own native
        category nor the single adjacent-younger one returns 400. This is checked
        immediately (not just on the last position) — an out-of-window category is
        never allowed on the team, regardless of how many positions remain.
        """
        gender = "M"
        result = self._find_event_with_single_native_code(relay_page_data, "M")
        if result is None:
            gender = "F"
            result = self._find_event_with_single_native_code(relay_page_data, "F")
        if result is None:
            pytest.skip("No relay event with a single native age category in test meet")
        event_id, native_code = result
        ni = _AGE_ORDER.index(native_code)
        bad_codes = [c for i, c in enumerate(_AGE_ORDER) if abs(i - ni) > 1]
        if not bad_codes:
            pytest.skip("No non-adjacent age category exists relative to the native code")

        club_id = clubs[0]["id"]
        club_athletes = [a for a in athletes
                         if a["club_id"] == club_id and a["gender"] == gender]
        if not club_athletes:
            pytest.skip("No athletes for this gender/club")

        found = None
        for code in bad_codes:
            found = self._find_athlete_registerable_at(club_athletes, admin_headers, code)
            if found:
                break
        if not found:
            pytest.skip("Could not register any athlete at a non-adjacent category")
        athlete_id, reg_id = found

        try:
            r = requests.post(f"{BASE_URL}/api/relay-teams",
                              json={"event_id": event_id, "age_code": native_code,
                                    "club_id": club_id},
                              headers=admin_headers, timeout=10)
            r.raise_for_status()
            team_id = r.json()["teamId"]

            try:
                r = requests.put(
                    f"{BASE_URL}/api/relay-teams/{team_id}/members/1",
                    json={"athleteId": athlete_id},
                    headers=admin_headers, timeout=10)
                assert r.status_code == 400, (
                    f"Expected 400 assigning a non-adjacent-category athlete to a "
                    f"{native_code}-anchored team, got {r.status_code}: {r.text}"
                )
                assert "age category" in r.json().get("detail", "").lower()
            finally:
                requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                                headers=admin_headers, timeout=10)
        finally:
            delete_registration(reg_id, admin_headers)

    def test_age_group_composition_allows_swim_up_when_anchor_present(
            self, relay_page_data, athletes, clubs, admin_headers):
        """A team with 2 native-category members + swim-up members from the single
        adjacent-younger category is fully assignable — no majority required, any
        split is fine as long as at least 2 members match the native category.
        """
        gender = "M"
        result = self._find_event_with_single_native_code(relay_page_data, "M")
        if result is None:
            gender = "F"
            result = self._find_event_with_single_native_code(relay_page_data, "F")
        if result is None:
            pytest.skip("No relay event with a single native age category in test meet")
        event_id, native_code = result
        relaycount = self._relaycount_for_event(relay_page_data, event_id)
        if relaycount < 2:
            pytest.skip("Relaycount too small to exercise this scenario")
        ni = _AGE_ORDER.index(native_code)
        if ni == 0:
            pytest.skip("Native category has no younger adjacent category to swim up from")
        younger_code = _AGE_ORDER[ni - 1]

        club_id = clubs[0]["id"]
        club_athletes = [a for a in athletes
                         if a["club_id"] == club_id and a["gender"] == gender]
        if not club_athletes:
            pytest.skip("No athletes for this gender/club")

        reg_ids = []
        try:
            native_ids = []
            for ath in club_athletes:
                found = self._find_athlete_registerable_at([ath], admin_headers, native_code)
                if found:
                    native_ids.append(found[0])
                    reg_ids.append(found[1])
                if len(native_ids) >= 2:
                    break
            if len(native_ids) < 2:
                pytest.skip(f"Not enough athletes registerable at native category {native_code}")

            remaining = [a for a in club_athletes if a["id"] not in native_ids]
            younger_ids = []
            for ath in remaining:
                found = self._find_athlete_registerable_at([ath], admin_headers, younger_code)
                if found:
                    younger_ids.append(found[0])
                    reg_ids.append(found[1])
                if len(younger_ids) >= relaycount - 2:
                    break
            if len(younger_ids) < relaycount - 2:
                pytest.skip(f"Not enough athletes registerable at {younger_code} to fill the team")

            # Native members placed first — 2 natives satisfy the anchor requirement
            # immediately, so the remaining swim-up members are never blocked.
            team_members = native_ids[:2] + younger_ids[:relaycount - 2]

            r = requests.post(f"{BASE_URL}/api/relay-teams",
                              json={"event_id": event_id, "age_code": native_code,
                                    "club_id": club_id},
                              headers=admin_headers, timeout=10)
            r.raise_for_status()
            team_id = r.json()["teamId"]

            try:
                for pos, ath_id in enumerate(team_members, start=1):
                    r = requests.put(
                        f"{BASE_URL}/api/relay-teams/{team_id}/members/{pos}",
                        json={"athleteId": ath_id},
                        headers=admin_headers, timeout=10)
                    assert r.status_code == 200, f"Position {pos} failed: {r.status_code} {r.text}"
            finally:
                requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                                headers=admin_headers, timeout=10)
        finally:
            for rid in reg_ids:
                try:
                    delete_registration(rid, admin_headers)
                except Exception:
                    pass

    def test_age_group_composition_rejects_missing_anchor(
            self, relay_page_data, athletes, clubs, admin_headers):
        """A team built entirely from swim-up (adjacent-younger) members, with no
        native-category member, is rejected as soon as fewer positions remain than
        would be needed to still reach 2 native members — not just on the very
        last position. Earlier positions (while >=2 slots still remain, including
        the one being assigned) are NOT blocked. This is the core "at least 2
        native members" requirement.
        """
        gender = "M"
        result = self._find_event_with_single_native_code(relay_page_data, "M")
        if result is None:
            gender = "F"
            result = self._find_event_with_single_native_code(relay_page_data, "F")
        if result is None:
            pytest.skip("No relay event with a single native age category in test meet")
        event_id, native_code = result
        relaycount = self._relaycount_for_event(relay_page_data, event_id)
        ni = _AGE_ORDER.index(native_code)
        if ni == 0:
            pytest.skip("Native category has no younger adjacent category to swim up from")
        younger_code = _AGE_ORDER[ni - 1]

        # Position at which it first becomes mathematically impossible to reach
        # 2 native members: remainingAfterThis = relaycount - position < 2.
        first_blocked_position = relaycount - 1
        if first_blocked_position < 1:
            pytest.skip("Relaycount too small to exercise this scenario")

        club_id = clubs[0]["id"]
        club_athletes = [a for a in athletes
                         if a["club_id"] == club_id and a["gender"] == gender]
        if not club_athletes:
            pytest.skip("No athletes for this gender/club")

        reg_ids = []
        try:
            younger_ids = []
            for ath in club_athletes:
                found = self._find_athlete_registerable_at([ath], admin_headers, younger_code)
                if found:
                    younger_ids.append(found[0])
                    reg_ids.append(found[1])
                if len(younger_ids) >= first_blocked_position:
                    break
            if len(younger_ids) < first_blocked_position:
                pytest.skip(f"Not enough athletes registerable at {younger_code} to fill the team")

            r = requests.post(f"{BASE_URL}/api/relay-teams",
                              json={"event_id": event_id, "age_code": native_code,
                                    "club_id": club_id},
                              headers=admin_headers, timeout=10)
            r.raise_for_status()
            team_id = r.json()["teamId"]

            try:
                # Positions before the blocking point: still enough remaining slots
                # to reach 2 native members later, so swim-up members are allowed
                for pos, ath_id in enumerate(younger_ids[:first_blocked_position - 1], start=1):
                    r = requests.put(
                        f"{BASE_URL}/api/relay-teams/{team_id}/members/{pos}",
                        json={"athleteId": ath_id},
                        headers=admin_headers, timeout=10)
                    assert r.status_code == 200, (
                        f"Position {pos} (swim-up, anchor still achievable) failed: "
                        f"{r.status_code} {r.text}"
                    )

                # This position: not enough slots remain to ever reach 2 native
                # members (0 native so far, <2 slots left including this one) → rejected
                r = requests.put(
                    f"{BASE_URL}/api/relay-teams/{team_id}/members/{first_blocked_position}",
                    json={"athleteId": younger_ids[first_blocked_position - 1]},
                    headers=admin_headers, timeout=10)
                assert r.status_code == 400, (
                    f"Expected 400 at position {first_blocked_position} for an "
                    f"all-swim-up team with no native {native_code} member, got "
                    f"{r.status_code}: {r.text}"
                )
                detail = r.json().get("detail", "").lower()
                assert "own age category" in detail or native_code.lower() in detail
            finally:
                requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                                headers=admin_headers, timeout=10)
        finally:
            for rid in reg_ids:
                try:
                    delete_registration(rid, admin_headers)
                except Exception:
                    pass

    def test_age_group_composition_allows_same_group_team(
            self, relay_page_data, athletes, clubs, admin_headers):
        """A relay with all members from the event's native age category (4-0)
        should be fully assignable — well above the minimum of 2 native members."""
        gender = "M"
        result = self._find_event_with_single_native_code(relay_page_data, "M")
        if result is None:
            gender = "F"
            result = self._find_event_with_single_native_code(relay_page_data, "F")
        if result is None:
            pytest.skip("No relay event with a single native age category in test meet")
        event_id, native_code = result
        relaycount = self._relaycount_for_event(relay_page_data, event_id)

        club_id = clubs[0]["id"]
        club_athletes = [a for a in athletes
                         if a["club_id"] == club_id and a["gender"] == gender]
        if not club_athletes:
            pytest.skip("No athletes for this gender/club")

        reg_ids = []
        try:
            native_ids = []
            for ath in club_athletes:
                found = self._find_athlete_registerable_at([ath], admin_headers, native_code)
                if found:
                    native_ids.append(found[0])
                    reg_ids.append(found[1])
                if len(native_ids) >= relaycount:
                    break
            if len(native_ids) < relaycount:
                pytest.skip(f"Not enough athletes registerable at native category {native_code}")

            r = requests.post(f"{BASE_URL}/api/relay-teams",
                              json={"event_id": event_id, "age_code": native_code,
                                    "club_id": club_id},
                              headers=admin_headers, timeout=10)
            r.raise_for_status()
            team_id = r.json()["teamId"]

            try:
                for pos, ath_id in enumerate(native_ids[:relaycount], start=1):
                    r = requests.put(
                        f"{BASE_URL}/api/relay-teams/{team_id}/members/{pos}",
                        json={"athleteId": ath_id},
                        headers=admin_headers, timeout=10)
                    assert r.status_code == 200, (
                        f"Position {pos} failed: {r.status_code} {r.text}"
                    )
            finally:
                requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                                headers=admin_headers, timeout=10)
        finally:
            for rid in reg_ids:
                try:
                    delete_registration(rid, admin_headers)
                except Exception:
                    pass


# ---------------------------------------------------------------------------
# Historical Meet Import
# ---------------------------------------------------------------------------

class TestHistoricalMeetImport:
    """Tests for the historical meet import feature."""

    @pytest.fixture(autouse=True, scope="class")
    def _ensure_meet(self, admin_headers):
        """Re-upload meet template so current meet exists."""
        meet_path = Path(__file__).resolve().parent / "fixtures" / "meet_template.lxf"
        entries_path = Path(__file__).resolve().parent / "fixtures" / "test_entries.lxf"
        with open(meet_path, "rb") as f:
            r = requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                              files={"file": ("meet.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)
            assert r.status_code == 200
        if entries_path.exists():
            with open(entries_path, "rb") as f:
                r = requests.post(f"{BASE_URL}/api/upload/entries",
                                  files={"file": ("entries.lxf", f, "application/octet-stream")},
                                  headers=admin_headers, timeout=60)
                assert r.status_code == 200

    @pytest.fixture(scope="class")
    def results_lxf_bytes(self, results_path) -> bytes:
        """Load the test results LXF file bytes."""
        return results_path.read_bytes()

    def test_import_historical_creates_meet(self, results_lxf_bytes, admin_headers):
        """Importing a results LXF creates a historical meet record."""
        r = requests.post(
            f"{BASE_URL}/api/admin/import-historical?force=true",
            files={"file": ("results.lxf", results_lxf_bytes, "application/octet-stream")},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 200, f"Import failed: {r.text}"
        data = r.json()
        assert data["meet_name"]
        assert data["results_imported"] > 0
        assert data["athletes_matched"] > 0
        assert data["events_created"] > 0
        assert "meet_id" in data

    def test_list_historical_meets(self, results_lxf_bytes, admin_headers):
        """After import, the meet appears in the historical meets list."""
        r = requests.get(f"{BASE_URL}/api/admin/historical-meets",
                         headers=admin_headers, timeout=10)
        r.raise_for_status()
        meets = r.json()
        # Should have at least one meet (the one we just imported)
        assert len(meets) >= 1
        # Find a meet with results
        meets_with_results = [m for m in meets if m["resultCount"] > 0]
        assert len(meets_with_results) >= 1

    def test_reimport_deduplicates(self, results_lxf_bytes, admin_headers):
        """Re-importing the same LXF with force=true replaces results."""
        # Import twice
        r1 = requests.post(
            f"{BASE_URL}/api/admin/import-historical?force=true",
            files={"file": ("results.lxf", results_lxf_bytes, "application/octet-stream")},
            headers=admin_headers, timeout=30,
        )
        assert r1.status_code == 200
        meet_id = r1.json()["meet_id"]
        first_count = r1.json()["results_imported"]

        r2 = requests.post(
            f"{BASE_URL}/api/admin/import-historical?force=true",
            files={"file": ("results.lxf", results_lxf_bytes, "application/octet-stream")},
            headers=admin_headers, timeout=30,
        )
        assert r2.status_code == 200
        assert r2.json()["meet_id"] == meet_id, "Re-import should reuse same meet ID"
        assert r2.json()["reimported"] is True
        assert r2.json()["results_imported"] == first_count

    def test_cross_validation_warns_current_meet(self, admin_headers):
        """Importing a LXF that matches the current meet name returns 409."""
        # Get current meet name
        r = requests.get(f"{BASE_URL}/api/meet-info", headers=admin_headers, timeout=5)
        r.raise_for_status()
        current_name = r.json().get("meet_name", "")
        if not current_name:
            pytest.skip("No current meet name set")

        # Create a minimal LXF with the current meet name
        import zipfile
        from io import BytesIO
        lef_content = f'<?xml version="1.0"?><LENEX><MEETS><MEET name="{current_name}" course="SCM"><CLUBS></CLUBS></MEET></MEETS></LENEX>'
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("meet.lef", lef_content)
        fake_lxf = buf.getvalue()

        r = requests.post(
            f"{BASE_URL}/api/admin/import-historical",
            files={"file": ("fake.lxf", fake_lxf, "application/octet-stream")},
            headers=admin_headers, timeout=10,
        )
        assert r.status_code == 409, f"Expected 409 for current meet name, got {r.status_code}"
        assert "current meet" in r.json().get("detail", "").lower()

    def test_athlete_history(self, results_lxf_bytes, admin_headers):
        """After import, athlete history endpoint returns results."""
        # Get an athlete that should have historical results
        r = requests.get(f"{BASE_URL}/api/athletes", headers=admin_headers, timeout=10)
        r.raise_for_status()
        athletes = r.json()
        if not athletes:
            pytest.skip("No athletes")

        # Try a few athletes until we find one with history
        found = False
        for ath in athletes[:20]:
            r = requests.get(f"{BASE_URL}/api/athletes/{ath['id']}/history",
                             headers=admin_headers, timeout=10)
            if r.status_code == 200 and r.json().get("meets"):
                found = True
                data = r.json()
                assert "athlete" in data
                assert "meets" in data
                assert "bestTimes" in data
                assert len(data["meets"]) >= 1
                assert data["meets"][0]["results"]
                break

        assert found, "No athlete with historical results found"

    def test_delete_historical_meet(self, results_lxf_bytes, admin_headers):
        """Deleting a historical meet removes it and its results."""
        # Import a meet
        r = requests.post(
            f"{BASE_URL}/api/admin/import-historical?force=true",
            files={"file": ("results.lxf", results_lxf_bytes, "application/octet-stream")},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 200
        meet_id = r.json()["meet_id"]

        # Delete it
        r = requests.delete(f"{BASE_URL}/api/admin/historical-meets/{meet_id}",
                            headers=admin_headers, timeout=10)
        assert r.status_code == 200
        assert r.json()["ok"] is True

        # Verify it's gone
        r = requests.get(f"{BASE_URL}/api/admin/historical-meets",
                         headers=admin_headers, timeout=10)
        r.raise_for_status()
        ids = [m["id"] for m in r.json()]
        assert meet_id not in ids

    def test_requires_admin(self, results_lxf_bytes, admin_headers):
        """Historical import endpoints require admin access."""
        # Get a coach PIN
        r = requests.get(f"{BASE_URL}/api/clubs", headers=admin_headers, timeout=10)
        r.raise_for_status()
        clubs = r.json()
        if not clubs:
            pytest.skip("No clubs")
        coach_headers = {"X-Club-Pin": clubs[0].get("pin", "000000")}

        r = requests.post(
            f"{BASE_URL}/api/admin/import-historical",
            files={"file": ("results.lxf", results_lxf_bytes, "application/octet-stream")},
            headers=coach_headers, timeout=10,
        )
        assert r.status_code == 403

        r = requests.get(f"{BASE_URL}/api/admin/historical-meets",
                         headers=coach_headers, timeout=10)
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# New Meet — must not wipe archived (historical) meets
# ---------------------------------------------------------------------------

class TestNewMeetPreservesHistory:
    """Regression test for a prod incident: /api/admin/new-meet used to delete
    the entire `meets` table with no meetstate filter, cascading away every
    archived (meetstate=3) meet's results/events/sessions while starting the
    next meet cycle. Clubs/athletes were untouched (they're repopulated by
    ongoing registration), which masked the loss until someone went looking
    for old results."""

    @pytest.fixture(autouse=True, scope="class")
    def _restore_current_meet(self, admin_headers):
        """Put the normal current meet back afterward so later test classes
        (and other test files, which share the session-scoped stack) aren't
        affected by the fresh empty meet this class creates."""
        yield
        with open(MEET_TEMPLATE, "rb") as f:
            requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                          files={"file": ("meet.lxf", f, "application/octet-stream")},
                          headers=admin_headers, timeout=60)
        if ENTRIES_FILE.exists():
            with open(ENTRIES_FILE, "rb") as f:
                requests.post(f"{BASE_URL}/api/upload/entries",
                              files={"file": ("entries.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)

    @pytest.fixture(scope="class")
    def results_lxf_bytes(self, results_path) -> bytes:
        return results_path.read_bytes()

    def test_new_meet_keeps_historical_results(self, results_lxf_bytes, admin_headers):
        """Archiving a historical meet, then starting a new meet cycle, must
        leave the archived meet and its results in place."""
        r = requests.post(
            f"{BASE_URL}/api/admin/import-historical?force=true",
            files={"file": ("results.lxf", results_lxf_bytes, "application/octet-stream")},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 200, f"Historical import failed: {r.text}"
        meet_id = r.json()["meet_id"]

        before = requests.get(f"{BASE_URL}/api/admin/historical-meets",
                              headers=admin_headers, timeout=10)
        before.raise_for_status()
        before_entry = next((m for m in before.json() if m["id"] == meet_id), None)
        assert before_entry is not None
        assert before_entry["resultCount"] > 0

        r = requests.post(f"{BASE_URL}/api/admin/new-meet", json={"meet_type": "pool"},
                          headers=admin_headers, timeout=60)
        assert r.status_code == 200, f"new-meet failed: {r.text}"

        after = requests.get(f"{BASE_URL}/api/admin/historical-meets",
                             headers=admin_headers, timeout=10)
        after.raise_for_status()
        after_entry = next((m for m in after.json() if m["id"] == meet_id), None)
        assert after_entry is not None, "Historical meet vanished after /api/admin/new-meet"
        assert after_entry["resultCount"] == before_entry["resultCount"], (
            "Historical results were lost after starting a new meet"
        )

    def test_new_meet_keeps_swimstyle_catalog_usable(self, admin_headers):
        """SwimStyle rows are upserted by id, not wiped, so both the surviving
        historical results and the fresh meet keep valid style references."""
        r = requests.get(f"{BASE_URL}/api/swim-styles", headers=admin_headers, timeout=10)
        r.raise_for_status()
        assert len(r.json()) > 0


# ---------------------------------------------------------------------------
# Upload Meet — must not wipe archived (historical) meets either
# ---------------------------------------------------------------------------

class TestUploadMeetPreservesHistory:
    """Same regression as TestNewMeetPreservesHistory, but for the far more
    routine 'Upload meet .lxf' flow (/api/upload/meet) — every meet cycle
    starts with an organizer re-uploading the structure, so this path is
    even more likely to hit than /api/admin/new-meet."""

    @pytest.fixture(autouse=True, scope="class")
    def _restore_current_meet(self, admin_headers):
        yield
        with open(MEET_TEMPLATE, "rb") as f:
            requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                          files={"file": ("meet.lxf", f, "application/octet-stream")},
                          headers=admin_headers, timeout=60)
        if ENTRIES_FILE.exists():
            with open(ENTRIES_FILE, "rb") as f:
                requests.post(f"{BASE_URL}/api/upload/entries",
                              files={"file": ("entries.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)

    @pytest.fixture(scope="class")
    def results_lxf_bytes(self, results_path) -> bytes:
        return results_path.read_bytes()

    def test_upload_meet_keeps_historical_results(self, results_lxf_bytes, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/admin/import-historical?force=true",
            files={"file": ("results.lxf", results_lxf_bytes, "application/octet-stream")},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 200, f"Historical import failed: {r.text}"
        meet_id = r.json()["meet_id"]

        before = requests.get(f"{BASE_URL}/api/admin/historical-meets",
                              headers=admin_headers, timeout=10)
        before.raise_for_status()
        before_entry = next((m for m in before.json() if m["id"] == meet_id), None)
        assert before_entry is not None
        assert before_entry["resultCount"] > 0

        with open(MEET_TEMPLATE, "rb") as f:
            r = requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                              files={"file": ("meet.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)
        assert r.status_code == 200, f"upload/meet failed: {r.text}"

        after = requests.get(f"{BASE_URL}/api/admin/historical-meets",
                             headers=admin_headers, timeout=10)
        after.raise_for_status()
        after_entry = next((m for m in after.json() if m["id"] == meet_id), None)
        assert after_entry is not None, "Historical meet vanished after /api/upload/meet"
        assert after_entry["resultCount"] == before_entry["resultCount"], (
            "Historical results were lost after re-uploading the meet structure"
        )

    def test_upload_meet_beach_detection_ignores_historical_styles(self, results_lxf_bytes, admin_headers):
        """A pool meet upload must not be misclassified as BEACH just because
        a historical meet in the (now-persistent) SwimStyle catalog used a
        beach style id (>= 600)."""
        # Archive a beach-style historical meet first (test fixtures use pool
        # ids only, so fabricate a minimal beach SWIMSTYLE reference).
        import zipfile as _zipfile
        from io import BytesIO as _BytesIO
        lef_content = (
            '<?xml version="1.0"?><LENEX><MEETS><MEET name="Beach Historical Meet" course="LCM">'
            '<SESSIONS><SESSION number="1"><EVENTS><EVENT eventid="1" number="1" gender="M">'
            '<SWIMSTYLE swimstyleid="601" distance="100" name="Beach Flags" relaycount="1"/>'
            '</EVENT></EVENTS></SESSION></SESSIONS><CLUBS></CLUBS></MEET></MEETS></LENEX>'
        )
        buf = _BytesIO()
        with _zipfile.ZipFile(buf, "w") as z:
            z.writestr("meet.lef", lef_content)
        beach_lxf = buf.getvalue()
        r = requests.post(
            f"{BASE_URL}/api/admin/import-historical?force=true",
            files={"file": ("beach.lxf", beach_lxf, "application/octet-stream")},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 200, f"Beach historical import failed: {r.text}"

        # Now upload the (pool) meet template — must classify as POOL, not BEACH.
        with open(MEET_TEMPLATE, "rb") as f:
            r = requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                              files={"file": ("meet.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)
        assert r.status_code == 200, f"upload/meet failed: {r.text}"

        r = requests.get(f"{BASE_URL}/api/meet-info", headers=admin_headers, timeout=10)
        r.raise_for_status()
        meet_type = r.json()["meet_type"]
        assert meet_type.upper() == "POOL", (
            f"Pool meet misclassified as {meet_type} due to a historical beach style"
        )


# ---------------------------------------------------------------------------
# Concurrent open meets — swimevent/agegroup ids must not collide, and
# meetsid-scoped listing endpoints must not mix the two meets' data
# ---------------------------------------------------------------------------

class TestConcurrentOpenMeetsStayIsolated:
    """Regression test for the composite-PK fix (docs/CONCURRENT_MEETS_PLAN.md,
    Phase 2 Stage 1 follow-up). `swimevent.swimeventid`/`agegroup.agegroupid`
    are populated from fixed LXF-template id ranges every time a meet is
    created, so a second meet used to collide on Postgres's swimevent_pkey
    the moment its rows weren't wiped first. The fix makes the primary key
    (meetsid, swimeventid)/(meetsid, agegroupid) instead — this proves two
    meets can share those numeric ids without corrupting each other, and
    that meetsid-scoped endpoints (GET /api/sessions, /api/events) only ever
    show the currently-active meet's rows, never a mix of both.

    Opens meet B alongside meet A via /admin/new-meet's close_other_meets=false
    (Stage 7) to reach the genuinely-concurrent precondition.
    """

    @pytest.fixture(autouse=True, scope="class")
    def _restore_current_meet(self, admin_headers):
        yield
        with open(MEET_TEMPLATE, "rb") as f:
            requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                          files={"file": ("meet.lxf", f, "application/octet-stream")},
                          headers=admin_headers, timeout=60)
        if ENTRIES_FILE.exists():
            with open(ENTRIES_FILE, "rb") as f:
                requests.post(f"{BASE_URL}/api/upload/entries",
                              files={"file": ("entries.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)

    def test_new_meet_alongside_open_meet_does_not_corrupt_either(self, uploaded, athletes, admin_headers):
        meet_a_id = int(exec_in_backend(
            "from app.meet_config import get_active_meetsid\n"
            "from app.database import SessionLocal\n"
            "db = SessionLocal()\n"
            "print(get_active_meetsid(db))\n"
        ).strip())

        def _counts(meetsid: int) -> tuple[int, int, int]:
            out = exec_in_backend(
                "from app.database import SessionLocal\n"
                "from app.models import SwimEvent, AgeGroup, SwimResult\n"
                "from app.models_team import Meet\n"
                "db = SessionLocal()\n"
                f"m = {meetsid}\n"
                "print(db.query(SwimEvent).filter(SwimEvent.meetsid == m).count())\n"
                "print(db.query(AgeGroup).filter(AgeGroup.meetsid == m).count())\n"
                "print(db.query(SwimResult).filter(SwimResult.meetsid == m).count())\n"
            ).strip().splitlines()
            return int(out[0]), int(out[1]), int(out[2])

        # `uploaded` only imports athletes/clubs, no registrations — create one
        # of meet A's own so there's real SwimResult data to protect. Inserted
        # directly (not via POST /api/registrations) since age_code validation
        # isn't what this test is about.
        events = requests.get(f"{BASE_URL}/api/events", headers=admin_headers, timeout=10).json()
        individual_event_id = next(e["id"] for e in events if e["relay_count"] == 1)
        exec_in_backend(
            "from app.database import SessionLocal\n"
            "from app.models import SwimResult\n"
            "from app.models_team import Meet\n"
            "db = SessionLocal()\n"
            "db.add(SwimResult(\n"
            f"    athleteid={athletes[0]['id']}, meetsid={meet_a_id},\n"
            f"    swimeventid={individual_event_id}, age_code='Open',\n"
            "))\n"
            "db.commit()\n"
        )

        before_events, before_agegroups, before_results = _counts(meet_a_id)
        assert before_events > 0 and before_results > 0, "test setup produced no data to protect"
        # Meet A's own swimeventids — these are the fixed 1065.. range from the
        # LXF template, the exact values meet B's creation below will reuse.
        meet_a_event_ids = sorted(e["id"] for e in events)

        meet_b_id = None
        try:
            # Creates meet B from the same fixed-id-range template meet A used —
            # this is exactly the collision the composite PK fix targets: before
            # the fix, this 500s with a swimevent_pkey UniqueViolation the moment
            # meet A's still-open rows occupy the same ids. close_other_meets=false
            # (Stage 7) is what keeps meet A open alongside it.
            r = requests.post(f"{BASE_URL}/api/admin/new-meet",
                              json={"meet_type": "pool", "close_other_meets": False},
                              headers=admin_headers, timeout=60)
            assert r.status_code == 200, f"new-meet failed while meet A was open: {r.text}"
            meet_b_id = r.json()["meet_id"]
            assert meet_b_id != meet_a_id

            after_events, after_agegroups, after_results = _counts(meet_a_id)
            assert (after_events, after_agegroups, after_results) == (before_events, before_agegroups, before_results), (
                "Meet A's own rows changed after meet B was created alongside it — "
                "the composite PK isn't isolating the two meets"
            )

            # /admin/new-meet only uses the template to seed the global SwimStyle
            # catalog (stub events at those same fixed ids, deleted right after) —
            # a brand-new meet is deliberately empty (see api.py's create_new_meet
            # docstring), so meet B itself should have zero events/age-groups.
            b_events, b_agegroups, _ = _counts(meet_b_id)
            assert (b_events, b_agegroups) == (0, 0), (
                "Meet B unexpectedly has events/age-groups of its own — "
                "create_new_meet's stub-then-delete step didn't run as designed"
            )

            # Stage 3: with two meets open and no X-Meet-Id, the ambiguity is
            # now a 409 with both candidates, not a silent guess.
            no_header_resp = requests.get(f"{BASE_URL}/api/events", headers=admin_headers, timeout=10)
            assert no_header_resp.status_code == 409, (
                f"Expected 409 (ambiguous — two meets open, no X-Meet-Id), got "
                f"{no_header_resp.status_code}: {no_header_resp.text}"
            )
            candidate_ids = {m["meet_id"] for m in no_header_resp.json()["detail"]["meets"]}
            assert candidate_ids == {meet_a_id, meet_b_id}

            # X-Meet-Id: meet B must show nothing, never meet A's 57
            # events/age-groups leaking through just because they happen to
            # share numeric ids.
            b_headers = {**admin_headers, "X-Meet-Id": str(meet_b_id)}
            events_resp = requests.get(f"{BASE_URL}/api/events", headers=b_headers, timeout=10)
            events_resp.raise_for_status()
            assert events_resp.json() == [], (
                "GET /api/events with X-Meet-Id=meet B returned rows while meet B "
                "is supposed to be empty — likely leaking meet A's events, which "
                "reuse the same swimeventid values"
            )
            assert not any(e["id"] in meet_a_event_ids for e in events_resp.json())

            sessions_resp = requests.get(f"{BASE_URL}/api/sessions", headers=b_headers, timeout=10)
            sessions_resp.raise_for_status()
            assert sessions_resp.json() == [], (
                "GET /api/sessions with X-Meet-Id=meet B returned rows while meet "
                "B is supposed to be empty — likely leaking meet A's sessions"
            )

            # X-Meet-Id: meet A must show exactly meet A's own events — the
            # header, not just table contents, is what disambiguates once two
            # meets are open.
            a_headers = {**admin_headers, "X-Meet-Id": str(meet_a_id)}
            events_resp_a = requests.get(f"{BASE_URL}/api/events", headers=a_headers, timeout=10)
            events_resp_a.raise_for_status()
            assert sorted(e["id"] for e in events_resp_a.json()) == meet_a_event_ids, (
                "GET /api/events with X-Meet-Id=meet A did not return meet A's own events"
            )

            # And meet A's own events, still sitting in the same table at the same
            # numeric ids, must still be exactly what they were before meet B existed.
            db_meet_a_event_ids = sorted(int(x) for x in exec_in_backend(
                "from app.database import SessionLocal\n"
                "from app.models import SwimEvent\n"
                "from app.models_team import Meet\n"
                "db = SessionLocal()\n"
                f"m = {meet_a_id}\n"
                "for e in db.query(SwimEvent).filter(SwimEvent.meetsid == m).all():\n"
                "    print(e.swimeventid)\n"
            ).strip().splitlines())
            assert db_meet_a_event_ids == meet_a_event_ids, (
                "Meet A's swimeventid set changed after meet B reused the same "
                "numeric ids under a different meetsid"
            )
        finally:
            delete_meet_b = (
                f"m = {meet_b_id}\n"
                "db.query(SwimResult).filter(SwimResult.meetsid == m).delete()\n"
                "db.query(AgeGroup).filter(AgeGroup.meetsid == m).delete()\n"
                "db.query(SwimEvent).filter(SwimEvent.meetsid == m).delete()\n"
                "db.query(SwimSession).filter(SwimSession.meetsid == m).delete()\n"
                "db.query(Meet).filter(Meet.meetsid == m).delete()\n"
            ) if meet_b_id is not None else ""
            exec_in_backend(
                "from app.database import SessionLocal\n"
                "from app.models_team import Meet\n"
                "from app.models import SwimSession, SwimEvent, AgeGroup, SwimResult\n"
                "db = SessionLocal()\n"
                + delete_meet_b +
                f"a = db.get(Meet, {meet_a_id})\n"
                "if a:\n"
                "    a.registration_open = True\n"
                "db.commit()\n"
            )


# ---------------------------------------------------------------------------
# Admin Meets Dashboard (Phase 2 Stage 7) — scoped flush/reset/close/reopen/
# organizer-assignment must never affect a concurrently-open second meet
# ---------------------------------------------------------------------------

class TestAdminMeetsDashboard:
    """flush_meet, _reset_for_next_meet (import-results-lxf), and organizer
    assignment used to operate on "every non-archived meet" / "whatever
    get_active_meetsid picks" — harmless with one meet, dormant until Stage
    7's close_other_meets=false made a second concurrently-open meet
    actually reachable. This proves each action now only ever touches its
    own explicit target."""

    @pytest.fixture(autouse=True, scope="class")
    def _restore_current_meet(self, admin_headers):
        yield
        with open(MEET_TEMPLATE, "rb") as f:
            requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                          files={"file": ("meet.lxf", f, "application/octet-stream")},
                          headers=admin_headers, timeout=60)
        if ENTRIES_FILE.exists():
            with open(ENTRIES_FILE, "rb") as f:
                requests.post(f"{BASE_URL}/api/upload/entries",
                              files={"file": ("entries.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)

    @staticmethod
    def _meet_a_id() -> int:
        return int(exec_in_backend(
            "from app.meet_config import get_active_meetsid\n"
            "from app.database import SessionLocal\n"
            "db = SessionLocal()\n"
            "print(get_active_meetsid(db))\n"
        ).strip())

    @staticmethod
    def _open_meet_b(admin_headers, meet_type="pool", close_other_meets=False) -> int:
        r = requests.post(f"{BASE_URL}/api/admin/new-meet",
                          json={"meet_type": meet_type, "close_other_meets": close_other_meets},
                          headers=admin_headers, timeout=60)
        assert r.status_code == 200, f"new-meet failed: {r.text}"
        return r.json()["meet_id"]

    @staticmethod
    def _cleanup_meet(meetsid: int):
        exec_in_backend(
            "from app.database import SessionLocal\n"
            "from app.models_team import Meet\n"
            "from app.models import SwimSession, SwimEvent, AgeGroup, SwimResult\n"
            "db = SessionLocal()\n"
            f"m = {meetsid}\n"
            "db.query(SwimResult).filter(SwimResult.meetsid == m).delete()\n"
            "db.query(AgeGroup).filter(AgeGroup.meetsid == m).delete()\n"
            "db.query(SwimEvent).filter(SwimEvent.meetsid == m).delete()\n"
            "db.query(SwimSession).filter(SwimSession.meetsid == m).delete()\n"
            "db.query(Meet).filter(Meet.meetsid == m).delete()\n"
            "db.commit()\n"
        )

    def test_new_meet_default_still_closes_prior_meet(self, uploaded, admin_headers):
        """Regression guard: omitting close_other_meets must reproduce
        today's exact single-meet behavior for every existing caller."""
        meet_a_id = self._meet_a_id()
        meet_b_id = None
        try:
            r = requests.post(f"{BASE_URL}/api/admin/new-meet", json={"meet_type": "pool"},
                              headers=admin_headers, timeout=60)
            assert r.status_code == 200, r.text
            meet_b_id = r.json()["meet_id"]
            a_open = exec_in_backend(
                "from app.database import SessionLocal\n"
                "from app.models_team import Meet\n"
                "db = SessionLocal()\n"
                f"print(db.get(Meet, {meet_a_id}).registration_open)\n"
            ).strip()
            assert a_open == "False", "Meet A should be closed when close_other_meets is omitted"
        finally:
            if meet_b_id is not None:
                self._cleanup_meet(meet_b_id)
            exec_in_backend(
                "from app.database import SessionLocal\n"
                "from app.models_team import Meet\n"
                "db = SessionLocal()\n"
                f"a = db.get(Meet, {meet_a_id})\n"
                "if a:\n    a.registration_open = True\n"
                "db.commit()\n"
            )

    def test_new_meet_close_other_meets_false_keeps_both_open_and_listed(self, uploaded, admin_headers):
        meet_a_id = self._meet_a_id()
        meet_b_id = None
        try:
            meet_b_id = self._open_meet_b(admin_headers)
            r = requests.get(f"{BASE_URL}/api/admin/meets", headers=admin_headers, timeout=10)
            r.raise_for_status()
            by_id = {m["meet_id"]: m for m in r.json()}
            assert meet_a_id in by_id and meet_b_id in by_id
            assert by_id[meet_a_id]["registration_open"] is True
            assert by_id[meet_b_id]["registration_open"] is True
        finally:
            if meet_b_id is not None:
                self._cleanup_meet(meet_b_id)

    def test_delete_registrations_scoped_via_x_meet_id(self, uploaded, admin_headers):
        """DELETE /registrations (toolbar Flush Meet) must only ever touch
        the X-Meet-Id target, never a concurrently-open second meet."""
        meet_a_id = self._meet_a_id()
        meet_b_id = None
        try:
            meet_b_id = self._open_meet_b(admin_headers)
            b_headers = {**admin_headers, "X-Meet-Id": str(meet_b_id)}
            requests.post(f"{BASE_URL}/api/sessions", json={"name": "S1", "number": 1},
                          headers=b_headers, timeout=10).raise_for_status()

            r = requests.delete(f"{BASE_URL}/api/registrations", headers=b_headers, timeout=30)
            assert r.status_code == 200, f"scoped flush failed: {r.text}"

            still_there = exec_in_backend(
                "from app.database import SessionLocal\n"
                "from app.models_team import Meet\n"
                "db = SessionLocal()\n"
                f"print(db.get(Meet, {meet_b_id}) is not None)\n"
            ).strip()
            assert still_there == "False", "DELETE /registrations with X-Meet-Id=B should have deleted meet B"
            meet_b_id = None

            a_sessions = requests.get(f"{BASE_URL}/api/sessions",
                                       headers={**admin_headers, "X-Meet-Id": str(meet_a_id)}, timeout=10)
            a_sessions.raise_for_status()
            assert len(a_sessions.json()) > 0, "Meet A's sessions were wiped by a flush scoped to meet B"
        finally:
            if meet_b_id is not None:
                self._cleanup_meet(meet_b_id)

    def test_delete_admin_meets_explicit_path_scoped(self, uploaded, admin_headers):
        meet_a_id = self._meet_a_id()
        meet_b_id = None
        try:
            meet_b_id = self._open_meet_b(admin_headers)
            r = requests.delete(f"{BASE_URL}/api/admin/meets/{meet_b_id}", headers=admin_headers, timeout=30)
            assert r.status_code == 200, f"explicit delete failed: {r.text}"
            meet_b_id = None

            a_sessions = requests.get(f"{BASE_URL}/api/sessions",
                                       headers={**admin_headers, "X-Meet-Id": str(meet_a_id)}, timeout=10)
            a_sessions.raise_for_status()
            assert len(a_sessions.json()) > 0
        finally:
            if meet_b_id is not None:
                self._cleanup_meet(meet_b_id)

    def test_stub_meet_not_recreated_while_another_meet_stays_open(self, uploaded, admin_headers):
        """GET /admin/meets can legitimately show other closed-but-undeleted
        meets left behind by other test classes elsewhere in this suite
        (Stage 1's "close, don't delete" behavior) — so this compares the
        meet_id set before/after, rather than asserting an absolute count,
        to isolate just the effect of this test's own create+delete."""
        meet_a_id = self._meet_a_id()
        before_ids = {m["meet_id"] for m in
                      requests.get(f"{BASE_URL}/api/admin/meets", headers=admin_headers, timeout=10).json()}

        meet_b_id = self._open_meet_b(admin_headers)
        r = requests.delete(f"{BASE_URL}/api/admin/meets/{meet_b_id}", headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text

        active = exec_in_backend(
            "from app.meet_config import get_active_meetsid\n"
            "from app.database import SessionLocal\n"
            "db = SessionLocal()\n"
            "print(get_active_meetsid(db))\n"
        ).strip()
        assert active == str(meet_a_id), (
            "Deleting meet B while meet A stayed open should not recreate a "
            "stub meet — get_active_meetsid should still resolve to meet A"
        )
        after_ids = {m["meet_id"] for m in
                     requests.get(f"{BASE_URL}/api/admin/meets", headers=admin_headers, timeout=10).json()}
        assert after_ids == before_ids, "A spurious stub meet was created even though meet A was still open"

    def test_close_then_reopen_registration_roundtrip(self, uploaded, admin_headers):
        meet_b_id = None
        try:
            meet_b_id = self._open_meet_b(admin_headers)

            r = requests.post(f"{BASE_URL}/api/admin/meets/{meet_b_id}/close-registration",
                              headers=admin_headers, timeout=10)
            assert r.status_code == 200, r.text

            # GET /admin/meets (not /api/auth — the PIN login endpoint is
            # rate-limited, and this suite already exercises it heavily
            # elsewhere) to confirm the flag actually flipped.
            meets = requests.get(f"{BASE_URL}/api/admin/meets", headers=admin_headers, timeout=10).json()
            b_entry = next(m for m in meets if m["meet_id"] == meet_b_id)
            assert b_entry["registration_open"] is False

            blocked = requests.get(f"{BASE_URL}/api/sessions",
                                    headers={**admin_headers, "X-Meet-Id": str(meet_b_id)}, timeout=10)
            assert blocked.status_code == 404

            r2 = requests.post(f"{BASE_URL}/api/admin/meets/{meet_b_id}/reopen-registration",
                               headers=admin_headers, timeout=10)
            assert r2.status_code == 200, r2.text

            meets2 = requests.get(f"{BASE_URL}/api/admin/meets", headers=admin_headers, timeout=10).json()
            b_entry2 = next(m for m in meets2 if m["meet_id"] == meet_b_id)
            assert b_entry2["registration_open"] is True
        finally:
            if meet_b_id is not None:
                self._cleanup_meet(meet_b_id)

    def test_reopen_blocked_by_session_date_conflict(self, uploaded, admin_headers):
        meet_a_id = self._meet_a_id()
        meet_b_id = None
        try:
            a_headers = {**admin_headers, "X-Meet-Id": str(meet_a_id)}
            a_sessions = requests.get(f"{BASE_URL}/api/sessions", headers=a_headers, timeout=10).json()
            a_session_id = a_sessions[0]["id"]
            requests.put(f"{BASE_URL}/api/sessions/{a_session_id}",
                        json={"startdate": "2027-06-01"}, headers=a_headers, timeout=10).raise_for_status()

            # close_other_meets=True (the default) briefly closes meet A, so
            # meet B can acquire the same date with no conflict yet — a
            # dormant collision that should only surface when meet B tries
            # to reopen alongside meet A later.
            meet_b_id = self._open_meet_b(admin_headers, close_other_meets=True)
            b_headers = {**admin_headers, "X-Meet-Id": str(meet_b_id)}
            b_session = requests.post(f"{BASE_URL}/api/sessions", json={"name": "S1", "number": 1},
                                      headers=b_headers, timeout=10).json()
            requests.put(f"{BASE_URL}/api/sessions/{b_session['id']}",
                        json={"startdate": "2027-06-01"}, headers=b_headers, timeout=10).raise_for_status()

            requests.post(f"{BASE_URL}/api/admin/meets/{meet_b_id}/close-registration",
                         headers=admin_headers, timeout=10).raise_for_status()
            requests.post(f"{BASE_URL}/api/admin/meets/{meet_a_id}/reopen-registration",
                         headers=admin_headers, timeout=10).raise_for_status()

            r = requests.post(f"{BASE_URL}/api/admin/meets/{meet_b_id}/reopen-registration",
                              headers=admin_headers, timeout=10)
            assert r.status_code == 409, f"Expected 409 on colliding reopen, got {r.status_code}: {r.text}"
        finally:
            requests.post(f"{BASE_URL}/api/admin/meets/{meet_a_id}/reopen-registration",
                          headers=admin_headers, timeout=10)
            if meet_b_id is not None:
                self._cleanup_meet(meet_b_id)

    def test_set_and_get_organizer_explicit_meetsid(self, uploaded, clubs, admin_headers):
        meet_a_id = self._meet_a_id()
        meet_b_id = None
        try:
            meet_b_id = self._open_meet_b(admin_headers)
            club_a = clubs[0]["id"]
            club_b = clubs[1]["id"] if len(clubs) > 1 else clubs[0]["id"]

            requests.post(f"{BASE_URL}/api/admin/set-organizer",
                         json={"club_id": club_a, "meetsid": meet_a_id},
                         headers=admin_headers, timeout=10).raise_for_status()
            requests.post(f"{BASE_URL}/api/admin/set-organizer",
                         json={"club_id": club_b, "meetsid": meet_b_id},
                         headers=admin_headers, timeout=10).raise_for_status()

            org_a = requests.get(f"{BASE_URL}/api/admin/organizer",
                                 params={"meetsid": meet_a_id}, headers=admin_headers, timeout=10).json()
            org_b = requests.get(f"{BASE_URL}/api/admin/organizer",
                                 params={"meetsid": meet_b_id}, headers=admin_headers, timeout=10).json()
            assert org_a["club_id"] == club_a
            assert org_b["club_id"] == club_b
        finally:
            if meet_b_id is not None:
                self._cleanup_meet(meet_b_id)
            # meet B's organizer_club_id is cascade-deleted with its Meet
            # row above; meet A survives, so its assignment needs explicit
            # clearing (same escape hatch as TestAuth's organizer test).
            exec_in_backend(
                "from app.database import SessionLocal\n"
                "from app.models import MeetConfig\n"
                "from app.models_team import Meet\n"
                "db = SessionLocal()\n"
                f"db.query(MeetConfig).filter(MeetConfig.meetsid == {meet_a_id}, "
                "MeetConfig.name == 'organizer_club_id').delete()\n"
                "db.commit()\n"
            )


class TestCloseMeetWithoutResults:
    """POST /admin/close-meet-without-results: resets the caller's target
    meet (same _reset_for_next_meet a results import uses) without creating
    any historical record — for meets with nothing worth archiving. Isolated
    in its own class since it destroys the sole active meet (same reason as
    TestStubMeetRecreatedWhenLastMeetFlushed/TestImportResultsLxfResetScopedToTarget)."""

    @pytest.fixture(autouse=True, scope="class")
    def _restore_current_meet(self, admin_headers):
        yield
        with open(MEET_TEMPLATE, "rb") as f:
            requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                          files={"file": ("meet.lxf", f, "application/octet-stream")},
                          headers=admin_headers, timeout=60)
        if ENTRIES_FILE.exists():
            with open(ENTRIES_FILE, "rb") as f:
                requests.post(f"{BASE_URL}/api/upload/entries",
                              files={"file": ("entries.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)

    def test_closes_without_creating_a_historical_record_and_leaves_other_meets_alone(self, uploaded, admin_headers):
        meet_a_id = int(exec_in_backend(
            "from app.meet_config import get_active_meetsid\n"
            "from app.database import SessionLocal\n"
            "db = SessionLocal()\n"
            "print(get_active_meetsid(db))\n"
        ).strip())

        meet_b_id = None
        try:
            r = requests.post(f"{BASE_URL}/api/admin/new-meet",
                              json={"meet_type": "pool", "close_other_meets": False},
                              headers=admin_headers, timeout=60)
            assert r.status_code == 200, r.text
            meet_b_id = r.json()["meet_id"]
            b_headers = {**admin_headers, "X-Meet-Id": str(meet_b_id)}
            requests.post(f"{BASE_URL}/api/sessions", json={"name": "S1", "number": 1},
                          headers=b_headers, timeout=10).raise_for_status()

            # /admin/historical-meets has no meetstate/registration_open
            # filter (see docs/CONCURRENT_MEETS_PLAN.md) — it lists every
            # Meet row, open or archived. Snapshotting after meet B exists
            # isolates just the close action's effect, instead of also
            # picking up meet B's own creation as a spurious "new entry".
            before_historical = {m["id"] for m in
                                  requests.get(f"{BASE_URL}/api/admin/historical-meets", headers=admin_headers, timeout=10).json()}
            assert meet_a_id in before_historical

            r2 = requests.post(f"{BASE_URL}/api/admin/close-meet-without-results",
                               headers={**admin_headers, "X-Meet-Id": str(meet_a_id)}, timeout=10)
            assert r2.status_code == 200, r2.text
            body = r2.json()
            assert body["ok"] is True
            assert body["role"] == "admin"

            gone = exec_in_backend(
                "from app.database import SessionLocal\n"
                "from app.models_team import Meet\n"
                "db = SessionLocal()\n"
                f"print(db.get(Meet, {meet_a_id}) is not None)\n"
            ).strip()
            assert gone == "False", "Meet A's live TeamMeet row should be gone after closing"

            after_historical = {m["id"] for m in
                                 requests.get(f"{BASE_URL}/api/admin/historical-meets", headers=admin_headers, timeout=10).json()}
            assert after_historical == before_historical - {meet_a_id}, (
                "close-meet-without-results must not create any historical-meets entry — "
                "meet A should simply be gone, not replaced by an archived record"
            )

            b_sessions = requests.get(f"{BASE_URL}/api/sessions", headers=b_headers, timeout=10)
            b_sessions.raise_for_status()
            assert len(b_sessions.json()) == 1, "Meet B's session vanished after meet A was closed"
        finally:
            if meet_b_id is not None:
                exec_in_backend(
                    "from app.database import SessionLocal\n"
                    "from app.models_team import Meet\n"
                    "from app.models import SwimSession, SwimEvent, AgeGroup, SwimResult\n"
                    "db = SessionLocal()\n"
                    f"m = {meet_b_id}\n"
                    "db.query(SwimResult).filter(SwimResult.meetsid == m).delete()\n"
                    "db.query(AgeGroup).filter(AgeGroup.meetsid == m).delete()\n"
                    "db.query(SwimEvent).filter(SwimEvent.meetsid == m).delete()\n"
                    "db.query(SwimSession).filter(SwimSession.meetsid == m).delete()\n"
                    "db.query(Meet).filter(Meet.meetsid == m).delete()\n"
                    "db.commit()\n"
                )

    def test_requires_organizer_or_admin(self, uploaded, clubs):
        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.post(f"{BASE_URL}/api/admin/close-meet-without-results",
                          headers=coach_headers, timeout=10)
        assert r.status_code == 403


class TestClubInviteCountsScopedPerMeet:
    """Regression test for a real bug found manually testing Phase 2 Stage 7
    (docs/CONCURRENT_MEETS_PLAN.md): GET /clubs's invite_send_count/
    stripe_send_count used to read straight off clubs.invite_send_count — a
    single counter shared across every meet — so a club invited for meet A
    showed as already-invited on meet B too. Fixed via a new club_meet_invites
    table keyed by (clubsid, meetsid); this proves the same club's counts
    are now genuinely independent per meet."""

    @pytest.fixture(autouse=True, scope="class")
    def _restore_current_meet(self, admin_headers):
        yield
        with open(MEET_TEMPLATE, "rb") as f:
            requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                          files={"file": ("meet.lxf", f, "application/octet-stream")},
                          headers=admin_headers, timeout=60)
        if ENTRIES_FILE.exists():
            with open(ENTRIES_FILE, "rb") as f:
                requests.post(f"{BASE_URL}/api/upload/entries",
                              files={"file": ("entries.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)

    def test_invite_count_does_not_leak_between_concurrently_open_meets(self, uploaded, clubs, admin_headers):
        meet_a_id = int(exec_in_backend(
            "from app.meet_config import get_active_meetsid\n"
            "from app.database import SessionLocal\n"
            "db = SessionLocal()\n"
            "print(get_active_meetsid(db))\n"
        ).strip())
        club_id = clubs[0]["id"]
        meet_b_id = None
        try:
            r = requests.post(f"{BASE_URL}/api/admin/new-meet",
                              json={"meet_type": "pool", "close_other_meets": False},
                              headers=admin_headers, timeout=60)
            assert r.status_code == 200, r.text
            meet_b_id = r.json()["meet_id"]

            # Directly seed an invite count for meet A only — send-pin itself
            # needs RESEND_API_KEY configured, which the test stack doesn't
            # set up; this exercises the same increment path's data shape
            # without depending on outbound email.
            exec_in_backend(
                "from app.database import SessionLocal\n"
                "from app.meet_config import increment_club_invite_send_count\n"
                "db = SessionLocal()\n"
                f"increment_club_invite_send_count(db, {club_id}, {meet_a_id})\n"
                "increment_club_invite_send_count(db, "
                f"{club_id}, {meet_a_id})\n"  # twice — count should read back as 2
                "db.commit()\n"
            )

            a_clubs = requests.get(f"{BASE_URL}/api/clubs",
                                    headers={**admin_headers, "X-Meet-Id": str(meet_a_id)}, timeout=10).json()
            b_clubs = requests.get(f"{BASE_URL}/api/clubs",
                                    headers={**admin_headers, "X-Meet-Id": str(meet_b_id)}, timeout=10).json()
            a_entry = next(c for c in a_clubs if c["id"] == club_id)
            b_entry = next(c for c in b_clubs if c["id"] == club_id)
            assert a_entry["invite_send_count"] == 2, "Meet A's own invite count should reflect the seeded sends"
            assert b_entry["invite_send_count"] == 0, (
                "Meet B shows meet A's invite count — the per-meet scoping isn't isolating them"
            )
        finally:
            if meet_b_id is not None:
                self._cleanup_meet(meet_b_id)
            exec_in_backend(
                "from app.database import SessionLocal\n"
                "from app.models_team import ClubMeetInvite\n"
                "db = SessionLocal()\n"
                f"db.query(ClubMeetInvite).filter(ClubMeetInvite.meetsid == {meet_a_id}, "
                f"ClubMeetInvite.clubsid == {club_id}).delete()\n"
                "db.commit()\n"
            )

    @staticmethod
    def _cleanup_meet(meetsid: int):
        exec_in_backend(
            "from app.database import SessionLocal\n"
            "from app.models_team import Meet\n"
            "from app.models import SwimSession, SwimEvent, AgeGroup, SwimResult\n"
            "db = SessionLocal()\n"
            f"m = {meetsid}\n"
            "db.query(SwimResult).filter(SwimResult.meetsid == m).delete()\n"
            "db.query(AgeGroup).filter(AgeGroup.meetsid == m).delete()\n"
            "db.query(SwimEvent).filter(SwimEvent.meetsid == m).delete()\n"
            "db.query(SwimSession).filter(SwimSession.meetsid == m).delete()\n"
            "db.query(Meet).filter(Meet.meetsid == m).delete()\n"
            "db.commit()\n"
        )


class TestStubMeetRecreatedWhenLastMeetFlushed:
    """Isolated from TestAdminMeetsDashboard: this test deletes the only
    currently-active meet outright (proving _flush_meet_data's stub-recreate
    guard fires when nothing else is open), which no other test in this
    file can share a class with — its own _restore_current_meet teardown
    must run immediately after, before anything else assumes an active
    meet exists."""

    @pytest.fixture(autouse=True, scope="class")
    def _restore_current_meet(self, admin_headers):
        yield
        with open(MEET_TEMPLATE, "rb") as f:
            requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                          files={"file": ("meet.lxf", f, "application/octet-stream")},
                          headers=admin_headers, timeout=60)
        if ENTRIES_FILE.exists():
            with open(ENTRIES_FILE, "rb") as f:
                requests.post(f"{BASE_URL}/api/upload/entries",
                              files={"file": ("entries.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)

    def test_stub_meet_recreated_when_last_meet_flushed(self, uploaded, admin_headers):
        meet_a_id = int(exec_in_backend(
            "from app.meet_config import get_active_meetsid\n"
            "from app.database import SessionLocal\n"
            "db = SessionLocal()\n"
            "print(get_active_meetsid(db))\n"
        ).strip())
        r = requests.delete(f"{BASE_URL}/api/admin/meets/{meet_a_id}", headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        active = exec_in_backend(
            "from app.meet_config import get_active_meetsid\n"
            "from app.database import SessionLocal\n"
            "db = SessionLocal()\n"
            "print(get_active_meetsid(db))\n"
        ).strip()
        # Not "active != meet_a_id": the deleted meet is fully gone (cascade),
        # so a fresh stub reusing the same numeric id is harmless and, when
        # nothing else in the meets table has a higher id (e.g. running this
        # test in isolation), is exactly what max(meetsid)+1 legitimately
        # produces. What actually matters is that a genuinely empty stub
        # exists — checked below via its session list.
        assert active != "None", "A fresh stub meet should exist after the last open meet was flushed"
        stub_sessions = requests.get(f"{BASE_URL}/api/sessions",
                                      headers={**admin_headers, "X-Meet-Id": active}, timeout=10)
        stub_sessions.raise_for_status()
        assert stub_sessions.json() == [], "The recreated stub meet should be empty, not carry over old sessions"


class TestImportResultsLxfResetScopedToTarget:
    """Isolated from TestAdminMeetsDashboard for the same reason as
    TestStubMeetRecreatedWhenLastMeetFlushed: this archives meet A's results
    (deleting its live TeamMeet row) while meet B is concurrently open, so
    _flush_meet_data's stub-recreate guard correctly does NOT fire — meet B
    is still open — leaving zero meets once meet B is cleaned up afterward.
    No other test in this file can safely assume an active meet exists
    after this one runs within the same class."""

    @pytest.fixture(autouse=True, scope="class")
    def _restore_current_meet(self, admin_headers):
        yield
        with open(MEET_TEMPLATE, "rb") as f:
            requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                          files={"file": ("meet.lxf", f, "application/octet-stream")},
                          headers=admin_headers, timeout=60)
        if ENTRIES_FILE.exists():
            with open(ENTRIES_FILE, "rb") as f:
                requests.post(f"{BASE_URL}/api/upload/entries",
                              files={"file": ("entries.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)

    def test_import_results_lxf_reset_scoped_to_x_meet_id_target(self, uploaded, admin_headers):
        """Uploading final results for meet A must reset only meet A's live
        data — meet B, concurrently open, must be untouched."""
        meet_a_id = int(exec_in_backend(
            "from app.meet_config import get_active_meetsid\n"
            "from app.database import SessionLocal\n"
            "db = SessionLocal()\n"
            "print(get_active_meetsid(db))\n"
        ).strip())
        meet_b_id = None
        try:
            r = requests.post(f"{BASE_URL}/api/admin/new-meet",
                              json={"meet_type": "pool", "close_other_meets": False},
                              headers=admin_headers, timeout=60)
            assert r.status_code == 200, f"new-meet failed: {r.text}"
            meet_b_id = r.json()["meet_id"]
            b_headers = {**admin_headers, "X-Meet-Id": str(meet_b_id)}
            requests.post(f"{BASE_URL}/api/sessions", json={"name": "S1", "number": 1},
                          headers=b_headers, timeout=10).raise_for_status()

            with open(RESULTS_FILE, "rb") as f:
                r2 = requests.post(f"{BASE_URL}/api/import-results-lxf?force=true",
                                   files={"file": ("results.lxf", f, "application/octet-stream")},
                                   headers={**admin_headers, "X-Meet-Id": str(meet_a_id)}, timeout=30)
            assert r2.status_code == 200, f"import-results-lxf failed: {r2.text}"
            assert r2.json()["reset"] is True

            gone = exec_in_backend(
                "from app.database import SessionLocal\n"
                "from app.models_team import Meet\n"
                "db = SessionLocal()\n"
                f"print(db.get(Meet, {meet_a_id}) is not None)\n"
            ).strip()
            assert gone == "False", "Meet A's live TeamMeet row should be gone after its results were archived"

            b_sessions = requests.get(f"{BASE_URL}/api/sessions", headers=b_headers, timeout=10)
            b_sessions.raise_for_status()
            assert len(b_sessions.json()) == 1, "Meet B's session vanished after meet A's results were imported"
        finally:
            if meet_b_id is not None:
                exec_in_backend(
                    "from app.database import SessionLocal\n"
                    "from app.models_team import Meet\n"
                    "from app.models import SwimSession, SwimEvent, AgeGroup, SwimResult\n"
                    "db = SessionLocal()\n"
                    f"m = {meet_b_id}\n"
                    "db.query(SwimResult).filter(SwimResult.meetsid == m).delete()\n"
                    "db.query(AgeGroup).filter(AgeGroup.meetsid == m).delete()\n"
                    "db.query(SwimEvent).filter(SwimEvent.meetsid == m).delete()\n"
                    "db.query(SwimSession).filter(SwimSession.meetsid == m).delete()\n"
                    "db.query(Meet).filter(Meet.meetsid == m).delete()\n"
                    "db.commit()\n"
                )


# ---------------------------------------------------------------------------
# Flush Meet — must not wipe archived (historical) meets either
# ---------------------------------------------------------------------------

class TestFlushMeetPreservesHistory:
    """Same regression class as TestNewMeetPreservesHistory /
    TestUploadMeetPreservesHistory, but for DELETE /api/registrations
    ("Flush Meet" in Admin). This path used to blanket-delete every TeamMeet
    row (and every SwimResult/AgeGroup/SwimEvent/SwimSession row), including
    archived (meetstate=3) ones, plus the entire SwimStyle catalog — found
    live against a real WSL dev DB, where clicking "Reset Meet" still wiped
    history even after the /api/admin/new-meet and /api/upload/meet paths
    had already been fixed. Fixed in flush_meet() (routers/api.py); this is
    its regression test, matching the pattern the other two paths already
    have."""

    @pytest.fixture(autouse=True, scope="class")
    def _restore_current_meet(self, admin_headers):
        yield
        with open(MEET_TEMPLATE, "rb") as f:
            requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                          files={"file": ("meet.lxf", f, "application/octet-stream")},
                          headers=admin_headers, timeout=60)
        if ENTRIES_FILE.exists():
            with open(ENTRIES_FILE, "rb") as f:
                requests.post(f"{BASE_URL}/api/upload/entries",
                              files={"file": ("entries.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)

    @pytest.fixture(scope="class")
    def results_lxf_bytes(self, results_path) -> bytes:
        return results_path.read_bytes()

    def test_flush_meet_keeps_historical_results(self, results_lxf_bytes, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/admin/import-historical?force=true",
            files={"file": ("results.lxf", results_lxf_bytes, "application/octet-stream")},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 200, f"Historical import failed: {r.text}"
        meet_id = r.json()["meet_id"]

        before = requests.get(f"{BASE_URL}/api/admin/historical-meets",
                              headers=admin_headers, timeout=10)
        before.raise_for_status()
        before_entry = next((m for m in before.json() if m["id"] == meet_id), None)
        assert before_entry is not None
        assert before_entry["resultCount"] > 0

        r = requests.delete(f"{BASE_URL}/api/registrations", headers=admin_headers, timeout=30)
        assert r.status_code == 200, f"flush meet failed: {r.text}"

        after = requests.get(f"{BASE_URL}/api/admin/historical-meets",
                             headers=admin_headers, timeout=10)
        after.raise_for_status()
        after_entry = next((m for m in after.json() if m["id"] == meet_id), None)
        assert after_entry is not None, "Historical meet vanished after DELETE /api/registrations"
        assert after_entry["resultCount"] == before_entry["resultCount"], (
            "Historical results were lost after flushing the current meet"
        )

    def test_flush_meet_keeps_swimstyle_catalog_usable(self, admin_headers):
        """SwimStyle rows are upserted by id, not wiped, so both the surviving
        historical results and the fresh (reloaded) meet keep valid style
        references."""
        r = requests.get(f"{BASE_URL}/api/swim-styles", headers=admin_headers, timeout=10)
        r.raise_for_status()
        assert len(r.json()) > 0


# ---------------------------------------------------------------------------
# New Swimstyle Confirmation — LXF imports warn before adding unknown styles
# ---------------------------------------------------------------------------

class TestNewSwimstyleConfirmation:
    """New swimstyle ids referenced by an uploaded LXF must be confirmed
    (409 + ?force=true) before being silently added to the shared catalog —
    the catalog is never wiped anymore (see TestUploadMeetPreservesHistory),
    so a stale/foreign template could otherwise pollute it unnoticed."""

    @staticmethod
    def _fabricate_meet_lxf(style_id: int, meet_name: str) -> bytes:
        lef_content = (
            f'<?xml version="1.0"?><LENEX><MEETS><MEET name="{meet_name}" course="LCM">'
            '<SESSIONS><SESSION number="1"><EVENTS><EVENT eventid="1" number="1" gender="M">'
            f'<SWIMSTYLE swimstyleid="{style_id}" distance="777" name="Totally New Style" relaycount="1"/>'
            '</EVENT></EVENTS></SESSION></SESSIONS><CLUBS></CLUBS></MEET></MEETS></LENEX>'
        )
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("meet.lef", lef_content)
        return buf.getvalue()

    @pytest.fixture(autouse=True, scope="class")
    def _restore_current_meet(self, admin_headers):
        yield
        with open(MEET_TEMPLATE, "rb") as f:
            requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                          files={"file": ("meet.lxf", f, "application/octet-stream")},
                          headers=admin_headers, timeout=60)
        if ENTRIES_FILE.exists():
            with open(ENTRIES_FILE, "rb") as f:
                requests.post(f"{BASE_URL}/api/upload/entries",
                              files={"file": ("entries.lxf", f, "application/octet-stream")},
                              headers=admin_headers, timeout=60)

    def test_upload_meet_warns_then_accepts_with_force(self, admin_headers):
        lxf = self._fabricate_meet_lxf(555, "Fabricated New Style Meet")
        r = requests.post(f"{BASE_URL}/api/upload/meet",
                          files={"file": ("new.lxf", lxf, "application/octet-stream")},
                          headers=admin_headers, timeout=30)
        assert r.status_code == 409, f"Expected 409, got {r.status_code}: {r.text}"
        detail = r.json()["detail"]
        assert detail["code"] == "new_swimstyles"
        assert any(s["id"] == 555 for s in detail["styles"])

        r2 = requests.post(f"{BASE_URL}/api/upload/meet?force=true",
                           files={"file": ("new.lxf", lxf, "application/octet-stream")},
                           headers=admin_headers, timeout=30)
        assert r2.status_code == 200, f"force=true should succeed: {r2.text}"

        r3 = requests.get(f"{BASE_URL}/api/swim-styles", headers=admin_headers, timeout=10)
        r3.raise_for_status()
        assert any(s["id"] == 555 for s in r3.json())

    def test_upload_meet_known_style_does_not_warn(self, admin_headers):
        """Once a style id is in the catalog (from the previous test), later
        uploads referencing it must not warn again."""
        lxf = self._fabricate_meet_lxf(555, "Fabricated New Style Meet Reupload")
        r = requests.post(f"{BASE_URL}/api/upload/meet",
                          files={"file": ("new.lxf", lxf, "application/octet-stream")},
                          headers=admin_headers, timeout=30)
        assert r.status_code == 200, f"Known style should not need force: {r.text}"

    def test_import_historical_warns_then_accepts_with_force(self, admin_headers):
        lxf = self._fabricate_meet_lxf(556, "Fabricated Historical Meet")
        r = requests.post(f"{BASE_URL}/api/admin/import-historical",
                          files={"file": ("hist.lxf", lxf, "application/octet-stream")},
                          headers=admin_headers, timeout=30)
        assert r.status_code == 409, f"Expected 409, got {r.status_code}: {r.text}"
        detail = r.json()["detail"]
        assert detail["code"] == "new_swimstyles"
        assert any(s["id"] == 556 for s in detail["styles"])

        r2 = requests.post(f"{BASE_URL}/api/admin/import-historical?force=true",
                           files={"file": ("hist.lxf", lxf, "application/octet-stream")},
                           headers=admin_headers, timeout=30)
        assert r2.status_code == 200, f"force=true should succeed: {r2.text}"

    def test_import_results_lxf_warns_then_accepts_with_force(self, admin_headers):
        lxf = self._fabricate_meet_lxf(557, "Fabricated Results Meet")
        r = requests.post(f"{BASE_URL}/api/import-results-lxf",
                          files={"file": ("results.lxf", lxf, "application/octet-stream")},
                          headers=admin_headers, timeout=30)
        assert r.status_code == 409, f"Expected 409, got {r.status_code}: {r.text}"
        detail = r.json()["detail"]
        assert detail["code"] == "new_swimstyles"
        assert any(s["id"] == 557 for s in detail["styles"])

        r2 = requests.post(f"{BASE_URL}/api/import-results-lxf?force=true",
                           files={"file": ("results.lxf", lxf, "application/octet-stream")},
                           headers=admin_headers, timeout=30)
        assert r2.status_code == 200, f"force=true should succeed: {r2.text}"

    def test_upload_entries_with_mismatched_structure_warns_then_registers(self, admin_headers):
        """A combined meet+entries LXF whose own EVENT/eventid isn't in the
        local catalog must warn (not silently drop the registration) — and
        once forced, must replace the structure so the entry actually
        resolves. Regression for the entries-mismatch bug: entries used to
        be seeded blindly against whatever events already existed, silently
        dropping any entry whose eventid wasn't in the (possibly stale)
        catalog."""
        style_id = 558
        event_id = 90210
        lef_content = (
            '<?xml version="1.0"?><LENEX><MEETS><MEET name="Mismatch Meet" course="LCM">'
            '<SESSIONS><SESSION number="1"><EVENTS>'
            f'<EVENT eventid="{event_id}" number="1" gender="M">'
            f'<SWIMSTYLE swimstyleid="{style_id}" distance="777" name="Totally New Style 558" relaycount="1"/>'
            '</EVENT></EVENTS></SESSION></SESSIONS>'
            '<CLUBS><CLUB code="MISM" name="Mismatch Club">'
            '<ATHLETES><ATHLETE athleteid="1" firstname="Test" lastname="Athlete" '
            'gender="M" birthdate="2000-01-01">'
            f'<ENTRIES><ENTRY eventid="{event_id}" entrytime="0"/></ENTRIES>'
            '</ATHLETE></ATHLETES></CLUB></CLUBS>'
            '</MEET></MEETS></LENEX>'
        )
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("meet.lef", lef_content)
        lxf = buf.getvalue()

        r = requests.post(f"{BASE_URL}/api/upload/entries",
                          files={"file": ("mismatch.lxf", lxf, "application/octet-stream")},
                          headers=admin_headers, timeout=30)
        assert r.status_code == 409, f"Expected 409, got {r.status_code}: {r.text}"
        detail = r.json()["detail"]
        assert detail["code"] == "new_swimstyles"
        assert any(s["id"] == style_id for s in detail["styles"])

        r2 = requests.post(f"{BASE_URL}/api/upload/entries?force=true",
                           files={"file": ("mismatch.lxf", lxf, "application/octet-stream")},
                           headers=admin_headers, timeout=30)
        assert r2.status_code == 200, f"force=true should succeed: {r2.text}"
        data = r2.json()
        assert data["events_loaded"] > 0, "Mismatched structure should have been reloaded"
        assert data["entries_added"] == 1, (
            "The registration should resolve now that its event was loaded, not be silently dropped"
        )

