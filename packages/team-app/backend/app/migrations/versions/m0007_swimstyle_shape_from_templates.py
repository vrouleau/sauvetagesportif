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

"""Correct existing swimstyle distance/relaycount from the bundled templates.

Historical imports created styles with no distance and relaycount=1 (even
relays), and meet uploads only ever inserted new styles, so real databases
carry a half-empty catalog: throws can't be recognized (best_times.py treats
pool styles < 25 m as course-free) and relays like "Lancer de la corde" or
4x50 show up as individual events. Meet uploads now correct styles too
(events.correct_style_shape), but an open meet can't be re-uploaded without
losing its registrations — so apply the bundled pool and beach templates once.

Only existing rows are touched (no styles are added), with the same rules as
a meet upload: set a known distance, only *upgrade* relaycount. Idempotent;
a no-op on a fresh install (empty catalog) or when the templates are missing.
"""
from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import inspect
from sqlalchemy.orm import sessionmaker

NAME = "0007_swimstyle_shape_from_templates"

def _template_paths() -> list[Path]:
    # The container sets MEET_TEMPLATE_POOL/BEACH (backend/Dockerfile); in a
    # dev checkout fall back to the repo's config/ (backend/app/migrations/
    # versions/ is 6 levels below the repo root — not so in the container,
    # hence the guard).
    here = Path(__file__).resolve()
    config = here.parents[6] / "config" if len(here.parents) > 6 else None
    paths = []
    for env, name in (("MEET_TEMPLATE_POOL", "template_pool.lxf"), ("MEET_TEMPLATE_BEACH", "template_beach.lxf")):
        value = os.environ.get(env) or (str(config / name) if config else None)
        if value:
            paths.append(Path(value))
    return [p for p in paths if p.exists()]


def upgrade(engine) -> None:
    if "swimstyle" not in inspect(engine).get_table_names():
        return  # fresh install — nothing to correct
    from ...models import SwimStyle
    from ... import models_team, models_live, models_serc  # noqa: F401 — FK resolution
    from ...meet_parser import parse_meet_lxf
    from ...events import correct_style_shape

    db = sessionmaker(bind=engine)()
    try:
        for path in _template_paths():
            meet = parse_meet_lxf(path)
            for ses in meet.sessions:
                for ev in ses.events:
                    if not ev.swimstyleid:
                        continue
                    style = db.get(SwimStyle, ev.swimstyleid)
                    if style is not None:
                        correct_style_shape(style, ev.distance, ev.relaycount)
        db.commit()
    finally:
        db.close()
