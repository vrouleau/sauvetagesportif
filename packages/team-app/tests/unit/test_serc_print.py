# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.routers.serc_print import (  # noqa: E402
    _print_languages,
    _render_overall_sheet,
    _render_results_report,
)


@pytest.mark.parametrize(
    ("lang", "members_label"),
    [
        ("en", "Member first names:"),
        ("fr", "Prénoms des membres:"),
    ],
)
def test_score_sheet_includes_team_name_and_member_first_names(lang, members_label):
    sheet = _render_overall_sheet(
        {},
        lang,
        team_name="Surf Central Burwell",
        member_names="Samantha, Oliver, Martyna, Kingston",
        draw_num=4,
    )

    assert "Surf Central Burwell" in sheet
    assert members_label in sheet
    assert "Samantha, Oliver, Martyna, Kingston" in sheet


def test_score_sheet_escapes_team_and_member_names():
    sheet = _render_overall_sheet(
        {},
        "en",
        team_name="<Team & Co.>",
        member_names="A & B",
    )

    assert "&lt;Team &amp; Co.&gt;" in sheet
    assert "A &amp; B" in sheet


@pytest.mark.parametrize(
    ("lang", "title", "rank_label"),
    [
        ("en", "SERC Results — Overall Standings", "Rank"),
        ("fr", "Résultats SERC — classement général", "Rang"),
    ],
)
def test_results_report_renders_localized_standings(lang, title, rank_label):
    report = _render_results_report(
        [
            {
                "rank": 1,
                "name": "Surf Central Burwell",
                "club": "Surf Central Lifesaving Club",
                "total": 298.12,
                "disqualified": False,
            },
            {
                "rank": None,
                "name": "PSA Cohen",
                "club": "Pacific Swim Academy",
                "total": 0,
                "disqualified": True,
                "dsq_code": "4",
            },
        ],
        lang,
    )

    assert title in report
    assert f">{rank_label}<" in report
    assert "Surf Central Burwell" in report
    assert "298.12" in report
    assert "PSA Cohen" in report
    assert "DQ4" in report


def test_bilingual_results_are_ordered_french_then_english():
    assert _print_languages("bilingual") == ["fr", "en"]
