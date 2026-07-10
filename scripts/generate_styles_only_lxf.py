#!/usr/bin/env python3

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

"""
generate_styles_only_lxf.py — Strip a full meet template down to a minimal
"styles-only" template.

LENEX has no standalone swimstyle catalog: a style only exists in the file
because some <EVENT> references it via a <SWIMSTYLE> child. So a *literally*
event-less template can't carry any styles at all — importing it (e.g. via
"Create Pool/Beach meet") leaves the SwimStyle table empty, and every event
created afterward gets swimstyleid=NULL (which the UI then displays as a
pause, since it can't tell "no style assigned" from "this is a pause").

This script keeps the template importable and useful while minimizing the
event count: it extracts every distinct SWIMSTYLE from SOURCE.lxf (first
occurrence wins) and writes OUTPUT.lxf containing one bare event per unique
style — no age groups, all in a single session — so the swimstyle catalog is
fully seeded on import while the meet itself is otherwise empty.

Usage:
    python scripts/generate_styles_only_lxf.py SOURCE.lxf OUTPUT.lxf [--id-base N] [--session-name NAME]

Example (regenerate the real templates in place):
    python scripts/generate_styles_only_lxf.py config/template_pool.lxf config/template_pool.lxf --id-base 1065
    python scripts/generate_styles_only_lxf.py config/template_beach.lxf config/template_beach.lxf --id-base 6001
"""
from __future__ import annotations

import argparse
import io
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def _read_lef_xml(lxf_path: Path) -> str:
    with zipfile.ZipFile(lxf_path) as zf:
        lef_name = next((n for n in zf.namelist() if n.lower().endswith(".lef")), None)
        if not lef_name:
            raise ValueError(f"No .lef entry found in {lxf_path}")
        return zf.read(lef_name).decode("utf-8")


def _escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _attrs_xml(attrs: dict[str, str]) -> str:
    return "".join(f' {k}="{_escape(v)}"' for k, v in attrs.items() if v is not None)


def generate(source_path: Path, output_path: Path, id_base: int, session_name: str) -> int:
    xml_text = _read_lef_xml(source_path)
    root = ET.fromstring(xml_text)
    meet_el = root.find(".//MEET")
    if meet_el is None:
        raise ValueError(f"No MEET element found in {source_path}")

    # Collect unique swimstyles, first occurrence wins, ordered by swimstyleid.
    styles: dict[str, dict[str, str]] = {}
    for style_el in meet_el.iter("SWIMSTYLE"):
        sid = style_el.get("swimstyleid")
        if not sid or sid in styles:
            continue
        styles[sid] = dict(style_el.attrib)

    ordered = [styles[sid] for sid in sorted(styles, key=int)]

    # Preserve meet-level metadata (name/course/facility/pointtable/etc.) as-is.
    meet_attrs = dict(meet_el.attrib)
    agedate_el = meet_el.find("AGEDATE")
    facility_el = meet_el.find("FACILITY")
    pointtable_el = meet_el.find("POINTTABLE")
    constructor_el = root.find("CONSTRUCTOR")

    lines: list[str] = []
    lines.append('<?xml version="1.0" encoding="UTF-8"?>')
    lines.append('<LENEX revisiondate="2024-12-02" version="3.0">')
    if constructor_el is not None:
        lines.append("  " + ET.tostring(constructor_el, encoding="unicode").strip())
    lines.append("  <MEETS>")
    lines.append(f"    <MEET{_attrs_xml(meet_attrs)}>")
    if agedate_el is not None:
        lines.append("      " + ET.tostring(agedate_el, encoding="unicode").strip())
    if facility_el is not None:
        lines.append("      " + ET.tostring(facility_el, encoding="unicode").strip())
    if pointtable_el is not None:
        lines.append("      " + ET.tostring(pointtable_el, encoding="unicode").strip())
    lines.append("      <SESSIONS>")
    lines.append(f'        <SESSION daytime="08:00" name="{_escape(session_name)}" number="1">')
    lines.append("          <EVENTS>")
    for i, style in enumerate(ordered):
        eventid = id_base + i * 2
        lines.append(
            f'            <EVENT eventid="{eventid}" number="{i + 1}" order="{i + 1}" round="TIM" preveventid="-1">'
        )
        lines.append("              <SWIMSTYLE" + _attrs_xml(style) + " />")
        lines.append("            </EVENT>")
    lines.append("          </EVENTS>")
    lines.append("        </SESSION>")
    lines.append("      </SESSIONS>")
    lines.append("    </MEET>")
    lines.append("  </MEETS>")
    lines.append("</LENEX>")
    new_xml = "\n".join(lines) + "\n"

    lef_name = output_path.stem + ".lef"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(lef_name, new_xml)
    output_path.write_bytes(buf.getvalue())

    return len(ordered)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="Full meet template .lxf to extract styles from")
    parser.add_argument("output", type=Path, help="Output .lxf path (styles-only template)")
    parser.add_argument("--id-base", type=int, default=1000, help="Starting eventid for stub events (default: 1000)")
    parser.add_argument("--session-name", default="Styles", help="Name of the single stub session (default: Styles)")
    args = parser.parse_args()

    count = generate(args.source, args.output, args.id_base, args.session_name)
    print(f"Wrote {args.output} with {count} unique swimstyles ({args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
