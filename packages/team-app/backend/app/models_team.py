"""SQLAlchemy models — Team Manager schema (multi-meet).

This replaces the Meet Manager schema (single-meet) to support:
- Multiple meets (historical + current)
- Best times computed from historical results
- Compatibility with Splash Team Manager .mdb import
"""
from __future__ import annotations

from sqlalchemy import (
    Column, Integer, SmallInteger, String, Text, DateTime, Float,
    ForeignKey, Index, CheckConstraint,
)
from sqlalchemy.orm import relationship

from .models import Base  # Use the same Base so FK references resolve


# ── Encoding helpers ──────────────────────────────────────────────────────────

GENDER_M = 1
GENDER_F = 2


def gender_to_str(g: int | None) -> str:
    if g == GENDER_M:
        return "M"
    if g == GENDER_F:
        return "F"
    return "X"


def gender_from_str(s: str) -> int:
    if s == "M":
        return GENDER_M
    if s == "F":
        return GENDER_F
    return 0


# ── SWIMSTYLE and BSGLOBAL already defined in models.py (same Base) ───────────
# FK references to swimstyle.swimstyleid resolve automatically.


# ── MEETS ─────────────────────────────────────────────────────────────────────

class Meet(Base):
    __tablename__ = "meets"
    meetsid = Column(Integer, primary_key=True)
    name = Column(String(100))
    poolname = Column(String(50))
    place = Column(String(50))
    state = Column(String(4))
    nation = Column(String(50))
    mindate = Column(DateTime)
    maxdate = Column(DateTime)
    agedate = Column(DateTime)
    course = Column(SmallInteger)       # 1=LCM, 2=SCY, 3=SCM
    meetstate = Column(SmallInteger)    # 0=planned, 3=completed
    feeclub = Column(Float)
    feeperson = Column(Float)
    feerelay = Column(Float)
    maxientries = Column(SmallInteger)
    maxrentries = Column(SmallInteger)
    deadline = Column(DateTime)
    data = Column(Text)                 # contact info (INI-style)

    # Relationships
    sessions = relationship("Session", back_populates="meet", cascade="all, delete-orphan")
    events = relationship("Event", back_populates="meet", cascade="all, delete-orphan")
    results = relationship("Result", back_populates="meet", cascade="all, delete-orphan")


# ── SESSIONS ──────────────────────────────────────────────────────────────────

class Session(Base):
    __tablename__ = "sessions"
    sessionsid = Column(Integer, primary_key=True)
    meetsid = Column(Integer, ForeignKey("meets.meetsid", ondelete="CASCADE"))
    numb = Column(SmallInteger)
    startdate = Column(DateTime)
    starttime = Column(DateTime)
    name = Column(String(50))
    feeperson = Column(Float)

    meet = relationship("Meet", back_populates="sessions")


# ── CLUBS ─────────────────────────────────────────────────────────────────────

class TeamClub(Base):
    __tablename__ = "clubs"
    clubsid = Column(Integer, primary_key=True)
    name = Column(String(100))
    shortname = Column(String(30))
    code = Column(String(10))
    nation = Column(String(3))
    nameen = Column(String(80))
    shortnameen = Column(String(30))
    teamnumb = Column(SmallInteger)
    # Team-app extras (not in Splash Team Manager)
    pin = Column(String(20))
    email = Column(String(100))
    invite_send_count = Column(Integer, default=0)
    stripe_send_count = Column(Integer, default=0)
    stripe_account_id = Column(String(100))

    members = relationship("Member", back_populates="club")

    @property
    def clubid(self) -> int:
        """Backward-compatible alias for clubsid (transition helper)."""
        return self.clubsid


# ── MEMBERS (athletes) ────────────────────────────────────────────────────────

class Member(Base):
    __tablename__ = "members"
    membersid = Column(Integer, primary_key=True)
    lastname = Column(String(60))
    firstname = Column(String(30))
    birthdate = Column(DateTime)
    gender = Column(SmallInteger)       # 1=M, 2=F
    nation = Column(String(3))
    license = Column(String(20))
    clubsid = Column(Integer, ForeignKey("clubs.clubsid"))
    nameprefix = Column(String(15))
    firstnameen = Column(String(30))
    lastnameen = Column(String(60))
    swimlevel = Column(String(10))
    handicapex = Column(String(10))
    active = Column(String(1), default="T")

    club = relationship("TeamClub", back_populates="members")
    results = relationship("Result", back_populates="member", cascade="all, delete-orphan")
    swim_results = relationship("SwimResult", back_populates="member", foreign_keys="[SwimResult.athleteid]")

    @property
    def athleteid(self) -> int:
        """Backward-compatible alias for membersid (transition helper)."""
        return self.membersid

    @property
    def clubid(self) -> int:
        """Backward-compatible alias for clubsid (transition helper)."""
        return self.clubsid


