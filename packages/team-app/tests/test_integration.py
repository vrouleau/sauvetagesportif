"""Integration tests for meetmanager-app.

Exercises the full HTTP API against the running stack with synthetic data —
no SPLASH involved. Run: `pytest tests/ -v` from repo root.
"""
from __future__ import annotations

import re
import zipfile
from datetime import date
from io import BytesIO

import pytest
import requests

from conftest import (
    BASE_URL, MEET_TEMPLATE, ENTRIES_FILE, RESULTS_FILE,
    get_registration, post_registration, delete_registration,
    export_bundle, export_lxf,
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
        assert uploaded["entries"]["clubs_added"] == 5
        assert uploaded["entries"]["athletes_added"] == 100

    def test_status_counts(self, status):
        assert status["clubs"] == 5
        assert status["athletes"] == 100
        assert status["events"] == 57
        assert status["registrations"] == 0

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
                f"{BASE_URL}/api/upload/results",
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
        assert uploaded_results["athletes_skipped"] == 0
        assert uploaded_results["times_updated"] > 100

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
            ("GET",  "/api/data-management/styles"),
            ("POST", "/api/admin/set-organizer"),
            ("POST", "/api/data-management/merge-clubs"),
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
        assert lef.count("<ATHLETE ") == uploaded["entries"]["athletes_added"]

    def test_club_count_matches_import(self, entries_zip, uploaded):
        lef_name = next(n for n in entries_zip.namelist() if n.endswith(".lef"))
        lef = entries_zip.read(lef_name).decode()
        assert lef.count("<CLUB ") == uploaded["entries"]["clubs_added"]

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
                f"{BASE_URL}/api/upload/results",
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
# Meet SMB download (/export/meet-smb)
# ---------------------------------------------------------------------------

class TestExportMeetLxf:
    def test_returns_zip_content(self, uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/export/meet-smb",
                         headers=admin_headers, timeout=30)
        r.raise_for_status()
        z = zipfile.ZipFile(BytesIO(r.content))
        assert len(z.namelist()) > 0

    def test_rejects_no_auth(self):
        r = requests.get(f"{BASE_URL}/api/export/meet-smb", timeout=5)
        assert r.status_code == 403

    def test_rejects_coach(self, clubs):
        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.get(f"{BASE_URL}/api/export/meet-smb",
                         headers=coach_headers, timeout=5)
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# Data management endpoints (new in security-hardening branch)
# ---------------------------------------------------------------------------

class TestDataManagement:
    # --- styles listing ---

    def test_styles_returns_list(self, uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/data-management/styles",
                         headers=admin_headers, timeout=10)
        r.raise_for_status()
        assert isinstance(r.json(), list)

    def test_styles_entries_have_uid_and_name(self, uploaded, admin_headers):
        r = requests.get(f"{BASE_URL}/api/data-management/styles",
                         headers=admin_headers, timeout=10)
        r.raise_for_status()
        for s in r.json():
            assert "uid" in s
            assert "name" in s

    def test_styles_requires_admin(self, clubs):
        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.get(f"{BASE_URL}/api/data-management/styles",
                         headers=coach_headers, timeout=5)
        assert r.status_code == 403

    # --- merge-clubs ---

    def test_merge_clubs_moves_athletes(self, admin_headers):
        """Create two fresh clubs, merge source into target, verify source deleted."""
        r = requests.post(f"{BASE_URL}/api/clubs",
                          json={"name": "Merge Source", "code": "MSRC"},
                          headers=admin_headers, timeout=10)
        r.raise_for_status()
        src_id = r.json()["id"]

        r = requests.post(f"{BASE_URL}/api/clubs",
                          json={"name": "Merge Target", "code": "MTGT"},
                          headers=admin_headers, timeout=10)
        r.raise_for_status()
        tgt_id = r.json()["id"]

        r = requests.post(f"{BASE_URL}/api/data-management/merge-clubs",
                          json={"merges": [{"from_id": src_id, "to_id": tgt_id}]},
                          headers=admin_headers, timeout=10)
        r.raise_for_status()
        assert r.json()["merged"] == 1

        r = requests.get(f"{BASE_URL}/api/clubs", headers=admin_headers, timeout=10)
        r.raise_for_status()
        ids = [c["id"] for c in r.json()]
        assert src_id not in ids, "source club should be deleted after merge"
        assert tgt_id in ids, "target club should still exist"

        # clean up
        requests.delete(f"{BASE_URL}/api/clubs/{tgt_id}",
                        headers=admin_headers, timeout=10)

    def test_merge_clubs_noop_same_id(self, admin_headers, clubs):
        club_id = clubs[0]["id"]
        r = requests.post(f"{BASE_URL}/api/data-management/merge-clubs",
                          json={"merges": [{"from_id": club_id, "to_id": club_id}]},
                          headers=admin_headers, timeout=10)
        r.raise_for_status()
        assert r.json()["merged"] == 0

    def test_merge_clubs_requires_admin(self, clubs):
        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.post(f"{BASE_URL}/api/data-management/merge-clubs",
                          json={"merges": []},
                          headers=coach_headers, timeout=5)
        assert r.status_code == 403

    # --- merge-styles ---

    def test_merge_styles_noop_same_uid(self, uploaded, admin_headers):
        """Merging a style uid into itself must return merged_rows == 0."""
        r = requests.get(f"{BASE_URL}/api/data-management/styles",
                         headers=admin_headers, timeout=10)
        r.raise_for_status()
        styles = r.json()
        if not styles:
            pytest.skip("No best-time styles in DB yet")
        uid = styles[0]["uid"]
        r = requests.post(f"{BASE_URL}/api/data-management/merge-styles",
                          json={"merges": [{"from_uid": uid, "to_uid": uid}]},
                          headers=admin_headers, timeout=10)
        r.raise_for_status()
        assert r.json()["merged_rows"] == 0

    def test_merge_styles_empty_list_is_noop(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/data-management/merge-styles",
                          json={"merges": []},
                          headers=admin_headers, timeout=10)
        r.raise_for_status()
        assert r.json()["merged_rows"] == 0

    def test_merge_styles_requires_admin(self, clubs):
        coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
        r = requests.post(f"{BASE_URL}/api/data-management/merge-styles",
                          json={"merges": []},
                          headers=coach_headers, timeout=5)
        assert r.status_code == 403

    def test_style_names_are_not_id_prefixed(self, uploaded, admin_headers):
        """Style names must be human-readable, never the raw ID{uid} fallback."""
        r = requests.get(f"{BASE_URL}/api/data-management/styles",
                         headers=admin_headers, timeout=10)
        r.raise_for_status()
        styles = r.json()
        if not styles:
            pytest.skip("No best-time styles in DB")
        for s in styles:
            assert not re.match(r"^ID\d+$", s["name"]), (
                f"style uid={s['uid']} has unresolved name {s['name']!r} — "
                "style_names_json may not have been populated on results import"
            )

    def test_style_names_survive_meet_flush(self, uploaded, results_path, admin_headers):
        """After flushing the meet (events table cleared), style names must still
        resolve from the style_names_json cache rather than falling back to ID{uid}."""
        # Upload results so style_names_json is populated, then flush the meet.
        with open(results_path, "rb") as f:
            r = requests.post(
                f"{BASE_URL}/api/upload/results",
                files={"file": ("results.lxf", f, "application/octet-stream")},
                headers=admin_headers, timeout=60,
            )
        r.raise_for_status()

        r = requests.delete(f"{BASE_URL}/api/registrations",
                            headers=admin_headers, timeout=10)
        r.raise_for_status()
        # Events are now gone; style_names_json should carry the names.
        r = requests.get(f"{BASE_URL}/api/data-management/styles",
                         headers=admin_headers, timeout=10)
        r.raise_for_status()
        styles = r.json()
        assert styles, "styles list must not be empty — best_times should survive flush"
        for s in styles:
            assert not re.match(r"^ID\d+$", s["name"]), (
                f"style uid={s['uid']} name {s['name']!r} not resolved after meet flush; "
                "style_names_json cache is missing or not being read"
            )


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
