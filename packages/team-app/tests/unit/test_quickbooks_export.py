"""QuickBooks Online import files (customers + invoices CSV)."""
from __future__ import annotations

import csv
import io
import sys
import zipfile
from datetime import date
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from app import quickbooks_export as qx
from app.models import Base
from app import models_team, models_live, models_serc  # noqa: F401 — register tables
from app.models_team import Meet as TeamMeet, TeamClub
from app.routers import api

TODAY = date(2026, 11, 24)
ITEMS = [
    {"event_number": None, "event_name": "Frais de club", "description": "", "qty": 1, "unit_cents": 5000},
    {"event_number": 12, "event_name": "50 m libre", "description": "Tremblay — 2 épreuves", "qty": 1, "unit_cents": 1250},
    {"event_number": None, "event_name": "Relais", "description": "", "qty": 3, "unit_cents": 1000},
]


def _read(raw: bytes) -> list[list[str]]:
    assert raw.startswith(b"\xef\xbb\xbf")          # BOM, so Excel shows the accents
    return list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))


def entry(name="Club d'Alma", no="2026-012-0045", items=ITEMS, email="alma@x.ca"):
    return qx.ExportEntry(name=name, email=email, invoice_no=no, items=items)


class TestInvoiceRows:
    def test_the_headers_are_intuits_own_sample_headers(self):
        assert qx.INVOICE_HEADERS == [
            "*InvoiceNo", "*Customer", "*InvoiceDate", "*DueDate", "Terms", "Location", "Memo",
            "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "*ItemAmount",
            "*ItemTaxCode", "ItemTaxAmount", "Currency", "Note to customer"]

    def test_one_row_per_line_header_fields_on_the_first_line_only(self):
        rows = qx.invoice_rows(entry(), "Meet <1>", TODAY, qx.ExportOptions())
        assert len(rows) == 3 and all(len(r) == len(qx.INVOICE_HEADERS) for r in rows)
        first = dict(zip(qx.INVOICE_HEADERS, rows[0]))
        assert first["*InvoiceNo"] == "2026-012-0045" and first["*Customer"] == "Club d'Alma"
        assert first["*InvoiceDate"] == "24/11/2026" and first["*DueDate"] == "24/12/2026"
        assert first["Memo"] == "Meet <1>"
        assert first["Item(Product/Service)"] == "Frais d'inscription"
        assert first["*ItemTaxCode"] == "Exempt"
        # like Intuit's sample: later lines carry the invoice number and the item fields only
        for r in rows[1:]:
            line = dict(zip(qx.INVOICE_HEADERS, r))
            assert line["*InvoiceNo"] == "2026-012-0045"
            assert [line[h] for h in ("*Customer", "*InvoiceDate", "*DueDate", "Memo")] == ["", "", "", ""]
            assert line["*ItemTaxCode"] == "Exempt" and line["Item(Product/Service)"] == "Frais d'inscription"

    def test_amounts_are_quantity_times_rate(self):
        rows = qx.invoice_rows(entry(), "M", TODAY, qx.ExportOptions())
        relay = dict(zip(qx.INVOICE_HEADERS, rows[2]))
        assert (relay["ItemQuantity"], relay["ItemRate"], relay["*ItemAmount"]) == ("3", "10.00", "30.00")

    def test_description_has_no_em_dash_or_line_break(self):
        rows = qx.invoice_rows(entry(items=[{"event_number": 1, "event_name": "100 m\nlibre",
                                              "description": "A — B", "qty": 1, "unit_cents": 100}]),
                               "M", TODAY, qx.ExportOptions())
        desc = dict(zip(qx.INVOICE_HEADERS, rows[0]))["ItemDescription"]
        assert desc == "#1 - 100 m libre - A - B"

    def test_a_line_without_text_still_has_a_description(self):
        bare = [{"event_number": None, "event_name": "", "description": "", "qty": 1, "unit_cents": 100}]
        assert dict(zip(qx.INVOICE_HEADERS, qx.invoice_rows(entry(items=bare), "M", TODAY, qx.ExportOptions())[0]))[
            "ItemDescription"] == "Inscription"

    def test_revision_suffix_is_dropped_like_in_the_connected_flow(self):
        rows = qx.invoice_rows(entry(no="2026-012-0045-R3"), "M", TODAY, qx.ExportOptions())
        assert rows[0][0] == "2026-012-0045"

    def test_options_are_used(self):
        rows = qx.invoice_rows(entry(), "M", TODAY,
                               qx.ExportOptions(item_name="Meet fees", tax_code="Exonéré", due_days=0))
        r = dict(zip(qx.INVOICE_HEADERS, rows[0]))
        assert r["Item(Product/Service)"] == "Meet fees" and r["*ItemTaxCode"] == "Exonéré"
        assert r["*DueDate"] == r["*InvoiceDate"]


