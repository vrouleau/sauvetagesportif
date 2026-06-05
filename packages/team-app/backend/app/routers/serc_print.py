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

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..models_serc import SercConfig, SercDrawOrder
from ..models_team import Relay, RelayPos, Member, TeamClub

router = APIRouter(prefix="/api/serc/print")

# SERC swimstyle ID
SERC_STYLE_ID = 530

# ── Victim type descriptions (from XLSX sheets) — bilingual ───────────────────

VICTIM_DESCRIPTIONS = {
    "en": {
        "Non Swimmer": {
            "scenario": "The victim is struggling to stay above the water and is starting to panic as they cannot get to safety. They are capable of taking a rescue aid if pushed into their reach (judge will give specifics based upon scenario description). However if a contact rescue is attempted, they will struggle and try to grab hold of the rescuer (they will not turn on their back). They need assistance to get out of the water and when out will be exhausted from the experience.",
            "notes": "Non-swimmer is in imminent danger and is a high priority for rescue. They will attempt to grab any rescuer who approaches them directly without an aid. If a contact rescue is used, low marks should be recorded for the rescue component. The victim should be made safe with an effective and efficient return to safety. Landing should be done with care. They will answer questions asked of them.",
            "criteria": {
                "approach": "Recognition of non-swimmer (high priority), speed of reaching victim\nSafe approach by rescuer",
                "rescue": "Rescue with extreme caution\n(low marks for contact rescue if not required — maximum 5 marks for this section)\nMonitor while still in water; may require further directions/instructions",
                "control": "Clear effective questioning and reassurance\nReassurance during rescue until returned to safety",
                "landing": "Care of the victim; protection of the head\nAppropriate landing for size and strength of rescuer",
                "care": "Safe position away from the edge; warmth and protection where possible; monitor safety; ongoing reassurance",
            },
        },
        "Weak Swimmer": {
            "scenario": "The victim is a weak swimmer struggling to get back to safety. They will be capable of shouting or calling out for help. They will be able to take an aid to get to safety. If a contact carry is performed they will struggle and resist. They will be able to land themselves. They will provide assistance or contact emergency services and will cooperative throughout.",
            "notes": "Weak swimmers need to be made safe very quickly. The victim can be talked at or given signs to return to safety; they will need to be kept monitored. They will struggle if a contact rescue is used; low marks should be awarded for contact rescue.",
            "criteria": {
                "approach": "Recognition that they are a weak swimmer and high priority to mobilize.\nSafe approach by rescuer",
                "rescue": "Encourage return to safety with clear directions; perform a non-contact rescue (low marks for contact rescue if not required — maximum 5 marks for this section)\nMonitor while still in water; may require further directions/instructions",
                "control": "Effective communication / instruction; use for keeping another victim warm / safe",
                "landing": "Make secure and land\nAppropriate landing for size and strength of rescuer",
                "care": "Safe position away from danger; warmth and protection where possible; monitor safety; ongoing monitoring and care",
            },
        },
        "Injured Swimmer": {
            "scenario": "Victim will be complaining of a specific injury and will not be calmed.",
            "notes": "This is a medium priority victim requiring assistance. Rescuer should use an aid. Victim may not be able to hold an aid depending on the injury and may need assistance in the water and on landing. The victim should be removed carefully from the water with attention to the injured part of the body. They will not be cooperative.",
            "criteria": {
                "approach": "Recognition that they are an injured swimmer and medium priority to mobilize\nSafe approach by rescuer",
                "rescue": "Encourage to return to the edge with clear directions\nPerform non-contact rescue\n(low marks for contact rescue if not required — maximum 5 marks for this section)\nMonitor while still in water; may require further directions/instructions",
                "control": "Effective communication / instruction\nReassurance throughout rescue",
                "landing": "Careful removal from water with attention to injury\nMake secure and land (monitor while still in water; may require further directions/instructions)\nAppropriate landing for size and strength of rescuer",
                "care": "Safe position away from the edge; warmth and protection where possible; monitor safety; ongoing monitoring and care",
            },
        },
        "Unconscious Non-Breathing": {
            "scenario": "This victim will be on the bottom of the pool.",
            "notes": "This victim is a low-order rescue priority and rescuers should deal with the high priority victims as quickly as possible in order to get to this victim who requires continuous care.\nCPR should be commenced when it is safe to do so; on land, boat, rescue breaths with a buoyant aid in the water, etc. and your marks should reflect the efficiency and effectiveness of the CPR simulation.",
            "criteria": {
                "approach": "Identification of casualty",
                "rescue": "Speed of rescue (considering priority of rescue)\nSpeed in getting back to safety",
                "control": "Effective and efficient carry",
                "landing": "Careful handling/landing of the casualty",
                "care": "Effective and efficient CPR likely to assist recovery\nSafe position away from danger; monitor safety; ongoing monitoring and care",
            },
        },
    },
    "fr": {
        "Non Swimmer": {
            "scenario": "La victime a de la difficulté à rester à la surface et commence à paniquer car elle ne peut pas se mettre en sécurité. Elle est capable de prendre une aide au sauvetage si on la pousse à sa portée (le juge donnera les détails selon la description du scénario). Cependant, si un sauvetage par contact est tenté, elle se débattra et essaiera d'agripper le sauveteur (elle ne se retournera pas sur le dos). Elle a besoin d'aide pour sortir de l'eau et sera épuisée une fois sortie.",
            "notes": "Le non-nageur est en danger imminent et représente une priorité élevée de sauvetage. Il tentera d'agripper tout sauveteur qui s'approche directement sans aide. Si un sauvetage par contact est utilisé, des notes basses doivent être attribuées pour la composante sauvetage. La victime doit être mise en sécurité de manière efficace et efficiente. Le débarquement doit être fait avec soin. Elle répondra aux questions posées.",
            "criteria": {
                "approach": "Reconnaissance du non-nageur (priorité élevée), vitesse pour atteindre la victime\nApproche sécuritaire par le sauveteur",
                "rescue": "Sauvetage avec extrême prudence\n(notes basses pour sauvetage par contact si non requis — maximum 5 points pour cette section)\nSurveiller dans l'eau; peut nécessiter des directives supplémentaires",
                "control": "Questionnement clair et efficace et réassurance\nRéassurance durant le sauvetage jusqu'au retour en sécurité",
                "landing": "Soin de la victime; protection de la tête\nDébarquement approprié selon la taille et la force du sauveteur",
                "care": "Position sécuritaire loin du bord; chaleur et protection si possible; surveillance; réassurance continue",
            },
        },
        "Weak Swimmer": {
            "scenario": "La victime est un nageur faible qui a de la difficulté à revenir en sécurité. Elle sera capable de crier ou d'appeler à l'aide. Elle sera capable de prendre une aide pour se mettre en sécurité. Si un transport par contact est effectué, elle se débattra et résistera. Elle sera capable de se débarquer elle-même. Elle fournira de l'assistance ou contactera les services d'urgence et coopérera tout au long.",
            "notes": "Les nageurs faibles doivent être mis en sécurité très rapidement. On peut leur parler ou leur faire des signes pour revenir en sécurité; ils devront être surveillés. Ils se débattront si un sauvetage par contact est utilisé; des notes basses doivent être attribuées pour un sauvetage par contact.",
            "criteria": {
                "approach": "Reconnaissance qu'il s'agit d'un nageur faible et priorité élevée à mobiliser.\nApproche sécuritaire par le sauveteur",
                "rescue": "Encourager le retour en sécurité avec des directives claires; effectuer un sauvetage sans contact (notes basses pour contact si non requis — maximum 5 points pour cette section)\nSurveiller dans l'eau; peut nécessiter des directives supplémentaires",
                "control": "Communication / instruction efficace; utiliser pour garder une autre victime au chaud / en sécurité",
                "landing": "Sécuriser et débarquer\nDébarquement approprié selon la taille et la force du sauveteur",
                "care": "Position sécuritaire loin du danger; chaleur et protection si possible; surveillance; soins continus",
            },
        },
        "Injured Swimmer": {
            "scenario": "La victime se plaindra d'une blessure spécifique et ne pourra pas être calmée.",
            "notes": "C'est une victime de priorité moyenne nécessitant de l'assistance. Le sauveteur devrait utiliser une aide. La victime pourrait ne pas être capable de tenir une aide selon la blessure et pourrait avoir besoin d'assistance dans l'eau et au débarquement. La victime doit être retirée soigneusement de l'eau avec attention à la partie blessée du corps. Elle ne sera pas coopérative.",
            "criteria": {
                "approach": "Reconnaissance qu'il s'agit d'un nageur blessé et priorité moyenne à mobiliser\nApproche sécuritaire par le sauveteur",
                "rescue": "Encourager à revenir au bord avec des directives claires\nEffectuer un sauvetage sans contact\n(notes basses pour contact si non requis — maximum 5 points pour cette section)\nSurveiller dans l'eau; peut nécessiter des directives supplémentaires",
                "control": "Communication / instruction efficace\nRéassurance tout au long du sauvetage",
                "landing": "Retrait soigneux de l'eau avec attention à la blessure\nSécuriser et débarquer (surveiller dans l'eau; peut nécessiter des directives supplémentaires)\nDébarquement approprié selon la taille et la force du sauveteur",
                "care": "Position sécuritaire loin du bord; chaleur et protection si possible; surveillance; soins continus",
            },
        },
        "Unconscious Non-Breathing": {
            "scenario": "Cette victime sera au fond de la piscine.",
            "notes": "Cette victime est une priorité de sauvetage de bas ordre et les sauveteurs doivent s'occuper des victimes prioritaires le plus rapidement possible afin d'atteindre cette victime qui nécessite des soins continus.\nLa RCR doit être commencée lorsque c'est sécuritaire; sur terre, bateau, insufflations avec une aide flottante dans l'eau, etc. Vos notes doivent refléter l'efficacité de la simulation de RCR.",
            "criteria": {
                "approach": "Identification de la victime",
                "rescue": "Vitesse du sauvetage (considérant la priorité)\nVitesse de retour en sécurité",
                "control": "Transport efficace et efficient",
                "landing": "Manipulation/débarquement soigneux de la victime",
                "care": "RCR efficace et efficiente susceptible d'aider à la récupération\nPosition sécuritaire loin du danger; surveillance; soins continus",
            },
        },
    },
}

