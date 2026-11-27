---
name: lxf-normalize
description: Offline cleanup of historic .lxf files (normalize_lxf.py: swimstyle remap, fuzzy club/athlete matching) and HANDICAP/Para exception codes in LXF (members.handicapex). Use when importing old-season LXF files or touching HANDICAP handling in seed.py / lxf_to_team.py.
---

## LXF Normalization (offline tool)

Historic .lxf files from previous seasons often have stale swimstyle IDs, accent issues, or missing HANDICAP exception codes. Fix them offline with `scripts/normalize_lxf.py` before importing:

```bash
python scripts/normalize_lxf.py TEMPLATE.lxf ENTRIES.lxf HISTORIC.lxf
```

- Remaps swimstyle IDs to the current template's canonical IDs (matched by name, not ID)
- Fuzzy-matches clubs (code → name → difflib 0.80) and athletes (license → exact → difflib 0.85)
- Copies `<HANDICAP exception="X" />` child elements to athletes missing them
- Logs all changes verbosely; `⚠ verify` suffix on fuzzy matches for manual review

## HANDICAP / Para exception codes

Athletes with a Para/disability classification carry `<HANDICAP exception="X" />` as a child element of `<ATHLETE>` in LXF (not a direct attribute).

Both LXF importers read this element and set `members.handicapex`:
- `seed.py` — Upload Lenex (Admin page)
- `lxf_to_team.py` — results importer behind Import results .lxf (Invitation page) and Import historical .lxf (Admin page)

Existing members missing `handicapex` are backfilled on re-import; existing non-null values are never overwritten.
