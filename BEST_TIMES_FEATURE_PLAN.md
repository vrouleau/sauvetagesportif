# Athlete Best Times Feature - Handoff Plan

## Status

- Branch: `feature/athlete-course-best-times`
- Backend implemented (uncommitted); integration tests not yet run.
- This file is the portable handoff for continuing the work in Claude.

## Goal

Persist a coach-entered best time for each athlete, swim style, and course:

- Long course (LCM, typically a 50 m pool)
- Short course (SCM, typically a 25 m pool)
- Store the time and the date it was entered.

Show those best times in both the coach registration entry window and the
Consult Best Times page.

## Agreed behavior

- A non-expired coach-entered best time is authoritative over historical results.
- Expiry is controlled by `BEST_TIME_MAX_AGE_MONTHS` (default currently 18).
- If the coach-entered value is missing or expired, use the fastest eligible
  historical result within the configured expiry window.
- If no eligible historical result exists, show no best time.
- Registration and Consult Best Times must use the same resolution rules.

## Current implementation findings

- Historical results are stored in `Result` with athlete, style, course,
  `totaltime`, `eventdate`, `entrytime`, and `entrytimecourse`:
  `packages/team-app/backend/app/models_team.py`
- There is no dedicated durable record for a coach-maintained BT and its entry
  date. Current-meet `SwimResult` has entry/qualifying-time fields, but those
  registrations are deleted when the meet is reset:
  `packages/team-app/backend/app/models.py`
  `packages/team-app/backend/app/routers/api.py`
- Registration currently calculates best times from historical results:
  `packages/team-app/backend/app/best_times.py`
  `packages/team-app/backend/app/routers/api.py`
  `packages/shared-ui/src/components/RegistrationPanel.tsx`
- The Consult Best Times page calls `GET /api/results/best-times`, which also
  currently reads historical results:
  `packages/team-app/backend/app/routers/results.py`
  `packages/team-app/frontend/src/pages/ResultsPage.jsx`
- Results import reads the LXF, archives the results, then resets current-meet
  registrations. The meet-app results exporter does not include entry time, so
  any registration-only BT must be captured from the Team DB before reset:
  `packages/team-app/backend/app/routers/api.py`
  `packages/team-app/backend/app/lxf_to_team.py`
  `packages/meet-app/src/main/lenex.ts`
- The existing historical query selects the minimum time and maximum event
  date per athlete/style/course, then checks the maximum date against expiry.
  A stale fastest time can therefore survive if a newer, slower result exists.
  Filter historical results by expiry before choosing the minimum:
  `packages/team-app/backend/app/best_times.py`

## Proposed implementation steps

1. Add durable storage keyed by athlete, swim style, and course, with time and
   entered date; add the appropriate migration and uniqueness constraints.
2. Implement one shared resolver:
   - Return the coach-entered value when it is within the configured expiry.
   - Otherwise select the fastest official, non-HC historical result within
     the expiry window for the same athlete/style/course.
   - Return no BT if neither source has a qualifying value.
3. Use that resolver for registration data and `GET /api/results/best-times`.
4. Preserve/capture the current coach BT during results import, before the
   current-meet registrations are reset.
5. Add focused tests for LCM/SCM separation, coach precedence, expiry,
   historical fallback, no eligible history, public-page parity, and result
   import/reset behavior.

## Decisions (confirmed 2026-11-16)

- A faster result from the newly imported meet replaces the stored coach
  value (time and date).
- The coach "enters" the best time through the registration entry time; no
  new UI. It is stored at meet close (results upload / close without
  results), not on each registration edit.

## Implementation (team-app backend)

- `athlete_best_times` table + migration m0006.
- `best_times.py`: shared resolver (also fixes the min/max expiry bug and
  reports the winning row's own date), `capture_coach_best_times`,
  `refresh_best_times_from_meet`.
- Hooks: `import-results-lxf` / `close-meet-without-results` (capture),
  `lxf_to_team.py` / `historical_import.py` (refresh).
- Tests: `tests/unit/test_athlete_best_times.py`.
