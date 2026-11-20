// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
//
// This file is part of Sauvetage Sportif.
//
// Sauvetage Sportif is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Sauvetage Sportif is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Sauvetage Sportif. If not, see <https://www.gnu.org/licenses/>.

/**
 * SMB file format handler (Splash Meet Backup)
 *
 * An .smb file is a ZIP archive containing:
 * - geologix.ini: metadata (app version, record counts)
 * - TABLENAME-0001.gbin: binary-serialized table data
 *
 * GBIN format:
 * - 2-byte LE header length
 * - Header: tab-separated "COLNAME;TYPE;SIZE" column definitions
 * - Body: records packed contiguously (no separator bytes)
 *
 * Column types:
 * - I;32 = int32 LE (4 bytes), I;16 = int16 LE (2 bytes)
 * - S;N = uint16 LE string length + UTF-8 content (len=0 → null)
 * - D;32 = 8-byte LE double (OLE Automation date)
 * - F;0 = 8-byte LE double (floating point / currency)
 * - M;0 = uint32 LE length + UTF-8 content (memo field, len=0 → null)
 *
 * Null disambiguation:
 * When a numeric field (I, D, F) stores its null-sentinel value, a trailing
 * 1-byte flag follows: 0x00 = value is real, 0x01 = value is null.
 * Sentinels: I → 0, F → 0.0, D → -36522.0 (OLE date for 1800-01-01 00:00:00).
 * S/M fields use len=0 for null (no flag needed).
 * G fields (Splash 11.85709+) are 16 raw GUID bytes, no flag; all-zero = null.
 */

import { ROUND } from './rounds'
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateRawSync, deflateRawSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import type { DbBackend } from './dbBackend'

// ── Table definitions (column name, type, size) ───────────────────────────────

export interface ColDef {
  name: string
  type: 'I' | 'S' | 'D' | 'F' | 'M' | 'G'
  size: number
  // No backing column in our own schema — export-only, generated per row at save time.
  // Never read from or written to our DB. (Unused since the sync GUIDs got real columns.)
  synthetic?: boolean
  // Sync GUID column: export writes the stored value, or a fresh GUID when the row has none
  // (rows meet-app created itself). Splash fills every *GUID except SWIMRESULTGUID.
  newGuid?: boolean
}

