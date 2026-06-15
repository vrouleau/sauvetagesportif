"""Generate a Splash Meet Backup (.smb) from the current database state.

Queries all meet tables (bsglobal, swimstyle, swimsession, club, athlete,
swimevent, agegroup, heat, swimresult, split, relay, relayposition) and
produces an .smb file compatible with Splash Meet Manager 11.

The column definitions match the meet-app's SMB_TABLES exactly so that
round-trip save/restore works between meet-app and team-app.
"""

from __future__ import annotations

import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from .models import (
    AgeGroup, BsGlobal, Heat, Split, SwimEvent, SwimResult,
    SwimSession, SwimStyle, ROUND_PRE, ROUND_FIN, ROUND_TIM,
)
from .models_team import Member, Relay, RelayPos, TeamClub
from .smb import ColDef, write_smb

# OLE Automation epoch (days since 1899-12-30)
_OLE_EPOCH = datetime(1899, 12, 30)


def _datetime_to_ole(dt: datetime | None) -> float | None:
    """Convert a Python datetime to an OLE Automation date (float days since epoch)."""
    if dt is None:
        return None
    delta = dt - _OLE_EPOCH
    return delta.days + delta.seconds / 86400.0


def _date_to_ole(dt: datetime | None) -> float | None:
    """Convert a date-only datetime to an integer OLE date."""
    if dt is None:
        return None
    delta = dt - _OLE_EPOCH
    return float(delta.days)


# ── Column definitions (must match meet-app's SMB_TABLES exactly) ─────────────

BSGLOBAL_COLS = [
    ColDef("NAME", "S", 50),
    ColDef("DATA", "M", 0),
]

DSQITEM_COLS = [
    ColDef("DSQITEMID", "I", 32),
    ColDef("CODE", "S", 10),
    ColDef("LENEXCODE", "S", 10),
    ColDef("NAME", "S", 250),
    ColDef("OPTIONS", "S", 5),
    ColDef("SORTCODE", "I", 16),
]

SWIMSTYLE_COLS = [
    ColDef("SWIMSTYLEID", "I", 32),
    ColDef("CODE", "S", 10),
    ColDef("DISTANCE", "I", 16),
    ColDef("NAME", "S", 50),
    ColDef("RELAYCOUNT", "I", 16),
    ColDef("STROKE", "I", 16),
    ColDef("SORTCODE", "I", 32),
    ColDef("TECHNIQUE", "I", 16),
    ColDef("UNIQUEID", "I", 16),
]

SWIMSESSION_COLS = [
    ColDef("SWIMSESSIONID", "I", 32),
    ColDef("COURSE", "I", 16),
    ColDef("DAYTIME", "D", 32),
    ColDef("ENDTIME", "D", 32),
    ColDef("FEEATHLETE", "F", 0),
    ColDef("FOLLOWING", "S", 1),
    ColDef("LANEMIN", "I", 16),
    ColDef("LANEMAX", "I", 16),
    ColDef("LANESBYPLACE", "S", 100),
    ColDef("MAXENTRIESATHLETE", "I", 16),
    ColDef("MAXENTRIESRELAY", "I", 16),
    ColDef("NAME", "S", 100),
    ColDef("OFFICIALMEETING", "D", 32),
    ColDef("POOLGLOBAL", "S", 1),
    ColDef("POOLTYPE", "I", 16),
    ColDef("REMARKS", "M", 0),
    ColDef("REMARKSJURY", "M", 0),
    ColDef("ROUNDTOTENTHS", "S", 1),
    ColDef("SESSIONNUMBER", "I", 16),
    ColDef("STARTDATE", "D", 32),
    ColDef("TIMING", "I", 16),
    ColDef("TLMEETING", "D", 32),
    ColDef("TOUCHPADMODE", "I", 16),
    ColDef("WARMUPFROM", "D", 32),
    ColDef("WARMUPUNTIL", "D", 32),
]

