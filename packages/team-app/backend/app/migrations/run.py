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

"""Entry point: `python -m app.migrations.run`.

Runs any pending schema migrations against the database configured via the
same DATABASE_URL / SQLITE_DB_PATH env vars app/database.py reads. Meant to
run as a separate process before the backend starts (see
backend/docker-entrypoint.sh) — not imported by the FastAPI app itself.
"""
from .runner import apply_pending


def upgrade_schema(engine) -> list[str]:
    """Bring a database to the current schema: what container startup does
    (this module's main() in docker-entrypoint.sh, then main.py's create_all).

    Also needed after POST /admin/restore-db: a backup taken before a schema
    change brings back the old schema (and its own schema_migrations rows),
    and nothing else re-runs migrations until the next restart — e.g. a
    pre-0006 backup made every results import fail with "no such table:
    athlete_best_times". Returns the migrations applied.
    """
    from ..models import Base
    from .. import models_team, models_live, models_serc  # noqa: F401 — register all tables

    engine.dispose()  # drop pooled connections to the pre-restore database
    ran = apply_pending(engine)
    Base.metadata.create_all(bind=engine)
    return ran


def main() -> None:
    from ..database import engine
    ran = apply_pending(engine)
    if ran:
        print(f"Applied {len(ran)} migration(s): {', '.join(ran)}")
    else:
        print("Schema up to date, no migrations to apply.")


if __name__ == "__main__":
    main()
