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

"""
generate_entries_lxf.py — Generate a synthetic LENEX "entries" file for testing
the meet-app <-> team-app round trip (see top-level CLAUDE.md, "LXF round-trip").

Produces the same shape team-app's `export.py::generate_lxf()` writes for
"Télécharger LXF" (GET /api/export/registrations-lxf): full session/event/
age-group structure (copied verbatim from config/template_pool.lxf or
config/template_beach.lxf, since that's exactly what meet-app's own
"Create Pool"/"Create Beach" seeds into a fresh meet — matching event ids is
what lets meet-app's importer treat this as a normal entries-only import
into an existing meet) + clubs + athletes + individual entries + relay teams.

Import via meet-app: File -> Importer LENEX.

What it generates:
  - N clubs, M athletes distributed across them, birthdates spread across
    the 5 age brackets meet-app actually computes (10-, 11-12, 13-14, 15-18,
    Open — see config/age-group-rules.json / ageGroupRules.ts; "Masters" is
    a display-only bracket with no canonical age threshold in this app's
    rule engine, so it's intentionally not generated here).
  - Roughly a third of individual (relaycount=1) events converted to a
    Prelim+Final pair (round PRE/FIN, linked via preveventid), the rest left
    as Finale directe (round TIM) -- a realistic mixed meet structure.
  - Every athlete entered in a random subset of the individual events open
    to their bracket (not literally every event -- see docstring below).
  - Relay teams (relaycount=4) built compliant with docs/RELAY_TEAM_RULES.md
    (>=2 native-category members, single adjacent-younger swim-up, exact
    2M+2F for MIXED events, SERC/swimstyleid 530 fully unrestricted).
  - relaycount=2 events (rope-throw pairs, aquaplane-rescue -- not "relay
    teams" in the RelayEntryPage/relay-rules sense, no documented
    composition rule) get simple 2-person teams: same club, same gender,
    same age bracket.

Usage:
    python scripts/generate_entries_lxf.py --clubs 8 --athletes 120 --type pool --output entries.lxf
    python scripts/generate_entries_lxf.py --clubs 6 --athletes 80 --type beach --output entries_beach.lxf --seed 42
"""

from __future__ import annotations

import argparse
import random
import sys
import zipfile
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, tostring

# ── Age brackets ────────────────────────────────────────────────────────────
# Canonical bracket codes, youngest -> oldest (shared-ui/src/logic/ageGroupCode.ts
# AGE_CODE_ORDER, minus "Masters" -- see module docstring).
AGE_CODE_ORDER = ["10-", "11-12", "13-14", "15-18", "Open"]

# (agemin, agemax) per bracket. agemax=-1 means "no upper limit" (Splash convention,
# see top-level CLAUDE.md "agegroup.agemax -- 99 or -1 both mean Open").
BRACKET_RANGE = {
    "10-": (0, 10),
    "11-12": (11, 12),
    "13-14": (13, 14),
    "15-18": (15, 18),
    "Open": (19, -1),
}

REQUIRED_NATIVE_COUNT = 2  # packages/shared-ui/src/logic/relayRules.ts


def adjacent_younger(bracket: str) -> str | None:
    i = AGE_CODE_ORDER.index(bracket)
    return AGE_CODE_ORDER[i - 1] if i > 0 else None


def age_as_of(birthdate: date, ref: date) -> int:
    age = ref.year - birthdate.year
    if (ref.month, ref.day) < (birthdate.month, birthdate.day):
        age -= 1
    return age


def birthdate_for_bracket(bracket: str, meet_type: str, season_year: int, rng: random.Random) -> date:
    """Mirrors ageGroupRules.ts's resolveMatchingAge: 10-/11-12 are computed as of
    season start (Sept 1 pool / May 1 beach), the rest as of Dec 31. We pick a
    birth month/day safely *before* the season-start date for the season-start
    brackets so the same birthdate can't get bumped by the "will turn 13 by
    year end" exception in ageGroupRules.ts.
    """
    lo, hi = BRACKET_RANGE[bracket]
    if bracket in ("10-", "11-12"):
        ss_month = 9 if meet_type == "POOL" else 5
        target_age = rng.randint(0, hi) if bracket == "10-" else rng.randint(lo, hi)
        month = rng.randint(1, ss_month - 1)
        day = rng.randint(1, 28)
    else:
        target_age = rng.randint(19, 40) if bracket == "Open" else rng.randint(lo, hi)
        month = rng.randint(1, 12)
        day = rng.randint(1, 28)
    return date(season_year - target_age, month, day)


