"""
AI Hand Detection Presentation - Streamlit entry point
======================================================
Deploy on Streamlit Community Cloud with this file as the main file, or run locally:

    streamlit run app.py

The interface in ./web is served unchanged as a full-page Streamlit component. Hand tracking,
the PDF viewer and the 3D scene run in the visitor's browser, so the webcam is used on the
visitor's own device and nothing is uploaded to the server.

Differences from the desktop launcher (python main.py):
  * PowerPoint/Word to PDF conversion needs Office or LibreOffice on the local PC, so on the web
    open PDFs, images or DOCX (built-in reader); export PPTX to PDF first.
"""

import mimetypes
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

WEB_DIR = Path(__file__).resolve().parent / "web"

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

hand_presenter = components.declare_component("hand_presenter", path=str(WEB_DIR))
hand_presenter(key="hand_presenter")
