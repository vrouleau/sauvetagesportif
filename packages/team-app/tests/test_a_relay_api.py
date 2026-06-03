"""Integration tests for the relay team API endpoints.

Exercises GET /relay-teams, POST /relay-teams, DELETE /relay-teams/{id},
PUT /relay-teams/{id}/members/{pos}, and PUT /relay-teams/{id}/name
against a running stack with synthetic data.

Requirements tested: 5.2, 7.1, 7.2, 7.4, 7.6, 8.5
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
import requests

from conftest import BASE_URL


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_relay_event(admin_headers: dict) -> dict | None:
    """Return the first relay event (relay_count > 1, not a final)."""
    r = requests.get(f"{BASE_URL}/api/events", headers=admin_headers, timeout=10)
    r.raise_for_status()
    events = r.json()
    # Filter relay events (relay_count > 1) excluding finals (round=FIN)
    relay_events = [e for e in events if e.get("relay_count", 1) > 1]
    return relay_events[0] if relay_events else None


def _get_relay_page_data(headers: dict, club_id: int | None = None) -> dict:
    params = {}
    if club_id is not None:
        params["club_id"] = club_id
    r = requests.get(f"{BASE_URL}/api/relay-teams", headers=headers,
                     params=params, timeout=10)
    r.raise_for_status()
    return r.json()


def _set_closure_date(admin_headers: dict, date_str: str):
    """Set or clear the closure date via admin API."""
    r = requests.put(f"{BASE_URL}/api/closure-date",
                     json={"closure_date": date_str},
                     headers=admin_headers, timeout=5)
    r.raise_for_status()


def _set_organizer(admin_headers: dict, club_id: int):
    """Mark a club as organizer."""
    r = requests.post(f"{BASE_URL}/api/admin/set-organizer",
                      json={"club_id": club_id},
                      headers=admin_headers, timeout=5)
    r.raise_for_status()


# ---------------------------------------------------------------------------
# Test class: Relay Team CRUD
# ---------------------------------------------------------------------------

class TestRelayTeamCRUD:
    """End-to-end tests for relay team create, read, update, delete."""

    @pytest.fixture(scope="class")
    def relay_event(self, uploaded, admin_headers) -> dict:
        """Find a relay event available in the test meet."""
        ev = _find_relay_event(admin_headers)
        if not ev:
            pytest.skip("No relay events in test meet")
        return ev

    @pytest.fixture(scope="class")
    def relay_age_code(self, relay_event, clubs, admin_headers) -> str:
        """Find a valid age code for the relay event."""
        data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
        # Look through age categories to find one with our event
        for cat in data["ageCategories"]:
            for ev in cat["events"]:
                if ev["eventId"] == relay_event["id"]:
                    return cat["ageCode"]
        # Fallback: try "Open"
        return "Open"

    def test_get_relay_page_data_returns_structure(self, uploaded, admin_headers, clubs):
        """GET /relay-teams returns expected top-level keys."""
        data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
        assert "ageCategories" in data
        assert "teamsByEvent" in data
        assert "eligibleAthletes" in data
        assert "closureDate" in data
        assert "isClosed" in data
        assert isinstance(data["ageCategories"], list)

    def test_get_relay_page_data_has_relay_events(
            self, uploaded, admin_headers, clubs, relay_event):
        """Relay page data includes at least one relay event."""
        data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
        all_event_ids = []
        for cat in data["ageCategories"]:
            for ev in cat["events"]:
                all_event_ids.append(ev["eventId"])
        assert relay_event["id"] in all_event_ids

    def test_create_relay_team(self, uploaded, admin_headers, clubs,
                               relay_event, relay_age_code):
        """POST /relay-teams creates a team and returns teamId + teamNumber."""
        r = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": clubs[0]["id"]},
            headers=admin_headers, timeout=10,
        )
        assert r.status_code == 200
        body = r.json()
        assert "teamId" in body
        assert "teamNumber" in body
        assert body["teamNumber"] in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

        # Cleanup
        requests.delete(f"{BASE_URL}/api/relay-teams/{body['teamId']}",
                        headers=admin_headers, timeout=5)

    def test_created_team_appears_in_page_data(self, uploaded, admin_headers, clubs,
                                                relay_event, relay_age_code):
        """A newly created team shows up in GET /relay-teams response."""
        r = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": clubs[0]["id"]},
            headers=admin_headers, timeout=10,
        )
        r.raise_for_status()
        team_id = r.json()["teamId"]

        try:
            data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
            # Find the team in teamsByEvent
            found = False
            for key, teams in data["teamsByEvent"].items():
                for t in teams:
                    if t["id"] == team_id:
                        found = True
                        # Team should have empty members
                        assert len(t["members"]) > 0
                        for m in t["members"]:
                            assert m["athleteId"] is None
                        break
            assert found, f"Team {team_id} not found in relay page data"
        finally:
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)

    def test_delete_relay_team(self, uploaded, admin_headers, clubs,
                               relay_event, relay_age_code):
        """DELETE /relay-teams/{id} removes the team."""
        # Create a team
        r = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": clubs[0]["id"]},
            headers=admin_headers, timeout=10,
        )
        r.raise_for_status()
        team_id = r.json()["teamId"]

        # Delete it
        r = requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)
        assert r.status_code == 200

        # Verify it's gone
        data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
        for key, teams in data["teamsByEvent"].items():
            for t in teams:
                assert t["id"] != team_id

    def test_assign_member_to_position(self, uploaded, admin_headers, clubs,
                                       athletes, relay_event, relay_age_code):
        """PUT /relay-teams/{id}/members/{pos} assigns an athlete."""
        # Create a team
        r = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": clubs[0]["id"]},
            headers=admin_headers, timeout=10,
        )
        r.raise_for_status()
        team_id = r.json()["teamId"]

        try:
            # Find an eligible athlete from the relay page data
            data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
            event_key = None
            for cat in data["ageCategories"]:
                for ev in cat["events"]:
                    if ev["eventId"] == relay_event["id"]:
                        event_key = f"{ev['eventId']}-{cat['ageCode']}"
                        break

            eligible = data["eligibleAthletes"].get(event_key, [])
            if not eligible:
                pytest.skip("No eligible athletes for relay event")

            athlete_id = eligible[0]["id"]

            # Assign to position 1
            r = requests.put(
                f"{BASE_URL}/api/relay-teams/{team_id}/members/1",
                json={"athleteId": athlete_id},
                headers=admin_headers, timeout=10,
            )
            assert r.status_code == 200

            # Verify the assignment
            data2 = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
            team = None
            for key, teams in data2["teamsByEvent"].items():
                for t in teams:
                    if t["id"] == team_id:
                        team = t
                        break
            assert team is not None
            pos1 = next(m for m in team["members"] if m["position"] == 1)
            assert pos1["athleteId"] == athlete_id
        finally:
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)

    def test_remove_member_from_position(self, uploaded, admin_headers, clubs,
                                         relay_event, relay_age_code):
        """Assigning athleteId=null removes the athlete from a position."""
        # Create team and assign member
        r = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": clubs[0]["id"]},
            headers=admin_headers, timeout=10,
        )
        r.raise_for_status()
        team_id = r.json()["teamId"]

        try:
            data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
            event_key = None
            for cat in data["ageCategories"]:
                for ev in cat["events"]:
                    if ev["eventId"] == relay_event["id"]:
                        event_key = f"{ev['eventId']}-{cat['ageCode']}"
                        break
            eligible = data["eligibleAthletes"].get(event_key, [])
            if not eligible:
                pytest.skip("No eligible athletes for relay event")
            athlete_id = eligible[0]["id"]

            # Assign
            requests.put(
                f"{BASE_URL}/api/relay-teams/{team_id}/members/1",
                json={"athleteId": athlete_id},
                headers=admin_headers, timeout=10,
            )

            # Remove (set to null)
            r = requests.put(
                f"{BASE_URL}/api/relay-teams/{team_id}/members/1",
                json={"athleteId": None},
                headers=admin_headers, timeout=10,
            )
            assert r.status_code == 200

            # Verify removed
            data2 = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
            team = None
            for key, teams in data2["teamsByEvent"].items():
                for t in teams:
                    if t["id"] == team_id:
                        team = t
                        break
            assert team is not None
            pos1 = next(m for m in team["members"] if m["position"] == 1)
            assert pos1["athleteId"] is None
        finally:
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)

    def test_set_custom_team_name(self, uploaded, admin_headers, clubs,
                                   relay_event, relay_age_code):
        """PUT /relay-teams/{id}/name sets a custom team name."""
        r = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": clubs[0]["id"]},
            headers=admin_headers, timeout=10,
        )
        r.raise_for_status()
        team_id = r.json()["teamId"]

        try:
            # Set name
            r = requests.put(
                f"{BASE_URL}/api/relay-teams/{team_id}/name",
                json={"name": "Lightning Bolts"},
                headers=admin_headers, timeout=10,
            )
            assert r.status_code == 200

            # Verify name appears in page data
            data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
            team = None
            for key, teams in data["teamsByEvent"].items():
                for t in teams:
                    if t["id"] == team_id:
                        team = t
                        break
            assert team is not None
            assert team["teamName"] == "Lightning Bolts"
        finally:
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)


# ---------------------------------------------------------------------------
# Test class: Uniqueness Constraint (409 responses)
# ---------------------------------------------------------------------------

class TestRelayUniqueness:
    """Test that assigning an athlete to multiple teams for same event returns 409."""

    @pytest.fixture(scope="class")
    def relay_event(self, uploaded, admin_headers) -> dict:
        ev = _find_relay_event(admin_headers)
        if not ev:
            pytest.skip("No relay events in test meet")
        return ev

    @pytest.fixture(scope="class")
    def relay_age_code(self, relay_event, clubs, admin_headers) -> str:
        data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
        for cat in data["ageCategories"]:
            for ev in cat["events"]:
                if ev["eventId"] == relay_event["id"]:
                    return cat["ageCode"]
        return "Open"

    def test_cross_team_uniqueness_409(self, uploaded, admin_headers, clubs,
                                       relay_event, relay_age_code):
        """Assigning same athlete to two different teams → 409 Conflict."""
        club_id = clubs[0]["id"]

        # Create two teams
        r1 = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": club_id},
            headers=admin_headers, timeout=10,
        )
        r1.raise_for_status()
        team_a_id = r1.json()["teamId"]

        r2 = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": club_id},
            headers=admin_headers, timeout=10,
        )
        r2.raise_for_status()
        team_b_id = r2.json()["teamId"]

        try:
            # Find an eligible athlete
            data = _get_relay_page_data(admin_headers, club_id=club_id)
            event_key = f"{relay_event['id']}-{relay_age_code}"
            eligible = data["eligibleAthletes"].get(event_key, [])
            if not eligible:
                pytest.skip("No eligible athletes for relay event")
            athlete_id = eligible[0]["id"]

            # Assign to team A, position 1
            r = requests.put(
                f"{BASE_URL}/api/relay-teams/{team_a_id}/members/1",
                json={"athleteId": athlete_id},
                headers=admin_headers, timeout=10,
            )
            assert r.status_code == 200

            # Try to assign same athlete to team B → should get 409
            r = requests.put(
                f"{BASE_URL}/api/relay-teams/{team_b_id}/members/1",
                json={"athleteId": athlete_id},
                headers=admin_headers, timeout=10,
            )
            assert r.status_code == 409
            assert "already assigned" in r.json()["detail"].lower()
        finally:
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_a_id}",
                            headers=admin_headers, timeout=5)
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_b_id}",
                            headers=admin_headers, timeout=5)

    def test_intra_team_uniqueness_409(self, uploaded, admin_headers, clubs,
                                       relay_event, relay_age_code):
        """Assigning same athlete to two positions on same team → 409."""
        club_id = clubs[0]["id"]

        r = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": club_id},
            headers=admin_headers, timeout=10,
        )
        r.raise_for_status()
        team_id = r.json()["teamId"]

        try:
            data = _get_relay_page_data(admin_headers, club_id=club_id)
            event_key = f"{relay_event['id']}-{relay_age_code}"
            eligible = data["eligibleAthletes"].get(event_key, [])
            if not eligible:
                pytest.skip("No eligible athletes for relay event")
            athlete_id = eligible[0]["id"]

            # Assign to position 1
            r = requests.put(
                f"{BASE_URL}/api/relay-teams/{team_id}/members/1",
                json={"athleteId": athlete_id},
                headers=admin_headers, timeout=10,
            )
            assert r.status_code == 200

            # Try same athlete in position 2 → 409
            r = requests.put(
                f"{BASE_URL}/api/relay-teams/{team_id}/members/2",
                json={"athleteId": athlete_id},
                headers=admin_headers, timeout=10,
            )
            assert r.status_code == 409
        finally:
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)


# ---------------------------------------------------------------------------
# Test class: Closure Date Enforcement
# ---------------------------------------------------------------------------

class TestRelayClosureDate:
    """Test closure date blocking for coach and bypass for admin/organizer."""

    @pytest.fixture(scope="class")
    def relay_event(self, uploaded, admin_headers) -> dict:
        ev = _find_relay_event(admin_headers)
        if not ev:
            pytest.skip("No relay events in test meet")
        return ev

    @pytest.fixture(scope="class")
    def relay_age_code(self, relay_event, clubs, admin_headers) -> str:
        data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
        for cat in data["ageCategories"]:
            for ev in cat["events"]:
                if ev["eventId"] == relay_event["id"]:
                    return cat["ageCode"]
        return "Open"

    def test_closure_blocks_coach_create(self, uploaded, admin_headers, clubs,
                                          relay_event, relay_age_code):
        """Coach cannot create relay team after closure date."""
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        _set_closure_date(admin_headers, yesterday)

        try:
            coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
            r = requests.post(
                f"{BASE_URL}/api/relay-teams",
                json={"event_id": relay_event["id"],
                      "age_code": relay_age_code},
                headers=coach_headers, timeout=10,
            )
            assert r.status_code == 403
        finally:
            _set_closure_date(admin_headers, "")

    def test_closure_blocks_coach_assign_member(self, uploaded, admin_headers, clubs,
                                                 relay_event, relay_age_code):
        """Coach cannot assign a member after closure date."""
        # Create team while open (as admin)
        r = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": clubs[0]["id"]},
            headers=admin_headers, timeout=10,
        )
        r.raise_for_status()
        team_id = r.json()["teamId"]

        yesterday = (date.today() - timedelta(days=1)).isoformat()
        _set_closure_date(admin_headers, yesterday)

        try:
            coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
            r = requests.put(
                f"{BASE_URL}/api/relay-teams/{team_id}/members/1",
                json={"athleteId": 1},
                headers=coach_headers, timeout=10,
            )
            assert r.status_code == 403
        finally:
            _set_closure_date(admin_headers, "")
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)

    def test_closure_blocks_coach_delete(self, uploaded, admin_headers, clubs,
                                          relay_event, relay_age_code):
        """Coach cannot delete relay team after closure date."""
        # Create team while open (as admin)
        r = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": clubs[0]["id"]},
            headers=admin_headers, timeout=10,
        )
        r.raise_for_status()
        team_id = r.json()["teamId"]

        yesterday = (date.today() - timedelta(days=1)).isoformat()
        _set_closure_date(admin_headers, yesterday)

        try:
            coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
            r = requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                                headers=coach_headers, timeout=5)
            assert r.status_code == 403
        finally:
            _set_closure_date(admin_headers, "")
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)

    def test_admin_bypasses_closure(self, uploaded, admin_headers, clubs,
                                     relay_event, relay_age_code):
        """Admin can create relay team even after closure date."""
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        _set_closure_date(admin_headers, yesterday)

        try:
            r = requests.post(
                f"{BASE_URL}/api/relay-teams",
                json={"event_id": relay_event["id"],
                      "age_code": relay_age_code,
                      "club_id": clubs[0]["id"]},
                headers=admin_headers, timeout=10,
            )
            assert r.status_code == 200
            team_id = r.json()["teamId"]
            # Cleanup
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)
        finally:
            _set_closure_date(admin_headers, "")

    def test_organizer_bypasses_closure(self, uploaded, admin_headers, clubs,
                                         relay_event, relay_age_code):
        """Organizer can create relay team even after closure date."""
        # Set one club as organizer
        _set_organizer(admin_headers, clubs[1]["id"])
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        _set_closure_date(admin_headers, yesterday)

        try:
            organizer_headers = {"X-Club-Pin": clubs[1]["pin"]}
            r = requests.post(
                f"{BASE_URL}/api/relay-teams",
                json={"event_id": relay_event["id"],
                      "age_code": relay_age_code},
                headers=organizer_headers, timeout=10,
            )
            assert r.status_code == 200
            team_id = r.json()["teamId"]
            # Cleanup
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)
        finally:
            _set_closure_date(admin_headers, "")

    def test_is_closed_flag_for_coach(self, uploaded, admin_headers, clubs):
        """GET /relay-teams returns isClosed=true for coach when past closure."""
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        _set_closure_date(admin_headers, yesterday)

        try:
            coach_headers = {"X-Club-Pin": clubs[0]["pin"]}
            data = _get_relay_page_data(coach_headers)
            assert data["isClosed"] is True
        finally:
            _set_closure_date(admin_headers, "")

    def test_is_closed_flag_false_for_admin(self, uploaded, admin_headers, clubs):
        """GET /relay-teams returns isClosed=false for admin even past closure."""
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        _set_closure_date(admin_headers, yesterday)

        try:
            data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
            assert data["isClosed"] is False
        finally:
            _set_closure_date(admin_headers, "")


# ---------------------------------------------------------------------------
# Test class: Existing Relay Data Display
# ---------------------------------------------------------------------------

class TestRelayExistingData:
    """Test that existing relay data from MDB import displays correctly."""

    def test_relay_page_data_returns_existing_teams(self, uploaded, admin_headers, clubs):
        """Existing relay data (from uploaded meet) shows in relay page data.

        The meet template may or may not have relay data pre-loaded. This test
        verifies the endpoint returns without error and the structure is correct.
        """
        data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
        # Structural assertions
        assert isinstance(data["ageCategories"], list)
        assert isinstance(data["teamsByEvent"], dict)
        # Each team entry must have expected fields
        for key, teams in data["teamsByEvent"].items():
            for t in teams:
                assert "id" in t
                assert "teamNumber" in t
                assert "members" in t
                for m in t["members"]:
                    assert "position" in m
                    assert "athleteId" in m
                    assert "athleteName" in m

    def test_eligible_athletes_populated_for_club(self, uploaded, admin_headers, clubs):
        """Eligible athletes list is populated when club_id is specified."""
        data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
        # If there are relay events, there should be eligible athletes
        if data["ageCategories"]:
            # At least some event/age combo should have eligible athletes
            has_eligible = any(
                len(athletes) > 0
                for athletes in data["eligibleAthletes"].values()
            )
            assert has_eligible, (
                "Expected some eligible athletes for relay events"
            )

    def test_eligible_athletes_format(self, uploaded, admin_headers, clubs):
        """Eligible athletes have id, name, and gender fields."""
        data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
        for key, athletes in data["eligibleAthletes"].items():
            for a in athletes:
                assert "id" in a
                assert "name" in a
                assert "gender" in a
                # Name should be "LastName, FirstName" format
                assert ", " in a["name"]
                assert a["gender"] in ("M", "F")


# ---------------------------------------------------------------------------
# Test class: Invalid Position (400 responses)
# ---------------------------------------------------------------------------

class TestRelayInvalidPosition:
    """Test that invalid position numbers are rejected with 400."""

    @pytest.fixture(scope="class")
    def relay_event(self, uploaded, admin_headers) -> dict:
        ev = _find_relay_event(admin_headers)
        if not ev:
            pytest.skip("No relay events in test meet")
        return ev

    @pytest.fixture(scope="class")
    def relay_age_code(self, relay_event, clubs, admin_headers) -> str:
        data = _get_relay_page_data(admin_headers, club_id=clubs[0]["id"])
        for cat in data["ageCategories"]:
            for ev in cat["events"]:
                if ev["eventId"] == relay_event["id"]:
                    return cat["ageCode"]
        return "Open"

    def test_position_zero_rejected(self, uploaded, admin_headers, clubs,
                                     relay_event, relay_age_code):
        """Position 0 is invalid (positions are 1-based)."""
        r = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": clubs[0]["id"]},
            headers=admin_headers, timeout=10,
        )
        r.raise_for_status()
        team_id = r.json()["teamId"]

        try:
            r = requests.put(
                f"{BASE_URL}/api/relay-teams/{team_id}/members/0",
                json={"athleteId": 1},
                headers=admin_headers, timeout=10,
            )
            assert r.status_code == 400
            assert "invalid position" in r.json()["detail"].lower()
        finally:
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)

    def test_position_exceeding_relaycount_rejected(self, uploaded, admin_headers, clubs,
                                                     relay_event, relay_age_code):
        """Position > relaycount is invalid."""
        r = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": clubs[0]["id"]},
            headers=admin_headers, timeout=10,
        )
        r.raise_for_status()
        team_id = r.json()["teamId"]

        try:
            # Typical relaycount is 4; position 99 is certainly invalid
            r = requests.put(
                f"{BASE_URL}/api/relay-teams/{team_id}/members/99",
                json={"athleteId": 1},
                headers=admin_headers, timeout=10,
            )
            assert r.status_code == 400
            assert "invalid position" in r.json()["detail"].lower()
        finally:
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)

    def test_negative_position_rejected(self, uploaded, admin_headers, clubs,
                                         relay_event, relay_age_code):
        """Negative position number is invalid."""
        r = requests.post(
            f"{BASE_URL}/api/relay-teams",
            json={"event_id": relay_event["id"],
                  "age_code": relay_age_code,
                  "club_id": clubs[0]["id"]},
            headers=admin_headers, timeout=10,
        )
        r.raise_for_status()
        team_id = r.json()["teamId"]

        try:
            r = requests.put(
                f"{BASE_URL}/api/relay-teams/{team_id}/members/-1",
                json={"athleteId": 1},
                headers=admin_headers, timeout=10,
            )
            # Could be 400 or 422 depending on path validation
            assert r.status_code in (400, 422)
        finally:
            requests.delete(f"{BASE_URL}/api/relay-teams/{team_id}",
                            headers=admin_headers, timeout=5)

    def test_delete_nonexistent_team_returns_404(self, uploaded, admin_headers):
        """Deleting a team that doesn't exist → 404."""
        r = requests.delete(f"{BASE_URL}/api/relay-teams/999999",
                            headers=admin_headers, timeout=5)
        assert r.status_code == 404
