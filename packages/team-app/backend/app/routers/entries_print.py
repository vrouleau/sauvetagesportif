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

"""Printable entries list — every individual and relay entry of the current
meet, grouped by club (one club per printed page).

Served as a self-contained HTML page; the Invitation page fetches it with the
organizer's PIN and opens it in a new tab; the page's own Print button opens
the browser's print dialog.
"""
from __future__ import annotations

from datetime import datetime
from html import escape

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session, joinedload

from ..database import get_db
from ..meet_config import resolve_meetsid, _get_meet_config, _get_meet_type
from ..models import BsGlobal, SwimEvent, SwimResult
from ..models_team import Member, Relay, RelayPos, TeamClub
from .api import require_organizer_or_admin

router = APIRouter(prefix="/api/print")

_TXT = {
    "fr": {
        "title": "Inscriptions",
        "individual": "Inscriptions individuelles",
        "relays": "Inscriptions relais",
        "athlete": "Athlète",
        "born": "Né(e)",
        "event": "Épreuve",
        "category": "Catégorie",
        "entry_time": "Temps d'inscription",
        "team": "Équipe",
        "members": "Membres",
        "no_entries": "Aucune inscription.",
        "no_individual": "Aucune inscription individuelle.",
        "no_relays": "Aucune inscription relais.",
        "athletes": "athlète(s)",
        "entries": "inscription(s)",
        "teams": "équipe(s)",
        "printed": "Imprimé le",
        "print": "Imprimer",
        "gender": {1: "Hommes", 2: "Femmes", 3: "Mixte"},
    },
    "en": {
        "title": "Entries",
        "individual": "Individual entries",
        "relays": "Relay entries",
        "athlete": "Athlete",
        "born": "Born",
        "event": "Event",
        "category": "Category",
        "entry_time": "Entry time",
        "team": "Team",
        "members": "Members",
        "no_entries": "No entries.",
        "no_individual": "No individual entries.",
        "no_relays": "No relay entries.",
        "athletes": "athlete(s)",
        "entries": "entry(ies)",
        "teams": "team(s)",
        "printed": "Printed",
        "print": "Print",
        "gender": {1: "Men", 2: "Women", 3: "Mixed"},
    },
}


def _fmt_time(ms: int | None) -> str:
    if not ms:
        return "NT"
    total_cs = ms // 10
    minutes, rem = divmod(total_cs, 6000)
    seconds, cs = divmod(rem, 100)
    return f"{minutes}:{seconds:02d}.{cs:02d}" if minutes else f"{seconds}.{cs:02d}"


def _event_label(ev: SwimEvent | None, txt: dict, fallback: str = "") -> str:
    if ev is None:
        return fallback
    name = (ev.swimstyle.name if ev.swimstyle else "") or ev.roundname or fallback
    gender = txt["gender"].get(ev.gender or 0, "")
    num = f"#{ev.eventnumber} " if ev.eventnumber else ""
    return f"{num}{name}" + (f" — {gender}" if gender else "")


def _age_label(minage: int | None, maxage: int | None) -> str:
    lo = minage if minage is not None and minage >= 0 else None
    hi = maxage if maxage is not None and 0 <= maxage < 99 else None
    if lo is None and hi is None:
        return "Open"
    if lo is None:
        return f"{hi}-"
    if hi is None:
        return f"{lo}+"
    return f"{lo}-{hi}"


def _event_sort_key(ev: SwimEvent | None):
    if ev is None:
        return (1 << 30, 1 << 30)
    return (ev.eventnumber or 1 << 30, ev.sortcode or 0)


