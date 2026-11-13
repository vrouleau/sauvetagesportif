"""Fake Resend API for the integration test stack — no real email is sent.

Runs as the `fake-resend` service in docker-compose.test.yml; the backend's
RESEND_API_URL points at it. Stdlib only (runs on a bare python image).

  POST   /emails   — what the backend calls. Records the JSON payload and
                     returns {"id": ...}, or 422 when failure mode is on.
                     Requires an `Authorization: Bearer ...` header, like Resend.
  GET    /emails   — tests: every recorded payload, oldest first.
  DELETE /emails   — tests: forget recorded payloads.
  POST   /control  — tests: {"fail": true|false} toggles failure mode.
"""
from __future__ import annotations

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_lock = threading.Lock()
_emails: list[dict] = []
_state = {"fail": False}


class Handler(BaseHTTPRequestHandler):
    def _reply(self, status: int, body) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _json(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_POST(self):
        if self.path == "/control":
            _state["fail"] = bool(self._json().get("fail"))
            return self._reply(200, _state)
        if self.path != "/emails":
            return self._reply(404, {"message": "not found"})
        if not (self.headers.get("Authorization") or "").startswith("Bearer "):
            return self._reply(401, {"message": "missing API key"})
        payload = self._json()
        if _state["fail"]:
            return self._reply(422, {"message": "fake-resend: forced failure"})
        email_id = str(uuid.uuid4())
        with _lock:
            _emails.append({"id": email_id, **payload})
        return self._reply(200, {"id": email_id})

    def do_GET(self):
        if self.path == "/health":
            return self._reply(200, {"ok": True})
        if self.path != "/emails":
            return self._reply(404, {"message": "not found"})
        with _lock:
            return self._reply(200, list(_emails))

    def do_DELETE(self):
        if self.path != "/emails":
            return self._reply(404, {"message": "not found"})
        with _lock:
            _emails.clear()
        return self._reply(200, {"ok": True})

    def log_message(self, *args):  # keep container logs quiet
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8025), Handler).serve_forever()