class TestCustomerName:
    def test_colon_is_replaced_and_blank_gets_a_name(self):
        assert qx.customer_name("Club d'Alma: Nord") == "Club d'Alma- Nord"
        assert qx.customer_name("   ", 7) == "Club 7"

    def test_invoice_and_customer_files_use_the_same_name(self):
        files = qx.build_files([entry(name="A: B  C")], "M", TODAY)
        customer = _read(files["1-customers.csv"])[1][0]
        invoice = _read(files["2-invoices.csv"])[1][1]
        assert customer == invoice == "A- B C"


class TestBuildFiles:
    def test_customers_invoices_and_howto(self):
        files = qx.build_files([entry(), entry(name="Club B", no="2026-012-0046", email="")], "M", TODAY)
        assert sorted(files) == ["1-customers.csv", "2-invoices.csv", "README.txt"]
        customers = _read(files["1-customers.csv"])
        assert customers[0] == qx.CUSTOMER_HEADERS
        assert customers[1:] == [["Club d'Alma", "Club d'Alma", "alma@x.ca"], ["Club B", "Club B", ""]]
        assert _read(files["2-invoices.csv"])[0] == qx.INVOICE_HEADERS

    def test_clubs_with_nothing_to_bill_are_skipped(self):
        files = qx.build_files([entry(), entry(name="Empty", no="2026-012-0099", items=[])], "M", TODAY)
        assert [r[0] for r in _read(files["1-customers.csv"])[1:]] == ["Club d'Alma"]

    def test_nothing_to_bill_at_all_is_an_error(self):
        with pytest.raises(ValueError):
            qx.build_files([entry(items=[])], "M", TODAY)

    def test_a_club_listed_twice_is_one_customer(self):
        files = qx.build_files([entry(no="2026-012-0045"), entry(no="2026-012-0046")], "M", TODAY)
        assert len(_read(files["1-customers.csv"])) == 2

    def test_howto_follows_the_language_and_names_the_item_and_tax_code(self):
        en = qx.build_files([entry()], "M", TODAY, qx.ExportOptions(item_name="Fees", tax_code="Zero"), "en")["README.txt"].decode()
        assert "Import data > Invoices" in en and '"Fees"' in en and '"Zero"' in en
        fr = qx.build_files([entry()], "M", TODAY, lang="fr")["README.txt"].decode()
        assert "Importer des données" in fr


