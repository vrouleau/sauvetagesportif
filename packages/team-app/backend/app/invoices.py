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

"""Create Stripe draft invoices summarising registration fees, one per club."""
from __future__ import annotations

import json
import os
from datetime import date
from io import BytesIO

import stripe
from sqlalchemy.orm import Session, joinedload

from .models import (
    BsGlobal, SwimEvent, SwimStyle, SwimResult,
    fee_dollars_to_cents, GENDER_M, GENDER_F,
)
from .models_team import TeamClub, Member, Relay, RelayPos


MEET_FEE_LABELS = {
    "CLUB": "Frais de club",
    "ATHLETE": "Frais par athlète",
    "RELAY": "Frais par relais",
    "TEAM": "Frais d'équipe",
    "LATEFEE": "Inscription tardive",
    "LSCMEETFEE": "Frais LSC",
}


def _meet_fees(db: Session) -> dict[str, int]:
    """Read meet-level fees from MEETVALUES (Splash-compatible format).

    Falls back to meet_fees_json for backward compatibility with LXF imports.
    MEETVALUES keys: FEECLUB, FEEPERSON, FEERELAY (stored as F;dollars)
    Returns: {CLUB: cents, ATHLETE: cents, RELAY: cents, ...}
    """
    # Primary: read from MEETVALUES (Splash interoperable)
    fees: dict[str, int] = {}
    cfg = db.get(BsGlobal, "MEETVALUES")
    if cfg and cfg.data:
        key_map = {
            "FEECLUB": "CLUB",
            "FEEPERSON": "ATHLETE",
            "FEERELAY": "RELAY",
            "FEELATEINDIVIDUAL": "LATEFEE",
            "FEELATERELAY": "LATERELAYFE",
        }
        for line in cfg.data.split("\r\n"):
            eq = line.find("=")
            if eq < 0:
                continue
            key = line[:eq]
            if key not in key_map:
                continue
            val_part = line[eq + 1:]
            # Format: TYPE;VALUE (e.g., F;5.00 or I;500)
            semi = val_part.find(";")
            if semi >= 0:
                raw_val = val_part[semi + 1:]
            else:
                raw_val = val_part
            try:
                dollars = float(raw_val)
                if dollars > 0:
                    fees[key_map[key]] = int(round(dollars * 100))
            except (ValueError, TypeError):
                pass

    # Fallback: read from meet_fees_json (LXF import legacy)
    if not fees:
        cfg2 = db.get(BsGlobal, "meet_fees_json")
        if cfg2 and cfg2.data:
            try:
                data = json.loads(cfg2.data)
                fees = {k: int(v) for k, v in data.items() if isinstance(v, (int, float)) and v > 0}
            except ValueError:
                pass

    return fees


def _stripe_client() -> None:
    key = os.environ.get("STRIPE_API_KEY")
    if not key:
        raise RuntimeError("STRIPE_API_KEY not configured")
    stripe.api_key = key


