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

"""SERC printable score sheets — one 8.5x11 page per judge per victim/section.

Replicates the exact layout of the XLSX judge sheets:
- VICTIM_1 through VICTIM_N
- OVERALL (Chief Judge)
- BYSTANDER

Each page: scenario description, marking criteria, factor, score box, total.
Bilingual option: FR on front, EN on back (double-sided printing).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from html import escape

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..i18n import Section
from ..models_serc import SercConfig, SercDrawOrder
from ..models_team import Relay, RelayPos, Member, TeamClub
from .serc import get_results

router = APIRouter(prefix="/api/serc/print")

# SERC swimstyle ID
SERC_STYLE_ID = 530

# ── Victim type descriptions (from XLSX sheets) — bilingual ───────────────────

VICTIM_DESCRIPTIONS = Section("serc_print.victim")

OVERALL_DESCRIPTION = Section("serc_print.overall")

BYSTANDER_DESCRIPTION = Section("serc_print.bystander")

# Bilingual labels
LABELS = Section("serc_print.labels")

VICTIM_TYPE_KEY = {
    "Non Swimmer": "ns",
    "Weak Swimmer": "ws",
    "Injured Swimmer": "is",
    "Unconscious Non-Breathing": "unb",
}


def _render_team_metadata(t: dict[str, str], draw_num: int | str, team_name: str, member_names: str) -> str:
    return f"""
        <div class="meta-row">
            <span>{t['draw_no']} <span class="field">{escape(str(draw_num))}</span></span>
            <span>{t['team_name']} <span class="field">{escape(team_name)}</span></span>
        </div>
        <div class="meta-row">
            <span>{t['team_members']} <span class="field">{escape(member_names)}</span></span>
        </div>
        <div class="meta-row">
            <span>{t['judge_id']} <span class="field"></span></span>
        </div>
    """


def _print_languages(lang: str) -> list[str]:
    return ["fr", "en"] if lang == "bilingual" else [lang if lang in ("fr", "en") else "fr"]


DRAW_LIST_LABELS = Section("serc_print.draw_list")


def _render_draw_list(ordered: list[tuple[int, str, str]], lang: str) -> str:
    labels = DRAW_LIST_LABELS[lang]
    rows = "".join(
        f"""
        <tr>
            <td class="draw-position">{escape(str(position))}</td>
            <td class="draw-team">{escape(team_name)}</td>
            <td>{escape(member_names)}</td>
        </tr>"""
        for position, team_name, member_names in ordered
    )
    if not rows:
        rows = f'<tr><td class="draw-empty" colspan="3">{labels["no_teams"]}</td></tr>'

    return f"""
    <section class="sheet draw-list">
        <div class="title-bar">{labels['title']}</div>
        <table>
            <thead>
                <tr>
                    <th>{labels['draw']}</th>
                    <th>{labels['team']}</th>
                    <th>{labels['members']}</th>
                </tr>
            </thead>
            <tbody>{rows}</tbody>
        </table>
    </section>"""


RESULTS_REPORT_LABELS = Section("serc_print.results_report")

RESULTS_REPORT_CSS = """
@page { size: letter; margin: 0.5in; }
* { box-sizing: border-box; }
body { font-family: Arial, sans-serif; color: #111; font-size: 9pt; }
.report { page-break-after: always; break-after: page; }
.report:last-child { page-break-after: avoid; break-after: avoid; }
h1 { font-size: 16pt; margin: 0 0 12px; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th { background: #222; color: #fff; text-align: left; }
th, td { padding: 4px 7px; border-bottom: 1px solid #bbb; }
.rank { width: 10%; text-align: center; }
.team { width: 35%; font-weight: bold; }
.club { width: 40%; }
.total { width: 15%; text-align: right; font-weight: bold; }
.dsq { display: block; color: #a00; font-size: 8pt; font-weight: normal; }
.no-results { text-align: center; padding: 20px; }
"""


def _render_results_report(results: list[dict], lang: str) -> str:
    labels = RESULTS_REPORT_LABELS[lang]
    rows = ""
    for result in results:
        disqualified = result.get("disqualified", False)
        rank = labels["dsq"] if disqualified else escape(str(result.get("rank", "")))
        total = labels["dsq"] if disqualified else f"{float(result.get('total') or 0):.2f}"
        dsq_code = result.get("dsq_code")
        dsq_html = (
            f'<span class="dsq">DQ{escape(str(dsq_code))}</span>'
            if disqualified and dsq_code
            else ""
        )
        rows += f"""
        <tr>
            <td class="rank">{rank}</td>
            <td class="team">{escape(str(result.get("name") or ""))}{dsq_html}</td>
            <td class="club">{escape(str(result.get("club") or ""))}</td>
            <td class="total">{total}</td>
        </tr>"""

    if not rows:
        rows = f'<tr><td class="no-results" colspan="4">{labels["no_results"]}</td></tr>'

    return f"""
    <section class="report">
        <h1>{labels['title']}</h1>
        <table>
            <thead>
                <tr>
                    <th class="rank">{labels['rank']}</th>
                    <th class="team">{labels['team']}</th>
                    <th class="club">{labels['club']}</th>
                    <th class="total">{labels['total']}</th>
                </tr>
            </thead>
            <tbody>{rows}</tbody>
        </table>
    </section>"""


# ── Page CSS (matches XLSX print styling) ─────────────────────────────────────

PAGE_CSS = """
@page { size: letter; margin: 0.5in 0.4in; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; font-size: 10pt; color: #000; }
.sheet {
    width: 7.7in; margin: 0 auto; padding: 0;
    page-break-after: always; break-after: page;
    min-height: 9.5in;
}
.sheet:last-child { page-break-after: avoid; break-after: avoid; }
.draw-list table { width: 100%; border-collapse: collapse; margin-top: 12px; }
.draw-list th { background: #333; color: #fff; text-align: left; }
.draw-list th, .draw-list td { border: 1px solid #777; padding: 6px 8px; }
.draw-position { width: 12%; text-align: center; font-weight: bold; }
.draw-team { width: 40%; font-weight: bold; }
.draw-empty { text-align: center; }

.title-bar {
    background: #000; color: #fff; font-size: 13pt; font-weight: bold;
    padding: 6px 10px; margin-bottom: 2px;
}
.subtitle-bar {
    background: #555; color: #fff; font-size: 10pt; font-weight: bold;
    padding: 4px 10px; margin-bottom: 8px;
}

.meta-row {
    display: flex; justify-content: space-between; margin-bottom: 3px;
    font-size: 10pt;
}
.meta-row .field { border-bottom: 1px solid #000; min-width: 200px; display: inline-block; margin-left: 4px; }

.scenario-box {
    background: #f0f0f0; border: 1px solid #999; padding: 6px 8px;
    margin: 8px 0 4px; font-size: 9pt; line-height: 1.3;
}
.notes-header {
    background: #333; color: #fff; font-weight: bold; font-size: 9pt;
    padding: 3px 8px; margin-top: 6px;
}
.notes-box {
    border: 1px solid #999; border-top: none; padding: 6px 8px;
    font-size: 9pt; line-height: 1.3; margin-bottom: 8px;
}
.notes-box ul { margin-left: 16px; margin-top: 4px; }

.scale-bar {
    display: flex; border: 1px solid #000; margin-bottom: 6px;
}
.scale-bar div {
    flex: 1; text-align: center; font-size: 8pt; font-weight: bold;
    padding: 3px 2px; border-right: 1px solid #000;
}
.scale-bar div:last-child { border-right: none; }
.scale-bar div:nth-child(1) { background: #000; color: #fff; }
.scale-bar div:nth-child(2) { background: #444; color: #fff; }
.scale-bar div:nth-child(3) { background: #888; color: #fff; }
.scale-bar div:nth-child(4) { background: #bbb; color: #000; }
.scale-bar div:nth-child(5) { background: #ddd; color: #000; }

.marking-header {
    display: flex; justify-content: space-between; font-size: 8pt;
    font-style: italic; margin-bottom: 4px; color: #333;
}

.criterion-block { margin-bottom: 2px; }
.criterion-header {
    background: #333; color: #fff; font-weight: bold; font-size: 10pt;
    padding: 4px 8px; display: flex; justify-content: space-between; align-items: center;
}
.criterion-header .factor-label { font-size: 9pt; font-weight: normal; }
.criterion-header .factor-value { font-weight: bold; font-size: 10pt; }
.criterion-desc {
    border: 1px solid #999; border-top: none; padding: 5px 8px;
    font-size: 9pt; line-height: 1.3; min-height: 36px;
    display: flex; align-items: flex-start;
}
.criterion-desc .desc-text { flex: 1; white-space: pre-line; }
.criterion-desc .score-box {
    width: 60px; min-width: 60px; height: 36px;
    border: 2px solid #000; margin-left: 10px; background: #fff;
}

.rough-row {
    background: #f8f8f8; border: 1px solid #999;
    padding: 5px 8px; font-size: 9pt; font-weight: bold; color: #c00;
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 6px;
}
.rough-row .score-box {
    width: 60px; min-width: 60px; height: 28px;
    border: 2px solid #c00; background: #fff;
}

.total-row {
    background: #000; color: #fff; font-weight: bold; font-size: 12pt;
    padding: 6px 10px; display: flex; justify-content: space-between;
    align-items: center; margin-top: 4px;
}
.total-row .score-box {
    width: 70px; height: 30px; border: 2px solid #fff; background: #333;
}
"""


# ── Rendering functions ───────────────────────────────────────────────────────

def _render_victim_sheet(
    victim_num: int,
    victim_type: str,
    factors: dict,
    lang: str,
    team_name: str = "",
    member_names: str = "",
    draw_num: int | str = "",
) -> str:
    """Render one victim judge sheet page."""
    t = LABELS[lang]
    type_key = VICTIM_TYPE_KEY.get(victim_type, "ns")
    type_label = t.get(type_key, victim_type)
    desc = VICTIM_DESCRIPTIONS[lang].get(victim_type, VICTIM_DESCRIPTIONS[lang]["Non Swimmer"])

    criteria_keys = ["approach", "rescue", "control", "landing", "care"]
    criteria_labels = [t["approach"], t["rescue"], t["control"], t["landing"], t["care"]]
    criteria_descs = [desc["criteria"].get(k, "") for k in criteria_keys]
    criteria_factors = [factors.get(k, 1) for k in criteria_keys]

    criteria_html = ""
    for label, description, factor in zip(criteria_labels, criteria_descs, criteria_factors):
        desc_escaped = description.replace("\n", "<br>")
        criteria_html += f"""
        <div class="criterion-block">
            <div class="criterion-header">
                <span>{label}</span>
                <span><span class="factor-label">{t['factor']}</span> <span class="factor-value">{factor}</span></span>
            </div>
            <div class="criterion-desc">
                <div class="desc-text">{desc_escaped}</div>
                <div class="score-box"></div>
            </div>
        </div>"""

    return f"""
    <div class="sheet">
        <div class="title-bar">{type_label} - {t['victim']} {victim_num}</div>
        <div class="subtitle-bar">{t['judge_sheet']}</div>

        {_render_team_metadata(t, draw_num, team_name, member_names)}

        <div class="scenario-box">
            <strong>{t['victim']}: {type_label}</strong><br>
            {desc['scenario']}
        </div>

        <div class="notes-header">{t['judges_notes']}</div>
        <div class="notes-box">{desc['notes']}</div>

        <div class="scale-bar">
            <div>{t['scale_excellent']}</div>
            <div>{t['scale_vgood']}</div>
            <div>{t['scale_satisfactory']}</div>
            <div>{t['scale_weak']}</div>
            <div>{t['scale_poor']}</div>
        </div>

        <div class="marking-header">
            <span>{t['areas_marking']}</span>
            <span>{t['mark_out_of']}</span>
        </div>

        {criteria_html}

        <div class="rough-row">
            <span>{t['rough']}</span>
            <div class="score-box"></div>
        </div>

        <div class="total-row">
            <span>{t['total']}</span>
            <div class="score-box"></div>
        </div>
    </div>"""


def _render_overall_sheet(
    factors: dict,
    lang: str,
    team_name: str = "",
    member_names: str = "",
    draw_num: int | str = "",
) -> str:
    """Render the Overall (Chief Judge) sheet."""
    t = LABELS[lang]
    desc = OVERALL_DESCRIPTION[lang]

    bullets_html = "".join(f"<li>{b}</li>" for b in desc["bullets"])

    criteria_html = ""
    for key in ["assessment", "control", "communication", "search", "teamwork"]:
        label = t.get(key, key.capitalize())
        factor = factors.get(key, 1)
        desc_escaped = desc["criteria"][key].replace("\n", "<br>")
        criteria_html += f"""
        <div class="criterion-block">
            <div class="criterion-header">
                <span>{label}</span>
                <span><span class="factor-label">{t['factor']}</span> <span class="factor-value">{factor}</span></span>
            </div>
            <div class="criterion-desc">
                <div class="desc-text">{desc_escaped}</div>
                <div class="score-box"></div>
            </div>
        </div>"""

    return f"""
    <div class="sheet">
        <div class="title-bar">{t['overall_title']}</div>
        <div class="subtitle-bar">{t['judge_sheet']}</div>

        {_render_team_metadata(t, draw_num, team_name, member_names)}

        <div class="notes-header">{t['judges_notes']}</div>
        <div class="notes-box">
            {desc['notes']}
            <ul>{bullets_html}</ul>
        </div>

        <div class="scale-bar">
            <div>{t['scale_excellent']}</div>
            <div>{t['scale_vgood']}</div>
            <div>{t['scale_satisfactory']}</div>
            <div>{t['scale_weak']}</div>
            <div>{t['scale_poor']}</div>
        </div>

        <div class="marking-header">
            <span>{t['areas_marking']}</span>
            <span>{t['mark_out_of']}</span>
        </div>

        {criteria_html}

        <div class="rough-row">
            <span>{t['rough']}</span>
            <div class="score-box"></div>
        </div>

        <div class="total-row">
            <span>{t['total']}</span>
            <div class="score-box"></div>
        </div>
    </div>"""


def _render_bystander_sheet(
    factors: dict,
    lang: str,
    team_name: str = "",
    member_names: str = "",
    draw_num: int | str = "",
) -> str:
    """Render the Bystander sheet."""
    t = LABELS[lang]
    desc = BYSTANDER_DESCRIPTION[lang]

    criteria_html = ""
    for key in ["approach", "info", "directions", "monitoring", "encouragement"]:
        c = desc["criteria"][key]
        factor = factors.get(key, 1)
        desc_escaped = c["desc"].replace("\n", "<br>")
        criteria_html += f"""
        <div class="criterion-block">
            <div class="criterion-header">
                <span>{c['label']}</span>
                <span><span class="factor-label">{t['factor']}</span> <span class="factor-value">{factor}</span></span>
            </div>
            <div class="criterion-desc">
                <div class="desc-text">{desc_escaped}</div>
                <div class="score-box"></div>
            </div>
        </div>"""

    return f"""
    <div class="sheet">
        <div class="title-bar">{t['bystander_title']}</div>
        <div class="subtitle-bar">{t['judge_sheet']}</div>

        {_render_team_metadata(t, draw_num, team_name, member_names)}

        <div class="scenario-box">
            {desc['scenario']}
        </div>

        <div class="notes-header">{t['judges_notes']}</div>
        <div class="notes-box">{desc['notes']}</div>

        <div class="scale-bar">
            <div>{t['scale_excellent']}</div>
            <div>{t['scale_vgood']}</div>
            <div>{t['scale_satisfactory']}</div>
            <div>{t['scale_weak']}</div>
            <div>{t['scale_poor']}</div>
        </div>

        <div class="marking-header">
            <span>{t['areas_marking']}</span>
            <span>{t['mark_out_of']}</span>
        </div>

        {criteria_html}

        <div class="rough-row">
            <span>{t['rough']}</span>
            <div class="score-box"></div>
        </div>

        <div class="total-row">
            <span>{t['total']}</span>
            <div class="score-box"></div>
        </div>
    </div>"""


# ── API Endpoint ──────────────────────────────────────────────────────────────

@router.get("/sheets", response_class=HTMLResponse)
def print_sheets(
    lang: str = Query(default="fr", description="Language: 'fr', 'en', or 'bilingual'"),
    db: Session = Depends(get_db),
):
    """Generate printable judge score sheets as HTML — one page per team per section.

    For each team (in draw order): generates OVERALL, BYSTANDER, VICTIM_1..N pages.
    Draw # and Team Name are pre-filled on each page.

    - lang=fr: French only
    - lang=en: English only
    - lang=bilingual: French page then English page for each (double-sided)
    """
    config = db.query(SercConfig).order_by(SercConfig.id.desc()).first()
    if not config:
        return HTMLResponse("<p>No SERC configuration found. Save Setup first.</p>", status_code=404)

    overall_factors = json.loads(config.overall_factors_json) if config.overall_factors_json else {}
    bystander_factors = json.loads(config.bystander_factors_json) if config.bystander_factors_json else {}
    victim_factors = json.loads(config.victim_factors_json) if config.victim_factors_json else []

    langs = _print_languages(lang)

    # Get teams from relay entries in draw order
    relays = db.query(Relay).filter(Relay.stylesid == SERC_STYLE_ID).order_by(Relay.teamnumb).all()
    teams_map: dict[int, tuple[str, str]] = {}
    for relay in relays:
        positions = db.query(RelayPos).filter(RelayPos.relaysid == relay.relaysid).order_by(RelayPos.numb).all()
        member_first_names = []
        for pos in positions:
            if pos.membersid:
                member = db.get(Member, pos.membersid)
                if member and member.firstname and member.firstname.strip():
                    member_first_names.append(member.firstname.strip())
        club = db.get(TeamClub, relay.clubsid) if relay.clubsid else None
        club_name = (club.name or club.code or "") if club else ""
        fallback_name = " ".join(
            part for part in (club_name, str(relay.teamnumb) if relay.teamnumb is not None else "") if part
        )
        team_name = (relay.name or "").strip() or fallback_name or f"Team {relay.teamnumb or 1}"
        teams_map[relay.relaysid] = (team_name, ", ".join(member_first_names))

    # Get draw order (position 1,2,3... = draw number for each team)
    orders = (
        db.query(SercDrawOrder)
        .filter(SercDrawOrder.config_id == config.id, SercDrawOrder.draw_number == 1)
        .order_by(SercDrawOrder.position)
        .all()
    )
    if orders:
        ordered = [
            (o.position, *teams_map.get(o.relay_team_id, (f"Team {o.position}", "")))
            for o in orders
        ]
    else:
        # Fall back to natural order
        ordered = [(i + 1, *team_data) for i, team_data in enumerate(teams_map.values())]

    sheets_html = "".join(_render_draw_list(ordered, ln) for ln in langs)

    # For each team: generate all section pages
    for draw_pos, team_name, member_names in ordered:
        # Overall
        for ln in langs:
            sheets_html += _render_overall_sheet(
                overall_factors, ln, team_name=team_name, member_names=member_names, draw_num=draw_pos
            )

        # Bystander
        if config.has_bystander:
            for ln in langs:
                sheets_html += _render_bystander_sheet(
                    bystander_factors, ln, team_name=team_name, member_names=member_names, draw_num=draw_pos
                )

        # Victims
        for i in range(config.num_victims):
            vf = victim_factors[i] if i < len(victim_factors) else {}
            victim_type = vf.get("type", "Non Swimmer")
            for ln in langs:
                sheets_html += _render_victim_sheet(
                    i + 1, victim_type, vf, ln, team_name=team_name, member_names=member_names, draw_num=draw_pos
                )

    html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>SERC Judge Score Sheets</title>
<style>
{PAGE_CSS}
</style>
</head>
<body>
{sheets_html}
</body>
</html>"""
    return HTMLResponse(html)


@router.get("/results", response_class=HTMLResponse)
def print_results(
    lang: str = Query(default="fr", description="Language: 'fr', 'en', or 'bilingual'"),
    db: Session = Depends(get_db),
):
    """Render the overall SERC standings as a print-ready report."""
    results = get_results(db).get("overall", [])
    reports_html = "".join(_render_results_report(results, ln) for ln in _print_languages(lang))
    html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>SERC Results</title>
<style>
{RESULTS_REPORT_CSS}
</style>
</head>
<body>
{reports_html}
</body>
</html>"""
    return HTMLResponse(html)