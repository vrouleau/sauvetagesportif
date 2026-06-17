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

"""Unit tests for OLE date conversion in the team-app.

Covers: ole_to_datetime, ole_to_date_only (from api.py SMB upload),
        and gbin encode/decode roundtrip for date columns.

Run: pytest tests/unit/test_date_conversion.py -v
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.smb import ColDef, decode_gbin, encode_gbin, D_NULL_SENTINEL


# ── OLE epoch ──────────────────────────────────────────────────────────────────
OLE_EPOCH = datetime(1899, 12, 30)


# ── Re-implement the conversion functions from api.py for direct testing ───────

def ole_to_datetime(val):
    """Convert OLE Automation date double to full Python datetime, or None."""
    if val is None:
        return None
    if not isinstance(val, (int, float)):
        return None
    if val == D_NULL_SENTINEL or val == 0:
        return None
    int_part = int(val)
    if int_part == -36522 or int_part == 0:
        # Time-only: extract fractional part as time of day
        frac = abs(val) % 1
        if frac == 0:
            return None
        total_minutes = round(frac * 24 * 60)
        hours = total_minutes // 60
        minutes = total_minutes % 60
        return datetime(2000, 1, 1, hours, minutes, 0)
    # Full date+time
    dt = OLE_EPOCH + timedelta(days=val)
    if dt.year < 1900 or dt.year > 2100:
        return None
    return dt


def ole_to_date_only(val):
    """Convert OLE Automation date double to a date-only datetime, or None."""
    if val is None:
        return None
    if not isinstance(val, (int, float)):
        return None
    if val == D_NULL_SENTINEL or val == 0 or val <= 0:
        return None
    dt = OLE_EPOCH + timedelta(days=int(val))
    if dt.year < 1900 or dt.year > 2100:
        return None
    return dt


# ── Tests: ole_to_datetime ─────────────────────────────────────────────────────

class TestOleToDatetime:
    """Test the ole_to_datetime function used during SMB upload."""

    def test_time_only_with_null_sentinel_date(self):
        """OLE value with null sentinel date part extracts time correctly."""
        # -36522.333... = 8:00 AM
        result = ole_to_datetime(-36522.333333333336)
        assert result == datetime(2000, 1, 1, 8, 0, 0)

    def test_time_only_various(self):
        """Various time-only OLE values."""
        assert ole_to_datetime(-36522.25) == datetime(2000, 1, 1, 6, 0, 0)
        assert ole_to_datetime(-36522.375) == datetime(2000, 1, 1, 9, 0, 0)
        assert ole_to_datetime(-36522.5) == datetime(2000, 1, 1, 12, 0, 0)
        assert ole_to_datetime(-36522.75) == datetime(2000, 1, 1, 18, 0, 0)

    def test_full_date_time(self):
        """OLE value with real date part converts to full datetime."""
        # 46188.333... = 2026-06-15 ~08:00
        result = ole_to_datetime(46188.333333333336)
        assert result is not None
        assert result.year == 2026
        assert result.month == 6
        assert result.day == 15
        assert result.hour == 8

    def test_full_date_no_time(self):
        """OLE value with real date but no time fraction."""
        # 46188.0 = 2026-06-15 00:00:00
        result = ole_to_datetime(46188.0)
        assert result is not None
        assert result.year == 2026
        assert result.month == 6
        assert result.day == 15
        assert result.hour == 0

    def test_null_sentinel_returns_none(self):
        """Null sentinel (-36522.0) returns None."""
        assert ole_to_datetime(D_NULL_SENTINEL) is None
        assert ole_to_datetime(-36522.0) is None

    def test_zero_returns_none(self):
        """Zero returns None."""
        assert ole_to_datetime(0) is None
        assert ole_to_datetime(0.0) is None

    def test_none_returns_none(self):
        """None input returns None."""
        assert ole_to_datetime(None) is None

    def test_non_numeric_returns_none(self):
        """Non-numeric input returns None."""
        assert ole_to_datetime("hello") is None
        assert ole_to_datetime("2026-06-15") is None

    def test_out_of_range_returns_none(self):
        """Dates outside 1900-2100 return None."""
        # Very large OLE value
        assert ole_to_datetime(999999) is None


# ── Tests: ole_to_date_only ────────────────────────────────────────────────────

class TestOleToDateOnly:
    """Test the ole_to_date_only function for startdate fields."""

    def test_valid_date(self):
        """Positive OLE double converts to correct date."""
        # 46188 = 2026-06-15
        result = ole_to_date_only(46188)
        assert result is not None
        assert result.year == 2026
        assert result.month == 6
        assert result.day == 15

    def test_birthdate_conversion(self):
        """Birthdate OLE double converts correctly."""
        # 28725 = 1978-08-23
        result = ole_to_date_only(28725)
        assert result is not None
        assert result.year == 1978
        assert result.month == 8
        assert result.day == 23

    def test_null_sentinel_returns_none(self):
        """Null sentinel returns None."""
        assert ole_to_date_only(D_NULL_SENTINEL) is None

    def test_zero_returns_none(self):
        """Zero returns None."""
        assert ole_to_date_only(0) is None

    def test_negative_returns_none(self):
        """Negative values return None."""
        assert ole_to_date_only(-100) is None
        assert ole_to_date_only(-36522) is None

    def test_none_returns_none(self):
        """None input returns None."""
        assert ole_to_date_only(None) is None

    def test_fractional_part_ignored(self):
        """Only integer part is used (time component discarded)."""
        result = ole_to_date_only(46188.75)
        assert result is not None
        assert result.year == 2026
        assert result.month == 6
        assert result.day == 15
        assert result.hour == 0  # time discarded


# ── Tests: gbin date roundtrip ─────────────────────────────────────────────────

class TestGbinDateRoundtrip:
    """Verify date values survive gbin encode/decode cycle."""

    COLS = [
        ColDef("id", "I", 32),
        ColDef("birthdate", "D", 32),
        ColDef("startdate", "D", 32),
    ]

    def test_real_dates_roundtrip(self):
        """Real OLE dates survive encode/decode."""
        rows = [
            {"id": 1, "birthdate": 28725.0, "startdate": 46188.0},
            {"id": 2, "birthdate": 40247.0, "startdate": 46201.5},
        ]
        encoded = encode_gbin(self.COLS, rows)
        _, decoded = decode_gbin(encoded)

        assert decoded[0]["birthdate"] == 28725.0
        assert decoded[0]["startdate"] == 46188.0
        assert decoded[1]["birthdate"] == 40247.0
        assert decoded[1]["startdate"] == pytest.approx(46201.5)

    def test_null_dates_roundtrip(self):
        """Null dates survive encode/decode."""
        rows = [
            {"id": 1, "birthdate": None, "startdate": None},
        ]
        encoded = encode_gbin(self.COLS, rows)
        _, decoded = decode_gbin(encoded)

        assert decoded[0]["birthdate"] is None
        assert decoded[0]["startdate"] is None

    def test_time_only_dates_roundtrip(self):
        """Time-only OLE values (null sentinel + fraction) survive."""
        rows = [
            {"id": 1, "birthdate": 28725.0, "startdate": -36522.375},  # 9:00 AM
        ]
        encoded = encode_gbin(self.COLS, rows)
        _, decoded = decode_gbin(encoded)

        assert decoded[0]["birthdate"] == 28725.0
        assert decoded[0]["startdate"] == pytest.approx(-36522.375)

    def test_sentinel_as_real_value(self):
        """D_NULL_SENTINEL stored as real value (flag=0x00) is preserved."""
        rows = [
            {"id": 1, "birthdate": D_NULL_SENTINEL, "startdate": D_NULL_SENTINEL},
        ]
        encoded = encode_gbin(self.COLS, rows)
        _, decoded = decode_gbin(encoded)

        # The sentinel stored as a real value should come back as the sentinel
        assert decoded[0]["birthdate"] == D_NULL_SENTINEL
        assert decoded[0]["startdate"] == D_NULL_SENTINEL


# ── Tests: full pipeline simulation ────────────────────────────────────────────

class TestFullPipeline:
    """Simulate the full SMB → PG → SMB roundtrip for dates."""

    def test_smb_to_pg_to_smb_birthdate(self):
        """Birthdate: OLE double → ole_to_date_only → datetime → back to OLE."""
        # Step 1: SMB decode gives us OLE double
        ole_val = 28725.0  # 1978-08-23

        # Step 2: Convert to datetime for PG (what api.py does)
        pg_datetime = ole_to_date_only(ole_val)
        assert pg_datetime is not None
        assert pg_datetime.year == 1978
        assert pg_datetime.month == 8
        assert pg_datetime.day == 23

        # Step 3: Convert back to OLE for SMB export
        back_to_ole = (pg_datetime - OLE_EPOCH).days
        assert back_to_ole == 28725

    def test_smb_to_pg_to_smb_daytime(self):
        """Daytime (time-only): OLE sentinel+frac → datetime → back to OLE."""
        # Step 1: SMB decode gives us OLE double with null sentinel date
        ole_val = -36522.375  # 9:00 AM (abs % 1 = 0.375)

        # Step 2: Convert to datetime for PG
        pg_datetime = ole_to_datetime(ole_val)
        assert pg_datetime is not None
        assert pg_datetime.hour == 9
        assert pg_datetime.minute == 0

        # Step 3: Verify the time extraction is correct
        # For time-only fields, the convention is to store with null sentinel date.
        # The fractional part 0.375 = 9/24 = 9:00 AM
        frac = (pg_datetime.hour * 60 + pg_datetime.minute) / (24 * 60)
        assert frac == pytest.approx(0.375, abs=1e-6)

    def test_smb_to_pg_to_smb_full_datetime(self):
        """Full date+time: OLE double → datetime → back to OLE."""
        ole_val = 46188.5  # 2026-06-15 12:00

        pg_datetime = ole_to_datetime(ole_val)
        assert pg_datetime is not None
        assert pg_datetime.year == 2026
        assert pg_datetime.month == 6
        assert pg_datetime.day == 15
        assert pg_datetime.hour == 12

        # Convert back
        back_to_ole = (pg_datetime - OLE_EPOCH).total_seconds() / 86400
        assert back_to_ole == pytest.approx(46188.5, abs=1e-4)