CLUB_COLS = [
    ColDef("CLUBID", "I", 32),
    ColDef("BONUSPOINTS", "I", 32),
    ColDef("CLUBTYPE", "I", 16),
    ColDef("CODE", "S", 10),
    ColDef("CONTACTNAME", "S", 50),
    ColDef("CONTACTINTERNET", "S", 150),
    ColDef("CONTACTCITY", "S", 30),
    ColDef("CONTACTCOUNTRY", "S", 2),
    ColDef("CONTACTEMAIL", "S", 50),
    ColDef("CONTACTFAX", "S", 20),
    ColDef("CONTACTPHONE", "S", 20),
    ColDef("CONTACTSTATE", "S", 5),
    ColDef("CONTACTSTREET", "S", 50),
    ColDef("CONTACTSTREET2", "S", 50),
    ColDef("CONTACTZIP", "S", 10),
    ColDef("EXTERNALID", "S", 40),
    ColDef("LONGCODE", "S", 20),
    ColDef("ENTRYCLUBID", "I", 32),
    ColDef("ENTRYEMAILS", "S", 255),
    ColDef("NAME", "S", 80),
    ColDef("NAMEEN", "S", 80),
    ColDef("NATION", "S", 3),
    ColDef("REGION", "S", 10),
    ColDef("SHORTNAME", "S", 30),
    ColDef("SHORTNAMEEN", "S", 30),
    ColDef("SWRID", "I", 32),
    ColDef("TEAMNUMBER", "I", 16),
]

ATHLETE_COLS = [
    ColDef("ATHLETEID", "I", 32),
    ColDef("CLUBID", "I", 32),
    ColDef("FIRSTNAME", "S", 30),
    ColDef("FIRSTNAME_UPPER", "S", 5),
    ColDef("GENDER", "I", 16),
    ColDef("LASTNAME", "S", 50),
    ColDef("LASTNAME_UPPER", "S", 10),
    ColDef("NAMEPREFIX", "S", 20),
    ColDef("BIRTHDATE", "D", 32),
    ColDef("DOMICILE", "S", 50),
    ColDef("EXTERNALID", "S", 40),
    ColDef("FIRSTNAMEEN", "S", 30),
    ColDef("HANDICAPEX", "S", 20),
    ColDef("HANDICAPS", "I", 16),
    ColDef("HANDICAPSB", "I", 16),
    ColDef("HANDICAPSM", "I", 16),
    ColDef("LASTNAMEEN", "S", 50),
    ColDef("LICENSE", "S", 20),
    ColDef("NATION", "S", 3),
    ColDef("SDMSID", "I", 32),
    ColDef("STATUS", "I", 32),
    ColDef("SWIMLEVEL", "S", 10),
    ColDef("SWRID", "I", 32),
    ColDef("SWRHASHKEY", "I", 32),
    ColDef("CLUBCODE2", "S", 10),
    ColDef("COACHNAME", "S", 80),
    ColDef("SCHOOLYEAR", "S", 10),
    ColDef("MIDDLENAME", "S", 50),
    ColDef("MIDDLENAMEEN", "S", 50),
]

SWIMEVENT_COLS = [
    ColDef("SWIMEVENTID", "I", 32),
    ColDef("COMMENT", "M", 0),
    ColDef("DAYTIME", "D", 32),
    ColDef("DURATION", "D", 32),
    ColDef("ENTRYTIMECONVERSION", "I", 16),
    ColDef("ENTRYTIMEPERCENT", "I", 16),
    ColDef("EVENTNUMBER", "I", 16),
    ColDef("EXTERNALID", "S", 40),
    ColDef("FEE", "F", 0),
    ColDef("FINALORDER", "I", 16),
    ColDef("GENDER", "I", 16),
    ColDef("LANEMAX", "I", 16),
    ColDef("LYTENTRYLIST", "I", 32),
    ColDef("LYTSTARTLIST", "I", 32),
    ColDef("LYTRESULT2COLUMN", "I", 32),
    ColDef("LYTRESULT2SPLIT", "I", 32),
    ColDef("LYTRESULT4SPLIT", "I", 32),
    ColDef("LYTRESULTNOSPLIT", "I", 32),
    ColDef("LYTRESULTHTML", "I", 32),
    ColDef("MASTERS", "S", 1),
    ColDef("MAXENTRIES", "I", 16),
    ColDef("PFINEIGNORE", "S", 1),
    ColDef("PREVEVENTID", "I", 32),
    ColDef("QUALBYPLACE", "I", 16),
    ColDef("ROUND", "I", 16),
    ColDef("SEEDBONUSLAST", "S", 1),
    ColDef("SEEDEXHLAST", "S", 1),
    ColDef("SEEDLATEENTRYLAST", "S", 1),
    ColDef("SEEDINGGLOBAL", "S", 1),
    ColDef("SINGLEHEATS", "I", 16),
    ColDef("SORTCODE", "I", 32),
    ColDef("SPLASHMECANEDIT", "S", 1),
    ColDef("SPONSOR", "S", 50),
    ColDef("SWIMSESSIONID", "I", 32),
    ColDef("SWIMSTYLEID", "I", 32),
    ColDef("TWOPERLANE", "S", 1),
    ColDef("ROUNDNAME", "S", 50),
    ColDef("COMBINEAGEGROUPS", "S", 1),
    ColDef("ROUNDONE", "S", 20),
    ColDef("INTERNALEVENT", "S", 1),
]

