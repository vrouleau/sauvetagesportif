# SauvetageTeam — Administrator Guide

## Overview

The administrator is responsible for full database backup/restore, managing clubs and athletes, and maintaining data between seasons. This role has access to **all tabs** in the application: Meet, Invitation, Individual Entries, Relay Entries, SERC, and Admin.

---

## Complete Meet Lifecycle

![Meet Lifecycle](assets/meet-lifecycle-en.png)

The admin's role is primarily at **steps ① and ⑦**: inviting the organizer at the start, and being ready to invite the next organizer once the meet closes.

---

## Login

1. Open the SauvetageTeam app in a browser
2. Enter the **Admin PIN** (configured by the host)
3. Click **Login**

![Admin page](assets/team-admin.png)

---

## Admin Tab — Key Actions

### Database Backup

The Admin page provides full backup and restore capabilities for the database.

#### Create Backup

1. Click **Create Backup** — a snapshot of the current database is stored on the server
2. The backup appears in the **Backup List** below

#### Restore (.sql)

1. Click **Restore (.sql)**
2. Select a `.sql` backup file to upload
3. The app wipes the current database and restores all data from the file

> **Warning**: This replaces ALL data in the database. Clubs get new PINs assigned automatically.

#### Auto-Backup Configuration

1. In the **Auto-Backup** section, set the **interval** (in days) between automatic backups
2. Set the **maximum copies** to keep — older backups are deleted automatically
3. Click **Save**

#### Backup List

The backup list displays all stored backups (manual and automatic):
- Click **Download** to save a backup file locally
- Click **Delete** to remove a backup from the server

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
- Upload meet structure (.lxf)
- Upload entries/results (.lxf)
- Export registration bundle (.zip)
- Send invitations
- Create new pool/beach meet (from the Invitation page: **Create Pool** / **Create Beach** buttons)
- SERC (Simulated Emergency Response Competition) configuration and scoring

See the [Organizer Guide](team-organizer) for details on these workflows.

---

## Historical Meets

The **Historical Meets** section lets you import past competition results. These results are used to compute athletes' best times for future meets.

### Import Team.mdb (legacy)

1. Click **Import Team.mdb** and select the legacy Access database
2. All meets, members, and results are imported

### Import results .smb

1. Click **Import results .smb** and select a SauvetageMeet backup file
2. The meet name, athletes, and results are imported

### Import results .lxf

1. Click **Import results .lxf** and select a Lenex results file
2. If a duplicate meet is detected, you can force the import

### Manage Historical Meets

- The historical meets table shows all imported meets with their date, location, and result count
- Click **✕** to delete a historical meet (irreversible)

---

## Task Summary

| Task | When | Section |
|------|------|---------|
| Designate organizer | Before each meet | Admin |
| Configure club emails | Before invitations | Admin |
| Configure Gemini keys | Before competition | Admin |
| Create backup | After any major change | Admin |
| Configure auto-backup | Once (set interval + max copies) | Admin |
| Import historical results | After receiving results from a past meet | Admin |
| *(After meet closes)* Invite next organizer | After organizer imports results | Admin |
