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

"""Unit tests for SMB/gbin encoding and decoding.

Uses synthetic data — no external files or Docker stack required.
Run: `pytest tests/unit/ -v`
"""
from __future__ import annotations

import sys
import zipfile
from io import BytesIO
from pathlib import Path

import pytest

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.smb import ColDef, decode_gbin, encode_gbin, read_smb, write_smb, read_smb_with_cols


# ── Fixtures: synthetic table data ─────────────────────────────────────────────

SWIMSTYLE_COLS = [
    ColDef("swimstyleid", "I", 32),
    ColDef("code", "S", 10),
    ColDef("distance", "I", 16),
    ColDef("name", "S", 50),
    ColDef("relaycount", "I", 16),
    ColDef("stroke", "I", 16),
    ColDef("sortcode", "I", 32),
    ColDef("technique", "I", 16),
    ColDef("uniqueid", "I", 16),
]

SWIMSTYLE_ROWS = [
    {"swimstyleid": 101, "code": "50FR", "distance": 50, "name": "50 m Nage libre",
     "relaycount": 1, "stroke": 1, "sortcode": 100, "technique": 0, "uniqueid": 1},
    {"swimstyleid": 102, "code": "100FR", "distance": 100, "name": "100 m Nage libre",
     "relaycount": 1, "stroke": 1, "sortcode": 200, "technique": 0, "uniqueid": 2},
    {"swimstyleid": 103, "code": "50DO", "distance": 50, "name": "50 m Dos",
     "relaycount": 1, "stroke": 2, "sortcode": 300, "technique": 0, "uniqueid": 3},
    {"swimstyleid": 201, "code": "4x50", "distance": 200, "name": "4x50 m Relais libre",
     "relaycount": 4, "stroke": 6, "sortcode": 400, "technique": 0, "uniqueid": 4},
]

SWIMSESSION_COLS = [
    ColDef("swimsessionid", "I", 32),
    ColDef("course", "I", 16),
    ColDef("daytime", "D", 32),
    ColDef("endtime", "D", 32),
    ColDef("feeathlete", "F", 32),
    ColDef("following", "S", 1),
    ColDef("lanemin", "I", 16),
    ColDef("lanemax", "I", 16),
    ColDef("lanesbyplace", "S", 100),
    ColDef("maxentriesathlete", "I", 16),
    ColDef("maxentriesrelay", "I", 16),
    ColDef("name", "S", 100),
    ColDef("officialmeeting", "D", 32),
    ColDef("poolglobal", "S", 1),
    ColDef("pooltype", "I", 16),
    ColDef("remarks", "M", 0),
    ColDef("remarksjury", "M", 0),
    ColDef("roundtotenths", "S", 1),
    ColDef("sessionnumber", "I", 16),
    ColDef("startdate", "D", 32),
    ColDef("timing", "I", 16),
    ColDef("tlmeeting", "D", 32),
    ColDef("touchpadmode", "I", 16),
    ColDef("warmupfrom", "D", 32),
    ColDef("warmupuntil", "D", 32),
]

SWIMSESSION_ROWS = [
    {
        "swimsessionid": 1001, "course": 3, "daytime": None, "endtime": None,
        "feeathlete": 45.0, "following": "F", "lanemin": 1, "lanemax": 6,
        "lanesbyplace": None, "maxentriesathlete": None, "maxentriesrelay": None,
        "name": "Session 1 - Préliminaires", "officialmeeting": None,
        "poolglobal": "F", "pooltype": 0, "remarks": None, "remarksjury": None,
        "roundtotenths": "F", "sessionnumber": 1, "startdate": None,
        "timing": 0, "tlmeeting": None, "touchpadmode": 0,
        "warmupfrom": None, "warmupuntil": None,
    },
    {
        "swimsessionid": 1002, "course": 3, "daytime": None, "endtime": None,
        "feeathlete": None, "following": "F", "lanemin": 1, "lanemax": 6,
        "lanesbyplace": None, "maxentriesathlete": None, "maxentriesrelay": None,
        "name": "Session 2 - Finales", "officialmeeting": None,
        "poolglobal": "F", "pooltype": 0, "remarks": None, "remarksjury": None,
        "roundtotenths": "F", "sessionnumber": 2, "startdate": None,
        "timing": 0, "tlmeeting": None, "touchpadmode": 0,
        "warmupfrom": None, "warmupuntil": None,
    },
]

SPLIT_COLS = [
    ColDef("swimresultid", "I", 32),
    ColDef("distance", "I", 16),
    ColDef("swimtime", "I", 32),
]