def build_entries_html(db: Session, meetsid: int | None, lang: str = "fr") -> str:
    txt = _TXT.get(lang, _TXT["fr"])
    is_beach = _get_meet_type(db) == "BEACH"
    meet_name = _get_meet_config(db, meetsid, "meet_name") or txt["title"]

    events = (
        db.query(SwimEvent)
        .options(joinedload(SwimEvent.swimstyle))
        .filter(SwimEvent.meetsid == meetsid)
        .all()
    )

    # ── Individual entries ────────────────────────────────────────────────
    regs = (
        db.query(SwimResult)
        .options(
            joinedload(SwimResult.member),
            joinedload(SwimResult.event).joinedload(SwimEvent.swimstyle),
        )
        .filter(SwimResult.meetsid == meetsid)
        .all()
    )
    # club id -> member id -> [regs]
    indiv: dict[int, dict[int, list[SwimResult]]] = {}
    members: dict[int, Member] = {}
    for reg in regs:
        m = reg.member
        if m is None:
            continue
        ev = reg.event
        if ev is not None and ev.swimstyle and (ev.swimstyle.relaycount or 1) > 1:
            continue  # team events are listed in the relay section
        members[m.membersid] = m
        indiv.setdefault(m.clubsid, {}).setdefault(m.membersid, []).append(reg)

    # ── Relay teams ───────────────────────────────────────────────────────
    relays = (
        db.query(Relay)
        .filter(Relay.meetsid == meetsid, Relay.clubsid.isnot(None))
        .all()
    )
    relay_ids = [r.relaysid for r in relays]
    positions: dict[int, list[RelayPos]] = {}
    if relay_ids:
        for pos in (
            db.query(RelayPos)
            .filter(RelayPos.relaysid.in_(relay_ids), RelayPos.membersid.isnot(None))
            .order_by(RelayPos.relaysid, RelayPos.numb)
            .all()
        ):
            positions.setdefault(pos.relaysid, []).append(pos)
    missing = {p.membersid for ps in positions.values() for p in ps} - members.keys()
    if missing:
        for m in db.query(Member).filter(Member.membersid.in_(missing)).all():
            members[m.membersid] = m
    # Legacy custom names stored in bsglobal (same fallback as the LXF export)
    legacy_names: dict[int, str] = {}
    unnamed = [f"relay_name_{r.relaysid}" for r in relays if not r.name]
    if unnamed:
        for cfg in db.query(BsGlobal).filter(BsGlobal.name.in_(unnamed)).all():
            legacy_names[int(cfg.name.replace("relay_name_", ""))] = cfg.data

    def relay_event(r: Relay) -> SwimEvent | None:
        cands = [e for e in events if e.eventnumber == r.eventnumb]
        if len(cands) > 1:
            cands = [e for e in cands if e.swimstyleid == r.stylesid] or cands
        if not cands:
            cands = [e for e in events if e.swimstyleid == r.stylesid]
        return cands[0] if cands else None

    relays_by_club: dict[int, list[tuple[SwimEvent | None, Relay]]] = {}
    for r in relays:
        relays_by_club.setdefault(r.clubsid, []).append((relay_event(r), r))

    club_ids = set(indiv) | set(relays_by_club)
    clubs = db.query(TeamClub).filter(TeamClub.clubsid.in_(club_ids)).all() if club_ids else []
    clubs.sort(key=lambda c: (c.name or "").lower())

    def member_name(m: Member | None) -> str:
        if m is None:
            return "?"
        return f"{m.lastname or ''}, {m.firstname or ''}".strip(", ")

    # ── Render ────────────────────────────────────────────────────────────
    parts: list[str] = []
    for club in clubs:
        club_indiv = indiv.get(club.clubsid, {})
        club_relays = relays_by_club.get(club.clubsid, [])
        n_entries = sum(len(v) for v in club_indiv.values())
        code = f" ({escape(club.code)})" if club.code else ""
        parts.append('<section class="club">')
        parts.append(
            f'<h2>{escape(club.name or "")}{code}</h2>'
            f'<p class="summary">{len(club_indiv)} {txt["athletes"]} · '
            f'{n_entries} {txt["entries"]} · {len(club_relays)} {txt["teams"]}</p>'
        )

        # The section title lives in the table's <thead>, which browsers
        # repeat at the top of every printed page the table spans — so a
        # continuation page still says which club and section it belongs to.
        def caption(label: str, ncols: int) -> str:
            return (f'<tr class="caption"><th colspan="{ncols}">'
                    f'<span class="cap-club">{escape(club.name or "")}</span> · {label}</th></tr>')

        # Individual
        if not club_indiv:
            parts.append(f'<h3>{txt["individual"]}</h3>')
            parts.append(f'<p class="empty">{txt["no_individual"]}</p>')
        else:
            time_th = "" if is_beach else f'<th class="time">{txt["entry_time"]}</th>'
            parts.append(
                f'<table><thead>{caption(txt["individual"], 4 if is_beach else 5)}'
                f'<tr><th>{txt["athlete"]}</th><th>{txt["born"]}</th>'
                f'<th>{txt["event"]}</th><th>{txt["category"]}</th>{time_th}</tr></thead>'
            )
            ordered = sorted(
                club_indiv.items(),
                key=lambda kv: ((members[kv[0]].lastname or "").lower(),
                                (members[kv[0]].firstname or "").lower()),
            )
            for mid, mregs in ordered:
                m = members[mid]
                mregs = sorted(mregs, key=lambda r: _event_sort_key(r.event))
                born = str(m.birthdate.year) if m.birthdate else ""
                # One <tbody> per athlete so their events never split across pages
                parts.append('<tbody class="athlete">')
                for i, reg in enumerate(mregs):
                    cls = ' class="first"' if i == 0 else ""
                    if i == 0:
                        span = f' rowspan="{len(mregs)}"'
                        head = (f'<td{span} class="ath">{escape(member_name(m))}</td>'
                                f'<td{span}>{born}</td>')
                    else:
                        head = ""
                    time_td = "" if is_beach else f'<td class="time">{_fmt_time(reg.entrytime)}</td>'
                    parts.append(
                        f'<tr{cls}>{head}<td>{escape(_event_label(reg.event, txt, str(reg.swimeventid)))}</td>'
                        f'<td>{escape(reg.age_code or "")}</td>{time_td}</tr>'
                    )
                parts.append("</tbody>")
            parts.append("</table>")

        # Relays
        if not club_relays:
            parts.append(f'<h3>{txt["relays"]}</h3>')
            parts.append(f'<p class="empty">{txt["no_relays"]}</p>')
        else:
            parts.append(
                f'<table class="relays"><thead>{caption(txt["relays"], 4)}'
                f'<tr><th>{txt["event"]}</th><th>{txt["category"]}</th>'
                f'<th>{txt["team"]}</th><th>{txt["members"]}</th></tr></thead><tbody>'
            )
            for ev, r in sorted(club_relays, key=lambda t: (_event_sort_key(t[0]), t[1].teamnumb or 0)):
                pos = positions.get(r.relaysid, [])
                pos_members = [members.get(p.membersid) for p in pos]
                name = r.name or legacy_names.get(r.relaysid) or "/".join(
                    (m.lastname or "") for m in pos_members if m)
                letter = chr(ord("A") + (r.teamnumb or 1) - 1) if 1 <= (r.teamnumb or 1) <= 26 else str(r.teamnumb)
                team = f"{letter}" + (f" — {escape(name)}" if name else "")
                member_list = "<br>".join(
                    f"{p.numb}. {escape(member_name(m))}" for p, m in zip(pos, pos_members)
                ) or "—"
                fallback = f"#{r.eventnumb}" if r.eventnumb else ""
                parts.append(
                    f'<tr class="first"><td>{escape(_event_label(ev, txt, fallback))}</td>'
                    f'<td>{escape(_age_label(r.minage, r.maxage))}</td>'
                    f'<td>{team}</td><td>{member_list}</td></tr>'
                )
            parts.append("</tbody></table>")
        parts.append("</section>")

    if not clubs:
        parts.append(f'<p class="empty">{txt["no_entries"]}</p>')

    printed = datetime.now().strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<title>{escape(txt["title"])} — {escape(meet_name)}</title>