class TestSplitting:
    def test_at_most_100_invoices_per_file(self):
        entries = [entry(name=f"Club {i}", no=f"2026-012-{i:04d}", items=ITEMS[:1]) for i in range(250)]
        files = qx.build_files(entries, "M", TODAY)
        names = sorted(n for n in files if n.startswith("2-invoices"))
        assert names == ["2-invoices-1.csv", "2-invoices-2.csv", "2-invoices-3.csv"]
        counts = [len({r[0] for r in _read(files[n])[1:]}) for n in names]
        assert counts == [100, 100, 50]

    def test_at_most_1000_rows_and_an_invoice_is_never_cut(self):
        big = [{"event_number": i, "event_name": "E", "description": "", "qty": 1, "unit_cents": 100} for i in range(400)]
        files = qx.build_files([entry(name=f"C{i}", no=f"2026-012-{i:04d}", items=big) for i in range(5)], "M", TODAY)
        sizes = []
        for n in sorted(f for f in files if f.startswith("2-invoices")):
            rows = _read(files[n])[1:]
            sizes.append(len(rows))
            by_invoice = {}
            for r in rows:
                by_invoice[r[0]] = by_invoice.get(r[0], 0) + 1
            assert set(by_invoice.values()) == {400}       # each invoice whole
        assert sizes == [800, 800, 400] and max(sizes) <= qx.MAX_ROWS_PER_FILE

    def test_a_single_huge_invoice_gets_a_file_of_its_own(self):
        huge = [{"event_number": i, "event_name": "E", "description": "", "qty": 1, "unit_cents": 1} for i in range(1200)]
        files = qx.build_files([entry(items=ITEMS), entry(name="Huge", no="2026-012-0002", items=huge)], "M", TODAY)
        assert len([f for f in files if f.startswith("2-invoices")]) == 2


class _Req:
    headers = {}


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'qx.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    s.add(TeamMeet(meetsid=1, name="M", meetstate=0, registration_open=True))
    s.add(TeamClub(clubsid=10, name="Club A", pin="111111", email="a@x.ca"))
    s.add(TeamClub(clubsid=20, name="Club B", pin="222222", email=""))
    s.commit()
    yield s
    s.close()


@pytest.fixture
def items(monkeypatch):
    import app.invoices as invoices
    state = {10: ITEMS, 20: []}
    monkeypatch.setattr(invoices, "_club_line_items", lambda db, club, *a, **k: state[club.clubsid])
    return state


def _zip(resp) -> dict[str, bytes]:
    assert resp.media_type == "application/zip"
    with zipfile.ZipFile(io.BytesIO(resp.body)) as zf:
        return {n: zf.read(n) for n in zf.namelist()}


class TestEndpoint:
    def test_exports_a_zip_with_the_pdf_numbers(self, db, items):
        from app.invoices import invoice_number, items_total_cents
        resp = api.invoices_quickbooks_export({"club_ids": [10, 20]}, _Req(), db)
        files = _zip(resp)
        rows = _read(files["2-invoices.csv"])[1:]
        assert {r[1] for r in rows} == {"Club A", ""}                   # Club B has nothing to bill
        assert rows[0][0] == invoice_number(db, 10, 1, items_total_cents(ITEMS))
        assert resp.headers["content-disposition"].endswith('"quickbooks-import.zip"')

    def test_options_travel_from_the_request(self, db, items):
        files = _zip(api.invoices_quickbooks_export(
            {"club_ids": [10], "item_name": "Meet fees", "tax_code": "Exonéré", "due_days": 15, "lang": "en"}, _Req(), db))
        r = dict(zip(qx.INVOICE_HEADERS, _read(files["2-invoices.csv"])[1]))
        assert r["Item(Product/Service)"] == "Meet fees" and r["*ItemTaxCode"] == "Exonéré"
        assert "Import data > Invoices" in files["README.txt"].decode()

    def test_nothing_is_recorded_as_sent(self, db, items):
        from app.models_team import ClubMeetInvite
        api.invoices_quickbooks_export({"club_ids": [10]}, _Req(), db)
        assert db.query(ClubMeetInvite).count() == 0

    def test_no_selection_and_nothing_billable_are_400(self, db, items):
        for body in ({"club_ids": []}, {"club_ids": [20]}, {"club_ids": [999]}):
            with pytest.raises(HTTPException) as e:
                api.invoices_quickbooks_export(body, _Req(), db)
            assert e.value.status_code == 400

    def test_a_bad_due_days_is_400(self, db, items):
        with pytest.raises(HTTPException) as e:
            api.invoices_quickbooks_export({"club_ids": [10], "due_days": "soon"}, _Req(), db)
        assert e.value.status_code == 400


