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

"""Prototype: generate a Hy-Tek Meet Manager .sd3 (SDIF v3) entries file
straight from a team-app SQLite database, for one meet by name.

This is the "hand-build one representative sample" step from
docs/HYTEK_EXPORT_RESEARCH.md — a throwaway tool to produce a file that can
be test-imported into a real Meet Manager install (File > Import > Entries),
NOT a production export path. See that doc for the format research, field
layout sources, and the list of known gaps this script inherits:

  - Individual entries only — no relay (E0/F0) support yet.
  - Pool meets only (Hy-Tek Meet Manager has no ranked/beach-event concept).
  - SERC (swimstyleid 530) is judged, not timed, and is skipped — same
    exclusion export.py already applies to the LENEX export.
  - team-app has no meet/club address fields, so B1/C1 address fields are
    left blank.
  - TEAM code (C1) has no real USA-Swimming LSC equivalent for our clubs;
    this script fabricates one ("QC" + club code), deduplicated per file.
  - Field widths/positions and the exact SD3 dialect Meet Manager expects
    have NOT been validated against a real Meet Manager install — treat
    the output as a first draft to test, not a trusted export.

Usage:
    python scripts/generate_hytek_sd3.py --db /path/to/meetmgr.db \\
        --meet "Compétition Provinciale" --output entries.sd3
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker, joinedload  # noqa: E402

from app.models import SwimResult, SwimEvent  # noqa: E402
from app.models_team import TeamClub, Member, Meet  # noqa: E402

RECORD_WIDTH = 200

# SERC (Simulated Emergency Response Competition) is judged, not timed — no
# SDIF representation, same exclusion export.py applies to the LENEX export.
SERC_STYLE_ID = 530


def _agegroup_for_code(age_groups, age_code: str, masters: bool):
    """Pick the AgeGroup row matching the registration's age_code.

    Copied from app/export.py rather than imported, so this script doesn't
    pull in FastAPI (export.py -> meet_config.py -> fastapi) for what's
    otherwise a plain read-only reporting tool.
    """
    if masters:
        return age_groups[0] if age_groups else None
    for ag in age_groups:
        if age_code == "10-" and ag.agemax == 10:
            return ag
        if age_code == "11-12" and ag.agemin == 11 and ag.agemax == 12:
            return ag
        if age_code == "13-14" and ag.agemin == 13 and ag.agemax == 14:
            return ag
        if age_code == "15-18" and ag.agemin == 15 and ag.agemax == 18:
            return ag
        if age_code == "Open" and ag.agemin == 19 and ag.agemax == -1:
            return ag
    return None

# team-app's meets.course encoding (see models_team.py) differs from SDIF's
# COURSE code table (013) — 1=LCM/2=SCY/3=SCM here vs 1|S=SCM/2|Y=SCY/3|L=LCM
# there. Map explicitly rather than reusing the raw integer.
_COURSE_TO_SD3 = {1: "L", 2: "Y", 3: "S"}


# ── Fixed-width record helpers ──────────────────────────────────────────────

def _line(fields: list[tuple[int, int, str]]) -> str:
    """Build one fixed-width record. fields = [(start_col, width, value), ...],
    start_col is 1-indexed to match the SDIF spec's own column numbering."""
    buf = [" "] * RECORD_WIDTH
    for start, width, value in fields:
        value = (value or "")[:width]
        buf[start - 1:start - 1 + len(value)] = list(value)
    return "".join(buf).rstrip()


def _txt(value: str | None) -> str:
    return value or ""


def _date(dt: datetime | None) -> str:
    return dt.strftime("%m%d%Y") if dt else ""


def _name(member: Member) -> str:
    return f"{member.lastname or ''}, {member.firstname or ''}"


def _sex(gender: int | None) -> str:
    return "F" if gender == 2 else "M"


def _event_sex(gender: int | None) -> str:
    # SwimEvent.gender: 0=All, 1=M, 2=F, 3=Mixed (relay only, not reachable
    # here since individual events never use it). SDIF's EVENT SEX code
    # (011) only has M/F/X — there's no "All" equivalent, so this is an
    # approximation flagged in docs/HYTEK_EXPORT_RESEARCH.md.
    return {1: "M", 2: "F"}.get(gender, "X")


def _age_range(agemin: int | None, agemax: int | None) -> str:
    lo = "UN" if not agemin or agemin <= 0 else f"{agemin:02d}"
    hi = "OV" if not agemax or agemax >= 99 or agemax == -1 else f"{agemax:02d}"
    return f"{lo}{hi}"


def _sd3_time(ms: int | None) -> str:
    if not ms:
        return "NT"
    total_cs = round(ms / 10)
    cs = total_cs % 100
    total_s = total_cs // 100
    s = total_s % 60
    m = total_s // 60
    return f"{m}:{s:02d}.{cs:02d}"


def _team_code(club: TeamClub, used: set[str]) -> str:
    """Fabricate a 6-char TEAM code (no real LSC concept for our clubs)."""
    base = "".join(ch for ch in (club.code or club.name or "CLUB").upper() if ch.isalnum())[:4]
    code = f"QC{base:0<4}"[:6]
    suffix = 0
    candidate = code
    while candidate in used:
        suffix += 1
        candidate = f"{code[:5]}{suffix}"[:6]
    used.add(candidate)
    return candidate


# ── Record builders (columns per docs/HYTEK_EXPORT_RESEARCH.md) ────────────

def a0_record(meet_name: str) -> str:
    return _line([
        (1, 2, "A0"),
        (3, 1, "1"),                      # ORG code — 1=USS, closest fit (see doc gaps)
        (4, 8, "V3"),
        (44, 20, "SauvetageTeam"),
        (64, 10, "prototype"),
        (106, 8, _date(datetime.utcnow())),
    ])