<style>
  body {{ font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; margin: 16px; }}
  header {{ display: flex; justify-content: space-between; align-items: baseline;
           border-bottom: 2px solid #111; margin-bottom: 8px; }}
  header h1 {{ font-size: 16px; margin: 0 0 4px; }}
  header .meta {{ font-size: 10px; color: #555; }}
  .club {{ break-after: page; page-break-after: always; }}
  .club:last-of-type {{ break-after: auto; page-break-after: auto; }}
  h2 {{ font-size: 14px; margin: 12px 0 2px; }}
  h3 {{ font-size: 12px; margin: 10px 0 4px; }}
  .summary {{ margin: 0 0 6px; color: #555; }}
  .empty {{ color: #777; font-style: italic; margin: 2px 0; }}
  table {{ width: 100%; border-collapse: collapse; }}
  th, td {{ text-align: left; padding: 2px 6px; vertical-align: top; }}
  th {{ border-bottom: 1px solid #111; font-size: 10px; text-transform: uppercase; }}
  table.relays {{ margin-top: 10px; }}
  tr.caption th {{ border-bottom: none; padding: 6px 6px 3px; font-size: 12px;
                   text-transform: none; }}
  .cap-club {{ color: #555; font-weight: normal; }}
  tr.first td {{ border-top: 1px solid #ccc; }}
  tr, tbody.athlete {{ break-inside: avoid; page-break-inside: avoid; }}
  td.ath {{ font-weight: bold; }}
  .time {{ text-align: right; white-space: nowrap; }}
  .print-btn {{ position: fixed; top: 12px; right: 12px; padding: 6px 14px; font-size: 12px; }}
  @media print {{ .print-btn {{ display: none; }} body {{ margin: 0; }} }}
  @page {{ size: letter; margin: 12mm; }}
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">{txt["print"]}</button>
<header><h1>{escape(txt["title"])} — {escape(meet_name)}</h1>
<span class="meta">{txt["printed"]} {printed}</span></header>
{''.join(parts)}
</body>
</html>"""


@router.get("/entries", response_class=HTMLResponse,
            dependencies=[Depends(require_organizer_or_admin)])
def print_entries(request: Request, lang: str = Query("fr"), db: Session = Depends(get_db)):
    """All individual + relay entries of the current meet, grouped by club."""
    return HTMLResponse(build_entries_html(db, resolve_meetsid(request, db), lang))
