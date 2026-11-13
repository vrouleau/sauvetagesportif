"""Unit tests for emailing.send_email / from_header — the Resend payload
(From display name, Reply-To, attachments). No network: httpx.post is mocked.

Run: `pytest tests/unit/test_emailing.py -v`
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

from app.emailing import from_header, send_email


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "re_test")
    monkeypatch.setenv("RESEND_FROM_EMAIL", "no-reply@sauvetagesportif-qc.ca")


class TestFromHeader:
    def test_plain_address_without_name(self, env):
        assert from_header() == "no-reply@sauvetagesportif-qc.ca"

    def test_display_name(self, env):
        assert from_header("Sauveteurs de Gatineau") == "Sauveteurs de Gatineau <no-reply@sauvetagesportif-qc.ca>"

    def test_specials_are_quoted(self, env):
        assert from_header("Club X, Montreal") == '"Club X, Montreal" <no-reply@sauvetagesportif-qc.ca>'

    def test_accents_kept(self, env):
        assert from_header("Société de sauvetage").startswith("Société de sauvetage <")

    def test_configured_name_replaced_by_club_name(self, env, monkeypatch):
        monkeypatch.setenv("RESEND_FROM_EMAIL", "SauvetageTeam <no-reply@sauvetagesportif-qc.ca>")
        assert from_header("Club A") == "Club A <no-reply@sauvetagesportif-qc.ca>"
        assert from_header() == "SauvetageTeam <no-reply@sauvetagesportif-qc.ca>"

    def test_header_injection_stripped(self, env):
        assert from_header('Evil"\r\nBcc: x@y.z <a>') == '"EvilBcc: x@y.z a" <no-reply@sauvetagesportif-qc.ca>'

    def test_blank_name_falls_back(self, env):
        assert from_header('  "<>" ') == "no-reply@sauvetagesportif-qc.ca"


class TestSendEmailPayload:
    def _capture(self, monkeypatch, status=200):
        sent = {}

        def fake_post(url, json, headers, timeout):
            sent.update(url=url, json=json, headers=headers)
            return httpx.Response(status, json={"id": "x"})

        monkeypatch.setattr(httpx, "post", fake_post)
        return sent

    def test_reply_to_from_name_and_attachment(self, env, monkeypatch):
        sent = self._capture(monkeypatch)
        send_email("coach@club.ca", "Facture", "<p>x</p>", reply_to="tresor@org.ca",
                   from_name="Org Club", attachments=[("facture.pdf", b"%PDF-1.4")])
        p = sent["json"]
        assert sent["url"] == "https://api.resend.com/emails"
        assert p["from"] == "Org Club <no-reply@sauvetagesportif-qc.ca>"
        assert p["to"] == ["coach@club.ca"]
        assert p["reply_to"] == "tresor@org.ca"  # Resend REST field name
        assert p["attachments"] == [{"filename": "facture.pdf",
                                     "content": base64.b64encode(b"%PDF-1.4").decode()}]
        assert sent["headers"]["Authorization"] == "Bearer re_test"

    def test_no_reply_to_key_when_absent(self, env, monkeypatch):
        sent = self._capture(monkeypatch)
        send_email("a@b.ca", "S", "<p>x</p>")
        assert "reply_to" not in sent["json"] and "attachments" not in sent["json"]
        assert sent["json"]["from"] == "no-reply@sauvetagesportif-qc.ca"

    def test_resend_error_is_502(self, env, monkeypatch):
        from fastapi import HTTPException
        self._capture(monkeypatch, status=422)
        with pytest.raises(HTTPException) as exc:
            send_email("a@b.ca", "S", "<p>x</p>")
        assert exc.value.status_code == 502
