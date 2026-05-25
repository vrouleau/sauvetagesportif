# SauvetageMeet — Beach Competition Workflow

## Overview

SauvetageMeet handles **beach (ranked)** lifesaving events where athletes are ranked by position (1st, 2nd, 3rd…) rather than timed. This guide covers the differences from pool mode and the complete beach competition workflow.

---

## Key Differences from Pool Mode

| Aspect | Pool | Beach |
|--------|------|-------|
| Results | Time in M:SS.CC | Position (1st, 2nd, 3rd…) |
| Lanes | Center-out assignment | No lanes (sequential numbering) |
| Heat capacity | Session lane count | Event max entries (or template default) |
| Seeding | By entry time | Random |
| Finals qualification | Fastest prelim time | Best prelim position (lowest) |
| Scanner/OCR tabs | Visible | **Hidden** |
| Best times | Displayed | Not applicable |

---

## Getting Started

### Create a Beach Meet

1. File menu → **Nouveau meet plage**
2. Confirm the creation dialog — this loads the beach template with beach-specific events (IDs 601-605)
3. The title bar shows a **🏖 PLAGE** badge to indicate beach mode

![New beach meet](assets/meet-pool-new-meet.png)

> **Warning**: Creating a new meet deletes all existing data. This is irreversible.

---

### Import Entries

1. File menu → **Importer un fichier LENEX…**
2. Select the entries `.lxf` file
3. Athletes and clubs are imported
4. No entry times are imported (beach events don't use times)

![Import entries](assets/meet-pool-import-summary.png)

---

## Events Tab — Beach Event Structure

The events tab works the same as pool mode, but beach events have different characteristics:

- Events use beach-specific swim styles (IDs 601-605)
- No distance in meters — events are activity-based (e.g., "Sprint plage", "Sauvetage planche")
- Max entries per heat is defined per event (`swimevent.maxentries`)

![Beach events](assets/meet-beach-events.png)

---

## Registration Tab

Registration for beach events is simplified:

- **Checkbox only** — no entry time needed
- No best times displayed (not applicable for ranked events)
- Relay assignment works the same as pool mode

![Beach registration](assets/meet-beach-inscription.png)

---

## Heats Tab — Random Seeding

### Generate Heats

1. Navigate to the **Séries** tab
2. Click **Générer séries**
3. Beach heats use **random seeding**:
   - Athletes are shuffled randomly
   - Distributed evenly across heats
   - Max participants per heat from event config (default: 16)
   - No lane assignment (sequential numbering as placeholders)

![Generate beach heats](assets/meet-beach-generate-heats.png)

---

### View Heats

The heat view for beach events shows:
- Participant list (numbered sequentially, not by lane)
- Athlete names and clubs
- No entry times column

---

### Enter Positions

Position entry has a specialized UX:

1. Select an event and heat
2. Click on an athlete's position cell
3. The cell **pre-fills with the next available position** (text selected for override)
4. Type the position number (1, 2, 3…) or accept the pre-filled value
5. Press **Enter** to confirm

![Position entry](assets/meet-beach-position-entry.png)

#### Special Behaviors

- **Duplicate position** → the two athletes' positions are **swapped** automatically
- **Gap prevention** → you cannot enter a position greater than the total number of athletes who already have positions
- **Rank column** is hidden (position IS the result)

---

## Finals — Qualification by Position

### How Qualification Works

For beach events with prelims + finals:

1. After prelim positions are entered, navigate to the **Finales** tab
2. Qualification is based on **best position** (lowest number = best)
3. Athletes with position 1 in prelims rank highest

---

### Generate Final Heats

1. Click **Générer finales**
2. Final heats are generated with qualified athletes
3. Enter final positions the same way as prelims

---

## What's Hidden in Beach Mode

The following features are **not available** in beach mode:

- ❌ **Scanner tab** — no timing sheets to scan
- ❌ **Traitement (Processing) tab** — no OCR needed
- ❌ **Timing sheet printing** — no chronometers
- ❌ **Best times display** — positions are not comparable across meets
- ❌ **Entry time fields** — no times to enter
- ❌ **Quantum integration** — no electronic timing

---

## Reports Tab

The reports tab works the same but shows:
- Results by position (1st, 2nd, 3rd…) instead of times
- Combined event standings (points based on position)
- Club rankings

![Beach reports](assets/meet-pool-reports.png)

---

## Save and Backup

Same as pool mode:
- File menu → **Sauvegarder le meet (.smb)…** for full backup
- File menu → **Synchronisation ↑** for remote database sync

---

## Quick Reference

| Action | How |
|--------|-----|
| Create new beach meet | File → Nouveau meet plage |
| Import entries | File → Importer un fichier LENEX |
| Generate heats (random) | Séries tab → Générer séries |
| Enter positions | Séries tab → Click position cell → Type number |
| Swap positions | Enter a duplicate position number |
| Generate finals | Finales tab → Générer finales |
| Save meet | File → Sauvegarder le meet (.smb) |
| Identify beach mode | Look for 🏖 PLAGE badge in tab bar |
