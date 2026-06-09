# Deployment Guide — Oracle Cloud Free Tier + Podman

## Architecture

```
[Users] → [Cloudflare CDN/HTTPS] → [Oracle VM :80] → [Podman Pod]
                                                        ├── frontend (nginx :80)
                                                        └── backend (uvicorn :8000)
```

- **Oracle Cloud Free Tier**: VM.Standard.E2.1.Micro (1 OCPU, 1GB RAM) — forever free
- **Podman** (rootless): replaces Docker on the VM, lighter footprint
- **SQLite**: single-file database, no external DB needed
- **Cloudflare**: free HTTPS, DNS proxy, DDoS protection
- **systemd user service**: auto-start on boot via `loginctl enable-linger`

---

## One-Time Setup

### 1. Create Oracle Cloud Account

Sign up at https://cloud.oracle.com (credit card for identity, no charges on free tier).
Select home region close to users (Toronto or Ashburn for Quebec).

### 2. Create a Free-Tier VM

- Compute → Instances → Create Instance
- Shape: **VM.Standard.E2.1.Micro** (AMD, 1 OCPU, 1GB RAM — Always Free)
- Image: **Ubuntu 22.04** (Canonical)
- Networking: create VCN with public subnet, assign public IPv4
- SSH key: upload your public key

### 3. Oracle VCN Security Rules

In Oracle Console → Networking → VCN → Subnet → Security List:

**Ingress rules:**
| Source | Protocol | Dest Port | Description |
|--------|----------|-----------|-------------|
| 0.0.0.0/0 | TCP | 80 | HTTP |
| 0.0.0.0/0 | TCP | 443 | HTTPS |

**Egress rules** (needed for Resend API, Docker pulls, etc.):
| Destination | Protocol | Dest Port | Description |
|-------------|----------|-----------|-------------|
| 0.0.0.0/0 | TCP | 443 | HTTPS outbound |
| 0.0.0.0/0 | TCP | 80 | HTTP outbound |

### 4. VM Firewall (iptables)

Oracle's Ubuntu image has iptables rules that block traffic even if VCN allows it:

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### 5. Install Podman

```bash
sudo apt-get update
sudo apt-get install -y podman
```

### 6. Enable Lingering (auto-start without login)

```bash
loginctl enable-linger ubuntu
```

This allows user-level systemd services to run even when not logged in.

### 7. Authenticate to GHCR (GitHub Container Registry)

```bash
echo "YOUR_GITHUB_PAT" | podman login ghcr.io -u vrouleau --password-stdin
```

---

## Deployment

### Environment File

Create `~/.env` (or wherever you run the restart script from):

```bash
cat > ~/.env << 'EOF'
ADMIN_PIN=your-admin-pin
SECRET_KEY=your-random-secret-key-here
RESEND_API_KEY=re_xxxxxxxxxxxx
RESEND_FROM_EMAIL=noreply@yourdomain.com
APP_BASE_URL=https://yourdomain.com
STRIPE_API_KEY=
SUPPORT_EMAIL=your@email.com
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
EOF
```

### Deploy / Update

```bash
cd ~
bash podman_restartmeet.sh
```

The script (`scripts/podman_restartmeet.sh`):
1. Pulls latest images from `ghcr.io/vrouleau/sauvetagesportif/team-backend:latest` and `team-frontend:latest`
2. Stops and removes old containers + pod
3. Loads `.env` from current directory
4. Creates a pod (`sauvetage-pod`) on port 80 with `--add-host backend:127.0.0.1`
5. Starts backend container (env vars passed via `-e` flags)
6. Starts frontend container (nginx proxies `/api` to `backend:8000`)
7. Prunes old images

### Register as systemd Service (auto-start on boot)

After a successful deployment:

```bash
# Generate service files from the running pod
mkdir -p ~/.config/systemd/user/
cd ~/.config/systemd/user/
podman generate systemd --new --files --name sauvetage-pod

# Enable
systemctl --user daemon-reload
systemctl --user enable pod-sauvetage-pod.service

# Verify
systemctl --user status pod-sauvetage-pod.service
```

### ⚠️ Updating env vars

`podman generate systemd --new` **bakes env vars into the service file**. When you change `.env`, you must:

```bash
# 1. Stop the systemd service
systemctl --user stop pod-sauvetage-pod.service

# 2. Re-deploy with updated .env
cd ~ && bash podman_restartmeet.sh

# 3. Verify new env is active
podman exec ubuntu_backend_1 env | grep RESEND

# 4. Re-generate systemd files (bakes new env vars)
cd ~/.config/systemd/user/
podman generate systemd --new --files --name sauvetage-pod

# 5. Reload
systemctl --user daemon-reload
systemctl --user enable pod-sauvetage-pod.service
```

---

## Cloudflare DNS + HTTPS

### DNS Setup

In Cloudflare → your domain → DNS:
- **A record**: `team` (or `@`) → Oracle VM public IP, Proxy ON (orange cloud)

### SSL/TLS

- Cloudflare SSL/TLS → Overview → **Flexible**
  - Cloudflare handles HTTPS to users
  - Connection to Oracle VM is HTTP (port 80)
  - No cert needed on the VM

### Resend Email (sender domain)

For `RESEND_FROM_EMAIL` to work:
1. Resend dashboard → Domains → Add your domain
2. Add the DNS records (SPF + DKIM TXT records) in Cloudflare
3. Wait for verification (usually instant with Cloudflare)

---

## Operations

### Check status

```bash
podman ps --pod
podman exec ubuntu_backend_1 python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/api/status').read().decode())"
```

### View logs

```bash
podman logs ubuntu_backend_1 --tail 50
podman logs ubuntu_frontend_1 --tail 20
```

### Backup

SQLite DB lives in a Podman volume (`appdata`). Auto-backup creates daily copies inside the volume.

Manual backup:
```bash
podman exec ubuntu_backend_1 cat /app/data/meetmgr.db > ~/backup-$(date +%Y%m%d).db
```

### Restart

```bash
systemctl --user restart pod-sauvetage-pod.service
```

### Full redeploy (new version)

```bash
systemctl --user stop pod-sauvetage-pod.service
cd ~ && bash podman_restartmeet.sh
cd ~/.config/systemd/user/ && podman generate systemd --new --files --name sauvetage-pod
systemctl --user daemon-reload
```

---

## Alternatives Considered

| Platform | Verdict |
|----------|---------|
| Fly.io | Micro-VMs too small (256MB), Postgres provisioning broken, needs custom Dockerfile |
| Google Cloud Run | No persistent volumes (no SQLite), needs Cloud SQL ($) |
| Railway.app | $5/month credit; easy but limited free tier |
| Render.com | Free Postgres expires after 90 days |
| Docker on Oracle | Works but rootless Podman is lighter, no daemon, better systemd integration |
