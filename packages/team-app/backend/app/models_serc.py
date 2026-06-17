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

"""SQLAlchemy models for SERC (Simulated Emergency Response Competition).

Teams come from relay entries (relays table) — no separate SERC team table.
"""
from __future__ import annotations

from sqlalchemy import (
    Column, Integer, SmallInteger, String, Text, Float,
    ForeignKey, UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .models import Base


class SercConfig(Base):
    __tablename__ = "serc_config"
    id = Column(Integer, primary_key=True)
    num_victims = Column(SmallInteger, default=9)
    num_draws = Column(SmallInteger, default=4)
    has_bystander = Column(SmallInteger, default=1)  # 0/1 boolean
    overall_factors_json = Column(Text)    # JSON: {assessment, control, communication, search, teamwork}
    bystander_factors_json = Column(Text)  # JSON: {approach, info, directions, monitoring, encouragement}
    victim_factors_json = Column(Text)     # JSON: [{type, approach, rescue, control, landing, care}, ...]
    created_at = Column(String(30))

    draw_orders = relationship("SercDrawOrder", back_populates="config", cascade="all, delete-orphan")
    scores = relationship("SercScore", back_populates="config", cascade="all, delete-orphan")


class SercDrawOrder(Base):
    """Order in which relay teams compete per draw."""
    __tablename__ = "serc_draw_order"
    config_id = Column(Integer, ForeignKey("serc_config.id", ondelete="CASCADE"), primary_key=True)
    draw_number = Column(SmallInteger, primary_key=True)
    position = Column(SmallInteger, primary_key=True)
    relay_team_id = Column(Integer)  # references relays.relaysid

    config = relationship("SercConfig", back_populates="draw_orders")


class SercScore(Base):
    """Individual score entry: one row per (draw, team, section, field)."""
    __tablename__ = "serc_score"
    id = Column(Integer, primary_key=True)
    config_id = Column(Integer, ForeignKey("serc_config.id", ondelete="CASCADE"))
    draw_number = Column(SmallInteger)
    relay_team_id = Column(Integer)  # references relays.relaysid
    section = Column(String(20))     # 'overall', 'bystander', 'victim_0'..'victim_15'
    field = Column(String(20))       # 'assessment', 'approach', 'rescue', 'rough', etc.
    value = Column(Float)

    config = relationship("SercConfig", back_populates="scores")

    __table_args__ = (
        UniqueConstraint("config_id", "draw_number", "relay_team_id", "section", "field",
                         name="uq_serc_score"),
    )