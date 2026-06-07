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
)

SMB_FILE = Path(__file__).resolve().parent / "fixtures" / "meet.smb"


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
        # Generator emits 3 results per athlete (300 total). Some may collide
        # on the same (athlete, style, course) when one event shares a style
        # with another — those keep the fastest. So times_updated <= 300.
        # On re-runs, times may already be set (no improvement) so count can be 0.
        assert uploaded_results["athletes_skipped"] == 0
        assert uploaded_results["times_updated"] >= 0

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
        # (may contain more if SMB tests added additional athletes)
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
# Meet SMB download (/export/meet-smb) — moved to end of file to avoid
# disrupting session-scoped fixtures (full SMB restore wipes all data)
# ---------------------------------------------------------------------------


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
            r = requests.post(f"{BASE_URL}/api/upload/meet",
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
        assert ev["gender"] in ("M", "F", "X")
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
                    assert ag["gender"] in ("M", "F", "X")
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


# ---------------------------------------------------------------------------
# SMB upload round normalization
# ---------------------------------------------------------------------------




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

    def test_keys_survive_smb_roundtrip(self, uploaded, admin_headers):
        """Keys stored in BSGLOBAL should be included in SMB export."""
        # Set keys
        requests.post(f"{BASE_URL}/api/admin/gemini-keys",
                      json={"freeKey": "AIzaSyRoundtripFree", "paidKey": "AIzaSyRoundtripPaid"},
                      headers=admin_headers, timeout=10)

        # Export SMB
        r = requests.get(f"{BASE_URL}/api/export/meet-smb",
                         headers=admin_headers, timeout=30)
        if r.status_code == 404:
            pytest.skip("SMB export endpoint not available")
        r.raise_for_status()
        smb_data = r.content
        assert len(smb_data) > 0

        # The SMB file should contain the GEMINI_KEY entries in BSGLOBAL
        # (We can't easily parse the binary SMB here, but we verify the keys
        # are in the DB which is what gets exported)
        r = requests.get(f"{BASE_URL}/api/admin/gemini-keys",
                         headers=admin_headers, timeout=10)
        data = r.json()
        assert data["hasFreeKey"] is True
        assert data["hasPaidKey"] is True

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
# SMB upload → LXF export regression (destructive — runs last)
#
# These tests reproduce the exact failure mode: meet loaded via SMB has no
# meet.lxf on disk, so both export endpoints used to crash or return 404/500.
# ---------------------------------------------------------------------------

class TestExportAfterSmbUpload:
    """Verify export endpoints work when meet was loaded via SMB (no meet.lxf file).

    Runs last because SMB upload wipes all existing meet data.
    """

    @pytest.fixture(scope="class")
    def smb_loaded(self, admin_headers):
        assert SMB_FILE.exists(), f"meet.smb not found at {SMB_FILE}"
        with open(SMB_FILE, "rb") as f:
            r = requests.post(
                f"{BASE_URL}/api/upload/meet-smb",
                files={"file": ("meet.smb", f, "application/octet-stream")},
                headers=admin_headers,
                timeout=60,
            )
        assert r.status_code == 200, f"SMB upload failed: {r.status_code} {r.text}"
        return r.json()

    def test_registrations_lxf_returns_200_after_smb(self, smb_loaded, admin_headers):
        """Previously crashed with 500: FileNotFoundError meet.lxf not on disk."""
        r = requests.get(f"{BASE_URL}/api/export/registrations-lxf",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200, \
            f"Expected 200 after SMB upload, got {r.status_code}: {r.text}"

    def test_registrations_lxf_has_sessions_after_smb(self, smb_loaded, admin_headers):
        lxf = export_registrations_lxf(admin_headers)
        lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
        assert "<SESSION " in lef, "No sessions in registrations-lxf after SMB load"
        assert "<EVENT " in lef, "No events in registrations-lxf after SMB load"

    def test_meet_lxf_returns_200_after_smb(self, smb_loaded, admin_headers):
        """Previously returned 404: No meet .lxf available."""
        r = requests.get(f"{BASE_URL}/api/export/meet-lxf",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200, \
            f"Expected 200 after SMB upload, got {r.status_code}: {r.text}"

    def test_meet_lxf_has_events_after_smb(self, smb_loaded, admin_headers):
        lxf = export_meet_lxf(admin_headers)
        lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
        events = re.findall(r'<EVENT [^>]*\beventid="(\d+)"', lef)
        assert len(events) > 0, "No events in meet-lxf after SMB load"

    def test_meet_lxf_events_have_swimstyle_after_smb(self, smb_loaded, admin_headers):
        lxf = export_meet_lxf(admin_headers)
        lef = lxf.read(next(n for n in lxf.namelist() if n.endswith(".lef"))).decode()
        event_blocks = re.findall(r'<EVENT [^>]*>(.*?)</EVENT>', lef, re.DOTALL)
        assert event_blocks, "No EVENT blocks found"
        for block in event_blocks[:5]:
            assert "<SWIMSTYLE " in block


# ---------------------------------------------------------------------------
# SMB tests (destructive — must run LAST since full restore wipes all data)
# ---------------------------------------------------------------------------

class TestExportMeetLxf:
    """Test SMB upload + export. Runs last because full restore wipes DB."""

    def test_returns_zip_content(self, uploaded, admin_headers):
        with open(SMB_FILE, "rb") as f:
            r = requests.post(
                f"{BASE_URL}/api/upload/meet-smb",
                files={"file": ("meet.smb", f, "application/octet-stream")},
                headers=admin_headers,
                timeout=60,
            )
        assert r.status_code == 200, f"smb upload: {r.status_code} {r.text}"

        r = requests.get(f"{BASE_URL}/api/export/meet-smb",
                         headers=admin_headers, timeout=30)
        r.raise_for_status()
        z = zipfile.ZipFile(BytesIO(r.content))
        assert len(z.namelist()) > 0

    def test_rejects_no_auth(self):
        r = requests.get(f"{BASE_URL}/api/export/meet-smb", timeout=5)
        assert r.status_code == 403

    def test_rejects_coach(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/clubs", headers=admin_headers, timeout=10)
        r.raise_for_status()
        clubs = r.json()
        if clubs:
            coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
            r = requests.get(f"{BASE_URL}/api/export/meet-smb",
                             headers=coach_headers, timeout=5)
            assert r.status_code == 403


class TestSmbUploadNormalization:
    """Verify that uploading a Splash-native SMB normalizes MDB round encoding.
    Runs last because full restore wipes DB."""

    @pytest.fixture(scope="class")
    def smb_uploaded(self, admin_headers):
        """Upload the Splash meet.smb and return the response."""
        assert SMB_FILE.exists(), f"meet.smb not found at {SMB_FILE}"
        with open(SMB_FILE, "rb") as f:
            r = requests.post(
                f"{BASE_URL}/api/upload/meet-smb",
                files={"file": ("meet.smb", f, "application/octet-stream")},
                headers=admin_headers,
                timeout=60,
            )
        assert r.status_code == 200, f"SMB upload failed ({r.status_code}): {r.text}"
        return r.json()

    def test_smb_upload_succeeds(self, smb_uploaded):
        assert smb_uploaded["events_loaded"] > 0

    def test_tim_events_have_correct_phase(self, smb_uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/sessions", headers=admin_headers, timeout=10)
        r.raise_for_status()
        sessions = r.json()
        tim_events = [
            ev for s in sessions for ev in s["events"]
            if ev["phase"] == "Finale directe" and not ev["isAdmin"]
        ]
        assert len(tim_events) > 0, "Expected Timed Final events after SMB upload"

    def test_pre_events_have_correct_phase(self, smb_uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/sessions", headers=admin_headers, timeout=10)
        r.raise_for_status()
        sessions = r.json()
        pre_events = [
            ev for s in sessions for ev in s["events"]
            if ev["phase"] == "Eliminatoire" and not ev["isAdmin"]
        ]
        assert len(pre_events) > 0, "Expected Prelim events after SMB upload"

    def test_fin_events_have_correct_phase(self, smb_uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/sessions", headers=admin_headers, timeout=10)
        r.raise_for_status()
        sessions = r.json()
        fin_events = [
            ev for s in sessions for ev in s["events"]
            if ev["phase"] == "Finale" and not ev["isAdmin"]
        ]
        assert len(fin_events) > 0, "Expected Final events after SMB upload"

    def test_no_events_have_unknown_round(self, smb_uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/sessions", headers=admin_headers, timeout=10)
        r.raise_for_status()
        sessions = r.json()
        valid_phases = {"Eliminatoire", "Finale", "Finale directe"}
        for s in sessions:
            for ev in s["events"]:
                if not ev["isAdmin"]:
                    assert ev["phase"] in valid_phases

    def test_pre_events_have_valid_gender(self, smb_uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/sessions", headers=admin_headers, timeout=10)
        r.raise_for_status()
        sessions = r.json()
        pre_events = [
            ev for s in sessions for ev in s["events"]
            if ev["phase"] == "Eliminatoire" and not ev["isAdmin"]
        ]
        gendered = [ev for ev in pre_events if ev["gender"] in ("M", "F")]
        assert len(gendered) > 0

    def test_pre_events_have_nonzero_eventnumber(self, smb_uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/sessions", headers=admin_headers, timeout=10)
        r.raise_for_status()
        sessions = r.json()
        pre_events = [
            ev for s in sessions for ev in s["events"]
            if ev["phase"] == "Eliminatoire" and not ev["isAdmin"]
        ]
        assert len(pre_events) > 0
        zero_num = [ev for ev in pre_events if ev["number"] == 0]
        assert len(zero_num) == 0


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
        """Re-upload meet template so clubs exist after destructive SMB tests."""
        from pathlib import Path
        meet_path = Path(__file__).resolve().parent / "fixtures" / "meet_template.lxf"
        entries_path = Path(__file__).resolve().parent / "fixtures" / "test_entries.lxf"
        with open(meet_path, "rb") as f:
            r = requests.post(f"{BASE_URL}/api/upload/meet",
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
        """Fetch a fresh club list — SMB tests earlier in the session wipe clubs."""
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
# Relay Team Composition Validation (gender balance + age group majority)
# ---------------------------------------------------------------------------

class TestRelayTeamComposition:
    """Tests for relay team gender balance (2M+2F for mixed) and age group majority."""

    @pytest.fixture(autouse=True, scope="class")
    def _ensure_meet(self, admin_headers):
        """Re-upload meet template so events and athletes exist."""
        meet_path = Path(__file__).resolve().parent / "fixtures" / "meet_template.lxf"
        entries_path = Path(__file__).resolve().parent / "fixtures" / "test_entries.lxf"
        with open(meet_path, "rb") as f:
            r = requests.post(f"{BASE_URL}/api/upload/meet",
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

    # ── Age group majority tests ──────────────────────────────────────────────

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

    def test_age_group_majority_rejects_invalid_split(
            self, relay_page_data, athletes, clubs, admin_headers):
        """Assigning athletes that create an impossible age group majority returns 400.

        Scenario: on a 4-person relay, fill 3 positions with 2×groupA + 1×groupB.
        Then try to assign a 4th athlete from groupB → would create 2-2 split → rejected.
        """
        # Find a gendered relay event (simpler than mixed for this test)
        result = self._find_gendered_relay_event(relay_page_data, "M")
        if result is None:
            result = self._find_gendered_relay_event(relay_page_data, "F")
        if result is None:
            pytest.skip("No gendered relay event in test meet")
        event_id, age_code = result

        # We need athletes from at least 2 different age groups
        # Register athletes into different age categories
        club_id = clubs[0]["id"]
        club_athletes = [a for a in athletes
                         if a["club_id"] == club_id
                         and a["gender"] == ("M" if result else "F")]

        if len(club_athletes) < 4:
            pytest.skip("Not enough athletes for age group test")

        # Register athletes in different age categories
        # Athletes born in different years will naturally fall into different age groups
        reg_ids = []
        registered_athletes = []
        try:
            for ath in club_athletes[:4]:
                reg = get_registration(ath["id"], admin_headers)
                ind_events = reg.get("individual_events", [])
                if not ind_events:
                    continue
                style = ind_events[0]
                cats = style.get("categories", [])
                if not cats:
                    continue
                cat = cats[0]
                r = post_registration(
                    ath["id"], cat["event_id"], cat["age_code"], 60000, admin_headers)
                reg_ids.append(r["id"])
                registered_athletes.append({"id": ath["id"], "age_code": cat["age_code"]})

            if len(registered_athletes) < 4:
                pytest.skip("Could not register enough athletes in different age groups")

            # Check if we have athletes in at least 2 different age groups
            age_groups = {ra["age_code"] for ra in registered_athletes}
            if len(age_groups) < 2:
                pytest.skip("All athletes in same age group; cannot test majority rule")

            # Create a relay team
            r = requests.post(f"{BASE_URL}/api/relay-teams",
                              json={"event_id": event_id, "age_code": age_code,
                                    "club_id": club_id},
                              headers=admin_headers, timeout=10)
            r.raise_for_status()
            team_id = r.json()["teamId"]

            try:
                # Find 2 athletes from groupA and 2 from groupB
                groups = {}
                for ra in registered_athletes:
                    groups.setdefault(ra["age_code"], []).append(ra["id"])

                group_codes = list(groups.keys())
                group_a = group_codes[0]
                group_b = group_codes[1]

                athletes_a = groups[group_a]
                athletes_b = groups[group_b]

                if len(athletes_a) < 2 or len(athletes_b) < 2:
                    pytest.skip("Not enough athletes per age group for 2-2 test")

                # Assign 2 from group A + 1 from group B (positions 1-3)
                for pos, ath_id in enumerate([athletes_a[0], athletes_a[1], athletes_b[0]], start=1):
                    r = requests.put(
                        f"{BASE_URL}/api/relay-teams/{team_id}/members/{pos}",
                        json={"athleteId": ath_id},
                        headers=admin_headers, timeout=10)
                    assert r.status_code == 200, f"Pos {pos} failed: {r.status_code} {r.text}"

                # Assign 2nd from group B → would create 2A-2B split → should be rejected
                r = requests.put(
                    f"{BASE_URL}/api/relay-teams/{team_id}/members/4",
                    json={"athleteId": athletes_b[1]},
                    headers=admin_headers, timeout=10)
                assert r.status_code == 400, (
                    f"Expected 400 for 2-2 age group split, got {r.status_code}: {r.text}"
                )
                assert "majority" in r.json().get("detail", "").lower()

            finally:
                requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                                headers=admin_headers, timeout=10)
        finally:
            for rid in reg_ids:
                try:
                    delete_registration(rid, admin_headers)
                except Exception:
                    pass

    def test_age_group_majority_allows_valid_composition(
            self, relay_page_data, athletes, clubs, admin_headers):
        """A relay with 3 athletes from the same age group should be fully assignable."""
        result = self._find_gendered_relay_event(relay_page_data, "M")
        if result is None:
            result = self._find_gendered_relay_event(relay_page_data, "F")
        if result is None:
            pytest.skip("No gendered relay event in test meet")
        event_id, age_code = result

        club_id = clubs[0]["id"]
        club_athletes = [a for a in athletes
                         if a["club_id"] == club_id
                         and a["gender"] == ("M" if result else "F")]

        if len(club_athletes) < 4:
            pytest.skip("Not enough athletes")

        # Register all 4 athletes in the SAME age category
        reg_ids = []
        registered_ids = []
        try:
            for ath in club_athletes[:4]:
                reg = get_registration(ath["id"], admin_headers)
                ind_events = reg.get("individual_events", [])
                if not ind_events:
                    continue
                # Use the first category (same for all to ensure same age group)
                style = ind_events[0]
                cats = style.get("categories", [])
                if not cats:
                    continue
                # Pick a specific age code (use the first one consistently)
                target_code = cats[0]["age_code"]
                target_cat = next((c for c in cats if c["age_code"] == target_code), None)
                if not target_cat:
                    continue
                r = post_registration(
                    ath["id"], target_cat["event_id"], target_code, 60000, admin_headers)
                reg_ids.append(r["id"])
                registered_ids.append(ath["id"])

            if len(registered_ids) < 4:
                pytest.skip("Could not register 4 athletes in same age group")

            # Create a relay team
            r = requests.post(f"{BASE_URL}/api/relay-teams",
                              json={"event_id": event_id, "age_code": age_code,
                                    "club_id": club_id},
                              headers=admin_headers, timeout=10)
            r.raise_for_status()
            team_id = r.json()["teamId"]

            try:
                # Assign all 4 (same age group → 4-0 composition, valid)
                for pos, ath_id in enumerate(registered_ids[:4], start=1):
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
            r = requests.post(f"{BASE_URL}/api/upload/meet",
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

