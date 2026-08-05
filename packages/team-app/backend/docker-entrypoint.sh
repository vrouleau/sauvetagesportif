#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
#
# Runs pending schema migrations (app/migrations/) as a separate process
# before handing off to the backend's own CMD. See docs/CONCURRENT_MEETS_PLAN.md.
set -e
python -m app.migrations.run
exec "$@"
