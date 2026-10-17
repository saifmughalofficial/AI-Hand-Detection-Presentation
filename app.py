"""
AI Hand Detection Presentation - Streamlit app
==============================================
Control PDFs, PowerPoint decks, Word documents and images with natural hand movement.

    streamlit run app.py            (or double-click run_windows.bat / python main.py)

Deploy on Streamlit Community Cloud with app.py as the main file.

How it works: the visitor's browser opens the webcam and finds the 21 hand points (MediaPipe,
see hand_presenter/camera.py). Python receives the points about 9 times a second and does
everything else: gesture recognition (hand_presenter/gestures.py), page rendering and Office
conversion (hand_presenter/documents.py), navigation, zoom, modes, settings and the interface.
"""
from __future__ import annotations

import html
import json
import mimetypes
import time

import pymupdf as fitz
import streamlit as st

from hand_presenter import documents, theme
from hand_presenter.camera import hand_camera
from hand_presenter.gestures import GestureController, analyze_hand

# Static files (static/mediapipe) are served with Python's MIME table; WebAssembly needs its exact type.
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".task")

st.set_page_config(page_title="AI Hand Detection Presentation", page_icon="✋", layout="wide",
                   initial_sidebar_state="collapsed")

ZOOM_MIN, ZOOM_MAX = 0.4, 2.5
DOC_MODE_MAX_PAGES = 60
ZOOM_MODES = {"Pinch + move up / down (smooth)": "pinch", "Hand closer / farther (steps)": "depth",
              "Off (buttons / keys)": "off"}
SETTINGS = {
    "set_sens": 72, "set_smooth": 25, "set_cool": 450, "set_zoom": next(iter(ZOOM_MODES)), "set_once": True,
    "set_point": True, "set_laser": True, "set_updown": True, "set_video": False, "set_mirror": True,
    "set_skeleton": True,
}
STATE_TEXT = {
    "NO HAND": ("NO HAND", "Show your hand to the camera"),
    "LOCKING": ("LOCKING", "Hold your hand still…"),
    "READY": ("READY", "Move your hand to control"),
    "STILL": ("STILL", "Hand still · no action"),
    "RE-ARM": ("RE-ARM", "Return to center or hold still"),
    "COOLDOWN": ("COOLDOWN", "Waiting before next action"),
    "LOCKED": ("DONE", "Lower your hand, then show it again"),
    "POINT": ("POINTING", "Hold to confirm"),
    "PINCH": ("PINCH", "Move up / down to zoom"),
    "LASER": ("LASER", "Point at the slide"),
}

ss = st.session_state


def init_state() -> None:
    defaults = {
        "doc": None, "index": 0, "zoom": 1.0, "mode": "Slide", "mode_ctl": "Slide", "anim": "load", "zoom_from": 1.0,
        "nav": 0, "event": {"id": 0}, "scroll": {"id": 0}, "goto": {"id": 0}, "log": [], "last_seq": None,
        "status": "Choose a PDF, PowerPoint, Word file or images to begin.", "cam": {}, "hud": {}, "pose": "open",
        "hand": None, "move": ("WAITING", "Start the camera to begin"), "hold_until": 0.0, "pinch": None,
        "zoom_preview": None, "upl_nonce": 0, "upl_sig": None, "was_running": False, "was_live": False,
        "low_light_warned": False,
    }
    for key, value in {**defaults, **SETTINGS}.items():
        if key not in ss:
            ss[key] = value
    if "controller" not in ss:
        ss.controller = GestureController()
        log("System ready. Add your file and start the camera.", "ok")


# ------------------------------------------------------------------ log, status, effects

def log(message: str, level: str = "info") -> None:
    ss.log = ([(time.strftime("%H:%M:%S"), level, message)] + ss.get("log", []))[:60]


def set_status(message: str) -> None:
    ss.status = message


def emit(text: str, action: str | None = None, kind: str = "") -> None:
    """Ask the browser to show a toast (and an arrow flash for an action)."""
    ss.event = {"id": ss.event["id"] + 1, "text": text, "action": action, "kind": kind}


# ------------------------------------------------------------------ navigation & zoom

