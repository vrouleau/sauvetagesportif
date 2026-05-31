# SERC Generator

## Project Overview

A single-file HTML desktop app that replaces a fragile Excel workbook used to tabulate results for SERC (Simulated Emergency Response Competition) lifesaving events.

The original spreadsheet is kept as a reference:
`C:\ProgramData\Meet Manager\SERC Generator CPLC 2026 version 28 mai 2026.xlsm`

## Files

- `SERC_Generator.html` — the complete app (HTML + CSS + JS, no dependencies, no build step)

## How to Run

Open `SERC_Generator.html` in any modern browser (Chrome, Edge, Firefox). No server or install required.

## Architecture

Single-file app with three layers inside the HTML:

- **State** — JSON object (`S`) persisted to `localStorage` under key `serc_generator_v1`
- **Calculation engine** — pure functions (`calcTeamTotal`, `calcOverallTotal`, `rankTeams`) that derive weighted scores and rankings from state
- **Rendering engine** — functions that build the DOM from state; re-renders the active page on every nav or data change

## Data Model

```
S = {
  competition: string,
  numVictims: 1–9,
  hasBystander: bool,
  numDraws: 1–4,

  overallFactors:   { assessment, control, communication, search, teamwork },
  bystanderFactors: { approach, info, directions, monitoring, encouragement },
  victimFactors:    [ { type, approach, rescue, control, landing, care }, ... ],  // 9 entries

  teams: [ { id, name, club, m1, m2, m3, m4 }, ... ],

  drawOrders: { "1": [teamId, ...], "2": [...], "3": [...], "4": [...] },

  scores: {
    "{draw}_{teamId}": {
      overall:   { assessment, control, communication, search, teamwork, rough },
      bystander: { approach, info, directions, monitoring, encouragement, rough },
      victims:   [ { approach, rescue, control, landing, care, rough }, ... ]  // 9 entries
    }
  }
}
```

## Scoring Logic

For each team in each draw:

```
weighted_score = Σ(raw_score × factor) for all criteria
               + rough_handling (0 or −10, no factor multiplier)
```

Sections: Overall (5 criteria) + Bystander (5 criteria, optional) + up to 9 Victims (5 criteria each). Each section also has a Rough Handling field (0 or −10).

Overall total = sum of weighted scores across all draws.

Teams are ranked highest-score-first within each draw and overall.

## Score Input IDs

Input element IDs encode all routing info so a single `handleScore(el)` handler can update state without closures:

```
sc_{draw}_{teamId}_{section}_{field}

section: o  = overall
         b  = bystander
         v0 = victim 0, v1 = victim 1, ... v8 = victim 8
```

## Current Meet Data (CPLC 2026)

- **26 teams** pre-loaded from the spreadsheet
- **Draw 1 & 3**: random draw order (from spreadsheet column I)
- **Draw 2**: sequential (not yet extracted from spreadsheet)
- **Draw 4**: final draw order (from spreadsheet columns N/O)
- **9 victims**: Non Swimmer ×2, Weak Swimmer ×2, Injured Swimmer ×4, Unconscious Non-Breathing ×1
- **Bystander**: enabled, all factors = 1.0
- **Overall factors**: Assessment 1.0, Control 1.0, Communication 1.25, Search 1.5, Teamwork 1.0

## Data Persistence

- Auto-saved to `localStorage` on every input change
- **Export JSON** — full backup of all state
- **Import JSON** — restore from backup
- **Export CSV** — results table for sharing

## Known Gaps / Future Work

- Draw 2 order not extracted from original spreadsheet (currently defaults to sequential)
- No user authentication or multi-device sync (localStorage is browser/device-local)
- Print layout renders all score panels open; could be refined per-team
- Could add per-draw scenario description fields (victim positions, notes for judges)