def _club_line_items(db: Session, club: TeamClub, meet_fees: dict[str, int]) -> list[dict]:
    """Build one line item per athlete for a club.

    Individual event fees are summed onto the athlete's own line. Relay event
    fees are split evenly across that relay team's members (remainder cents
    distributed deterministically so the split always sums back to the exact
    event fee — no revenue lost to rounding). No per-event detail is shown,
    only the athlete's individual/relay counts.
    """
    # Build a map of event_number -> fee_cents
    all_events = db.query(SwimEvent).options(joinedload(SwimEvent.swimstyle)).all()
    fee_by_number = {}
    for e in all_events:
        fee_cents = fee_dollars_to_cents(e.fee)
        if fee_cents > 0:
            fee_by_number[e.eventnumber] = fee_cents

    rows = (
        db.query(SwimResult, SwimEvent, Member)
        .join(SwimEvent, SwimResult.swimeventid == SwimEvent.swimeventid)
        .join(Member, SwimResult.athleteid == Member.membersid)
        .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
        .filter(Member.clubsid == club.clubsid)
        .all()
    )

    def _event_fee(ev) -> int:
        return fee_dollars_to_cents(ev.fee) or fee_by_number.get(ev.eventnumber - 1, 0)

    def _relay_count(ev) -> int:
        style = ev.swimstyle if getattr(ev, "swimstyle", None) else None
        return style.relaycount if style else 1

    def _relay_team_fee(relay) -> int:
        """Resolve the SwimEvent fee for a materialized relay team (relays table).

        Same match priority as get_relay_teams/_get_event_native_age_code in
        routers/api.py: eventnumb+style first, falling back to style+gender
        for legacy rows without eventnumb.
        """
        event = None
        if relay.eventnumb:
            event = (
                db.query(SwimEvent)
                .filter(SwimEvent.swimstyleid == relay.stylesid, SwimEvent.eventnumber == relay.eventnumb)
                .first()
            )
        if not event:
            gender_str = "M" if relay.gender == GENDER_M else "F" if relay.gender == GENDER_F else "X"
            for ev in db.query(SwimEvent).filter(SwimEvent.swimstyleid == relay.stylesid).all():
                ev_gender_str = "M" if ev.gender == GENDER_M else "F" if ev.gender == GENDER_F else "X"
                if ev_gender_str == gender_str:
                    event = ev
                    break
        if not event:
            return 0
        return fee_dollars_to_cents(event.fee) or fee_by_number.get(event.eventnumber - 1, 0)

    # First pass: for each billable relay event, collect its team members and
    # fee so the fee can be split evenly (with exact-cent remainder handling).
    relay_team_athletes: dict[int, set[int]] = {}
    relay_event_fee: dict[int, int] = {}
    for reg, ev, ath in rows:
        if _relay_count(ev) <= 1:
            continue
        fee = _event_fee(ev)
        if fee <= 0:
            continue
        relay_team_athletes.setdefault(ev.swimeventid, set()).add(ath.membersid)
        relay_event_fee[ev.swimeventid] = fee

    relay_split_cents: dict[int, dict[int, int]] = {}
    for evid, member_ids in relay_team_athletes.items():
        fee = relay_event_fee[evid]
        ids_sorted = sorted(member_ids)
        n = len(ids_sorted)
        base, remainder = divmod(fee, n)
        relay_split_cents[evid] = {
            mid: base + (1 if i < remainder else 0) for i, mid in enumerate(ids_sorted)
        }

    # Second pass: accumulate per-athlete totals and counts.
    athletes: dict[int, dict] = {}
    for reg, ev, ath in rows:
        fee = _event_fee(ev)
        if fee <= 0:
            continue
        entry = athletes.setdefault(ath.membersid, {
            "name": f"{ath.lastname.upper()}, {ath.firstname}",
            "_sort": (ath.lastname.lower(), ath.firstname.lower()),
            "individual_count": 0,
            "relay_count": 0,
            "total_cents": 0,
        })
        if _relay_count(ev) == 1:
            entry["individual_count"] += 1
            entry["total_cents"] += fee
        else:
            entry["relay_count"] += 1
            entry["total_cents"] += relay_split_cents[ev.swimeventid][ath.membersid]

    # Materialized relay teams (built via the Relay Entry page) live in the
    # relays/relayspos tables, not swimresult — swimresult only holds a
    # placeholder "lock" until a team is created, at which point the lock row
    # is deleted (see create_relay_team in routers/api.py). Both sources must
    # be combined here or a club's relay fees vanish the moment its rosters
    # are actually built.
    meet_id_cfg = db.get(BsGlobal, "current_meetsid")
    meet_id = int(meet_id_cfg.data) if meet_id_cfg and meet_id_cfg.data else None
    relay_query = db.query(Relay).filter(Relay.clubsid == club.clubsid)
    if meet_id:
        relay_query = relay_query.filter(Relay.meetsid == meet_id)
    relay_teams = relay_query.all()

    if relay_teams:
        relay_ids = [r.relaysid for r in relay_teams]
        positions = (
            db.query(RelayPos, Member)
            .join(Member, RelayPos.membersid == Member.membersid)
            .filter(RelayPos.relaysid.in_(relay_ids), RelayPos.membersid.isnot(None))
            .all()
        )
        members_by_relay: dict[int, list[Member]] = {}
        for pos, ath in positions:
            members_by_relay.setdefault(pos.relaysid, []).append(ath)

        for relay in relay_teams:
            members = members_by_relay.get(relay.relaysid) or []
            if not members:
                continue
            fee = _relay_team_fee(relay)
            if fee <= 0:
                continue
            ids_sorted = sorted(m.membersid for m in members)
            n = len(ids_sorted)
            base, remainder = divmod(fee, n)
            split = {mid: base + (1 if i < remainder else 0) for i, mid in enumerate(ids_sorted)}
            for m in members:
                entry = athletes.setdefault(m.membersid, {
                    "name": f"{m.lastname.upper()}, {m.firstname}",
                    "_sort": (m.lastname.lower(), m.firstname.lower()),
                    "individual_count": 0,
                    "relay_count": 0,
                    "total_cents": 0,
                })
                entry["relay_count"] += 1
                entry["total_cents"] += split[m.membersid]

    event_items: list[dict] = []
    for a in athletes.values():
        if a["total_cents"] <= 0:
            continue
        parts = []
        if a["individual_count"]:
            parts.append(
                f"{a['individual_count']} individuelle" + ("s" if a["individual_count"] > 1 else "")
            )
        if a["relay_count"]:
            parts.append(f"{a['relay_count']} relais")
        event_items.append({
            "event_number": None,
            "event_name": a["name"],
            "description": ", ".join(parts),
            "qty": 1,
            "unit_cents": a["total_cents"],
            "_sort": a["_sort"],
        })

    event_items.sort(key=lambda x: x["_sort"])
    for it in event_items:
        it.pop("_sort", None)

    # Meet-level fee lines
    meet_items: list[dict] = []
    if meet_fees:
        athlete_count = (
            db.query(Member.membersid)
            .join(SwimResult, SwimResult.athleteid == Member.membersid)
            .filter(Member.clubsid == club.clubsid)
            .distinct()
            .count()
        )
        relay_event_count = (
            db.query(SwimEvent.swimeventid)
            .join(SwimResult, SwimResult.swimeventid == SwimEvent.swimeventid)
            .join(Member, SwimResult.athleteid == Member.membersid)
            .join(SwimStyle, SwimEvent.swimstyleid == SwimStyle.swimstyleid)
            .filter(Member.clubsid == club.clubsid, SwimStyle.relaycount > 1)
            .distinct()
            .count()
        )
        qty_for = {
            "CLUB": 1,
            "ATHLETE": athlete_count,
            "RELAY": relay_event_count,
            "TEAM": 1,
            "LATEFEE": 1,
            "LSCMEETFEE": 1,
        }
        for ftype, cents in meet_fees.items():
            if not cents:
                continue
            qty = qty_for.get(ftype, 1)
            if qty <= 0:
                continue
            meet_items.append({
                "event_number": None,
                "event_name": MEET_FEE_LABELS.get(ftype, ftype),
                "description": "",
                "qty": qty,
                "unit_cents": cents,
            })

    return meet_items + event_items


