#!/bin/bash
BASE="http://localhost:8000"
ADMIN_PIN="314159"

echo "=== Check backend ==="
curl -sv http://localhost:8000/api/status 2>&1
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
for c in clubs:
    print(c['pin'])
" | head -1)
echo "Club PIN: $CLUB_PIN"

echo ""
echo "=== Enable live mode ==="
RESP=$(curl -s -X POST "$BASE/api/live/enable" -H "X-Club-Pin: $ADMIN_PIN")
echo "$RESP"
SECRET=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['secret'])")
echo ">> SECRET: $SECRET"

echo ""
echo "=== Push events ==="
curl -s -X POST "$BASE/api/live/push-events" \
  -H "X-Live-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"events":[
    {"event_id":1001,"session_number":1,"session_name":"Session 1","event_number":1,"event_name":"50m Libre","gender":"F","distance":50,"round":"TIM","total_heats":3},
    {"event_id":1002,"session_number":1,"session_name":"Session 1","event_number":2,"event_name":"100m Dos","gender":"M","distance":100,"round":"TIM","total_heats":2},
    {"event_id":1003,"session_number":1,"session_name":"Session 1","event_number":3,"event_name":"200m Papillon","gender":"F","distance":200,"round":"FIN","total_heats":1}
  ]}'

echo ""
echo "========================================"
echo "DONE."
echo "Club PIN:    $CLUB_PIN"
echo "Live SECRET: $SECRET"
echo "Results URL: http://192.168.1.254:8001/results  (phone)"
echo "========================================"
