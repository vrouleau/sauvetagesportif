# SMB import/export in team-app — deprecation investigation (2026-08-03)

## Question

Does team-app's `.smb` (Splash Meet Backup) support still have a real use case,
now that the whole meet-app ↔ team-app lifecycle (structure, entries, results)
round-trips through `.lxf`? Or is it dead weight?

## Scope

Three team-app features touch `.smb`, all built on `backend/app/smb.py`
(GBIN codec, ZIP read/write — the only three consumers of that module):

| Feature | Endpoint | Code |
|---|---|---|
| Full DB restore from `.smb` | `POST /api/upload/meet-smb` | `api.py` (inline, ~line 582) |
| Full DB export to `.smb` | `GET /api/export/meet-smb` | `generate_smb.py` |
| Import `.smb` as historical meet | `POST /api/admin/import-meet-results` | `smb_to_team.py` |

**Out of scope:** meet-app's own File → Save/Restore `.smb` (`packages/meet-app/src/main/smb.ts`).
That's meet-app's local backup format and its interop path with real Splash
Meet Manager 11 — unrelated to team-app and not part of this investigation.

## Findings

### 1. Every `.smb` feature has an LXF equivalent that's already the documented path

- `upload/meet-smb` (destructive full restore: wipes bsglobal, styles, clubs,
  members, sessions, events, agegroups, heats, results, relays — **and also
  wipes `TeamMeet`, i.e. all historical meets**) is functionally replaced by
  `POST /api/upload/meet` (structure) + `POST /api/upload/entries` (entries),
  neither of which touches historical data.
- `export/meet-smb` (dump current DB to `.smb`) is replaced by
  `GET /api/export/registrations-lxf` / `GET /api/export/entries`.
- `import-meet-results` (`smb_to_team.py`, .smb → historical meet) is replaced
  by `POST /api/import-results-lxf`. The `.smb` path is actually **missing
  functionality** the LXF path has: it doesn't call `_reset_for_next_meet`,
  doesn't regenerate PINs, doesn't clear `organizer_club_id`, and doesn't
  dedupe/replace an existing completed meet with the same name — see
  "Meet lifecycle" in `packages/team-app/CLAUDE.md`. Importing via `.smb`
  today silently skips all of that.

### 2. The one non-obvious original use case (Gemini key transport) is already covered by LXF too

`packages/meet-app/CLAUDE.md` documents "Keys travel to meet-app via TWO
paths: `.smb` backup ... or `.lxf` export (embedded `.keys` JSON dotfile,
transparent)." Confirmed both paths exist in code (`export.py:545-563` for
LXF, `generate_smb.py`'s `BSGLOBAL` passthrough for SMB). Since the LXF path
is already transparent and always exercised (every entries/results LXF
carries it), the `.smb` path contributes nothing that isn't already covered.

**Stale doc found along the way:** `team-admin_fr.md`/`team-admin_en.md` say
Gemini keys "travel with the `.smb` export to SauvetageMeet" as if that were
the mechanism — it's actually the LXF export that normally carries them now;
the `.smb` line is left over from before the LXF key-transport path existed.

### 3. Test suite already treats `.smb` as fragile/legacy

`tests/test_integration.py`'s `.smb` tests are explicitly ordered to run
**last** in their own classes because a full restore wipes the whole
database out from under every other test — they're isolated as a hazard,
not exercised as part of the normal flow.

## Conclusion

No functionality gap blocks deprecation. `.smb` upload/export in team-app is:
- fully superseded by LXF for structure, entries, and results,
- redundant (not required) for Gemini/live-push key transport,
- and in the "import as historical meet" case, actually a **regression**
  relative to the LXF path (skips meet-cycle reset/dedup logic).

**Origin, per author (2026-08-03):** `.smb` support was added early on to get
Splash's combined-points ("classement au points") config into team-app's DB,
before it was clear team-app's schema was its own thing and not a Splash
schema clone. The `export/meet-smb` "hand data to real Splash" angle was
never an actual use case either — the only club data that's meant to move
between systems is the event-relevant subset, and that's the job LXF
already does. So there's no remaining use case anywhere in this feature set,
confirmed by the person who added it — clear to remove.

## Status: done (2026-08-03)

Removed `smb.py`, `smb_to_team.py`, `generate_smb.py`; the three endpoints in
`api.py` (`upload/meet-smb`, `export/meet-smb`, `admin/import-meet-results`)
and their `meet.smb`-file storage/cleanup side effects; the Admin.jsx
upload/download/import UI and its i18n strings; `tests/unit/test_smb.py`,
`tests/unit/test_date_conversion.py` (tested the OLE-date helpers that lived
inline in the removed `upload_meet_smb` plus `smb.py`'s GBIN codec — nothing
left to test), and the destructive `.smb` test classes in
`test_integration.py` (plus the now-unused `tests/fixtures/meet.smb`); the
stale Gemini-key line in
`team-admin_{fr,en}.md`; and updated `packages/meet-app/CLAUDE.md`,
`packages/team-app/CLAUDE.md`, root `CLAUDE.md`, and
`docs/MEET_RESET_BEHAVIOR.md` to drop references to the removed feature.
meet-app's own File → Save/Restore `.smb` (Splash interop, unrelated) is
untouched.
