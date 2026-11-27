---
name: team-tests
description: Run the team-app test suite (pytest integration tests in Docker via WSL, or the Docker-free unit tests) and report results. Use when asked to run team-app / team integration / backend tests.
disable-model-invocation: true
argument-hint: "[unit | integration | keep | skip-stack] [pytest -k expr or path]"
---

# Run team-app tests

Tests live in `packages/team-app/tests/`. Integration tests need Docker and are meant to run from a **WSL terminal** on the user's Windows machine (repo at `/mnt/c/Users/eoivnru/Documents/MeetManager/sauvetagesportif`). This Claude session may be a Linux container with no Docker: check first with `docker info`; if Docker is unavailable, run only the unit tests and say integration tests could not run.

Arguments: `$ARGUMENTS`

## Modes
| Arg | Command (from `packages/team-app/`) |
|---|---|
| `unit` (or no Docker) | `python3 -m pytest tests/unit/ -v` |
| `integration` (default when Docker works) | `python3 -m pytest tests/ -v` — pytest wipes + rebuilds the test stack, waits for health, runs, tears down |
| `skip-stack` | `MEETMGR_SKIP_STACK=1 python3 -m pytest tests/ -v` — use an already-running stack on `http://127.0.0.1:8000` |
| `keep` | `MEETMGR_KEEP_STACK=1 python3 -m pytest tests/ -v` — leave stack up afterwards |

Any extra argument (path or `-k expr`) is appended to the pytest command.

## Steps
1. `cd packages/team-app` (never run `docker compose` from the repo root — build context is `../..`).
2. First time: `pip install -r tests/requirements-test.txt`.
3. Run the chosen mode. Use `--tb=short`; on failure, re-run only the failing test(s) with `-x -vv`.
4. Report: pass/fail counts, each failing test with the key assertion, and whether it looks like a code bug, a stale fixture, or an environment problem. Don't skip/xfail tests to get green.

## Safety rules (these have burned the user before)
- Test stack MUST use compose project `-p team-app-test` (conftest does this). **Never** run `docker compose down -v` against the bare `docker-compose.yml` project — it shares the dev stack's volume and silently wipes the local dev database.
- Tests never send real email (a fake Resend runs on `127.0.0.1:8025`).
- Test creds come from `tests/test.env` (`ADMIN_PIN=314159`).

## Regenerating fixtures (only if generators changed)
```bash
python3 tests/generate_test_entries.py --out tests/fixtures/test_entries.lxf
python3 tests/generate_test_results.py --meet tests/fixtures/meet_template.lxf \
    --entries tests/fixtures/test_entries.lxf --out tests/fixtures/test_results.lxf
```