// Tables to include in SMB backup (order matters for FK dependencies).
// Column definitions must match the gbin header format that Splash expects.
// The column ORDER here defines the binary layout in the gbin file.
// `stub: true` tables have no backing table in our own schema (we don't have a records-tracking
// feature) — they're exported as genuinely-present-but-empty gbin files instead of omitted
// entirely: omitting them (the previous behavior) produced a working `.smb` file, but real Splash's Results
// module apparently doesn't tolerate a *missing* record-checking table the way it tolerates an
// empty one — it crashed with an access violation (nil dereference) the moment any heat was
// viewed, even with zero results entered. saveSMB/restoreSMB special-case `stub` tables: always
// export 0 rows without querying our DB, and never attempt to read/write our DB for them on restore.
const SMB_TABLES: { name: string; cols: ColDef[]; stub?: boolean }[] = [
  {
    name: 'BSGLOBAL', cols: [
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'DATA', type: 'M', size: 0 },
    ]
  },
  {
    name: 'DSQITEM', cols: [
      { name: 'DSQITEMID', type: 'I', size: 32 },
      { name: 'CODE', type: 'S', size: 10 },
      { name: 'LENEXCODE', type: 'S', size: 10 },
      { name: 'NAME', type: 'S', size: 250 },
      { name: 'OPTIONS', type: 'S', size: 5 },
      { name: 'SORTCODE', type: 'I', size: 16 },
    ]
  },
  {
    name: 'SWIMSTYLE', cols: [
      { name: 'SWIMSTYLEID', type: 'I', size: 32 },
      { name: 'CODE', type: 'S', size: 10 },
      { name: 'DISTANCE', type: 'I', size: 16 },
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'RELAYCOUNT', type: 'I', size: 16 },
      { name: 'STROKE', type: 'I', size: 16 },
      { name: 'SORTCODE', type: 'I', size: 32 },
      { name: 'TECHNIQUE', type: 'I', size: 16 },
      { name: 'UNIQUEID', type: 'I', size: 16 },
      // Real Splash column (Microsoft.ACE.OLEDB.12.0 GetSchema: S;36, matches randomUUID()'s
      // dashed format), always a real unique value in every genuine Splash-native .mdb sampled —
      // never blank. Re-added 2026-08-14 after being tried once (2026-08-13) and reverted for not
      // fixing a *different*, earlier-in-the-flow access-violation crash (see smb_beach_results_
      // crash_investigation memory / meet-app CLAUDE.md) — new evidence (a distinct "Invalid class
      // typecast" crash surfacing deeper in Splash's own delete-final routine, in its generic
      // items/notification dispatch layer, once the earlier crash was fixed) makes an object-
      // identity mismatch from blank/duplicate GUIDs a live hypothesis again for THIS crash.
      // Type 'G' (16 raw bytes), not 'S': Splash 11.85709 (2026-11) writes every *GUID column
      // as G;36 in its own .smb, and silently blanks a GUID it receives as S;36 on restore.
      { name: 'SWIMSTYLEGUID', type: 'G', size: 36, newGuid: true },
      { name: 'SYNCMODIFIED', type: 'I', size: 32 },
      { name: 'ISDIRTY', type: 'S', size: 1 },
    ]
  },
  {
    name: 'SWIMSESSION', cols: [
      { name: 'SWIMSESSIONID', type: 'I', size: 32 },
      { name: 'COURSE', type: 'I', size: 16 },
      { name: 'DAYTIME', type: 'D', size: 32 },
      { name: 'ENDTIME', type: 'D', size: 32 },
      { name: 'FEEATHLETE', type: 'F', size: 0 },
      { name: 'FOLLOWING', type: 'S', size: 1 },
      { name: 'LANEMIN', type: 'I', size: 16 },
      { name: 'LANEMAX', type: 'I', size: 16 },
      { name: 'LANESBYPLACE', type: 'S', size: 100 },
      { name: 'MAXENTRIESATHLETE', type: 'I', size: 16 },
      { name: 'MAXENTRIESRELAY', type: 'I', size: 16 },
      { name: 'NAME', type: 'S', size: 100 },
      { name: 'OFFICIALMEETING', type: 'D', size: 32 },
      { name: 'POOLGLOBAL', type: 'S', size: 1 },
      { name: 'POOLTYPE', type: 'I', size: 16 },
      { name: 'REMARKS', type: 'M', size: 0 },
      { name: 'REMARKSJURY', type: 'M', size: 0 },
      { name: 'ROUNDTOTENTHS', type: 'S', size: 1 },
      { name: 'SESSIONNUMBER', type: 'I', size: 16 },
      { name: 'STARTDATE', type: 'D', size: 32 },
      { name: 'TIMING', type: 'I', size: 16 },
      { name: 'TLMEETING', type: 'D', size: 32 },
      { name: 'TOUCHPADMODE', type: 'I', size: 16 },
      { name: 'WARMUPFROM', type: 'D', size: 32 },
      { name: 'WARMUPUNTIL', type: 'D', size: 32 },
      { name: 'SWIMSESSIONGUID', type: 'G', size: 36, newGuid: true },
      { name: 'SYNCMODIFIED', type: 'I', size: 32 },
      { name: 'ISDIRTY', type: 'S', size: 1 },
    ]
  },
  {
    name: 'CLUB', cols: [
      { name: 'CLUBID', type: 'I', size: 32 },
      { name: 'BONUSPOINTS', type: 'I', size: 32 },
      { name: 'CLUBTYPE', type: 'I', size: 16 },
      { name: 'CODE', type: 'S', size: 10 },
      { name: 'CONTACTNAME', type: 'S', size: 50 },
      { name: 'CONTACTINTERNET', type: 'S', size: 150 },
      { name: 'CONTACTCITY', type: 'S', size: 30 },
      { name: 'CONTACTCOUNTRY', type: 'S', size: 2 },
      { name: 'CONTACTEMAIL', type: 'S', size: 50 },
      { name: 'CONTACTFAX', type: 'S', size: 20 },
      { name: 'CONTACTPHONE', type: 'S', size: 20 },
      { name: 'CONTACTSTATE', type: 'S', size: 5 },
      { name: 'CONTACTSTREET', type: 'S', size: 50 },
      { name: 'CONTACTSTREET2', type: 'S', size: 50 },
      { name: 'CONTACTZIP', type: 'S', size: 10 },
      { name: 'EXTERNALID', type: 'S', size: 40 },
      { name: 'LONGCODE', type: 'S', size: 20 },
      { name: 'ENTRYCLUBID', type: 'I', size: 32 },
      { name: 'ENTRYEMAILS', type: 'S', size: 255 },
      { name: 'NAME', type: 'S', size: 80 },
      { name: 'NAMEEN', type: 'S', size: 80 },
      { name: 'NATION', type: 'S', size: 3 },
      { name: 'REGION', type: 'S', size: 10 },
      { name: 'SHORTNAME', type: 'S', size: 30 },
      { name: 'SHORTNAMEEN', type: 'S', size: 30 },
      { name: 'SWRID', type: 'I', size: 32 },
      { name: 'TEAMNUMBER', type: 'I', size: 16 },
      { name: 'CLUBGUID', type: 'G', size: 36, newGuid: true },
      { name: 'SYNCMODIFIED', type: 'I', size: 32 },
      { name: 'ISDIRTY', type: 'S', size: 1 },
    ]
  },
  {
    name: 'ATHLETE', cols: [
      { name: 'ATHLETEID', type: 'I', size: 32 },
      { name: 'CLUBID', type: 'I', size: 32 },
      { name: 'FIRSTNAME', type: 'S', size: 30 },
      { name: 'FIRSTNAME_UPPER', type: 'S', size: 5 },
      { name: 'GENDER', type: 'I', size: 16 },
      { name: 'LASTNAME', type: 'S', size: 50 },
      { name: 'LASTNAME_UPPER', type: 'S', size: 10 },
      { name: 'NAMEPREFIX', type: 'S', size: 20 },
      { name: 'BIRTHDATE', type: 'D', size: 32 },
      { name: 'DOMICILE', type: 'S', size: 50 },
      { name: 'EXTERNALID', type: 'S', size: 40 },
      { name: 'FIRSTNAMEEN', type: 'S', size: 30 },
      { name: 'HANDICAPEX', type: 'S', size: 20 },
      { name: 'HANDICAPS', type: 'I', size: 16 },
      { name: 'HANDICAPSB', type: 'I', size: 16 },
      { name: 'HANDICAPSM', type: 'I', size: 16 },
      { name: 'LASTNAMEEN', type: 'S', size: 50 },
      { name: 'LICENSE', type: 'S', size: 20 },
      { name: 'NATION', type: 'S', size: 3 },
      { name: 'SDMSID', type: 'I', size: 32 },
      { name: 'STATUS', type: 'I', size: 32 },
      { name: 'SWIMLEVEL', type: 'S', size: 10 },
      { name: 'SWRID', type: 'I', size: 32 },
      { name: 'SWRHASHKEY', type: 'I', size: 32 },
      { name: 'CLUBCODE2', type: 'S', size: 10 },
      { name: 'COACHNAME', type: 'S', size: 80 },
      { name: 'SCHOOLYEAR', type: 'S', size: 10 },
      { name: 'MIDDLENAME', type: 'S', size: 50 },
      { name: 'MIDDLENAMEEN', type: 'S', size: 50 },
      { name: 'ATHLETEGUID', type: 'G', size: 36, newGuid: true },
      { name: 'SYNCMODIFIED', type: 'I', size: 32 },
      { name: 'ISDIRTY', type: 'S', size: 1 },
    ]
  },
  {
    name: 'SWIMEVENT', cols: [
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'COMMENT', type: 'M', size: 0 },
      { name: 'DAYTIME', type: 'D', size: 32 },
      { name: 'DURATION', type: 'D', size: 32 },
      { name: 'ENTRYTIMECONVERSION', type: 'I', size: 16 },
      { name: 'ENTRYTIMEPERCENT', type: 'I', size: 16 },
      { name: 'EVENTNUMBER', type: 'I', size: 16 },
      { name: 'EXTERNALID', type: 'S', size: 40 },
      { name: 'FEE', type: 'F', size: 0 },
      { name: 'FINALORDER', type: 'I', size: 16 },
      { name: 'GENDER', type: 'I', size: 16 },
      { name: 'LANEMAX', type: 'I', size: 16 },
      { name: 'LYTENTRYLIST', type: 'I', size: 32 },
      { name: 'LYTSTARTLIST', type: 'I', size: 32 },
      { name: 'LYTRESULT2COLUMN', type: 'I', size: 32 },
      { name: 'LYTRESULT2SPLIT', type: 'I', size: 32 },
      { name: 'LYTRESULT4SPLIT', type: 'I', size: 32 },
      { name: 'LYTRESULTNOSPLIT', type: 'I', size: 32 },
      { name: 'LYTRESULTHTML', type: 'I', size: 32 },
      { name: 'MASTERS', type: 'S', size: 1 },
      { name: 'MAXENTRIES', type: 'I', size: 16 },
      { name: 'PFINEIGNORE', type: 'S', size: 1 },
      { name: 'PREVEVENTID', type: 'I', size: 32 },
      { name: 'QUALBYPLACE', type: 'I', size: 16 },
      { name: 'ROUND', type: 'I', size: 16 },
      { name: 'SEEDBONUSLAST', type: 'S', size: 1 },
      { name: 'SEEDEXHLAST', type: 'S', size: 1 },
      { name: 'SEEDLATEENTRYLAST', type: 'S', size: 1 },
      { name: 'SEEDINGGLOBAL', type: 'S', size: 1 },
      { name: 'SINGLEHEATS', type: 'I', size: 16 },
      { name: 'SORTCODE', type: 'I', size: 32 },
      { name: 'SPLASHMECANEDIT', type: 'S', size: 1 },
      { name: 'SPONSOR', type: 'S', size: 50 },
      { name: 'SWIMSESSIONID', type: 'I', size: 32 },
      { name: 'SWIMSTYLEID', type: 'I', size: 32 },
      { name: 'TWOPERLANE', type: 'S', size: 1 },
      { name: 'ROUNDNAME', type: 'S', size: 50 },
      { name: 'COMBINEAGEGROUPS', type: 'S', size: 1 },
      { name: 'ROUNDONE', type: 'S', size: 20 },
      { name: 'INTERNALEVENT', type: 'S', size: 1 },
      { name: 'SWIMEVENTGUID', type: 'G', size: 36, newGuid: true },
      { name: 'SYNCMODIFIED', type: 'I', size: 32 },
      { name: 'ISDIRTY', type: 'S', size: 1 },
      { name: 'STARTTIMEEFF', type: 'D', size: 32 },
      { name: 'OFFICIALAT', type: 'D', size: 32 },
      { name: 'REVISED', type: 'D', size: 32 },
    ]
  },
  {
    name: 'AGEGROUP', cols: [
      { name: 'AGEGROUPID', type: 'I', size: 32 },
      { name: 'AGEBYTOTAL', type: 'S', size: 1 },
      { name: 'AGEMAX', type: 'I', size: 16 },
      { name: 'AGEMAX2', type: 'I', size: 16 },
      { name: 'AGEMIN', type: 'I', size: 16 },
      { name: 'AGEMIN2', type: 'I', size: 16 },
      { name: 'ALLOFFICIAL', type: 'S', size: 1 },
      { name: 'ATHLETESTATUSES', type: 'I', size: 32 },
      { name: 'CLUBIDS', type: 'M', size: 0 },
      { name: 'CODE', type: 'S', size: 10 },
      { name: 'EXTERNALID', type: 'S', size: 40 },
      { name: 'FASTHEATCOUNT', type: 'I', size: 16 },
      { name: 'FORCEPRELIM', type: 'S', size: 1 },
      { name: 'GENDER', type: 'I', size: 16 },
      { name: 'HANDICAPS', type: 'S', size: 100 },
      { name: 'HEATCOUNT', type: 'I', size: 16 },
      { name: 'HEATQUALIPRIORITY', type: 'S', size: 50 },
      { name: 'LEVELMAX', type: 'S', size: 5 },
      { name: 'LEVELMIN', type: 'S', size: 5 },
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'NATIONALITY', type: 'S', size: 3 },
      { name: 'NATIONREGIONS', type: 'M', size: 0 },
      { name: 'RESULTCOUNT', type: 'I', size: 16 },
      { name: 'SCORETYPE', type: 'I', size: 16 },
      { name: 'SEEDWITHTSONLY', type: 'S', size: 1 },
      { name: 'SORTCODE', type: 'I', size: 32 },
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'SWIMLEVELS', type: 'S', size: 255 },
      { name: 'USEFORMEDALS', type: 'S', size: 1 },
      { name: 'USEFORSCORING', type: 'S', size: 1 },
      { name: 'WINNERTITLE', type: 'S', size: 100 },
      { name: 'FOREIGNCOUNT', type: 'I', size: 16 },
      { name: 'FINALSEEDTYPE', type: 'I', size: 16 },
      { name: 'AFINAL8LANES', type: 'S', size: 1 }, // real Splash column, found missing via full schema diff against a genuine Splash-native .smb export
      { name: 'AGEGROUPGUID', type: 'G', size: 36, newGuid: true },
      { name: 'SYNCMODIFIED', type: 'I', size: 32 },
      { name: 'ISDIRTY', type: 'S', size: 1 },
    ]
  },
  // Real column defs captured from a populated Splash mdb via GetSchema("Columns") —
  // we have no records-tracking feature, so these always export 0 rows (see `stub` comment above SMB_TABLES).
  {
    name: 'RECORDLIST', stub: true, cols: [
      { name: 'RECORDLISTID', type: 'I', size: 32 },
      { name: 'CODE', type: 'S', size: 20 },
      { name: 'LENEXCODE', type: 'S', size: 20 },
      { name: 'NAME', type: 'S', size: 100 },
      { name: 'SHORTNAME', type: 'S', size: 40 },
      { name: 'SPLASHMECODE', type: 'S', size: 10 },
      { name: 'NATIONREGION', type: 'S', size: 20 },
      { name: 'AGEGROUPS', type: 'S', size: 255 },
      { name: 'AGECACLTYPE', type: 'I', size: 16 },
      { name: 'UPDATEMODE', type: 'I', size: 16 },
      { name: 'SORTCODE', type: 'I', size: 32 },
    ]
  },
  {
    name: 'RECORDAGEGROUP', stub: true, cols: [
      { name: 'RECORDAGEGROUPID', type: 'I', size: 32 },
      { name: 'AGEMIN', type: 'I', size: 16 },
      { name: 'AGEMAX', type: 'I', size: 16 },
      { name: 'AGETYPE', type: 'I', size: 16 },
    ]
  },
  {
    name: 'RECORDLISTAGEGROUP', stub: true, cols: [
      { name: 'RECORDLISTID', type: 'I', size: 32 },
      { name: 'RECORDAGEGROUPID', type: 'I', size: 32 },
    ]
  },
  {
    name: 'RECORD', stub: true, cols: [
      { name: 'RECORDID', type: 'I', size: 32 },
      { name: 'RECORDLISTID', type: 'I', size: 32 },
      { name: 'RECORDAGEGROUPID', type: 'I', size: 32 },
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'SWIMSTYLEID', type: 'I', size: 32 },
      { name: 'RESULTID', type: 'I', size: 32 },
      { name: 'SWIMTIME', type: 'I', size: 32 },
      { name: 'COURSE', type: 'I', size: 16 },
      { name: 'GENDER', type: 'I', size: 16 },
      { name: 'AGEGROUP', type: 'I', size: 32 },
      { name: 'HANDICAP', type: 'I', size: 16 },
      { name: 'FIRSTNAME', type: 'S', size: 30 },
      { name: 'LASTNAME', type: 'S', size: 50 },
      { name: 'NAMEPREFIX', type: 'S', size: 20 },
      { name: 'BIRTHDATE', type: 'D', size: 32 },
      { name: 'CLUBCODE', type: 'S', size: 10 },
      { name: 'CLUBNAME', type: 'S', size: 80 },
      { name: 'CLUBNATION', type: 'S', size: 3 },
      { name: 'MEETNAME', type: 'S', size: 100 },
      { name: 'MEETCITY', type: 'S', size: 30 },
      { name: 'MEETNATION', type: 'S', size: 3 },
      { name: 'MEETDATE', type: 'D', size: 32 },
    ]
  },
  {
    name: 'RECORDSPLIT', stub: true, cols: [
      { name: 'RECORDID', type: 'I', size: 32 },
      { name: 'DISTANCE', type: 'I', size: 16 },
      { name: 'SWIMTIME', type: 'I', size: 32 },
    ]
  },
  {
    name: 'RECORDPOSITION', stub: true, cols: [
      { name: 'RECORDID', type: 'I', size: 32 },
      { name: 'RELAYNUMBER', type: 'I', size: 16 },
      { name: 'FIRSTNAME', type: 'S', size: 30 },
      { name: 'LASTNAME', type: 'S', size: 50 },
      { name: 'NAMEPREFIX', type: 'S', size: 20 },
      { name: 'GENDER', type: 'I', size: 16 },
      { name: 'BIRTHDATE', type: 'D', size: 32 },
    ]
  },
  {
    name: 'HEAT', cols: [
      { name: 'HEATID', type: 'I', size: 32 },
      { name: 'AGEGROUPID', type: 'I', size: 32 },
      { name: 'AGEGROUPORDER', type: 'I', size: 32 },
      { name: 'DAYTIME', type: 'D', size: 32 },
      { name: 'FINALCODE', type: 'S', size: 2 },
      { name: 'HEATNUMBER', type: 'I', size: 16 },
      { name: 'RACESTATUS', type: 'I', size: 16 },
      { name: 'REMARKS', type: 'M', size: 0 },
      { name: 'SORTCODE', type: 'I', size: 32 },
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'SEEDEVENTID', type: 'I', size: 32 },
      { name: 'CODE', type: 'S', size: 10 },
      { name: 'RESERVECOUNT', type: 'I', size: 16 },
      { name: 'FOREIGNCOUNT', type: 'I', size: 16 },
    ]
  },
  {
    name: 'SWIMRESULT', cols: [
      { name: 'SWIMRESULTID', type: 'I', size: 32 },
      { name: 'ATHLETEID', type: 'I', size: 32 },
      { name: 'SWRABESTID', type: 'I', size: 32 },
      { name: 'SWRABESTTIME', type: 'I', size: 32 },
      { name: 'SWRSBESTID', type: 'I', size: 32 },
      { name: 'SWRSBESTTIME', type: 'I', size: 32 },
      { name: 'AGEGROUPID', type: 'I', size: 32 },
      { name: 'BACKUPTIME1', type: 'I', size: 32 },
      { name: 'BACKUPTIME2', type: 'I', size: 32 },
      { name: 'BACKUPTIME3', type: 'I', size: 32 },
      { name: 'BONUSENTRY', type: 'S', size: 1 },
      { name: 'COMMENT', type: 'S', size: 250 },
      { name: 'DSQITEMID', type: 'I', size: 32 },
      { name: 'DSQDAYTIME', type: 'D', size: 32 },
      { name: 'DSQNOTIFIED', type: 'S', size: 1 },
      { name: 'DSQNUMBER', type: 'I', size: 16 },
      { name: 'ENTRYCOURSE', type: 'I', size: 16 },
      { name: 'ENTRYTIME', type: 'I', size: 32 },
      { name: 'FINALFIX', type: 'S', size: 1 },
      { name: 'FINISHJUDGE', type: 'I', size: 16 },
      { name: 'HEATID', type: 'I', size: 32 },
      { name: 'INFOCODE', type: 'S', size: 5 },
      { name: 'LANE', type: 'I', size: 16 },
      { name: 'LATEENTRY', type: 'S', size: 1 },
      { name: 'MPOINTS', type: 'I', size: 16 },
      { name: 'PADTIME', type: 'I', size: 32 },
      { name: 'QTCITY', type: 'S', size: 30 },
      { name: 'QTCOURSE', type: 'I', size: 16 },
      { name: 'QTDATE', type: 'D', size: 32 },
      { name: 'QTNAME', type: 'S', size: 100 },
      { name: 'QTNATION', type: 'S', size: 3 },
      { name: 'QTTIME', type: 'I', size: 32 },
      { name: 'QUALCODE', type: 'S', size: 2 },
      { name: 'REACTIONTIME', type: 'I', size: 16 },
      { name: 'RESULTSTATUS', type: 'I', size: 16 },
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'SWIMTIME', type: 'I', size: 32 },
      { name: 'USETIMETYPE', type: 'I', size: 16 },
      { name: 'DSQOFFICIALID', type: 'I', size: 32 },
      { name: 'RESERVECODE', type: 'S', size: 20 },
      { name: 'NOADVANCE', type: 'S', size: 1 },
      { name: 'OFFICIALSPLITS', type: 'S', size: 100 },
      { name: 'QTTIMING', type: 'I', size: 16 },
      { name: 'SWIMRESULTGUID', type: 'G', size: 36 },  // Splash leaves it all-zero
      { name: 'SYNCMODIFIED', type: 'I', size: 32 },
      { name: 'ISDIRTY', type: 'S', size: 1 },
    ]
  },
  {
    name: 'SPLIT', cols: [
      { name: 'SWIMRESULTID', type: 'I', size: 32 },
      { name: 'DISTANCE', type: 'I', size: 16 },
      { name: 'SWIMTIME', type: 'I', size: 32 },
    ]
  },
  {
    name: 'RELAY', cols: [
      { name: 'RELAYID', type: 'I', size: 32 },
      { name: 'AGEGROUPID', type: 'I', size: 32 },
      { name: 'AGEMAX', type: 'I', size: 16 },
      { name: 'AGEMIN', type: 'I', size: 16 },
      { name: 'AGETOTAL', type: 'I', size: 16 },
      { name: 'ATHLETES', type: 'I', size: 32 }, // real Splash ≥11.84174 uses I;32, not I;16
      { name: 'BACKUPTIME1', type: 'I', size: 32 },
      { name: 'BACKUPTIME2', type: 'I', size: 32 },
      { name: 'BACKUPTIME3', type: 'I', size: 32 },
      { name: 'BONUSENTRY', type: 'S', size: 1 },
      { name: 'CLUBID', type: 'I', size: 32 },
      { name: 'COMMENT', type: 'S', size: 250 },
      { name: 'DSQITEMID', type: 'I', size: 32 },
      { name: 'DSQDAYTIME', type: 'D', size: 32 },
      { name: 'DSQNOTIFIED', type: 'S', size: 1 },
      { name: 'DSQNUMBER', type: 'I', size: 16 },
      { name: 'DSQOFFICIALID', type: 'I', size: 32 },
      { name: 'ENTRYCOURSE', type: 'I', size: 16 },
      { name: 'ENTRYTIME', type: 'I', size: 32 },
      { name: 'FINALFIX', type: 'S', size: 1 },
      { name: 'FINISHJUDGE', type: 'I', size: 16 },
      { name: 'GENDER', type: 'I', size: 16 },
      { name: 'HEATID', type: 'I', size: 32 },
      { name: 'INFOCODE', type: 'S', size: 5 },
      { name: 'LANE', type: 'I', size: 16 },
      { name: 'LATEENTRY', type: 'S', size: 1 },
      { name: 'MPOINTS', type: 'I', size: 16 },
      { name: 'NAME', type: 'S', size: 100 },
      { name: 'NOADVANCE', type: 'S', size: 1 },
      { name: 'OFFICIALSPLITS', type: 'S', size: 100 },
      { name: 'PADTIME', type: 'I', size: 32 },
      { name: 'QTCITY', type: 'S', size: 30 },
      { name: 'QTCOURSE', type: 'I', size: 16 },
      { name: 'QTDATE', type: 'D', size: 32 },
      { name: 'QTNAME', type: 'S', size: 100 },
      { name: 'QTNATION', type: 'S', size: 3 },
      { name: 'QTTIME', type: 'I', size: 32 },
      { name: 'QTTIMING', type: 'I', size: 16 },
      { name: 'QUALCODE', type: 'S', size: 2 },
      { name: 'REACTIONTIME', type: 'I', size: 16 },
      { name: 'RELAYCODE', type: 'I', size: 32 }, // real Splash ≥11.84174 uses I;32, not I;16
      { name: 'RESERVECODE', type: 'S', size: 20 },
      { name: 'RESULTSTATUS', type: 'I', size: 16 },
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'SWIMTIME', type: 'I', size: 32 },
      { name: 'TEAMNUMBER', type: 'I', size: 16 },
      { name: 'USETIMETYPE', type: 'I', size: 16 },
      { name: 'RELAYGUID', type: 'G', size: 36, newGuid: true },
      { name: 'SYNCMODIFIED', type: 'I', size: 32 },
      { name: 'ISDIRTY', type: 'S', size: 1 },
    ]
  },
  {
    name: 'RELAYSPLIT', cols: [
      { name: 'RELAYID', type: 'I', size: 32 },
      { name: 'DISTANCE', type: 'I', size: 16 },
      { name: 'SWIMTIME', type: 'I', size: 32 },
    ]
  },
  {
    name: 'RELAYPOSITION', cols: [
      { name: 'RELAYID', type: 'I', size: 32 },
      { name: 'ATHLETEID', type: 'I', size: 32 },
      { name: 'QTCITY', type: 'S', size: 30 },
      { name: 'QTCOURSE', type: 'I', size: 16 },
      { name: 'QTDATE', type: 'D', size: 32 },
      { name: 'QTISLAP', type: 'S', size: 1 },
      { name: 'QTNAME', type: 'S', size: 100 },
      { name: 'QTNATION', type: 'S', size: 3 },
      { name: 'QTTIME', type: 'I', size: 32 },
      { name: 'QTTIMING', type: 'I', size: 16 },
      { name: 'REACTIONTIME', type: 'I', size: 16 },
      { name: 'RELAYNUMBER', type: 'I', size: 16 },
      { name: 'RESULTSTATUS', type: 'I', size: 16 },
    ]
  },
]

