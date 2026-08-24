# Exporting team-app data to Hy-Tek Meet Manager

Research notes on getting SauvetageTeam registration data (clubs, athletes, entries)
into **Hy-Tek Meet Manager**, the dominant North American swim-meet software, for
organizers who run their competition in Meet Manager instead of (or alongside)
SauvetageMeet. This is an investigation/documentation pass — **no export code has
been written yet**. See "Recommended path forward" at the end for the proposed
implementation.

## Why this matters

team-app already does the meet-app round trip via LENEX (`.lxf`, see
`docs/LENEX_EXPORT_MATRIX.md`). Some Quebec/Canadian lifesaving clubs and some
combined swim/lifesaving meets are run by officials who only have Hy-Tek Meet
Manager, not SauvetageMeet. The ask is a second export path, analogous to
`GET /api/export/entries`, that produces a file Meet Manager can import directly —
without requiring meet-app in the loop at all.

## Format landscape

Hy-Tek's ecosystem has three file formats that get casually lumped together. They
are **not interchangeable**:

| Format | Extension | Status | Notes |
|---|---|---|---|
| **SDIF v3 / SD3** | `.sd3` | Open, fully documented, USA Swimming-owned standard | No checksum (removed in v3). Fixed-width text records. This is the format meant for **third-party software** to exchange data with Hy-Tek products. |
| **CL2** | `.cl2` | Hy-Tek proprietary, "not exactly" SDIF | Historically the Team Manager ↔ Meet Manager roster/entry transfer format. Field layout is not officially published; only reverse-engineered fragments exist in the community. Primarily meant for Hy-Tek-to-Hy-Tek transfer (Team Manager → Meet Manager), not third-party generation. |
| **HY3** | `.hy3` | Hy-Tek proprietary | Meet **results** format (also used for roster export from Team Manager). Contains a checksum field whose algorithm Hy-Tek has never disclosed publicly — this makes programmatic *generation* of valid `.hy3` files from scratch unreliable. Reading/parsing existing `.hy3` files is fine; writing new ones is the risky part. |

**Recommendation: target SD3 (SDIF v3), not CL2 or HY3.**

- It's the only one of the three with a public, complete, checksum-free spec.
- Hy-Tek explicitly documents third-party SD3 import: **Meet Manager → File →
  Import → Entries → select the `.sd3` file**. The article "Import SD3 File for
  Meet Entry" on Hy-Tek's own support site frames this exact workflow as the
  supported path for non-Hy-Tek software.
- CL2 would require reverse-engineering an undocumented layout for a format
  that's arguably the wrong one anyway (built for Hy-Tek-to-Hy-Tek transfer).
- HY3's undisclosed checksum makes it a dead end for a from-scratch writer.

**Caveats to flag to the user before committing to this:**

1. Importing `.sd3` in Meet Manager reportedly requires the **latest service pack
   and an active internet connection** (an activation/licensing check on Hy-Tek's
   end, not a technical file constraint) — worth confirming with an organizer who
   has Meet Manager installed before relying on this path.
2. Community reports (SDIF forum) describe Meet Manager sometimes **rejecting
   generated SD3 files as "NOT entry files"** when the record set/ordering isn't
   exactly what it expects. The spec looks simple but Meet Manager's parser is
   reportedly strict about record order and required fields. This means the
   export needs to be validated against a real Meet Manager install (or at least
   a trusted third-party SD3 sample) before it can be trusted — see "Recommended
   path forward."
3. Meet Manager's entries importer also accepts `.csv`/`.txt` (for scraped
   registration sites, with user-driven column mapping in the import wizard) as a
   fallback if SD3 proves too finicky, but that format is configured per-import
   inside Meet Manager rather than a fixed spec we can target deterministically.

## SD3 file structure

A flat text file, one record per line, fixed-width fields, CRLF-terminated.
Records are identified by a 2-character code in columns 1–2. For a **meet entries
file** (as opposed to a full results file), the minimal required record set is:

