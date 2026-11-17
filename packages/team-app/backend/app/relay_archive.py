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

"""Archive relay results from a results .lxf into the Team Manager relay tables.

Results files (meet-app's exportLenexResults, LENEX 3) carry each relay team's
result as CLUB > RELAYS > RELAY > RESULTS > RESULT, with the swimmers who swam it
as RELAYPOSITIONS (inside the RESULT, else at RELAY level) referencing the file's
ATHLETE@athleteid. Each one becomes a `relays` row (team total, status) under the
archived meet plus one `relayspos` row per member — Splash Team Manager's own
shape. best_times.get_relay_best_times credits every member with the team's
total; it suggests future relay entry times.

Used by both results importers (lxf_to_team.py, historical_import.py).
"""
from __future__ import annotations

from datetime import date, datetime
from xml.etree.ElementTree import Element

from sqlalchemy.orm import Session

from .models_team import Relay, RelayPos

# LENEX RESULT@status -> Splash resultstatus. Any other non-empty status
# (WDR, SICK, DNQ…) means no valid time either: stored as DNS.
RELAY_RESULT_STATUS = {"DNS": 1, "DNF": 2, "DSQ": 3, "EXH": 4}

_GENDER = {"M": 1, "F": 2, "MIXED": 3, "X": 3, "ALL": 0}


def delete_archived_relays(db: Session, meet_id: int) -> None:
    """Remove a meet's archived relays (re-import replaces them)."""
    ids = [rid for (rid,) in db.query(Relay.relaysid).filter(Relay.meetsid == meet_id).all()]
    if ids:
        db.query(RelayPos).filter(RelayPos.relaysid.in_(ids)).delete(synchronize_session=False)
        db.query(Relay).filter(Relay.relaysid.in_(ids)).delete(synchronize_session=False)
        db.flush()


def archive_club_relays(
    db: Session,
    club_el: Element,
    *,
    club_id: int,
    meet_id: int,
    meet_date: date | datetime | None,
    course: int,
    event_style: dict[str, int | None],
    event_number: dict[str, int],
    athlete_members: dict[str, int],
) -> tuple[int, set[int]]:
    """Archive one CLUB's relay results. Returns (relays archived, member ids)."""
    from .lxf_to_team import _lenex_time_to_ms  # lazy: lxf_to_team imports this module
    archived = 0
    members_seen: set[int] = set()
    relays_el = club_el.find("RELAYS")
    if relays_el is None:
        return 0, members_seen

    for relay_el in relays_el.findall("RELAY"):
        results_el = relay_el.find("RESULTS")
        if results_el is None:
            continue
        for res_el in results_el.findall("RESULT"):
            eid = res_el.get("eventid") or ""
            style_id = event_style.get(eid)
            if not style_id:
                continue
            swimtime = _lenex_time_to_ms(res_el.get("swimtime"))
            status_str = (res_el.get("status") or "").upper()
            status = RELAY_RESULT_STATUS.get(status_str, 1) if status_str else None
            if not swimtime and status is None:
                continue  # no result

            positions_el = res_el.find("RELAYPOSITIONS")
            if positions_el is None:
                positions_el = relay_el.find("RELAYPOSITIONS")
            positions: list[tuple[int, int]] = []
            if positions_el is not None:
                for pos_el in positions_el.findall("RELAYPOSITION"):
                    try:
                        numb = int(pos_el.get("number") or 0)
                    except ValueError:
                        continue
                    member_id = athlete_members.get(pos_el.get("athleteid") or "")
                    if numb and member_id:
                        positions.append((numb, member_id))

            relay = Relay(
                meetsid=meet_id,
                eventdate=meet_date,
                clubsid=club_id,
                teamnumb=int(relay_el.get("number") or 1),
                name=(relay_el.get("name") or None),
                stylesid=style_id,
                totaltime=swimtime,
                eventnumb=event_number.get(eid) or None,
                eventtyp=0,
                resulttyp=0,  # official
                course=course,
                gender=_GENDER.get((relay_el.get("gender") or "").upper()),
                resultstatus=status,
            )
            db.add(relay)
            db.flush()
            for numb, member_id in positions:
                db.add(RelayPos(relaysid=relay.relaysid, numb=numb, membersid=member_id))
                members_seen.add(member_id)
            archived += 1
    return archived, members_seen