AGEGROUP_COLS = [
    ColDef("AGEGROUPID", "I", 32),
    ColDef("AGEBYTOTAL", "S", 1),
    ColDef("AGEMAX", "I", 16),
    ColDef("AGEMAX2", "I", 16),
    ColDef("AGEMIN", "I", 16),
    ColDef("AGEMIN2", "I", 16),
    ColDef("ALLOFFICIAL", "S", 1),
    ColDef("ATHLETESTATUSES", "I", 32),
    ColDef("CLUBIDS", "M", 0),
    ColDef("CODE", "S", 10),
    ColDef("EXTERNALID", "S", 40),
    ColDef("FASTHEATCOUNT", "I", 16),
    ColDef("FORCEPRELIM", "S", 1),
    ColDef("GENDER", "I", 16),
    ColDef("HANDICAPS", "S", 100),
    ColDef("HEATCOUNT", "I", 16),
    ColDef("HEATQUALIPRIORITY", "S", 50),
    ColDef("LEVELMAX", "S", 5),
    ColDef("LEVELMIN", "S", 5),
    ColDef("NAME", "S", 50),
    ColDef("NATIONALITY", "S", 3),
    ColDef("NATIONREGIONS", "M", 0),
    ColDef("RESULTCOUNT", "I", 16),
    ColDef("SCORETYPE", "I", 16),
    ColDef("SEEDWITHTSONLY", "S", 1),
    ColDef("SORTCODE", "I", 32),
    ColDef("SWIMEVENTID", "I", 32),
    ColDef("SWIMLEVELS", "S", 255),
    ColDef("USEFORMEDALS", "S", 1),
    ColDef("USEFORSCORING", "S", 1),
    ColDef("WINNERTITLE", "S", 100),
    ColDef("FOREIGNCOUNT", "I", 16),
    ColDef("FINALSEEDTYPE", "I", 16),
]

HEAT_COLS = [
    ColDef("HEATID", "I", 32),
    ColDef("AGEGROUPID", "I", 32),
    ColDef("AGEGROUPORDER", "I", 32),
    ColDef("DAYTIME", "D", 32),
    ColDef("FINALCODE", "S", 2),
    ColDef("HEATNUMBER", "I", 16),
    ColDef("RACESTATUS", "I", 16),
    ColDef("REMARKS", "M", 0),
    ColDef("SORTCODE", "I", 32),
    ColDef("SWIMEVENTID", "I", 32),
    ColDef("NAME", "S", 50),
    ColDef("SEEDEVENTID", "I", 32),
    ColDef("CODE", "S", 10),
    ColDef("RESERVECOUNT", "I", 16),
    ColDef("FOREIGNCOUNT", "I", 16),
]

