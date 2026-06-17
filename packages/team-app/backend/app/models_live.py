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

"""SQLAlchemy models — Live results (ephemeral, cleared on meet finalization).

These tables store real-time competition data pushed from meet-app during
an active live meet. They are separate from the permanent Team Manager
schema (results table) and are promoted to historical on finalization.
"""
from __future__ import annotations

from datetime import datetime, timezone
from sqlalchemy import (
    Column, Integer, SmallInteger, String, Boolean, DateTime,
    ForeignKey, UniqueConstraint,
)

from .models import Base


class LiveEvent(Base):
    __tablename__ = "live_events"
    event_id = Column(Integer, primary_key=True)
    session_number = Column(SmallInteger)
    session_name = Column(String(100))
    event_number = Column(SmallInteger)
    event_name = Column(String(100), nullable=False)
    gender = Column(String(1))
    distance = Column(SmallInteger)
    round = Column(String(5))
    scheduled_time = Column(String(5))
    total_heats = Column(SmallInteger, default=0)
    completed_heats = Column(SmallInteger, default=0)
    official_heats = Column(SmallInteger, default=0)


class LiveResult(Base):
    __tablename__ = "live_results"
    id = Column(Integer, primary_key=True)
    event_id = Column(Integer, nullable=False)
    heat_number = Column(SmallInteger, nullable=False)
    lane = Column(SmallInteger, nullable=False)
    athlete_id = Column(Integer)
    athlete_name = Column(String(100))
    club_name = Column(String(100))
    swimtime_ms = Column(Integer)
    reaction_time_ms = Column(SmallInteger)
    status = Column(String(5), default='')
    dsq_reason = Column(String(250))
    is_official = Column(Boolean, default=False)
    pushed_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        UniqueConstraint("event_id", "heat_number", "lane", name="uq_live_result"),
    )


class LiveSplit(Base):
    __tablename__ = "live_splits"
    id = Column(Integer, primary_key=True)
    live_result_id = Column(Integer, ForeignKey("live_results.id", ondelete="CASCADE"))
    distance = Column(SmallInteger, nullable=False)
    swimtime_ms = Column(Integer, nullable=False)


class LiveStartlist(Base):
    __tablename__ = "live_startlist"
    id = Column(Integer, primary_key=True)
    event_id = Column(Integer, nullable=False)
    heat_number = Column(SmallInteger, nullable=False)
    lane = Column(SmallInteger, nullable=False)
    athlete_id = Column(Integer)
    athlete_name = Column(String(100))
    club_name = Column(String(100))
    entry_time_ms = Column(Integer)

    __table_args__ = (
        UniqueConstraint("event_id", "heat_number", "lane", name="uq_live_startlist"),
    )


class PushSubscription(Base):
    """Web Push subscriptions for coach DSQ notifications.

    Linked to a club via PIN validation at subscription time.
    Cleared on meet finalization (same lifecycle as other live tables).
    """
    __tablename__ = "push_subscriptions"
    id = Column(Integer, primary_key=True)
    club_id = Column(Integer, nullable=False, index=True)
    endpoint = Column(String(500), nullable=False, unique=True)
    p256dh = Column(String(200), nullable=False)
    auth = Column(String(100), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))