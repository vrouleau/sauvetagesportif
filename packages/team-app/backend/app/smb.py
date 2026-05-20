"""SMB file format handler (Splash Meet Backup).

An .smb file is a ZIP archive containing:
- geologix.ini: metadata (app version, record counts)
- TABLENAME-0001.gbin: binary-serialized table data

See packages/meet-app/docs/GBIN_FORMAT.md for the full binary specification.

This module provides:
- decode_gbin(data) -> list of dicts (parse a single gbin buffer)
- encode_gbin(cols, rows) -> bytes (produce a gbin buffer)
- read_smb(path_or_bytes) -> dict of table_name -> list of row dicts
- write_smb(path, tables, geologix_ini_text) -> None
"""

from __future__ import annotations

import struct
import zipfile
import zlib
from io import BytesIO
from pathlib import Path
from typing import Any

# ── Null sentinel for D;32 (OLE date for 1800-01-01 00:00:00) ──────────────────

D_NULL_SENTINEL = -36522.0


# ── Column definition ──────────────────────────────────────────────────────────

class ColDef:
    __slots__ = ("name", "type", "size")

    def __init__(self, name: str, col_type: str, size: int):
        self.name = name
        self.type = col_type  # 'I', 'S', 'D', 'F', 'M'
        self.size = size

    def __repr__(self):
        return f"{self.name};{self.type};{self.size}"


# ── GBIN decoding ─────────────────────────────────────────────────────────────

def decode_gbin(data: bytes | bytearray | memoryview) -> tuple[list[ColDef], list[dict[str, Any]]]:
    """Decode a gbin binary buffer into column definitions and rows.

    Returns (cols, rows) where rows is a list of dicts with lowercase keys.
    """
    buf = memoryview(data) if not isinstance(data, memoryview) else data
    header_len = struct.unpack_from("<H", buf, 0)[0]
    header_str = bytes(buf[2:2 + header_len]).decode("ascii")
    cols: list[ColDef] = []
    for part in header_str.split("\t"):
        name, col_type, size_str = part.split(";")
        cols.append(ColDef(name, col_type, int(size_str)))

    rows: list[dict[str, Any]] = []
    offset = 2 + header_len
    length = len(buf)

    while offset < length:
        row: dict[str, Any] = {}
        valid = True

        for col in cols:
            if offset >= length:
                valid = False
                break

            key = col.name.lower()

            if col.type == "I":
                if col.size <= 16:
                    val = struct.unpack_from("<h", buf, offset)[0]
                    offset += 2
                else:
                    val = struct.unpack_from("<i", buf, offset)[0]
                    offset += 4

                if val == 0 and offset < length:
                    flag = buf[offset]
                    if flag == 0x00 or flag == 0x01:
                        offset += 1
                        row[key] = None if flag == 0x01 else val
                    else:
                        row[key] = val
                else:
                    row[key] = val

            elif col.type == "S":
                slen = struct.unpack_from("<H", buf, offset)[0]
                offset += 2
                if slen > 0:
                    row[key] = bytes(buf[offset:offset + slen]).decode("utf-8")
                    offset += slen
                else:
                    row[key] = None

            elif col.type == "D":
                dbl = struct.unpack_from("<d", buf, offset)[0]
                offset += 8

                if dbl == D_NULL_SENTINEL or dbl == 0.0:
                    if offset < length:
                        flag = buf[offset]
                        if flag == 0x00 or flag == 0x01:
                            offset += 1
                            row[key] = None if flag == 0x01 else dbl
                        else:
                            row[key] = None if dbl == 0.0 else dbl
                    else:
                        row[key] = None if dbl == 0.0 else dbl
                else:
                    row[key] = dbl

            elif col.type == "F":
                dbl = struct.unpack_from("<d", buf, offset)[0]
                offset += 8

                if dbl == 0.0:
                    if offset < length:
                        flag = buf[offset]
                        if flag == 0x00 or flag == 0x01:
                            offset += 1
                            row[key] = None if flag == 0x01 else dbl
                        else:
                            row[key] = None
                    else:
                        row[key] = None
                else:
                    row[key] = dbl

            elif col.type == "M":
                mlen = struct.unpack_from("<I", buf, offset)[0]
                offset += 4
                if mlen > 0:
                    row[key] = bytes(buf[offset:offset + mlen]).decode("utf-8")
                    offset += mlen
                else:
                    row[key] = None

        if not valid:
            break
        rows.append(row)

    return cols, rows


# ── GBIN encoding ─────────────────────────────────────────────────────────────