SWIMRESULT_COLS = [
    ColDef("SWIMRESULTID", "I", 32),
    ColDef("ATHLETEID", "I", 32),
    ColDef("SWRABESTID", "I", 32),
    ColDef("SWRABESTTIME", "I", 32),
    ColDef("SWRSBESTID", "I", 32),
    ColDef("SWRSBESTTIME", "I", 32),
    ColDef("AGEGROUPID", "I", 32),
    ColDef("BACKUPTIME1", "I", 32),
    ColDef("BACKUPTIME2", "I", 32),
    ColDef("BACKUPTIME3", "I", 32),
    ColDef("BONUSENTRY", "S", 1),
    ColDef("COMMENT", "S", 250),
    ColDef("DSQITEMID", "I", 32),
    ColDef("DSQDAYTIME", "D", 32),
    ColDef("DSQNOTIFIED", "S", 1),
    ColDef("DSQNUMBER", "I", 16),
    ColDef("ENTRYCOURSE", "I", 16),
    ColDef("ENTRYTIME", "I", 32),
    ColDef("FINALFIX", "S", 1),
    ColDef("FINISHJUDGE", "I", 16),
    ColDef("HEATID", "I", 32),
    ColDef("INFOCODE", "S", 5),
    ColDef("LANE", "I", 16),
    ColDef("LATEENTRY", "S", 1),
    ColDef("MPOINTS", "I", 16),
    ColDef("PADTIME", "I", 32),
    ColDef("QTCITY", "S", 30),
    ColDef("QTCOURSE", "I", 16),
    ColDef("QTDATE", "D", 32),
    ColDef("QTNAME", "S", 100),
    ColDef("QTNATION", "S", 3),
    ColDef("QTTIME", "I", 32),
    ColDef("QUALCODE", "S", 2),
    ColDef("REACTIONTIME", "I", 16),
    ColDef("RESULTSTATUS", "I", 16),
    ColDef("SWIMEVENTID", "I", 32),
    ColDef("SWIMTIME", "I", 32),
    ColDef("USETIMETYPE", "I", 16),
    ColDef("DSQOFFICIALID", "I", 32),
    ColDef("RESERVECODE", "S", 20),
    ColDef("NOADVANCE", "S", 1),
    ColDef("OFFICIALSPLITS", "S", 100),
    ColDef("QTTIMING", "I", 16),
]

SPLIT_COLS = [
    ColDef("SWIMRESULTID", "I", 32),
    ColDef("DISTANCE", "I", 16),
    ColDef("SWIMTIME", "I", 32),
]

RELAY_COLS = [
    ColDef("RELAYID", "I", 32),
    ColDef("AGEGROUPID", "I", 32),
    ColDef("AGEMAX", "I", 16),
    ColDef("AGEMIN", "I", 16),
    ColDef("AGETOTAL", "I", 16),
    ColDef("ATHLETES", "I", 16),
    ColDef("BACKUPTIME1", "I", 32),
    ColDef("BACKUPTIME2", "I", 32),
    ColDef("BACKUPTIME3", "I", 32),
    ColDef("BONUSENTRY", "S", 1),
    ColDef("CLUBID", "I", 32),
    ColDef("COMMENT", "S", 250),
    ColDef("DSQITEMID", "I", 32),
    ColDef("DSQDAYTIME", "D", 32),
    ColDef("DSQNOTIFIED", "S", 1),
    ColDef("DSQNUMBER", "I", 16),
    ColDef("DSQOFFICIALID", "I", 32),
    ColDef("ENTRYCOURSE", "I", 16),
    ColDef("ENTRYTIME", "I", 32),
    ColDef("FINALFIX", "S", 1),
    ColDef("FINISHJUDGE", "I", 16),
    ColDef("GENDER", "I", 16),
    ColDef("HEATID", "I", 32),
    ColDef("INFOCODE", "S", 5),
    ColDef("LANE", "I", 16),
    ColDef("LATEENTRY", "S", 1),
    ColDef("MPOINTS", "I", 16),
    ColDef("NAME", "S", 100),
    ColDef("NOADVANCE", "S", 1),
    ColDef("OFFICIALSPLITS", "S", 100),
    ColDef("PADTIME", "I", 32),
    ColDef("QTCITY", "S", 30),
    ColDef("QTCOURSE", "I", 16),
    ColDef("QTDATE", "D", 32),
    ColDef("QTNAME", "S", 100),
    ColDef("QTNATION", "S", 3),
    ColDef("QTTIME", "I", 32),
    ColDef("QTTIMING", "I", 16),
    ColDef("QUALCODE", "S", 2),
    ColDef("REACTIONTIME", "I", 16),
    ColDef("RELAYCODE", "I", 16),
    ColDef("RESERVECODE", "S", 20),
    ColDef("RESULTSTATUS", "I", 16),
    ColDef("SWIMEVENTID", "I", 32),
    ColDef("SWIMTIME", "I", 32),
    ColDef("TEAMNUMBER", "I", 16),
    ColDef("USETIMETYPE", "I", 16),
]

