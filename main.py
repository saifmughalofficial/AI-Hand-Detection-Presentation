"""
AI Hand Detection Presentation - desktop launcher
=================================================
Starts the Streamlit app (app.py) on this PC and opens it in its own Edge/Chrome app window
with webcam access. Closing the window stops the app.

    python main.py                 # app window on http://127.0.0.1:8765
    python main.py --port 9000
    python main.py --no-window     # server only; open the printed URL yourself
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import webbrowser
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
DEFAULT_PORT = 8765


def free_port(start: int) -> int:
    for port in range(start, start + 25):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise SystemExit(f"No free port between {start} and {start + 24}.")


def find_browser() -> str | None:
    roots = [os.environ.get(k) for k in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")]
    for sub in (r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe"):
        for root in filter(None, roots):
            candidate = Path(root) / sub
            if candidate.exists():
                return str(candidate)
    for name in ("msedge", "chrome", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    return None


def open_app_window(url: str) -> subprocess.Popen | None:
    browser = find_browser()
    if not browser:
        webbrowser.open(url)
        return None
    profile = Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir())) / "AIHandPresentation" / "browser"
    profile.mkdir(parents=True, exist_ok=True)
    return subprocess.Popen([
        browser, f"--app={url}", f"--user-data-dir={profile}", "--start-maximized", "--no-first-run",
        "--no-default-browser-check",
        "--use-fake-ui-for-media-stream",          # auto-allow the webcam for this local app only
        "--ignore-gpu-blocklist",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
    ])


def wait_until_up(url: str, server: subprocess.Popen, timeout: float = 60) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if server.poll() is not None:
            raise SystemExit("Streamlit stopped while starting. Run: python -m pip install -r requirements.txt")
        try:
            with urllib.request.urlopen(url + "_stcore/health", timeout=2) as r:
                if r.status == 200:
                    return
        except OSError:
            time.sleep(0.5)
    raise SystemExit("Streamlit did not start in time.")


def main() -> None:
    parser = argparse.ArgumentParser(description="AI Hand Detection Presentation")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-window", action="store_true", help="start the server without opening a window")
    args = parser.parse_args()

    if importlib.util.find_spec("streamlit") is None:
        raise SystemExit("Streamlit is not installed. Run: python -m pip install -r requirements.txt")

    port = free_port(args.port)
    url = f"http://127.0.0.1:{port}/"
    server = subprocess.Popen(
        [sys.executable, "-m", "streamlit", "run", str(APP_DIR / "app.py"), "--server.port", str(port),
         "--server.address", "127.0.0.1", "--server.headless", "true", "--browser.gatherUsageStats", "false"],
        cwd=APP_DIR,
    )
    try:
        wait_until_up(url, server)
        print("=" * 62)
        print("  AI HAND DETECTION PRESENTATION  //  PYTHON + STREAMLIT")
        print("=" * 62)
        print(f"  App      : {url}")
        print("  Privacy  : the camera image never leaves this PC")
        print("  Close the app window (or press Ctrl+C here) to quit.")
        print("=" * 62)
        window = None if args.no_window else open_app_window(url)
        if window is not None:
            window.wait()
        else:
            server.wait()
    except KeyboardInterrupt:
        pass
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    main()