class TestOptionsFrom:
    def test_blank_or_missing_fields_keep_the_base(self):
        base = qx.ExportOptions(item_name="Fees", tax_code="Zero", due_days=10)
        assert qx.options_from({"item_name": "  ", "tax_code": None}, base) == base
        assert qx.options_from(None, base) == base

    def test_values_override_and_due_days_is_clamped(self):
        o = qx.options_from({"item_name": "X", "tax_code": "Y", "due_days": "400"})
        assert (o.item_name, o.tax_code, o.due_days) == ("X", "Y", 365)
        assert qx.options_from({"due_days": -5}).due_days == 0

    def test_due_days_must_be_a_number(self):
        with pytest.raises(ValueError):
            qx.options_from({"due_days": "soon"})


class TestRememberedOptions:
    """The form's values live on the server, per organizer club, and outlive the meet."""

    def _export(self, db, **body):
        return api.invoices_quickbooks_export({"club_ids": [10], **body}, _Req(), db)

    def test_defaults_until_the_first_export(self, db, items):
        assert api.quickbooks_export_options(_Req(), db) == {
            "item_name": "Frais d'inscription", "tax_code": "Exempt", "due_days": 30}

    def test_an_export_remembers_what_it_used(self, db, items):
        self._export(db, item_name="Meet fees", tax_code="Exonéré", due_days=15)
        assert api.quickbooks_export_options(_Req(), db) == {
            "item_name": "Meet fees", "tax_code": "Exonéré", "due_days": 15}

    def test_a_field_left_out_keeps_the_remembered_value(self, db, items):
        self._export(db, item_name="Meet fees", tax_code="Exonéré", due_days=15)
        files = _zip(self._export(db, due_days=45))
        r = dict(zip(qx.INVOICE_HEADERS, _read(files["2-invoices.csv"])[1]))
        assert r["Item(Product/Service)"] == "Meet fees" and r["*ItemTaxCode"] == "Exonéré"
        assert api.quickbooks_export_options(_Req(), db)["due_days"] == 45

    def test_a_failed_export_remembers_nothing(self, db, items):
        with pytest.raises(HTTPException):
            api.invoices_quickbooks_export({"club_ids": [20], "item_name": "Nope"}, _Req(), db)  # nothing to bill
        assert api.quickbooks_export_options(_Req(), db)["item_name"] == "Frais d'inscription"

    def test_each_organizer_club_has_its_own(self, db, items):
        from app.meet_config import _set_organizer_club_id
        _set_organizer_club_id(db, 10, meetsid=1)
        db.commit()
        self._export(db, item_name="Club A fees")
        assert api.quickbooks_export_options(_Req(), db)["item_name"] == "Club A fees"
        _set_organizer_club_id(db, 20, meetsid=1)         # another club organizes the next meet
        db.commit()
        assert api.quickbooks_export_options(_Req(), db)["item_name"] == "Frais d'inscription"
        _set_organizer_club_id(db, 10, meetsid=1)         # ...and when the first one organizes again
        db.commit()
        assert api.quickbooks_export_options(_Req(), db)["item_name"] == "Club A fees"

    def test_closing_the_meet_keeps_them(self, db, items):
        self._export(db, item_name="Meet fees", due_days=20)
        api._reset_for_next_meet(db, 1)
        db.commit()
        assert api.quickbooks_export_options(_Req(), db) == {
            "item_name": "Meet fees", "tax_code": "Exempt", "due_days": 20}

    def test_garbage_in_storage_falls_back_to_the_defaults(self, db, items):
        from app.meet_config import _set_config
        _set_config(db, "qb_export_options", "{not json")
        db.commit()
        assert api.quickbooks_export_options(_Req(), db)["tax_code"] == "Exempt"
