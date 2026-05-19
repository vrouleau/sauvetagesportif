# Meet Manager — Quick Start Workflow

## Prerequisites

- SPLASH Meet Manager 11
- Meet Manager App running (Docker)
- Admin access to the app (admin PIN)

---

## Step 1 — Admin: Set Up Clubs and Athletes

1. Log in to Meet Manager App as **Admin**
2. In the **Admin** page, upload a Lenex entries `.lxf` file (previous meet or master list) to import clubs, athletes, and best times
3. Review the club list; add or remove clubs as needed
4. Designate the **organizer club** under *Set Meet Organizer*

---

## Step 2 — Organizer: Get the Meet Template

1. Log in as the **Organizer** (club designated by Admin)
2. In the **Organizer** page, click **Download Meet Template (.smb)**
3. Open the downloaded `.smb` file in SPLASH — this restores the full previous meet structure, including **combined events** (defined combined events are not preserved in `.lxf` exports)
4. In SPLASH, update the meet: dates, sessions, events, fees, and any other details
5. **Review and adapt the combined events** to match this season's meet definitions — combined event scoring rules are stored only in the `.smb` and must be manually updated each season

---

## SPLASH Configuration Checklist (before exporting the invitation)

Before exporting the invitation `.lxf` from SPLASH, verify that the following fields are set. Missing or incorrect values cause silent failures on import — wrong fees, events without age groups, best times that never fill in, etc.

| SPLASH setting | What breaks if missing |
|---|---|
| Meet name | Displayed throughout the UI and stored in app config |
| Pool type (LCM / SCM) | Defaults to LCM; wrong value means entry times show in the wrong column |
| Masters flag | Masters events and category are hidden for all athletes |
| Fee types and amounts | Invoice items are missing or zero |
| Fee currency | Invoice currency defaults to nothing |
| Per-event fees on timing events | Per-entry invoice lines are zero |
| Age groups on every event | Age category dropdown has no valid options for the event |
| Combined event definitions | Scoring for combined events (e.g. rescue medley, combined lifesaving) will be wrong or missing if not adapted to the current meet |

---

## Step 3 — Export the Meet Invitation from SPLASH

![Export invitation from SPLASH](/docs/assets/1_export_invitation.png)

1. In SPLASH, go to **Transfers → Export invitation…**
2. Save the resulting `.lxf` file (this is your updated meet structure)

---

## Step 4 — Organizer: Upload the Meet Structure

1. In the **Organizer** page, click **Upload Meet Structure** and select the `.lxf` exported in Step 3
2. The app loads all events, pool size, masters flag, and fees
3. The **Fee Summary** box will show the loaded meet-level and per-event fees

---

## Step 5 — Organizer: Set the Entry Closure Date

1. In the **Organizer** page, set the **Entry closure date**
2. Club coaches can register until this date; the invite list greys out after closure

---

## Step 6 — Organizer: Send Invitations to Club Coaches

1. In the **Organizer** page, go to **Team Invites**
2. Select the clubs to invite (use the checkboxes or select all)
3. Click **Send Invitation** — each coach receives an email with a one-time secure link to retrieve their club PIN

> **Alternative — self-invite**: Coaches can also request their own invitation without waiting for the organizer. From the login page, click **Request an Invitation**, select their club, confirm the email address on file, and click **Send Invitation**. This triggers the same email and secret-link flow. The club must have an email address configured in the Admin page.

---

## Step 7 — Club Coaches Register Athletes

![Edit entries](/docs/assets/3_editentries.png)

1. Coach clicks the PIN link in the invitation email to reveal their club PIN
2. Coach logs in with the PIN
3. Select an athlete → Registration page opens
4. Check events to register; select category (15-18 / Open / Masters)
5. Best times (50m and 25m) are shown read-only
6. Entry time is pre-filled from the best time matching the meet's pool size; adjust if needed

---

## Step 8 — Organizer: Export Registrations

1. After the closure date, in the **Organizer** page click **Download bundle (.zip)**
2. The zip contains the registrations `.lxf` and SPLASH simulation helper scripts

---

## Step 9 — Import Entries into SPLASH

![Import entries into SPLASH](/docs/assets/2_importentries.png)

1. In SPLASH, go to **Transfers → Import entries…**
2. Select the `.lxf` from inside the downloaded zip
3. All athletes, clubs, and entry times are imported and ready for race day

---

## Step 10 — After the Meet: Export Results from SPLASH

![Export results from SPLASH](/docs/assets/4_exportresults.png)

1. After the competition, in SPLASH go to **Transfers → Export results…**
2. Save the results `.lxf` file

---

## Step 11 — Admin: Upload Results to Update Best Times

