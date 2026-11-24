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
"""Backend translations: one JSON catalogue per language in ``locales/``.

The backend twin of the frontends' ``i18n.ts`` / ``i18n.jsx``. Catalogues are
flat ``{"dotted.key": "text with {placeholders}"}`` maps, the same keys in every
language (``tests/unit/test_i18n.py`` enforces it). Wording lives only there —
code calls ``t("invoice.pdf.total", lang)`` instead of branching on ``lang``.

* ``t(key, lang, **params)`` — look up and ``str.format`` the text.
* ``tn(key, n, lang, **params)`` — plural: uses ``key_one`` when ``n <= 1``,
  else ``key_other`` (French and English both treat 0 as singular here, as the
  invoice wording always has); ``{n}`` is filled in.

An unknown language falls back to French, the app's default. A missing key
raises ``KeyError`` rather than printing a blank into an invoice.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

LOCALES_DIR = Path(__file__).parent / "locales"
DEFAULT_LANG = "fr"


def available_languages() -> list[str]:
    return sorted(p.stem for p in LOCALES_DIR.glob("*.json"))


@lru_cache(maxsize=None)
def catalogue(lang: str) -> dict[str, str]:
    """The whole catalogue for `lang` (falls back to the default language)."""
    path = LOCALES_DIR / f"{lang}.json"
    if not path.is_file():
        path = LOCALES_DIR / f"{DEFAULT_LANG}.json"
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def t(key: str, lang: str = DEFAULT_LANG, **params) -> str:
    text = catalogue(lang)[key]
    return text.format(**params) if params else text


def tn(key: str, n: int, lang: str = DEFAULT_LANG, **params) -> str:
    return t(f"{key}_{'one' if n <= 1 else 'other'}", lang, n=n, **params)
