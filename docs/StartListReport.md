# Start List Report (Fiche de Départs)

## Overview

New report type: **Fiche de Départs** — a start list grouped **by lane**, designed for lane judges to note times during the competition.

Unlike the existing "Liste des Séries" (grouped by event → heat → all lanes), this report produces **one section per lane** where each page shows the swimmer assigned to that lane across all heats of all events.

## Reference

See `FicheDeDeparts.pdf` for the visual target.

## Key Requirements

### 1. Report Structure (per lane)

For each lane (e.g., lane 0 through lane N):
- Header: meet name, "Couloir X", page N / total
- Body: compact table of entries for that lane, grouped by event
  - Event number + name + age range
  - For each heat in that event where this lane has a swimmer:
    - Heat number (e.g. "2/5")
    - Swimmer name (Last, First)
    - Club code (short, not full name — saves space)
    - Entry time
    - **Two time columns** (Temps 1, Temps 2) — one per judge to write observed time

### 2. No Individual Age Column

The age group range is shown in the event header. No per-swimmer age column (saves space, not needed for lane judges).

### 3. No Blank Lines Between Heats

Heats within an event are listed compactly with no spacing rows between them. The time cells are tall enough (18px) for judges to write clearly.

### 4. Smart Page Breaks — Never Split an Event

Within a single lane's document, an event's heats must **never** be split across two pages. If the remaining space on the current page cannot fit all heats for the next event, insert a page break before that event.

### 5. Synchronized Page Breaks Across Lanes (No Empty Pages)

**Problem:** Lane 3–4 have more swimmers than lane 0–1 (center lanes are used more). Without synchronization, lane 4's judge finishes a page while lane 1's judge is still mid-page. A runner cannot collect all sheets simultaneously.

**Solution:** The busiest lane determines the page break boundaries (which event starts each new page). Other lanes respect those same boundaries BUT:
- A lane **skips** a page break if it has NO content between the previous break and this one (avoids empty pages)
- A lane **skips** a page break if it has no content after the break point (avoids trailing empty pages)
- Lanes with fewer entries naturally pack more events per page since they respect the same boundaries but have less content between them

**Algorithm:**
1. For each lane, build the list of events and how many rows each occupies (1 header row + 2× number of heats for that lane).
2. Find the busiest lane (most total rows) — this is the "reference lane."
3. Walk the reference lane: accumulate rows; when adding the next event would exceed page capacity (38 rows), mark a page break. Record which event indices start new pages.
4. For each other lane, apply those page breaks ONLY if:
   - The lane has content on the page before the break, AND
   - The lane has content after the break
5. This means a lane with fewer entries may have fewer total pages — no empty pages.

### 6. Page Layout

- Page size: Letter portrait, 1.5cm margins
- Header on each page: Meet name (left), "Couloir X" large (center), "Page N / Total" (right)
- Compact table: Série | Nom | Club | Inscr. | Temps 1 | Temps 2
- Events separated by minimal spacing (4pt)
- Events use `break-inside: avoid` to prevent splitting within a page

### 7. UI Integration

- "Fiche de Départs" is the second option in the report type dropdown on `ReportPage.tsx`
- Reuses the same session/event selector, preview pane, and Print/PDF/HTML export buttons
- The generator produces one combined PDF with all lanes sequentially (lane 0 pages, then lane 1 pages, etc.), each starting on a new page
