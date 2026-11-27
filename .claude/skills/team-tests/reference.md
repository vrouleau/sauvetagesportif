# team-app integration tests — reference

## Integration tests (WSL)

All test commands run from a **WSL terminal**. The test suite is in `tests/`.

### How it works

- `conftest.py` manages the Docker stack automatically via `docker compose -p team-app-test -f docker-compose.yml -f docker-compose.test.yml --env-file tests/test.env`
- `-p team-app-test` gives the test stack its own project name — **without it, `down -v` targets the same named volume as the plain dev stack (`docker compose up -d` with no `-p`, project name defaults to the directory name) and silently wipes your local dev database.** This has happened before; always pass `-p team-app-test` (or an equivalent unique name) for any test/e2e compose invocation, never reuse the bare `docker-compose.yml` project.
- `docker-compose.test.yml` adds a port mapping: backend exposed on `http://127.0.0.1:8000`
- It also replaces Resend with a **fake** (`tests/fake_resend/server.py`, service `fake-resend` on `127.0.0.1:8025`): the backend's `RESEND_API_URL` points at it, it records every email payload and can be told to fail (`POST /control {"fail": true}`). Tests use the `fake_resend` fixture (conftest) to read the outbox. **Tests never send real email.** The stack also sets `RESEND_FROM_EMAIL=no-reply@test.local` and `SUPPORT_EMAIL=support@test.local`.
- `tests/test.env` provides test-only credentials (`ADMIN_PIN=314159`, `SECRET_KEY=test-only-key-not-for-production`)
- By default the session fixture runs `down -v && up --build -d` (wipes the test DB, rebuilds images) then tears down after — this is safe because it's scoped to the `team-app-test` project, not the dev stack.

### Standard run (let pytest manage the stack)

```bash
# In WSL terminal
cd /mnt/c/Users/eoivnru/Documents/MeetManager/sauvetagesportif/packages/team-app
pip install -r tests/requirements-test.txt   # first time: pytest + requests
python3 -m pytest tests/ -v
```

pytest wipes+rebuilds the stack, waits for backend health, runs all tests, then tears down.

### Run against a stack you already have up

```bash
MEETMGR_SKIP_STACK=1 python3 -m pytest tests/ -v
```

Backend URL defaults to `http://127.0.0.1:8000` — no override needed when using the test compose file.

### Keep the stack running after tests

```bash
MEETMGR_KEEP_STACK=1 python3 -m pytest tests/ -v
```

### Unit tests (no Docker needed)

```bash
python3 -m pytest tests/unit/ -v
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MEETMGR_URL` | `http://127.0.0.1:8000` | Backend base URL |
| `MEETMGR_SKIP_STACK` | unset | `1` = skip docker stack management |
| `MEETMGR_KEEP_STACK` | unset | `1` = skip teardown after suite |
| `ADMIN_PIN` | `314159` | Admin PIN (sourced from `tests/test.env`) |

### Regenerating test fixtures

Only needed if you change the generators:

```bash
python3 tests/generate_test_entries.py --out tests/fixtures/test_entries.lxf
python3 tests/generate_test_results.py \
    --meet tests/fixtures/meet_template.lxf \
    --entries tests/fixtures/test_entries.lxf \
    --out tests/fixtures/test_results.lxf
```