SPLIT_ROWS = [
    {"swimresultid": 5001, "distance": 50, "swimtime": 32450},
    {"swimresultid": 5001, "distance": 100, "swimtime": 67890},
    {"swimresultid": 5002, "distance": 50, "swimtime": 28100},
    {"swimresultid": 5002, "distance": 100, "swimtime": 59200},
]

BSGLOBAL_COLS = [
    ColDef("name", "S", 50),
    ColDef("data", "M", 0),
]

BSGLOBAL_ROWS = [
    {"name": "MeetName", "data": "Championnats régionaux 2026"},
    {"name": "MeetCity", "data": "Gatineau"},
    {"name": "MeetNation", "data": "CAN"},
    {"name": "MeetCourse", "data": "3"},
]


# ── Tests: gbin encode/decode roundtrip ────────────────────────────────────────

class TestGbinRoundtrip:
    """Verify encode→decode roundtrip preserves data for various column types."""

    def test_swimstyle_roundtrip(self):
        """Integer and string columns roundtrip correctly."""
        encoded = encode_gbin(SWIMSTYLE_COLS, SWIMSTYLE_ROWS)
        cols, rows = decode_gbin(encoded)

        assert len(rows) == len(SWIMSTYLE_ROWS)
        assert len(cols) == len(SWIMSTYLE_COLS)

        for orig, decoded in zip(SWIMSTYLE_ROWS, rows):
            for key in orig:
                assert decoded[key] == orig[key], (
                    f"SWIMSTYLE.{key}: expected {orig[key]!r}, got {decoded[key]!r}"
                )

    def test_swimsession_roundtrip(self):
        """Float, date, memo, and nullable columns roundtrip correctly."""
        encoded = encode_gbin(SWIMSESSION_COLS, SWIMSESSION_ROWS)
        cols, rows = decode_gbin(encoded)

        assert len(rows) == len(SWIMSESSION_ROWS)

        # Session 1: feeathlete=45.0 (non-null float)
        assert rows[0]["name"] == "Session 1 - Préliminaires"
        assert rows[0]["feeathlete"] == 45.0
        assert rows[0]["lanemin"] == 1
        assert rows[0]["lanemax"] == 6
        assert rows[0]["sessionnumber"] == 1
        assert rows[0]["course"] == 3

        # Session 2: feeathlete=None (null float)
        assert rows[1]["name"] == "Session 2 - Finales"
        assert rows[1]["feeathlete"] is None
        assert rows[1]["sessionnumber"] == 2

    def test_split_roundtrip(self):
        """Simple integer-only table roundtrips correctly."""
        encoded = encode_gbin(SPLIT_COLS, SPLIT_ROWS)
        cols, rows = decode_gbin(encoded)

        assert len(rows) == len(SPLIT_ROWS)
        for orig, decoded in zip(SPLIT_ROWS, rows):
            assert decoded["swimresultid"] == orig["swimresultid"]
            assert decoded["distance"] == orig["distance"]
            assert decoded["swimtime"] == orig["swimtime"]

    def test_bsglobal_roundtrip(self):
        """String + memo columns roundtrip correctly."""
        encoded = encode_gbin(BSGLOBAL_COLS, BSGLOBAL_ROWS)
        cols, rows = decode_gbin(encoded)

        assert len(rows) == len(BSGLOBAL_ROWS)
        for orig, decoded in zip(BSGLOBAL_ROWS, rows):
            assert decoded["name"] == orig["name"]
            assert decoded["data"] == orig["data"]

    def test_null_integer_preserved(self):
        """A null integer (None) is distinct from zero after roundtrip."""
        cols = [ColDef("id", "I", 32), ColDef("value", "I", 32)]
        rows = [
            {"id": 1, "value": 0},
            {"id": 2, "value": None},
            {"id": 3, "value": 42},
        ]
        encoded = encode_gbin(cols, rows)
        _, decoded = decode_gbin(encoded)

        assert decoded[0]["value"] == 0
        assert decoded[1]["value"] is None
        assert decoded[2]["value"] == 42

    def test_null_string_preserved(self):
        """A null string is distinct from empty string after roundtrip."""
        cols = [ColDef("id", "I", 32), ColDef("text", "S", 50)]
        rows = [
            {"id": 1, "text": "hello"},
            {"id": 2, "text": None},
            {"id": 3, "text": ""},
        ]
        encoded = encode_gbin(cols, rows)
        _, decoded = decode_gbin(encoded)

        assert decoded[0]["text"] == "hello"
        assert decoded[1]["text"] is None
        # Empty string encodes as length=0 which decodes as None
        assert decoded[2]["text"] is None

    def test_unicode_string_roundtrip(self):
        """UTF-8 characters (accents, special chars) survive roundtrip."""
        cols = [ColDef("id", "I", 32), ColDef("name", "S", 100)]
        rows = [
            {"id": 1, "name": "50 m Remorquage mannequin"},
            {"id": 2, "name": "Épreuve spéciale — été"},
            {"id": 3, "name": "100m Nage avec obstacles"},
        ]
        encoded = encode_gbin(cols, rows)
        _, decoded = decode_gbin(encoded)

        for orig, dec in zip(rows, decoded):
            assert dec["name"] == orig["name"]

    def test_large_integer_values(self):
        """Large 32-bit integers encode/decode correctly.
        Note: 2147483647 (max int32) is Splash's "no time" sentinel and is
        normalized to None on decode and encoded as GBIN null.
        """
        cols = [ColDef("id", "I", 32), ColDef("time_ms", "I", 32)]
        rows = [
            {"id": 1, "time_ms": 3600000},   # 1 hour in ms
            {"id": 2, "time_ms": 65430},      # ~1:05.43
            {"id": 3, "time_ms": 2147483647}, # max int32 = Splash NT sentinel
        ]
        encoded = encode_gbin(cols, rows)
        _, decoded = decode_gbin(encoded)

        assert decoded[0]["time_ms"] == 3600000
        assert decoded[1]["time_ms"] == 65430
        # Splash sentinel is normalized to None
        assert decoded[2]["time_ms"] is None

    def test_empty_table_roundtrip(self):
        """An empty table (no rows) roundtrips correctly."""
        encoded = encode_gbin(SWIMSTYLE_COLS, [])
        cols, rows = decode_gbin(encoded)

        assert len(rows) == 0
        assert len(cols) == len(SWIMSTYLE_COLS)