def is_slide_view() -> bool:
    return ss.mode == "Slide" and (ss.doc is None or ss.doc.kind != "html")


def navigate(direction: int, axis: str = "x") -> bool:
    doc = ss.doc
    if doc is None:
        set_status("Open a file to use page navigation.")
        return False
    if doc.kind == "html":
        scroll(direction)
        return True
    new = ss.index + direction
    if not 0 <= new < doc.count:
        emit("LAST PAGE REACHED" if direction > 0 else "FIRST PAGE REACHED", kind="warn")
        set_status("Already on the last page." if direction > 0 else "Already on the first page.")
        return False
    ss.index = new
    ss.anim = f"{axis}{'p' if direction > 0 else 'm'}"
    ss.nav += 1
    if ss.mode == "Document":
        ss.goto = {"id": ss.goto["id"] + 1, "page": new}
    set_status("Next page" if direction > 0 else "Previous page")
    return True


def scroll(direction: int, axis: str = "y") -> None:
    ss.scroll = {"id": ss.scroll["id"] + 1, "dir": direction, "axis": axis}


def scroll_document(direction: int) -> None:
    if is_slide_view():
        navigate(direction, "y")
    elif ss.doc is not None:
        scroll(direction)
        set_status("Document scroll command")


def set_zoom(value: float, animate: bool = True) -> None:
    if ss.doc is None:
        set_status("Open a file to use zoom.")
        return
    z = min(ZOOM_MAX, max(ZOOM_MIN, round(value, 2)))
    if z != ss.zoom:
        ss.zoom_from = ss.zoom / z
        ss.anim = "zoom" if animate else "none"
        ss.nav += 1
        ss.zoom = z
    set_status(f"Zoom: {round(ss.zoom * 100)}%")


def set_mode(mode: str) -> None:
    ss.mode = ss.mode_ctl = mode
    if mode == "Document":
        ss.goto = {"id": ss.goto["id"] + 1, "page": ss.index, "smooth": False}
    ss.anim = "load"
    ss.nav += 1
    set_status(f"Mode: {mode} Mode")


def on_mode_widget() -> None:
    set_mode(ss.mode_ctl or ss.mode)


def recalibrate() -> None:
    ss.controller.reset()
    ss.move = ("LOCKING", "Hold your hand still…")
    set_status("Recalibrating: keep your hand still briefly.")
    log("Recalibrating neutral hand position.")


def close_file() -> None:
    if ss.doc is not None:
        log(f"Closed {ss.doc.name}.")
    ss.doc = None
    ss.index, ss.zoom = 0, 1.0
    ss.upl_nonce += 1
    ss.upl_sig = None
    set_status("File closed. Choose a file to begin.")


# ------------------------------------------------------------------ gestures from the browser

def apply_settings(c: GestureController) -> None:
    c.threshold = 0.16 - ss.set_sens / 100 * 0.125
    c.smoothing = ss.set_smooth / 100
    c.cooldown_ms = ss.set_cool
    c.zoom_mode = ZOOM_MODES.get(ss.set_zoom, "pinch")
    c.pointing = ss.set_point
    c.laser = ss.set_laser
    c.once_per_appearance = ss.set_once
    if not ss.set_once:
        c.locked = False


def handle_key(key: str) -> None:
    actions = {
        "KEY_LEFT": lambda: navigate(-1), "KEY_RIGHT": lambda: navigate(1),
        "KEY_UP": lambda: scroll_document(-1), "KEY_DOWN": lambda: scroll_document(1),
        "ZOOM_IN": lambda: set_zoom(ss.zoom + 0.1), "ZOOM_OUT": lambda: set_zoom(ss.zoom - 0.1),
        "FIT": lambda: set_zoom(1.0), "MODE": lambda: set_mode("Document" if ss.mode == "Slide" else "Slide"),
        "RECALIBRATE": recalibrate,
    }
    if key in actions:
        actions[key]()