```
A0                      — File description (exactly one, first line)
B1                      — Meet info (exactly one)
  C1                    — Team/club (one per club)
    D0                  — Individual event entry (one per swimmer per event)
    D1                  — Individual swimmer info (one per swimmer, after their D0s)
    E0                  — Relay event entry (one per relay team per event) [optional]
      F0                — Relay swimmer leg (one per swimmer on that relay) [optional]
Z0                      — File terminator (exactly one, last line), with record counts
```

No B2 (meet host), D3 (extended swimmer demographics), or G0 (splits) records are
needed for an entries-only file.

### Field layouts (columns are 1-indexed, `start/length`)

**A0 — File Description**

| Field | Start/Len | Format | Notes |
|---|---|---|---|
| Record ID | 1/2 | const | `"A0"` |
| Org code | 3/1 | code | `1`=USS. No lifesaving-specific org code exists — use closest fit or blank; needs confirmation against a real Meet Manager acceptance test. |
| SDIF version | 4/8 | alpha | `"V3"` etc. |
| File code | 12/2 | code | Entries-file indicator |
| Software name | 44/20 | alpha | e.g. `"SauvetageTeam"` |
| Software version | 64/10 | alpha | |
| Contact name | 74/20 | alpha | |
| Contact phone | 94/12 | phone | |
| File creation date | 106/8 | `MMDDYYYY` | |

**B1 — Meet**

| Field | Start/Len | Format | Notes |
|---|---|---|---|
| Record ID | 1/2 | const | `"B1"` |
| Meet name | 12/30 | alpha | from `meets.name` |
| Address / city / state / postal / country | 42–120 | alpha | team-app has no meet address fields today — would need to add them or leave blank |
| Meet start/end date | 122/8, 130/8 | `MMDDYYYY` | from `meets.mindate`/`maxdate` |
| Course | 150/1 | code | `1`/`S`=SCM, `2`/`Y`=SCY, `3`/`L`=LCM — from `meets.course` |

**C1 — Team ID** (one per club with registrations)

| Field | Start/Len | Format | Notes |
|---|---|---|---|
| Record ID | 1/2 | const | `"C1"` |
| Team code | 12/6 | code | Nominally "2-char LSC + 4-char team code" (USA Swimming convention) — Quebec lifesaving clubs have no LSC. Needs a synthetic scheme, e.g. `QC` + first 4 chars of `clubs.code`. |
| Full team name | 18/30 | alpha | `clubs.name` |
| Abbreviated name | 48/16 | alpha | `clubs.shortname` |
| City / state / postal / country | 64–142 | alpha | team-app clubs have no address fields today |

**D0 — Individual Event Entry** (one per swimmer × entered event)

| Field | Start/Len | Format | Notes |
|---|---|---|---|
| Record ID | 1/2 | const | `"D0"` |
| Swimmer name | 12/28 | `Last, First M` | from `members.lastname`/`firstname` |
| Attach status | 52/1 | code | Attached/unattached — always "attached" for us |
| Birth date | 56/8 | `MMDDYYYY` | `members.birthdate` |
| Sex | 66/1 | code | `M`/`F` — `members.gender` (1/2) maps directly |
| Event sex | 67/1 | code | `M`/`F`/`X` — from `events.gender` |
| Event distance | 68/4 | int | `swimstyle.distance` |
| Stroke | 72/1 | code | 1–7, see code table below — **`swimstyle.stroke` already uses this exact 1–7 numbering** (Freestyle/Back/Breast/Fly/IM/FreeRelay/MedRelay), so this is a direct passthrough, no remapping needed |
| Event number | 73/4 | alpha | `events.numb` |
| Event age range | 77/4 | code | 2-digit low + 2-digit high, `"UN"`=no lower limit, `"OV"`=no upper limit — from `events.minage`/`maxage` |
| Seed time | 89/8 | `mm:ss.ss` or special code | from `results.entrytime` (ms → formatted), or `"NT"` if none |
| Seed course | 97/1 | code | matches Seed time's course |

