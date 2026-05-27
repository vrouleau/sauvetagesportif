# SauvetageTeam — Organizer Guide

## Overview

The organizer manages the full meet cycle: creating the structure, sending invitations, collecting registrations, sending invoices, and finally importing results to close the meet. This role has access to the **Meet**, **Invitation**, and **Registration** tabs.

```
┌────────────────────────── MEET LIFECYCLE ────────────────────────────────┐
│                                                                            │
│  ① Admin         Invite organizer (set organizer club in Admin page)     │
│        │                                                                   │
│        ▼                                                                   │
│  ② Organizer     Create meet structure                                    │
│                  (Create Pool/Beach — or import .lxf from SauvetageMeet)  │
│        │                                                                   │
│        ▼                                                                   │
│  ③ Organizer     Send invitations → coaches receive PIN by email          │
│        │                                                                   │
│        ▼                                                                   │
│  ④ Coaches       Log in · Register athletes · Adjust entry times          │
│        │                                                                   │
│        ▼                                                                   │
│  ⑤ Organizer     Closure date passes → Send Stripe invoices to clubs      │
│        │                                                                   │
│        ▼                                                                   │
│  ⑥ Organizer     Export registrations (.lxf)                              │
│   SauvetageMeet  Import entries · Seed heats · Run competition            │
│                  Record times · Generate reports · Export results (.lxf)  │
│        │                                                                   │
│        ▼                                                                   │
│  ⑦ Organizer     Import results (.lxf)   ← closes the meet               │
│                  → Results archived as historical meet                     │
│                  → Current meet reset (events + registrations cleared)    │
│                  → All club PINs regenerated                              │
│                  → Organizer role cleared · Organizer logged out          │
│                  → Admin meet also reset                                  │
│        │                                                                   │
│        └────────────────────────────────► ① Start next meet cycle        │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Login

1. Open the SauvetageTeam app in a browser
2. Enter the **organizer club PIN** (provided by the administrator)
3. Click **Login**

![Organizer — Meet tab](assets/team-organizer.png)

---

## Meet Tab — Competition Structure

### Create a New Meet

1. In the **Invitation** tab toolbar, click **Create Pool** or **Create Beach**
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

### Entry Deadline

The entry deadline is set in the meet configuration panel:
1. In the **Meet** tab, open the **Competition** config panel → **Others** section
2. Set the **Entry deadline** date
3. This date is displayed read-only on the Invitation tab and enforces registration closure

---

## Invitation Tab — Managing Club Invitations

### Entry Closure Date

The entry closure date is configured in the **Meet** tab under **Competition → Others → Entry deadline**. The Invitation tab displays the closure date in read-only mode for reference.

- Coaches can register until this date; after closure the form becomes read-only

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

1. After the closure date, click **Download LXF** in the Invitation tab toolbar
2. Import the `.lxf` file into SauvetageMeet: **File → Import LENEX**
3. All athletes, clubs, and entry times are loaded into SauvetageMeet

---

## After Closure — Send Invoices (Stripe)

If your Stripe account is connected:

1. Select clubs in the Invitation tab (checkboxes)
2. Click **Send Stripe Invoice** — each club receives an invoice for their registration fees
3. Clubs pay online; payment status is tracked in Stripe

> **Note**: Connect your Stripe account in the Invitation tab toolbar before the meet. Fees are configured in the meet structure.

---

## Registration Tab

The organizer can register athletes from any club and modify entries (same interface as coaches, but not limited to their own club). See the [Coach Guide](team-coach) for details.

---

## After the Competition — Import Results (Close the Meet)

Once the competition is over and results have been exported from SauvetageMeet:

1. In SauvetageMeet, use **File → Export results LENEX…** to save a `.lxf` results file
2. In SauvetageTeam (Invitation tab), click **Import Results**
3. A confirmation modal appears — review the warning carefully. This action is **irreversible** and will:
   - Archive results as a completed historical meet (used for future best times)
   - Reset the current meet **for both admin and organizer** (all registrations and event structure cleared)
   - Regenerate all club PINs (coaches must re-authenticate for the next meet)
   - Clear the organizer role and **log you out**
4. After logout, the administrator can invite the organizer for the next meet

> **Admin note**: After a results import, the system is back to step ①. The meet is reset for both admin and organizer. Designate the next organizer in the Admin page.

---

## Workflow Summary

| Step | Action | Role | Tool |
|------|--------|------|------|
| ① | Invite organizer | Admin | SauvetageTeam |
| ② | Create meet structure | Organizer | SauvetageTeam (or SauvetageMeet → export) |
| ③ | Send invitations to clubs | Organizer | SauvetageTeam |
| ④ | Register athletes | Coaches | SauvetageTeam |
| ⑤ | Send Stripe invoices (collect fees) | Organizer | SauvetageTeam |
| ⑥ | Export registrations (.lxf) → Run competition | Organizer + SauvetageMeet | Both |
| ⑦ | Import results (.lxf) → meet closed | Organizer | SauvetageTeam |