RELAYPOSITION_COLS = [
    ColDef("RELAYID", "I", 32),
    ColDef("ATHLETEID", "I", 32),
    ColDef("QTCITY", "S", 30),
    ColDef("QTCOURSE", "I", 16),
    ColDef("QTDATE", "D", 32),
    ColDef("QTISLAP", "S", 1),
    ColDef("QTNAME", "S", 100),
    ColDef("QTNATION", "S", 3),
    ColDef("QTTIME", "I", 32),
    ColDef("QTTIMING", "I", 16),
    ColDef("REACTIONTIME", "I", 16),
    ColDef("RELAYNUMBER", "I", 16),
    ColDef("RESULTSTATUS", "I", 16),
]


# ── Canonical → Splash MDB round encoding ────────────────────────────────────
# Canonical: 1=PRE, 2=SEM, 4=FIN, 5=TIM
# Splash:    2=PRE, 2=SEM, 9=FIN, 1=TIM

def _to_mdb_round(canonical_round: int | None) -> int | None:
    if canonical_round is None:
        return None
    if canonical_round == ROUND_PRE:
        return 2
    if canonical_round == ROUND_FIN:
        return 9
    if canonical_round == ROUND_TIM:
        return 1
    return canonical_round


# ── Main export function ──────────────────────────────────────────────────────

