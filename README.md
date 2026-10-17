# AI Hand Detection Presentation (Holographic Edition)

Control PDFs, PowerPoint decks, Word documents and images by moving your hand in front of a webcam.
No hand poses, no clicker, no cloud. **100% free and local**: no API keys, no accounts, and it works offline.

## Run it

Double-click **`run_windows.bat`**, or run:

```bat
python main.py
```

The app opens in its own window (Microsoft Edge or Chrome in app mode). Closing the window ends the program.
Python 3.8+ is the only requirement. **No `pip install` is needed**: `main.py` uses only the standard library,
and all libraries and the AI model are bundled in `web/vendor`.

Options: `python main.py --port 9000`, or `python main.py --no-window` to print the URL and open it yourself.

## How to use

1. **Add your file**: click *ADD YOUR FILE* or drag and drop a file anywhere.
2. **Start camera**: press *START CAMERA*.
3. **Hold still** for a moment. The app calibrates a neutral hand position (state `READY`).
4. **Move your hand** to control the content.

| Hand movement | Slide Mode (animation) | Document Mode |
|---|---|---|
| Left | Previous slide (3D page flip) | Pan left |
| Right | Next slide (3D page flip) | Pan right |
| Up | Previous slide (rolls down from above) | Scroll up |
| Down | Next slide (rolls up from below) | Scroll down |
| Pinch + move up / down | Live zoom in / out | Live zoom in / out |
| Still | No action | No action |

### Finger gestures

| Finger pose | Action |
|---|---|
| ☛ Index finger pointing **right** (other fingers folded) | Next slide / page |
| ☚ Index finger pointing **left** | Previous slide / page |
| 🤏 Pinch thumb + index, then move hand **up / down** | Smooth live zoom in / out (open fingers to finish) |
| ☝ Index finger pointing **up** | Red laser pointer on the slide |

### One page change per hand appearance (on by default)

After a slide or page changes, nothing else fires until your hand **leaves the camera view and comes
back**. This prevents accidental double moves while you talk. The corner HUD shows `DONE · LOWER HAND`
while waiting. Zoom and the laser pointer still work during that time. Turn this off in the Control
Matrix if you prefer continuous swiping. A hand that is just entering the camera view never triggers
an action: the app waits until it is steady.

### Present mode (`P` or the ▶ PRESENT button)

Full-screen slides with hand control and **no camera image on screen**. Your face is never shown; only
the hand signal is used. A big arrow flashes for each gesture, and a small corner HUD shows the hand
status and page number. The 3D background pauses while presenting so detection gets the full GPU and CPU.
Press `Esc` to exit.

By default the sidebar camera panel shows a privacy grid with the hand skeleton instead of your face
("Show camera image" turns the video back on).

One swipe gives exactly one action. Moving your hand back to the centre does **not** trigger the opposite
command. The dashed square in the camera preview shows the dead zone; it turns amber while re-arming.

### Keyboard

`←` `→` page · `↑` `↓` scroll · `+` `−` zoom · `0` fit · `Space` pause tracking · `C` recalibrate ·
`M` switch mode · `F` fullscreen presenter · `O` open file · `Esc` stop camera ·
`Ctrl + mouse wheel` zoom · mouse wheel turns slides in Slide Mode.

### Fullscreen presenter

Press `F`. The slide fills the screen and a small live camera window stays in the corner. Move the mouse to
the top edge to show the toolbar.

## Supported files

| File | How it opens |
|---|---|
| PDF | Directly (PDF.js) |
| PNG, JPG, JPEG, BMP, WEBP, GIF | Directly. Select several images to make a slideshow. |
| PPTX, PPT, PPSX, ODP | Converted to PDF on this PC with Microsoft PowerPoint or LibreOffice |
| DOCX, DOC, ODT, RTF | Converted to PDF on this PC with Microsoft Word or LibreOffice. DOCX falls back to a built-in reader if neither is installed. |
| Gamma | Export from Gamma as PDF or PowerPoint, then open the export |

Office macros are force-disabled during conversion, and Office windows you already have open are never closed.
Without Microsoft Office, install the free [LibreOffice](https://www.libreoffice.org) for exact PPTX/DOCX pages.

## Settings (Control Matrix)

- **Sensitivity**: how far the hand must move to trigger an action.
- **Smoothing**: removes jitter (higher is steadier but slower).
- **Cooldown**: minimum time between two actions.
- **Camera / Resolution / Frame rate**: up to **60 FPS** is requested; the app uses the most your webcam supports.
- **Lock exposure for max camera FPS** (on by default): webcams slow down in indoor light (for example
  30 → 17 FPS). Locking the exposure keeps the camera at its full frame rate. If the room is too dark,
  the app switches back to auto exposure by itself.
- **Zoom gesture**: off, hand closer/farther, or pinch.
- **3D effects**: Auto keeps the interface at 60 FPS and lowers effects only if the PC struggles.
  Use Low or Off on battery.

Settings are remembered between sessions.

## Performance notes (measured on this PC: i5-8250U, Intel UHD 620)

- Interface and 3D scene: **~60 FPS**.
- Camera: the built-in webcam's hardware maximum is **30 FPS**; with exposure lock the app gets the full 30.
  A 60 FPS USB webcam runs at 60 automatically.
- Hand AI runs on the GPU in a background thread so it never stutters the interface. It runs faster on mains
  power than on battery, because Windows slows the CPU on battery.
- Live numbers are shown in the top bar: `CAM` (camera FPS), `AI` (tracking FPS) and `FX` (3D FPS).

## Troubleshooting

- **"Camera is busy"**: close Zoom, Teams, the Windows Camera app or any other app using the webcam.
- **"Camera access is blocked"**: Windows Settings → Privacy → Camera → allow desktop apps to use the camera.
- **Tracking is jumpy**: add light in front of you, raise Smoothing, or press `C` to recalibrate.
- **Actions trigger too easily**: lower Sensitivity or raise Cooldown.

## Privacy

The server listens on `127.0.0.1` only and rejects requests from other websites. Camera frames are processed
inside the app window and are never saved or uploaded. Converted files live in a temporary folder that is
deleted right after conversion.

## Project layout

```
main.py                 launcher + local server + Office→PDF converter (stdlib only)
run_windows.bat         double-click launcher
web/index.html          interface
web/css/style.css       holographic HUD theme
web/js/app.js           application controller
web/js/hand.js          webcam capture, gesture engine, camera overlay
web/js/hand-worker.js   MediaPipe hand landmarks on a background thread
web/js/viewer.js        PDF/image/document viewer with 3D slide transitions
web/js/scene3d.js       Three.js holographic scene (globe, arcs, skyline, binary streams)
web/js/matrix.js        binary rain background
web/vendor/             bundled libraries: Three.js, PDF.js, MediaPipe Tasks + model, mammoth, fonts
legacy/                 the original Tkinter prototype (kept for reference)
```

The original Tkinter prototype is in `legacy/main_tkinter_v1.py`. Its camera failed because MediaPipe 1.x
removed the `mp.solutions` API that it relied on.
