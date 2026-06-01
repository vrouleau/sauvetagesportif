# End-to-End Test: Live Notifications (DSQ + Announcements)

## Prerequisites

- Docker running on the test machine
- HTTPS access to the team-app (e.g., `https://testmeet.vrouleau.app` via Pangolin tunnel to port 8001)
- A phone on the same network or with internet access to the HTTPS URL
- Push notifications **require HTTPS** (won't work over plain HTTP except localhost)

## 1. Start the Stack

```bash
cd packages/team-app
docker compose -f docker-compose.yml -f docker-compose.test.yml down -v
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build
```

Wait for backend to be healthy:
```bash
curl -s http://localhost:8000/api/status
# Should return: {"clubs":0,"athletes":0,...}
```

## 2. Seed Test Data

Run these commands from the machine running Docker (replace `BASE` with your URL):

```bash
BASE="http://localhost:8000"
# Or if testing via Pangolin: BASE="https://testmeet.vrouleau.app"
ADMIN_PIN="314159"
```

### 2a. Create a test club

```bash
curl -s -X POST "$BASE/api/clubs" \
  -H "X-Club-Pin: $ADMIN_PIN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Club Aquatique Test","shortname":"CAT","code":"CAT"}'
```

Note the `pin` in the response — this is what the coach enters on their phone.

### 2b. Get the club PIN

```bash
curl -s "$BASE/api/clubs" -H "X-Club-Pin: $ADMIN_PIN" | python3 -c "
import sys, json
clubs = json.load(sys.stdin)
for c in clubs:
    print(f\"Club: {c['name']}  PIN: {c['pin']}\")
"
```

### 2c. Enable live mode

```bash
RESP=$(curl -s -X POST "$BASE/api/live/enable" -H "X-Club-Pin: $ADMIN_PIN")
echo "$RESP"
SECRET=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['secret'])")
echo "Live secret: $SECRET"
```

### 2d. Push event metadata

```bash
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
```

## 3. Phone Setup

1. Open `https://testmeet.vrouleau.app/results` on your phone
2. You should see the **live view** with 3 events listed
3. Tap the 🔔 **"Alertes DSQ"** button (in the green header area)
4. Enter the **team PIN** from step 2b
5. Tap **"Activer"**
6. Browser will prompt **"Allow notifications?"** → tap **Allow**
7. You should see a green badge with your club name (e.g., "🔔 Club Aquatique Test ✕")

## 4. Test: Push a Normal Result

```bash
curl -s -X POST "$BASE/api/live/push-results" \
  -H "X-Live-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "results": [{
      "event_id": 1001, "heat_number": 1, "lane": 3,
      "athlete_id": 100, "athlete_name": "Tremblay, Marie",
      "club_name": "Club Aquatique Test",
      "swimtime_ms": 28450, "reaction_time_ms": 720,
      "status": "", "is_official": false
    }]
  }'
```

**Expected on phone:** If you have event 1 selected, you see the result appear in real-time. Progress bar updates to 1/3.

## 5. Test: Push a DSQ Result

```bash
curl -s -X POST "$BASE/api/live/push-results" \
  -H "X-Live-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "results": [{
      "event_id": 1001, "heat_number": 1, "lane": 5,
      "athlete_id": 101, "athlete_name": "Gagnon, Jean",
      "club_name": "Club Aquatique Test",
      "swimtime_ms": null, "reaction_time_ms": null,
      "status": "DSQ", "dsq_reason": "SW 6.4 — Faux départ",
      "is_official": false
    }]
  }'
```

**Expected on phone:**
- ✅ **In-page toast** (red banner, bottom-right): "⚠️ DSQ — Gagnon, Jean / SW 6.4 — Faux départ"
- ✅ **Alert sound** (two beeps)
- ✅ **Push notification** (system notification tray): "DSQ — Gagnon, Jean / SW 6.4 — Faux départ"
- ✅ DSQ shows in red in the results table with ⓘ tooltip

## 6. Test: Call to Marshall

```bash
curl -s -X POST "$BASE/api/live/push-announcement" \
  -H "X-Live-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "call_to_marshall",
    "event_id": 1002, "event_number": 2,
    "event_name": "100m Dos", "gender": "M"
  }'
```

**Expected on phone:**
- ✅ **Orange banner** at top of event list: "📢 Appel au maréchal — Épr. 2 — 100m Dos"
- ✅ **Push notification**: "📢 Appel au maréchal — Épr. 2 — 100m Dos ♂"
- Banner auto-dismisses after 30 seconds

## 7. Test: Call to Scratch

```bash
curl -s -X POST "$BASE/api/live/push-announcement" \
  -H "X-Live-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "call_to_scratch",
    "event_id": 1003, "event_number": 3,
    "event_name": "200m Papillon", "gender": "F"
  }'
```

**Expected on phone:**
- ✅ **Pink banner** at top of event list: "✂️ Appel aux scratches — Épr. 3 — 200m Papillon"
- ✅ **Push notification**: "✂️ Appel aux scratches — Épr. 3 — 200m Papillon (Finale) ♀"

## 8. Test: Persistence (Close and Reopen)

1. Close the browser tab on your phone
2. Wait 10 seconds
3. Push another DSQ:

```bash
curl -s -X POST "$BASE/api/live/push-results" \
  -H "X-Live-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "results": [{
      "event_id": 1002, "heat_number": 1, "lane": 2,
      "athlete_id": 102, "athlete_name": "Lavoie, Sophie",
      "club_name": "Club Aquatique Test",
      "swimtime_ms": null, "reaction_time_ms": null,
      "status": "DSQ", "dsq_reason": "SW 4.4 — Virage non conforme",
      "is_official": false
    }]
  }'
```

**Expected:** Push notification appears in your phone's notification tray (even with browser closed).

4. Tap the notification → should open/focus the results page
5. The PIN should still be remembered (green badge visible without re-entering)

## 9. Test: Unsubscribe

1. On the results page, tap the **✕** next to the club name in the green badge
2. Push another DSQ — you should NOT get a notification or toast

## 10. Cleanup

```bash
# Disable live mode
curl -s -X POST "$BASE/api/live/disable" -H "X-Club-Pin: $ADMIN_PIN"

# Or tear down the stack entirely
docker compose -f docker-compose.yml -f docker-compose.test.yml down -v
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| No "Alertes DSQ" button | Push not supported | Use Chrome/Safari 16.4+, needs HTTPS |
| "Notification permission denied" | User blocked notifications | Clear site settings, try again |
| Toast works but no push notification | HTTP instead of HTTPS | Must use HTTPS for Service Worker |
| 504 on Pangolin | Tunnel not reaching laptop | Check Newt agent, firewall rules |
| WebSocket disconnects | nginx not proxying upgrade | Verify nginx.conf has ws location block |
| PIN rejected | Wrong PIN or no clubs | Re-check with `GET /api/clubs` |

## Network Requirements

- **Phone → HTTPS URL**: Port 443 (handled by Pangolin/reverse proxy)
- **Pangolin → Laptop**: Port 8001 (nginx frontend, proxies everything)
- **nginx → backend**: Port 8000 (internal Docker network, no external access needed)
