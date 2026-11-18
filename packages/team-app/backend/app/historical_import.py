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


"""Admin "Import historical" — archive an older meet's results .lxf.

Thin entry point over lxf_to_team.archive_results_lxf (the one results
importer, shared with the Organizer "Import results" that closes a meet).
Admin-specific policy only:
- warns (needs_force) when the file looks like the open meet — that one is
  closed with "Import results" instead;
- asks for confirmation (needs_force) before replacing a meet that is
  already archived.
`force=True` skips every warning.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from .lxf_to_team import archive_results_lxf, _read_lef_xml, _parse_meet
from .meet_config import get_active_meetsid, _get_meet_config


def import_historical_meet(db: Session, file_bytes: bytes, force: bool = False) -> dict:
    """Import a results LXF as a historical meet (see archive_results_lxf).

    Returns the import counts, or {"needs_force": True, "warning": ...} when a
    warning needs confirming (retry with force=True).
    """
    if not force:
        meet_name = _parse_meet(_read_lef_xml(file_bytes))["name"]
        current_meet_name = _get_meet_config(db, get_active_meetsid(db), "meet_name")
        if current_meet_name and meet_name.strip().lower() == current_meet_name.strip().lower():
            return {
                "warning": (
                    f"This LXF appears to be your current meet ('{meet_name}'). "
                    f"Use the results import on the Invitation page instead. "
                    f"Pass force=true to override."
                ),
                "meet_name": meet_name,
                "needs_force": True,
            }
    return archive_results_lxf(db, file_bytes, force=force, confirm_replace=True)