def apply_action(action: str) -> None:
    doc = ss.doc
    slide = is_slide_view()
    if doc is None:
        result = "Add a file to control it"
    elif action in ("LEFT", "RIGHT"):
        d = -1 if action == "LEFT" else 1
        if slide:
            result = ("Next slide" if d > 0 else "Previous slide") if navigate(d) else ("Last slide" if d > 0 else "First slide")
        else:
            scroll(d, "x")
            result = "Pan right" if d > 0 else "Pan left"
    elif action in ("UP", "DOWN"):
        d = -1 if action == "UP" else 1
        if not slide:
            scroll(d)
            result = "Scroll down" if d > 0 else "Scroll up"
        elif ss.set_updown:
            result = ("Next slide" if d > 0 else "Previous slide") if navigate(d, "y") else ("Last slide" if d > 0 else "First slide")
        else:
            result = "No action in Slide Mode"
    elif action in ("POINT_LEFT", "POINT_RIGHT"):
        d = -1 if action == "POINT_LEFT" else 1
        word = "slide" if slide else "page"
        result = (f"Next {word}" if d > 0 else f"Previous {word}") if navigate(d) else ("Last page" if d > 0 else "First page")
    elif action in ("ZOOM_IN", "ZOOM_OUT"):
        set_zoom(ss.zoom + (0.15 if action == "ZOOM_IN" else -0.15))
        result = f"Zoom {round(ss.zoom * 100)}%"
    else:
        return
    word = action.replace("_", " ")
    ss.move = (word, result)
    emit(f"HAND {word} → {result.upper()}", action)
    set_status(f"Hand moved {word.lower()} → {result}")
    log(f"Gesture {word} → {result}", "ok")


def on_zoom(zoom: dict) -> None:
    if zoom["phase"] == "start":
        ss.pinch = {"start": ss.zoom, "target": ss.zoom}
        log("Pinch zoom: move the pinched hand up to zoom in, down to zoom out.")
    if not ss.pinch:
        return
    target = min(ZOOM_MAX, max(ZOOM_MIN, round(ss.pinch["start"] * zoom["factor"], 2)))
    ss.pinch["target"] = target
    ss.zoom_preview = round(target / ss.zoom, 3) if ss.doc is not None else None
    ss.move = ("ZOOM", f"{round(target * 100)}% · open fingers to finish")
    if zoom["phase"] == "end":
        finish_pinch()


def finish_pinch() -> None:
    if not ss.pinch:
        return
    target = ss.pinch["target"]
    ss.pinch = None
    ss.zoom_preview = None
    if ss.doc is not None:
        set_zoom(target, animate=False)
        log(f"Pinch zoom set to {round(ss.zoom * 100)}%.", "ok")


def handle_frame(frame: dict | None) -> None:
    if not frame or frame.get("seq") == ss.last_seq:
        return
    ss.last_seq = frame.get("seq")
    cam = ss.cam = {k: frame.get(k) for k in ("running", "paused", "fps", "ai", "delegate", "light")}
    for key in frame.get("keys") or []:
        handle_key(key)
    page = frame.get("page")
    if page is not None and ss.doc is not None and not is_slide_view() and 0 <= page < ss.doc.count:
        ss.index = page

    if cam["running"] != ss.was_running:
        ss.was_running = cam["running"]
        log("Camera started. Hold your hand still briefly to calibrate." if cam["running"] else "Camera stopped.",
            "ok" if cam["running"] else "info")
        set_status("Camera started. Hold your hand still briefly to calibrate." if cam["running"] else "Camera stopped.")
    light = cam.get("light")
    if light is not None and light < 0.2 and not ss.low_light_warned:
        ss.low_light_warned = True
        log("Low light detected. Face a window or lamp for reliable tracking.", "warn")
    c = ss.controller
    apply_settings(c)
    live = bool(cam["running"] and not cam["paused"])
    if live != ss.was_live:
        ss.was_live = live
        c.reset()
        finish_pinch()
        if cam["running"]:
            log("Tracking paused." if cam["paused"] else "Tracking on.")
    if not live:
        ss.hud, ss.pose, ss.hand = {}, "open", None
        ss.move = ("PAUSED", "Press SPACE to resume") if cam["running"] else ("WAITING", "Start the camera to begin")
        return

    hand = frame.get("hand")
    now = float(frame.get("t") or 0)
    if hand and len(hand.get("lm") or []) == 21:
        aspect = (frame.get("w") or 640) / (frame.get("h") or 480)
        palm, size, pose = analyze_hand(hand["lm"], aspect)
        event = c.update(palm, size, pose, now)
        ss.hand = {"score": hand.get("score", 1)}
    else:
        event = c.lost(now)
        ss.hand = None
    hud = c.hud()
    ss.hud = {"origin": hud["origin"], "point": hud["point"], "threshold": round(hud["threshold"], 4),
              "armed": hud["armed"], "pose": hud["pose"], "locked": hud["locked"]}
    ss.pose = c.pose if ss.hand else "open"

    if event["zoom"]:
        on_zoom(event["zoom"])
    if event["action"]:
        apply_action(event["action"])
        ss.hold_until = time.time() + 0.9
    elif event["state"] != "ZOOM" and time.time() > ss.hold_until:
        ss.move = STATE_TEXT.get(event["state"], (event["state"], ""))


