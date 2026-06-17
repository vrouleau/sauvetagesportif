# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
#
# This file is part of Sauvetage Sportif.
#
# Sauvetage Sportif is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Sauvetage Sportif is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with Sauvetage Sportif. If not, see <https://www.gnu.org/licenses/>.

"""Import Splash Team Manager .mdb file using mdbtools.

Requires `mdbtools` package installed in the Docker container:
    apt-get install -y mdbtools

Usage:
    from .mdb_import import import_team_mdb
    counts = import_team_mdb(db_session, mdb_file_bytes)
"""
from __future__ import annotations

import csv
import subprocess
import tempfile
from datetime import datetime
from io import StringIO
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from .models_team import (
    Meet, Session as MeetSession, Event, TeamClub, Member,
    Result, MemberMeet, Relay, RelayPos,
)
from .models import SwimStyle

# Tables to import in FK-dependency order
IMPORT_TABLES = [
    "SWIMSTYLE",
    "CLUBS",
    "MEMBERS",
    "MEETS",
    "SESSIONS",
    "EVENTS",
    "RESULTS",
    "MEMBERSMEETS",
    "RELAYS",
    "RELAYSPOS",
]


def _mdb_export_csv(mdb_path: str, table_name: str) -> str:
    """Run mdb-export and return CSV string."""
    result = subprocess.run(
        ["mdb-export", mdb_path, table_name],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"mdb-export {table_name} failed: {result.stderr}")
    return result.stdout