def _find_or_create_customer(club: TeamClub) -> stripe.Customer:
    email = (club.email or "").strip()
    if email:
        existing = stripe.Customer.list(email=email, limit=1)
        if existing.data:
            return existing.data[0]
    return stripe.Customer.create(
        name=club.name,
        email=email or None,
        metadata={"meetmanager_club_id": str(club.clubsid)},
    )


def _create_draft_for_club(club: TeamClub, items: list[dict], meet_name: str) -> dict:
    customer = _find_or_create_customer(club)
    invoice = stripe.Invoice.create(
        customer=customer.id,
        auto_advance=False,
        currency="cad",
        collection_method="send_invoice",
        days_until_due=30,
        description=f"{meet_name} — Inscriptions",
        metadata={
            "meetmanager_club_id": str(club.clubsid),
            "meetmanager_meet": meet_name,
        },
        pending_invoice_items_behavior="exclude",
    )
    for it in items:
        desc_parts = []
        if it["event_number"]:
            desc_parts.append(f"#{it['event_number']}")
        if it["event_name"]:
            desc_parts.append(it["event_name"])
        if it["description"]:
            desc_parts.append(it["description"])
        stripe.InvoiceItem.create(
            customer=customer.id,
            invoice=invoice.id,
            currency="cad",
            amount=it["unit_cents"] * it["qty"],
            description=" — ".join(desc_parts) or "Inscription",
        )
    return {
        "club": club.name,
        "invoice_id": invoice.id,
        "url": f"https://dashboard.stripe.com/invoices/{invoice.id}",
    }


