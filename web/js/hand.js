// Webcam capture (up to 60 FPS), MediaPipe hand landmarks and natural movement detection.

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11],
  [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
const PALM = [0, 5, 9, 13, 17];
const FINGER_TIPS = new Set([4, 8, 12, 16, 20]);
const MISSES_BEFORE_LOST = 3;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Turns hand landmarks into presentation actions:
 *  - Swipes: LEFT/RIGHT/UP/DOWN palm movement past a dead zone around a calibrated neutral point.
 *    The return stroke never fires the opposite command.
 *  - Finger poses: index pointing left/right (POINT_LEFT/POINT_RIGHT), index pointing up (laser),
 *    and thumb+index pinch moved up/down (continuous zoom).
 *  - "One action per appearance": after a page action, nothing fires until the hand leaves the
 *    camera view and comes back.
 */
export class GestureController {
  constructor() {
    this.threshold = 0.07;
    this.smoothing = 0.25;
    this.cooldownMs = 450;
    this.stableFrames = 3;
    this.settleMs = 700;
    this.zoomMode = "pinch";
    this.pointing = true;
    this.laser = true;
    this.oncePerAppearance = true;
    this.unlockMs = 350;
    this.pointHoldMs = 160;
    this.pinchHoldMs = 120;
    this.reset();
  }

  /** Full reset: recalibrate, pause/resume, camera start. */
  reset() {
    this.locked = false;
    this.goneAt = null;
    this.lastTrigger = -Infinity;
    this._resetTracking();
  }

  _resetTracking() {
    this.origin = null;
    this.point = null;
    this.size = null;
    this.prevRaw = null;
    this.seen = 0;
    this.armed = true;
    this.zoomBase = null;
    this.zoomArmed = true;
    this.anchor = null;
    this.anchorTime = 0;
    this.pose = "open";
    this.poseSince = 0;
    this.poseFired = false;
    this.candidate = null;
    this.candidateCount = 0;
    this.pinchZoom = null;
  }

  /** Hand left the camera view. Keeps the lock; it is released once the hand stays away long enough. */
  lost(now) {
    if (this.goneAt === null) this.goneAt = now;
    const zoom = this.pinchZoom ? { phase: "end", factor: this.pinchZoom.factor } : null;
    this._resetTracking();
    return { state: "NO HAND", zoom };
  }

  hud() {
    return {
      origin: this.origin, point: this.point, threshold: this.threshold,
      armed: this.armed && !this.locked, pose: this.pose, locked: this.locked,
    };
  }

  _markAnchor(now) {
    this.anchor = { ...this.point };
    this.anchorTime = now;
  }

  update(palm, size, pose, now) {
    if (this.goneAt !== null) {
      if (now - this.goneAt >= this.unlockMs) this.locked = false;
      this.goneAt = null;
    }
    const jump = this.prevRaw ? dist(palm, this.prevRaw) : 0;
    this.prevRaw = { ...palm };
    const a = 1 - this.smoothing;
    if (this.point) {
      this.point = { x: this.point.x + (palm.x - this.point.x) * a, y: this.point.y + (palm.y - this.point.y) * a };
      this.size += (size - this.size) * a;
    } else {
      this.point = { ...palm };
      this.size = size;
    }
    if (!this.origin) {
      // Calibrate only once the hand is calm, so a hand entering the frame never fires a swipe.
      this.seen = jump > this.threshold * 0.35 ? 0 : this.seen + 1;
      if (this.seen < this.stableFrames) return { state: "LOCKING" };
      this.origin = { ...this.point };
      this.zoomBase = { size: this.size };
      this._markAnchor(now);
      return { state: this.locked ? "LOCKED" : "READY" };
    }

    const posed = this._poses(pose, now);
    if (posed) return posed;

    if (dist(this.point, this.anchor) > this.threshold * 0.35) this._markAnchor(now);
    const settled = now - this.anchorTime > this.settleMs;
    const dx = this.point.x - this.origin.x;
    const dy = this.point.y - this.origin.y;
    const offset = Math.max(Math.abs(dx), Math.abs(dy));

    if (!this.armed) {
      if (settled) {
        this.origin = { ...this.point };
        this.zoomBase = { size: this.size };
      }
      if (settled || offset < this.threshold * 0.6) {
        this.armed = true;
        return { state: this.locked ? "LOCKED" : "READY" };
      }
      return { state: "RE-ARM" };
    }

    const zoom = this.zoomMode === "depth" && offset < this.threshold * 0.5 ? this._depthZoom(now, settled) : null;
    if (zoom) return zoom;

    if (offset < this.threshold) {
      if (settled) this.origin = { ...this.point };
      return { state: this.locked ? "LOCKED" : "STILL" };
    }
    if (this.oncePerAppearance && this.locked) {
      this.origin = { ...this.point }; // nothing accumulates while waiting for the hand to leave
      return { state: "LOCKED" };
    }
    if (now - this.lastTrigger < this.cooldownMs) return { state: "COOLDOWN" };

    const action = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "RIGHT" : "LEFT") : (dy > 0 ? "DOWN" : "UP");
    this.lastTrigger = now;
    this.armed = false;
    if (this.oncePerAppearance) this.locked = true;
    this._markAnchor(now);
    return { state: action, action };
  }

  _classify(f) {
    if (!f) return "open";
    if (!f.indexCurled && f.pinch < (this.pose === "pinch" ? 0.45 : 0.3)) return "pinch";
    if (f.indexExt && f.othersCurled && f.pinch > 0.4) {
      const ax = Math.abs(f.vx);
      const ay = Math.abs(f.vy);
      if (ax > ay * 1.3) return f.vx > 0 ? "point-right" : "point-left";
      if (-f.vy > ax * 1.3) return "laser";
    }
    return "open";
  }

  _poses(f, now) {
    const name = this._classify(f);
    if (name !== this.pose) {
      // A pose must be seen on two consecutive frames before it counts (filters landmark flicker).
      if (name === this.candidate) this.candidateCount++;
      else {
        this.candidate = name;
        this.candidateCount = 1;
      }
      if (this.candidateCount >= 2) {
        const ended = this._endPose(now);
        this.pose = name;
        this.poseSince = now;
        this.poseFired = false;
        this.candidate = null;
        if (ended) return ended;
      }
    } else {
      this.candidate = null;
    }

    const held = now - this.poseSince;
    switch (this.pose) {
      case "pinch":
        if (this.zoomMode !== "pinch") return null;
        if (!this.pinchZoom) {
          if (held < this.pinchHoldMs) return { state: "PINCH" };
          this.pinchZoom = { y0: this.point.y, factor: 1 };
          return { state: "ZOOM", zoom: { phase: "start", factor: 1 } };
        }
        // Moving the pinched hand up 15% of the frame height doubles the zoom; down halves it.
        this.pinchZoom.factor = 2 ** ((this.pinchZoom.y0 - this.point.y) / 0.15);
        return { state: "ZOOM", zoom: { phase: "move", factor: this.pinchZoom.factor } };
      case "point-left":
      case "point-right": {
        if (!this.pointing) return null;
        if (this.poseFired) return { state: this.locked ? "LOCKED" : "POINT" };
        if (held < this.pointHoldMs) return { state: "POINT" };
        if (this.oncePerAppearance && this.locked) return { state: "LOCKED" };
        if (now - this.lastTrigger < this.cooldownMs) return { state: "COOLDOWN" };
        this.poseFired = true;
        this.lastTrigger = now;
        if (this.oncePerAppearance) this.locked = true;
        const action = this.pose === "point-right" ? "POINT_RIGHT" : "POINT_LEFT";
        return { state: action, action };
      }
      case "laser":
        return this.laser ? { state: "LASER", laser: f.tip } : null;
      default:
        return null;
    }
  }

  _endPose(now) {
    if (this.pose === "open") return null;
    // Re-centre the swipe origin so releasing a pose never counts as a swipe.
    this.origin = { ...this.point };
    this.armed = true;
    this.zoomBase = { size: this.size };
    this._markAnchor(now);
    if (this.pinchZoom) {
      const { factor } = this.pinchZoom;
      this.pinchZoom = null;
      return { state: "ZOOM", zoom: { phase: "end", factor } };
    }
    return null;
  }

  _depthZoom(now, settled) {
    if (!this.zoomBase) return null;
    const delta = Math.log(this.size / this.zoomBase.size); // > 0 when the hand comes closer
    const limit = 0.2;
    if (!this.zoomArmed) {
      if (Math.abs(delta) < limit * 0.4 || settled) {
        if (settled) this.zoomBase = { size: this.size };
        this.zoomArmed = true;
      }
      return null;
    }
    if (Math.abs(delta) < limit || now - this.lastTrigger < this.cooldownMs) return null;
    this.lastTrigger = now;
    this.zoomArmed = false;
    this._markAnchor(now);
    const action = delta > 0 ? "ZOOM_IN" : "ZOOM_OUT";
    return { state: action, action };
  }
}

