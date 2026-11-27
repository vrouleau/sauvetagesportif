---
name: best-times
description: team-app best times — resolver in best_times.py, coach best times vs archived results, 18-month expiry, relay best times, course-free throws, beach exclusion, entry-time help bubble. Use when touching best_times.py, registration entry times, capture/refresh at meet close, or relay entry time suggestions.
---

## Best times storage

One resolver in `best_times.py` (`get_best_times_for_member` / `get_public_best_times`) feeds registration, the public Best Times page and the LXF exports. Per (athlete, style, course), anything older than `BEST_TIME_MAX_AGE_MONTHS` (default 18) is ignored:
1. **Coach best time** (`athlete_best_times`, migration m0006) — authoritative while valid, even if a faster historical result exists.
2. Otherwise the **fastest official, non-HC result** from `results`, with that result's own date — or its meet's `mindate` when the result has none (most historical rows). Rows with neither date never expire.

Coach best times are written only at meet close, never on registration:
- `capture_coach_best_times` — `import-results-lxf` (before the import) and `close-meet-without-results` store each individual registration's entry time for the meet's course, dated to the meet start (`mindate`, else first session date). Entry times equal to the current best time (the pre-filled default) are skipped so a historical value isn't re-dated — and so are entry times equal to one of the athlete's *expired* times for that style/course (`_expired_times`): a best time pre-filled at registration that aged out before the meet was closed, which would otherwise be re-dated to this meet and kept for another 18 months. Relays and beach meets skipped.
- `refresh_best_times_from_meet` — end of every results import (`lxf_to_team.archive_results_lxf`, both entry points): a faster result replaces the stored time/date, unless the meet is older than the stored value.

**Entry-time help bubble:** `GET /api/athletes/{id}/registration` returns each style's `best_time_{lcm,scm}_date`/`_source` and a top-level `best_time_policy` (`max_age_months`, `typed_time_date` = `coach_best_time_date()`, the date capture would stamp). The shared `RegistrationPanel` shows a "?" next to each individual entry time (only when `best_time_policy` is present — meet-app has no best times): the BT's origin, date and expiry, and that a typed time becomes the new BT at meet close.

**Team events never have individual best times:** styles with `relaycount > 1` (relays, SERC, Lancer de la corde 10/12.5 m 523/524 — a pair, entered in the relay tab) are excluded from the resolver, even if a file recorded them per athlete.

**Relay best times (separate, only to suggest relay entry times):** `get_relay_best_times(db, member_ids, style, course)` — every member of an archived relay team (`relays.totaltime` + `relayspos`, written by both results imports via `relay_archive.py`) is credited with the team's total; a member's relay best time is the fastest one. Same rules as individual: pool only, official, `relays.resultstatus` NULL/0 (HC/DSQ/DNS/DNF excluded), 18-month expiry (team's `eventdate`, else meet `mindate`), SERC excluded, deck throws (distance < 25 m) course-free. Live registrations (no `totaltime`) never count. `GET /api/relay-teams` returns it per member (`relayBestTimeMs`); the shared relay page suggests the team entry time as the average of the members who have one.

**Throws are course-free:** individual pool styles with `0 < distance < 25` (`COURSE_FREE_MAX_DISTANCE`) — Lancer de précision 4/7 m (521/522) — don't depend on the pool's length: one best time across 50 m and 25 m (latest coach value, else fastest result), kept under the course it was actually done in (`pick_course()` reads it for any course). Registration and the public page get a `course_free` flag and show a single box. This relies on `swimstyle.distance`: meet uploads (`events.py`) now correct distance and upgrade relaycount of existing styles from the meet file (historical imports used to create them with no distance and relaycount=1); migration `m0007` applied the bundled pool/beach templates once to existing catalogs (an open meet can't be re-uploaded without losing its registrations).

**Beach meets never count** (results are finishing positions stored as ms, not times): the resolver, refresh, capture and the athlete-history best times all exclude styles `>= BEACH_STYLE_MIN` (600). Pool styles use 5xx IDs, beach styles use 6xx — no collisions. Beach results are no longer archived at all (both results importers refuse them — see "Beach meets are never archived"); the exclusions above still guard beach rows archived before that.