// ── GBIN encoding ─────────────────────────────────────────────────────────────

export function encodeGbin(tableDef: { name: string; cols: ColDef[] }, rows: Record<string, unknown>[]): Buffer {
  // Header
  const headerStr = tableDef.cols.map(c => `${c.name};${c.type};${c.size}`).join('\t')
  const headerBuf = Buffer.from(headerStr, 'ascii')
  const headerLenBuf = Buffer.alloc(2)
  headerLenBuf.writeUInt16LE(headerBuf.length)

  // Body — records packed contiguously (no separator)
  const chunks: Buffer[] = []
  for (const row of rows) {
    for (const col of tableDef.cols) {
      const val = row[col.name.toLowerCase()]

      if (col.type === 'I') {
        let numVal = val != null ? Number(val) : 0
        let isNull = val == null
        // Treat Splash "no time" sentinel (max int32) as null
        if (col.size > 16 && numVal === 2147483647) {
          numVal = 0
          isNull = true
        }
        if (col.size <= 16) {
          const b = Buffer.alloc(2)
          b.writeInt16LE(numVal)
          chunks.push(b)
        } else {
          const b = Buffer.alloc(4)
          b.writeInt32LE(numVal)
          chunks.push(b)
        }
        // Null disambiguation flag when value is 0
        if (numVal === 0) {
          chunks.push(Buffer.from([isNull ? 0x01 : 0x00]))
        }
      } else if (col.type === 'S') {
        const strVal = val != null ? String(val) : ''
        // `col.size` for S columns is a max *character* count (Splash's Access/Jet Text field
        // width — see docs/GBIN_FORMAT.md, "informational only" re: the wire encoding, but it's
        // what Splash enforces on restore). Truncate by character/codepoint, not UTF-8 byte
        // length: French text is full of accented multi-byte characters, so byte-length
        // truncation clamps well before the real 250-char limit is hit (e.g. a 247-char DSQ
        // description is 261 bytes) and can slice a multi-byte sequence in half, corrupting
        // the trailing character.
        let chars = Array.from(strVal)
        if (chars.length > col.size) {
          console.warn(
            `[smb] ${tableDef.name}.${col.name} value exceeds declared size ${col.size} ` +
            `(got ${chars.length} characters) — truncating: ${JSON.stringify(strVal)}`
          )
          chars = chars.slice(0, col.size)
        }
        const strBuf = Buffer.from(chars.join(''), 'utf8')
        const lenBuf = Buffer.alloc(2)
        lenBuf.writeUInt16LE(strBuf.length)
        chunks.push(lenBuf)
        if (strBuf.length > 0) chunks.push(strBuf)
      } else if (col.type === 'D') {
        let dblVal: number
        if (val == null) {
          dblVal = D_NULL_SENTINEL
        } else if (typeof val === 'number') {
          dblVal = val
        } else {
          // Could be an ISO date string (from syncDown) or a stringified OLE double
          const str = String(val).trim()
          const asNum = parseFloat(str)
          if (!isNaN(asNum) && !/^\d{4}-/.test(str)) {
            // Looks like a plain number (OLE double as text)
            dblVal = asNum
          } else {
            // Try parsing as ISO date → convert to OLE double
            const dt = new Date(str)
            if (!isNaN(dt.getTime())) {
              dblVal = (dt.getTime() - OLE_EPOCH_MS) / 86400000
            } else {
              dblVal = D_NULL_SENTINEL
            }
          }
        }
        const b = Buffer.alloc(8)
        b.writeDoubleLE(dblVal)
        chunks.push(b)
        // Null disambiguation flag when value is the sentinel
        if (dblVal === D_NULL_SENTINEL || dblVal === 0) {
          chunks.push(Buffer.from([val == null ? 0x01 : 0x00]))
        }
      } else if (col.type === 'F') {
        const dblVal = val != null ? Number(val) : 0
        const b = Buffer.alloc(8)
        b.writeDoubleLE(dblVal)
        chunks.push(b)
        // Null disambiguation flag when value is 0
        if (dblVal === 0) {
          chunks.push(Buffer.from([val == null ? 0x01 : 0x00]))
        }
      } else if (col.type === 'M') {
        const strVal = val != null ? String(val) : ''
        const strBuf = Buffer.from(strVal, 'utf8')
        const lenBuf = Buffer.alloc(4)
        lenBuf.writeUInt32LE(strBuf.length)
        chunks.push(lenBuf)
        if (strBuf.length > 0) chunks.push(strBuf)
      } else if (col.type === 'G') {
        chunks.push(guidToBytes(val))
      }
    }
  }

  return Buffer.concat([headerLenBuf, headerBuf, ...chunks])
}

