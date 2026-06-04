# Deployment Guide

## Current Production Setup

The team-app runs on Docker Compose with SQLite (default) or PostgreSQL (optional overlay).

### Local / Mini-PC

```bash
# SQLite (default — simplest):
docker compose up -d

# With PostgreSQL:
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
```

---

## Cloud Deployment — Oracle Cloud Free Tier

Oracle Cloud provides **2 free ARM VMs** (Ampere A1) with 4 CPUs, 24GB RAM, 200GB storage — forever free. You run the same `docker compose` setup as locally.

### One-Time Setup

#### 1. Create an Oracle Cloud account

- Sign up at https://cloud.oracle.com (requires credit card for identity, no charges on free tier)
- Select your home region (pick one close to Quebec: Toronto or Ashburn)

#### 2. Create a free-tier VM

- Go to: Compute → Instances → Create Instance
- Shape: **VM.Standard.A1.Flex** (Ampere ARM) — 1 OCPU, 6GB RAM is plenty
- Image: **Ubuntu 22.04** (or Oracle Linux 8)
- Networking: create a VCN with public subnet, assign a public IP
- SSH key: upload your public key

#### 3. Open firewall ports

In the Oracle Console → Networking → VCN → Security Lists → Default Security List:
- Add ingress rule: **port 80** (HTTP) from 0.0.0.0/0
- Add ingress rule: **port 443** (HTTPS) from 0.0.0.0/0

Also on the VM itself (Ubuntu):
```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

#### 4. Install Docker

```bash
# SSH into the VM
ssh ubuntu@<your-vm-public-ip>

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for group to take effect

# Install Docker Compose plugin
sudo apt-get install docker-compose-plugin
```

#### 5. Clone and deploy

```bash
git clone https://github.com/vrouleau/sauvetagesportif.git
cd sauvetagesportif/packages/team-app

# Create .env file with your secrets
cat > .env << 'EOF'
ADMIN_PIN=your-admin-pin
SECRET_KEY=your-random-secret-key-here
RESEND_API_KEY=your-resend-key
RESEND_FROM_EMAIL=noreply@yourdomain.com
APP_BASE_URL=https://yourdomain.com
STRIPE_API_KEY=
SUPPORT_EMAIL=your@email.com
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
EOF

# Start (SQLite mode — no Postgres needed)
docker compose -f docker-compose.prod.yml up -d
```

#### 6. Point your Cloudflare DNS

- In Cloudflare dashboard → DNS → add an A record:
  - Name: `team` (or whatever subdomain you want)
  - Content: your Oracle VM public IP
  - Proxy: ON (orange cloud) — gives you free HTTPS

#### 7. Enable Cloudflare SSL

- SSL/TLS → Overview → set to **Full (strict)** if you add a cert on the VM, or **Flexible** to let Cloudflare handle HTTPS

---

### Updating the App

```bash
ssh ubuntu@<your-vm-ip>
cd sauvetagesportif/packages/team-app
git pull
docker compose -f docker-compose.prod.yml up --build -d
```

### Backups

SQLite DB is a single file inside the Docker volume. To backup:

```bash
# Copy the DB out of the container
docker compose -f docker-compose.prod.yml exec backend cat /app/data/meetmgr.db > ~/backup-$(date +%Y%m%d).db
```

Or use the built-in auto-backup (creates daily `.db` copies inside the container volume).

### Monitoring

```bash
# Check logs
docker compose -f docker-compose.prod.yml logs -f backend

# Check status
curl http://localhost:8001/api/status
```

---

## Alternatives Considered

| Platform | Verdict |
|----------|---------|
| Fly.io | Works but requires new Dockerfile (supervisord), micro-VMs are small (256MB), Postgres provisioning was broken |
| Google Cloud Run | Doesn't support persistent volumes (no SQLite), needs Cloud SQL ($) |
| Railway.app | $5/month credit; easy but limited free tier |
| Render.com | Free Postgres expires after 90 days |
