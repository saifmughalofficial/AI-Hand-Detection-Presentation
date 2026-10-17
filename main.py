"""
AI Hand Detection Presentation - Holographic Edition
====================================================
Local-first presentation controller driven by natural hand movement.

    python main.py                 # opens the app window
    python main.py --no-window     # server only, open the printed URL yourself

This file uses the Python standard library only. It:
  * serves the interface in ./web on 127.0.0.1 (never reachable from the network)
  * converts PPTX/PPT/DOCX/DOC/ODP/ODT/RTF to PDF locally with LibreOffice or Microsoft Office
  * opens the interface in a chromeless Edge/Chrome window with webcam access

Hand tracking (MediaPipe, up to 60 FPS), the PDF viewer (PDF.js) and the 3D scene (Three.js)
run inside that window. Every library and the hand model ship in ./web/vendor, so the app
works offline with no paid API, account or key.
"""

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

APP_TITLE = "AI Hand Detection Presentation"
APP_DIR = Path(__file__).resolve().parent
WEB_DIR = APP_DIR / "web"
DEFAULT_PORT = 8765
MAX_UPLOAD = 300 * 1024 * 1024
CONVERT_TIMEOUT = 240
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

POWERPOINT_EXT = {".pptx", ".ppt", ".ppsx", ".pps", ".odp"}
WORD_EXT = {".docx", ".doc", ".odt", ".rtf"}
OFFICE_EXT = POWERPOINT_EXT | WORD_EXT

CONVERT_LOCK = threading.Lock()


class ConversionError(Exception):
    pass


# --------------------------------------------------------------------------- converters

def find_soffice():
    for name in ("soffice", "soffice.exe", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if base:
            candidate = Path(base) / "LibreOffice" / "program" / "soffice.exe"
            if candidate.exists():
                return str(candidate)
    return None


def has_com_server(prog_id):
    if os.name != "nt":
        return False
    try:
        import winreg
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, prog_id))
        return True
    except OSError:
        return False


def available_converters():
    found = []
    if find_soffice():
        found.append("LibreOffice")
    if has_com_server("PowerPoint.Application"):
        found.append("PowerPoint")
    if has_com_server("Word.Application"):
        found.append("Word")
    return found


# Macros are force-disabled (AutomationSecurity = 3) and an Office instance the user
# already had open is never closed.
POWERPOINT_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject PowerPoint.Application
$hadOpen = $app.Presentations.Count -gt 0
try {
  try { $app.AutomationSecurity = 3 } catch {}
  $deck = $app.Presentations.Open($env:AHDP_SRC, -1, 0, 0)
  try { $deck.SaveAs($env:AHDP_DST, 32) } finally { $deck.Close() }
} finally {
  if (-not $hadOpen) { $app.Quit() }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
"""

WORD_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject Word.Application
$hadOpen = $app.Documents.Count -gt 0
try {
  $app.DisplayAlerts = 0
  try { $app.AutomationSecurity = 3 } catch {}
  $doc = $app.Documents.Open($env:AHDP_SRC, $false, $true, $false)
  try { $doc.ExportAsFixedFormat($env:AHDP_DST, 17) } finally { try { $doc.Close(0) } catch { $doc.Close() } }
} finally {
  if (-not $hadOpen) { $app.Quit() }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
"""


def convert_with_libreoffice(soffice, src, out_dir):
    profile = (out_dir / "lo-profile").as_uri()
    result = subprocess.run(
        [soffice, f"-env:UserInstallation={profile}", "--headless", "--norestore",
         "--convert-to", "pdf", "--outdir", str(out_dir), str(src)],
        capture_output=True, text=True, timeout=CONVERT_TIMEOUT, creationflags=NO_WINDOW,
    )
    if result.returncode != 0:
        raise ConversionError((result.stderr or result.stdout or "conversion failed").strip()[:300])


def convert_with_msoffice(script, src, dst):
    env = dict(os.environ, AHDP_SRC=str(src), AHDP_DST=str(dst))
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        capture_output=True, text=True, timeout=CONVERT_TIMEOUT, env=env, creationflags=NO_WINDOW,
    )
    if result.returncode != 0:
        raise ConversionError((result.stderr or result.stdout or "conversion failed").strip()[:300])


