"""Static file server for the game.

The browser blocks `fetch` on file:// URLs, so the data files in data/ can only
be loaded over HTTP. This is the smallest thing that works: standard library
only, no install, no virtualenv.

    python serve.py
    python serve.py --port 9000
    python serve.py --no-browser
"""

from __future__ import annotations

import argparse
import http.server
import socketserver
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Explicit, because the stdlib map is not guaranteed to know .mjs or .webmanifest
# and a wrong Content-Type for a module is a hard failure in the browser.
EXTENSIONS = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **EXTENSIONS}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # No caching: the whole point of this server is to iterate on the game,
        # and a stale module is far more confusing than a slightly slower load.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib signature
        # Only report problems; a 200 for every module is noise.
        status = args[1] if len(args) > 1 else ""
        if isinstance(status, str) and not status.startswith("2"):
            sys.stderr.write(f"  {self.address_string()} - {fmt % args}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve the game over HTTP.")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    args = parser.parse_args()

    if not (ROOT / "index.html").exists():
        print(f"index.html not found in {ROOT}", file=sys.stderr)
        return 1

    socketserver.TCPServer.allow_reuse_address = True

    for port in range(args.port, args.port + 20):
        try:
            httpd = socketserver.ThreadingTCPServer((args.host, port), Handler)
            break
        except OSError:
            continue
    else:
        print(f"no free port in {args.port}-{args.port + 19}", file=sys.stderr)
        return 1

    url = f"http://{args.host}:{port}/"
    print(f"Towers running at {url}")
    print("Press Ctrl+C to stop.")

    if not args.no_browser:
        webbrowser.open(url)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