function friendlyCameraError(err) {
  const blocked = "Camera access is blocked. Allow the camera for this app (camera icon in the address bar) " +
    "and check Windows Settings → Privacy → Camera, then press START CAMERA.";
  const busy = "The camera is busy. Close Zoom, Teams, the Windows Camera app or other camera apps, then press START CAMERA.";
  const messages = {
    NotAllowedError: blocked,
    SecurityError: blocked,
    NotFoundError: "No camera was found. Connect a webcam and press START CAMERA.",
    OverconstrainedError: "This camera does not support the selected settings. Choose another camera or resolution.",
    NotReadableError: busy,
    AbortError: busy,
  };
  return new Error(messages[err?.name] || `Camera error: ${err?.message || err}`);
}

export class HandEngine {
  constructor({ video, canvas, onResult, onStats, onEnded, onNotice }) {
    Object.assign(this, { video, canvas, onResult, onStats, onEnded, onNotice });
    this.ctx = canvas.getContext("2d");
    this.controller = new GestureController();
    this.ready = false;
    this.running = false;
    this.paused = false;
    this.lockExposure = true;
    this.exposureLocked = false;
    this.showVideo = false;
    this.previewEnabled = true;
    this.mirror = true;
    this.showSkeleton = true;
    this.pipCanvas = null;
    this.hands = [];
    this.busy = false;
    this.missed = 0;
    this.lastEvent = { state: "NO HAND" };
    this.counters = { cam: 0, ai: 0 };
    this.latency = 0;
    this.light = null;
    this.delegate = "--";
    this.engineMode = "--";
    this.trackInfo = null;
    this.lumaCanvas = document.createElement("canvas");
    this.lumaCanvas.width = 32;
    this.lumaCanvas.height = 24;
    this.lumaCtx = this.lumaCanvas.getContext("2d", { willReadFrequently: true });
    this.initPromise = null;
  }