# ------------------------------------------------------------------ files

def handle_upload(files) -> None:
    if not files:
        return
    sig = tuple((f.name, f.size, getattr(f, "file_id", "")) for f in files)
    if sig == ss.upl_sig:
        return
    ss.upl_sig = sig
    office = any(f.name.lower().endswith(tuple(documents.OFFICE_EXT)) for f in files)
    label = "Converting to PDF on the server…" if office else "Loading…"
    with st.spinner(label):
        try:
            doc = documents.load_files([(f.name, f.getvalue()) for f in files])
        except Exception as exc:  # noqa: BLE001 - shown to the user
            log(f"Could not open {files[0].name}: {exc}", "err")
            set_status(f"Could not open file: {exc}")
            emit("COULD NOT OPEN FILE — SEE DATA STREAM", kind="err")
            return
    ss.doc, ss.index, ss.zoom, ss.anim, ss.zoom_preview, ss.pinch = doc, 0, 1.0, "load", None, None
    ss.nav += 1
    pages = "document" if doc.kind == "html" else f"{doc.count} page(s)"
    log(f"Loaded {doc.name} · {pages}", "ok")
    if doc.note:
        log(doc.note, "warn")
    set_status(f"Loaded: {doc.name}")
    emit(f"LOADED · {doc.name.upper()}")


# ------------------------------------------------------------------ HTML pieces

def head_html(title: str, right: str = "") -> str:
    return f'<div class="hp-head">{title}<span class="grow"></span>{right}</div>'


@st.cache_data(show_spinner=False)
def system_rows(converters: tuple[str, ...]) -> str:
    rows = [("3D scene", "CSS 3D"), ("PDF engine", f"PyMuPDF {getattr(fitz, 'VersionBind', '')}".strip()),
            ("Hand model", "MediaPipe"),
            ("Logic", "Python"), ("Office", " + ".join(converters) if converters else "PDF · images · DOCX")]
    return "".join(f"<tr><td></td><td>{a}</td><td style='text-align:right;color:#00ff66'>{html.escape(b)}</td></tr>"
                   for a, b in rows)


def home_html() -> str:
    converters = tuple(documents.available_converters())
    return (
        '<div class="hp-home">' + theme.globe_html() +
        '<div class="hp-side"><div class="hp-mini"><b class="h">// SYSTEM STATUS</b><table>'
        f'{system_rows(converters)}</table></div>'
        '<div class="hp-words"><span>DETECT</span><span>TRACK</span><span>CONTROL</span><span>PRESENT</span></div></div>'
        '<div class="hp-home-center"><div class="hp-eyebrow">// NATURAL HAND MOVEMENT CONTROL</div>'
        '<div class="hp-hero">PRESENT <em>HANDS-FREE</em></div>'
        '<p class="hp-hero-sub">Swipe, point or pinch. No clicker, no cloud upload, no API keys.</p></div>'
        '<div class="hp-side right"><div class="hp-mini"><b class="h">// GESTURES</b><table>'
        '<tr><td>◀▶</td><td>Swipe / point finger: prev · next</td></tr>'
        '<tr><td>▲▼</td><td>Swipe up / down: prev · next</td></tr>'
        '<tr><td>🤏</td><td>Pinch + move up / down: zoom</td></tr>'
        '<tr><td>☝</td><td>Finger up: laser pointer</td></tr>'
        '<tr><td>✋</td><td>1 action, then lower hand</td></tr></table></div>'
        '<div class="hp-mini"><b class="h">// FORMATS</b>PDF · PPTX · PPT · DOCX · DOC · ODP · PNG · JPG · BMP · GAMMA</div></div>'
        '<div class="hp-steps"><span><b>01</b>Add file</span><span><b>02</b>Start camera</span>'
        '<span><b>03</b>Hold still to calibrate</span><span><b>04</b>Swipe or point · ⛶ Present</span></div></div>'
    )


