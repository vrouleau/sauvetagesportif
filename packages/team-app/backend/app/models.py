"""SQLAlchemy models — Full Splash Meet Manager compatible schema.

All columns match the real Splash PostgreSQL database exactly (types, sizes).
Team-specific extra columns (pin, email, stripe, age_code, created_at) are
appended at the end of each table so Splash ignores them gracefully.
"""
from __future__ import annotations

from datetime import datetime
from sqlalchemy import (
    Column, Integer, SmallInteger, String, Text, Date, DateTime,
    Float, ForeignKey, Boolean, UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------------------
# swimstyle
# ---------------------------------------------------------------------------

class SwimStyle(Base):
    __tablename__ = "swimstyle"
    swimstyleid = Column(Integer, primary_key=True)
    code = Column(String(10))
    distance = Column(SmallInteger)
    name = Column(String(50))
    relaycount = Column(SmallInteger)
    stroke = Column(SmallInteger)  # 1=Free 2=Back 3=Breast 4=Fly 5=IM 6=FreeRelay 7=MedRelay
    sortcode = Column(Integer)
    technique = Column(SmallInteger)
    uniqueid = Column(SmallInteger)


# ---------------------------------------------------------------------------
# club
# ---------------------------------------------------------------------------

class Club(Base):
    __tablename__ = "club"
    clubid = Column(Integer, primary_key=True)
    bonuspoints = Column(Integer)
    clubtype = Column(SmallInteger)
    code = Column(String(10))
    contactname = Column(String(50))
    contactinternet = Column(String(150))
    contactcity = Column(String(30))
    contactcountry = Column(String(2))
    contactemail = Column(String(50))
    contactfax = Column(String(20))
    contactphone = Column(String(20))
    contactstate = Column(String(5))
    contactstreet = Column(String(50))
    contactstreet2 = Column(String(50))
    contactzip = Column(String(10))
    externalid = Column(String(40))
    longcode = Column(String(20))
    entryclubid = Column(Integer)
    entryemails = Column(String(255))
    name = Column(String(80), nullable=False)
    nameen = Column(String(80))
    nation = Column(String(3))
    region = Column(String(10))
    shortname = Column(String(30))
    shortnameen = Column(String(30))
    swrid = Column(Integer)
    teamnumber = Column(SmallInteger)
    # --- Team-specific extra columns (not in Splash) ---
    pin = Column(String(20))
    email = Column(String(200))
    stripe_account_id = Column(String(100))
    invite_send_count = Column(Integer, default=0, nullable=False, server_default="0")
    stripe_send_count = Column(Integer, default=0, nullable=False, server_default="0")

    athletes = relationship("Athlete", back_populates="club")


# ---------------------------------------------------------------------------
# athlete
# ---------------------------------------------------------------------------

class Athlete(Base):
    __tablename__ = "athlete"
    athleteid = Column(Integer, primary_key=True)
    clubid = Column(Integer, ForeignKey("club.clubid"))
    firstname = Column(String(30))
    firstname_upper = Column(String(5))
    gender = Column(SmallInteger)  # 1=M, 2=F
    lastname = Column(String(50))
    lastname_upper = Column(String(10))
    nameprefix = Column(String(20))
    birthdate = Column(DateTime)  # Splash uses TIMESTAMP
    domicile = Column(String(50))
    externalid = Column(String(40))
    firstnameen = Column(String(30))
    handicapex = Column(String(20))
    handicaps = Column(SmallInteger)
    handicapsb = Column(SmallInteger)
    handicapsm = Column(SmallInteger)
    lastnameen = Column(String(50))
    license = Column(String(20))
    nation = Column(String(3))
    sdmsid = Column(Integer)
    status = Column(Integer)
    swimlevel = Column(String(10))
    swrid = Column(Integer)
    swrhashkey = Column(Integer)
    clubcode2 = Column(String(10))
    coachname = Column(String(80))
    schoolyear = Column(String(10))
    middlename = Column(String(50))
    middlenameen = Column(String(50))
    # --- Team-specific extra column ---
    exception = Column(String(1))  # 'X' for Masters (maps to handicapex in Splash)

    club = relationship("Club", back_populates="athletes")
    results = relationship("SwimResult", back_populates="athlete")

    __table_args__ = (
        UniqueConstraint("firstname", "lastname", "clubid", name="uq_athlete"),
    )


# ---------------------------------------------------------------------------
# swimsession
# ---------------------------------------------------------------------------

class SwimSession(Base):
    __tablename__ = "swimsession"
    swimsessionid = Column(Integer, primary_key=True)
    course = Column(SmallInteger)  # 1=50m(LCM), 2=25yd(SCY), 3=25m(SCM)
    daytime = Column(DateTime)
    endtime = Column(DateTime)
    feeathlete = Column(Float)
    following = Column(String(1), default='F')
    lanemin = Column(SmallInteger)
    lanemax = Column(SmallInteger)
    lanesbyplace = Column(String(100))
    maxentriesathlete = Column(SmallInteger)
    maxentriesrelay = Column(SmallInteger)
    name = Column(String(100))
    officialmeeting = Column(DateTime)
    poolglobal = Column(String(1), default='F')
    pooltype = Column(SmallInteger)
    remarks = Column(Text)
    remarksjury = Column(Text)
    roundtotenths = Column(String(1), default='F')
    sessionnumber = Column(SmallInteger)
    startdate = Column(DateTime)
    timing = Column(SmallInteger)
    tlmeeting = Column(DateTime)
    touchpadmode = Column(SmallInteger)
    warmupfrom = Column(DateTime)
    warmupuntil = Column(DateTime)

    events = relationship("SwimEvent", back_populates="session")


# ---------------------------------------------------------------------------
# swimevent
# ---------------------------------------------------------------------------

class SwimEvent(Base):
    __tablename__ = "swimevent"
    swimeventid = Column(Integer, primary_key=True)
    comment = Column(Text)
    daytime = Column(DateTime)
    duration = Column(DateTime)
    entrytimeconversion = Column(SmallInteger)
    entrytimepercent = Column(SmallInteger)
    eventnumber = Column(SmallInteger)
    externalid = Column(String(40))
    fee = Column(Float)
    finalorder = Column(SmallInteger)
    gender = Column(SmallInteger)  # 1=M, 2=F, 3=Mixed
    lanemax = Column(SmallInteger)
    lytentrylist = Column(Integer)
    lytstartlist = Column(Integer)
    lytresult2column = Column(Integer)
    lytresult2split = Column(Integer)
    lytresult4split = Column(Integer)
    lytresultnosplit = Column(Integer)
    lytresulthtml = Column(Integer)
    masters = Column(String(1), default='F')
    maxentries = Column(SmallInteger)
    pfineignore = Column(String(1), default='F')
    preveventid = Column(Integer)
    qualbyplace = Column(SmallInteger)
    round = Column(SmallInteger)  # 1=PRE, 2=SEM, 4=FIN, 5=TIM
    seedbonuslast = Column(String(1), default='F')
    seedexhlast = Column(String(1), default='F')
    seedlateentrylast = Column(String(1), default='F')
    seedingglobal = Column(String(1), default='F')
    singleheats = Column(SmallInteger)
    sortcode = Column(Integer)
    splashmecanedit = Column(String(1), default='F')
    sponsor = Column(String(50))
    swimsessionid = Column(Integer, ForeignKey("swimsession.swimsessionid"))
    swimstyleid = Column(Integer, ForeignKey("swimstyle.swimstyleid"))
    twoperlane = Column(String(1), default='F')
    roundname = Column(String(50))
    combineagegroups = Column(String(1), default='F')
    roundone = Column(String(20))
    internalevent = Column(String(1), default='F')

    session = relationship("SwimSession", back_populates="events")
    swimstyle = relationship("SwimStyle")
    agegroups = relationship("AgeGroup", back_populates="event",
                             cascade="all, delete-orphan")
    results = relationship("SwimResult", back_populates="event")


# ---------------------------------------------------------------------------
# agegroup
# ---------------------------------------------------------------------------

class AgeGroup(Base):
    __tablename__ = "agegroup"
    agegroupid = Column(Integer, primary_key=True)
    agebytotal = Column(String(1), default='F')
    agemax = Column(SmallInteger)
    agemax2 = Column(SmallInteger)
    agemin = Column(SmallInteger)
    agemin2 = Column(SmallInteger)
    allofficial = Column(String(1), default='F')
    athletestatuses = Column(Integer)
    clubids = Column(String(1024))
    code = Column(String(10))
    externalid = Column(String(40))
    fastheatcount = Column(SmallInteger)
    forceprelim = Column(String(1), default='F')
    gender = Column(SmallInteger)
    handicaps = Column(String(100))
    heatcount = Column(SmallInteger)
    heatqualipriority = Column(String(50))
    levelmax = Column(String(5))
    levelmin = Column(String(5))
    name = Column(String(50))
    nationality = Column(String(3))
    nationregions = Column(String(1024))
    resultcount = Column(SmallInteger)
    scoretype = Column(SmallInteger)
    seedwithtsonly = Column(String(1), default='F')
    sortcode = Column(Integer)
    swimeventid = Column(Integer, ForeignKey("swimevent.swimeventid", ondelete="CASCADE"))
    swimlevels = Column(String(255))
    useformedals = Column(String(1), default='F')
    useforscoring = Column(String(1), default='F')
    winnertitle = Column(String(100))
    foreigncount = Column(SmallInteger)
    finalseedtype = Column(SmallInteger)

    event = relationship("SwimEvent", back_populates="agegroups")


# ---------------------------------------------------------------------------
# swimresult
# ---------------------------------------------------------------------------

class SwimResult(Base):
    __tablename__ = "swimresult"
    swimresultid = Column(Integer, primary_key=True)
    athleteid = Column(Integer, ForeignKey("athlete.athleteid"))
    swrabestid = Column(Integer)
    swrabesttime = Column(Integer)
    swrsbestid = Column(Integer)
    swrsbesttime = Column(Integer)
    agegroupid = Column(Integer, ForeignKey("agegroup.agegroupid"))
    backuptime1 = Column(Integer)
    backuptime2 = Column(Integer)
    backuptime3 = Column(Integer)
    bonusentry = Column(String(1), default='F')
    comment = Column(String(250))
    dsqitemid = Column(Integer)
    dsqdaytime = Column(DateTime)
    dsqnotified = Column(String(1), default='F')
    dsqnumber = Column(SmallInteger)
    entrycourse = Column(SmallInteger)
    entrytime = Column(Integer)  # ms, NULL = NT
    finalfix = Column(String(1), default='F')
    finishjudge = Column(SmallInteger)
    heatid = Column(Integer)
    infocode = Column(String(5))
    lane = Column(SmallInteger)
    lateentry = Column(String(1), default='F')
    mpoints = Column(SmallInteger)
    padtime = Column(Integer)
    qtcity = Column(String(30))
    qtcourse = Column(SmallInteger)
    qtdate = Column(DateTime)  # Splash uses TIMESTAMP
    qtname = Column(String(100))
    qtnation = Column(String(3))
    qttime = Column(Integer)  # ms
    qualcode = Column(String(2))
    reactiontime = Column(SmallInteger)
    resultstatus = Column(SmallInteger)  # NULL/0=normal, 1=DNS, 2=DNF, 3=DSQ
    swimeventid = Column(Integer, ForeignKey("swimevent.swimeventid"))
    swimtime = Column(Integer)  # ms, NULL = not swum yet
    usetimetype = Column(SmallInteger, default=0)
    dsqofficialid = Column(Integer)
    reservecode = Column(String(20))
    noadvance = Column(String(1), default='F')
    officialsplits = Column(String(100))
    qttiming = Column(SmallInteger)
    # --- Team-specific extra columns (not in Splash) ---
    age_code = Column(String(10), default="Open")
    created_at = Column(DateTime, default=datetime.utcnow)

    athlete = relationship("Athlete", back_populates="results")
    event = relationship("SwimEvent", back_populates="results")
    agegroup = relationship("AgeGroup")

    __table_args__ = (
        UniqueConstraint("athleteid", "swimeventid", "age_code",
                         name="uq_swimresult_entry"),
    )


# ---------------------------------------------------------------------------
# bsglobal
# ---------------------------------------------------------------------------

class BsGlobal(Base):
    __tablename__ = "bsglobal"
    name = Column(String(50), primary_key=True, default='')
    data = Column(Text)


# ---------------------------------------------------------------------------
# secret_links (team-specific, not in Splash)
# ---------------------------------------------------------------------------

class SecretLink(Base):
    __tablename__ = "secret_links"
    id = Column(Integer, primary_key=True)
    token = Column(String(36), unique=True, nullable=False)
    club_id = Column(Integer, ForeignKey("club.clubid"), nullable=False)
    pin_encrypted = Column(String(200), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    viewed = Column(Boolean, default=False)
    lang = Column(String(2), default="fr")
    created_at = Column(DateTime, default=datetime.utcnow)


# ---------------------------------------------------------------------------
# Helper constants
# ---------------------------------------------------------------------------

GENDER_M = 1
GENDER_F = 2
GENDER_MIXED = 3

COURSE_LCM = 1
COURSE_SCY = 2
COURSE_SCM = 3

ROUND_PRE = 1
ROUND_SEM = 2
ROUND_FIN = 4
ROUND_TIM = 5


def gender_to_str(g: int) -> str:
    return "M" if g == GENDER_M else "F"


def gender_from_str(s: str) -> int:
    return GENDER_M if s == "M" else GENDER_F


def course_to_str(c: int | None) -> str:
    if c == COURSE_SCM:
        return "SCM"
    if c == COURSE_SCY:
        return "SCY"
    return "LCM"


def course_from_str(s: str) -> int:
    if s == "SCM":
        return COURSE_SCM
    if s == "SCY":
        return COURSE_SCY
    return COURSE_LCM


def fee_dollars_to_cents(fee: float | None) -> int:
    if fee is None:
        return 0
    return round(fee * 100)


def fee_cents_to_dollars(cents: int | None) -> float:
    if cents is None:
        return 0.0
    return cents / 100.0
