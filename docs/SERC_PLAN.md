# SERC Integration Plan (Revised)

## Overview

SERC (Simulated Emergency Response Competition) is a technical judged relay event in lifesaving. Teams of 4 respond to a staged water emergency with multiple victims. Each team performs once per draw (round), and judges score independently on paper sheets or digitally.

## Key Concepts (from XLSX analysis)

### Draws
A "draw" is a **single round** where all teams perform sequentially. The draw determines the **order** in which teams compete. Typically:
- **Draw 1 & 3**: Random order (generated once, reused)
- **Draw 2 (optional)**: Different random order
- **Draw 4**: "Final draw" — often ordered by preliminary results (best goes last)

Each draw uses the **same scenario** (same victims, same factors). Teams are scored once per draw.

### Factor Sheet (Victim Configuration)
The factor sheet defines up to **16 victim positions** (not all used). Each victim has:
- **Type**: Non Swimmer, Weak Swimmer, Injured Swimmer, Unconscious Non-Breathing
- **5 scoring criteria** with individual weighting factors (1.0, 1.25, or 1.5):
  - Victim Recognition / Approach
  - Rescue
  - Control of Victim
  - Landing
  - Care and Aftercare

The factors come from a **predefined catalog** (rows 1-16 in Factor Sheet, referenced as victim types A1-G16). The organizer selects which victim type goes in each position and the factors are auto-assigned based on:
- **Approach factor**: based on distance (far=1.5, near=1.25, close=1.0)
- **Rescue factor**: based on cooperation (refuses=1.5, accepts but won't swim=1.25, accepts/unconscious=1.0)
- **Control factor**: based on rescue type (carry=1.0, reach/tow=1.25, talk/throw=1.5)
- **Landing factor**: based on victim state at landing (unconscious=1.0, non/injured=1.25, weak/mobile=1.5)
- **Care factor**: based on victim condition (unconscious=1.5, non/injured=1.25, weak/mobile=1.0)

### Overall (Chief Judge)
5 criteria with factors (1.0, 1.25, or 1.5):
- Assessment (of priorities)
- Control (over scenario)
- Communication
- Search (finding victims)
- Teamwork

Plus a **Rough Handling** penalty (0 or -10).

### Bystander (optional)
5 criteria (all typically factor 1.0):
- Victim Recognition / Approach
- Assesses relevant information
- Provides directions and instructions
- Monitoring bystander actions
- Provides ongoing encouragement

Plus Rough Handling penalty.

### Scoring
- Each criterion is scored **0-10** in increments of 0.5
- Rough Handling is **0 or -10** only (no partial)
- Weighted score = raw_score × factor
- Team draw total = sum of all weighted scores across all sections
- Overall total = sum across all draws

### Teams
- Come from **relay team entries** for the SERC event (swimstyle ID 530)
- No separate team creation UI needed
- The SERC page pulls teams directly from the relay entries page

### Scoring Sheet (Scoring tab in XLSX)
- Single grid: columns = teams (in draw order), rows = criteria
- Shows factor in column D, raw scores entered in team columns
- Subtotals per section, grand total + ranking at top

### Judge Sheets (VICTIM_1-9, OVERALL, BYSTANDER tabs)
- One printable page per victim/section
- Contains: scenario description, marking criteria, factor info, score guidelines
- Fields for: Draw No, Team Name, Judge ID
- Used for hand-scoring — volunteer enters into the Scoring grid later

## Data Model (Revised)

```sql
-- SERC competition configuration (one per meet)
CREATE TABLE serc_config (
  id INTEGER PRIMARY KEY,
  num_victims INTEGER DEFAULT 9,
  num_draws INTEGER DEFAULT 4,
  has_bystander INTEGER DEFAULT 1,
  overall_factors_json TEXT,      -- {assessment: 1, control: 1, communication: 1.25, search: 1.5, teamwork: 1}
  bystander_factors_json TEXT,    -- {approach: 1, info: 1, directions: 1, monitoring: 1, encouragement: 1}
  victim_factors_json TEXT,       -- [{type, approach, rescue, control, landing, care}, ...] up to 16
  created_at TEXT
);

-- Draw orders (which team goes in which position per draw)
CREATE TABLE serc_draw_order (
  config_id INTEGER REFERENCES serc_config(id),
  draw_number INTEGER,
  position INTEGER,
  relay_team_id INTEGER,          -- FK to relays table (SERC relay teams)
  PRIMARY KEY (config_id, draw_number, position)
);

-- Scores: one row per (draw, team, section, field)
CREATE TABLE serc_score (
  id INTEGER PRIMARY KEY,
  config_id INTEGER REFERENCES serc_config(id),
  draw_number INTEGER,
  relay_team_id INTEGER,          -- FK to relays table
  section TEXT,                   -- 'overall', 'bystander', 'victim_0'..'victim_15'
  field TEXT,                     -- 'assessment', 'approach', 'rescue', 'rough', etc.
  value REAL,
  UNIQUE(config_id, draw_number, relay_team_id, section, field)
);
```

No `serc_team` table needed — teams come from relays.

## UI (Revised)

### SERC Tab layout

| Page | Content |
|------|---------|
| **Setup** | Select num victims (1-16), num draws, bystander toggle, configure victim types + factors, overall factors |
| **Draw 1–N** | Score entry grid (teams in columns, criteria in rows). Pull teams from SERC relay entries. |
| **Results** | Ranked totals per draw + overall |
| **Print** | Generate printable judge sheets (bilingual FR/EN) |

### Setup Page
- Victim count selector (1-16)
- Per victim: dropdown to select type from catalog → auto-fills factors
- OR manual factor override per criterion
- Overall factors: dropdown per criterion (1.0/1.25/1.5) based on scenario difficulty
- Bystander yes/no toggle

### Score Entry (Draw page)
- Grid layout matching the XLSX Scoring sheet
- Teams in columns (from relay entries, in draw order)
- Criteria in rows with factor column
- Section headers: Overall, Bystander, Victim 1-N
- Real-time subtotals and grand total
- Ranking row at top

### Print
- **Judge sheets**: one per section (OVERALL, BYSTANDER, VICTIM_1-N)
  - Pre-filled with scenario description, criteria, factors
  - Empty score fields for hand-writing
  - Bilingual (FR front / EN back) or unilingual
- **Score entry grid**: blank grid for volunteer data entry (matches Scoring sheet layout)

## Integration with Relay Entries
- SERC event uses swimstyle ID 530 (relay with 4 members)
- Teams are created on the Relay Entry page as normal relay teams
- SERC tab reads those teams for scoring
- No duplicate team management

## Implementation Changes Needed

1. ~~Remove `serc_team` table~~ — use relay teams directly
2. Update `serc_draw_order` and `serc_score` to reference `relay_team_id` (from `relays` table)
3. Add endpoint to fetch SERC relay teams (filter relays by SERC swimstyle)
4. Update score entry UI to grid layout (teams in columns)
5. Update print sheets with proper scenario descriptions from factor catalog
6. Add factor catalog (the 9 predefined victim types with their descriptions)