def convert_to_pdf(name, data):
    ext = Path(name).suffix.lower()
    if ext not in OFFICE_EXT:
        raise ConversionError(f"Unsupported file type: {ext or 'unknown'}")
    with CONVERT_LOCK, tempfile.TemporaryDirectory(prefix="ahdp_") as tmp:
        tmp_dir = Path(tmp)
        src = tmp_dir / f"input{ext}"
        dst = tmp_dir / "input.pdf"
        src.write_bytes(data)
        errors = []

        soffice = find_soffice()
        if soffice:
            try:
                convert_with_libreoffice(soffice, src, tmp_dir)
            except (ConversionError, OSError, subprocess.TimeoutExpired) as exc:
                errors.append(f"LibreOffice: {exc}")

        if not dst.exists():
            prog_id, script = (("PowerPoint.Application", POWERPOINT_SCRIPT) if ext in POWERPOINT_EXT
                               else ("Word.Application", WORD_SCRIPT))
            if has_com_server(prog_id):
                try:
                    convert_with_msoffice(script, src, dst)
                except (ConversionError, OSError, subprocess.TimeoutExpired) as exc:
                    errors.append(f"{prog_id.split('.')[0]}: {exc}")

        if dst.exists() and dst.stat().st_size > 0:
            return dst.read_bytes()
        if errors:
            raise ConversionError("; ".join(errors))
        raise ConversionError(
            "No local converter found. Install the free LibreOffice (libreoffice.org) "
            "or export the file to PDF first."
        )


# --------------------------------------------------------------------------- web server

class Lifetime:
    last_ping = 0.0

    @classmethod
    def ping(cls):
        cls.last_ping = time.monotonic()


class AppHandler(SimpleHTTPRequestHandler):
    # Windows' registry can map .js to text/plain, which breaks ES modules, so types are explicit.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".task": "application/octet-stream",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def _host_allowed(self):
        port = self.server.server_address[1]
        return self.headers.get("Host", "") in {f"127.0.0.1:{port}", f"localhost:{port}"}

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._host_allowed():
            return self._json({"error": "Forbidden host"}, 403)
        path = urlparse(self.path).path
        if path == "/api/ping":
            Lifetime.ping()
            return self._json({"ok": True})
        if path == "/api/info":
            return self._json({"app": APP_TITLE, "converters": available_converters()})
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if not self._host_allowed() or self.headers.get("X-Requested-With") != "hand-presenter":
            return self._json({"error": "Forbidden"}, 403)
        if parsed.path != "/api/convert":
            return self._json({"error": "Not found"}, 404)
        name = Path(parse_qs(parsed.query).get("name", ["document"])[0]).name
        name = re.sub(r"[^\w.\- ]", "_", name) or "document"
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_UPLOAD:
            return self._json({"error": "File is empty or larger than 300 MB."}, 413)
        data = self.rfile.read(length)
        try:
            pdf = convert_to_pdf(name, data)
        except ConversionError as exc:
            return self._json({"error": str(exc)}, 422)
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(pdf)))
        self.end_headers()
        self.wfile.write(pdf)


def make_server(port):
    for candidate in range(port, port + 25):
        try:
            return ThreadingHTTPServer(("127.0.0.1", candidate), AppHandler)
        except OSError:
            continue
    raise SystemExit(f"No free port between {port} and {port + 24}.")


# --------------------------------------------------------------------------- app window

def find_browser():
    roots = [os.environ.get(k) for k in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")]
    rel = [r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe"]
    for sub in rel:
        for root in filter(None, roots):
            candidate = Path(root) / sub
            if candidate.exists():
                return str(candidate)
    for name in ("msedge", "chrome", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    return None


def open_app_window(url):
    browser = find_browser()
    if not browser:
        webbrowser.open(url)
        return None
    profile = Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir())) / "AIHandPresentation" / "browser"
    profile.mkdir(parents=True, exist_ok=True)
    return subprocess.Popen([
        browser,
        f"--app={url}",
        f"--user-data-dir={profile}",
        "--window-size=1440,900",
        "--start-maximized",
        "--no-first-run",
        "--no-default-browser-check",
        "--use-fake-ui-for-media-stream",          # auto-grant the webcam to this local app only
        "--ignore-gpu-blocklist",                  # keep WebGL/GPU tracking on older Intel graphics
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
    ])


def wait_for_window(proc, started):
    """Keep serving while the app window is open (or still pinging after a browser hand-off)."""
    proc.wait()
    while time.monotonic() - started < 15 or time.monotonic() - Lifetime.last_ping < 10:
        time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description=APP_TITLE)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-window", action="store_true", help="start the server without opening a window")
    args = parser.parse_args()

    if not (WEB_DIR / "index.html").exists():
        raise SystemExit(f"Interface files are missing: {WEB_DIR}")

    server = make_server(args.port)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    threading.Thread(target=server.serve_forever, daemon=True).start()

    converters = available_converters()
    print("=" * 62)
    print(f"  {APP_TITLE.upper()}  //  HOLOGRAPHIC EDITION")
    print("=" * 62)
    print(f"  Interface   : {url}")
    print(f"  Office files: {', '.join(converters) if converters else 'PDF/images only (install LibreOffice for PPTX/DOCX)'}")
    print("  Privacy     : camera frames and files never leave this PC")
    print("  Close the app window (or press Ctrl+C here) to quit.")
    print("=" * 62)

    proc = None if args.no_window else open_app_window(url)
    try:
        if proc is not None:
            wait_for_window(proc, time.monotonic())
        else:
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
