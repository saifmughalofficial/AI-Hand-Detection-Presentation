"""
AI Hand Detection Presentation — Complete Mock MVP
=================================================
Desktop prototype with:
- Local PDF and image file opening
- Live webcam preview and MediaPipe hand landmarks
- Natural LEFT/RIGHT/UP/DOWN hand movement detection
- Slide Mode and Document Mode
- PDF page navigation, document scrolling, zoom, pause/resume, recalibration
- Keyboard and on-screen fallback controls

Install: python -m pip install -r requirements.txt
Run:     python main.py

Note: PPTX/DOCX can be supported by converting them to PDF with LibreOffice
installed separately. This MVP opens PDF, PNG, JPG, JPEG, and BMP directly.
"""

import os
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from collections import deque

try:
    import cv2
    import mediapipe as mp
    import fitz
    from PIL import Image, ImageTk
except ImportError as exc:
    raise SystemExit(
        "Missing dependency. Run: python -m pip install -r requirements.txt\n"
        f"Details: {exc}"
    )

APP_TITLE = "AI Hand Detection Presentation"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp"}
PDF_EXTENSION = ".pdf"


class MovementTracker:
    def __init__(self):
        self.points = deque(maxlen=5)
        self.origin = None
        self.last_trigger = 0.0
        self.threshold = 0.075
        self.cooldown = 0.70

    def reset(self):
        self.points.clear()
        self.origin = None

    def update(self, point):
        self.points.append(point)
        if self.origin is None:
            self.origin = point
            return "READY"
        x = sum(p[0] for p in self.points) / len(self.points)
        y = sum(p[1] for p in self.points) / len(self.points)
        dx, dy = x - self.origin[0], y - self.origin[1]
        if max(abs(dx), abs(dy)) < self.threshold:
            return "STILL"
        if time.time() - self.last_trigger < self.cooldown:
            return "MOVING"
        if abs(dx) >= abs(dy):
            action = "RIGHT" if dx > 0 else "LEFT"
        else:
            action = "DOWN" if dy > 0 else "UP"
        self.last_trigger = time.time()
        self.origin = (x, y)
        self.points.clear()
        self.points.append((x, y))
        return action


