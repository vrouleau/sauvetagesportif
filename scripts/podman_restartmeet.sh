#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "=== 1. Pulling latest images from GHCR ==="
podman pull ghcr.io/vrouleau/sauvetagesportif/team-backend:latest
podman pull ghcr.io/vrouleau/sauvetagesportif/team-frontend:latest

echo "=== 2. Shutting down old containers and cleaning up ==="
podman stop ubuntu_backend_1 ubuntu_frontend_1 2>/dev/null || true
podman rm ubuntu_backend_1 ubuntu_frontend_1 2>/dev/null || true

if podman pod exists sauvetage-pod; then
    echo "Removing existing sauvetage-pod..."
    podman pod rm -f sauvetage-pod
fi

echo "=== 3. Loading environment variables ==="
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
    echo "Loaded environment variables from .env file."
else
    echo "WARNING: No .env file found!"
fi

echo "=== 4. Creating a unified Pod ==="
# Map host port 80 directly to container port 80 inside the pod.
# Also inject the host alias mapping so Nginx resolves 'backend' locally instantly.
podman pod create --name sauvetage-pod -p 80:80 --add-host backend:127.0.0.1

echo "=== 5. Starting Backend Container inside Pod ==="
podman run -d --pod sauvetage-pod \
  --name ubuntu_backend_1 \
  -e ADMIN_PIN="${ADMIN_PIN}" \
  -e RESEND_API_KEY="${RESEND_API_KEY:-}" \
  -e RESEND_FROM_EMAIL="${RESEND_FROM_EMAIL:-noreply@example.com}" \
  -e APP_BASE_URL="${APP_BASE_URL:-http://localhost}" \
  -e SECRET_KEY="${SECRET_KEY}" \
  -e STRIPE_API_KEY="${STRIPE_API_KEY:-}" \
  -e SUPPORT_EMAIL="${SUPPORT_EMAIL:-}" \
  -e TURNSTILE_SECRET_KEY="${TURNSTILE_SECRET_KEY:-}" \
  -v appdata:/app/data:Z \
  --restart unless-stopped \
  ghcr.io/vrouleau/sauvetagesportif/team-backend:latest

echo "=== 6. Waiting for Backend to initialize network space ==="
sleep 4

echo "=== 7. Starting Frontend Container inside Pod ==="
podman run -d --pod sauvetage-pod \
  --name ubuntu_frontend_1 \
  -e TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY:-}" \
  -e SUPPORT_EMAIL="${SUPPORT_EMAIL:-}" \
  --restart unless-stopped \
  ghcr.io/vrouleau/sauvetagesportif/team-frontend:latest

echo "=== 8. Cleaning up dangling image layers (RAM/Disk optimization) ==="
podman image prune -f

echo "=== 9. Verifying Deployment Status ==="
sleep 2
podman ps --pod

echo "===================================================="
echo " Update & Reset Complete! App listening on port 80 "
echo "===================================================="