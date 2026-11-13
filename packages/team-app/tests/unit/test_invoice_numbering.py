"""Unit tests for deterministic invoice numbers, revisions, migration 0005 and
the invoice email templates. No Docker/FastAPI app needed.

Run: `pytest tests/unit/test_invoice_numbering.py -v`
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.models import Base, SwimSession
from app import models_team, models_live, models_serc  # noqa: F401 — register tables
from app.models_team import ClubMeetInvite, TeamClub, Meet as TeamMeet
from app.invoices import (
    format_invoice_number, next_invoice_rev, invoice_number, record_invoice_sent, _meet_year,
)
from app.emailing import build_invoice_email, build_organizer_invoice_summary
from app.migrations.versions import m0005_invoice_revision as migration


class TestFormat:
    def test_base_number(self):
        assert format_invoice_number(2026, 12, 45) == "2026-012-0045"

    def test_revision_suffix(self):
        assert format_invoice_number(2026, 12, 45, 2) == "2026-012-0045-R2"

    def test_memo_safe(self):
        n = format_invoice_number(2026, 1234, 56789, 12)
        assert n.replace("-", "").isalnum() and n.isascii()

    def test_no_meet(self):
        assert format_invoice_number(2026, None, 7) == "2026-000-0007"


class TestRevision:
    def test_never_sent(self):
        assert next_invoice_rev(None, None, 5000) == 1

    def test_same_total_keeps_rev(self):
        assert next_invoice_rev(1, 5000, 5000) == 1
        assert next_invoice_rev(3, 5000, 5000) == 3

    def test_changed_total_bumps_rev(self):
        assert next_invoice_rev(1, 5000, 7500) == 2
        assert next_invoice_rev(2, 7500, 5000) == 3


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    session.add(TeamMeet(meetsid=12, name="Test meet", mindate=datetime(2026, 3, 14)))
    session.add(TeamMeet(meetsid=13, name="No date meet"))
    session.add(TeamClub(clubsid=45, name="Club A", pin="1234"))
    session.commit()
    yield session
    session.close()
    engine.dispose()


class TestPersistence:
    def test_number_independent_of_today(self, db):
        assert invoice_number(db, 45, 12, 5000) == "2026-012-0045"

    def test_year_falls_back_to_first_session(self, db):
        db.add(SwimSession(swimsessionid=1, meetsid=13, startdate=datetime(2027, 1, 9)))
        db.add(SwimSession(swimsessionid=2, meetsid=13, startdate=datetime(2027, 1, 8)))
        db.commit()
        assert _meet_year(db, 13) == 2027

    def test_send_cycle(self, db):
        # First send: R1, counter 1
        assert invoice_number(db, 45, 12, 5000) == "2026-012-0045"
        record_invoice_sent(db, 45, 12, 5000)
        db.commit()
        row = db.get(ClubMeetInvite, (45, 12))
        assert (row.invoice_rev, row.invoice_last_total_cents, row.stripe_send_count) == (1, 5000, 1)

        # Resend with same total: same number, counter 2
        assert invoice_number(db, 45, 12, 5000) == "2026-012-0045"
        record_invoice_sent(db, 45, 12, 5000)
        db.commit()
        assert (row.invoice_rev, row.stripe_send_count) == (1, 2)

        # Total changed: preview shows R2 before sending; sending persists it
        assert invoice_number(db, 45, 12, 7500) == "2026-012-0045-R2"
        record_invoice_sent(db, 45, 12, 7500)
        db.commit()
        assert (row.invoice_rev, row.invoice_last_total_cents, row.stripe_send_count) == (2, 7500, 3)
        assert invoice_number(db, 45, 12, 7500) == "2026-012-0045-R2"

    def test_preview_does_not_write(self, db):
        invoice_number(db, 45, 12, 5000)
        assert db.get(ClubMeetInvite, (45, 12)) is None

    def test_keeps_invite_count(self, db):
        db.add(ClubMeetInvite(clubsid=45, meetsid=12, invite_send_count=3, stripe_send_count=0))
        db.commit()
        record_invoice_sent(db, 45, 12, 5000)
        db.commit()
        row = db.get(ClubMeetInvite, (45, 12))
        assert (row.invite_send_count, row.stripe_send_count) == (3, 1)


class TestMigration:
    def test_adds_columns(self):
        engine = create_engine("sqlite:///:memory:")
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    "CREATE TABLE club_meet_invites (clubsid INTEGER, meetsid INTEGER, "
                    "invite_send_count INTEGER, stripe_send_count INTEGER, PRIMARY KEY (clubsid, meetsid))"))
                conn.execute(text("INSERT INTO club_meet_invites VALUES (1, 2, 3, 4)"))
            migration.upgrade(engine)
            migration.upgrade(engine)  # idempotent
            cols = {c["name"] for c in inspect(engine).get_columns("club_meet_invites")}
            assert {"invoice_rev", "invoice_last_total_cents"} <= cols
            with engine.connect() as conn:
                row = conn.execute(text(
                    "SELECT stripe_send_count, invoice_rev FROM club_meet_invites")).fetchone()
            assert row == (4, None)
        finally:
            engine.dispose()

    def test_fresh_install_noop(self):
        engine = create_engine("sqlite:///:memory:")
        try:
            migration.upgrade(engine)
            assert "club_meet_invites" not in inspect(engine).get_table_names()
        finally:
            engine.dispose()


ITEMS = [
    {"event_name": "Frais de club", "description": "", "qty": 1, "unit_cents": 2500},
    {"event_name": "TREMBLAY, <Léa>", "description": "2 individuelles", "qty": 1, "unit_cents": 1000},
    {"event_name": "Frais par athlète", "description": "", "qty": 4, "unit_cents": 500},
]


class TestEmailTemplates:
    @pytest.mark.parametrize("lang", ["fr", "en"])
    def test_invoice_email(self, lang):
        subject, html = build_invoice_email(
            lang=lang, meet_name="Coupe Été", club_name="Club A", org_club_name="Org Club",
            org_email="tresor@org.ca", invoice_no="2026-012-0045-R2", items=ITEMS, total_cents=5500)
        assert "2026-012-0045-R2" in subject
        assert html.count("2026-012-0045-R2") >= 3  # summary box + security answer + memo step
        if lang == "fr":
            assert "pas le dépôt automatique" in html and "Quel est le numéro de facture?" in html
        else:
            assert "not use Autodeposit" in html and "What is the invoice number?" in html
        assert "tresor@org.ca" in html
        assert "$55.00" in html
        assert "Interac" in html
        assert "4 × $5.00" in html
        assert "&lt;Léa&gt;" in html and "<Léa>" not in html  # escaped
        assert ("ne pas répondre" if lang == "fr" else "do not reply") not in html  # Reply-To is set
        contact = ("Pour toute question, veuillez communiquer avec <strong>Org Club</strong> à "
                   if lang == "fr" else "Please contact <strong>Org Club</strong> at ")
        assert contact + '<a href="mailto:tresor@org.ca">tresor@org.ca</a>' in html
        assert html.count("mailto:tresor@org.ca") == 1  # not repeated in the footer

    def test_invoice_email_contact_without_org_email(self):
        _, html = build_invoice_email(
            lang="en", meet_name="M", club_name="C", org_club_name="Org Club", org_email="",
            invoice_no="2026-001-0001", items=ITEMS, total_cents=5500)
        assert "Please contact <strong>Org Club</strong> if you have any questions." in html

    @pytest.mark.parametrize("lang", ["fr", "en"])
    def test_invoice_email_admin_sent_names_support(self, lang):
        """Admin send: contact is support, Interac recipient is still the organizer."""
        _, html = build_invoice_email(
            lang=lang, meet_name="M", club_name="C", org_club_name="Org Club",
            org_email="tresor@org.ca", invoice_no="2026-001-0001", items=ITEMS, total_cents=5500,
            support_email="help@sauvetage.app")
        team = "l'équipe de soutien SauvetageTeam" if lang == "fr" else "the SauvetageTeam support team"
        assert team in html
        assert html.count("mailto:help@sauvetage.app") == 1  # body only, no duplicate footer
        assert "mailto:tresor@org.ca" not in html
        assert "<strong>tresor@org.ca</strong>" in html  # Interac recipient unchanged

    @pytest.mark.parametrize("lang", ["fr", "en"])
    def test_organizer_summary(self, lang):
        subject, html = build_organizer_invoice_summary(
            lang=lang, meet_name="Coupe", org_club_name="Org Club", org_email="tresor@org.ca", invoices=[
                {"club_name": "Club A", "club_email": "a@club.ca", "invoice_no": "2026-012-0045",
                 "total_cents": 5500},
                {"club_name": "Club <B>", "club_email": "b@club.ca", "invoice_no": "2026-012-0046-R2",
                 "total_cents": 1000},
            ])
        assert "SauvetageTeam" in subject and "2" in subject
        for s in ("a@club.ca", "b@club.ca", "2026-012-0045", "2026-012-0046-R2", "$55.00", "$65.00"):
            assert s in html
        assert "Club &lt;B&gt;" in html
        assert "<strong>tresor@org.ca</strong>" in html  # Interac recipient named explicitly
        assert ("au nom de" if lang == "fr" else "on behalf of") in html

    def test_summary_without_organizer_has_no_on_behalf(self):
        _, html = build_organizer_invoice_summary(
            lang="en", meet_name="Coupe", org_club_name="", org_email="help@sauvetage.app",
            invoices=[{"club_name": "A", "club_email": "a@a.ca", "invoice_no": "2026-001-0001",
                       "total_cents": 100}])
        assert "on behalf of" not in html and "SauvetageTeam just emailed 1 invoice" in html
        assert "<strong>help@sauvetage.app</strong>" in html
