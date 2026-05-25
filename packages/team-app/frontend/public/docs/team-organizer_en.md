# SauvetageTeam — Organizer Guide

## Overview

The organizer manages the competition structure, sends invitations to clubs, and exports registration bundles for import into SauvetageMeet. This role has access to the **Meet**, **Invitation**, and **Registration** tabs.

---

## Login

1. Open the SauvetageTeam app in a browser
2. Enter the **organizer club PIN** (provided by the administrator)
3. Click **Login**

![Organizer — Meet tab](assets/team-organizer.png)

---

## Meet Tab — Competition Structure

### Create a New Meet

1. In the **Meet** tab toolbar, click **New Pool Meet** or **New Beach Meet**
2. Confirm the dialog — this wipes the current event structure and loads the template
3. The event tree refreshes with the standard events for the chosen meet type

> **Note**: This only resets the event structure. Clubs and athletes are preserved.

### View the Event Tree

The Meet tab displays the full competition structure as a tree:
- **Sessions** (morning, afternoon, etc.)
- **Events** within each session (50m Obstacle Swim, 100m Rescue Medley, etc.)
- **Age groups** within each event

### Upload Meet Structure

1. In the toolbar, click **Upload Meet Structure (.lxf)**
2. Select the `.lxf` file exported from SauvetageMeet
3. The app loads all events, pool size, masters flag, and fees

> **Important**: Uploading a new structure replaces the current one. All existing registrations will be deleted.

### Fee Summary

After uploading a meet structure, the **Fee Summary** box displays:
- Meet-level fees (per athlete, per club)
- Per-event fees (timing events)
- Currency

---

## Invitation Tab — Managing Club Invitations

### Set the Entry Closure Date

1. Navigate to the **Invitation** tab
2. In the **Entry Closure Date** section, select the deadline and click **Save**
3. Coaches can register until this date; after closure the form becomes read-only

### Send Invitations

1. In the **Team Invites** section, select clubs to invite (checkboxes or select all)
2. Click **Send Invitation**
3. Each coach receives an email with a one-time secure link to retrieve their club PIN

> **Note**: Clubs must have an email address configured in the Admin page.

### Monitor Invitation Status

The invitation list shows:
- ✅ Invitation sent (with date)
- 📧 Email pending
- 🔗 Link clicked (PIN revealed)

### Self-Invite (Alternative Flow)

Coaches can request their own invitation from the login page:
1. Click **Request an Invitation**
2. Select their club, confirm email, click **Send Invitation**

---

## After Closure — Export Registrations

1. After the closure date, click **Download bundle (.zip)**
2. The zip contains:
   - `entries.lxf` — all registrations in Lenex format
   - Helper scripts for result simulation

### Import into SauvetageMeet

1. In SauvetageMeet, use **File → Import LENEX**
2. Select the `entries.lxf` from the downloaded zip
3. All athletes, clubs, and entry times are imported

---

## Registration Tab

The organizer can register athletes from any club and modify entries (same interface as coaches, but not limited to their own club). See the [Coach Guide](team-coach) for details.

---

## Workflow Summary

| Step | Action | Tool |
|------|--------|------|
| 1 | Create new pool or beach meet from template | SauvetageTeam |
| 2 | Upload meet structure (.lxf) from SauvetageMeet export | SauvetageTeam |
| 3 | Set entry closure date | SauvetageTeam |
| 4 | Send invitations to clubs | SauvetageTeam |
| 5 | Wait for coaches to register | — |
| 6 | Export registration bundle (.zip) | SauvetageTeam |
| 7 | Import entries into SauvetageMeet | SauvetageMeet |
