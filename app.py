"""
AI Hand Detection Presentation - Streamlit entry point
======================================================
Run locally (double-click run_streamlit.bat, or):

    streamlit run app.py --server.port 8765 --server.address localhost

then open http://localhost:8765. Deploy on Streamlit Community Cloud with this file as the main file.

The interface in ./web is served unchanged as a full-page Streamlit component. Hand tracking,
the PDF viewer and the 3D scene run in the visitor's browser, so the webcam is used on the
visitor's own device and nothing is uploaded to the server.

Camera note: browsers only allow the webcam on https:// or on localhost. The "Network URL"
(http://192.168.x.x:...) that Streamlit prints blocks the camera, so this page shows a link
to the localhost address when it is opened that way.

PowerPoint / Word: when the app runs on your own PC, the local converter from main.py is started
on 127.0.0.1 (LibreOffice or Microsoft Office do the conversion; nothing leaves the PC).
"""

import ipaddress
import mimetypes
import threading
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

WEB_DIR = Path(__file__).resolve().parent / "web"
CONVERTER_PORT = 8766

# Streamlit serves component files with Python's MIME table. Some systems lack these entries,
# and browsers refuse ES modules / WebAssembly served with the wrong type.
for mime, ext in (
    ("text/javascript", ".js"),
    ("text/javascript", ".mjs"),
    ("text/css", ".css"),
    ("application/wasm", ".wasm"),
    ("font/woff2", ".woff2"),
    ("application/octet-stream", ".task"),
):
    mimetypes.add_type(mime, ext)

st.set_page_config(
    page_title="AI Hand Detection Presentation",
    page_icon="✋",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# Let the app fill the whole browser window, like the desktop version.
st.markdown(
    """
    <style>
      header[data-testid="stHeader"], #MainMenu, footer { display: none !important; }
      [data-testid="stAppViewContainer"], .stApp { background: #010603; }
      [data-testid="stMainBlockContainer"], .block-container {
        padding: 0 !important; max-width: 100% !important;
      }
      [data-testid="stVerticalBlock"] { gap: 0 !important; }
      iframe { border: 0; display: block; }
    </style>
    """,
    unsafe_allow_html=True,
)


def request_host():
    """(hostname, is_local, camera_blocked) for the address the visitor used to open the app.

    The camera is only blocked on plain-http IP addresses, i.e. Streamlit's "Network URL" /
    "External URL". Named hosts such as *.streamlit.app are served over https and work. (Proxies
    do not always forward X-Forwarded-Proto, so it is not relied on; the page itself also checks
    window.isSecureContext and shows its own fix-it link.)
    """
    try:
        headers = st.context.headers
    except Exception:
        return "", True, False
    host = headers.get("Host", "") or ""
    name = host.rsplit(":", 1)[0].strip("[]") if host.count(":") <= 1 or host.startswith("[") else host
    if name in ("localhost", "") or name.endswith(".localhost"):
        return name, True, False
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        return name, False, False  # a domain name: https in practice
    https = (headers.get("X-Forwarded-Proto", "") or "").lower() == "https"
    return name, ip.is_loopback, not ip.is_loopback and not https


@st.cache_resource(show_spinner=False)
def start_converter():
    """Start main.py's localhost-only Office→PDF converter once per Streamlit process."""
    try:
        from main import make_server
        server = make_server(CONVERTER_PORT)
    except (Exception, SystemExit):
        return None
    threading.Thread(target=server.serve_forever, daemon=True, name="office-converter").start()
    return f"http://127.0.0.1:{server.server_address[1]}"


host, is_local, camera_blocked = request_host()
if camera_blocked:
    port = st.get_option("server.port")
    st.warning(
        f"**Camera blocked on this address ({host}).** Browsers only allow the webcam on localhost "
        f"or https. On this PC open **http://localhost:{port}** instead.",
        icon="📷",
    )
    st.link_button(f"Open http://localhost:{port}", f"http://localhost:{port}", type="primary")

hand_presenter = components.declare_component("hand_presenter", path=str(WEB_DIR))
hand_presenter(key="hand_presenter", converter=start_converter() if is_local else None)