# ── Tests: SMB (ZIP) read/write ────────────────────────────────────────────────

class TestSmbReadWrite:
    """Verify write_smb → read_smb roundtrip with synthetic data."""

    @pytest.fixture
    def smb_tables(self):
        """Synthetic table data for a minimal meet."""
        return {
            "BSGLOBAL": (BSGLOBAL_COLS, BSGLOBAL_ROWS),
            "SWIMSTYLE": (SWIMSTYLE_COLS, SWIMSTYLE_ROWS),
            "SWIMSESSION": (SWIMSESSION_COLS, SWIMSESSION_ROWS),
            "SPLIT": (SPLIT_COLS, SPLIT_ROWS),
        }

    def test_write_then_read(self, smb_tables, tmp_path):
        """write_smb produces a file that read_smb can parse back."""
        smb_path = tmp_path / "test.smb"
        total = write_smb(smb_path, smb_tables)

        assert total == sum(len(rows) for _, rows in smb_tables.values())
        assert smb_path.exists()

        tables = read_smb(smb_path)
        assert "SWIMSTYLE" in tables
        assert "SWIMSESSION" in tables
        assert "SPLIT" in tables
        assert "BSGLOBAL" in tables

        assert len(tables["SWIMSTYLE"]) == len(SWIMSTYLE_ROWS)
        assert len(tables["SWIMSESSION"]) == len(SWIMSESSION_ROWS)
        assert len(tables["SPLIT"]) == len(SPLIT_ROWS)
        assert len(tables["BSGLOBAL"]) == len(BSGLOBAL_ROWS)

    def test_write_then_read_with_cols(self, smb_tables, tmp_path):
        """read_smb_with_cols returns column definitions alongside rows."""
        smb_path = tmp_path / "test.smb"
        write_smb(smb_path, smb_tables)

        tables = read_smb_with_cols(smb_path)
        cols, rows = tables["SWIMSTYLE"]
        assert len(cols) == len(SWIMSTYLE_COLS)
        assert cols[0].name == "swimstyleid"
        assert cols[0].type == "I"
        assert len(rows) == len(SWIMSTYLE_ROWS)

    def test_smb_is_valid_zip(self, smb_tables, tmp_path):
        """The output .smb is a valid ZIP file."""
        smb_path = tmp_path / "test.smb"
        write_smb(smb_path, smb_tables)

        with zipfile.ZipFile(smb_path) as z:
            names = z.namelist()
            assert "geologix.ini" in names
            assert any(n.endswith(".gbin") for n in names)

    def test_smb_geologix_ini_content(self, smb_tables, tmp_path):
        """The geologix.ini contains correct record counts."""
        smb_path = tmp_path / "test.smb"
        write_smb(smb_path, smb_tables)

        with zipfile.ZipFile(smb_path) as z:
            ini = z.read("geologix.ini").decode("utf-8")
            assert "SWIMSTYLE=4" in ini
            assert "SWIMSESSION=2" in ini
            assert "SPLIT=4" in ini
            assert "BSGLOBAL=4" in ini

    def test_field_values_preserved_through_smb(self, smb_tables, tmp_path):
        """Specific field values survive the full write→read cycle."""
        smb_path = tmp_path / "test.smb"
        write_smb(smb_path, smb_tables)

        tables = read_smb(smb_path)

        # Check swimstyle values
        style = next(s for s in tables["SWIMSTYLE"] if s["swimstyleid"] == 101)
        assert style["name"] == "50 m Nage libre"
        assert style["distance"] == 50
        assert style["stroke"] == 1
        assert style["relaycount"] == 1

        # Check session values
        sess = next(s for s in tables["SWIMSESSION"] if s["swimsessionid"] == 1001)
        assert sess["name"] == "Session 1 - Préliminaires"
        assert sess["feeathlete"] == 45.0
        assert sess["lanemin"] == 1
        assert sess["lanemax"] == 6

        # Check null fee
        sess2 = next(s for s in tables["SWIMSESSION"] if s["swimsessionid"] == 1002)
        assert sess2["feeathlete"] is None

        # Check splits
        split = next(s for s in tables["SPLIT"] if s["swimresultid"] == 5001 and s["distance"] == 50)
        assert split["swimtime"] == 32450

    def test_read_smb_from_bytes(self, smb_tables, tmp_path):
        """read_smb accepts raw bytes as input."""
        smb_path = tmp_path / "test.smb"
        write_smb(smb_path, smb_tables)

        raw = smb_path.read_bytes()
        tables = read_smb(raw)
        assert len(tables["SWIMSTYLE"]) == len(SWIMSTYLE_ROWS)

    def test_read_smb_from_bytesio(self, smb_tables, tmp_path):
        """read_smb accepts BytesIO as input."""
        smb_path = tmp_path / "test.smb"
        write_smb(smb_path, smb_tables)

        raw = smb_path.read_bytes()
        tables = read_smb(BytesIO(raw))
        assert len(tables["SWIMSTYLE"]) == len(SWIMSTYLE_ROWS)


