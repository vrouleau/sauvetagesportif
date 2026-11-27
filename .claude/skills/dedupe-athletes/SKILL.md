---
name: dedupe-athletes
description: Audit a team-app database for duplicate members and prepare (never silently apply) a merge. Runs the read-only audit, shows the plan CSV, then a dry-run merge; writes a merged copy only on explicit approval. Use when asked to find, audit or merge duplicate athletes/members.
disable-model-invocation: true
argument-hint: "<path/to/team.db> [plan.csv]"
---

# Deduplicate team-app athletes

Arguments: `$ARGUMENTS` — a team-app SQLite DB (a backup/export, **never** the live dev volume) and optionally an existing plan CSV. If no DB path is given, ask for one.

Scripts (repo `scripts/`): `audit_duplicate_athletes.py`, `merge_duplicate_athletes.py`. Both open the input DB **read-only**.

## Steps
1. **Audit** (read-only):
   `python scripts/audit_duplicate_athletes.py DB.db --csv plan.csv`
   Finds same name + birthdate, same license, similar names, and blank names, plus what references each copy. Put `plan.csv` in the scratchpad (or where the user says), not the repo.
2. **Show the user** a summary: group counts by kind, a few representative groups, and what each copy is referenced by (results, meet links, relay slots, registrations, best times). Flag risky groups: similar-name-only matches (could be different people), differing birthdates, or copies with results on both sides.
3. **Review the plan**: the CSV's `suggest_keep` column marks the keeper per group. Let the user edit it, or propose edits yourself for them to approve — don't change decisions silently. Blank-name rows are only removed with `--delete-blank`, and only if the user wants that.
4. **Dry run** (default, writes nothing):
   `python scripts/merge_duplicate_athletes.py DB.db plan.csv [--delete-blank]`
   Report what would move (results, meet links, relay slots, registrations, best times → keeper) and what would be deleted.
5. **Write only on explicit approval**: add `--out merged.db`. This writes a **merged copy**; the original is untouched. The user restores it via Admin (team-app) themselves. Never overwrite the source DB, never run against the live stack's database directly.

## Notes
- Merge keeps one member per group and re-points all references; copies are then deleted.
- After the user restores, suggest re-running the audit on the merged DB to confirm zero remaining groups.
