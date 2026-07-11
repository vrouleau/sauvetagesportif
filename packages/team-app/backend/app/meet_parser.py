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

"""Parse a SPLASH meet export .lxf into event structure.

Used by both ebimport_splash and meetmanager-app to get event IDs,
agegroups, and swimstyles from the authoritative SPLASH export.
"""
from __future__ import annotations

import zipfile
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET  # noqa: F401
from defusedxml.ElementTree import fromstring as _ET_fromstring


@dataclass
class MeetAgeGroup:
    agegroupid: int
    agemin: int
    agemax: int


@dataclass
class MeetEvent:
    eventid: int
    number: int
    gender: str  # "F", "M", "X"
    round: str  # "TIM", "PRE", "FIN"
    event_type: str  # "MASTERS" or ""
    swimstyleid: int
    distance: int
    relaycount: int
    style_name: str
    fee_cents: int = 0
    agegroups: list[MeetAgeGroup] = field(default_factory=list)
    roundname: str = ""
    is_internal: bool = False

    @property
    def is_masters(self) -> bool:
        return self.event_type == "MASTERS"

    @property
    def is_prelim(self) -> bool:
        return self.round == "PRE"

    @property
    def gender_int(self) -> int:
        return {"M": 1, "F": 2, "X": 3}.get(self.gender, 0)


@dataclass
class MeetSession:
    number: int
    name: str
    events: list[MeetEvent] = field(default_factory=list)


@dataclass
class ParsedMeet:
    meet_name: str = ""
    course: str = ""
    masters: bool = False
    currency: str = ""
    age_base_date: str = ""  # AGEDATE value from Lenex (YYYY-MM-DD)
    meet_fees: dict[str, int] = field(default_factory=dict)
    sessions: list[MeetSession] = field(default_factory=list)

    @property
    def all_events(self) -> list[MeetEvent]:
        return [e for s in self.sessions for e in s.events]


def parse_meet_lxf(source) -> ParsedMeet:
    """Parse a meet .lxf (path, bytes, or file-like) into ParsedMeet.

    Accepts: Path, str (file path), bytes, or BytesIO.
    """
    if isinstance(source, (str, Path)):
        with open(source, "rb") as f:
            raw = f.read()
    elif isinstance(source, bytes):
        raw = source
    else:
        raw = source.read()

    # Unzip
    with zipfile.ZipFile(BytesIO(raw)) as z:
        lef_name = [n for n in z.namelist() if n.endswith(".lef")][0]
        xml_bytes = z.read(lef_name)

    root = _ET_fromstring(xml_bytes)
    meet = ParsedMeet()

    meet_el = root.find(".//MEET")
    if meet_el is not None:
        meet.meet_name = meet_el.get("name", "")
        meet.course = meet_el.get("course", "")
        meet.masters = meet_el.get("masters", "").upper() == "T"
        agedate_el = meet_el.find("AGEDATE")
        if agedate_el is not None:
            meet.age_base_date = agedate_el.get("value", "")
        for fee_el in meet_el.iterfind("FEES/FEE"):
            ftype = (fee_el.get("type") or "").upper()
            if not ftype:
                continue
            try:
                meet.meet_fees[ftype] = int(fee_el.get("value", 0))
            except (ValueError, TypeError):
                continue
            cur = fee_el.get("currency")
            if cur and not meet.currency:
                meet.currency = cur

    for session_el in root.iter("SESSION"):
        ses = MeetSession(
            number=int(session_el.get("number", 0)),
            name=session_el.get("name", ""),
        )
        for event_el in session_el.iter("EVENT"):
            style_el = event_el.find("SWIMSTYLE")
            fee_el = event_el.find("FEE")
            try:
                fee_cents = int(fee_el.get("value", 0)) if fee_el is not None else 0
            except (ValueError, TypeError):
                fee_cents = 0
            # A style-less SWIMSTYLE (code="ID0", no swimstyleid) marks a pause/break
            # event — this is how Splash represents it, in addition to our own
            # internalevent="T" attribute on EVENT.
            is_placeholder_style = style_el is not None and style_el.get("code") == "ID0"
            is_internal = event_el.get("internalevent", "").upper() == "T" or is_placeholder_style
            ev = MeetEvent(
                eventid=int(event_el.get("eventid", 0)),
                number=int(event_el.get("number", 0)),
                gender=event_el.get("gender", ""),
                round=event_el.get("round", "TIM"),
                event_type=event_el.get("type", ""),
                swimstyleid=0 if is_placeholder_style else (int(style_el.get("swimstyleid", 0)) if style_el is not None else 0),
                distance=int(style_el.get("distance", 0)) if style_el is not None else 0,
                relaycount=int(style_el.get("relaycount", 1)) if style_el is not None else 1,
                style_name=(style_el.get("name", "") if style_el is not None else ""),
                fee_cents=fee_cents,
                roundname=event_el.get("name", ""),
                is_internal=is_internal,
            )
            for ag_el in event_el.iter("AGEGROUP"):
                ev.agegroups.append(MeetAgeGroup(
                    agegroupid=int(ag_el.get("agegroupid", 0)),
                    agemin=int(ag_el.get("agemin", -1)),
                    agemax=int(ag_el.get("agemax", -1)),
                ))
            ses.events.append(ev)
        meet.sessions.append(ses)

    return meet