def stage_html() -> str:
    doc = ss.doc
    corners = '<div class="hp-corners"><i></i><i></i><i></i><i></i></div>'
    if doc is None:
        return f'<div class="hp-stage-wrap">{home_html()}{corners}</div>'
    # Alternating the wrapper tag makes the browser rebuild the slide, so its entrance animation replays.
    tag = "section" if ss.nav % 2 else "div"
    if doc.kind == "html":
        body = f'<div class="hp-doc"><article class="hp-paper hp-zoomable" style="zoom:{ss.zoom}">{doc.html}</article></div>'
    elif is_slide_view():
        uri = documents.page_data_uri(doc, ss.index, min(2600, int(1600 * max(1.0, ss.zoom))))
        z = round(ss.zoom * 100)
        scan = '<div class="hp-scanline"></div>' if ss.anim in ("xp", "xm", "yp", "ym", "load") else ""
        body = (f'<div class="hp-stage"><img class="hp-zoomable hp-anim-{ss.anim}" alt="Page {ss.index + 1}" '
                f'style="--hp-zfrom:{ss.zoom_from:.3f};max-width:{z}%;max-height:{z}%" src="{uri}"></div>{scan}')
    else:
        width = min(2200, int(1000 * max(1.0, ss.zoom)))
        pages = "".join(
            f'<div class="hp-doc-page" data-page="{i}" style="width:{min(86 * ss.zoom, 400):.0f}%">'
            f'<span>{i + 1:02d}</span><img alt="Page {i + 1}" src="{documents.page_data_uri(doc, i, width, "jpeg")}"></div>'
            for i in range(min(doc.count, DOC_MODE_MAX_PAGES)))
        more = (f'<p style="text-align:center;color:#69b886">Showing the first {DOC_MODE_MAX_PAGES} pages · '
                f'switch to Slide Mode for all {doc.count}.</p>') if doc.count > DOC_MODE_MAX_PAGES else ""
        body = f'<div class="hp-doc"><div class="hp-doc-pages hp-zoomable">{pages}</div>{more}</div>'
    return f'<{tag} class="hp-stage-wrap hp-loaded">{body}{corners}</{tag}>'


def readout_html() -> str:
    hud, (main, sub) = ss.hud, ss.move
    cls, dot = "hp-compass idle", ""
    if hud.get("origin") and hud.get("point") and ss.hand:
        t = hud["threshold"] or 0.07
        dx = max(-1.5, min(1.5, (hud["point"][0] - hud["origin"][0]) / t)) * 26
        dy = max(-1.5, min(1.5, (hud["point"][1] - hud["origin"][1]) / t)) * 26
        cls = "hp-compass" if hud.get("armed") else "hp-compass rearm"
        dot = f' style="transform:translate({dx:.1f}px,{dy:.1f}px)"'
    hit = {"UP": "u", "DOWN": "d", "LEFT": "l", "RIGHT": "r", "POINT LEFT": "l", "POINT RIGHT": "r"}.get(main, "")
    arrows = "".join(f'<span class="a {k}{" hit" if k == hit else ""}">{s}</span>' for k, s in
                     (("u", "▲"), ("l", "◀"), ("r", "▶"), ("d", "▼")))
    warn = " warn" if main in ("DONE", "RE-ARM", "PAUSED") else ""
    return (f'<div class="hp-panel hp-readout"><div class="{cls}"><div class="ring"></div>{arrows}<span class="dot"{dot}></span></div>'
            f'<div class="hp-mv"><label>MOVEMENT</label><div class="v{warn}">{html.escape(main)}</div>'
            f'<div class="s">{html.escape(sub)}</div></div></div>')