// ── Null sentinel constants ────────────────────────────────────────────────────

export const D_NULL_SENTINEL = -36522.0 // OLE date for 1800-01-01 00:00:00

/** OLE date (wall-clock days since 1899-12-30) → 'YYYY-MM-DD HH:MM:SS.mmm' for a Postgres timestamp */
export function oleToPgTimestamp(ole: number): string {
  return new Date(OLE_EPOCH_MS + Math.round(ole * 86400000)).toISOString().replace('T', ' ').replace('Z', '')
}

/** OLE Automation epoch: 1899-12-30 in milliseconds since Unix epoch */
const OLE_EPOCH_MS = Date.UTC(1899, 11, 30)

// ── GUID (type G) ─────────────────────────────────────────────────────────────
// 16 raw bytes in Windows GUID layout: the first three groups little-endian, the
// last two as-is (.NET Guid.ToByteArray / Python uuid bytes_le). No null flag —
// Splash writes an all-zero GUID for "none" (e.g. every SWIMRESULTGUID).

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function guidToBytes(val: unknown): Buffer {
  const b = Buffer.alloc(16)
  const s = val == null ? '' : String(val).trim()
  if (!GUID_RE.test(s)) return b
  const hex = Buffer.from(s.replace(/-/g, ''), 'hex')
  hex.subarray(0, 4).reverse().copy(b, 0)
  hex.subarray(4, 6).reverse().copy(b, 4)
  hex.subarray(6, 8).reverse().copy(b, 6)
  hex.copy(b, 8, 8, 16)
  return b
}

