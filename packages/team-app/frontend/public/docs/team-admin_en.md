# SauvetageTeam — Administrator Guide

## Overview

The administrator is responsible for full database backup/restore, managing clubs and athletes, and maintaining data between seasons. This role has access to **all tabs** in the application (including the Organizer tabs).

---

## Login

1. Open the SauvetageTeam app in a browser
2. Enter the **Admin PIN** (configured by the host)
3. Click **Login**

![Admin page](assets/team-admin.png)

---

## Admin Tab — Key Actions

### Restore from Backup (.smb)

The primary way to seed the database is by restoring a full `.smb` backup. This loads **everything**: clubs, athletes, events, sessions, age groups, registrations, results, and configuration.

1. In the **Restore Backup (.smb)** section, click **Choose file**
2. Select an `.smb` file (from a previous season or from SauvetageMeet)
3. The app wipes the current database and loads all data from the backup

> **Warning**: This replaces ALL data in the database. Clubs get new PINs assigned automatically.

### Save Backup (.smb)

1. In the **Save Backup (.smb)** section, click **Download**
2. Save the file — this is a full snapshot of the current database
3. Use it to transfer data to SauvetageMeet or as a season archive

### Designate the Organizer

1. In the **Set Meet Organizer** section, select the organizer club from the dropdown
2. Click **Save** — the designated club can now log in with the "organizer" role

### Manage Clubs

- Verify codes, names, and emails for each club
- Add or remove clubs as needed
- **Configure each club's email address** — required for sending invitations

### Configure Gemini API Keys

1. In the **Gemini API Keys** section, enter the free and/or paid key
2. Click **Save** — these keys travel with the `.smb` export to SauvetageMeet

### Change Admin PIN

1. In the **Change Admin PIN** section, enter the new PIN and confirm

---

## Organizer Pages (Admin has full access)

The admin has access to all organizer capabilities:
- Create new pool/beach meet from templates
- Upload meet structure (.lxf)
- Upload entries/results (.lxf)
- Export registration bundle (.zip)
- Send invitations, set closure date

See the [Organizer Guide](team-organizer) for details on these workflows.

---

## Data Management Tab

### Export Entries (.lxf)

1. Navigate to the **Data Management** tab
2. Click **Download entries (.lxf)** — use as the seed for the next meet

### Merge Duplicate Clubs

1. In the **Merge Clubs** section, select the **source club** (to eliminate) and the **target club** (to keep)
2. Click **Merge** — all athletes are re-parented to the target club

### Merge Diverging Styles

1. In the **Merge Styles** section, select the **source UID** (to eliminate) and **target UID** (canonical)
2. Click **Merge** — best times are consolidated (fastest per pool size is kept)

---

## Task Summary

| Task | When | Section |
|------|------|---------|
| Restore backup (.smb) | Start of season / data transfer | Admin |
| Designate organizer | Start of season | Admin |
| Configure club emails | Before invitations | Admin |
| Configure Gemini keys | Before competition | Admin |
| Save backup (.smb) | After any major change | Admin |
| Export entries (.lxf) | After updating times | Data Management |
| Merge clubs/styles | After multiple imports | Data Management |