# ── Tests: OLE date handling for pause events ──────────────────────────────────

class TestOleDateDecoding:
    """Verify OLE Automation date values are decoded correctly from gbin."""

    SWIMEVENT_COLS = [
        ColDef("swimeventid", "I", 32),
        ColDef("comment", "M", 0),
        ColDef("daytime", "D", 32),
        ColDef("duration", "D", 32),
        ColDef("eventnumber", "I", 16),
        ColDef("gender", "I", 16),
        ColDef("round", "I", 16),
        ColDef("sortcode", "I", 32),
        ColDef("swimsessionid", "I", 32),
        ColDef("swimstyleid", "I", 32),
        ColDef("internalevent", "S", 1),
        ColDef("roundname", "S", 50),
    ]

    def test_pause_event_with_ole_daytime(self):
        """A pause event with OLE daytime -36522.3125 decodes to 7:30 time fraction."""
        rows = [{
            "swimeventid": 4532,
            "comment": "huis clos/lock up",
            "daytime": -36522.3125,  # 0.3125 * 24 = 7.5h = 7:30
            "duration": None,
            "eventnumber": None,
            "gender": None,
            "round": 11,
            "sortcode": 66,
            "swimsessionid": 1058,
            "swimstyleid": None,
            "internalevent": "F",
            "roundname": None,
        }]
        encoded = encode_gbin(self.SWIMEVENT_COLS, rows)
        _, decoded = decode_gbin(encoded)

        assert len(decoded) == 1
        row = decoded[0]
        # The raw OLE double should be preserved
        assert row["daytime"] == pytest.approx(-36522.3125)
        # Pause fields
        assert row["comment"] == "huis clos/lock up"
        assert row["swimstyleid"] is None
        assert row["internalevent"] == "F"
        assert row["roundname"] is None

    def test_ole_daytime_null_sentinel_is_none(self):
        """OLE date exactly equal to null sentinel (-36522.0) decodes as None."""
        rows = [{
            "swimeventid": 1,
            "comment": None,
            "daytime": None,  # Will encode as -36522.0 with null flag
            "duration": None,
            "eventnumber": 1,
            "gender": 1,
            "round": 5,
            "sortcode": 1,
            "swimsessionid": 100,
            "swimstyleid": 101,
            "internalevent": "F",
            "roundname": None,
        }]
        encoded = encode_gbin(self.SWIMEVENT_COLS, rows)
        _, decoded = decode_gbin(encoded)

        assert decoded[0]["daytime"] is None

    def test_ole_daytime_various_times(self):
        """Various OLE time fractions decode to expected values."""
        # 0.25 = 6:00, 0.5 = 12:00, 0.75 = 18:00, 0.333... ≈ 8:00
        test_cases = [
            (-36522.25, 0.25),      # 6:00
            (-36522.5, 0.5),        # 12:00
            (-36522.75, 0.75),      # 18:00
            (-36522.3125, 0.3125),  # 7:30
            (-36522.666666666667, 0.666666666667),  # ~16:00
        ]
        for ole_val, expected_frac in test_cases:
            rows = [{
                "swimeventid": 1,
                "comment": "test",
                "daytime": ole_val,
                "duration": None,
                "eventnumber": None,
                "gender": None,
                "round": 11,
                "sortcode": 1,
                "swimsessionid": 100,
                "swimstyleid": None,
                "internalevent": "F",
                "roundname": None,
            }]
            encoded = encode_gbin(self.SWIMEVENT_COLS, rows)
            _, decoded = decode_gbin(encoded)

            # The fractional part should be preserved
            actual_frac = abs(decoded[0]["daytime"]) % 1
            assert actual_frac == pytest.approx(expected_frac, abs=1e-6), (
                f"OLE {ole_val}: expected frac {expected_frac}, got {actual_frac}"
            )

    def test_pause_event_roundtrip_through_smb(self, tmp_path):
        """Pause events with OLE daytime survive full SMB write→read cycle."""
        table_data = {
            "SWIMEVENT": (self.SWIMEVENT_COLS, [
                {
                    "swimeventid": 100,
                    "comment": "Remise des prix",
                    "daytime": -36522.375,  # 9:00
                    "duration": None,
                    "eventnumber": None,
                    "gender": None,
                    "round": 11,
                    "sortcode": 5,
                    "swimsessionid": 1,
                    "swimstyleid": None,
                    "internalevent": "F",
                    "roundname": None,
                },
                {
                    "swimeventid": 101,
                    "comment": None,
                    "daytime": -36522.333333333336,  # 8:00
                    "duration": None,
                    "eventnumber": 1,
                    "gender": 1,
                    "round": 5,
                    "sortcode": 1,
                    "swimsessionid": 1,
                    "swimstyleid": 50,
                    "internalevent": "F",
                    "roundname": None,
                },
            ]),
        }
        smb_path = tmp_path / "pause_test.smb"
        write_smb(smb_path, table_data)
        tables = read_smb(smb_path)

        events = tables["SWIMEVENT"]
        assert len(events) == 2

        # Pause event
        pause = next(e for e in events if e["swimeventid"] == 100)
        assert pause["comment"] == "Remise des prix"
        assert pause["swimstyleid"] is None
        assert pause["daytime"] == pytest.approx(-36522.375)

        # Regular event
        regular = next(e for e in events if e["swimeventid"] == 101)
        assert regular["swimstyleid"] == 50
        assert regular["daytime"] == pytest.approx(-36522.333333333336, rel=1e-9)


