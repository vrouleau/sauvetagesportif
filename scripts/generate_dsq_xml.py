#!/usr/bin/env python3
"""Generate a Splash Meet Manager disqualification XML file from dsq-codes.json.

Usage:
    python generate_dsq_xml.py [--lang fr|en] [--type pool|beach] [--output FILE]

Options:
    --lang      Language for DSQ names (default: fr)
    --type      Meet type: pool or beach (default: pool)
    --output    Output file path (default: ../config/dsq.xml)
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape


SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DSQ_CODES_FILE = CONFIG_DIR / "dsq-codes.json"

SPLASH_APP = "Meet Manager 11"
SPLASH_VERSION = "11.84087"
ENCODING = "Windows-1252"


def load_dsq_codes(meet_type: str) -> list[dict]:
    """Load DSQ codes from JSON for the given meet type."""
    with open(DSQ_CODES_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    if meet_type not in data:
        raise ValueError(
            f"Unknown meet type '{meet_type}'. Available: {list(data.keys())}"
        )

    return data[meet_type]


def escape_xml_attr(value: str) -> str:
    """Escape a string for use in an XML attribute value."""
    return escape(value, entities={"'": "&apos;", '"': "&quot;"})


def generate_dsq_xml(codes: list[dict], lang: str) -> str:
    """Generate the Splash DSQ XML content."""
    name_key = f"name_{lang}"
    timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

    lines = []
    lines.append(f'<?xml version="1.0" encoding="{ENCODING}"?>')
    lines.append(
        f'<SPLASH application="{SPLASH_APP}" version="{SPLASH_VERSION}" '
        f'created="{timestamp}">'
    )
    lines.append("  <DSQITEMS>")

    for order, entry in enumerate(codes, start=1):
        code = escape_xml_attr(entry["code"])
        lenexcode = escape_xml_attr(entry["code"])
        name = escape_xml_attr(entry[name_key])
        options = escape_xml_attr(entry["options"])

        lines.append(
            f'    <DSQITEM code="{code}" lenexcode="{lenexcode}" '
            f'name="{name}" options="{options}" order="{order}" />'
        )

    lines.append("  </DSQITEMS>")
    lines.append("</SPLASH>")
    lines.append("")  # trailing newline

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Generate Splash Meet Manager DSQ XML from dsq-codes.json"
    )
    parser.add_argument(
        "--lang",
        choices=["fr", "en"],
        default="fr",
        help="Language for DSQ code names (default: fr)",
    )
    parser.add_argument(
        "--type",
        choices=["pool", "beach"],
        default="pool",
        dest="meet_type",
        help="Meet type (default: pool)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help=f"Output file path (default: {CONFIG_DIR / 'dsq.xml'})",
    )
    args = parser.parse_args()

    output_path = args.output or CONFIG_DIR / "dsq.xml"

    codes = load_dsq_codes(args.meet_type)
    xml_content = generate_dsq_xml(codes, args.lang)

    # Encode to Windows-1252 for Splash compatibility
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="cp1252") as f:
        f.write(xml_content)

    print(f"Generated {output_path} ({len(codes)} DSQ codes, lang={args.lang}, type={args.meet_type})")


if __name__ == "__main__":
    main()