# ── Event catalog (copied verbatim from config/template_pool.lxf / template_beach.lxf) ──
# (eventid, number, order, swimstyleid, name, distance, relaycount)

POOL_EVENTS = [
    (1065, 1, 1, 500, "50m Nage avec obstacles", 50, 1),
    (1067, 2, 2, 501, "100m Nage avec obstacles", 100, 1),
    (1069, 3, 3, 503, "200m Nage avec obstacles", 200, 1),
    (1071, 4, 4, 504, "50m Portage du mannequin plein", 50, 1),
    (1073, 5, 5, 505, "100m Portage du mannequin plein", 100, 1),
    (1075, 6, 6, 506, "50m Portage du mannequin ½plein", 50, 1),
    (1077, 7, 7, 508, "50m Portage du mannequin ½ plein + palmes", 50, 1),
    (1079, 8, 8, 509, "100m Portage du mannequin plein + palmes", 100, 1),
    (1081, 9, 9, 510, "100m Remorquage mannequin ½ plein + palmes", 100, 1),
    (1083, 10, 10, 511, "100m Remorquage du mannequin palmes", 100, 1),
    (1085, 11, 11, 513, "50m Remorquage mannequin ½ plein +palmes", 50, 1),
    (1087, 12, 12, 514, "100m Sauveteur d'acier", 100, 1),
    (1089, 13, 13, 515, "200m Sauveteur d'acier", 200, 1),
    (1091, 14, 14, 521, "4m Lancer de précision", 4, 1),
    (1093, 15, 15, 522, "7m Lancer de précision", 7, 1),
    (1095, 16, 16, 523, "10m Lancer de la corde", 10, 2),
    (1097, 17, 17, 524, "12.5m Lancer de la corde", 12, 2),
    (1099, 18, 18, 526, "100m Sauvetage Combiné", 100, 1),
    (1101, 19, 19, 527, "4x50m Relais Sauvetage Combiné", 50, 4),
    (1103, 20, 20, 528, "4x50m Relais obstacles", 50, 4),
    (1105, 21, 21, 530, "SERC", 0, 4),
    (1107, 22, 22, 531, "4x25m Relais portage du mannequin", 25, 4),
]

BEACH_EVENTS = [
    (6001, 1, 1, 601, "Drapeau Sur Plage", 0, 1),
    (6003, 2, 2, 602, "Sprint Sur Plage 90m", 0, 1),
    (6005, 3, 3, 603, "Surf Ski 800m", 16, 1),
    (6007, 4, 4, 604, "Relais Sprint  Sur Plage 4x90m", 10, 4),
    (6009, 5, 5, 605, "Aquaplane 200m", 16, 1),
    (6011, 6, 6, 606, "Aquaplane 400m", 16, 1),
    (6013, 7, 7, 607, "Aquaplane 600m", 16, 1),
    (6015, 8, 8, 608, "Course sur plage 500m", 40, 1),
    (6017, 9, 9, 609, "Course sur plage 1000m", 40, 1),
    (6019, 10, 10, 610, "Course sur plage 1500m", 40, 1),
    (6021, 11, 11, 611, "Course sur plage 2000m", 40, 1),
    (6023, 12, 12, 612, "Course 100m-nage 100m-course 100m", 32, 1),
    (6025, 13, 13, 613, "Course 100m-nage 300m-course 100m", 32, 1),
    (6027, 14, 14, 614, "Nage dans les brisants 100m", 32, 1),
    (6029, 15, 15, 615, "Nage dans les brisants 200m", 32, 1),
    (6031, 16, 16, 616, "Nage dans les brisants 400m", 32, 1),
    (6033, 17, 17, 617, "Sauveteur océanique N100m, C500m, A200m, S50m", 16, 1),
    (6035, 18, 18, 618, "Sauveteur océanique N200m, C1000m, A400m, S50m", 16, 1),
    (6037, 19, 19, 619, "Sauveteur océanique N400m, SK700m, A600m, S50m", 16, 1),
    (6039, 20, 20, 621, "Relais océanique N200m, C1000m, A400m, S50", 16, 4),
    (6041, 21, 21, 622, "Relais océanique N400m, SK700m, A600m, S50m", 16, 4),
    (6043, 22, 22, 623, "Sauvetage avec aquaplane", 9, 2),
    (6045, 23, 23, 624, "Sauvetage avec bouée tube", 9, 4),
]

