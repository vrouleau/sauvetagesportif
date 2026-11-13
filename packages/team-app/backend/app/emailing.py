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

"""Outgoing email: Resend transport, shared footer, invoice email template.

Used by the club invite (routers/api.py send_pin) and the invoice-by-email
flow (send_club_invoice_email).
"""
from __future__ import annotations

import base64
import os
import re
from html import escape

from fastapi import HTTPException


def from_header(from_name: str | None = None) -> str:
    """The From header: RESEND_FROM_EMAIL's address (must be on a domain
    verified in Resend), shown under `from_name` when given — e.g.
    `"Sauveteurs de Gatineau" <no-reply@example.org>`. Without a name, the
    configured value is used as-is (it may carry its own `Name <addr>`)."""
    raw = os.environ.get("RESEND_FROM_EMAIL", "noreply@example.com").strip()
    if "<" in raw and ">" in raw:
        addr = raw[raw.index("<") + 1:raw.rindex(">")].strip()
    else:
        addr = raw
    # Drop characters that would break or inject into the header.
    name = re.sub(r'[\r\n"<>\\]', "", from_name or "").strip()
    if not name:
        return raw
    # Resend's documented form is `Name <addr>`; quote only when the name has
    # RFC 5322 specials (e.g. a comma would otherwise split it into two addresses).
    if re.search(r'[()\[\]:;@,.]', name):
        name = f'"{name}"'
    return f"{name} <{addr}>"


def send_email(to: str, subject: str, html: str, *, reply_to: str | None = None,
               from_name: str | None = None,
               attachments: list[tuple[str, bytes]] | None = None) -> None:
    """Send one email through Resend. Raises HTTPException on failure.

    `from_name` is the display name on the From line (the address is always
    RESEND_FROM_EMAIL's). `reply_to` is where replies go — without it,
    replies go to the From address, typically a no-reply mailbox.
    `attachments` is a list of (filename, raw bytes).
    """
    import httpx

    resend_key = os.environ.get("RESEND_API_KEY")
    if not resend_key:
        raise HTTPException(500, "RESEND_API_KEY not configured")

    payload: dict = {
        "from": from_header(from_name),
        "to": [to],
        "subject": subject,
        "html": html,
    }
    if reply_to:
        payload["reply_to"] = reply_to
    if attachments:
        payload["attachments"] = [
            {"filename": name, "content": base64.b64encode(data).decode("ascii")}
            for name, data in attachments
        ]

    # RESEND_API_URL only exists for the test stack, which points it at a
    # local fake (tests/fake_resend) — never set in a real deployment.
    url = os.environ.get("RESEND_API_URL") or "https://api.resend.com/emails"
    resp = httpx.post(url, json=payload,
                      headers={"Authorization": f"Bearer {resend_key}"}, timeout=20)
    if resp.status_code not in (200, 201):
        raise HTTPException(502, f"Resend error: {resp.text}")


def build_footer(lang: str, *, is_organizer: bool, org_club_name: str, org_email: str,
                 no_reply: bool = True) -> str:
    """Contact footer: organizer contact (non-organizer recipients) + support.

    `no_reply=False` drops the "do not reply" line, for emails that set
    Reply-To to the organizer.
    """
    support_email = os.environ.get("SUPPORT_EMAIL", "")
    fr = lang == "fr"
    footer = ""
    lines = []
    if not is_organizer and org_email:
        lines.append(
            (f"Pour toute question sur la compétition, contactez l'organisateur ({org_club_name}) : "
             if fr else
             f"If you have questions about the meet, contact the organizer ({org_club_name}): ")
            + f"<a href=\"mailto:{org_email}\">{org_email}</a>")
    if support_email:
        if is_organizer:
            prefix = ("Pour toute question, contactez le support : " if fr
                      else "If you have questions, contact support: ")
        else:
            prefix = ("Pour de l'aide avec le portail d'inscription, contactez le support : " if fr
                      else "For help with the registration portal, contact support: ")
        lines.append(prefix + f"<a href=\"mailto:{support_email}\">{support_email}</a>")
    if lines:
        footer += "<p>" + "<br>".join(lines) + "</p>"
    if no_reply:
        footer += ("<p style=\"font-size:11px;color:#888\">Ce courriel est envoyé automatiquement. "
                   "Veuillez ne pas répondre à ce courriel.</p>" if fr else
                   "<p style=\"font-size:11px;color:#888\">This is an automated message. "
                   "Please do not reply to this email.</p>")
    return ("<hr style=\"margin-top:20px\">" + footer) if footer else ""