OVERALL_DESCRIPTION = {
    "en": {
        "notes": "You have the overview of the SERC area and assess overall efficiency of the team. In particular you mark the Team Leader's control of the team — assessment of priorities and dispatch/direction of team members to deal with the victims. You will also mark communication between the Leader and the team and between team members and this may include information about the condition of the victims and what help is needed. Your marks MUST take into account:",
        "bullets": [
            "Any loss of control by the Leader becoming committed or involved to such an extent that overall control is lost.",
            "Do not mark any rescues the leader carries out as another judge is allocated to that victim.",
            "Whether assistance was sought. Any person sent for help as assistant will not be allowed to return.",
        ],
        "criteria": {
            "assessment": "Assessment of the emergency\nDid the Leader coordinate the team and direct to the correct priorities of rescue?\nOn-going assessment / re-assessment",
            "control": "Control and safety over the scenario area\nLeader retains control throughout the scenario\nOn-going assessment / re-assessment",
            "communication": "Communication and feedback between Leader and team members,\nAnd between team members and victims\nBasic questioning and simple instructions given to victims and team\nNote: Emphasis is on non-verbal and simple verbal communication and not on extensive verbal communication.",
            "search": "Effective search of scenario area\nIdentification and location of victims",
            "teamwork": "Teamwork, summon assistance (emergency services called) with appropriate information provided\nIdentification and securing of all victims\nEffective use of bystanders / victims",
        },
    },
    "fr": {
        "notes": "Vous avez une vue d'ensemble de la zone SERC et évaluez l'efficacité globale de l'équipe. En particulier, vous notez le contrôle du chef d'équipe — évaluation des priorités et répartition/direction des membres de l'équipe pour s'occuper des victimes. Vous noterez aussi la communication entre le chef et l'équipe et entre les membres, incluant l'information sur l'état des victimes et l'aide nécessaire. Vos notes DOIVENT tenir compte de:",
        "bullets": [
            "Toute perte de contrôle du chef devenant trop impliqué au point de perdre le contrôle global.",
            "Ne pas noter les sauvetages effectués par le chef car un autre juge est assigné à cette victime.",
            "Si de l'aide a été demandée. Toute personne envoyée chercher de l'aide ne pourra pas revenir.",
        ],
        "criteria": {
            "assessment": "Évaluation de l'urgence\nLe chef a-t-il coordonné l'équipe et dirigé vers les bonnes priorités de sauvetage?\nÉvaluation / réévaluation continue",
            "control": "Contrôle et sécurité de la zone du scénario\nLe chef maintient le contrôle tout au long du scénario\nÉvaluation / réévaluation continue",
            "communication": "Communication et rétroaction entre le chef et les membres de l'équipe,\nEt entre les membres et les victimes\nQuestionnement de base et instructions simples données aux victimes et à l'équipe\nNote: L'accent est sur la communication non verbale et verbale simple, pas sur une communication verbale extensive.",
            "search": "Recherche efficace de la zone du scénario\nIdentification et localisation des victimes",
            "teamwork": "Travail d'équipe, demander de l'assistance (services d'urgence appelés) avec information appropriée\nIdentification et sécurisation de toutes les victimes\nUtilisation efficace des passants / victimes",
        },
    },
}