export function bytesToGuid(b: Buffer): string | null {
  if (b.every(x => x === 0)) return null
  const h = (start: number, end: number, le: boolean): string => {
    const part = Buffer.from(b.subarray(start, end))
    return (le ? part.reverse() : part).toString('hex')
  }
  return `${h(0, 4, true)}-${h(4, 6, true)}-${h(6, 8, true)}-${h(8, 10, false)}-${h(10, 16, false)}`
}

// ── GBIN decoding ─────────────────────────────────────────────────────────────

export function decodeGbin(data: Buffer): { cols: ColDef[]; rows: Record<string, unknown>[] } {
  const headerLen = data.readUInt16LE(0)
  const headerStr = data.subarray(2, 2 + headerLen).toString('ascii')
  const cols: ColDef[] = headerStr.split('\t').map(c => {
    const [name, type, size] = c.split(';')
    return { name, type: type as ColDef['type'], size: parseInt(size, 10) }
  })

  const rows: Record<string, unknown>[] = []
  let offset = 2 + headerLen

  while (offset < data.length) {
    const row: Record<string, unknown> = {}
    let valid = true
    for (const col of cols) {
      if (offset >= data.length) { valid = false; break }
      const key = col.name.toLowerCase()

      if (col.type === 'I') {
        const bytes = col.size <= 16 ? 2 : 4
        const val = bytes === 2 ? data.readInt16LE(offset) : data.readInt32LE(offset)
        offset += bytes
        if (val === 0 && offset < data.length) {
          const flag = data[offset]
          if (flag === 0x00 || flag === 0x01) {
            offset += 1
            row[key] = flag === 0x01 ? null : val
          } else {
            row[key] = val
          }
        } else if (bytes === 4 && val === 2147483647) {
          // Splash "no time" sentinel (max int32) → treat as null
          row[key] = null
        } else {
          row[key] = val
        }
      } else if (col.type === 'S') {
        const slen = data.readUInt16LE(offset)
        offset += 2
        row[key] = slen > 0 ? data.subarray(offset, offset + slen).toString('utf8') : null
        offset += slen
      } else if (col.type === 'D') {
        const dbl = data.readDoubleLE(offset)
        offset += 8
        if (dbl === D_NULL_SENTINEL || dbl === 0) {
          if (offset < data.length) {
            const flag = data[offset]
            if (flag === 0x00 || flag === 0x01) {
              offset += 1
              row[key] = flag === 0x01 ? null : dbl
            } else {
              row[key] = dbl === 0 ? null : dbl
            }
          } else {
            row[key] = dbl === 0 ? null : dbl
          }
        } else {
          row[key] = dbl
        }
      } else if (col.type === 'F') {
        const dbl = data.readDoubleLE(offset)
        offset += 8
        if (dbl === 0) {
          if (offset < data.length) {
            const flag = data[offset]
            if (flag === 0x00 || flag === 0x01) {
              offset += 1
              row[key] = flag === 0x01 ? null : dbl
            } else {
              row[key] = null
            }
          } else {
            row[key] = null
          }
        } else {
          row[key] = dbl
        }
      } else if (col.type === 'M') {
        const mlen = data.readUInt32LE(offset)
        offset += 4
        row[key] = mlen > 0 ? data.subarray(offset, offset + mlen).toString('utf8') : null
        offset += mlen
      } else if (col.type === 'G') {
        row[key] = bytesToGuid(data.subarray(offset, offset + 16))
        offset += 16
      } else {
        // An unknown type has an unknown width: every later field would be misread
        throw new Error(`Unsupported gbin column type '${col.type}' (${col.name})`)
      }
    }
    if (!valid) break
    rows.push(row)
  }

  return { cols, rows }
}