def encode_gbin(cols: list[ColDef], rows: list[dict[str, Any]]) -> bytes:
    """Encode rows into gbin binary format.

    Columns define the header and field order. Row keys should be lowercase.
    """
    # Header
    header_str = "\t".join(f"{c.name};{c.type};{c.size}" for c in cols)
    header_bytes = header_str.encode("ascii")
    parts: list[bytes] = [struct.pack("<H", len(header_bytes)), header_bytes]

    for row in rows:
        for col in cols:
            val = row.get(col.name.lower())

            if col.type == "I":
                num_val = int(val) if val is not None else 0
                if col.size <= 16:
                    parts.append(struct.pack("<h", num_val))
                else:
                    parts.append(struct.pack("<i", num_val))
                # Null disambiguation flag when value is 0
                if num_val == 0:
                    parts.append(b"\x01" if val is None else b"\x00")

            elif col.type == "S":
                s = str(val) if val is not None else ""
                encoded = s.encode("utf-8")
                parts.append(struct.pack("<H", len(encoded)))
                if encoded:
                    parts.append(encoded)

            elif col.type == "D":
                dbl_val = float(val) if val is not None else D_NULL_SENTINEL
                parts.append(struct.pack("<d", dbl_val))
                if dbl_val == D_NULL_SENTINEL or dbl_val == 0.0:
                    parts.append(b"\x01" if val is None else b"\x00")

            elif col.type == "F":
                dbl_val = float(val) if val is not None else 0.0
                parts.append(struct.pack("<d", dbl_val))
                if dbl_val == 0.0:
                    parts.append(b"\x01" if val is None else b"\x00")

            elif col.type == "M":
                s = str(val) if val is not None else ""
                encoded = s.encode("utf-8")
                parts.append(struct.pack("<I", len(encoded)))
                if encoded:
                    parts.append(encoded)

    return b"".join(parts)


# ── SMB (ZIP) reading ──────────────────────────────────────────────────────────

def read_smb(source: str | Path | bytes | BytesIO) -> dict[str, list[dict[str, Any]]]:
    """Read an .smb file and return {table_name: [rows...]}.

    Accepts a file path, raw bytes, or BytesIO.
    """
    if isinstance(source, (str, Path)):
        with open(source, "rb") as f:
            raw = f.read()
    elif isinstance(source, bytes):
        raw = source
    else:
        raw = source.read()

    tables: dict[str, list[dict[str, Any]]] = {}

    with zipfile.ZipFile(BytesIO(raw)) as z:
        for name in z.namelist():
            if not name.endswith(".gbin"):
                continue
            # Extract table name: "SWIMSTYLE-0001.gbin" -> "SWIMSTYLE"
            table_name = name.split("-")[0]
            gbin_data = z.read(name)
            _cols, rows = decode_gbin(gbin_data)
            tables[table_name] = rows

    return tables


def read_smb_with_cols(
    source: str | Path | bytes | BytesIO,
) -> dict[str, tuple[list[ColDef], list[dict[str, Any]]]]:
    """Read an .smb file and return {table_name: (cols, rows)}.

    Like read_smb but also returns column definitions for each table.
    """
    if isinstance(source, (str, Path)):
        with open(source, "rb") as f:
            raw = f.read()
    elif isinstance(source, bytes):
        raw = source
    else:
        raw = source.read()

    tables: dict[str, tuple[list[ColDef], list[dict[str, Any]]]] = {}

    with zipfile.ZipFile(BytesIO(raw)) as z:
        for name in z.namelist():
            if not name.endswith(".gbin"):
                continue
            table_name = name.split("-")[0]
            gbin_data = z.read(name)
            cols, rows = decode_gbin(gbin_data)
            tables[table_name] = (cols, rows)

    return tables


# ── SMB (ZIP) writing ──────────────────────────────────────────────────────────

def write_smb(
    dest: str | Path,
    table_data: dict[str, tuple[list[ColDef], list[dict[str, Any]]]],
    *,
    ini_text: str | None = None,
) -> int:
    """Write an .smb file from table data.

    Args:
        dest: Output file path.
        table_data: {TABLE_NAME: (cols, rows)} — column defs and row dicts.
        ini_text: Optional custom geologix.ini content. If None, auto-generated.

    Returns:
        Total number of rows written.
    """
    total_rows = 0

    if ini_text is None:
        lines = [
            "[Geologix]",
            "Application=SplashMeet",
            "Version=1.0.0",
            "Identification=BACKUP_MM_MEET_11",
            "",
            "[RecordCount]",
        ]
        for tname, (_, rows) in table_data.items():
            lines.append(f"{tname}={len(rows)}")
        lines.append("")
        lines.append("[Tables]")
        for tname, (_, rows) in table_data.items():
            lines.append(f"{tname}={1 if rows else 0}")
        lines.append("")
        ini_text = "\r\n".join(lines)

    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for tname, (cols, rows) in table_data.items():
            gbin_bytes = encode_gbin(cols, rows)
            z.writestr(f"{tname}-0001.gbin", gbin_bytes)
            total_rows += len(rows)

        z.writestr("geologix.ini", ini_text.encode("utf-8"))

    return total_rows
