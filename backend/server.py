"""Dependency-free HTTP API and static app server."""

from __future__ import annotations

import json
import mimetypes
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
sys.path.insert(0, str(ROOT))

from backend.config import configured_providers  # noqa: E402
from backend.engine import answer_question, create_investigation, get_investigation, inject_test_conflict  # noqa: E402


class TraceForgeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND), **kwargs)

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        length = min(int(self.headers.get("Content-Length", "0") or 0), 64_000)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            self._json({"status": "ok", "service": "traceforge-api", "providers": configured_providers()})
            return
        if path.startswith("/api/investigations/"):
            run = get_investigation(path.rsplit("/", 1)[-1])
            self._json(run or {"error": "investigation_not_found"}, 200 if run else 404)
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            body = self._body()
            if path == "/api/investigations":
                self._json(create_investigation(str(body.get("domain") or "")), 202)
                return
            if path.endswith("/conflict") and path.startswith("/api/investigations/"):
                run_id = path.split("/")[3]
                run = inject_test_conflict(run_id)
                self._json(run or {"error": "investigation_not_ready"}, 200 if run else 409)
                return
            if path.endswith("/ask") and path.startswith("/api/investigations/"):
                run_id = path.split("/")[3]
                answer = answer_question(run_id, str(body.get("question") or ""))
                self._json(answer or {"error": "investigation_not_ready"}, 200 if answer else 409)
                return
            self._json({"error": "not_found"}, 404)
        except ValueError as error:
            self._json({"error": "invalid_request", "message": str(error)}, 400)
        except json.JSONDecodeError:
            self._json({"error": "invalid_json"}, 400)
        except Exception:
            self._json({"error": "internal_error", "message": "The request could not be completed."}, 500)

    def end_headers(self) -> None:
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def guess_type(self, path: str) -> str:
        return mimetypes.guess_type(path)[0] or "application/octet-stream"

    def log_message(self, format: str, *args) -> None:
        print(f"[traceforge] {format % args}")


def run(port: int = 8090) -> None:
    server = ThreadingHTTPServer(("0.0.0.0", port), TraceForgeHandler)
    print(f"TraceForge AI running at http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run(int(sys.argv[1]) if len(sys.argv) > 1 else 8090)