// ── ZIP helpers (minimal PKZIP write) ─────────────────────────────────────────

export interface ZipEntry { name: string; data: Buffer }

export function createZip(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = []
  const centralHeaders: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data)
    const nameBytes = Buffer.from(entry.name, 'ascii')

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0) // signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(8, 8) // compression: deflate
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0, 12) // mod date
    local.writeUInt32LE(crc32(entry.data), 14) // crc32
    local.writeUInt32LE(compressed.length, 18) // compressed size
    local.writeUInt32LE(entry.data.length, 22) // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26) // filename length
    local.writeUInt16LE(0, 28) // extra field length
    nameBytes.copy(local, 30)

    localHeaders.push(local)
    localHeaders.push(compressed)

    // Central directory header
    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(8, 10) // compression
    central.writeUInt16LE(0, 12) // mod time
    central.writeUInt16LE(0, 14) // mod date
    central.writeUInt32LE(crc32(entry.data), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    nameBytes.copy(central, 46)
    centralHeaders.push(central)

    offset += local.length + compressed.length
  }

  const centralDirOffset = offset
  const centralDir = Buffer.concat(centralHeaders)

  // End of central directory
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // disk with central dir
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(centralDirOffset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localHeaders, centralDir, eocd])
}

export function readZipEntries(filePath: string): Map<string, Buffer> {
  const buf = readFileSync(filePath)
  const entries = new Map<string, Buffer>()
  let offset = 0

  while (offset < buf.length - 4) {
    const sig = buf.readUInt32LE(offset)
    if (sig !== 0x04034b50) break // not a local file header

    const method = buf.readUInt16LE(offset + 8)
    const compressedSize = buf.readUInt32LE(offset + 18)
    const fileNameLen = buf.readUInt16LE(offset + 26)
    const extraLen = buf.readUInt16LE(offset + 28)
    const fileName = buf.subarray(offset + 30, offset + 30 + fileNameLen).toString('ascii')
    const dataStart = offset + 30 + fileNameLen + extraLen
    const compressed = buf.subarray(dataStart, dataStart + compressedSize)

    let content: Buffer
    if (method === 0) content = compressed
    else if (method === 8) content = inflateRawSync(compressed)
    else { offset = dataStart + compressedSize; continue }

    entries.set(fileName, content)
    offset = dataStart + compressedSize
  }

  return entries
}

// ── CRC32 ─────────────────────────────────────────────────────────────────────

const crcTable: number[] = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c
}

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ── Public API ────────────────────────────────────────────────────────────────

// Splash build our .smb files identify as (geologix.ini) — see GBIN_FORMAT.md version history
export const SPLASH_BACKUP_VERSION = '11.85709'
export const SPLASH_DDL_VERSION_APPLICATION = '20260901'

/**
 * Database file name Splash restores the backup into ([ExtraInfo] DBFilename) — Splash
 * names it after the meet's own .mdb; ours follows the meet name so successive restores
 * of different meets don't all overwrite one meet.mdb. ASCII only (geologix.ini is written
 * as ASCII): accents stripped, characters Windows forbids in file names removed.
 */
export function mdbFilenameFor(meetName: string | null | undefined): string {
  const base = (meetName ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/, '')
  return `${base || 'meet'}.mdb`
}