# Fixed gender assignment for relaycount=4 events (RELAY_TEAM_RULES.md: the beach
# 4x90m Sprint relay is always MIXED; SERC is unrestricted so its nominal gender
# doesn't matter -- MIXED keeps it consistent). The rest alternate M/F for variety.
RELAY_GENDER = {
    527: "M", 528: "F", 530: "MIXED", 531: "MIXED",  # pool
    604: "MIXED", 621: "M", 622: "F", 624: "MIXED",  # beach
}

SERC_SWIMSTYLE_ID = 530

MEET_COURSE = {"POOL": "SCM", "BEACH": "OPEN"}

# New eventids/agegroupids for generated Final events and all AGEGROUP elements --
# kept well clear of the template's own id ranges (pool 1065-1107, beach 6001-6045).
FINAL_EVENTID_BASE = {"POOL": 1500, "BEACH": 6500}
AGEGROUP_ID_BASE = {"POOL": 2000, "BEACH": 7000}

# ── Name pools ───────────────────────────────────────────────────────────────

FIRST_NAMES_M = [
    "Olivier", "William", "Nathan", "Thomas", "Samuel", "Xavier", "Alexandre", "Édouard",
    "Gabriel", "Antoine", "Étienne", "Louis", "Charles", "Simon", "Vincent", "Mathis",
    "Zachary", "Félix", "Jacob", "Justin", "Raphael", "Mathieu", "Benjamin", "David",
]
FIRST_NAMES_F = [
    "Emma", "Alice", "Charlotte", "Olivia", "Rosalie", "Florence", "Juliette", "Maëlle",
    "Émilie", "Camille", "Laurence", "Sarah", "Zoé", "Annaëelle", "Valérie", "Justine",
    "Marianne", "Coralie", "Sophie", "Léa", "Chloé", "Rosalie", "Maéva", "Alexia",
]
LAST_NAMES = [
    "Tremblay", "Gagnon", "Roy", "Boucher", "Côté", "Bouchard", "Gauthier", "Morin",
    "Lavoie", "Fortin", "Gagné", "Ouellet", "Pelletier", "Bélanger", "Lévesque", "Bédard",
    "Girard", "Simard", "Bergeron", "Cloutier", "Dubé", "Poirier", "Fournier", "Landry",
    "Gauvreau", "Beaulieu", "Lefebvre", "Michaud", "Roussel", "Caron", "Turcotte", "Martel",
]
CLUB_CITIES = [
    "Gatineau", "Sherbrooke", "Trois-Rivières", "Rimouski", "Saguenay", "Lévis",
    "Longueuil", "Laval", "Drummondville", "Granby", "Victoriaville", "Rouyn-Noranda",
    "Baie-Comeau", "Sept-Îles", "Val-d'Or", "Alma", "Joliette", "Saint-Georges",
    "Magog", "Repentigny", "Terrebonne", "Blainville", "Saint-Hyacinthe", "Salaberry",
    "Vaudreuil", "Sorel-Tracy", "Sainte-Thérèse", "Boucherville", "Chibougamau", "Matane",
]


# ── Data model ───────────────────────────────────────────────────────────────

@dataclass
class Athlete:
    athleteid: int
    clubid: int
    firstname: str
    lastname: str
    gender: str  # "M" | "F"
    birthdate: date
    bracket: str
    skill: float  # 0.85 (fast) .. 1.20 (slow) multiplier on estimated times