**D1 — Individual Swimmer Info** (one per swimmer, follows their D0 block)

| Field | Start/Len | Format | Notes |
|---|---|---|---|
| Record ID | 1/2 | const | `"D1"` |
| Team code | 12/6 | code | same synthetic code as the swimmer's C1 |
| Swimmer name | 19/28 | `Last, First M` | |
| Birth date | 64/8 | `MMDDYYYY` | |
| Sex | 74/1 | code | |

**E0 — Relay Event Entry** / **F0 — Relay Swimmer Leg** (optional, for relay teams)

Needed only if we also want to carry `relays`/`relayspos` data across. E0 is one
line per relay team entered in an event (`relays` row); F0 is one line per swimmer
on that relay (`relayspos` rows, in `numb` position order → maps to the "leg"
field, code table 024: `1`=first leg … `4`=fourth leg, `A`=alternate). Column
layouts captured above under "SD3 spec reference" — omitted here since relay
support is a stretch goal, not part of a first cut.

**Z0 — File Terminator**

| Field | Start/Len | Format | Notes |
|---|---|---|---|
| Record ID | 1/2 | const | `"Z0"` |
| # of B records / meets | 44/3, 47/3 | int | always 1/1 for us |
| # of C records / teams | 50/4, 54/4 | int | club count |
| # of D records / swimmers | 58/6, 64/6 | int | entry count / distinct swimmer count |
| # of E/F/G records | 70/5, 75/6, 81/6 | int | 0 unless relays are included |

### Relevant SDIF code tables

| Table | Values |
|---|---|
| SEX (010) | `M`, `F` |
| EVENT SEX (011) | `M`, `F`, `X` (mixed) |
| STROKE (012) | `1`=Free, `2`=Back, `3`=Breast, `4`=Fly, `5`=IM, `6`=Free relay, `7`=Medley relay |
| COURSE (013) | `1`/`S`=SCM, `2`/`Y`=SCY, `3`/`L`=LCM, `X`=disqualified |
| EVENT AGE (025) | 2-digit low + 2-digit high; `UN`=no lower bound, `OV`=no upper bound |
| RELAY LEG / ORDER (024) | `0`=not swimming this leg, `1`–`4`=leg position, `A`=alternate |
| TIME special codes (020) | `NT`=no time, `NS`=no show, `DNF`, `DQ`, `SCR` |

## team-app schema → SD3 mapping

Mirrors the style of `docs/LENEX_EXPORT_MATRIX.md`:

| team-app source | SD3 record/field |
|---|---|
| `meets.name`, `mindate`, `maxdate`, `course` | `B1` |
| `clubs` (one row per club with ≥1 registered member) | `C1` |
| `members` | `D1` (one per athlete), plus one `D0` per event they're entered in |
| `events` (`numb`, `gender`, `minage`/`maxage`) joined to `swimstyle` (`distance`, `stroke`) | `D0` event fields |
| best-times / `results.entrytime` for the member+style | `D0` seed time |
| `relays` + `relayspos` | `E0`/`F0` (optional, stretch goal) |
| — no equivalent — | SERC events (judged, not timed) have no SDIF representation; exclude swimstyle 530 same as the existing LENEX export already does |
| — no equivalent — | Beach meets (positions, not times) don't map to SDIF's time-based model at all — Hy-Tek Meet Manager itself is pool-only software, so this export path is **pool meets only** |

## Known gaps / open questions

1. **No real Meet Manager instance to test against.** Everything above is derived
   from the public SDIF v3 spec plus secondhand community reports. Given the
   forum reports of Meet Manager rejecting technically-spec-compliant SD3 files,
   the only way to be confident is to generate a sample file and actually try
   importing it into a Meet Manager install (or send one to an organizer who has
   it) before writing this into a real feature.
2. **Team/club codes.** SD3's `TEAM code` (006) assumes the USA Swimming
   LSC+team-code convention. Quebec lifesaving clubs have no LSC. Need a
   synthetic, collision-free scheme (e.g. `QC` + truncated `clubs.code`) — minor,
   but needs a decision.
