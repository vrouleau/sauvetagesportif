# GBIN Binary Format Specification

## Overview

The GBIN format is the binary serialization used inside Splash Meet Manager `.smb` backup files. An `.smb` file is a standard ZIP archive containing:

- `geologix.ini` — metadata (app version, record counts, meet GUID)
- `TABLENAME-0001.gbin` — one file per database table with binary-encoded rows

This document describes the GBIN binary encoding as reverse-engineered from Splash Meet Manager 11.x backups.

---

## File Structure

```
┌─────────────────────────────┐
│ Header Length (2 bytes, LE)  │
├─────────────────────────────┤
│ Header (ASCII string)       │
├─────────────────────────────┤
│ Record 1                    │
│ Record 2                    │
│ ...                         │
│ Record N                    │
└─────────────────────────────┘
```

### Header

- **Header Length**: uint16 LE — byte length of the header string
- **Header String**: ASCII, tab-separated column definitions in the format `COLNAME;TYPE;SIZE`

Example:
```
SWIMSTYLEID;I;32\tCODE;S;10\tDISTANCE;I;16\tNAME;S;50
```

### Records

Records are packed **contiguously** — there are no separator bytes between records. Each record contains fields in the exact order defined by the header.

---

## Column Types

| Type | Size Field | Binary Encoding | Byte Size |
|------|-----------|-----------------|-----------|
| `I;16` | 16 | Signed int16, little-endian | 2 bytes + optional null flag |
| `I;32` | 32 | Signed int32, little-endian | 4 bytes + optional null flag |
| `S;N` | N (max chars) | uint16 LE length + UTF-8 content | 2 + len bytes |
| `D;32` | 32 | IEEE 754 double, little-endian (OLE Automation date) | 8 bytes + optional null flag |
| `F;0` | 0 | IEEE 754 double, little-endian (float/currency) | 8 bytes + optional null flag |
| `M;0` | 0 | uint32 LE length + UTF-8 content (memo/large text) | 4 + len bytes |

### Integer Fields (`I;16`, `I;32`)

Standard little-endian integers.

```
I;16: [low_byte] [high_byte]          → int16 LE
I;32: [b0] [b1] [b2] [b3]            → int32 LE
```

### String Fields (`S;N`)

Variable-length UTF-8 string with a 2-byte length prefix.

```
[len_low] [len_high] [utf8_bytes...]
```

- `N` in the header indicates the maximum character count (informational only)
- Length of 0 means **null** (not empty string — Splash treats them identically)
- No null disambiguation flag is needed

### Date Fields (`D;32`)

8-byte IEEE 754 double representing an OLE Automation date (days since 1899-12-30 00:00:00). Negative values represent dates before the epoch.

```
[8 bytes double LE]    → OLE date value
```

- Dates in year 1800 (e.g., `-36522.45`) are used as **time-only containers** — the date portion (1800-01-01) is meaningless, only the fractional part (time) matters.
- The null sentinel is `-36522.0` exactly (1800-01-01 00:00:00 midnight).

### Float Fields (`F;0`)

8-byte IEEE 754 double for currency/decimal values.

```
[8 bytes double LE]    → floating point value
```

- The null sentinel is `0.0` (all zero bytes).

### Memo Fields (`M;0`)

Variable-length UTF-8 string with a 4-byte length prefix (for large text content like XML, remarks, etc.).

```
[len_b0] [len_b1] [len_b2] [len_b3] [utf8_bytes...]
```

- Length of 0 means **null**
- No null disambiguation flag is needed

---

## Null Disambiguation Flag

This is the key mechanism that makes the format self-describing without a null bitmap.

### The Problem

For numeric types (I, D, F), the null value must be stored as some sentinel since the field always occupies its fixed byte size. But what if the sentinel value is also a valid data value? For example:
- An integer field with value `0` vs. a null integer
- A fee field with value `$0.00` vs. a null fee
- A date field representing midnight (OLE = -36522.0) vs. a null date

### The Solution

**When a numeric field's stored value equals its null sentinel, a 1-byte disambiguation flag immediately follows the value bytes:**

| Flag | Meaning |
|------|---------|
| `0x00` | The preceding value is **real** (not null) |
| `0x01` | The preceding value is **null** (ignore it) |

**The flag byte is ONLY present when the stored value matches the sentinel.** Non-sentinel values never have a trailing flag.

### Null Sentinels by Type