@dataclass
class Club:
    clubid: int
    name: str
    code: str
    athletes: list[Athlete] = field(default_factory=list)


@dataclass
class BuiltEvent:
    """A generated <EVENT> — either a standalone Finale directe (TIM) or the
    prelim half of a PRE/FIN pair. Individual ENTRY elements always target the
    prelim/TIM event, never the FIN event (finalists get seeded in-app)."""
    eventid: int
    number: int
    order: int
    swimstyleid: int
    name: str
    distance: int
    relaycount: int
    gender: str  # "ALL" | "M" | "F" | "MIXED"
    round: str  # "TIM" | "PRE"
    agegroup_ids: dict[str, int]  # bracket -> agegroupid, for THIS event
    final_eventid: int | None = None
    final_agegroup_ids: dict[str, int] | None = None


# ── Time estimation ──────────────────────────────────────────────────────────

def estimate_time_ms(distance: int, skill: float, rng: random.Random) -> int:
    pace = rng.uniform(1.3, 2.3)  # loose seconds-per-distance-unit approximation
    seconds = max(distance, 5) * pace * skill
    seconds = max(8.0, seconds)
    return int(seconds * 1000)


def ms_to_lenex_time(ms: int | None) -> str | None:
    if not ms or ms <= 0:
        return None
    total_cs = ms // 10
    cc = total_cs % 100
    total_s = total_cs // 100
    ss = total_s % 60
    total_m = total_s // 60
    mm = total_m % 60
    hh = total_m // 60
    return f"{hh}:{mm:02d}:{ss:02d}.{cc:02d}"


# ── Relay team composition (docs/RELAY_TEAM_RULES.md, relayRules.ts) ────────

def pick_team(native_pool: list[Athlete], swimup_pool: list[Athlete], count: int,
              rng: random.Random) -> list[Athlete] | None:
    """Fills `count` slots maximizing native-bracket members first (so 4-0/3-1/2-2
    splits all come out naturally), falling back to the single adjacent-younger
    bracket. Returns None if fewer than REQUIRED_NATIVE_COUNT native members are
    available, or if native+swim-up can't fill `count` slots at all."""
    if len(native_pool) < REQUIRED_NATIVE_COUNT:
        return None
    take_native = min(count, len(native_pool))
    remaining = count - take_native
    if remaining > 0 and len(swimup_pool) < remaining:
        return None
    members = rng.sample(native_pool, take_native)
    if remaining > 0:
        members += rng.sample(swimup_pool, remaining)
    rng.shuffle(members)
    return members


def pick_mixed_team(native_m: list[Athlete], swimup_m: list[Athlete],
                     native_f: list[Athlete], swimup_f: list[Athlete],
                     rng: random.Random) -> list[Athlete] | None:
    """Exactly 2M + 2F, >=2 native total across the whole team (RELAY_TEAM_RULES.md
    "Mixed-gender events")."""
    def pick_side(native: list[Athlete], swimup: list[Athlete]) -> tuple[list[Athlete], int] | None:
        take_native = min(2, len(native))
        remaining = 2 - take_native
        if remaining > 0 and len(swimup) < remaining:
            return None
        chosen = rng.sample(native, take_native)
        if remaining > 0:
            chosen += rng.sample(swimup, remaining)
        return chosen, take_native

    side_m = pick_side(native_m, swimup_m)
    side_f = pick_side(native_f, swimup_f)
    if side_m is None or side_f is None:
        return None
    chosen_m, native_m_count = side_m
    chosen_f, native_f_count = side_f
    if native_m_count + native_f_count < REQUIRED_NATIVE_COUNT:
        return None
    members = chosen_m + chosen_f
    rng.shuffle(members)
    return members


# ── Generator ────────────────────────────────────────────────────────────────