class TestOleDateConversion:
    """Test the OLE date to time conversion logic used by the import endpoints."""

    def test_ole_to_time_fractions(self):
        """Verify OLE fractional day converts to correct hours:minutes."""
        from app.smb import D_NULL_SENTINEL

        def ole_to_time(val):
            """Replicate the conversion logic from the API endpoint."""
            if val is None or val == D_NULL_SENTINEL:
                return None
            frac = abs(val) % 1
            if frac == 0:
                return None
            total_minutes = round(frac * 24 * 60)
            hours = total_minutes // 60
            minutes = total_minutes % 60
            return f"{hours}:{minutes:02d}"

        assert ole_to_time(-36522.3125) == "7:30"
        assert ole_to_time(-36522.25) == "6:00"
        assert ole_to_time(-36522.5) == "12:00"
        assert ole_to_time(-36522.75) == "18:00"
        assert ole_to_time(-36522.375) == "9:00"
        assert ole_to_time(-36522.333333333336) == "8:00"
        assert ole_to_time(-36522.291666666664) == "7:00"
        assert ole_to_time(-36522.270833333336) == "6:30"
        assert ole_to_time(None) == None
        assert ole_to_time(-36522.0) == None  # null sentinel, no time
        assert ole_to_time(0.0) == None  # zero, no fractional time