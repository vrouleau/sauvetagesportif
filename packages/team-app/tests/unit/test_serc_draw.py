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

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models_serc import SercDisqualification, SercScore  # noqa: E402
from app.routers.serc import _clear_draw_results  # noqa: E402


class QuerySpy:
    def __init__(self, db, model):
        self.db = db
        self.model = model
        self.filters = []

    def filter(self, *conditions):
        self.filters.extend(conditions)
        return self

    def delete(self, synchronize_session=False):
        self.db.deletions.append((self.model, self.filters, synchronize_session))
        return self.db.deleted_counts[self.model]


class SessionSpy:
    def __init__(self):
        self.deleted_counts = {SercScore: 4, SercDisqualification: 1}
        self.deletions = []

    def query(self, model):
        return QuerySpy(self, model)


def test_redrawing_clears_only_scores_and_disqualifications_for_that_draw():
    db = SessionSpy()

    removed = _clear_draw_results(db, config_id=7, draw_number=2)

    assert removed == (4, 1)
    assert [model for model, _, _ in db.deletions] == [SercScore, SercDisqualification]
    for model, conditions, synchronize_session in db.deletions:
        assert [(condition.left.key, condition.right.value) for condition in conditions] == [
            ("config_id", 7),
            ("draw_number", 2),
        ]
        assert synchronize_session is False