class EntriesGenerator:
    def __init__(self, meet_type: str, num_clubs: int, num_athletes: int,
                 season_year: int, rng: random.Random):
        self.meet_type = meet_type
        self.season_year = season_year
        self.rng = rng
        self.clubs: list[Club] = []
        self._next_athlete_id = 1
        self._next_agegroup_id = AGEGROUP_ID_BASE[meet_type]
        self._next_final_eventid = FINAL_EVENTID_BASE[meet_type]
        self.events: list[BuiltEvent] = []
        self._build_clubs(num_clubs)
        self._build_athletes(num_athletes)
        self._build_events()

    # -- clubs / athletes --------------------------------------------------

    def _build_clubs(self, num_clubs: int) -> None:
        cities = list(CLUB_CITIES)
        self.rng.shuffle(cities)
        if num_clubs > len(cities):
            cities += [f"Ville{i}" for i in range(num_clubs - len(cities))]
        used_codes: set[str] = set()
        for i in range(num_clubs):
            city = cities[i]
            base_code = "".join(ch for ch in city.upper() if ch.isalpha())[:3] or "CLB"
            code = base_code
            n = 1
            while code in used_codes:
                n += 1
                code = f"{base_code[:2]}{n}"
            used_codes.add(code)
            self.clubs.append(Club(clubid=i + 1, name=f"Club de sauvetage de {city}", code=code))

    def _build_athletes(self, num_athletes: int) -> None:
        if not self.clubs:
            return
        per_club = [num_athletes // len(self.clubs)] * len(self.clubs)
        for i in range(num_athletes % len(self.clubs)):
            per_club[i] += 1
        bracket_cycle = 0
        for club, count in zip(self.clubs, per_club):
            for i in range(count):
                bracket = AGE_CODE_ORDER[bracket_cycle % len(AGE_CODE_ORDER)]
                bracket_cycle += 1
                gender = "M" if (self._next_athlete_id % 2 == 0) else "F"
                names = FIRST_NAMES_M if gender == "M" else FIRST_NAMES_F
                firstname = self.rng.choice(names)
                lastname = self.rng.choice(LAST_NAMES)
                birthdate = birthdate_for_bracket(bracket, self.meet_type, self.season_year, self.rng)
                athlete = Athlete(
                    athleteid=self._next_athlete_id,
                    clubid=club.clubid,
                    firstname=firstname,
                    lastname=lastname,
                    gender=gender,
                    birthdate=birthdate,
                    bracket=bracket,
                    skill=self.rng.uniform(0.85, 1.20),
                )
                self._next_athlete_id += 1
                club.athletes.append(athlete)

    # -- event structure -----------------------------------------------------

    def _new_agegroup_set(self) -> dict[str, int]:
        ids = {}
        for bracket in AGE_CODE_ORDER:
            ids[bracket] = self._next_agegroup_id
            self._next_agegroup_id += 1
        return ids

    def _build_events(self) -> None:
        catalog = POOL_EVENTS if self.meet_type == "POOL" else BEACH_EVENTS
        individual_indices = [i for i, e in enumerate(catalog) if e[6] == 1]
        # Convert roughly a third of individual events to Prelim+Final pairs.
        split_indices = {idx for pos, idx in enumerate(individual_indices) if pos % 3 == 0}

        for idx, (eventid, number, order, swimstyleid, name, distance, relaycount) in enumerate(catalog):
            gender = "ALL"
            if relaycount == 4:
                gender = RELAY_GENDER.get(swimstyleid, "MIXED")
            elif relaycount == 2:
                gender = "ALL"

            agegroup_ids = self._new_agegroup_set()
            is_split = idx in split_indices
            ev = BuiltEvent(
                eventid=eventid, number=number, order=order, swimstyleid=swimstyleid,
                name=name, distance=distance, relaycount=relaycount, gender=gender,
                round="PRE" if is_split else "TIM", agegroup_ids=agegroup_ids,
            )
            if is_split:
                ev.final_eventid = self._next_final_eventid
                self._next_final_eventid += 1
                ev.final_agegroup_ids = self._new_agegroup_set()
            self.events.append(ev)

    # -- individual entries ---------------------------------------------------

    def _generate_individual_entries(self) -> list[tuple[Athlete, BuiltEvent]]:
        """Every athlete enters a random subset of the individual (relaycount=1)
        events open to their bracket -- guaranteed >=1 entry each (see module
        docstring: "for all athletes" means full athlete coverage, not that
        every athlete swims every event)."""
        individual_events = [e for e in self.events if e.relaycount == 1]
        pairs: list[tuple[Athlete, BuiltEvent]] = []
        for club in self.clubs:
            for athlete in club.athletes:
                if not individual_events:
                    continue
                k = self.rng.randint(min(3, len(individual_events)), len(individual_events))
                chosen = self.rng.sample(individual_events, k)
                for ev in chosen:
                    pairs.append((athlete, ev))
        return pairs

    # -- relay / pair teams ---------------------------------------------------

    def _relays_for_event(self, ev: BuiltEvent, club: Club) -> list[tuple[list[Athlete], str]]:
        """Builds this club's relay teams (relaycount=4) for one event, one team
        per eligible bracket (plus one unrestricted team for SERC)."""
        teams: list[tuple[list[Athlete], str]] = []
        used: set[int] = set()

        if ev.swimstyleid == SERC_SWIMSTYLE_ID:
            pool = [a for a in club.athletes if a.athleteid not in used]
            if len(pool) >= 4:
                team = self.rng.sample(pool, 4)
                self.rng.shuffle(team)
                teams.append((team, "Open"))  # bracket unused (unrestricted), just needs a valid agegroupid
            return teams

        by_bracket_gender: dict[tuple[str, str], list[Athlete]] = {}
        for a in club.athletes:
            by_bracket_gender.setdefault((a.bracket, a.gender), []).append(a)

        for bracket in AGE_CODE_ORDER:
            younger = adjacent_younger(bracket)

            def pool_for(gender: str, br: str | None) -> list[Athlete]:
                if br is None:
                    return []
                return [a for a in by_bracket_gender.get((br, gender), []) if a.athleteid not in used]

            if ev.gender == "MIXED":
                team = pick_mixed_team(
                    pool_for("M", bracket), pool_for("M", younger),
                    pool_for("F", bracket), pool_for("F", younger),
                    self.rng,
                )
            else:
                g = ev.gender  # "M" or "F"
                team = pick_team(pool_for(g, bracket), pool_for(g, younger), 4, self.rng)

            if team:
                teams.append((team, bracket))
                used.update(a.athleteid for a in team)

        return teams

    def _pairs_for_event(self, ev: BuiltEvent, club: Club) -> list[tuple[list[Athlete], str]]:
        """relaycount=2 events: simple 2-person teams, same club/gender/bracket
        (no documented compliance rule for these -- see module docstring)."""
        teams: list[tuple[list[Athlete], str]] = []
        by_bracket_gender: dict[tuple[str, str], list[Athlete]] = {}
        for a in club.athletes:
            by_bracket_gender.setdefault((a.bracket, a.gender), []).append(a)
        for (bracket, gender), pool in by_bracket_gender.items():
            shuffled = list(pool)
            self.rng.shuffle(shuffled)
            for i in range(0, len(shuffled) - 1, 2):
                teams.append((shuffled[i:i + 2], bracket))
        return teams


# ── XML construction ─────────────────────────────────────────────────────────

def build_lxf(gen: EntriesGenerator, meet_name: str) -> Element:
    lenex = Element("LENEX", {"version": "3.0"})

    constructor = SubElement(lenex, "CONSTRUCTOR", {
        "name": "Sauvetage Sportif -- Test Data Generator",
        "registration": "Société de Sauvetage",
        "version": "1.0",
    })
    SubElement(constructor, "CONTACT", {"name": "generate_entries_lxf.py"})

    meets = SubElement(lenex, "MEETS")
    meet = SubElement(meets, "MEET", {
        "name": meet_name,
        "course": MEET_COURSE[gen.meet_type],
        "nation": "CAN",
        "state": "QC",
    })
    SubElement(meet, "AGEDATE", {"value": f"{gen.season_year}-12-31", "type": "DATE"})

    sessions = SubElement(meet, "SESSIONS")
    session = SubElement(sessions, "SESSION", {
        "number": "1", "name": "Styles", "daytime": "08:00",
        "date": f"{gen.season_year}-{'02' if gen.meet_type == 'POOL' else '07'}-15",
        "course": MEET_COURSE[gen.meet_type],
    })
    events_el = SubElement(session, "EVENTS")

    def append_event(eventid: int, number: int, order: int, swimstyleid: int, name: str,
                      distance: int, relaycount: int, gender: str, round_: str,
                      preveventid: int, agegroup_ids: dict[str, int]) -> None:
        event_el = SubElement(events_el, "EVENT", {
            "eventid": str(eventid), "number": str(number), "order": str(order),
            "gender": gender, "round": round_, "preveventid": str(preveventid),
        })
        style_attrs = {"relaycount": str(relaycount), "swimstyleid": str(swimstyleid), "name": name,
                        "stroke": "UNKNOWN"}
        if swimstyleid != SERC_SWIMSTYLE_ID:  # template omits distance only for SERC, writes "0" elsewhere
            style_attrs["distance"] = str(distance)
        SubElement(event_el, "SWIMSTYLE", style_attrs)
        agegroups_el = SubElement(event_el, "AGEGROUPS")
        for bracket in AGE_CODE_ORDER:
            lo, hi = BRACKET_RANGE[bracket]
            SubElement(agegroups_el, "AGEGROUP", {
                "agegroupid": str(agegroup_ids[bracket]),
                "agemin": str(lo), "agemax": str(hi),
            })

    order_counter = 1
    for ev in gen.events:
        append_event(ev.eventid, ev.number, order_counter, ev.swimstyleid, ev.name, ev.distance,
                     ev.relaycount, ev.gender, ev.round, -1, ev.agegroup_ids)
        order_counter += 1
        if ev.final_eventid is not None:
            append_event(ev.final_eventid, ev.number, order_counter, ev.swimstyleid,
                         ev.name, ev.distance, ev.relaycount, ev.gender, "FIN",
                         ev.eventid, ev.final_agegroup_ids)
            order_counter += 1

    # -- clubs / athletes / entries / relays --
    clubs_el = SubElement(meet, "CLUBS")
    individual_pairs = gen._generate_individual_entries()
    entries_by_athlete: dict[int, list[BuiltEvent]] = {}
    for athlete, ev in individual_pairs:
        entries_by_athlete.setdefault(athlete.athleteid, []).append(ev)

    relaycount4_events = [e for e in gen.events if e.relaycount == 4]
    relaycount2_events = [e for e in gen.events if e.relaycount == 2]

    for club in gen.clubs:
        club_el = SubElement(clubs_el, "CLUB", {
            "clubid": str(club.clubid), "name": club.name, "code": club.code, "nation": "CAN",
        })
        athletes_el = SubElement(club_el, "ATHLETES")
        for athlete in club.athletes:
            athlete_el = SubElement(athletes_el, "ATHLETE", {
                "athleteid": str(athlete.athleteid),
                "firstname": athlete.firstname,
                "lastname": athlete.lastname,
                "gender": athlete.gender,
                "birthdate": athlete.birthdate.isoformat(),
            })
            entries_el = SubElement(athlete_el, "ENTRIES")
            for ev in entries_by_athlete.get(athlete.athleteid, []):
                entry_attrs = {
                    "eventid": str(ev.eventid),
                    "agegroupid": str(ev.agegroup_ids[athlete.bracket]),
                }
                if gen.meet_type == "POOL":
                    entry_attrs["entrycourse"] = MEET_COURSE["POOL"]
                    time_ms = estimate_time_ms(ev.distance, athlete.skill, gen.rng)
                    lenex_time = ms_to_lenex_time(time_ms)
                    if lenex_time and gen.rng.random() < 0.7:  # ~30% NT, like a real meet
                        entry_attrs["entrytime"] = lenex_time
                SubElement(entries_el, "ENTRY", entry_attrs)

        relays_el = SubElement(club_el, "RELAYS")
        relay_number = 1

        for ev in relaycount4_events:
            for members, bracket in gen._relays_for_event(ev, club):
                agegroup_id = ev.agegroup_ids[bracket]
                lo, hi = BRACKET_RANGE[bracket]
                relay_el = SubElement(relays_el, "RELAY", {
                    "number": str(relay_number), "gender": ev.gender,
                    "name": "/".join(m.lastname for m in members),
                    "agemin": str(lo), "agemax": str(hi),
                })
                relay_number += 1
                relay_entries_el = SubElement(relay_el, "ENTRIES")
                relay_entry_attrs = {"eventid": str(ev.eventid), "agegroupid": str(agegroup_id)}
                if gen.meet_type == "POOL":
                    relay_entry_attrs["entrycourse"] = MEET_COURSE["POOL"]
                relay_entry_el = SubElement(relay_entries_el, "ENTRY", relay_entry_attrs)
                positions_el = SubElement(relay_entry_el, "RELAYPOSITIONS")
                for pos, member in enumerate(members, start=1):
                    SubElement(positions_el, "RELAYPOSITION", {
                        "number": str(pos), "athleteid": str(member.athleteid),
                    })

        for ev in relaycount2_events:
            for members, bracket in gen._pairs_for_event(ev, club):
                agegroup_id = ev.agegroup_ids[bracket]
                lo, hi = BRACKET_RANGE[bracket]
                relay_el = SubElement(relays_el, "RELAY", {
                    "number": str(relay_number), "gender": members[0].gender,
                    "name": "/".join(m.lastname for m in members),
                    "agemin": str(lo), "agemax": str(hi),
                })
                relay_number += 1
                relay_entries_el = SubElement(relay_el, "ENTRIES")
                relay_entry_attrs = {"eventid": str(ev.eventid), "agegroupid": str(agegroup_id)}
                if gen.meet_type == "POOL":
                    relay_entry_attrs["entrycourse"] = MEET_COURSE["POOL"]
                relay_entry_el = SubElement(relay_entries_el, "ENTRY", relay_entry_attrs)
                positions_el = SubElement(relay_entry_el, "RELAYPOSITIONS")
                for pos, member in enumerate(members, start=1):
                    SubElement(positions_el, "RELAYPOSITION", {
                        "number": str(pos), "athleteid": str(member.athleteid),
                    })

    return lenex


def write_lxf(root: Element, output_path: Path) -> None:
    xml_bytes = b'<?xml version="1.0" encoding="UTF-8"?>\n' + tostring(root, encoding="UTF-8")
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("entries.lef", xml_bytes)


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a synthetic LENEX entries file.")
    parser.add_argument("--clubs", type=int, required=True, help="Number of clubs to generate")
    parser.add_argument("--athletes", type=int, required=True, help="Total number of athletes")
    parser.add_argument("--type", choices=["pool", "beach"], required=True, help="Meet type")
    parser.add_argument("--output", type=Path, required=True, help="Output .lxf path")
    parser.add_argument("--seed", type=int, default=None, help="Random seed (reproducible output)")
    parser.add_argument("--season-year", type=int, default=date.today().year,
                        help="Season reference year (AGEDATE=<year>-12-31); default: current year")
    args = parser.parse_args()

    if args.clubs < 1:
        parser.error("--clubs must be >= 1")
    if args.athletes < args.clubs:
        parser.error("--athletes must be >= --clubs")

    rng = random.Random(args.seed)
    meet_type = args.type.upper()

    gen = EntriesGenerator(meet_type, args.clubs, args.athletes, args.season_year, rng)
    meet_name = f"Meet de test généré ({args.clubs} clubs / {args.athletes} athlètes)"
    root = build_lxf(gen, meet_name)
    write_lxf(root, args.output)

    print(f"Wrote {args.output}")
    print(f"  {len(gen.clubs)} clubs, {sum(len(c.athletes) for c in gen.clubs)} athletes")
    total_events = len(gen.events)
    split_events = sum(1 for e in gen.events if e.final_eventid is not None)
    print(f"  {total_events} {meet_type.lower()} events ({split_events} split into Prelim+Final, "
          f"{total_events - split_events} Finale directe)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
