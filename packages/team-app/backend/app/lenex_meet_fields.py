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

"""Meet editor fields (MEETVALUES) <-> LENEX MEET header, both directions.

The mapping is data: config/lenex-meet-fields.json, shared with meet-app's
src/main/lenexMeetFields.ts — every field LENEX has a place for travels the
way Splash Team Manager / Meet Manager exchange it (MEET attributes, POOL,
FACILITY, QUALIFY, CONTACT, FEES). The Meet Manager settings LENEX can't
carry (seeding, heats…) travel in the hidden `.meetvalues` zip entry.

MEETVALUES values here are typed Splash strings: {KEY: "TYPE;value"}.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement

_CONFIG_ENV = "LENEX_MEET_FIELDS_PATH"
_CONFIG_FILENAME = "lenex-meet-fields.json"
# Child elements of MEET written in this order (after AGEDATE, before SESSIONS)
_CHILD_ORDER = ("POOL", "FACILITY", "QUALIFY", "CONTACT", "FEES")


def _config_path() -> Path:
    override = os.environ.get(_CONFIG_ENV)
    if override:
        return Path(override)
    # Docker image: COPY config/lenex-meet-fields.json . (backend/Dockerfile)
    docker_path = Path(__file__).resolve().parent.parent / _CONFIG_FILENAME
    if docker_path.exists():
        return docker_path
    # Local/dev: packages/team-app/backend/app -> repo root
    return Path(__file__).resolve().parents[4] / "config" / _CONFIG_FILENAME


@lru_cache(maxsize=1)
def _config() -> dict:
    with open(_config_path(), "r", encoding="utf-8") as f:
        return json.load(f)


def meet_fields() -> list[dict]:
    return _config()["fields"]


def dotfile_keys() -> frozenset[str]:
    return frozenset(_config()["dotfileKeys"])


def mapped_keys() -> frozenset[str]:
    return frozenset(f["key"] for f in meet_fields())


def parse_typed_meetvalues(blob: str | None) -> dict[str, str]:
    """MEETVALUES blob -> {KEY: "TYPE;value"}, dropping lines with no value."""
    out: dict[str, str] = {}
    for line in (blob or "").replace("\r", "").split("\n"):
        eq = line.find("=")
        if eq <= 0:
            continue
        typed = line[eq + 1:]
        semi = typed.find(";")
        if semi < 0 or not typed[semi + 1:].strip():
            continue
        out[line[:eq].strip()] = typed
    return out


def _value(typed: str) -> str:
    semi = typed.find(";")
    return (typed[semi + 1:] if semi >= 0 else typed).strip()


# ── value conversion ─────────────────────────────────────────────────────────

def _to_lenex(field: dict, value: str) -> str | None:
    if field.get("values"):
        return field["values"].get(value)
    if field.get("date"):
        digits = value.replace("-", "")
        return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}" if len(digits) >= 8 and digits[:8].isdigit() else None
    if field.get("cents"):
        try:
            return str(round(float(value.replace(",", ".")) * 100))
        except ValueError:
            return None
    return value


def _from_lenex(field: dict, value: str) -> str | None:
    if field.get("values"):
        reverse = {v: k for k, v in field["values"].items()}
        reverse.update(field.get("importAliases") or {})
        return reverse.get(value.upper())
    if field.get("date"):
        digits = value[:10].replace("-", "")
        return f"{digits}000000000" if len(digits) == 8 and digits.isdigit() else None
    if field.get("cents"):
        try:
            dollars = int(value) / 100
        except ValueError:
            return None
        return f"{dollars:.2f}".rstrip("0").rstrip(".")
    return value


# ── element helpers ──────────────────────────────────────────────────────────

def _find(meet_el: Element, el_path: str, match: dict | None) -> Element | None:
    if not el_path:
        return meet_el
    if el_path == "FEES/FEE":
        for fee in meet_el.iterfind("FEES/FEE"):
            if all((fee.get(k) or "").upper() == v.upper() for k, v in (match or {}).items()):
                return fee
        return None
    return meet_el.find(el_path)


def _find_or_create(meet_el: Element, el_path: str, match: dict | None) -> Element:
    found = _find(meet_el, el_path, match)
    if found is not None:
        return found
    if el_path == "FEES/FEE":
        fees = meet_el.find("FEES")
        if fees is None:
            fees = _insert_child(meet_el, "FEES")
        return SubElement(fees, "FEE", dict(match or {}))
    return _insert_child(meet_el, el_path)


def _insert_child(meet_el: Element, tag: str) -> Element:
    """New MEET child in Splash's order: after AGEDATE and the children that
    precede it in _CHILD_ORDER, before SESSIONS/CLUBS."""
    rank = _CHILD_ORDER.index(tag)
    pos = 0
    for i, ch in enumerate(list(meet_el)):
        if ch.tag == "AGEDATE" or (ch.tag in _CHILD_ORDER and _CHILD_ORDER.index(ch.tag) <= rank):
            pos = i + 1
    el = Element(tag)
    meet_el.insert(pos, el)
    return el


# ── public API ───────────────────────────────────────────────────────────────

def write_meet_header(meet_el: Element, meetvalues: dict[str, str], currency: str | None = None) -> None:
    """Write every mapped MEETVALUES field onto a MEET element (attributes and
    POOL/FACILITY/QUALIFY/CONTACT/FEES children). `meetvalues` is typed."""
    for field in meet_fields():
        typed = meetvalues.get(field["key"])
        if not typed:
            continue
        lenex = _to_lenex(field, _value(typed))
        if not lenex:
            continue
        for place in [field] + list(field.get("also") or []):
            el = _find_or_create(meet_el, place["el"], place.get("match"))
            el.set(place["attr"], lenex)
            if place["el"] == "FEES/FEE" and currency:
                el.set("currency", currency)


def read_meet_header(meet_el: Element | None) -> dict[str, str]:
    """Every mapped field a MEET element carries -> typed MEETVALUES."""
    out: dict[str, str] = {}
    if meet_el is None:
        return out
    for field in meet_fields():
        for place in [field] + list(field.get("also") or []):
            el = _find(meet_el, place["el"], place.get("match"))
            raw = (el.get(place["attr"]) or "").strip() if el is not None else ""
            if not raw:
                continue
            value = _from_lenex(field, raw)
            if value:
                out[field["key"]] = f"{field['type']};{value}"
                break
    return out


def dotfile_payload(meetvalues: dict[str, str]) -> str:
    """`.meetvalues` zip entry: the meet's settings LENEX can't carry."""
    keys = dotfile_keys()
    return json.dumps({k: v for k, v in meetvalues.items() if k in keys})


def read_dotfile(raw: bytes | str | None) -> dict[str, str]:
    """`.meetvalues` zip entry -> typed MEETVALUES (only the dotfile keys)."""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    keys = dotfile_keys()
    return {k: v for k, v in data.items()
            if k in keys and isinstance(v, str) and ";" in v and _value(v)}