1. In the **Admin** page, upload the results `.lxf` under **Upload Lenex (.lxf)**
2. Best times are updated (fastest of entry time vs. result, per pool size) and stamped with the meet date
3. These times will pre-fill entry times for the next meet; times older than 18 months are automatically discarded

---

## Step 12 — Admin: Export the Updated Entries File

1. In the **Data Management** page, click **Download entries (.lxf)**
2. Save this file — use it as the seed for the next meet (Step 1)

---

## Summary

| Step | Action | Who | Tool |
|------|--------|-----|------|
| 1 | Import clubs & athletes; designate organizer | Admin | Meet Manager App |
| 2 | Download meet template (.smb); adapt combined events in SPLASH | Organizer | Meet Manager App + SPLASH |
| 3 | Update meet in SPLASH; export invitation | Organizer | SPLASH |
| 4 | Upload meet structure | Organizer | Meet Manager App |
| 5 | Set closure date | Organizer | Meet Manager App |
| 6 | Send invitations | Organizer | Meet Manager App |
| 7 | Register athletes | Club coaches | Meet Manager App |
| 8 | Export registrations bundle (.zip) | Organizer | Meet Manager App |
| 9 | Import entries | Organizer | SPLASH |
| 10 | Export results | — | SPLASH |
| 11 | Upload results / update best times | Admin | Meet Manager App |
| 12 | Export updated entries file | Admin | Meet Manager App |

---

## Supplementary Workflow — Consolidating Results from Multiple Past Meets

Use this workflow when you have results or entries files from several past meets that were run with different SPLASH meet structures. Because each meet file may define its own event IDs (`IDxxx`) and club codes, importing multiple files can produce duplicate clubs and mismatched style UIDs. The **Data Management** page resolves both.

### Context

Each SPLASH meet structure assigns its own internal event IDs to disciplines (e.g., `ID001` in one meet file may represent the 50m Freestyle but `ID001` in another file may represent a different event). Similarly, a club that appears as `ASPN` in one file may appear as `ASP-N` or `ASP` in another. Importing both files without reconciling these differences results in duplicate clubs and fragmented best times.

### Step A — Import Each Past Meet File

For each past meet (entries or results `.lxf`):

1. Log in as **Admin**
2. In the **Admin** page, upload the `.lxf` file under **Upload Lenex (.lxf)**
3. The app imports new clubs, athletes, and best times; existing records are updated if a matching license number is found
4. Repeat for every past meet file you want to consolidate

After all uploads, the database will contain all athletes and best times, but may have duplicate clubs and inconsistent style UIDs.

### Step B — Merge Duplicate Clubs

Different meet files often encode the same club under slightly different codes or names. Use club merging to unify them:

1. In the **Data Management** page, go to the **Merge Clubs** section
2. The list shows all clubs currently in the database
3. For each duplicate pair, select the **source club** (the one to eliminate) and the **target club** (the canonical record to keep)
4. Click **Merge** — all athletes and registrations from the source club are re-parented to the target club, and the source club is deleted
5. Repeat until no duplicates remain

> **Tip:** Start with the most obvious duplicates (same name, different code). Club codes from older or non-standard meet files are the most common source of duplication.

### Step C — Merge Diverging Style UIDs

Each SPLASH meet file defines its own style UIDs for disciplines (e.g., the same discipline may appear as `ID001` in one file and `ID045` in another). Best times are stored per style UID, so a single athlete may end up with two separate best-time records for the same discipline.

1. In the **Data Management** page, go to the **Merge Styles** section
2. The list shows all distinct style UIDs found in the database, with their associated style names
3. For each pair of UIDs that represent the same discipline, select the **source UID** (to eliminate) and the **target UID** (canonical — typically the one used by the most recent or most complete meet file)
4. Click **Merge** — best times under the source UID are merged into the target UID, keeping the faster time per pool size (LCM / SCM) for each athlete; the source UID records are removed
5. Repeat for all diverging style pairs

> **Tip:** Cross-reference the style names shown in the list with your SPLASH event definitions to confirm you are merging the correct disciplines.

### Step D — Export the Consolidated Entries File

Once clubs and styles are fully reconciled:

1. In the **Data Management** page, click **Download entries (.lxf)**
2. Save this file — it is a clean Lenex export of all clubs, athletes, and consolidated best times
3. Use this file as the seed for the next meet (Step 1 of the main workflow)

### Summary

| Step | Action | Who | Tool |
|------|--------|-----|------|
| A | Upload each past meet entries/results file | Admin | Meet Manager App |
| B | Merge duplicate clubs | Admin | Meet Manager App — Data Management |
| C | Merge diverging style UIDs | Admin | Meet Manager App — Data Management |
| D | Export consolidated entries file | Admin | Meet Manager App — Data Management |
