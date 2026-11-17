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

"""Tests: find_new_swimstyles flags LXF style ids outside the known 5xx/6xx
series (config/swimstyle-ranges.json) or not yet in the catalog."""
from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimStyle
from app import models_team  # noqa: F401 — registers cross-schema FK targets
from app.swimstyle_check import (
    describe_new_swimstyles, find_new_swimstyles, mixed_meet_types, style_meet_type,
)


def _make_db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _make_db_with_baseline():
    """A db with one established style — past the empty-catalog bootstrap
    exemption, so the diff logic actually runs."""
    db = _make_db()
    db.add(SwimStyle(swimstyleid=1, name="Baseline Style", distance=1, relaycount=1))
    db.commit()
    return db


def test_no_styles_returns_empty():
    db = _make_db()
    assert find_new_swimstyles(db, []) == []


def test_all_styles_already_known_returns_empty():
    db = _make_db()
    db.add(SwimStyle(swimstyleid=501, name="50m Freestyle", distance=50, relaycount=1))
    db.commit()
    result = find_new_swimstyles(db, [(501, "50m Freestyle", 50)])
    assert result == []


def test_unknown_in_range_style_is_reported_as_not_in_catalog():
    db = _make_db_with_baseline()
    result = find_new_swimstyles(db, [(520, "Mystery Style", 100)])
    assert result == [{"id": 520, "name": "Mystery Style", "distance": 100, "reason": "not_in_catalog"}]


def test_mix_of_known_and_unknown():
    db = _make_db()
    db.add(SwimStyle(swimstyleid=501, name="50m Freestyle", distance=50, relaycount=1))
    db.commit()
    result = find_new_swimstyles(db, [
        (501, "50m Freestyle", 50),
        (999, "Mystery Style", 100),
        (520, "Another New Style", 200),
    ])
    assert result == [
        {"id": 520, "name": "Another New Style", "distance": 200, "reason": "not_in_catalog"},
        {"id": 999, "name": "Mystery Style", "distance": 100, "reason": "out_of_range"},
    ]


def test_duplicate_unknown_ids_deduplicated():
    db = _make_db_with_baseline()
    result = find_new_swimstyles(db, [
        (520, "Mystery Style", 100),
        (520, "Mystery Style", 100),
    ])
    assert result == [{"id": 520, "name": "Mystery Style", "distance": 100, "reason": "not_in_catalog"}]


def test_falsy_ids_ignored():
    """id=0 marks pause/break placeholders in Lenex — must not be reported."""
    db = _make_db()
    result = find_new_swimstyles(db, [(0, "", 0), (None, None, None)])
    assert result == []


def test_missing_name_falls_back_to_generated_label():
    db = _make_db_with_baseline()
    result = find_new_swimstyles(db, [(520, "", 0)])
    assert result == [{"id": 520, "name": "Style 520", "distance": 0, "reason": "not_in_catalog"}]


def test_empty_catalog_is_bootstrap_for_in_range_styles():
    """A brand new install's first meet upload sees an empty catalog — every
    style in the file is technically 'new', but there's nothing established
    yet to protect, so in-range styles aren't reported."""
    db = _make_db()
    result = find_new_swimstyles(db, [
        (501, "50m Freestyle", 50),
        (602, "Beach Flags", 0),
    ])
    assert result == []


def test_non_empty_catalog_still_warns_even_if_unrelated_style_known():
    """Once the catalog has at least one row, the bootstrap exemption no
    longer applies — genuinely new ids must be reported."""
    db = _make_db()
    db.add(SwimStyle(swimstyleid=501, name="50m Freestyle", distance=50, relaycount=1))
    db.commit()
    result = find_new_swimstyles(db, [(530, "SERC", 0)])
    assert result == [{"id": 530, "name": "SERC", "distance": 0, "reason": "not_in_catalog"}]


# ── Known-series range check ────────────────────────────────────────────────

def test_out_of_range_reported_even_on_empty_catalog():
    """The bootstrap exemption covers the catalog diff only — a stale id is
    never one of our templates' styles, first upload or not."""
    db = _make_db()
    result = find_new_swimstyles(db, [(501, "ok", 50), (538, "4x50 Relais Medley", 50)])
    assert result == [{"id": 538, "name": "4x50 Relais Medley", "distance": 50, "reason": "out_of_range"}]


def test_out_of_range_reported_even_if_already_in_catalog():
    """A polluted catalog must not launder a stale id."""
    db = _make_db()
    db.add(SwimStyle(swimstyleid=540, name="Old relay", distance=50, relaycount=4))
    db.commit()
    result = find_new_swimstyles(db, [(540, "Old relay", 50)])
    assert [r["reason"] for r in result] == ["out_of_range"]


def test_range_boundaries():
    assert style_meet_type(499) is None
    assert style_meet_type(500) == "POOL"
    assert style_meet_type(531) == "POOL"
    assert style_meet_type(532) is None
    assert style_meet_type(600) is None
    assert style_meet_type(601) == "BEACH"
    assert style_meet_type(624) == "BEACH"
    assert style_meet_type(625) is None
    assert style_meet_type(0) is None
    assert style_meet_type(None) is None


def test_mixed_meet_types():
    assert mixed_meet_types([501, 530, 0, None]) is False
    assert mixed_meet_types([601, 624]) is False
    assert mixed_meet_types([501, 601]) is True
    # out-of-range ids don't count as either type
    assert mixed_meet_types([501, 999]) is False


def test_describe_counts_each_reason():
    msg = describe_new_swimstyles([
        {"id": 999, "reason": "out_of_range"},
        {"id": 520, "reason": "not_in_catalog"},
        {"id": 521, "reason": "not_in_catalog"},
    ])
    assert "1 swimstyle id(s) in this file are outside the known series" in msg
    assert "pool 500-531" in msg and "beach 601-624" in msg
    assert "2 swimstyle id(s) in this file are not in the local catalog" in msg