export function saveSMB(filePath: string, db: DbBackend): { tables: number; rows: number } {
  const entries: ZipEntry[] = []
  const recordCounts: Record<string, number> = {}
  let totalRows = 0

  for (const tableDef of SMB_TABLES) {
    const tableName = tableDef.name.toLowerCase()
    const dbCols = tableDef.cols.filter(c => !c.synthetic)
    const syntheticCols = tableDef.cols.filter(c => c.synthetic)
    const colNames = dbCols.map(c => c.name.toLowerCase()).join(', ')
    // stub tables have no backing table in our schema — always export empty (see comment above SMB_TABLES)
    let rows = tableDef.stub ? [] : db.prepare(`SELECT ${colNames} FROM ${tableName}`).all() as Record<string, unknown>[]

    // Sync GUIDs: keep the stored one (Splash's own, from a restore or a shared Postgres
    // database), mint one for rows meet-app created itself. Not written back — export is read-only.
    const guidCols = tableDef.cols.filter(c => c.newGuid).map(c => c.name.toLowerCase())
    if (guidCols.length > 0) {
      rows = rows.map(row => {
        const extra: Record<string, unknown> = {}
        for (const c of guidCols) if (!row[c]) extra[c] = randomUUID()
        return { ...row, ...extra }
      })
    }

    // Synthetic columns have no backing DB column — generate a fresh value per row at export time.
    if (syntheticCols.length > 0) {
      rows = rows.map(row => {
        const extra: Record<string, unknown> = {}
        for (const c of syntheticCols) extra[c.name.toLowerCase()] = randomUUID()
        return { ...row, ...extra }
      })
    }

    // RECORDAGEGROUP is the one stub table real Splash always populates even with zero configured
    // records: every real, populated Splash database sampled had exactly one row
    // {recordagegroupid:0, agemax:-1, agemin:-1, agetype:0} — a default/no-restriction sentinel
    // entry, not just "table present but genuinely empty" like the other five RECORD* stubs.
    if (tableName === 'recordagegroup') {
      rows = [{ recordagegroupid: 0, agemax: -1, agemin: -1, agetype: 0 }]
    }

    // swimevent.round / preveventid and agegroup.agemin/agemax are stored in Splash's own
    // encoding (rounds.ts, NO_PREV_EVENT / NO_AGE_LIMIT in db.ts) — exported as they are.

    // dsqitem.options (Splash's own code, dsqCodes.ts) and heat.agegroupid (fillHeatAgeGroups)
    // are stored the way Splash stores them — exported as they are.

    if (tableName === 'bsglobal') {
      // Splash stamps every genuine Meet Manager database with BSAPPLICATION="Meet Manager - MEET"
      // in BSGLOBAL — confirmed present in every real Splash-native .mdb sampled, and absent from
      // every .mdb that had one of our own .smb backups restored into it (we never wrote this key).
      // Splash appears to validate it on file open: those restored files opened and worked fine in
      // the same session as the restore, but threw a generic "invalid data" error the next time
      // Splash was reopened against the same file. Always ensure it's present on export.
      if (!rows.some(r => r['name'] === 'BSAPPLICATION')) {
        rows = [...rows, { name: 'BSAPPLICATION', data: 'Meet Manager - MEET' }]
      }
      // A beach meet's COURSE=7 is stored as such (setBeachCourse, db.ts) — exported as is.
    }

    recordCounts[tableDef.name] = rows.length
    totalRows += rows.length

    const gbin = encodeGbin(tableDef, rows)
    entries.push({ name: `${tableDef.name}-0001.gbin`, data: gbin })
  }

  // Generate geologix.ini (matching Splash Meet Manager 11 format)
  // Read DDL versions from BSGLOBAL if available
  const bsgRows = db.prepare(`SELECT name, data FROM bsglobal WHERE name LIKE 'BSDB_DDL_VERSION%'`).all() as Array<{ name: string; data: string | null }>
  const ddlVersions: Record<string, string> = {}
  for (const r of bsgRows) {
    ddlVersions[r.name] = r.data ?? ''
  }

  // All tables Splash expects in the ini (even if we don't export them all)
  const allTableNames = [
    'BSGLOBAL', 'BSSWKATALOGITEM', 'BSPICTURE', 'DSQITEM',
    'SWIMSTYLE', 'SWIMSESSION', 'SWIMEVENT', 'AGEGROUP',
    'RECORDLIST', 'RECORDAGEGROUP', 'RECORDLISTAGEGROUP',
    'RECORD', 'RECORDSPLIT', 'RECORDPOSITION',
    'TIMESTANDARDLIST', 'TIMESTANDARD',
    'CLUB', 'ATHLETE', 'OFFICIAL', 'EVENTRECORD',
    'HEAT', 'JUDGE', 'SWIMRESULT', 'SPLIT',
    'RELAY', 'RELAYPOSITION', 'RELAYSPLIT',
    'RESULTPLACE', 'TIMINGDATA', 'SPLASHMEMESSAGE',
  ]

  // Version/GUID/[ExtraInfo] match the real installed Splash build's own .smb export
  // (Meet Manager 11.85709, compared 2026-11-20 against a genuine Splash re-export;
  // previously 11.84754). None of these were found to block a restore, but matching
  // them keeps our file closer to what a real Splash install would produce.
  // The application DDL version is never written below 20260901: that's the schema the
  // G-typed GUID columns above belong to, even if our bsglobal carries an older value.
  const ddlApp = [ddlVersions['BSDB_DDL_VERSION_APPLICATION'] ?? '', SPLASH_DDL_VERSION_APPLICATION].sort().pop()!
  const meetNameRow = db.prepare(`SELECT data FROM bsglobal WHERE name = 'MeetName'`).get() as { data: string | null } | undefined
  const ini = [
    '[Geologix]',
    'Application=Meet Manager 11',
    `Version=${SPLASH_BACKUP_VERSION}`,
    'Identification=BACKUP_MM_MEET_11',
    `GUID=${randomUUID()}`,
    'NullDateYear=1800',
    'ExtraFiles=0',
    '',
    '[BSGLOBAL]',
    `BSDB_DDL_VERSION_APPLICATION=${ddlApp}`,
    `BSDB_DDL_VERSION_PICTURE=${ddlVersions['BSDB_DDL_VERSION_PICTURE'] ?? '01.01'}`,
    `BSDB_DDL_VERSION_SW_KATALOG=${ddlVersions['BSDB_DDL_VERSION_SW_KATALOG'] ?? '01.00'}`,
    '',
    '[RecordCount]',
    ...allTableNames.map(t => `${t}=${recordCounts[t] ?? 0}`),
    '',
    '[Tables]',
    ...allTableNames.map(t => `${t}=${(recordCounts[t] ?? 0) > 0 ? 1 : 0}`),
    '',
    '[ExtraInfo]',
    `DBFilename=${mdbFilenameFor(meetNameRow?.data)}`,
    '',
  ].join('\r\n')

  // Real Splash writes geologix.ini with a UTF-8 BOM; match that for closer fidelity.
  entries.push({ name: 'geologix.ini', data: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(ini, 'ascii')]) })

  const zip = createZip(entries)
  writeFileSync(filePath, zip)

  return { tables: SMB_TABLES.length, rows: totalRows }
}

