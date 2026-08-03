# Historical Meets — Remaining Work

Historical meet import/browse/delete is implemented: `POST /admin/import-historical`
(LXF), `POST /admin/import-meet-results` (SMB), `POST /admin/import-mdb` (Team.mdb),
`GET /admin/historical-meets`, `DELETE /admin/historical-meets/{id}` (all in
`backend/app/routers/api.py`), backed by `historical_import.py` / `lxf_to_team.py` /
`smb_to_team.py`. Best times are derived live from the `results` table
(`best_times.py`, no JSON-blob cache). Admin page has a full Historical Meets
section (import with dedup/force-reimport, delete, per-meet result counts).

## Still missing

**Athlete history UI.** `GET /athletes/{id}/history` exists in `api.py` and returns
full per-meet results + best times for an athlete, but nothing in the frontend
calls it — no history tab/panel on the athlete detail view, no best-time
progression display. Wiring up that endpoint into the UI is the only remaining
piece of this feature.

## Note found during audit (2026-08-03), unrelated to the above

`api.py` defines `GET /admin/historical-meets` and `DELETE /admin/historical-meets/{meet_id}`
**twice** (once near line 2884, again near line 3697) — worth checking whether the
second pair is dead code or shadows the first.
