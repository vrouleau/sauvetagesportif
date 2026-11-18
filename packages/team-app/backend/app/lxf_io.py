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

"""Reading uploaded Lenex .lxf files (a zip holding one .lef XML document)."""
from __future__ import annotations

import zipfile
from io import BytesIO
from xml.etree.ElementTree import Element

from defusedxml.ElementTree import fromstring as _safe_fromstring


def read_lef_xml(content: bytes) -> Element:
    """The .lef XML inside an .lxf zip, parsed with defusedxml (uploaded file:
    no entity expansion / external entities).

    Raises zipfile.BadZipFile when `content` isn't a zip, ValueError when the
    zip holds no .lef file.
    """
    with zipfile.ZipFile(BytesIO(content)) as z:
        lef_name = next((n for n in z.namelist() if n.endswith(".lef")), None)
        if lef_name is None:
            raise ValueError("no .lef file in the .lxf archive")
        xml_bytes = z.read(lef_name)
    return _safe_fromstring(xml_bytes)


def read_lxf_entry(content: bytes, name: str) -> bytes | None:
    """Another entry of an .lxf zip (e.g. the hidden `.meetvalues`), or None."""
    with zipfile.ZipFile(BytesIO(content)) as z:
        return z.read(name) if name in z.namelist() else None
