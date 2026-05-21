# Splash Meet Manager — Lenex Export Content Matrix

This document describes what data is included in each type of `.lxf` file exported by Splash Meet Manager 11, and what is only preserved in the `.smb` (Splash Meet Backup) format.

## Export Types

| Content | Meet .lxf | Entries .lxf | Results .lxf | .smb |
|---------|:---------:|:------------:|:------------:|:----:|
| **Meet header** (name, city, course, dates, nation) | ✓ | ✓ | ✓ | ✓ |
| **Sessions** (schedule, pool config) | ✓ | ✓ | ✓ | ✓ |
| **Events** (event numbers, gender, round) | ✓ | ✓ | ✓ | ✓ |
| **Swim styles** (distance, stroke, relay count) | ✓ | ✓ | ✓ | ✓ |
| **Age groups** (min/max age, gender) | ✓ | ✓ | ✓ | ✓ |
| **Fees** (per-event, per-athlete, per-club) | ✓ | ✓ | — | ✓ |
| **Clubs** | — | ✓ | ✓ | — |
| **Athletes** (name, birthdate, license) | — | ✓ | ✓ | — |
| **Entries** (entry times, course) | — | ✓ | — | — |
| **Results** (swim times, status) | — | — | ✓ | — |
| **Splits** (intermediate times) | — | — | ✓ | — |
| **Heats** (seeding, lane assignments) | — | ✓* | ✓ | ✓ |
| **Relays** (team compositions) | — | ✓* | ✓ | — |
| **Pause/break events** | — | — | — | ✓ |
| **Combined events** (XML config) | — | — | — | ✓ |
| **Event sort order** (sortcode) | — | — | — | ✓ |
| **Layout templates** (lyt* fields) | — | — | — | ✓ |

\* Only if seeding/assignments have been done before export.

## Descriptions

### Meet .lxf (Invitation / Structure)

The "meet" export contains only the competition structure: sessions, events, swim styles, age groups, and fees. No athletes or clubs. This is the file an organizer sends out as an invitation for clubs to register.

### Entries .lxf (Registrations)

The "entries" export contains the full structure plus all registered clubs, athletes, and their entry times. If heats have been seeded, lane assignments are included. This is what gets imported into Splash to run the competition.

### Results .lxf

The "results" export contains the structure plus clubs, athletes, and their final swim times with splits. Entry times are not included. Used to update best-time databases after a competition.

### .smb (Splash Meet Backup)

The SMB is a binary backup of the full Splash database. It preserves everything including:

- **Pause/break events** (`internalevent = 'T'`, no swim style) — these are not representable in Lenex
- **Combined events** configuration (stored as XML in `BSGLOBAL`)
- **Sort order** of events within sessions
- **Layout template** references
- **All internal IDs** (preserving FK relationships)

## Why SMB Matters

The Lenex format (`.lxf`) is an interchange standard — it covers competitive data but omits operational details. Key gaps:

1. **Pauses** — Lenex has no concept of break/pause events between competitive events. They are lost on export.
2. **Combined events** — The combined-event definitions (which individual events contribute to a combined score) are stored as custom XML in Splash's `BSGLOBAL` table. Lenex doesn't support this.
3. **Exact ordering** — Lenex events are ordered by event number, but Splash uses a separate `sortcode` that allows pauses to be interleaved.

For round-tripping a full meet structure (including pauses and combined events), always use the `.smb` format.
