# AI Hand Detection Presentation

Control PDFs, PowerPoint decks, Word documents and images by moving your hand in front of a webcam.
Swipe, point or pinch. No clicker, no cloud upload, no API keys. Written in **Python** with
**Streamlit**, and ready for Streamlit Community Cloud.

## Run it on your PC

Double-click **`run_windows.bat`** (it installs the packages on first run), or:

```bat
python -m pip install -r requirements.txt
python main.py
```

`main.py` starts the app and opens it in its own window (Edge or Chrome app mode, webcam allowed).
Closing the window stops the app. You can also run `streamlit run app.py` and open the printed URL.

## Deploy on Streamlit Community Cloud

1. Push this repository to GitHub.
2. Open [share.streamlit.io](https://share.streamlit.io), choose **Create app**, select the repository,
   branch `main`, main file **`app.py`**, then **Deploy**.

Cloud installs `requirements.txt` (Python packages) and `packages.txt` (LibreOffice, used to convert
PowerPoint and Word files to PDF on the server). The visitor's browser asks for camera permission once.
No WebRTC/TURN server is needed: the camera runs in the visitor's browser and only hand points
(never video) are sent to the app.

## How to use

1. **Add your file**: drop it on the upload box. Several images become a slideshow.
2. **Start camera**: press ▶ START CAMERA in the Hand Tracking panel.
3. **Hold your hand still** for a moment. The app calibrates (`READY`).
4. **Gesture**, or press **⛶ PRESENT** (key `P`) for full-screen slides.

| Gesture | Slide Mode (animation) | Document Mode |
|---|---|---|
| Swipe right / left | Next / previous slide (3D page flip) | Pan right / left |
| Swipe down / up | Next / previous slide (rolls in) | Scroll down / up |
| ☛ Point index finger right / left | Next / previous slide | Next / previous page |
| 🤏 Pinch thumb + index, move up / down | Live zoom in / out (open fingers to finish) | Live zoom |
| ☝ Point index finger up | Red laser pointer on the slide | Laser pointer |
| ✋ Hand still | No action | No action |

**One page change per hand appearance** (on by default): after a page changes, nothing else fires
until your hand leaves the camera view and comes back. The panel shows `DONE · LOWER HAND` while it
waits. A hand that is just entering the view never triggers an action.

**Present mode** (`P` or ⛶ PRESENT): the slide fills the screen, the camera image is never shown,
and a big arrow plus a small corner HUD (hand status, page number) confirm each gesture. `Esc` exits.

**Privacy**: by default the camera panel shows a green grid with the hand skeleton, not your face.
Turn on "Show camera image" in the Control Matrix to see the video.

### Keyboard

`←` `→` page · `↑` `↓` scroll / slide · `+` `−` zoom · `0` fit · `P` present · `Space` pause tracking ·
`C` recalibrate · `M` switch Slide/Document mode · `Esc` leave present mode

## Settings (Control Matrix)

Sensitivity, smoothing, cooldown, zoom gesture (pinch / hand closer-farther / off), one action per hand
appearance, finger pointing, laser pointer, up/down slide changes, camera image, mirror and skeleton.

## Supported files

| File | How it opens |
|---|---|
| PDF | Directly (PyMuPDF) |
| PNG, JPG, JPEG, BMP, WEBP, GIF | Directly; several images make a slideshow |
| PPTX, PPT, PPSX, PPS, ODP | Converted to PDF with LibreOffice (Cloud) or PowerPoint/LibreOffice (Windows) |
| DOCX, DOC, ODT, RTF | Converted to PDF the same way; DOCX falls back to a built-in reader |
| Gamma | Export from Gamma as PDF or PowerPoint, then open it |

## How it works

| Part | File | Language |
|---|---|---|
| Streamlit app: layout, navigation, zoom, modes, settings, log | `app.py` | Python |
| Gesture engine: swipes, pointing, pinch zoom, laser, one action per appearance | `hand_presenter/gestures.py` | Python |
| Documents: PDF/image rendering, PowerPoint/Word to PDF conversion | `hand_presenter/documents.py` | Python |
| Theme: holographic CSS, binary rain, CSS-3D dotted globe built from a world map | `hand_presenter/theme.py`, `worldmask.py` | Python |
| Browser camera bridge: webcam + MediaPipe hand points, visual effects | `hand_presenter/camera.py` | Python (embedded browser script) |
| Desktop launcher | `main.py`, `run_windows.bat` | Python |
| Tests | `tests/` | Python |

The browser finds the 21 hand points with MediaPipe and sends them to Python about 9 times a second.
Python makes every decision and answers through a hidden state element. The hand model files are in
`static/mediapipe` (served by the app, with the public CDN as a fallback).

Run the tests:

```bat
python -m unittest discover -s tests -t .
```

## Troubleshooting

- **Camera is busy**: close Zoom, Teams, the Windows Camera app or other tabs using the webcam.
- **Camera blocked**: allow the camera in the address bar; on Windows also check Settings → Privacy → Camera.
- **Jumpy tracking**: add light in front of you, raise Smoothing, or press `C` to recalibrate.
- **Too many actions**: lower Sensitivity or raise Cooldown.

The original Tkinter prototype is kept in `legacy/main_tkinter_v1.py` for reference.
