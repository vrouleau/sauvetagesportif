"""Pytest fixtures: bring up docker compose, upload meet + entries, expose helpers."""
from __future__ import annotations

import os
import subprocess
import time
import zipfile
from io import BytesIO
from pathlib import Path

import pytest
import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
TEST_ENV_FILE = Path(__file__).resolve().parent / "test.env"
MEET_TEMPLATE = FIXTURES / "meet_template.lxf"
ENTRIES_FILE = FIXTURES / "test_entries.lxf"
RESULTS_FILE = FIXTURES / "test_results.lxf"

BASE_URL = os.environ.get("MEETMGR_URL", "http://127.0.0.1:8000")
ADMIN_PIN = os.environ.get("ADMIN_PIN", "314159")
HEALTH_TIMEOUT = 90  # backend can take a while on first build
KEEP_STACK = os.environ.get("MEETMGR_KEEP_STACK") == "1"
# Set MEETMGR_SKIP_STACK=1 if you've already brought up a clean stack from
# outside (e.g. when running pytest from a container that lacks docker).
SKIP_STACK = os.environ.get("MEETMGR_SKIP_STACK") == "1"


def _run_compose(args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["docker", "compose",
         "-f", "docker-compose.yml",
         "-f", "docker-compose.test.yml",
         "--env-file", str(TEST_ENV_FILE), *args],
        cwd=REPO_ROOT, check=check, capture_output=True,
    )


def _wait_healthy() -> None:
    deadline = time.time() + HEALTH_TIMEOUT
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            r = requests.get(f"{BASE_URL}/api/status", timeout=3)
            if r.status_code == 200:
                return
        except requests.RequestException as e:
            last_err = e
        time.sleep(2)
    pytest.fail(f"Backend did not become healthy within {HEALTH_TIMEOUT}s ({last_err})")


@pytest.fixture(scope="session", autouse=True)
def stack():
    """Wipe + bring up the docker stack, tear down after the suite."""
    if SKIP_STACK:
        _wait_healthy()
        yield
        return
    _run_compose(["down", "-v"], check=False)
    _run_compose(["up", "--build", "-d"])
    _wait_healthy()
    yield
    if not KEEP_STACK:
        _run_compose(["down", "-v"], check=False)


@pytest.fixture(scope="session")
def admin_headers() -> dict:
    return {"X-Club-Pin": ADMIN_PIN}


@pytest.fixture(scope="session")
def entries_path() -> Path:
    """Regenerate the entries .lxf if missing."""
    if not ENTRIES_FILE.exists():
        subprocess.run(
            ["python3", "tests/generate_test_entries.py", "--out", str(ENTRIES_FILE)],
            cwd=REPO_ROOT, check=True,
        )
    return ENTRIES_FILE


@pytest.fixture(scope="session")
def results_path(entries_path) -> Path:
    """Regenerate the results .lxf if missing (depends on entries fixture)."""
    if not RESULTS_FILE.exists():
        subprocess.run(
            ["python3", "tests/generate_test_results.py",
             "--meet", str(MEET_TEMPLATE),
             "--entries", str(entries_path),
             "--out", str(RESULTS_FILE)],
            cwd=REPO_ROOT, check=True,
        )
    return RESULTS_FILE


@pytest.fixture(scope="session")
def uploaded(entries_path, admin_headers) -> dict:
    """Upload meet template + generated entries. Returns counts from the API."""
    with open(MEET_TEMPLATE, "rb") as f:
        r = requests.post(
            f"{BASE_URL}/api/upload/meet",
            files={"file": ("meet.lxf", f, "application/octet-stream")},
            headers=admin_headers,
            timeout=60,
        )
    assert r.status_code == 200, f"meet upload: {r.status_code} {r.text}"
    meet_resp = r.json()

    with open(entries_path, "rb") as f:
        r = requests.post(
            f"{BASE_URL}/api/upload/entries",
            files={"file": ("entries.lxf", f, "application/octet-stream")},
            headers=admin_headers,
            timeout=60,
        )
    assert r.status_code == 200, f"entries upload: {r.status_code} {r.text}"
    entries_resp = r.json()

    return {"meet": meet_resp, "entries": entries_resp}


@pytest.fixture(scope="session")
def status(uploaded) -> dict:
    r = requests.get(f"{BASE_URL}/api/status", timeout=10)
    r.raise_for_status()
    return r.json()


@pytest.fixture(scope="session")
def clubs(uploaded, admin_headers) -> list[dict]:
    r = requests.get(f"{BASE_URL}/api/clubs", headers=admin_headers, timeout=10)
    r.raise_for_status()
    return r.json()


@pytest.fixture(scope="session")
def athletes(uploaded, admin_headers) -> list[dict]:
    r = requests.get(f"{BASE_URL}/api/athletes", headers=admin_headers, timeout=10)
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------------------
# Helpers exposed to tests
# ---------------------------------------------------------------------------

def get_registration(athlete_id: int, headers: dict) -> dict:
    r = requests.get(
        f"{BASE_URL}/api/athletes/{athlete_id}/registration",
        headers=headers, timeout=10,
    )
    r.raise_for_status()
    return r.json()


def post_registration(athlete_id: int, event_id: int, age_code: str,
                      entry_time_ms: int | None, headers: dict) -> dict:
    r = requests.post(
        f"{BASE_URL}/api/registrations",
        json={
            "athlete_id": athlete_id, "event_id": event_id,
            "age_code": age_code, "entry_time_ms": entry_time_ms,
        },
        headers=headers, timeout=10,
    )
    r.raise_for_status()
    return r.json()


def delete_registration(reg_id: int, headers: dict) -> None:
    r = requests.delete(f"{BASE_URL}/api/registrations/{reg_id}",
                        headers=headers, timeout=10)
    r.raise_for_status()


def export_bundle(headers: dict) -> zipfile.ZipFile:
    """Return the outer zip returned by /api/export (lxf + helper scripts)."""
    r = requests.get(f"{BASE_URL}/api/export", headers=headers, timeout=30)
    r.raise_for_status()
    return zipfile.ZipFile(BytesIO(r.content))


def export_lxf(headers: dict) -> zipfile.ZipFile:
    """Return the inner inscriptions.lxf (Lenex zip) extracted from the bundle."""
    bundle = export_bundle(headers)
    inner = bundle.read("inscriptions.lxf")
    return zipfile.ZipFile(BytesIO(inner))
