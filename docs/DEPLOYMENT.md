# Deployment Guide

## Current Production Setup

The team-app currently runs on a local mini-PC with:
- Docker Compose (`docker-compose.prod.yml`)
- PostgreSQL 16 container
- Backend container (FastAPI/Python)
- Frontend container (Nginx serving static React build)
- Cloudflare DNS pointing to the mini-PC's public IP
- Env file with secrets (ADMIN_PIN, SECRET_KEY, RESEND_API_KEY, etc.)

### Known Issue

Frequent power outages at the hosting location make this setup unreliable.

---

## Cloud Deployment Options (Evaluated)

### Fly.io (Recommended — paused)

**Architecture:**
- Backend → Fly app (from existing Dockerfile)
- Frontend → Fly app (from existing frontend Dockerfile)
- Postgres → Fly Managed Postgres or external (Neon.tech)
- Persistent volume for `/app/data` (meet .lxf storage)
- Cloudflare DNS → Fly app hostname

**Status:** Paused. Fly's unmanaged Postgres provisioning was broken during evaluation (Consul URL generation error). Two sub-options remain:
1. Use Neon.tech for free managed Postgres externally
2. Migrate to SQLite (eliminates the DB service entirely) — see `docs/SQLITE_MIGRATION_PLAN.md`

**Free Tier Limits:**
- 3 shared-cpu-1x VMs (256MB RAM each)
- 3GB persistent storage
- 160GB outbound bandwidth/month

**Secrets to configure (via `fly secrets set`):**
- `ADMIN_PIN`
- `SECRET_KEY`
- `DATABASE_URL` (Postgres connection string or SQLite path)
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `APP_BASE_URL`
- `STRIPE_API_KEY`
- `SUPPORT_EMAIL`
- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`

### Other Options Considered

| Platform | Verdict |
|----------|---------|
| Google Cloud Run | Doesn't support docker-compose; needs Cloud SQL ($) |
| Oracle Cloud Free Tier | 2 free ARM VMs forever; run docker-compose as-is; good fallback |
| Railway.app | $5/month free credit; easy but limited |
| Render.com | Free Postgres expires after 90 days |

---

## Recommended Path Forward

**SQLite migration** → eliminates the Postgres dependency entirely:
- Single container deployment (backend only serves API + static frontend)
- Database is a file on a persistent volume
- Dramatically simpler (no DB service, no connection strings, no backups to configure)
- Same approach as the meet-app (Electron) already uses successfully

See `docs/SQLITE_MIGRATION_PLAN.md` for the migration plan.
