#!/bin/bash
cd /mnt/c/Users/vince/Documents/MeetManager/sauvetagesportif/packages/team-app

# Start containers (own project name — must never collide with the dev stack's
# "team-app" project, whose volume a `down -v` here would otherwise wipe)
docker compose -p team-app-test -f docker-compose.yml -f docker-compose.test.yml --env-file tests/test.env up -d

# Wait for backend
for i in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/status 2>/dev/null || echo 0)
  [ "$STATUS" = "200" ] && echo "backend ready" && break
  sleep 2
done

# Seed
bash tests/seed_live_test.sh 2>/dev/null

# Run LAN proxy: port 8002 -> 8001 (8001 is taken by rootlesskit)
python3 tests/lan_proxy.py 8001 8002 &

echo "PROXY_PID=$!"
echo "PROXY ready on port 8002"

# Keep WSL alive
sleep 7200