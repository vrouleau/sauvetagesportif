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

"""Unit tests for schema correctness after dual-schema removal.

Verifies that:
- Base.metadata.tables does NOT contain 'club' or 'athlete' keys
- SwimResult.athleteid FK references members.membersid

Run: `pytest tests/unit/test_schema.py -v`
"""
from __future__ import annotations

import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimResult
from app import models_team  # noqa: F401 — ensure all models are registered


class TestSchemaCleanup:
    """Verify old dual-schema tables are removed from metadata."""

    def test_club_table_not_in_metadata(self):
        """The old 'club' table must not exist in Base.metadata.tables."""
        assert "club" not in Base.metadata.tables

    def test_athlete_table_not_in_metadata(self):
        """The old 'athlete' table must not exist in Base.metadata.tables."""
        assert "athlete" not in Base.metadata.tables


class TestSwimResultFK:
    """Verify SwimResult.athleteid FK points to members.membersid."""

    def test_athleteid_fk_references_members_membersid(self):
        """SwimResult.athleteid foreign key must reference members.membersid."""
        fk_set = SwimResult.__table__.c.athleteid.foreign_keys
        assert len(fk_set) == 1
        fk = next(iter(fk_set))
        assert fk.target_fullname == "members.membersid"