class HandPresentationApp:
    def __init__(self, root):
        self.root = root
        self.root.title(APP_TITLE)
        self.root.geometry("1180x760")
        self.root.minsize(900, 620)
        self.root.configure(bg="#eef2f7")

        self.file_path = None
        self.pdf_doc = None
        self.page_index = 0
        self.zoom = 1.0
        self.mode = tk.StringVar(value="Slide Mode")
        self.sensitivity = tk.DoubleVar(value=0.075)
        self.tracking_enabled = False
        self.camera_running = False
        self.camera = None
        self.camera_thread = None
        self.latest_camera_image = None
        self.latest_camera_photo = None
        self.tracker = MovementTracker()
        self.status = tk.StringVar(value="Choose a PDF or image to begin.")
        self.movement = tk.StringVar(value="Waiting")
        self.page_text = tk.StringVar(value="No file loaded")
        self._build_ui()
        self.root.bind("<Left>", lambda e: self.navigate(-1))
        self.root.bind("<Right>", lambda e: self.navigate(1))
        self.root.bind("<Up>", lambda e: self.scroll_document(-1))
        self.root.bind("<Down>", lambda e: self.scroll_document(1))
        self.root.bind("<plus>", lambda e: self.change_zoom(0.1))
        self.root.bind("<equal>", lambda e: self.change_zoom(0.1))
        self.root.bind("<minus>", lambda e: self.change_zoom(-0.1))
        self.root.bind("<space>", lambda e: self.toggle_tracking())
        self.root.bind("<Escape>", lambda e: self.stop_camera())
        self.root.protocol("WM_DELETE_WINDOW", self.close_app)
        self.root.after(100, self.refresh_camera_preview)

    def _build_ui(self):
        header = tk.Frame(self.root, bg="#142b4a", height=76)
        header.pack(fill="x")
        tk.Label(header, text="AI HAND DETECTION PRESENTATION",
                 font=("Segoe UI", 18, "bold"), fg="white", bg="#142b4a").pack(
                     side="left", padx=22, pady=18)
        tk.Label(header, text="LOCAL • FREE • WEBCAM CONTROL",
                 font=("Segoe UI", 9, "bold"), fg="#a8d9ff", bg="#142b4a").pack(
                     side="right", padx=22)

        toolbar = tk.Frame(self.root, bg="#ffffff", padx=12, pady=10)
        toolbar.pack(fill="x")
        self._button(toolbar, "＋ Open File", self.open_file, "#1769aa").pack(side="left", padx=4)
        self._button(toolbar, "◀ Previous", lambda: self.navigate(-1)).pack(side="left", padx=4)
        self._button(toolbar, "Next ▶", lambda: self.navigate(1)).pack(side="left", padx=4)
        self._button(toolbar, "− Zoom", lambda: self.change_zoom(-0.1)).pack(side="left", padx=4)
        self._button(toolbar, "＋ Zoom", lambda: self.change_zoom(0.1)).pack(side="left", padx=4)
        ttk.Label(toolbar, text="Mode:").pack(side="left", padx=(18, 4))
        mode_box = ttk.Combobox(toolbar, textvariable=self.mode, state="readonly",
                                values=["Slide Mode", "Document Mode"], width=16)
        mode_box.pack(side="left")
        mode_box.bind("<<ComboboxSelected>>", lambda e: self.update_status())

        body = tk.Frame(self.root, bg="#eef2f7", padx=12, pady=12)
        body.pack(fill="both", expand=True)
        left = tk.Frame(body, bg="#ffffff", bd=0, highlightthickness=1,
                        highlightbackground="#d6deea")
        left.pack(side="left", fill="both", expand=True, padx=(0, 10))
        tk.Label(left, text="PRESENTATION / DOCUMENT VIEWER",
                 font=("Segoe UI", 10, "bold"), bg="#ffffff", fg="#52647a").pack(
                     anchor="w", padx=14, pady=(12, 4))
        self.viewer = tk.Canvas(left, bg="#dfe7f0", highlightthickness=0)
        self.viewer.pack(fill="both", expand=True, padx=12, pady=10)
        self.viewer.bind("<Configure>", lambda e: self.render_page())

        right = tk.Frame(body, bg="#ffffff", width=300, highlightthickness=1,
                         highlightbackground="#d6deea")
        right.pack(side="right", fill="y")
        right.pack_propagate(False)
        tk.Label(right, text="HAND TRACKING", font=("Segoe UI", 12, "bold"),
                 bg="#ffffff", fg="#142b4a").pack(anchor="w", padx=14, pady=(14, 4))
        self.camera_label = tk.Label(right, text="Camera is off", bg="#101820",
                                     fg="#dce7f2", width=32, height=10)
        self.camera_label.pack(fill="x", padx=12, pady=8)
        tk.Label(right, text="Movement", font=("Segoe UI", 9, "bold"),
                 bg="#ffffff", fg="#65758b").pack(anchor="w", padx=14, pady=(8, 0))
        tk.Label(right, textvariable=self.movement, font=("Segoe UI", 17, "bold"),
                 bg="#ffffff", fg="#087e8b").pack(anchor="w", padx=14)
        tk.Label(right, text="Sensitivity", font=("Segoe UI", 9, "bold"),
                 bg="#ffffff", fg="#65758b").pack(anchor="w", padx=14, pady=(12, 0))
        ttk.Scale(right, from_=0.035, to=0.16, variable=self.sensitivity,
                  command=self.change_sensitivity).pack(fill="x", padx=14, pady=5)
        self._button(right, "▶ Start Camera", self.start_camera, "#087e8b").pack(
            fill="x", padx=12, pady=(10, 4))
        self._button(right, "Ⅱ Pause / Resume", self.toggle_tracking).pack(
            fill="x", padx=12, pady=4)
        self._button(right, "◎ Recalibrate", self.recalibrate).pack(
            fill="x", padx=12, pady=4)
        self._button(right, "■ Stop Camera", self.stop_camera, "#9d3545").pack(
            fill="x", padx=12, pady=4)
        tk.Label(right, text="KEYBOARD SHORTCUTS", font=("Segoe UI", 9, "bold"),
                 bg="#ffffff", fg="#65758b").pack(anchor="w", padx=14, pady=(15, 4))
        tk.Label(right, text="← / →  Page or slide\n↑ / ↓  Scroll document\n+ / −  Zoom\nSPACE  Pause tracking\nESC  Stop camera",
                 justify="left", bg="#ffffff", fg="#52647a",
                 font=("Consolas", 9)).pack(anchor="w", padx=14, pady=(0, 12))

        footer = tk.Frame(self.root, bg="#142b4a", padx=14, pady=9)
        footer.pack(fill="x")
        tk.Label(footer, textvariable=self.status, bg="#142b4a",
                 fg="white", anchor="w").pack(side="left", fill="x", expand=True)
        tk.Label(footer, textvariable=self.page_text, bg="#142b4a",
                 fg="#a8d9ff").pack(side="right")

    def _button(self, parent, text, command, color="#e8eef5"):
        fg = "white" if color not in ("#e8eef5",) else "#24364b"
        return tk.Button(parent, text=text, command=command, font=("Segoe UI", 9, "bold"),
                         bg=color, fg=fg, activebackground="#c7d8ea",
                         activeforeground="#142b4a", relief="flat", padx=10, pady=7,
                         cursor="hand2")

    def open_file(self):
        path = filedialog.askopenfilename(
            title="Choose a presentation or document",
            filetypes=[("Supported files", "*.pdf *.png *.jpg *.jpeg *.bmp"),
                       ("PDF files", "*.pdf"), ("Image files", "*.png *.jpg *.jpeg *.bmp")]
        )
        if not path:
            return
        try:
            if self.pdf_doc:
                self.pdf_doc.close()
                self.pdf_doc = None
            self.file_path = path
            self.page_index = 0
            self.zoom = 1.0
            if os.path.splitext(path)[1].lower() == PDF_EXTENSION:
                self.pdf_doc = fitz.open(path)
            elif os.path.splitext(path)[1].lower() not in IMAGE_EXTENSIONS:
                raise ValueError("This mock currently supports PDF and image files.")
            self.render_page()
            self.update_status(f"Loaded: {os.path.basename(path)}")
        except Exception as exc:
            messagebox.showerror("Could not open file", str(exc))

    def render_page(self):
        if not hasattr(self, "viewer"):
            return
        self.viewer.delete("all")
        width = max(self.viewer.winfo_width(), 400)
        height = max(self.viewer.winfo_height(), 300)
        if not self.file_path:
            self.viewer.create_text(width // 2, height // 2,
                text="OPEN A PDF OR IMAGE\n\nThen start the webcam and move your hand.",
                fill="#60758d", font=("Segoe UI", 18, "bold"), justify="center")
            self.page_text.set("No file loaded")
            return
        try:
            if self.pdf_doc is not None:
                page = self.pdf_doc[self.page_index]
                pix = page.get_pixmap(matrix=fitz.Matrix(1.5 * self.zoom, 1.5 * self.zoom),
                                      alpha=False)
                image = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                self.page_text.set(f"Page {self.page_index + 1} / {len(self.pdf_doc)}")
            else:
                image = Image.open(self.file_path).convert("RGB")
                self.page_text.set("Image 1 / 1")
            image.thumbnail((max(100, width - 35), max(100, height - 35)))
            self.page_photo = ImageTk.PhotoImage(image)
            self.viewer.create_image(width // 2, height // 2, image=self.page_photo,
                                     anchor="center")
        except Exception as exc:
            self.viewer.create_text(width // 2, height // 2, text=f"Preview error:\n{exc}",
                                    fill="#9d3545")

    def navigate(self, direction):
        if self.pdf_doc is None:
            self.update_status("Open a PDF to use page navigation.")
            return
        self.page_index = max(0, min(len(self.pdf_doc) - 1, self.page_index + direction))
        self.render_page()
        self.update_status("Next page" if direction > 0 else "Previous page")

    def scroll_document(self, direction):
        if self.mode.get() == "Document Mode":
            self.viewer.yview_scroll(direction * 3, "units")
            self.update_status("Document scroll command")
        elif self.pdf_doc is not None:
            self.navigate(1 if direction > 0 else -1)

    def change_zoom(self, amount):
        self.zoom = max(0.4, min(2.5, self.zoom + amount))
        self.render_page()
        self.update_status(f"Zoom: {int(self.zoom * 100)}%")

    def change_sensitivity(self, value):
        self.tracker.threshold = float(value)

    def start_camera(self):
        if self.camera_running:
            self.update_status("Camera is already running.")
            return
        self.camera = cv2.VideoCapture(0)
        if not self.camera.isOpened():
            self.camera.release()
            self.camera = None
            messagebox.showerror("Camera error", "Could not open webcam. Close other camera apps and try again.")
            return
        self.camera_running = True
        self.tracking_enabled = True
        self.tracker.reset()
        self.camera_thread = threading.Thread(target=self.camera_loop, daemon=True)
        self.camera_thread.start()
        self.update_status("Camera started. Hold your hand still briefly to calibrate.")

    def camera_loop(self):
        mp_hands = mp.solutions.hands
        mp_draw = mp.solutions.drawing_utils
        with mp_hands.Hands(max_num_hands=1, model_complexity=0,
                            min_detection_confidence=0.55,
                            min_tracking_confidence=0.55) as hands:
            while self.camera_running and self.camera is not None:
                ok, frame = self.camera.read()
                if not ok:
                    time.sleep(0.03)
                    continue
                frame = cv2.flip(frame, 1)
                if self.tracking_enabled:
                    result = hands.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                    if result.multi_hand_landmarks:
                        hand = result.multi_hand_landmarks[0]
                        mp_draw.draw_landmarks(frame, hand, mp_hands.HAND_CONNECTIONS)
                        wrist = hand.landmark[0]
                        action = self.tracker.update((wrist.x, wrist.y))
                        self.root.after(0, self.handle_movement, action)
                    else:
                        self.root.after(0, self.set_movement, "No hand detected")
                else:
                    cv2.putText(frame, "TRACKING PAUSED", (15, 30),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 180, 255), 2)
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                self.latest_camera_image = Image.fromarray(rgb)
                time.sleep(0.015)

    def refresh_camera_preview(self):
        if self.latest_camera_image is not None:
            img = self.latest_camera_image.copy()
            img.thumbnail((270, 190))
            self.latest_camera_photo = ImageTk.PhotoImage(img)
            self.camera_label.configure(image=self.latest_camera_photo, text="")
        elif not self.camera_running:
            self.camera_label.configure(image="", text="Camera is off")
        self.root.after(80, self.refresh_camera_preview)

    def handle_movement(self, action):
        self.set_movement(action)
        if not self.tracking_enabled:
            return
        if action == "LEFT":
            if self.mode.get() == "Slide Mode":
                self.navigate(-1)
            else:
                self.viewer.xview_scroll(-3, "units")
                self.update_status("Hand moved left → Pan left")
        elif action == "RIGHT":
            if self.mode.get() == "Slide Mode":
                self.navigate(1)
            else:
                self.viewer.xview_scroll(3, "units")
                self.update_status("Hand moved right → Pan right")
        elif action == "UP":
            if self.mode.get() == "Document Mode":
                self.scroll_document(-1)
            else:
                self.update_status("Hand moved up")
        elif action == "DOWN":
            if self.mode.get() == "Document Mode":
                self.scroll_document(1)
            else:
                self.update_status("Hand moved down")

    def set_movement(self, value):
        self.movement.set(value)

    def toggle_tracking(self):
        if not self.camera_running:
            self.update_status("Start the camera first.")
            return
        self.tracking_enabled = not self.tracking_enabled
        self.update_status("Tracking resumed." if self.tracking_enabled else "Tracking paused.")

    def recalibrate(self):
        self.tracker.reset()
        self.update_status("Recalibrating: keep your hand still briefly.")

    def stop_camera(self):
        self.camera_running = False
        self.tracking_enabled = False
        if self.camera is not None:
            self.camera.release()
            self.camera = None
        self.latest_camera_image = None
        self.camera_label.configure(image="", text="Camera is off")
        self.update_status("Camera stopped.")

    def update_status(self, message=None):
        if message:
            self.status.set(message)
        else:
            self.status.set(f"Mode: {self.mode.get()} • Tracking: {'On' if self.tracking_enabled else 'Off'}")

    def close_app(self):
        self.stop_camera()
        if self.pdf_doc:
            self.pdf_doc.close()
        self.root.destroy()


def main():
    root = tk.Tk()
    app = HandPresentationApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
