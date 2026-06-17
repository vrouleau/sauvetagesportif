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

"""Generate PNG diagrams from PlantUML source files using the Kroki API."""
import json
import urllib.request
from pathlib import Path

ASSETS_DIR = Path(__file__).parent
KROKI_URL = "https://kroki.io/plantuml/png"


def main():
    for puml_file in ASSETS_DIR.glob("*.puml"):
        png_file = puml_file.with_suffix(".png")
        print(f"Generating {png_file.name} from {puml_file.name}...")
        
        text = puml_file.read_text(encoding="utf-8")
        payload = json.dumps({"diagram_source": text}).encode("utf-8")
        
        req = urllib.request.Request(
            KROKI_URL,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (diagram-generator)",
                "Accept": "image/png",
            },
            method="POST",
        )
        
        try:
            response = urllib.request.urlopen(req, timeout=30)
            png_data = response.read()
            png_file.write_bytes(png_data)
            print(f"  OK {png_file.name} ({len(png_data):,} bytes)")
        except Exception as e:
            print(f"  FAILED: {e}")


if __name__ == "__main__":
    main()