export function restoreSMB(filePath: string, db: DbBackend): { tables: number; rows: number; detail: string } {
  const zipEntries = readZipEntries(filePath)
  const tableDetail: string[] = []
  let totalInserted = 0

  // Disable FK enforcement for bulk import — Splash encodes NULL integers as 0
  // which would fail FK checks mid-load even though the data is self-consistent.
  db.disableForeignKeys()
  try {
    // Clear existing data (reverse FK order). Skip stub tables — no backing table in our schema.
    const reversed = [...SMB_TABLES].reverse()
    for (const tableDef of reversed) {
      if (tableDef.stub) continue
      db.prepare(`DELETE FROM ${tableDef.name.toLowerCase()}`).run()
    }

    // Import each table
    for (const tableDef of SMB_TABLES) {
      if (tableDef.stub) {
        tableDetail.push(`${tableDef.name}: skipped (no local table)`)
        continue
      }
      const fileName = `${tableDef.name}-0001.gbin`
      const gbinData = zipEntries.get(fileName)
      if (!gbinData) {
        tableDetail.push(`${tableDef.name}: not found in backup`)
        continue
      }

      const { cols: fileCols, rows } = decodeGbin(gbinData)
      if (rows.length === 0) {
        tableDetail.push(`${tableDef.name}: 0 rows`)
        continue
      }

      // Use intersection of file columns and our expected columns for INSERT.
      // ON CONFLICT DO NOTHING is portable — SQLite (3.24+, bundled by better-sqlite3)
      // and Postgres both support the bare (no conflict target) form.
      // Synthetic columns (e.g. Splash's own per-row sync GUIDs) have no backing DB column on
      // our side — never insert them, whether this file came from us or genuine Splash.
      const fileColNames = new Set(fileCols.map(c => c.name.toLowerCase()))
      const colNames = tableDef.cols.filter(c => !c.synthetic).map(c => c.name.toLowerCase()).filter(c => fileColNames.has(c))
      const placeholders = colNames.map(() => '?').join(', ')
      const insertSql = `INSERT INTO ${tableDef.name.toLowerCase()} (${colNames.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`
      const stmt = db.prepare(insertSql)

      let inserted = 0
      // PG's TIMESTAMP columns are stricter than SQLite's untyped date storage — identify
      // date columns that need OLE-sentinel filtering before insert (SQLite tolerates any value).
      const dateColIndices = new Set<number>()
      if (db.type === 'pg') {
        const colDefsLower = tableDef.cols.map(c => ({ name: c.name.toLowerCase(), type: c.type }))
        colNames.forEach((cn, idx) => {
          const def = colDefsLower.find(d => d.name === cn)
          if (def && def.type === 'D') dateColIndices.add(idx)
        })
      }

      const insertAll = db.transaction((recs: Record<string, unknown>[]) => {
        for (const row of recs) {
          const vals = colNames.map((c, idx) => {
            const v = row[c] ?? null
            // PG date columns are Splash's `timestamp`: an OLE date (days since 1899-12-30) goes
            // in as a timestamp, not as the raw number. Valid OLE dates are roughly 2-73000
            // (1900-2100); anything else (sentinels, garbage) is NULL.
            if (dateColIndices.has(idx)) {
              if (v === null || v === undefined) return null
              const numVal = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : NaN)
              if (isNaN(numVal) || numVal < 2 || numVal > 73000 || !isFinite(numVal)) return null
              return oleToPgTimestamp(numVal)
            }
            return v
          })
          inserted += stmt.run(...vals).changes
        }
      })

      insertAll(rows)
      tableDetail.push(`${tableDef.name}: ${inserted}/${rows.length}`)
      totalInserted += inserted
    }

    // ── Post-import normalization: Splash time sentinel → NULL ──
    // Splash uses 2147483647 (0x7FFFFFFF, max int32) as "no time" for time fields.
    // This is an application-level convention, not a GBIN null sentinel (which is 0).
    // Normalize these to NULL so msToDisplay() returns undefined → "NT".
    db.prepare(`UPDATE swimresult SET entrytime = NULL WHERE entrytime >= 2147483647`).run()
    db.prepare(`UPDATE swimresult SET swimtime = NULL WHERE swimtime >= 2147483647`).run()

    // ── Post-import: Splash event data repairs (breaks, prelim gender/number) ──
    normalizeRoundEncoding(db)

    // heat.racestatus: Splash writes 2 for "seeded, not yet official" — meet-app stores the same
    // 2 since 2026-11 (HEAT_SEEDED, db.ts), so restored heats are kept as they are.
  } finally {
    db.enableForeignKeys()
  }

  return { tables: SMB_TABLES.length, rows: totalInserted, detail: tableDetail.join(', ') }
}

// ── Splash event data repairs on restore ──────────────────────────────────────
//
// swimevent.round is stored in Splash's own codes (rounds.ts) — no remapping. What's left:
// - round 11 (Break) → internalevent='T', the flag meet-app uses for breaks
// - prelims with gender 0 / event number 0 (see below)

function normalizeRoundEncoding(db: DbBackend): void {
  const hasEvents = db.prepare(
    `SELECT COUNT(*) AS c FROM swimevent WHERE round IS NOT NULL`
  ).get() as { c: number }

  if (hasEvents.c === 0) return

  db.prepare(`UPDATE swimevent SET internalevent = 'T' WHERE round = ${ROUND.BREAK}`).run()

  // Fix PRE events that have gender=0 and/or eventnumber=0.
  // In Splash MDB, prelim events store gender=0 and eventnumber=0 because
  // the display values are derived from the paired Timed Final event.
  // The TIM event always immediately precedes its PRE event (sortcode - 1).
  // Fallback: use the FIN event that references this PRE via preveventid.
  //
  // gender=0 is also our own encoding for "ALL" (unrestricted) — that doesn't create a
  // conflict here: when the paired TIM/FIN is itself genuinely ALL (gender=0), the
  // `!== 0` guards below skip the backfill and leave this PRE row at its already-0
  // value, which is the correct outcome either way (still-unresolved-placeholder and
  // genuinely-ALL both resolve to 0). Nothing here ever needs to distinguish the two.
  const preEvents = db.prepare(`
    SELECT e.swimeventid, e.swimsessionid, e.swimstyleid, e.eventnumber, e.gender, e.sortcode
    FROM swimevent e
    WHERE e.round = ${ROUND.PRE} AND e.gender = 0 AND e.swimstyleid IS NOT NULL
  `).all() as Array<{
    swimeventid: number; swimsessionid: number; swimstyleid: number
    eventnumber: number; gender: number; sortcode: number
  }>

  for (const pre of preEvents) {
    // Strategy 1: paired TIM event at sortcode - 1 (same session, same swimstyle)
    let gender: number | null = null
    const timEvent = db.prepare(`
      SELECT gender FROM swimevent
      WHERE swimsessionid = ? AND swimstyleid = ? AND round = ${ROUND.TIM} AND sortcode = ?
      LIMIT 1
    `).get(pre.swimsessionid, pre.swimstyleid, pre.sortcode - 1) as { gender: number } | undefined

    if (timEvent && timEvent.gender !== 0) {
      gender = timEvent.gender
    }

    // Strategy 2: FIN event that references this PRE via preveventid
    if (!gender) {
      const finEvent = db.prepare(`
        SELECT gender FROM swimevent WHERE preveventid = ? AND round = ${ROUND.FIN} LIMIT 1
      `).get(pre.swimeventid) as { gender: number } | undefined
      if (finEvent && finEvent.gender !== 0) {
        gender = finEvent.gender
      }
    }

    if (gender) {
      db.prepare(`UPDATE swimevent SET gender = ? WHERE swimeventid = ?`).run(gender, pre.swimeventid)
    }
  }

  // Fix PRE events with eventnumber=0.
  // Splash auto-assigns sequential numbers (1, 2, 3...) to prelim events that
  // have eventnumber=0 in the MDB. We replicate this by numbering them in
  // session-number + sortcode order.
  const zeroNumPrelims = db.prepare(`
    SELECT e.swimeventid, e.sortcode, s.sessionnumber
    FROM swimevent e
    JOIN swimsession s ON s.swimsessionid = e.swimsessionid
    WHERE e.round = ${ROUND.PRE} AND (e.eventnumber = 0 OR e.eventnumber IS NULL)
      AND e.swimstyleid IS NOT NULL
    ORDER BY s.sessionnumber, e.sortcode
  `).all() as Array<{ swimeventid: number; sortcode: number; sessionnumber: number }>

  if (zeroNumPrelims.length > 0) {
    const updateNum = db.prepare(`UPDATE swimevent SET eventnumber = ? WHERE swimeventid = ?`)
    let seq = 1
    for (const pre of zeroNumPrelims) {
      updateNum.run(seq, pre.swimeventid)
      seq++
    }
  }
}