def stats_html() -> str:
    cam, live = ss.cam, ss.cam.get("running")
    light = cam.get("light")
    light_txt = "--" if light is None or not live else ("LOW" if light < 0.2 else "GOOD")
    pose = {"point-left": "POINT ◀", "point-right": "POINT ▶", "pinch": "PINCH", "laser": "LASER"}.get(ss.pose, "OPEN" if ss.hand else "--")
    cells = [("CAM FPS", cam.get("fps") if live else "--", ""), ("AI FPS", cam.get("ai") if live else "--", ""),
             ("CONFIDENCE", f"{round(ss.hand['score'] * 100)}%" if ss.hand else "--", ""),
             ("LIGHT", light_txt, " class='warn'" if light_txt == "LOW" else ""),
             ("ENGINE", (cam.get("delegate") or "--") if live else "--", ""), ("POSE", pose, "")]
    return '<div class="hp-stats">' + "".join(f"<div><label>{a}</label><b{c}>{b}</b></div>" for a, b, c in cells) + "</div>"


def log_html() -> str:
    lines = "".join(f'<div class="{lvl}">{t} [{lvl.upper()}] {html.escape(msg)}</div>' for t, lvl, msg in ss.log[:40])
    return f'<div class="hp-panel hp-log">{lines}</div>'


KEYS_HTML = (
    '<div class="hp-panel hp-keys">'
    '<span><kbd>←</kbd><kbd>→</kbd></span><span>Page / slide</span>'
    '<span><kbd>↑</kbd><kbd>↓</kbd></span><span>Scroll / slide</span>'
    '<span><kbd>+</kbd><kbd>−</kbd><kbd>0</kbd></span><span>Zoom · fit</span>'
    '<span><kbd>P</kbd></span><span>Present (full screen)</span>'
    '<span><kbd>Space</kbd></span><span>Pause tracking</span>'
    '<span><kbd>C</kbd></span><span>Recalibrate</span>'
    '<span><kbd>M</kbd></span><span>Switch mode</span>'
    '<span><kbd>Esc</kbd></span><span>Leave present mode</span></div>'
)


def state_json() -> str:
    doc, cam = ss.doc, ss.cam
    if not cam.get("running"):
        hand_state = "off"
    elif cam.get("paused"):
        hand_state = "paused"
    elif not ss.hand:
        hand_state = "none"
    else:
        hand_state = "locked" if ss.hud.get("locked") else "on"
    state = {
        "ack": ss.last_seq or 0, "loaded": doc is not None, "mode": ss.mode, "index": ss.index,
        "event": ss.event, "scroll": ss.scroll, "goto": ss.goto,
        "zoom_preview": ss.zoom_preview, "zoom_pct": round(ss.pinch["target"] * 100) if ss.pinch else None,
        "pose": ss.pose, "laser": ss.set_laser, "hud": ss.hud, "show_video": ss.set_video,
        "mirror": ss.set_mirror, "skeleton": ss.set_skeleton, "hand_state": hand_state,
        "page_label": f"{ss.index + 1:02d} / {doc.count:02d}" if doc is not None and doc.kind != "html" else "",
    }
    return f'<div class="hp-state">{html.escape(json.dumps(state))}</div>'


# ------------------------------------------------------------------ page