def b1_record(meet: Meet, sd3_course: str) -> str:
    return _line([
        (1, 2, "B1"),
        (3, 1, "1"),
        (12, 30, _txt(meet.name)),
        (122, 8, _date(meet.mindate)),
        (130, 8, _date(meet.maxdate)),
        (150, 1, sd3_course),
    ])


def c1_record(club: TeamClub, team_code: str) -> str:
    return _line([
        (1, 2, "C1"),
        (3, 1, "1"),
        (12, 6, team_code),
        (18, 30, _txt(club.name)),
        (48, 16, _txt(club.shortname or club.code)),
    ])


def d0_record(member: Member, event: SwimEvent, style, age_range: str,
              seed_ms: int | None, sd3_course: str) -> str:
    return _line([
        (1, 2, "D0"),
        (3, 1, "1"),
        (12, 28, _name(member)),
        (52, 1, "A"),                     # attach status — always "attached" for us
        (56, 8, _date(member.birthdate)),
        (66, 1, _sex(member.gender)),
        (67, 1, _event_sex(event.gender)),
        (68, 4, str(style.distance if style else 0)),
        (72, 1, str(style.stroke if style else 1)),
        (73, 4, str(event.eventnumber or 0)),
        (77, 4, age_range),
        (89, 8, _sd3_time(seed_ms)),
        (97, 1, sd3_course),
    ])


def d1_record(member: Member, team_code: str) -> str:
    return _line([
        (1, 2, "D1"),
        (3, 1, "1"),
        (12, 6, team_code),
        (19, 28, _name(member)),
        (64, 8, _date(member.birthdate)),
        (74, 1, _sex(member.gender)),
    ])


def z0_record(num_teams: int, num_swimmers: int, num_d_records: int) -> str:
    return _line([
        (1, 2, "Z0"),
        (3, 1, "1"),
        (44, 3, "1"),                     # # of B (meet) records
        (47, 3, "1"),                     # # of meets
        (50, 4, str(num_teams)),
        (54, 4, str(num_teams)),
        (58, 6, str(num_d_records)),
        (64, 6, str(num_swimmers)),
    ])


# ── Main ─────────────────────────────────────────────────────────────────

def build_sd3(db, meet: Meet) -> str:
    sd3_course = _COURSE_TO_SD3.get(meet.course, "L")

    regs = (
        db.query(SwimResult)
        .options(
            joinedload(SwimResult.member).joinedload(Member.club),
            joinedload(SwimResult.event).joinedload(SwimEvent.agegroups),
            joinedload(SwimResult.event).joinedload(SwimEvent.swimstyle),
        )
        .filter(SwimResult.meetsid == meet.meetsid)
        .all()
    )

    clubs_map: dict[int, dict] = {}
    for reg in regs:
        event = reg.event
        if event is None or event.swimstyleid == SERC_STYLE_ID:
            continue
        member = reg.member
        club = member.club
        clubs_map.setdefault(club.clubsid, {"club": club, "athletes": {}})
        athletes = clubs_map[club.clubsid]["athletes"]
        athletes.setdefault(member.membersid, {"member": member, "entries": []})
        athletes[member.membersid]["entries"].append(reg)

    lines = [a0_record(meet.name or ""), b1_record(meet, sd3_course)]

    used_codes: set[str] = set()
    team_codes: dict[int, str] = {}
    for club_data in clubs_map.values():
        club = club_data["club"]
        team_codes[club.clubsid] = _team_code(club, used_codes)
        lines.append(c1_record(club, team_codes[club.clubsid]))

    num_swimmers = 0
    num_d_records = 0
    for club_data in clubs_map.values():
        club = club_data["club"]
        team_code = team_codes[club.clubsid]
        for ath_data in club_data["athletes"].values():
            member = ath_data["member"]
            num_swimmers += 1
            for reg in ath_data["entries"]:
                event = reg.event
                style = event.swimstyle
                ag = _agegroup_for_code(event.agegroups, reg.age_code, event.masters == "T")
                age_range = _age_range(ag.agemin if ag else None, ag.agemax if ag else None)
                lines.append(d0_record(member, event, style, age_range, reg.entrytime, sd3_course))
                num_d_records += 1
            lines.append(d1_record(member, team_code))
            num_d_records += 1

    lines.append(z0_record(len(clubs_map), num_swimmers, num_d_records))
    return "\r\n".join(lines) + "\r\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", required=True, help="Path to the team-app SQLite database file")
    parser.add_argument("--meet", required=True, help="Meet name to export (case-insensitive substring match)")
    parser.add_argument("--output", default=None, help="Output .sd3 path (default: <meet-name>.sd3)")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        sys.exit(f"Database file not found: {db_path}")

    engine = create_engine(f"sqlite:///{db_path}")
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()

    meet = db.query(Meet).filter(Meet.name.ilike(f"%{args.meet}%")).order_by(Meet.meetsid.desc()).first()
    if meet is None:
        available = [m.name for m in db.query(Meet).all()]
        sys.exit(f"No meet matching {args.meet!r}. Available meets: {available}")

    if meet.meet_type == "BEACH":
        sys.exit(
            f"Meet {meet.name!r} is a BEACH meet — Hy-Tek Meet Manager is pool-only, "
            "this export path doesn't apply (see docs/HYTEK_EXPORT_RESEARCH.md)."
        )

    content = build_sd3(db, meet)
    db.close()

    out_path = Path(args.output) if args.output else Path(f"{meet.name}.sd3".replace(" ", "_"))
    out_path.write_text(content, encoding="ascii", errors="replace", newline="")
    print(f"Wrote {out_path} ({content.count(chr(10))} lines) for meet {meet.name!r} (meetsid={meet.meetsid})")


if __name__ == "__main__":
    main()