3. **Missing address fields.** `B1` (meet) and `C1` (club) both have address
   fields team-app doesn't currently store (meet location, club city/state).
   These can likely be left blank — Meet Manager's importer probably tolerates
   it — but that's also unverified without a real test.
4. **Beach meets and SERC are out of scope.** Hy-Tek Meet Manager has no ranked
   /judged-event concept; this export only makes sense for pool meets, same
   restriction the existing entries data already has to accommodate through
   `meet_type`.
5. **HANDICAP/Para exception codes** (`members.handicapex`) have no SDIF
   equivalent — would be silently dropped, same category of loss as the beach
   number system.

## Recommended path forward

1. ~~Hand-build one representative SD3 sample~~ — done: `scripts/generate_hytek_sd3.py`
   is a standalone prototype that reads a team-app SQLite database file and a
   meet name, and writes a `.sd3` entries file for that meet (individual
   entries only — clubs → `C1`, athletes → `D0`/`D1`, `A0`/`B1`/`Z0` framing).
   It deliberately doesn't touch FastAPI/Postgres — point it at a copy of the
   default `meetmgr.db` SQLite file (or the file the unit tests spin up), not
   the Docker/Postgres stack:
   ```bash
   python packages/team-app/scripts/generate_hytek_sd3.py \
       --db /path/to/meetmgr.db --meet "Coupe du Québec 2026" --output entries.sd3
   ```
   Verified against a hand-seeded SQLite database: fields land at the exact
   column offsets from the "Field layouts" section above. What's **not**
   verified is whether Meet Manager itself accepts the result — that's step 2.
2. Get that sample actually imported into a real Hy-Tek Meet Manager install
   (organizer contact, or a trial license) to validate the record set/ordering
   Meet Manager actually accepts, since the public spec alone hasn't proven
   sufficient for others (see the "Meet Manager may reject generated SDIF
   files" report above).
3. Once validated, port the logic into `backend/app/export_hytek.py` following
   the same shape as `export_entries.py` (SQLAlchemy query → in-memory record
   build → bytes), exposed as a new `GET /api/export/hytek-entries` admin
   endpoint returning the `.sd3` file, gated to pool meets (`meet_type ==
   'POOL'`) same as other pool-only paths in the codebase.
4. Add relay (E0/F0) support as a follow-up once individual entries round-trip
   cleanly — not part of the first cut, and not in the prototype script.

## Sources

- [Understanding Swimming File Formats: SDIF, .sd3, .hy3, and .cl2](https://community.swimstandards.com/topic/94/understanding-swimming-file-formats-sdif-sd3-hy3-and-cl2)
- [What are CL2 and Hy3](https://swimmum.wordpress.com/2016/02/26/what-is-cl2-and-hy3/)
- [SDIF Version 3.0 spec text (sdifv3f.txt)](https://www.usms.org/admin/sdifv3f.txt) (mirrored in [tdsmith/sdif](https://github.com/tdsmith/sdif))
- [tdsmith/sdif — Python SDIF v3 library](https://github.com/tdsmith/sdif)
- [Import SD3 File for Meet Entry (Hy-Tek support)](https://activenetwork.my.salesforce-sites.com/hytekswimming/articles/en_US/Article/Internal-Importing-SD3-File-Requires-Internet-Connection)
- [Import Meet Entries (Hy-Tek user guide)](https://hytek.active.com/user_guides_html/swmm6/importmeetentries.htm)
- [3 Ways to Add Meet Entries (Hy-Tek support)](https://activenetwork.my.salesforce-sites.com/hytekswimming/articles/en_US/Article/3-Ways-to-Add-Meet-Entries)
- SDIF forum threads: "Trying to generate an SDIF file to import entries into Meet Manager", "Meet Entries for Team Manager vs. Meet Manager" (groups.google.com/g/sdif-forum)
