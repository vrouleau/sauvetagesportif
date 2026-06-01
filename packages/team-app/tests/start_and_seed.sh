#!/bin/bash
set -e

REPO="/mnt/c/Users/vince/Documents/MeetManager/sauvetagesportif"
BASE="http://localhost:8000"
ADMIN_PIN="314159"

echo "=== Stopping any existing stack ==="
cd "$REPO/packages/team-app"
docker compose -f docker-compose.yml -f docker-compose.test.yml --env-file tests/test.env down -v 2>&1 || true

echo ""
echo "=== Starting stack ==="
docker compose -f docker-compose.yml -f docker-compose.test.yml --env-file tests/test.env up -d --build 2>&1

echo ""
echo "=== Waiting for backend ==="
for i in $(seq 1 30); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/status" 2>/dev/null || echo "0")
  if [ "$STATUS" = "200" ]; then
    echo "Backend ready after ${i}s"
    break
  fi
  echo "  ...waiting ($i/30)"
  sleep 2
done

echo ""
echo "=== Create club ==="
CLUB_RESP=$(curl -s -X POST "$BASE/api/clubs" \
  -H "X-Club-Pin: $ADMIN_PIN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Club Aquatique Test","shortname":"CAT","code":"CAT"}')
echo "$CLUB_RESP"

echo ""
echo "=== Club PIN ==="
CLUB_PIN=$(curl -s "$BASE/api/clubs" -H "X-Club-Pin: $ADMIN_PIN" | python3 -c "
import sys, json
clubs = json.load(sys.stdin)
if clubs:
    print(clubs[0]['pin'])
else:
    print('NO_CLUBS')
")
echo "Club PIN: $CLUB_PIN"

echo ""
echo "=== Enable live mode ==="
RESP=$(curl -s -X POST "$BASE/api/live/enable" -H "X-Club-Pin: $ADMIN_PIN")
echo "$RESP"
SECRET=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['secret'])")
echo "SECRET: $SECRET"

echo ""
echo "=== Push events ==="
curl -s -X POST "$BASE/api/live/push-events" \
  -H "X-Live-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {"event_id":1001,"session_number":1,"session_name":"Session 1","event_number":1,"event_name":"50m Libre","gender":"F","distance":50,"round":"TIM","total_heats":3},
      {"event_id":1002,"session_number":1,"session_name":"Session 1","event_number":2,"event_name":"100m Dos","gender":"M","distance":100,"round":"TIM","total_heats":2},
      {"event_id":1003,"session_number":1,"session_name":"Session 1","event_number":3,"event_name":"200m Papillon","gender":"F","distance":200,"round":"FIN","total_heats":1}
    ]
  }'

echo ""
echo "========================================"
echo "STACK IS RUNNING. Press Ctrl+C to stop."
echo ""
echo "Club PIN:    $CLUB_PIN"
echo "Live SECRET: $SECRET"
echo ""
echo "Phone URL:   http://192.168.1.254:8001/results"
echo "========================================"

# Keep this session alive so containers stay up
tail -f /dev/null