Index("ix_members_club", Member.clubsid)
Index("ix_members_lastname", Member.lastname)


# ── EVENTS ────────────────────────────────────────────────────────────────────

class Event(Base):
    __tablename__ = "events"
    eventsid = Column(Integer, primary_key=True)
    meetsid = Column(Integer, ForeignKey("meets.meetsid", ondelete="CASCADE"))
    sessionnumb = Column(SmallInteger)
    numb = Column(SmallInteger)         # event number
    eventtyp = Column(SmallInteger)
    stylesid = Column(Integer, ForeignKey("swimstyle.swimstyleid"))
    minage = Column(SmallInteger)
    maxage = Column(SmallInteger)
    fee = Column(Float)
    gender = Column(SmallInteger)       # 1=M, 2=F, 0=mixed
    sortcode = Column(Integer)

    meet = relationship("Meet", back_populates="events")
    swimstyle = relationship("SwimStyle")


Index("ix_events_meet", Event.meetsid)
Index("ix_events_style", Event.stylesid)


# ── RESULTS ───────────────────────────────────────────────────────────────────

class Result(Base):
    __tablename__ = "results"
    resultsid = Column(Integer, primary_key=True)
    membersid = Column(Integer, ForeignKey("members.membersid", ondelete="CASCADE"))
    meetsid = Column(Integer, ForeignKey("meets.meetsid", ondelete="CASCADE"))
    eventdate = Column(DateTime)
    stylesid = Column(Integer, ForeignKey("swimstyle.swimstyleid"))
    totaltime = Column(Integer)         # result time in ms (NULL = no result)
    entrytime = Column(Integer)         # entry/seed time in ms
    rank = Column(SmallInteger)
    eventnumb = Column(SmallInteger)
    eventtyp = Column(SmallInteger)
    resulttyp = Column(SmallInteger)    # 0=official
    course = Column(SmallInteger)       # 1=LCM, 2=SCY, 3=SCM
    entrytimecourse = Column(SmallInteger)

    member = relationship("Member", back_populates="results")
    meet = relationship("Meet", back_populates="results")
    swimstyle = relationship("SwimStyle")


Index("ix_results_member", Result.membersid)
Index("ix_results_meet", Result.meetsid)
Index("ix_results_style", Result.stylesid)


# ── MEMBERSMEETS (registration link: athlete ↔ meet) ─────────────────────────

class MemberMeet(Base):
    __tablename__ = "membersmeets"
    membersid = Column(Integer, ForeignKey("members.membersid", ondelete="CASCADE"), primary_key=True)
    meetsid = Column(Integer, ForeignKey("meets.meetsid", ondelete="CASCADE"), primary_key=True)
    clubsid = Column(Integer, ForeignKey("clubs.clubsid"))
    changed = Column(DateTime)


# ── RELAYS ────────────────────────────────────────────────────────────────────

class Relay(Base):
    __tablename__ = "relays"
    relaysid = Column(Integer, primary_key=True)
    meetsid = Column(Integer, ForeignKey("meets.meetsid", ondelete="CASCADE"))
    eventdate = Column(DateTime)
    clubsid = Column(Integer, ForeignKey("clubs.clubsid"))
    teamnumb = Column(SmallInteger)
    stylesid = Column(Integer, ForeignKey("swimstyle.swimstyleid"))
    totaltime = Column(Integer)
    entrytime = Column(Integer)
    eventnumb = Column(SmallInteger)
    eventtyp = Column(SmallInteger)
    resulttyp = Column(SmallInteger)
    rank = Column(SmallInteger)
    course = Column(SmallInteger)
    gender = Column(SmallInteger)
    minage = Column(SmallInteger)
    maxage = Column(SmallInteger)


class RelayPos(Base):
    __tablename__ = "relayspos"
    relaysid = Column(Integer, ForeignKey("relays.relaysid", ondelete="CASCADE"), primary_key=True)
    numb = Column(SmallInteger, primary_key=True)
    membersid = Column(Integer, ForeignKey("members.membersid"))
    entrytime = Column(Integer)


# ── BSGLOBAL and SECRET LINKS — already defined in models.py ──────────────────
# Reuse from there: from .models import BsGlobal, SecretLink