| Type | Null Sentinel | Bytes |
|------|--------------|-------|
| `I;16` | `0` | `00 00` |
| `I;32` | `0` | `00 00 00 00` |
| `D;32` | `-36522.0` | `00 00 00 00 40 D5 E1 C0` |
| `F;0` | `0.0` | `00 00 00 00 00 00 00 00` |

### Examples

**Integer field with value 5 (not null):**
```
05 00                          ← value 5, no flag (5 ≠ 0)
```

**Integer field with value 0 (real zero, not null):**
```
00 00 00                       ← value 0 + flag 0x00 (real value)
```

**Integer field that is NULL:**
```
00 00 01                       ← value 0 + flag 0x01 (null)
```

**Float field with value 65.0:**
```
00 00 00 00 00 40 50 40        ← double 65.0, no flag (65 ≠ 0)
```

**Float field that is NULL:**
```
00 00 00 00 00 00 00 00 01     ← double 0.0 + flag 0x01 (null)
```

**Date field with time 10:50 (stored as 1800-01-01 10:50):**
```
72 1C C7 71 4E D5 E1 C0        ← OLE date -36522.4514, no flag
```

**Date field representing midnight (real value, not null):**
```
00 00 00 00 40 D5 E1 C0 00     ← OLE date -36522.0 + flag 0x00
```

**Date field that is NULL:**
```
00 00 00 00 40 D5 E1 C0 01     ← OLE date -36522.0 + flag 0x01
```

---

## Decoding Algorithm (Pseudocode)

```
for each column in header:
    if type == 'I':
        value = read_int(size)
        if value == 0:
            flag = read_byte()
            if flag == 0x01: value = NULL
    elif type == 'S':
        len = read_uint16()
        value = len > 0 ? read_utf8(len) : NULL
    elif type == 'D':
        value = read_double()
        if value == -36522.0 or value == 0.0:
            flag = read_byte()
            if flag == 0x01: value = NULL
    elif type == 'F':
        value = read_double()
        if value == 0.0:
            flag = read_byte()
            if flag == 0x01: value = NULL
    elif type == 'M':
        len = read_uint32()
        value = len > 0 ? read_utf8(len) : NULL
```

---

## geologix.ini Format

The INI file contains metadata about the backup:

```ini
[Geologix]
Application=Meet Manager 11
Version=11.84272
Identification=BACKUP_MM_MEET_11
GUID=216523d8-dfc5-4de5-aa9b-b42086412a5a
NullDateYear=1800
ExtraFiles=0

[RecordCount]
BSGLOBAL=38
SWIMSTYLE=91
SWIMSESSION=5
...

[Tables]
BSGLOBAL=1
SWIMSTYLE=1
...

[ExtraInfo]
DBFilename=MyMeet.mdb
```

- `NullDateYear=1800` confirms that dates in year 1800 are null/time-only containers
- `[RecordCount]` lists expected row counts per table
- `[Tables]` indicates which tables have data (1) or are empty (0)

---

## SMB ZIP Structure

The ZIP uses standard PKZIP format (deflate compression, method 8). File entries:

```
geologix.ini
BSGLOBAL-0001.gbin
DSQITEM-0001.gbin
SWIMSTYLE-0001.gbin
SWIMSESSION-0001.gbin
SWIMEVENT-0001.gbin
AGEGROUP-0001.gbin
CLUB-0001.gbin
ATHLETE-0001.gbin
HEAT-0001.gbin
SWIMRESULT-0001.gbin
SPLIT-0001.gbin
RELAY-0001.gbin
RELAYPOSITION-0001.gbin
RELAYSPLIT-0001.gbin
RESULTPLACE-0001.gbin
```

Not all tables are always present — check `[Tables]` in geologix.ini.

---

## OLE Automation Date Reference

OLE dates are stored as doubles where:
- Integer part = days since 1899-12-30
- Fractional part = time of day (0.5 = noon, 0.25 = 06:00)
- Negative values = dates before 1899-12-30

Common values:
| OLE Double | Date |
|-----------|------|
| `0.0` | 1899-12-30 00:00:00 |
| `-36522.0` | 1800-01-01 00:00:00 (null sentinel) |
| `-36522.4514` | 1800-01-01 10:50:00 (time = 10:50) |
| `46144.0` | 2026-05-02 00:00:00 |

---

## Version History

- **2026-05-20**: Initial reverse-engineering from Splash Meet Manager 11.84272 backups. Discovered null disambiguation flag mechanism for I, D, F types.
