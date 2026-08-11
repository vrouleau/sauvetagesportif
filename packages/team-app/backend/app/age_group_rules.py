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

"""Age-group reference-date resolution — mirrors meet-app's
src/main/ageGroupRules.ts. Both read config/age-group-rules.json; see that
file for the rule (Règlements des compétitions de sauvetage sportif au
Québec, Édition septembre 2025, §1.1-1.3)."""

import json
import os
from datetime import date
from functools import lru_cache
from pathlib import Path

_CONFIG_ENV = "AGE_GROUP_RULES_PATH"
_CONFIG_FILENAME = "age-group-rules.json"


def _config_path() -> Path:
    override = os.environ.get(_CONFIG_ENV)
    if override:
        return Path(override)
    # Docker image: COPY config/age-group-rules.json . lands it next to the
    # `app` package directory (see backend/Dockerfile), i.e. one level above
    # this file.
    docker_path = Path(__file__).resolve().parent.parent / _CONFIG_FILENAME
    if docker_path.exists():
        return docker_path
    # Local/dev fallback: actual monorepo layout (packages/team-app/backend/app -> repo root).
    return Path(__file__).resolve().parent.parent.parent.parent.parent / "config" / _CONFIG_FILENAME


@lru_cache(maxsize=1)
def _load_rules() -> dict:
    with open(_config_path(), "r", encoding="utf-8") as f:
        return json.load(f)


def _age_as_of(birthdate: date, ref_date: date) -> int:
    age = ref_date.year - birthdate.year
    if (ref_date.month, ref_date.day) < (birthdate.month, birthdate.day):
        age -= 1
    return age


def resolve_matching_age(birthdate: date, meet_type: str, season_year: int) -> int:
    """Age to use when matching an athlete's birthdate against an event's
    agemin/agemax brackets, per Règlements des compétitions de sauvetage
    sportif au Québec (Édition septembre 2025), §1.1-1.3:
    - 10 ans et moins / 11-12 ans: age at season start (1er septembre pool /
      1er mai beach), locked for the whole season — unless the athlete will
      turn 13 before year end, in which case they're bumped to 13-14 for the
      season instead of staying in 11-12.
    - 13-14 ans / 15-18 ans / Senior / Masters: age at 31 décembre of the
      season's start year (ILS rule), also locked for the whole season.
    """
    rules = _load_rules()
    ss = rules["seasonStartDate"][meet_type.upper()]
    ye = rules["yearEndDate"]
    age_at_season_start = _age_as_of(birthdate, date(season_year, ss["month"], ss["day"]))
    age_at_year_end = _age_as_of(birthdate, date(season_year, ye["month"], ye["day"]))
    if age_at_season_start <= 10:
        return age_at_season_start
    if age_at_season_start <= 12 and age_at_year_end < 13:
        return age_at_season_start
    return age_at_year_end
