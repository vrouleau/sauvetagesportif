# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.routers.serc_print import _render_overall_sheet  # noqa: E402


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