def main() -> None:
    init_state()
    st.markdown(theme.global_css(), unsafe_allow_html=True)
    st.markdown(theme.background_html(), unsafe_allow_html=True)
    topbar = st.empty()
    left, right = st.columns([3.1, 1.2], gap="medium")

    # The camera panel runs first so a gesture is applied before the slide is drawn in this rerun.
    with right:
        head = st.empty()
        handle_frame(hand_camera())
        cam = ss.cam
        pill = ("paused", "PAUSED") if cam.get("paused") else ("live", "LIVE") if cam.get("running") else ("", "OFFLINE")
        head.markdown(head_html("// HAND TRACKING", f'<span class="hp-pill {pill[0]}">{pill[1]}</span>'),
                      unsafe_allow_html=True)
        st.markdown(readout_html() + stats_html(), unsafe_allow_html=True)
        st.button("◎ Recalibrate", on_click=recalibrate, width="stretch")
        with st.expander("// CONTROL MATRIX"):
            st.slider("Sensitivity", 0, 100, key="set_sens")
            st.slider("Smoothing", 0, 85, key="set_smooth")
            st.slider("Cooldown (ms)", 200, 1500, step=50, key="set_cool")
            st.selectbox("Zoom gesture", list(ZOOM_MODES), key="set_zoom")
            st.toggle("One page change per hand appearance", key="set_once")
            st.toggle("Point finger left / right = prev / next", key="set_point")
            st.toggle("Laser pointer (point finger up)", key="set_laser")
            st.toggle("Up / Down changes slides in Slide Mode", key="set_updown")
            st.toggle("Show camera image (off = hand signal only)", key="set_video")
            st.toggle("Mirror camera (selfie view)", key="set_mirror")
            st.toggle("Show hand skeleton", key="set_skeleton")
        st.markdown(head_html("// DATA STREAM") + log_html() + head_html("// KEYBOARD") + KEYS_HTML,
                    unsafe_allow_html=True)

    with left:
        name = html.escape(ss.doc.name) if ss.doc else "NO FILE LOADED"
        st.markdown(head_html("// PRESENTATION VIEWER", f'<span style="color:#c8ffd9">{name}</span>'),
                    unsafe_allow_html=True)
        files = st.file_uploader("Add your file", type=documents.ALL_TYPES, accept_multiple_files=True,
                                 key=f"upl{ss.upl_nonce}", label_visibility="collapsed")
        handle_upload(files)
        doc = ss.doc
        loaded = doc is not None
        paged = loaded and doc.kind != "html"
        cols = st.columns([1, 1, 0.55, 0.75, 0.55, 0.7, 1.9, 1.3, 0.55], vertical_alignment="center")
        cols[0].button("◀ Prev", on_click=navigate, args=(-1,), disabled=not paged or ss.index == 0, width="stretch")
        cols[1].button("Next ▶", on_click=navigate, args=(1,), disabled=not paged or ss.index >= doc.count - 1,
                       width="stretch")
        cols[2].button("−", on_click=lambda: set_zoom(ss.zoom - 0.1), disabled=not loaded, width="stretch",
                       key="zoom_out")
        cols[3].markdown(f'<div class="hp-page-info">{round(ss.zoom * 100)}%</div>', unsafe_allow_html=True)
        cols[4].button("＋", on_click=lambda: set_zoom(ss.zoom + 0.1), disabled=not loaded, width="stretch",
                       key="zoom_in")
        cols[5].button("Fit", on_click=lambda: set_zoom(1.0), disabled=not loaded, width="stretch")
        cols[6].segmented_control("Mode", ["Slide", "Document"], key="mode_ctl", on_change=on_mode_widget,
                                  label_visibility="collapsed")
        page_info = f"PAGE {ss.index + 1:02d} / {doc.count:02d}" if paged else ("DOCUMENT" if loaded else "PAGE -- / --")
        cols[7].markdown(f'<div class="hp-page-info">{page_info}</div>', unsafe_allow_html=True)
        cols[8].button("✕", on_click=close_file, disabled=not loaded, width="stretch", help="Close file")

        st.markdown(stage_html(), unsafe_allow_html=True)
        progress = (ss.index + 1) / doc.count * 100 if paged else (100 if loaded else 0)
        led = "on" if cam.get("running") else ""
        tracking = "ON" if cam.get("running") and not cam.get("paused") else "OFF"
        st.markdown(
            f'<div class="hp-progress"><div style="width:{progress:.1f}%"></div></div>'
            f'<div class="hp-status"><span class="led {led}"></span><span class="msg">{html.escape(ss.status)}</span>'
            f'<span class="right">MODE: {ss.mode.upper()} · TRACKING: {tracking} · {page_info}</span></div>'
            + state_json(), unsafe_allow_html=True)

    chip = f"CAM {cam.get('fps', '--') if cam.get('running') else '--'} · AI {cam.get('ai', '--') if cam.get('running') else '--'}"
    topbar.markdown(theme.topbar_html(chip), unsafe_allow_html=True)


main()
