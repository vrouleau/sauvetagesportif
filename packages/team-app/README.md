# @meetmgr/team-app — SauvetageTeam

Web app for team registration, athlete entries, best times, and invoices.

## Stack
- **Backend**: FastAPI (Python 3.12) + PostgreSQL
- **Frontend**: React 18 + Tailwind (via @meetmgr/shared-ui)
- **Deployment**: Docker (ghcr.io images)

## Docker Images

Published to GitHub Container Registry on each release:

```
ghcr.io/vrouleau/sauvetagesportif/team-backend:<version>
ghcr.io/vrouleau/sauvetagesportif/team-frontend:<version>
```

Tags: `latest` + version (e.g. `0.2.0`)

## Production Deployment

### 1. Prerequisites
- Docker + Docker Compose installed
- A server with ports 8001 (or reverse proxy)

### 2. Setup

```bash
# Clone or copy the deployment files
mkdir sauvetageteam && cd sauvetageteam

# Get the production compose file
curl -O https://raw.githubusercontent.com/vrouleau/sauvetagesportif/main/packages/team-app/docker-compose.prod.yml

# Create environment file
curl -O https://raw.githubusercontent.com/vrouleau/sauvetagesportif/main/packages/team-app/.env_template
cp .env_template .env
```

### 3. Configure `.env`

Edit `.env` with your values:

```env
# Required
ADMIN_PIN=your-secure-pin
SECRET_KEY=random-32-char-string

# Public URL (for email links)
APP_BASE_URL=https://your-domain.com

# Email delivery (Resend.com)
RESEND_API_KEY=re_xxxxx
RESEND_FROM_EMAIL=inscriptions@your-domain.com

# Stripe invoicing (optional)
STRIPE_API_KEY=sk_live_xxxxx

# Cloudflare Turnstile CAPTCHA (optional, for self-invite page)
TURNSTILE_SITE_KEY=0x4AAA...
TURNSTILE_SECRET_KEY=0x4AAA...
```

### 4. Add meet template

The meet template `.lxf` file is included in the shared `config/` directory and mounted
automatically by docker-compose. No manual copy needed.

### 5. Start

```bash
docker compose -f docker-compose.prod.yml up -d
```

The app is available at `http://localhost:8001` (or behind your reverse proxy).

### 6. Update to a new version

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

### 7. Pin a specific version

Edit `docker-compose.prod.yml` and replace `:latest` with a version tag:

```yaml
backend:
  image: ghcr.io/vrouleau/sauvetagesportif/team-backend:0.2.0
frontend:
  image: ghcr.io/vrouleau/sauvetagesportif/team-frontend:0.2.0
```

## Local Development

```bash
cd packages/team-app
cp .env_template .env
docker compose up -d        # http://localhost:8001, admin PIN: 314159
```

## Tests

```bash
# Integration tests (requires running Docker stack)
cd packages/team-app
pip install pytest requests
MEETMGR_SKIP_STACK=1 MEETMGR_URL=http://127.0.0.1:8001 python -m pytest tests/ -v

# Or let pytest manage the stack:
python -m pytest tests/ -v
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_PIN` | Yes | PIN for admin login |
| `SECRET_KEY` | Yes | Encryption key for one-time links |
| `APP_BASE_URL` | Yes | Public URL (used in emails) |
| `RESEND_API_KEY` | No | Resend.com API key for email delivery |
| `RESEND_FROM_EMAIL` | No | Sender email address |
| `STRIPE_API_KEY` | No | Stripe secret key for invoicing |
| `BEST_TIME_MAX_AGE_MONTHS` | No | Expiry window for best times (default: 18) |
| `SUPPORT_EMAIL` | No | Shown in footer and emails |
| `TURNSTILE_SITE_KEY` | No | Cloudflare Turnstile public key |
| `TURNSTILE_SECRET_KEY` | No | Cloudflare Turnstile secret key |