def generate_smb_from_db(db: Session) -> bytes:
    """Generate a complete .smb file from the current database state.

    Returns the raw bytes of the .smb ZIP file.
    """
    table_data: dict[str, tuple[list[ColDef], list[dict[str, Any]]]] = {}

    # ── BSGLOBAL ──────────────────────────────────────────────────────────
    bsglobal_rows = []
    for row in db.query(BsGlobal).all():
        bsglobal_rows.append({"name": row.name, "data": row.data or ""})
    table_data["BSGLOBAL"] = (BSGLOBAL_COLS, bsglobal_rows)

    # ── DSQITEM (empty — team-app doesn't store these) ────────────────────
    table_data["DSQITEM"] = (DSQITEM_COLS, [])

    # ── SWIMSTYLE ─────────────────────────────────────────────────────────
    swimstyle_rows = []
    for s in db.query(SwimStyle).order_by(SwimStyle.sortcode).all():
        swimstyle_rows.append({
            "swimstyleid": s.swimstyleid,
            "code": s.code,
            "distance": s.distance,
            "name": s.name,
            "relaycount": s.relaycount,
            "stroke": s.stroke,
            "sortcode": s.sortcode,
            "technique": s.technique,
            "uniqueid": s.uniqueid,
        })
    table_data["SWIMSTYLE"] = (SWIMSTYLE_COLS, swimstyle_rows)

    # ── SWIMSESSION ──────────────────────────────────────────────────────
    swimsession_rows = []
    for ss in db.query(SwimSession).order_by(SwimSession.sessionnumber).all():
        swimsession_rows.append({
            "swimsessionid": ss.swimsessionid,
            "course": ss.course,
            "daytime": _datetime_to_ole(ss.daytime),
            "endtime": _datetime_to_ole(ss.endtime),
            "feeathlete": ss.feeathlete,
            "following": ss.following,
            "lanemin": ss.lanemin,
            "lanemax": ss.lanemax,
            "lanesbyplace": ss.lanesbyplace,
            "maxentriesathlete": ss.maxentriesathlete,
            "maxentriesrelay": ss.maxentriesrelay,
            "name": ss.name,
            "officialmeeting": _datetime_to_ole(ss.officialmeeting),
            "poolglobal": ss.poolglobal,
            "pooltype": ss.pooltype,
            "remarks": ss.remarks,
            "remarksjury": ss.remarksjury,
            "roundtotenths": ss.roundtotenths,
            "sessionnumber": ss.sessionnumber,
            "startdate": _datetime_to_ole(ss.startdate),
            "timing": ss.timing,
            "tlmeeting": _datetime_to_ole(ss.tlmeeting),
            "touchpadmode": ss.touchpadmode,
            "warmupfrom": _datetime_to_ole(ss.warmupfrom),
            "warmupuntil": _datetime_to_ole(ss.warmupuntil),
        })
    table_data["SWIMSESSION"] = (SWIMSESSION_COLS, swimsession_rows)

    # ── CLUB ──────────────────────────────────────────────────────────────
    club_rows = []
    for c in db.query(TeamClub).order_by(TeamClub.clubsid).all():
        club_rows.append({
            "clubid": c.clubsid,
            "bonuspoints": None,
            "clubtype": None,
            "code": c.code,
            "contactname": None,
            "contactinternet": None,
            "contactcity": None,
            "contactcountry": None,
            "contactemail": c.email,
            "contactfax": None,
            "contactphone": None,
            "contactstate": None,
            "contactstreet": None,
            "contactstreet2": None,
            "contactzip": None,
            "externalid": None,
            "longcode": None,
            "entryclubid": None,
            "entryemails": None,
            "name": c.name,
            "nameen": c.nameen,
            "nation": c.nation,
            "region": None,
            "shortname": c.shortname,
            "shortnameen": c.shortnameen,
            "swrid": None,
            "teamnumber": c.teamnumb,
        })
    table_data["CLUB"] = (CLUB_COLS, club_rows)

    # ── ATHLETE ───────────────────────────────────────────────────────────
    athlete_rows = []
    for m in db.query(Member).order_by(Member.membersid).all():
        athlete_rows.append({
            "athleteid": m.membersid,
            "clubid": m.clubsid,
            "firstname": m.firstname,
            "firstname_upper": (m.firstname or "")[:5].upper() or None,
            "gender": m.gender,
            "lastname": m.lastname,
            "lastname_upper": (m.lastname or "")[:10].upper() or None,
            "nameprefix": m.nameprefix,
            "birthdate": _date_to_ole(m.birthdate),
            "domicile": None,
            "externalid": None,
            "firstnameen": m.firstnameen,
            "handicapex": m.handicapex,
            "handicaps": None,
            "handicapsb": None,
            "handicapsm": None,
            "lastnameen": m.lastnameen,
            "license": m.license,
            "nation": m.nation,
            "sdmsid": None,
            "status": None,
            "swimlevel": m.swimlevel,
            "swrid": None,
            "swrhashkey": None,
            "clubcode2": None,
            "coachname": None,
            "schoolyear": None,
            "middlename": None,
            "middlenameen": None,
        })
    table_data["ATHLETE"] = (ATHLETE_COLS, athlete_rows)

    # ── SWIMEVENT (with round encoding → Splash MDB) ─────────────────────
    swimevent_rows = []
    for ev in db.query(SwimEvent).order_by(SwimEvent.sortcode).all():
        mdb_round = _to_mdb_round(ev.round)
        # In Splash MDB, PRE events have eventnumber=0 and gender=0
        eventnumber = ev.eventnumber
        gender = ev.gender
        if ev.round == ROUND_PRE:
            eventnumber = 0
            gender = 0
        swimevent_rows.append({
            "swimeventid": ev.swimeventid,
            "comment": ev.comment,
            "daytime": _datetime_to_ole(ev.daytime),
            "duration": _datetime_to_ole(ev.duration),
            "entrytimeconversion": ev.entrytimeconversion,
            "entrytimepercent": ev.entrytimepercent,
            "eventnumber": eventnumber,
            "externalid": ev.externalid,
            "fee": ev.fee,
            "finalorder": ev.finalorder,
            "gender": gender,
            "lanemax": ev.lanemax,
            "lytentrylist": ev.lytentrylist,
            "lytstartlist": ev.lytstartlist,
            "lytresult2column": ev.lytresult2column,
            "lytresult2split": ev.lytresult2split,
            "lytresult4split": ev.lytresult4split,
            "lytresultnosplit": ev.lytresultnosplit,
            "lytresulthtml": ev.lytresulthtml,
            "masters": ev.masters,
            "maxentries": ev.maxentries,
            "pfineignore": ev.pfineignore,
            "preveventid": ev.preveventid,
            "qualbyplace": ev.qualbyplace,
            "round": mdb_round,
            "seedbonuslast": ev.seedbonuslast,
            "seedexhlast": ev.seedexhlast,
            "seedlateentrylast": ev.seedlateentrylast,
            "seedingglobal": ev.seedingglobal,
            "singleheats": ev.singleheats,
            "sortcode": ev.sortcode,
            "splashmecanedit": ev.splashmecanedit,
            "sponsor": ev.sponsor,
            "swimsessionid": ev.swimsessionid,
            "swimstyleid": ev.swimstyleid,
            "twoperlane": ev.twoperlane,
            "roundname": ev.roundname,
            "combineagegroups": ev.combineagegroups,
            "roundone": ev.roundone,
            "internalevent": ev.internalevent,
        })
    table_data["SWIMEVENT"] = (SWIMEVENT_COLS, swimevent_rows)

    # ── AGEGROUP ──────────────────────────────────────────────────────────
    agegroup_rows = []
    for ag in db.query(AgeGroup).order_by(AgeGroup.sortcode).all():
        agegroup_rows.append({
            "agegroupid": ag.agegroupid,
            "agebytotal": ag.agebytotal,
            "agemax": ag.agemax,
            "agemax2": ag.agemax2,
            "agemin": ag.agemin,
            "agemin2": ag.agemin2,
            "allofficial": ag.allofficial,
            "athletestatuses": ag.athletestatuses,
            "clubids": ag.clubids,
            "code": ag.code,
            "externalid": ag.externalid,
            "fastheatcount": ag.fastheatcount,
            "forceprelim": ag.forceprelim,
            "gender": ag.gender,
            "handicaps": ag.handicaps,
            "heatcount": ag.heatcount,
            "heatqualipriority": ag.heatqualipriority,
            "levelmax": ag.levelmax,
            "levelmin": ag.levelmin,
            "name": ag.name,
            "nationality": ag.nationality,
            "nationregions": ag.nationregions,
            "resultcount": ag.resultcount,
            "scoretype": ag.scoretype,
            "seedwithtsonly": ag.seedwithtsonly,
            "sortcode": ag.sortcode,
            "swimeventid": ag.swimeventid,
            "swimlevels": ag.swimlevels,
            "useformedals": ag.useformedals,
            "useforscoring": ag.useforscoring,
            "winnertitle": ag.winnertitle,
            "foreigncount": ag.foreigncount,
            "finalseedtype": ag.finalseedtype,
        })
    table_data["AGEGROUP"] = (AGEGROUP_COLS, agegroup_rows)

    # ── HEAT ──────────────────────────────────────────────────────────────
    heat_rows = []
    for h in db.query(Heat).order_by(Heat.sortcode).all():
        heat_rows.append({
            "heatid": h.heatid,
            "agegroupid": h.agegroupid,
            "agegrouporder": h.agegrouporder,
            "daytime": _datetime_to_ole(h.daytime),
            "finalcode": h.finalcode,
            "heatnumber": h.heatnumber,
            "racestatus": h.racestatus,
            "remarks": h.remarks,
            "sortcode": h.sortcode,
            "swimeventid": h.swimeventid,
            "name": h.name,
            "seedeventid": h.seedeventid,
            "code": h.code,
            "reservecount": h.reservecount,
            "foreigncount": h.foreigncount,
        })
    table_data["HEAT"] = (HEAT_COLS, heat_rows)

    # ── SWIMRESULT ────────────────────────────────────────────────────────
    swimresult_rows = []
    for r in db.query(SwimResult).order_by(SwimResult.swimresultid).all():
        swimresult_rows.append({
            "swimresultid": r.swimresultid,
            "athleteid": r.athleteid,
            "swrabestid": r.swrabestid,
            "swrabesttime": r.swrabesttime,
            "swrsbestid": r.swrsbestid,
            "swrsbesttime": r.swrsbesttime,
            "agegroupid": r.agegroupid,
            "backuptime1": r.backuptime1,
            "backuptime2": r.backuptime2,
            "backuptime3": r.backuptime3,
            "bonusentry": r.bonusentry,
            "comment": r.comment,
            "dsqitemid": r.dsqitemid,
            "dsqdaytime": _datetime_to_ole(r.dsqdaytime),
            "dsqnotified": r.dsqnotified,
            "dsqnumber": r.dsqnumber,
            "entrycourse": r.entrycourse,
            "entrytime": r.entrytime,
            "finalfix": r.finalfix,
            "finishjudge": r.finishjudge,
            "heatid": r.heatid,
            "infocode": r.infocode,
            "lane": r.lane,
            "lateentry": r.lateentry,
            "mpoints": r.mpoints,
            "padtime": r.padtime,
            "qtcity": r.qtcity,
            "qtcourse": r.qtcourse,
            "qtdate": _datetime_to_ole(r.qtdate),
            "qtname": r.qtname,
            "qtnation": r.qtnation,
            "qttime": r.qttime,
            "qualcode": r.qualcode,
            "reactiontime": r.reactiontime,
            "resultstatus": r.resultstatus,
            "swimeventid": r.swimeventid,
            "swimtime": r.swimtime,
            "usetimetype": r.usetimetype,
            "dsqofficialid": r.dsqofficialid,
            "reservecode": r.reservecode,
            "noadvance": r.noadvance,
            "officialsplits": r.officialsplits,
            "qttiming": r.qttiming,
        })
    table_data["SWIMRESULT"] = (SWIMRESULT_COLS, swimresult_rows)

    # ── SPLIT ─────────────────────────────────────────────────────────────
    split_rows = []
    for sp in db.query(Split).order_by(Split.swimresultid, Split.distance).all():
        split_rows.append({
            "swimresultid": sp.swimresultid,
            "distance": sp.distance,
            "swimtime": sp.swimtime,
        })
    table_data["SPLIT"] = (SPLIT_COLS, split_rows)

    # ── RELAY ─────────────────────────────────────────────────────────────
    # Build style→event lookup for swimeventid mapping
    style_event_map: dict[int, int] = {}
    for ev in db.query(SwimEvent).filter(SwimEvent.swimstyleid.isnot(None)).all():
        # Prefer relay events (relaycount > 1)
        style = db.query(SwimStyle).get(ev.swimstyleid)
        if style and style.relaycount and style.relaycount > 1:
            style_event_map[ev.swimstyleid] = ev.swimeventid

    relay_rows = []
    for rl in db.query(Relay).order_by(Relay.relaysid).all():
        swimeventid = style_event_map.get(rl.stylesid) if rl.stylesid else None
        relay_rows.append({
            "relayid": rl.relaysid,
            "agegroupid": None,
            "agemax": rl.maxage,
            "agemin": rl.minage,
            "agetotal": None,
            "athletes": None,
            "backuptime1": None,
            "backuptime2": None,
            "backuptime3": None,
            "bonusentry": None,
            "clubid": rl.clubsid,
            "comment": None,
            "dsqitemid": None,
            "dsqdaytime": None,
            "dsqnotified": None,
            "dsqnumber": None,
            "dsqofficialid": None,
            "entrycourse": rl.course,
            "entrytime": rl.entrytime,
            "finalfix": None,
            "finishjudge": None,
            "gender": rl.gender,
            "heatid": None,
            "infocode": None,
            "lane": None,
            "lateentry": None,
            "mpoints": None,
            "name": rl.name,
            "noadvance": None,
            "officialsplits": None,
            "padtime": None,
            "qtcity": None,
            "qtcourse": None,
            "qtdate": None,
            "qtname": None,
            "qtnation": None,
            "qttime": None,
            "qttiming": None,
            "qualcode": None,
            "reactiontime": None,
            "relaycode": None,
            "reservecode": None,
            "resultstatus": None,
            "swimeventid": swimeventid,
            "swimtime": rl.totaltime,
            "teamnumber": rl.teamnumb,
            "usetimetype": None,
        })
    table_data["RELAY"] = (RELAY_COLS, relay_rows)

    # ── RELAYPOSITION ─────────────────────────────────────────────────────
    relaypos_rows = []
    for rp in db.query(RelayPos).order_by(RelayPos.relaysid, RelayPos.numb).all():
        relaypos_rows.append({
            "relayid": rp.relaysid,
            "athleteid": rp.membersid,
            "qtcity": None,
            "qtcourse": None,
            "qtdate": None,
            "qtislap": None,
            "qtname": None,
            "qtnation": None,
            "qttime": None,
            "qttiming": None,
            "reactiontime": None,
            "relaynumber": rp.numb,
            "resultstatus": None,
        })
    table_data["RELAYPOSITION"] = (RELAYPOSITION_COLS, relaypos_rows)

    # ── Write to a temp file and return bytes ─────────────────────────────
    tmp = tempfile.NamedTemporaryFile(suffix=".smb", delete=False)
    tmp.close()
    try:
        write_smb(tmp.name, table_data)
        return Path(tmp.name).read_bytes()
    finally:
        Path(tmp.name).unlink(missing_ok=True)