BYSTANDER_DESCRIPTION = {
    "en": {
        "scenario": "The bystander will not offer assistance but will be cooperative and take direction.",
        "notes": "This is a high priority bystander as they can lend assistance when given direction.",
        "criteria": {
            "approach": {"label": "Victim Recognition/Approach", "desc": "Recognition that they are a bystander and cooperative."},
            "info": {"label": "Assesses relevant information", "desc": "Questions bystander to assess information about the scenario.\n(low marks for not giving the bystander directions — maximum 5 marks for this section)"},
            "directions": {"label": "Provides directions and instructions", "desc": "Rescuer provides directions or instructions to assist the rescue scenario such as; asst. removals, reassure victims, call emergency services."},
            "monitoring": {"label": "Monitoring bystander actions", "desc": "Check periodically to ensure that bystander has followed the directions of the Rescuer throughout rescue."},
            "encouragement": {"label": "Provides ongoing encouragement", "desc": "Provides feedback to bystander on their actions to encourage them to assist with victim support."},
        },
    },
    "fr": {
        "scenario": "Le passant n'offrira pas d'assistance mais sera coopératif et suivra les directives.",
        "notes": "C'est un passant de haute priorité car il peut prêter assistance lorsqu'on lui donne des directives.",
        "criteria": {
            "approach": {"label": "Reconnaissance / Approche", "desc": "Reconnaissance qu'il s'agit d'un passant et qu'il est coopératif."},
            "info": {"label": "Évalue les informations pertinentes", "desc": "Questionne le passant pour évaluer les informations sur le scénario.\n(notes basses pour ne pas avoir donné de directives au passant — maximum 5 points pour cette section)"},
            "directions": {"label": "Fournit des directives et instructions", "desc": "Le sauveteur fournit des directives ou instructions pour assister le scénario de sauvetage; retraits, rassurer les victimes, appeler les services d'urgence."},
            "monitoring": {"label": "Surveillance des actions du passant", "desc": "Vérifier périodiquement que le passant a suivi les directives du sauveteur tout au long du sauvetage."},
            "encouragement": {"label": "Encouragement continu", "desc": "Fournit une rétroaction au passant sur ses actions pour l'encourager à assister au soutien des victimes."},
        },
    },
}

