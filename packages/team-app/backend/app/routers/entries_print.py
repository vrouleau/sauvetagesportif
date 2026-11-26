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

Served as a self-contained HTML page; the Invitation page and the Individual /
Relay entries pages fetch it with the caller's PIN and open it in a new tab; the
page's own Print button opens the browser's print dialog.

Admin / organizer get every club; a coach only ever gets their own club. The
entries pages pass `section` so each prints only what it shows.
"""
from __future__ import annotations

from datetime import date, datetime
from html import escape

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session, joinedload

from ..database import get_db
from ..i18n import Section
from ..age_group_rules import natural_age_code
from ..meet_config import resolve_meetsid, _get_meet_config, _get_meet_type, _get_config
from ..models import BsGlobal, SwimEvent, SwimResult
from ..models_team import Member, Relay, RelayPos, TeamClub
from ..swimstyle_names import swimstyle_name_en
from .api import _resolve_role

router = APIRouter(prefix="/api/print")

_TXT = Section("entries_print")


# swimevent.gender code -> catalogue key under entries_print.gender (0 = All: no label)
_GENDER_KEYS = {1: "men", 2: "women", 3: "mixed"}


def _fmt_time(ms: int | None) -> str:
    if not ms:
        return "NT"
    total_cs = ms // 10
    minutes, rem = divmod(total_cs, 6000)
    seconds, cs = divmod(rem, 100)
    return f"{minutes}:{seconds:02d}.{cs:02d}" if minutes else f"{seconds}.{cs:02d}"


def _event_label(ev: SwimEvent | None, txt: dict, fallback: str = "", lang: str = "fr") -> str:
    if ev is None:
        return fallback
    style_name = ev.swimstyle.name if ev.swimstyle else ""
    if style_name and lang == "en":
        style_name = swimstyle_name_en(ev.swimstyleid, style_name)
    name = style_name or ev.roundname or fallback
    gender = txt["gender"].get(_GENDER_KEYS.get(ev.gender or 0), "")
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


SECTIONS = ("all", "individual", "relays")


def build_entries_html(db: Session, meetsid: int | None, lang: str = "fr",
                       club_id: int | None = None, section: str = "all") -> str:
    """`club_id` restricts the report to one club; `section` to the individual
    or the relay entries ("all" = both)."""
    txt = _TXT[lang]
    show_indiv = section in ("all", "individual")
    show_relays = section in ("all", "relays")
    title = {"individual": txt["individual"], "relays": txt["relays"]}.get(section, txt["title"])
    meet_type = _get_meet_type(db)
    is_beach = meet_type == "BEACH"
    age_base = _get_config(db, "age_base_date")
    season_year = int(age_base[:4]) if age_base else date.today().year
    _order = ["10-", "11-12", "13-14", "15-18", "Open"]

    def is_up_categorized(m: Member, code: str | None) -> bool:
        """Entered in a category older than the athlete's own."""
        if not m.birthdate or code not in _order:
            return False
        own = natural_age_code(m.birthdate.date(), meet_type, season_year)
        return _order.index(code) > _order.index(own)
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
        if m is None or (club_id is not None and m.clubsid != club_id):
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
    if club_id is not None:
        relays = [r for r in relays if r.clubsid == club_id]
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

    if not show_indiv:
        indiv = {}
    if not show_relays:
        relays_by_club = {}
    club_ids = set(indiv) | set(relays_by_club)
    if club_id is not None:
        club_ids = {club_id}  # a coach's own club page, even when empty
    clubs = db.query(TeamClub).filter(TeamClub.clubsid.in_(club_ids)).all() if club_ids else []
    clubs.sort(key=lambda c: (c.name or "").lower())

    def up_mark(m: Member, code: str | None) -> str:
        if not is_up_categorized(m, code):
            return ""
        return f' <span class="up" title="{escape(txt["up_categorized"])}">&#8593;</span>'

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
        summary = []
        if show_indiv:
            summary += [f'{len(club_indiv)} {txt["athletes"]}', f'{n_entries} {txt["entries"]}']
        if show_relays:
            summary.append(f'{len(club_relays)} {txt["teams"]}')
        parts.append(
            f'<h2>{escape(club.name or "")}{code}</h2>'
            f'<p class="summary">{" · ".join(summary)}</p>'
        )

        # The section title lives in the table's <thead>, which browsers
        # repeat at the top of every printed page the table spans — so a
        # continuation page still says which club and section it belongs to.
        def caption(label: str, ncols: int) -> str:
            return (f'<tr class="caption"><th colspan="{ncols}">'
                    f'<span class="cap-club">{escape(club.name or "")}</span> · {label}</th></tr>')

        # Individual
        if not show_indiv:
            pass
        elif not club_indiv:
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
                        f'<tr{cls}>{head}<td>{escape(_event_label(reg.event, txt, str(reg.swimeventid), lang))}</td>'
                        f'<td>{escape(reg.age_code or "")}{up_mark(m, reg.age_code)}</td>{time_td}</tr>'
                    )
                parts.append("</tbody>")
            parts.append("</table>")
            if any(is_up_categorized(members[mid], r.age_code)
                   for mid, rs in club_indiv.items() for r in rs):
                parts.append(f'<p class="empty"><span class="up">&#8593;</span> {escape(txt["up_categorized"])}</p>')

        # Relays
        if not show_relays:
            pass
        elif not club_relays:
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
                    f'<tr class="first"><td>{escape(_event_label(ev, txt, fallback, lang))}</td>'
                    f'<td>{escape(_age_label(r.minage, r.maxage))}</td>'
                    f'<td>{team}</td><td>{member_list}</td></tr>'
                )
            parts.append("</tbody></table>")
        parts.append("</section>")

    if not clubs:
        empty = {"individual": txt["no_individual"], "relays": txt["no_relays"]}.get(section, txt["no_entries"])
        parts.append(f'<p class="empty">{empty}</p>')

    printed = datetime.now().strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<title>{escape(title)} — {escape(meet_name)}</title>
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
  .up {{ font-weight: bold; color: #b45309; }}
  .time {{ text-align: right; white-space: nowrap; }}
  .print-btn {{ position: fixed; top: 12px; right: 12px; padding: 6px 14px; font-size: 12px; }}
  @media print {{ .print-btn {{ display: none; }} body {{ margin: 0; }} }}
  @page {{ size: letter; margin: 12mm; }}
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">{txt["print"]}</button>
<header><h1>{escape(title)} — {escape(meet_name)}</h1>
<span class="meta">{txt["printed"]} {printed}</span></header>
{''.join(parts)}
</body>
</html>"""


@router.get("/entries", response_class=HTMLResponse)
def print_entries(request: Request, lang: str = Query("fr"),
                  section: str = Query("all"), db: Session = Depends(get_db)):
    """Individual and/or relay entries of the current meet, grouped by club.

    Admin / organizer: every club. Coach: their own club only.
    """
    if section not in SECTIONS:
        raise HTTPException(400, f"section must be one of {', '.join(SECTIONS)}")
    role, caller_club = _resolve_role(request.headers.get("X-Club-Pin", ""), db)
    if role == "none":
        raise HTTPException(403, "Authentication required")
    club_id = caller_club if role == "coach" else None
    return HTMLResponse(build_entries_html(db, resolve_meetsid(request, db), lang,
                                           club_id=club_id, section=section))
