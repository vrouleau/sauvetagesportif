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
"""Tests for backend/app/i18n.py and its catalogues (backend/app/locales/*.json)."""
from __future__ import annotations

import re
import string
from pathlib import Path

import pytest

from app import i18n

APP_DIR = Path(i18n.__file__).parent


def _placeholders(text: str) -> set[str]:
    return {name for _, name, _, _ in string.Formatter().parse(text) if name}


def test_every_language_defines_the_same_keys():
    langs = i18n.available_languages()
    assert {"fr", "en"} <= set(langs)
    reference = set(i18n.catalogue("fr"))
    for lang in langs:
        keys = set(i18n.catalogue(lang))
        assert keys == reference, (
            f"{lang}: missing {sorted(reference - keys)}, extra {sorted(keys - reference)}")


def test_translations_use_the_same_placeholders():
    fr = i18n.catalogue("fr")
    for lang in i18n.available_languages():
        for key, text in i18n.catalogue(lang).items():
            assert _placeholders(text) == _placeholders(fr[key]), f"{lang}:{key}"


def test_no_blank_translation():
    for lang in i18n.available_languages():
        for key, text in i18n.catalogue(lang).items():
            assert text.strip(), f"{lang}:{key} is empty"


def test_plural_keys_come_in_pairs():
    for lang in i18n.available_languages():
        keys = set(i18n.catalogue(lang))
        for key in keys:
            if key.endswith("_one"):
                assert key[:-4] + "_other" in keys, f"{lang}:{key}"
            if key.endswith("_other"):
                assert key[:-6] + "_one" in keys, f"{lang}:{key}"


def test_every_literal_key_used_in_code_exists():
    """`t("a.b", ...)` / `tn("a.b", ...)` with a literal key must be in the catalogue."""
    keys = set(i18n.catalogue("fr"))
    call = re.compile(r"""\bt(n?)\(\s*f?["']([a-z0-9_.]+)["']""")
    for path in list(APP_DIR.glob("*.py")) + list(APP_DIR.glob("routers/*.py")):
        if path.name == "i18n.py":
            continue
        for m in call.finditer(path.read_text(encoding="utf-8")):
            key = m.group(2)
            if m.group(1):  # tn(): plural base key
                assert f"{key}_one" in keys, f"{path.name}: {key}"
            else:
                assert key in keys, f"{path.name}: {key}"


def test_t_formats_params_and_falls_back_to_french():
    assert i18n.t("invoice.pdf.invoice", "en") == "INVOICE"
    assert i18n.t("invoice.pdf.invoice", "fr") == "FACTURE"
    assert i18n.t("invoice.pdf.invoice", "de") == "FACTURE"
    assert i18n.t("email.invoice.subject", "en", no="1", meet="M") == "Invoice 1 — M"


def test_tn_plural_rule():
    assert i18n.tn("invoice.line.individual", 1, "fr") == "1 individuelle"
    assert i18n.tn("invoice.line.individual", 2, "fr") == "2 individuelles"
    assert i18n.tn("invoice.line.relay", 1, "en") == "1 relay"
    assert i18n.tn("invoice.line.relay", 3, "en") == "3 relays"
    assert i18n.tn("invoice.line.relay", 3, "fr") == "3 relais"


def test_missing_key_raises():
    with pytest.raises(KeyError):
        i18n.t("no.such.key", "fr")