def _meet_name(db: Session) -> str:
    cfg = db.get(BsGlobal, "meet_name")
    return cfg.data if cfg else "Compétition"


def create_invoice_for_club(db: Session, club_id: int) -> dict:
    """Create a single Stripe draft invoice for one club."""
    _stripe_client()
    club = db.query(TeamClub).options(joinedload(TeamClub.members)).get(club_id)
    if not club:
        raise ValueError(f"Club {club_id} not found")
    items = _club_line_items(db, club, _meet_fees(db))
    if not items:
        raise ValueError("No billable items for this club")
    return _create_draft_for_club(club, items, _meet_name(db))


def create_invoices_for_all_clubs(db: Session) -> dict:
    """Create Stripe draft invoices for every club with billable items."""
    _stripe_client()
    meet_name = _meet_name(db)
    meet_fees = _meet_fees(db)
    clubs = (
        db.query(TeamClub)
        .options(joinedload(TeamClub.members))
        .order_by(TeamClub.name)
        .all()
    )
    created: list[dict] = []
    skipped: list[str] = []
    errors: list[dict] = []
    for club in clubs:
        items = _club_line_items(db, club, meet_fees)
        if not items:
            skipped.append(club.name)
            continue
        try:
            created.append(_create_draft_for_club(club, items, meet_name))
        except stripe.StripeError as e:
            errors.append({"club": club.name, "error": str(e)})
    return {"created": created, "skipped": skipped, "errors": errors}


def _money(cents: int) -> str:
    return f"${cents / 100:,.2f}"