# Bilingual labels
LABELS = {
    "fr": {
        "judge_sheet": "FEUILLE DE POINTAGE DU JUGE",
        "draw_no": "Tirage No:",
        "team_name": "Nom d'équipe:",
        "judge_id": "Identification du juge:",
        "victim": "Victime",
        "judges_notes": "Notes du juge",
        "scale_excellent": "Excellent 10",
        "scale_vgood": "Très bien 9.5-7.5",
        "scale_satisfactory": "Satisfaisant 7.0-5.0",
        "scale_weak": "Faible 4.5-2.5",
        "scale_poor": "Médiocre 2.0-0",
        "areas_marking": "Zones de notation - Note par incréments de 0.5 attribués par le juge.",
        "mark_out_of": "Note sur 10",
        "factor": "Facteur:",
        "approach": "Reconnaissance / Approche de la victime",
        "rescue": "Sauvetage",
        "control": "Contrôle de la victime",
        "landing": "Débarquement",
        "care": "Soins et après-soins de la victime",
        "rough": "Manipulation brutale des victimes - Déduire 10 points",
        "total": "Total:",
        "overall_title": "ÉVALUATION GLOBALE: FEUILLE DU JUGE EN CHEF",
        "bystander_title": "FEUILLE DE POINTAGE DU PASSANT",
        "assessment": "Évaluation",
        "communication": "Communication",
        "search": "Recherche",
        "teamwork": "Travail d'équipe",
        "ns": "Non-nageur",
        "ws": "Nageur faible",
        "is": "Nageur blessé",
        "unb": "Inconscient / Noyade",
    },
    "en": {
        "judge_sheet": "JUDGE SCORING SHEET",
        "draw_no": "Draw No:",
        "team_name": "Team Name:",
        "judge_id": "Judge Identification:",
        "victim": "Victim",
        "judges_notes": "Judge's Notes",
        "scale_excellent": "Excellent 10",
        "scale_vgood": "Very Good 9.5-7.5",
        "scale_satisfactory": "Satisfactory 7.0-5.0",
        "scale_weak": "Weak 4.5-2.5",
        "scale_poor": "Poor 2.0-0",
        "areas_marking": "Areas of Marking - Marking in increments of 0.5 allotted by the judge.",
        "mark_out_of": "Mark out of 10",
        "factor": "Factor:",
        "approach": "Victim recognition/approach",
        "rescue": "Rescue",
        "control": "Control of victim",
        "landing": "Landing",
        "care": "Care and Aftercare of Victim",
        "rough": "Rough handling of victims - Deduct 10 points",
        "total": "Total:",
        "overall_title": "OVERALL: CHIEF JUDGE SCORING SHEET",
        "bystander_title": "BYSTANDER SCORING SHEET",
        "assessment": "Assessment",
        "communication": "Communication",
        "search": "Search",
        "teamwork": "Teamwork",
        "ns": "Non Swimmer",
        "ws": "Weak Swimmer",
        "is": "Injured Swimmer",
        "unb": "Unconscious Non-Breathing",
    },
}

