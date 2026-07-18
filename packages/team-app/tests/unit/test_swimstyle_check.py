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

"""Tests: find_new_swimstyles diffs LXF style references against the catalog."""
from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimStyle
from app import models_team  # noqa: F401 — registers cross-schema FK targets
from app.swimstyle_check import find_new_swimstyles


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


def test_unknown_style_is_reported():
    db = _make_db_with_baseline()
    result = find_new_swimstyles(db, [(999, "Mystery Style", 100)])
    assert result == [{"id": 999, "name": "Mystery Style", "distance": 100}]


def test_mix_of_known_and_unknown():
    db = _make_db()
    db.add(SwimStyle(swimstyleid=501, name="50m Freestyle", distance=50, relaycount=1))
    db.commit()
    result = find_new_swimstyles(db, [
        (501, "50m Freestyle", 50),
        (999, "Mystery Style", 100),
        (998, "Another New Style", 200),
    ])
    assert result == [
        {"id": 998, "name": "Another New Style", "distance": 200},
        {"id": 999, "name": "Mystery Style", "distance": 100},
    ]


def test_duplicate_unknown_ids_deduplicated():
    db = _make_db_with_baseline()
    result = find_new_swimstyles(db, [
        (999, "Mystery Style", 100),
        (999, "Mystery Style", 100),
    ])
    assert result == [{"id": 999, "name": "Mystery Style", "distance": 100}]


def test_falsy_ids_ignored():
    """id=0 marks pause/break placeholders in Lenex — must not be reported."""
    db = _make_db()
    result = find_new_swimstyles(db, [(0, "", 0), (None, None, None)])
    assert result == []


def test_missing_name_falls_back_to_generated_label():
    db = _make_db_with_baseline()
    result = find_new_swimstyles(db, [(999, "", 0)])
    assert result == [{"id": 999, "name": "Style 999", "distance": 0}]


def test_empty_catalog_is_bootstrap_and_never_warns():
    """A brand new install's first meet upload sees an empty catalog — every
    style in the file is technically 'new', but there's nothing established
    yet to protect, so nothing should be reported."""
    db = _make_db()
    result = find_new_swimstyles(db, [
        (501, "50m Freestyle", 50),
        (502, "100m Freestyle", 100),
    ])
    assert result == []


def test_non_empty_catalog_still_warns_even_if_unrelated_style_known():
    """Once the catalog has at least one row, the bootstrap exemption no
    longer applies — genuinely new ids must be reported."""
    db = _make_db()
    db.add(SwimStyle(swimstyleid=501, name="50m Freestyle", distance=50, relaycount=1))
    db.commit()
    result = find_new_swimstyles(db, [(999, "Mystery Style", 100)])
    assert result == [{"id": 999, "name": "Mystery Style", "distance": 100}]