def _money(cents: int) -> str:
    return f"${cents / 100:,.2f}"


_BRAND = "#1e3a8a"
_BAND = "#eef2ff"
_MUTED = "#6b7280"


def build_invoice_email(*, lang: str, meet_name: str, club_name: str, org_club_name: str,
                        org_email: str, invoice_no: str, items: list[dict],
                        total_cents: int, support_email: str = "") -> tuple[str, str]:
    """Return (subject, html) for an invoice email with Interac instructions.

    The Interac recipient is always the organizer (`org_email`). The "contact
    us" sentence names the organizer, unless `support_email` is given (an
    admin sent the invoice): then it names SauvetageTeam support.

    Table-based layout with inline styles only — most email clients strip
    <style> blocks and ignore flex/grid.
    """
    fr = lang == "fr"
    e = escape
    total = _money(total_cents)
    if support_email:
        org_html = ("l'équipe de soutien SauvetageTeam" if fr else "the SauvetageTeam support team")
        contact_email = support_email
    else:
        org_html = f"<strong>{e(org_club_name)}</strong>" if org_club_name else ""
        contact_email = org_email
    org_mail_html = (f"<a href=\"mailto:{e(contact_email)}\">{e(contact_email)}</a>"
                     if contact_email else "")

    # Invoice number as shown in the Interac steps (security answer + memo).
    num = (f"<strong style=\"font-family:monospace;font-size:15px;white-space:nowrap\">"
           f"{e(invoice_no)}</strong>")

    subject = (f"Facture {invoice_no} — {meet_name}" if fr
               else f"Invoice {invoice_no} — {meet_name}")

    td = "padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;vertical-align:top"
    th = f"padding:8px 10px;background:{_BRAND};color:#fff;font-size:12px;text-align:left"
    rows = []
    for i, it in enumerate(items):
        line_total = it["unit_cents"] * it["qty"]
        bg = f"background:{_BAND};" if i % 2 else ""
        qty = f"{it['qty']} × {_money(it['unit_cents'])}" if it["qty"] > 1 else ""
        detail = " · ".join(p for p in (it.get("description") or "", qty) if p)
        rows.append(
            f"<tr style=\"{bg}\">"
            f"<td style=\"{td}\">{e(it.get('event_name') or '')}</td>"
            f"<td style=\"{td};color:{_MUTED}\">{e(detail)}</td>"
            f"<td style=\"{td};text-align:right;white-space:nowrap\">{_money(line_total)}</td>"
            f"</tr>")

    if fr:
        greeting = (f"<p>Bonjour,</p><p>Voici la facture des inscriptions de <strong>{e(club_name)}</strong> "
                    f"à la compétition <strong>{e(meet_name)}</strong>"
                    + (f", organisée par <strong>{e(org_club_name)}</strong>" if org_club_name else "")
                    + ". La facture PDF est jointe à ce courriel.</p>")
        h_items, h_detail, h_amount = "Athlète / frais", "Détail", "Montant"
        pay_title = "Comment payer par virement Interac"
        steps = [
            "Dans votre application bancaire, choisissez <strong>Virement Interac</strong>.",
            f"Destinataire : <strong>{e(org_email)}</strong>" if org_email else
            "Destinataire : le courriel de l'organisateur.",
            f"Montant : <strong>{total}</strong>",
            "Le destinataire n'utilise <strong>pas le dépôt automatique</strong> : ajoutez cette question de sécurité<br>"
            "Question : <strong>Quel est le numéro de facture?</strong><br>"
            f"Réponse : {num}",
            f"Dans le champ <strong>message / mémo</strong>, inscrivez uniquement le numéro de facture : {num}",
        ]
        memo_note = "Le numéro de facture dans le mémo nous permet d'associer votre paiement à votre club."
        contact = ("Pour toute question, veuillez communiquer avec "
                   + " à ".join(p for p in (org_html, org_mail_html) if p) + ".") if org_html or org_mail_html else ""
        lbl_inv, lbl_total = "N° de facture", "Total à payer"
    else:
        greeting = (f"<p>Hello,</p><p>Here is the registration invoice for <strong>{e(club_name)}</strong> "
                    f"for <strong>{e(meet_name)}</strong>"
                    + (f", organized by <strong>{e(org_club_name)}</strong>" if org_club_name else "")
                    + ". The PDF invoice is attached to this email.</p>")
        h_items, h_detail, h_amount = "Athlete / fee", "Detail", "Amount"
        pay_title = "How to pay by Interac e-Transfer"
        steps = [
            "In your banking app, choose <strong>Interac e-Transfer</strong>.",
            f"Recipient: <strong>{e(org_email)}</strong>" if org_email else
            "Recipient: the organizer's email.",
            f"Amount: <strong>{total}</strong>",
            "The recipient does <strong>not use Autodeposit</strong>: add this security question<br>"
            "Question: <strong>What is the invoice number?</strong><br>"
            f"Answer: {num}",
            f"In the <strong>message / memo</strong> field, enter only the invoice number: {num}",
        ]
        memo_note = "The invoice number in the memo lets us match your payment to your club."
        contact = ("Please contact "
                   + " at ".join(p for p in (org_html, org_mail_html) if p)
                   + " if you have any questions.") if org_html or org_mail_html else ""
        lbl_inv, lbl_total = "Invoice no.", "Total due"

    steps_html = "".join(f"<li style=\"margin:4px 0\">{s}</li>" for s in steps)
    # Organizer contact is in the body (`contact`); the footer keeps only the
    # platform-support line — and is dropped when the body already names support.
    footer = "" if support_email else build_footer(
        lang, is_organizer=False, org_club_name="", org_email="", no_reply=False)
    contact_html = (f"<tr><td style=\"padding:0 24px 20px 24px;font-size:14px;line-height:1.5\">"
                    f"{contact}</td></tr>") if contact else ""
    footer_html = (f"<tr><td style=\"padding:0 24px 20px 24px;font-size:12px;color:{_MUTED}\">"
                   f"{footer}</td></tr>") if footer else ""

    html = f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:20px 0">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0"
       style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#111827">
  <tr><td style="background:{_BRAND};padding:18px 24px;color:#fff">
    <div style="font-size:12px;opacity:.85;letter-spacing:.05em">{'FACTURE' if fr else 'INVOICE'}</div>
    <div style="font-size:20px;font-weight:bold;margin-top:2px">{e(meet_name)}</div>
  </td></tr>
  <tr><td style="padding:20px 24px 4px 24px;font-size:14px;line-height:1.5">{greeting}</td></tr>
  <tr><td style="padding:4px 24px 16px 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{_BAND};border-radius:6px">
      <tr>
        <td style="padding:12px 16px">
          <div style="font-size:11px;color:{_MUTED}">{lbl_inv}</div>
          <div style="font-size:16px;font-weight:bold;font-family:monospace">{e(invoice_no)}</div>
        </td>
        <td style="padding:12px 16px;text-align:right">
          <div style="font-size:11px;color:{_MUTED}">{lbl_total}</div>
          <div style="font-size:20px;font-weight:bold;color:{_BRAND}">{total}</div>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 24px 8px 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr><th style="{th}">{h_items}</th><th style="{th}">{h_detail}</th><th style="{th};text-align:right">{h_amount}</th></tr>
      {''.join(rows)}
      <tr>
        <td style="padding:10px;font-weight:bold;font-size:14px" colspan="2">TOTAL</td>
        <td style="padding:10px;font-weight:bold;font-size:14px;text-align:right;border-top:2px solid {_BRAND}">{total}</td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:8px 24px 20px 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="border:2px solid #f59e0b;border-radius:6px;background:#fffbeb">
      <tr><td style="padding:14px 18px;font-size:14px;line-height:1.5">
        <div style="font-weight:bold;font-size:15px;margin-bottom:6px">{pay_title}</div>
        <ol style="margin:0;padding-left:20px">{steps_html}</ol>
        <p style="margin:10px 0 0 0;font-size:12px;color:{_MUTED}">{memo_note}</p>
      </td></tr>
    </table>
  </td></tr>
  {contact_html}
  {footer_html}