VICTIM_TYPE_KEY = {
    "Non Swimmer": "ns",
    "Weak Swimmer": "ws",
    "Injured Swimmer": "is",
    "Unconscious Non-Breathing": "unb",
}


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

def _render_victim_sheet(victim_num: int, victim_type: str, factors: dict, lang: str, team_name: str = "", draw_num: int | str = "") -> str:
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

        <div class="meta-row">
            <span>{t['draw_no']} <span class="field">{draw_num}</span></span>
            <span>{t['team_name']} <span class="field">{team_name}</span></span>
        </div>
        <div class="meta-row">
            <span></span>
            <span>{t['judge_id']} <span class="field"></span></span>
        </div>

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


def _render_overall_sheet(factors: dict, lang: str, team_name: str = "", draw_num: int | str = "") -> str:
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

        <div class="meta-row">
            <span>{t['draw_no']} <span class="field">{draw_num}</span></span>
            <span>{t['team_name']} <span class="field">{team_name}</span></span>
        </div>
        <div class="meta-row">
            <span></span>
            <span>{t['judge_id']} <span class="field"></span></span>
        </div>

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


def _render_bystander_sheet(factors: dict, lang: str, team_name: str = "", draw_num: int | str = "") -> str:
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

        <div class="meta-row">
            <span>{t['draw_no']} <span class="field">{draw_num}</span></span>
            <span>{t['team_name']} <span class="field">{team_name}</span></span>
        </div>
        <div class="meta-row">
            <span></span>
            <span>{t['judge_id']} <span class="field"></span></span>
        </div>

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

    langs = ["fr", "en"] if lang == "bilingual" else [lang if lang in ("fr", "en") else "fr"]

    # Get teams from relay entries in draw order
    relays = db.query(Relay).filter(Relay.stylesid == SERC_STYLE_ID).order_by(Relay.teamnumb).all()
    teams_map: dict[int, str] = {}
    for relay in relays:
        positions = db.query(RelayPos).filter(RelayPos.relaysid == relay.relaysid).order_by(RelayPos.numb).all()
        members = []
        for pos in positions:
            if pos.membersid:
                member = db.query(Member).get(pos.membersid)
                if member:
                    members.append(member.lastname)
        club = db.query(TeamClub).get(relay.clubsid) if relay.clubsid else None
        club_name = (club.name or club.code or "") if club else ""
        team_name = "/".join(m for m in members if m) if members else club_name
        teams_map[relay.relaysid] = team_name

    # Get draw order (position 1,2,3... = draw number for each team)
    orders = (
        db.query(SercDrawOrder)
        .filter(SercDrawOrder.config_id == config.id, SercDrawOrder.draw_number == 1)
        .order_by(SercDrawOrder.position)
        .all()
    )
    if orders:
        ordered = [(o.position, o.relay_team_id, teams_map.get(o.relay_team_id, f"Team {o.position}")) for o in orders]
    else:
        # Fall back to natural order
        ordered = [(i + 1, rid, name) for i, (rid, name) in enumerate(teams_map.items())]

    sheets_html = ""

    # For each team: generate all section pages
    for draw_pos, relay_team_id, team_name in ordered:
        # Overall
        for ln in langs:
            sheets_html += _render_overall_sheet(overall_factors, ln, team_name=team_name, draw_num=draw_pos)

        # Bystander
        if config.has_bystander:
            for ln in langs:
                sheets_html += _render_bystander_sheet(bystander_factors, ln, team_name=team_name, draw_num=draw_pos)

        # Victims
        for i in range(config.num_victims):
            vf = victim_factors[i] if i < len(victim_factors) else {}
            victim_type = vf.get("type", "Non Swimmer")
            for ln in langs:
                sheets_html += _render_victim_sheet(i + 1, victim_type, vf, ln, team_name=team_name, draw_num=draw_pos)

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