def generate_invoice_pdf(db: Session, club_id: int) -> bytes:
    """Generate a PDF invoice for a single club."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    club = db.get(TeamClub, club_id)
    if not club:
        raise ValueError(f"Club {club_id} not found")
    items = _club_line_items(db, club, _meet_fees(db))
    if not items:
        raise ValueError("No billable items for this club")

    meet_name = _meet_name(db)
    issue_date = date.today()
    invoice_no = f"INV-{issue_date.strftime('%Y%m%d')}-{club.clubsid:04d}"

    _BRAND = colors.HexColor("#1e3a8a")
    _BAND = colors.HexColor("#eef2ff")
    _MUTED = colors.HexColor("#6b7280")

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER,
        leftMargin=0.7*inch, rightMargin=0.7*inch,
        topMargin=0.6*inch, bottomMargin=0.6*inch)
    styles = getSampleStyleSheet()
    h_meet = ParagraphStyle("h_meet", parent=styles["Title"], fontSize=18, leading=22, textColor=_BRAND, alignment=TA_LEFT)
    h_inv = ParagraphStyle("h_inv", parent=styles["Title"], fontSize=26, leading=30, textColor=_BRAND, alignment=TA_RIGHT)
    label = ParagraphStyle("label", parent=styles["Normal"], fontSize=8, textColor=_MUTED, leading=10, spaceAfter=2)
    body = ParagraphStyle("body", parent=styles["Normal"], fontSize=10, leading=13)
    body_b = ParagraphStyle("body_b", parent=body, fontName="Helvetica-Bold")
    cell = ParagraphStyle("cell", parent=styles["Normal"], fontSize=9, leading=11)
    cell_r = ParagraphStyle("cell_r", parent=cell, alignment=TA_RIGHT)

    flow = []

    # Header
    head = Table([[Paragraph(meet_name or "Compétition", h_meet), Paragraph("FACTURE / INVOICE", h_inv)]],
                 colWidths=[4.0*inch, 3.0*inch])
    head.setStyle(TableStyle([("VALIGN", (0,0), (-1,-1), "MIDDLE"), ("BOTTOMPADDING", (0,0), (-1,-1), 8)]))
    flow.append(head)
    flow.append(Table([[""]], colWidths=[7.0*inch], rowHeights=[2],
                      style=TableStyle([("BACKGROUND", (0,0), (-1,-1), _BRAND)])))
    flow.append(Spacer(1, 14))

    # Bill-to
    bill_to = [Paragraph("FACTURÉ À / BILLED TO", label), Paragraph(f"<b>{club.name}</b>", body_b)]
    if club.email:
        bill_to.append(Paragraph(club.email, body))
    meta = [Paragraph("N° / NO.", label), Paragraph(invoice_no, body), Spacer(1,4),
            Paragraph("DATE", label), Paragraph(issue_date.strftime("%Y-%m-%d"), body)]
    meta_block = Table([[bill_to, meta]], colWidths=[4.5*inch, 2.5*inch])
    meta_block.setStyle(TableStyle([("VALIGN", (0,0), (-1,-1), "TOP"), ("LEFTPADDING", (0,0), (-1,-1), 0)]))
    flow.append(meta_block)
    flow.append(Spacer(1, 18))

    # Line items table
    header_row = [Paragraph("<b>#</b>", cell), Paragraph("<b>ATHLÈTE / ATHLETE</b>", cell),
                  Paragraph("<b>DÉTAIL</b>", cell), Paragraph("<b>QTÉ</b>", cell_r),
                  Paragraph("<b>P.U.</b>", cell_r), Paragraph("<b>MONTANT</b>", cell_r)]
    data = [header_row]
    subtotal = 0
    for it in items:
        line_total = it["unit_cents"] * it["qty"]
        subtotal += line_total
        data.append([
            Paragraph(str(it.get("event_number") or ""), cell),
            Paragraph(it.get("event_name", ""), cell),
            Paragraph(it.get("description", ""), cell),
            Paragraph(str(it["qty"]), cell_r),
            Paragraph(_money(it["unit_cents"]), cell_r),
            Paragraph(_money(line_total), cell_r),
        ])

    line_table = Table(data, colWidths=[0.4*inch, 2.4*inch, 2.5*inch, 0.5*inch, 0.6*inch, 0.9*inch], repeatRows=1)
    style = [
        ("BACKGROUND", (0,0), (-1,0), _BRAND), ("TEXTCOLOR", (0,0), (-1,0), colors.white),
        ("VALIGN", (0,0), (-1,-1), "TOP"), ("LEFTPADDING", (0,0), (-1,-1), 6),
        ("RIGHTPADDING", (0,0), (-1,-1), 6), ("TOPPADDING", (0,0), (-1,-1), 6),
        ("BOTTOMPADDING", (0,0), (-1,-1), 6),
    ]
    for i in range(1, len(data)):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0,i), (-1,i), _BAND))
    line_table.setStyle(TableStyle(style))
    flow.append(line_table)
    flow.append(Spacer(1, 10))

    # Total
    totals = Table([
        ["", Paragraph("<b>TOTAL</b>", body_b), Paragraph(f"<b>{_money(subtotal)}</b>", cell_r)],
    ], colWidths=[4.5*inch, 1.6*inch, 1.2*inch])
    totals.setStyle(TableStyle([("LINEABOVE", (1,0), (-1,0), 1.0, _BRAND),
                                ("TOPPADDING", (0,0), (-1,-1), 6), ("ALIGN", (-1,0), (-1,-1), "RIGHT")]))
    flow.append(totals)

    doc.build(flow)
    return buf.getvalue()