def _parse_datetime(val: str) -> datetime | None:
    """Parse MDB datetime string (MM/DD/YY HH:MM:SS format)."""
    if not val or val.strip() == "":
        return None
    val = val.strip()
    for fmt in ("%m/%d/%y %H:%M:%S", "%m/%d/%Y %H:%M:%S",
                "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(val, fmt)
        except ValueError:
            continue
    return None


def _int(val: str) -> int | None:
    """Parse integer, return None for empty."""
    if not val or val.strip() == "":
        return None
    try:
        return int(val)
    except ValueError:
        return None


def _float(val: str) -> float | None:
    """Parse float, return None for empty."""
    if not val or val.strip() == "":
        return None
    try:
        return float(val)
    except ValueError:
        return None


def _str(val: str, max_len: int = 0) -> str | None:
    """Clean string, return None for empty."""
    if not val or val.strip() == "":
        return None
    s = val.strip()
    if max_len and len(s) > max_len:
        s = s[:max_len]
    return s


def _import_swimstyle(db: Session, rows: list[dict]) -> int:
    count = 0
    for row in rows:
        sid = _int(row.get("SWIMSTYLEID", ""))
        if not sid:
            continue
        db.merge(SwimStyle(
            swimstyleid=sid,
            code=_str(row.get("CODE", ""), 10),
            distance=_int(row.get("DISTANCE", "")),
            name=_str(row.get("NAME", ""), 50),
            relaycount=_int(row.get("RELAYCOUNT", "")),
            stroke=_int(row.get("STROKE", "")),
            sortcode=_int(row.get("SORTCODE", "")),
            technique=_int(row.get("TECHNIQUE", "")),
            uniqueid=_int(row.get("UNIQUEID", "")),
        ))
        count += 1
    db.flush()
    return count


def _import_clubs(db: Session, rows: list[dict]) -> int:
    import secrets, string
    count = 0
    for row in rows:
        cid = _int(row.get("CLUBSID", ""))
        if not cid:
            continue
        pin = ''.join(secrets.choice(string.digits) for _ in range(6))
        db.merge(TeamClub(
            clubsid=cid,
            name=_str(row.get("NAME", ""), 100),
            shortname=_str(row.get("SHORTNAME", ""), 30),
            code=_str(row.get("CODE", ""), 8),
            nation=_str(row.get("NATION", ""), 3),
            nameen=_str(row.get("NAMEEN", ""), 80),
            shortnameen=_str(row.get("SHORTNAMEEN", ""), 30),
            teamnumb=_int(row.get("TEAMNUMB", "")),
            pin=pin,
        ))
        count += 1
    db.flush()
    return count


def _import_members(db: Session, rows: list[dict]) -> int:
    count = 0
    for row in rows:
        mid = _int(row.get("MEMBERSID", ""))
        if not mid:
            continue
        db.merge(Member(
            membersid=mid,
            lastname=_str(row.get("LASTNAME", ""), 60),
            firstname=_str(row.get("FIRSTNAME", ""), 30),
            birthdate=_parse_datetime(row.get("BIRTHDATE", "")),
            gender=_int(row.get("GENDER", "")),
            nation=_str(row.get("NATION", ""), 3),
            license=_str(row.get("REGISTRATIONID", ""), 20),
            clubsid=_int(row.get("CLUBSID1", "")),
            nameprefix=_str(row.get("NAMEPREFIX", ""), 15),
            firstnameen=_str(row.get("FIRSTNAMEEN", ""), 30),
            lastnameen=_str(row.get("LASTNAMEEN", ""), 60),
            swimlevel=_str(row.get("SWIMLEVEL", ""), 10),
            handicapex=_str(row.get("HANDICAPEX", ""), 10),
            active=_str(row.get("ACTIVE", ""), 1) or "T",
        ))
        count += 1
    db.flush()
    return count


def _import_meets(db: Session, rows: list[dict]) -> int:
    count = 0
    for row in rows:
        mid = _int(row.get("MEETSID", ""))
        if not mid:
            continue
        db.merge(Meet(
            meetsid=mid,
            name=_str(row.get("NAME", ""), 100),
            poolname=_str(row.get("POOLNAME", ""), 50),
            place=_str(row.get("PLACE", ""), 50),
            state=_str(row.get("STATE", ""), 4),
            nation=_str(row.get("NATION", ""), 50),
            mindate=_parse_datetime(row.get("MINDATE", "")),
            maxdate=_parse_datetime(row.get("MAXDATE", "")),
            agedate=_parse_datetime(row.get("AGEDATE", "")),
            course=_int(row.get("COURSE", "")),
            meetstate=_int(row.get("MEETSTATE", "")),
            feeclub=_float(row.get("FEECLUB", "")),
            feeperson=_float(row.get("FEEPERSON", "")),
            feerelay=_float(row.get("FEERELAY", "")),
            maxientries=_int(row.get("MAXIENTRIES", "")),
            maxrentries=_int(row.get("MAXRENTRIES", "")),
            deadline=_parse_datetime(row.get("DEADLINE", "")),
            data=_str(row.get("DATA", "")),
        ))
        count += 1
    db.flush()
    return count


def _import_sessions(db: Session, rows: list[dict]) -> int:
    count = 0
    for row in rows:
        sid = _int(row.get("SESSIONSID", ""))
        if not sid:
            continue
        db.merge(MeetSession(
            sessionsid=sid,
            meetsid=_int(row.get("MEETSID", "")),
            numb=_int(row.get("NUMB", "")),
            startdate=_parse_datetime(row.get("STARTDATE", "")),
            starttime=_parse_datetime(row.get("STARTTIME", "")),
            name=_str(row.get("NAME", ""), 50),
            feeperson=_float(row.get("FEEPERSON", "")),
        ))
        count += 1
    db.flush()
    return count


def _import_events(db: Session, rows: list[dict]) -> int:
    count = 0
    for row in rows:
        eid = _int(row.get("EVENTSID", ""))
        if not eid:
            continue
        db.merge(Event(
            eventsid=eid,
            meetsid=_int(row.get("MEETSID", "")),
            sessionnumb=_int(row.get("SESSIONNUMB", "")),
            numb=_int(row.get("NUMB", "")),
            eventtyp=_int(row.get("EVENTTYP", "")),
            stylesid=_int(row.get("STYLESID", "")),
            minage=_int(row.get("MINAGE", "")),
            maxage=_int(row.get("MAXAGE", "")),
            fee=_float(row.get("FEE", "")),
            gender=_int(row.get("GENDER", "")),
            sortcode=_int(row.get("SORTCODE", "")),
        ))
        count += 1
    db.flush()
    return count


def _import_results(db: Session, rows: list[dict]) -> int:
    count = 0
    for row in rows:
        rid = _int(row.get("RESULTSID", ""))
        if not rid:
            continue
        db.merge(Result(
            resultsid=rid,
            membersid=_int(row.get("MEMBERSID", "")),
            meetsid=_int(row.get("MEETSID", "")),
            eventdate=_parse_datetime(row.get("EVENTDATE", "")),
            stylesid=_int(row.get("STYLESID", "")),
            totaltime=_int(row.get("TOTALTIME", "")),
            entrytime=_int(row.get("ENTRYTIME", "")),
            rank=_int(row.get("RANK", "")),
            eventnumb=_int(row.get("EVENTNUMB", "")),
            eventtyp=_int(row.get("EVENTTYP", "")),
            resulttyp=_int(row.get("RESULTTYP", "")),
            course=_int(row.get("COURSE", "")),
            entrytimecourse=_int(row.get("ENTRYTIMECOURSE", "")),
        ))
        count += 1
    db.flush()
    return count


def _import_membersmeets(db: Session, rows: list[dict]) -> int:
    count = 0
    for row in rows:
        mid = _int(row.get("MEMBERSID", ""))
        meid = _int(row.get("MEETSID", ""))
        if not mid or not meid:
            continue
        db.merge(MemberMeet(
            membersid=mid,
            meetsid=meid,
            clubsid=_int(row.get("CLUBSID", "")),
            changed=_parse_datetime(row.get("CHANGED", "")),
        ))
        count += 1
    db.flush()
    return count


def _import_relays(db: Session, rows: list[dict]) -> int:
    count = 0
    for row in rows:
        rid = _int(row.get("RELAYSID", ""))
        if not rid:
            continue
        db.merge(Relay(
            relaysid=rid,
            meetsid=_int(row.get("MEETSID", "")),
            eventdate=_parse_datetime(row.get("EVENTDATE", "")),
            clubsid=_int(row.get("CLUBSID", "")),
            teamnumb=_int(row.get("TEAMNUMB", "")),
            stylesid=_int(row.get("STYLESID", "")),
            totaltime=_int(row.get("TOTALTIME", "")),
            entrytime=_int(row.get("ENTRYTIME", "")),
            eventnumb=_int(row.get("EVENTNUMB", "")),
            eventtyp=_int(row.get("EVENTTYP", "")),
            resulttyp=_int(row.get("RESULTTYP", "")),
            rank=_int(row.get("RANK", "")),
            course=_int(row.get("COURSE", "")),
            gender=_int(row.get("GENDER", "")),
            minage=_int(row.get("MINAGE", "")),
            maxage=_int(row.get("MAXAGE", "")),
        ))
        count += 1
    db.flush()
    return count


def _import_relayspos(db: Session, rows: list[dict]) -> int:
    count = 0
    for row in rows:
        rid = _int(row.get("RELAYSID", ""))
        numb = _int(row.get("NUMB", ""))
        if not rid or numb is None:
            continue
        db.merge(RelayPos(
            relaysid=rid,
            numb=numb,
            membersid=_int(row.get("MEMBERSID", "")),
            entrytime=_int(row.get("ENTRYTIME", "")),
        ))
        count += 1
    db.flush()
    return count


# ── Main import function ──────────────────────────────────────────────────────

_TABLE_IMPORTERS = {
    "SWIMSTYLE": _import_swimstyle,
    "CLUBS": _import_clubs,
    "MEMBERS": _import_members,
    "MEETS": _import_meets,
    "SESSIONS": _import_sessions,
    "EVENTS": _import_events,
    "RESULTS": _import_results,
    "MEMBERSMEETS": _import_membersmeets,
    "RELAYS": _import_relays,
    "RELAYSPOS": _import_relayspos,
}


def import_team_mdb(db: Session, mdb_bytes: bytes) -> dict[str, int]:
    """Import a Splash Team Manager .mdb file into PostgreSQL.

    Writes the .mdb to a temp file, uses mdb-export to extract CSV per table,
    then inserts into the database.

    Returns: {table_name: rows_imported}
    """
    counts: dict[str, int] = {}

    with tempfile.NamedTemporaryFile(suffix=".mdb", delete=False) as f:
        f.write(mdb_bytes)
        mdb_path = f.name

    try:
        for table_name in IMPORT_TABLES:
            try:
                csv_text = _mdb_export_csv(mdb_path, table_name)
            except RuntimeError:
                counts[table_name] = 0
                continue

            if not csv_text.strip():
                counts[table_name] = 0
                continue

            reader = csv.DictReader(StringIO(csv_text))
            rows = list(reader)

            importer = _TABLE_IMPORTERS.get(table_name)
            if importer:
                counts[table_name] = importer(db, rows)
            else:
                counts[table_name] = 0

        db.commit()
    finally:
        Path(mdb_path).unlink(missing_ok=True)

    return counts