</table>
</td></tr>
</table>
</body></html>"""
    return subject, html


def build_organizer_invoice_summary(*, lang: str, meet_name: str, org_club_name: str,
                                    org_email: str, invoices: list[dict]) -> tuple[str, str]:
    """Return (subject, html) listing the invoices the platform just emailed
    to clubs on the organizer's behalf — one email per batch. Sent to the
    organizer, or to SauvetageTeam support when an admin sent the batch.

    `org_email` is the Interac recipient named in the clubs' instructions.
    `invoices`: [{club_name, club_email, invoice_no, total_cents}, ...]
    """
    fr = lang == "fr"
    e = escape
    pay_to = e(org_email) if org_email else ("le courriel de l'organisateur" if fr else "the organizer's email")
    n = len(invoices)
    grand = _money(sum(i["total_cents"] for i in invoices))
    if fr:
        subject = f"SauvetageTeam a envoyé {n} facture{'s' if n > 1 else ''} — {meet_name}"
        behalf = f", au nom de <strong>{e(org_club_name)}</strong>," if org_club_name else ""
        intro = (f"<p>Bonjour,</p><p>SauvetageTeam vient d'envoyer par courriel{behalf} "
                 f"{n} facture{'s' if n > 1 else ''} "
                 f"pour la compétition <strong>{e(meet_name)}</strong> :</p>")
        heads = ("Club", "Courriel", "N° de facture", "Total")
        note = ("Chaque club a reçu sa facture PDF et les instructions pour payer par virement Interac "
                f"à <strong>{pay_to}</strong>, avec le numéro de facture dans le champ message / mémo. "
                "Sans dépôt automatique : pour déposer un virement, répondez à la question de sécurité "
                "« Quel est le numéro de facture? » avec le numéro de facture du club (tableau ci-dessus). "
                "Leurs réponses vous seront adressées.")
    else:
        subject = f"SauvetageTeam sent {n} invoice{'s' if n > 1 else ''} — {meet_name}"
        behalf = f", on behalf of <strong>{e(org_club_name)}</strong>," if org_club_name else ""
        intro = (f"<p>Hello,</p><p>SauvetageTeam just emailed{behalf} "
                 f"{n} invoice{'s' if n > 1 else ''} "
                 f"for <strong>{e(meet_name)}</strong>:</p>")
        heads = ("Club", "Email", "Invoice no.", "Total")
        note = ("Each club received its PDF invoice and instructions to pay by Interac e-Transfer to "
                f"<strong>{pay_to}</strong>, with the invoice number in the message / memo field. "
                "No Autodeposit: to deposit a transfer, answer the security question "
                "\"What is the invoice number?\" with that club's invoice number (table above). "
                "Replies will come to you.")
    th = f"padding:6px 10px;background:{_BRAND};color:#fff;font-size:12px;text-align:left"
    td = "padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px"
    head = "".join(f"<th style=\"{th}{';text-align:right' if i == 3 else ''}\">{h}</th>"
                   for i, h in enumerate(heads))
    rows = "".join(
        f"<tr><td style=\"{td}\">{e(i['club_name'])}</td><td style=\"{td}\">{e(i['club_email'])}</td>"
        f"<td style=\"{td};font-family:monospace\">{e(i['invoice_no'])}</td>"
        f"<td style=\"{td};text-align:right\">{_money(i['total_cents'])}</td></tr>"
        for i in invoices)
    total_row = (f"<tr><td colspan=\"3\" style=\"padding:8px 10px;font-weight:bold\">TOTAL</td>"
                 f"<td style=\"padding:8px 10px;font-weight:bold;text-align:right\">{grand}</td></tr>")
    html = (f"<div style=\"font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px;line-height:1.5\">"
            f"{intro}<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" "
            f"style=\"border-collapse:collapse;width:100%;max-width:640px\"><tr>{head}</tr>{rows}{total_row}</table>"
            f"<p style=\"font-size:13px;color:{_MUTED}\">{note}</p></div>")
    return subject, html
