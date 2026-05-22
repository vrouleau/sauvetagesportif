# Date Handling — Technical Notes

## Storage Formats by System

| System | Format | Example |
|--------|--------|---------|
| Splash .mdb (Access) | OLE Automation double (days since 1899-12-30) | `28725.0` = 1978-08-23, `-36522.333` = null date + 8:00 AM |
| SMB backup (.gbin) | 8-byte LE double (same OLE format) | Binary `28725.0` |
| SQLite (local) | TEXT — either OLE double as string OR ISO string | `"28725.0"` or `"1978-08-23 00:00:00"` |
| PostgreSQL | TIMESTAMP WITHOUT TIME ZONE | `1978-08-23 00:00:00` |
| team-app (Python) | Python `datetime` via SQLAlchemy | `datetime(1978, 8, 23)` |

## OLE Automation Date Format

- Epoch: 1899-12-30 00:00:00
- Integer part = days since epoch
- Fractional part = time of day (0.5 = noon, 0.25 = 06:00)
- Null sentinel: `-36522.0` (= 1800-01-01 00:00:00)
- Zero (`0.0`) also treated as null

Splash uses the null sentinel date part (`-36522`) combined with a fractional time for "time-only" fields like `swimsession.daytime`. The actual session date is in `startdate`.

## Conversion Formulas

```
OLE → Unix ms:   unixMs = Date.UTC(1899, 11, 30) + oleDouble * 86400000
Unix ms → OLE:   oleDouble = (unixMs - Date.UTC(1899, 11, 30)) / 86400000
```

## Data Flow & Conversions

```
SMB restore → SQLite:     Raw OLE doubles stored as text ("28725.0")
SQLite → PG (syncUp):     oleToIsoTimestamp() converts to "1978-08-23 00:00:00"
PG → SQLite (syncDown):   PG Date objects → ISO string "1978-08-23 00:00:00"
SQLite → SMB (saveSMB):   encodeGbin converts ISO strings back to OLE doubles
PG → team-app:            SQLAlchemy reads as Python datetime (no conversion needed)
SQLite → UI (reports):    parseBirthYear / parseOleDate / formatDaytime handle both formats
```

## Key Functions (meet-app/src/main/db.ts)

| Function | Purpose |
|----------|---------|
| `parseBirthYear(v)` | Extract birth year from OLE double, ISO string, or number |
| `parseBirthDate(v)` | Convert to `YYYY-MM-DD` string from any format |
| `parseOleDate(v)` | Convert to `YYYY-MM-DD` or undefined (for session dates) |
| `oleToIsoTimestamp(v)` | Convert to full ISO timestamp for PG sync |
| `isoToOle(v)` | Convert ISO timestamp back to OLE double for SMB export |
| `formatDaytime(v)` | Extract time-of-day (`HH:MM`) from OLE double or ISO string |

## Key Functions (meet-app/src/main/smb.ts)

| Function | Purpose |
|----------|---------|
| `decodeGbin()` | Reads OLE doubles from binary, stores as-is |
| `encodeGbin()` | Writes dates — handles both OLE doubles and ISO strings |

## DATE_COLS Registry (db.ts)

The `DATE_COLS` set lists all `table.column` pairs that are TIMESTAMP in PG. Used by `syncUp` to know which values need OLE→ISO conversion:

- `swimsession`: daytime, endtime, officialmeeting, startdate, tlmeeting, warmupfrom, warmupuntil
- `athlete`: birthdate
- `swimevent`: daytime, duration
- `heat`: daytime
- `swimresult`: dsqdaytime, qtdate

## SQLite Dual-Format Reality

After an SMB restore, SQLite has OLE doubles as text. After a syncDown from PG, SQLite has ISO strings. All reading code must handle BOTH formats. This is why `parseBirthYear`, `parseOleDate`, etc. check for ISO pattern first, then fall back to OLE double parsing.

## Null Sentinel Handling

- `D_NULL_SENTINEL = -36522.0` (OLE date for 1800-01-01)
- In GBIN decode: if value equals sentinel or 0, check the next byte flag (0x00 = real value, 0x01 = null)
- In GBIN encode: write sentinel + flag byte `0x01` for null values
- In syncUp/read: treat `-36522`, `0`, and negative values as null

## MEETVALUES Date Format (bsglobal)

The `MEETVALUES` blob in `bsglobal` uses a different date format for fields like `AGEDATE`, `QUALIFYFROM`, `QUALIFYUNTIL`:

```
Format: YYYYMMDDHHMMSSMMM
Example: 20261231000000000 = 2026-12-31 00:00:00.000
```

This is NOT an OLE double — it's a Splash-specific string encoding. Parsed in the UI with `DateFieldRow` component.

## Splash .mdb vs SQLite Column Differences

- In .mdb: `swimsession.daytime` holds full date+time (e.g., `46200.333` = 2026-06-15 08:00)
- In SMB restore: `daytime` often has null sentinel date + time fraction (`-36522.333` = time only)
- The actual session date should be in `startdate` but may be NULL after SMB restore if Splash didn't export it
- Workaround: `getSessions()` uses `parseOleDate(s.startdate)` and falls back gracefully