  init() {
    this.initPromise ??= this._init().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  async _init() {
    const urls = {
      modelUrl: new URL("vendor/mediapipe/hand_landmarker.task", document.baseURI).href,
      wasmUrl: new URL("vendor/mediapipe/wasm", document.baseURI).href,
    };
    try {
      this.delegate = await this._initWorker(urls);
      this.engineMode = "WORKER";
    } catch (err) {
      console.warn("Background hand tracking unavailable, using the main thread:", err);
      this.worker?.terminate();
      this.worker = null;
      this.delegate = await this._initMain(urls);
      this.engineMode = "MAIN";
    }
    this.ready = true;
    return `${this.delegate} · ${this.engineMode === "WORKER" ? "background thread" : "main thread"}`;
  }

  _initWorker(urls) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./hand-worker.js", import.meta.url), { type: "module" });
      const fail = (err) => {
        clearTimeout(timer);
        worker.terminate();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error("Hand tracking worker timed out")), 30000);
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") {
          clearTimeout(timer);
          this.worker = worker;
          worker.onmessage = (e) => this._onWorkerMessage(e.data);
          resolve(data.delegate);
        } else if (data.type === "error") {
          fail(new Error(data.message));
        }
      };
      worker.onerror = (e) => fail(new Error(e.message || "Hand tracking worker failed"));
      worker.postMessage({ type: "init", ...urls });
    });
  }

  async _initMain(urls) {
    const { FilesetResolver, HandLandmarker } = await import("../vendor/mediapipe/vision_bundle.mjs");
    const fileset = await FilesetResolver.forVisionTasks(urls.wasmUrl);
    const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: urls.modelUrl, delegate },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.65,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await make("GPU");
      return "GPU";
    } catch {
      this.landmarker = await make("CPU");
      return "CPU";
    }
  }

  async listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "videoinput")
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  }

  async start({ deviceId, width, height, fps }) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera API unavailable. Start the app with python main.py and use Edge or Chrome.");
    }
    this.stop();
    const device = deviceId ? { deviceId: { exact: deviceId } } : {};
    const attempts = [
      { ...device, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps, max: fps } },
      { ...(deviceId ? { deviceId: { ideal: deviceId } } : {}), frameRate: { ideal: fps } },
      true,
    ];
    let stream = null;
    let lastError = null;
    for (const video of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        break;
      } catch (err) {
        lastError = err;
        if (err.name === "NotAllowedError" || err.name === "SecurityError") break;
      }
    }
    if (!stream) throw friendlyCameraError(lastError);

    this.stream = stream;
    const v = this.video;
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    await v.play();
    if (!v.videoWidth) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
    this.canvas.width = v.videoWidth;
    this.canvas.height = v.videoHeight;

    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    this.requestedFps = fps;
    this.trackInfo = {
      label: track.label || "Camera",
      width: s.width || v.videoWidth,
      height: s.height || v.videoHeight,
      fps: Math.round(s.frameRate || 0),
      maxFps: Math.round(track.getCapabilities?.().frameRate?.max || 0),
      exposureMs: await this.applyExposure().catch(() => null),
    };
    track.addEventListener("ended", () => {
      if (this.stream === stream) {
        this.stop();
        this.onEnded?.();
      }
    });

    this.running = true;
    this.paused = false;
    this.controller.reset();
    this.hands = [];
    this.missed = 0;
    this.busy = false;
    this.counters = { cam: 0, ai: 0 };
    this.lastStats = performance.now();
    this.lastVideoTime = -1;
    this.useRVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
    this._schedule();
    this.statsTimer = setInterval(() => this._emitStats(), 500);
    return this.trackInfo;
  }

  stop() {
    this.running = false;
    if (this.frameHandle != null) {
      if (this.useRVFC) this.video.cancelVideoFrameCallback(this.frameHandle);
      else cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    clearInterval(this.statsTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.hands = [];
    this.busy = false;
    this.light = null;
    this.controller.reset();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Webcam auto-exposure lengthens each frame in indoor light (a 30 FPS camera drops to ~15 FPS).
   * Locking exposure just under one frame interval keeps the sensor at its full frame rate.
   * Returns the locked exposure in ms, or null when auto exposure is in use.
   */
  async applyExposure() {
    const track = this.stream?.getVideoTracks()[0];
    this.exposureLocked = false;
    this.darkCount = 0;
    const caps = track?.getCapabilities?.() || {};
    if (!this.lockExposure) {
      if (caps.exposureMode?.includes("continuous")) {
        await track.applyConstraints({ advanced: [{ exposureMode: "continuous" }] });
      }
      return null;
    }
    if (!caps.exposureMode?.includes("manual") || !caps.exposureTime) return null;
    const fps = Math.min(this.requestedFps || 30, caps.frameRate?.max || 30);
    const { min, max, step = 1 } = caps.exposureTime;
    const target = Math.floor(((10000 / fps) * 0.94) / step) * step; // exposureTime is in 100 µs units
    const exposureTime = Math.min(max, Math.max(min, target));
    await track.applyConstraints({ advanced: [{ exposureMode: "manual", exposureTime }] });
    this.exposureLocked = true;
    return exposureTime / 10;
  }

  setPaused(paused) {
    this.paused = paused;
    this.controller.reset();
    this.hands = [];
  }

  _schedule() {
    this.frameHandle = this.useRVFC
      ? this.video.requestVideoFrameCallback(this._onFrame)
      : requestAnimationFrame(this._onFrame);
  }

  _onFrame = () => {
    if (!this.running) return;
    this._schedule();
    if (!this.useRVFC) {
      if (this.video.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = this.video.currentTime;
    }
    this.counters.cam++;
    this.frameCount = (this.frameCount || 0) + 1;
    if (this.previewEnabled || this.pipCanvas) this._drawPreview();
    if (this.paused) return;
    // While a hand is tracked, run inference back-to-back for the fastest response. While searching
    // (the heavier palm-detection step), use every other frame to leave the GPU to the 3D scene.
    const tracking = this.hands.length > 0;
    if (this.busy) this.frameWaiting = tracking;
    else if (tracking || this.frameCount % 2 === 0) this._detect();
    if (this.frameCount % 30 === 1) this._measureLight();
  };

  _detect() {
    const v = this.video;
    if (v.readyState < 2) return;
    this.busy = true;
    this.frameWaiting = false;
    this.sentAt = performance.now();
    if (this.worker) {
      const scale = Math.min(1, 640 / v.videoWidth);
      createImageBitmap(v, {
        resizeWidth: Math.round(v.videoWidth * scale),
        resizeHeight: Math.round(v.videoHeight * scale),
        resizeQuality: "low",
      })
        .then((bitmap) => this.worker.postMessage({ type: "frame", bitmap, ts: this.sentAt }, [bitmap]))
        .catch(() => { this.busy = false; });
      return;
    }
    try {
      this.lastTs = Math.max(this.sentAt, (this.lastTs || 0) + 1);
      const r = this.landmarker.detectForVideo(v, this.lastTs);
      const hands = (r.landmarks || []).map((points, i) => ({
        landmarks: points,
        handedness: r.handedness?.[i]?.[0]?.categoryName || "",
        score: r.handedness?.[i]?.[0]?.score ?? 0,
      }));
      this._handleResult(hands, performance.now() - this.sentAt);
    } catch (err) {
      console.error(err);
    } finally {
      this.busy = false;
    }
  }

  _onWorkerMessage(msg) {
    if (msg.type !== "result") return;
    this.busy = false;
    if (msg.error) console.warn("Hand tracking:", msg.error);
    this._handleResult(msg.hands, performance.now() - this.sentAt);
    // A newer camera frame arrived while the model was busy: process it now instead of
    // idling until the next frame, so inference runs back-to-back.
    if (this.frameWaiting && this.running && !this.paused) {
      this.frameWaiting = false;
      this._detect();
    }
  }

  _handleResult(hands, ms) {
    if (!this.running || this.paused) return;
    this.counters.ai++;
    this.latency = this.latency ? this.latency * 0.8 + ms * 0.2 : ms;
    const now = performance.now();
    let event;

    if (!hands.length) {
      this.missed++;
      if (this.missed < MISSES_BEFORE_LOST) return;
      this.hands = [];
      event = this.controller.lost(now);
    } else {
      this.missed = 0;
      const raw = hands[0];
      // Movement is always measured from the presenter's point of view (selfie coordinates).
      const selfie = raw.landmarks.map((p) => ({ x: 1 - p.x, y: p.y }));
      const aspect = this.canvas.width / this.canvas.height || 4 / 3;
      const span = (i, j) => Math.hypot((selfie[i].x - selfie[j].x) * aspect, selfie[i].y - selfie[j].y);
      const palm = {
        x: PALM.reduce((s, i) => s + selfie[i].x, 0) / PALM.length,
        y: PALM.reduce((s, i) => s + selfie[i].y, 0) / PALM.length,
      };
      const size = (span(0, 9) + span(5, 17)) / 2;
      // A finger is curled when its tip is nearer the wrist than its middle (PIP) joint.
      const curled = (tip, pip) => span(0, tip) < span(0, pip);
      const pose = {
        pinch: span(4, 8) / Math.max(size, 1e-3),
        indexExt: span(0, 8) > span(0, 6) * 1.08 && span(5, 8) > size * 0.55,
        indexCurled: curled(8, 6),
        othersCurled: curled(12, 10) && curled(16, 14) && curled(20, 18),
        vx: (selfie[8].x - selfie[5].x) * aspect,
        vy: selfie[8].y - selfie[5].y,
        tip: { x: selfie[8].x, y: selfie[8].y },
      };
      event = this.controller.update(palm, size, pose, now);
      // MediaPipe labels handedness for mirrored input; raw webcam frames are not mirrored.
      const label = raw.handedness === "Left" ? "Right" : raw.handedness === "Right" ? "Left" : "";
      const display = raw.landmarks.map((p) => ({ x: this.mirror ? 1 - p.x : p.x, y: p.y }));
      this.hands = [{ pts: display, score: raw.score, label }];
    }
    this.lastEvent = event;
    this.onResult?.({ event, hand: this.hands[0] || null, hud: this.controller.hud() });
  }

  _measureLight() {
    try {
      this.lumaCtx.drawImage(this.video, 0, 0, 32, 24);
      const d = this.lumaCtx.getImageData(0, 0, 32, 24).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      this.light = sum / (d.length / 4) / 255;
      if (this.exposureLocked && this.light < 0.15 && ++this.darkCount >= 3) {
        this.lockExposure = false;
        this.applyExposure().catch(() => {});
        this.onNotice?.("Room too dark for locked exposure: switched to auto exposure (camera may run slower). Add light for full frame rate.");
      } else if (this.light >= 0.15) {
        this.darkCount = 0;
      }
    } catch {
      this.light = null;
    }
  }

  _emitStats() {
    const now = performance.now();
    const seconds = Math.max((now - this.lastStats) / 1000, 0.001);
    this.onStats?.({
      camFps: this.counters.cam / seconds,
      aiFps: this.counters.ai / seconds,
      latency: this.latency,
      light: this.light,
      delegate: this.delegate,
      engine: this.engineMode,
      track: this.trackInfo,
    });
    this.counters = { cam: 0, ai: 0 };
    this.lastStats = now;
  }

  // ------------------------------------------------------------------ preview drawing

  _drawPreview() {
    const { ctx, canvas, video } = this;
    const w = canvas.width;
    const h = canvas.height;
    const k = w / 640;
    if (this.showVideo) {
      ctx.save();
      if (this.mirror) {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, w, h);
      ctx.restore();
      ctx.fillStyle = "rgba(0, 40, 14, 0.16)";
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.drawImage(this._backdrop(w, h, k), 0, 0);
    }

    if (this.paused) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(0, h / 2 - 28 * k, w, 56 * k);
      ctx.font = `${22 * k}px Orbitron, "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffc94d";
      ctx.fillText("TRACKING PAUSED", w / 2, h / 2);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    } else if (this.hands[0]) {
      this._drawDeadZone(k);
      if (this.showSkeleton) this._drawHand(this.hands[0], k);
    }

    if (this.pipCanvas) {
      const p = this.pipCanvas;
      if (p.width !== w || p.height !== h) {
        p.width = w;
        p.height = h;
      }
      p.getContext("2d").drawImage(canvas, 0, 0);
    }
  }

  // Privacy view: a HUD grid instead of the camera image, so no face is ever shown.
  _backdrop(w, h, k) {
    if (this.backdrop?.width === w && this.backdrop.height === h) return this.backdrop;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#010a05";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(0, 255, 102, 0.08)";
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= w; x += 40 * k) { g.moveTo(x, 0); g.lineTo(x, h); }
    for (let y = 0; y <= h; y += 40 * k) { g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    g.strokeStyle = "rgba(0, 255, 102, 0.25)";
    g.beginPath();
    g.arc(w / 2, h / 2, 60 * k, 0, Math.PI * 2);
    g.moveTo(w / 2 - 80 * k, h / 2); g.lineTo(w / 2 + 80 * k, h / 2);
    g.moveTo(w / 2, h / 2 - 80 * k); g.lineTo(w / 2, h / 2 + 80 * k);
    g.stroke();
    g.fillStyle = "rgba(0, 255, 102, 0.45)";
    g.font = `${13 * k}px "Share Tech Mono", Consolas, monospace`;
    g.textAlign = "center";
    g.fillText("PRIVACY MODE · HAND SIGNAL ONLY", w / 2, h - 16 * k);
    this.backdrop = c;
    return c;
  }

  _drawDeadZone(k) {
    const hud = this.controller.hud();
    if (!hud.origin || !hud.point) return;
    const { ctx } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const fx = (x) => (this.mirror ? x : 1 - x) * w;
    const ox = fx(hud.origin.x);
    const oy = hud.origin.y * h;
    const px = fx(hud.point.x);
    const py = hud.point.y * h;
    const tw = hud.threshold * w;
    const th = hud.threshold * h;
    const rgb = hud.armed ? "0, 255, 102" : "255, 201, 77";

    ctx.lineWidth = 1.5 * k;
    ctx.setLineDash([6 * k, 6 * k]);
    ctx.strokeStyle = `rgba(${rgb}, 0.75)`;
    ctx.strokeRect(ox - tw, oy - th, tw * 2, th * 2);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(ox - 9 * k, oy);
    ctx.lineTo(ox + 9 * k, oy);
    ctx.moveTo(ox, oy - 9 * k);
    ctx.lineTo(ox, oy + 9 * k);
    ctx.stroke();

    ctx.strokeStyle = `rgba(${rgb}, 0.95)`;
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(px, py);
    ctx.stroke();
    ctx.fillStyle = `rgb(${rgb})`;
    ctx.beginPath();
    ctx.arc(px, py, 6 * k, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawHand(hand, k) {
    const { ctx } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const P = hand.pts.map((p) => [p.x * w, p.y * h]);

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of P) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const pad = 18 * k;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const c = 16 * k;
    ctx.strokeStyle = "rgba(0, 255, 102, 0.9)";
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + c); ctx.lineTo(x0, y0); ctx.lineTo(x0 + c, y0);
    ctx.moveTo(x1 - c, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + c);
    ctx.moveTo(x1, y1 - c); ctx.lineTo(x1, y1); ctx.lineTo(x1 - c, y1);
    ctx.moveTo(x0 + c, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - c);
    ctx.stroke();
    ctx.font = `${13 * k}px "Share Tech Mono", Consolas, monospace`;
    ctx.fillStyle = "#00ff66";
    const c2 = this.controller;
    const pose = { "point-left": " · POINT ◀", "point-right": " · POINT ▶", pinch: " · PINCH", laser: " · LASER" }[c2.pose] || "";
    ctx.fillText(`HAND ${hand.label.toUpperCase()} · ${Math.round(hand.score * 100)}%${pose}${c2.locked ? " · DONE" : ""}`, x0, y0 - 6 * k);

    ctx.save();
    ctx.shadowColor = "#00ff66";
    ctx.shadowBlur = 10 * k;
    ctx.strokeStyle = "rgba(0, 255, 120, 0.95)";
    ctx.lineWidth = 3 * k;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(P[a][0], P[a][1]);
      ctx.lineTo(P[b][0], P[b][1]);
    }
    ctx.stroke();
    ctx.restore();

    for (let i = 0; i < P.length; i++) {
      const tip = FINGER_TIPS.has(i);
      ctx.beginPath();
      ctx.arc(P[i][0], P[i][1], (tip ? 5 : 3.2) * k, 0, Math.PI * 2);
      ctx.fillStyle = tip ? "#eaffef" : "#00ff66";
      ctx.fill();
    }
  }
}
