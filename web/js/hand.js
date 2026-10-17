// Webcam capture (negotiates up to 60 FPS), MediaPipe hand landmarks and natural movement detection.
// Privacy: the camera image is never drawn. Only the hand signal (skeleton + motion HUD) is shown.

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11],
  [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
const PALM = [0, 5, 9, 13, 17];
const FINGER_TIPS = new Set([4, 8, 12, 16, 20]);
const MISSES_BEFORE_LOST = 3;
// Frames sent to the model are downscaled to this width. The palm detector works at 192 px and the
// landmark model at 224 px, so 384 px keeps full accuracy while cutting copy and transfer time.
const DETECT_WIDTH = 384;
const STILL_SPEED = 0.35; // frame-widths per second below which the hand counts as still
const OPPOSITE = { LEFT: "RIGHT", RIGHT: "LEFT", UP: "DOWN", DOWN: "UP" };
const REF_SIZE = 0.2; // typical palm size (wrist → middle knuckle, frame heights) at arm's length

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One Euro filter (Casiez et al. 2012): heavy smoothing while the hand is still (no jitter) and
 * almost none while it moves fast (no lag). Also yields a filtered velocity used for flick detection.
 */
class OneEuro {
  constructor(minCutoff = 2.5, beta = 8, dCutoff = 1.2) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value, tMs) {
    if (this.x === null) {
      this.x = value;
      this.t = tMs;
      return value;
    }
    const dt = Math.max((tMs - this.t) / 1000, 1 / 240);
    this.t = tMs;
    const rawDx = (value - this.x) / dt;
    this.dx += (rawDx - this.dx) * OneEuro.alpha(this.dCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (value - this.x) * OneEuro.alpha(cutoff, dt);
    return this.x;
  }
}

/**
 * Turns hand landmarks into presentation actions:
 *  - Swipes: LEFT/RIGHT/UP/DOWN palm movement past a dead zone around a calibrated neutral point.
 *    A fast flick fires earlier (at ~55% of the distance). Returning to where a swipe started never
 *    fires the opposite command.
 *  - Finger poses: index pointing left/right (POINT_LEFT/POINT_RIGHT), index pointing up (laser),
 *    and thumb+index pinch moved up/down (continuous zoom).
 *  - "One action per appearance": after a page action, nothing fires until the hand leaves the
 *    camera view and comes back.
 */
export class GestureController {
  constructor() {
    this.threshold = 0.07;
    this.cooldownMs = 350;
    this.settleMs = 180;
    this.zoomMode = "pinch";
    this.pointing = true;
    this.laser = true;
    this.oncePerAppearance = true;
    this.flick = true;
    this.unlockMs = 200;
    this.pointHoldMs = 100;
    this.pinchHoldMs = 100;
    this.fx = new OneEuro();
    this.fy = new OneEuro();
    this.smoothing = 0.25;
    this.aspect = 4 / 3;
    this.progress = 0;
    this.reset();
  }

  /** 0 = raw landmarks, 0.85 = very smooth. Mapped onto the One Euro minimum cutoff (Hz). */
  set smoothing(s) {
    this._smoothing = s;
    const cutoff = 6 * (1 - s) ** 2 + 0.6;
    this.fx.minCutoff = this.fy.minCutoff = cutoff;
  }

  get smoothing() { return this._smoothing; }

  /** Full reset: recalibrate, pause/resume, camera start. */
  reset() {
    this.locked = false;
    this.goneAt = null;
    this.lastTrigger = -Infinity;
    this._resetTracking();
  }

  _resetTracking() {
    this.fx.reset();
    this.fy.reset();
    this.origin = null;
    this.point = null;
    this.vel = { x: 0, y: 0 };
    this.size = null;
    this.calm = 0;
    this.stillSince = null;
    this.armed = true;
    this.lastSwipe = null;
    this.zoomBase = null;
    this.zoomArmed = true;
    this.pose = "open";
    this.poseSince = 0;
    this.poseFired = false;
    this.candidate = null;
    this.candidateCount = 0;
    this.pinchZoom = null;
    this.progress = 0;
    this.pendingAction = null;
  }

  /** Hand left the camera view. Keeps the lock; it is released once the hand stays away long enough. */
  lost(now) {
    if (this.goneAt === null) this.goneAt = now;
    const zoom = this.pinchZoom ? { phase: "end", factor: this.pinchZoom.factor } : null;
    this._resetTracking();
    return { state: "NO HAND", zoom };
  }

  /**
   * Swipe distance as normalized x / y thresholds. It is measured in real proportions (x corrected
   * for the frame's aspect ratio) and scaled by the hand's size in the image, so a swipe needs the
   * same physical movement whether the presenter stands near or far from the camera.
   */
  _thresholds() {
    const scale = Math.min(1.6, Math.max(0.6, (this.size || REF_SIZE) / REF_SIZE));
    const t = this.threshold * 1.15 * scale; // frame-height units
    return { tx: t / this.aspect, ty: t };
  }

  hud() {
    const { tx, ty } = this._thresholds();
    return {
      origin: this.origin, point: this.point, threshold: ty, tx, ty, progress: this.progress,
      armed: this.armed && !this.locked, pose: this.pose, locked: this.locked,
    };
  }

  _ready() {
    return { state: this.locked ? "LOCKED" : "READY" };
  }

  _recenter() {
    this.origin = { ...this.point };
    this.zoomBase = { size: this.size };
  }

  update(palm, size, pose, now) {
    if (this.goneAt !== null) {
      if (now - this.goneAt >= this.unlockMs) this.locked = false;
      this.goneAt = null;
    }
    const prev = this.point;
    const first = prev === null;
    this.point = { x: this.fx.filter(palm.x, now), y: this.fy.filter(palm.y, now) };
    if (!first) {
      // Responsive velocity of the filtered point (frame-widths per second) for flicks and stillness.
      const dt = Math.max((now - this.lastT) / 1000, 1 / 240);
      this.vel.x += ((this.point.x - prev.x) / dt - this.vel.x) * 0.6;
      this.vel.y += ((this.point.y - prev.y) / dt - this.vel.y) * 0.6;
    }
    this.lastT = now;
    this.size = first ? size : this.size + (size - this.size) * 0.35;
    const speed = Math.hypot(this.vel.x, this.vel.y);
    // A far-away (small) hand moves fewer pixels for the same gesture: scale "still" with it.
    const still = STILL_SPEED * Math.min(1.6, Math.max(0.5, this.size / REF_SIZE));
    if (speed < still) this.stillSince ??= now;
    else this.stillSince = null;
    const stillFor = this.stillSince === null ? 0 : now - this.stillSince;

    if (!this.origin) {
      // Calibrate only once the hand is calm, so a hand entering the frame never fires a swipe.
      this.calm = !first && speed < still ? this.calm + 1 : 0;
      if (this.calm < 2) return { state: "LOCKING" };
      this._recenter();
      return this._ready();
    }

    const posed = this._poses(pose, now);
    if (posed) return posed;

    const settled = stillFor >= this.settleMs;
    const { tx, ty } = this._thresholds();
    // While the hand moves, look ~40 ms ahead along its velocity: this hides part of the
    // camera + model latency, so a swipe fires as the hand crosses the line, not after.
    const lead = speed > still * 1.5 ? 0.04 : 0;
    const nx = (this.point.x + this.vel.x * lead - this.origin.x) / tx; // in thresholds
    const ny = (this.point.y + this.vel.y * lead - this.origin.y) / ty;
    const offset = Math.max(Math.abs(nx), Math.abs(ny));
    this.progress = Math.min(1, offset);

    if (!this.armed) {
      // After a swipe, wait until the hand pauses; the new neutral point is wherever it stopped.
      if (!settled) return { state: "RE-ARM" };
      this._recenter();
      this.armed = true;
      return this._ready();
    }

    const zoom = this.zoomMode === "depth" && offset < 0.5 ? this._depthZoom(now, settled) : null;
    if (zoom) return zoom;

    if (offset < 0.55) {
      this.pendingAction = null;
      if (settled) this._recenter();
      return { state: this.locked ? "LOCKED" : "STILL" };
    }
    // Direction: the dominant axis must clearly win (35%). A diagonal move is settled by the
    // direction of travel; if that is diagonal too, wait instead of guessing UP vs RIGHT.
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    let horizontal = ax >= ay * 1.35 ? true : ay >= ax * 1.35 ? false : null;
    if (horizontal === null) {
      const vx = Math.abs(this.vel.x) / tx;
      const vy = Math.abs(this.vel.y) / ty;
      horizontal = vx >= vy * 1.35 ? true : vy >= vx * 1.35 ? false : null;
      if (horizontal === null) return { state: "DIAGONAL" };
    }
    const action = horizontal ? (nx > 0 ? "RIGHT" : "LEFT") : (ny > 0 ? "DOWN" : "UP");
    // Speed along the swipe direction, in thresholds per second (positive = moving outward).
    const along = horizontal ? (this.vel.x / tx) * Math.sign(nx) : (this.vel.y / ty) * Math.sign(ny);
    const flick = this.flick && along > 7.5;

    if ((horizontal ? ax : ay) < 1 && !flick) {
      if (settled) this._recenter();
      return { state: this.locked ? "LOCKED" : "STILL" };
    }
    if (this.oncePerAppearance && this.locked) {
      this._recenter(); // nothing accumulates while waiting for the hand to leave
      return { state: "LOCKED" };
    }
    // Return stroke: moving back toward where the last swipe started never fires the opposite command.
    const last = this.lastSwipe;
    if (last && now - last.at < 2500 && OPPOSITE[last.action] === action) {
      const past = horizontal
        ? ((last.origin.x - this.point.x) * Math.sign(-nx)) / tx
        : ((last.origin.y - this.point.y) * Math.sign(-ny)) / ty;
      if (past < 0.5) {
        this._recenter();
        return { state: "RETURN" };
      }
    }
    if (now - this.lastTrigger < this.cooldownMs) return { state: "COOLDOWN" };
    // Borderline swipes must be seen on two frames in a row; clear swipes and flicks fire at once.
    if (!flick && (horizontal ? ax : ay) < 1.3 && this.pendingAction !== action) {
      this.pendingAction = action;
      return { state: "CONFIRM" };
    }
    this.pendingAction = null;

    this.lastTrigger = now;
    this.lastSwipe = { action, origin: { ...this.origin }, at: now };
    this.armed = false;
    this.stillSince = null;
    if (this.oncePerAppearance) this.locked = true;
    return { state: action, action, flick };
  }

  _classify(f) {
    if (!f) return "open";
    if (!f.indexCurled && f.pinch < (this.pose === "pinch" ? 0.48 : 0.32)) return "pinch";
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
        {
          // Moving the pinched hand up 15% of the frame height doubles the zoom; down halves it.
          // A small dead band ignores tremor, and the factor glides so the zoom never jitters.
          const rise = this.pinchZoom.y0 - this.point.y;
          const band = Math.sign(rise) * Math.max(0, Math.abs(rise) - 0.012);
          this.pinchZoom.factor += (2 ** (band / 0.15) - this.pinchZoom.factor) * 0.5;
        }
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
    this._recenter();
    this.armed = true;
    this.lastSwipe = null;
    this.stillSince = now;
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
    this.stillSince = null;
    const action = delta > 0 ? "ZOOM_IN" : "ZOOM_OUT";
    return { state: action, action };
  }
}

/** Plain-language camera errors with the fix for each case. */
function friendlyCameraError(err) {
  const blocked = "Camera access is blocked. Click the camera icon in the address bar → Allow, " +
    "check Windows Settings → Privacy → Camera (allow desktop apps), then press START CAMERA.";
  const busy = "The camera is busy. Close Zoom, Teams, the Windows Camera app or another tab using the camera, then press START CAMERA.";
  const messages = {
    NotAllowedError: blocked,
    SecurityError: blocked,
    NotFoundError: "No camera was found. Connect a webcam (or enable it in Device Manager) and press START CAMERA.",
    OverconstrainedError: "This camera does not support the selected settings. Choose another camera or resolution.",
    NotReadableError: busy,
    AbortError: busy,
  };
  const error = new Error(messages[err?.name] || `Camera error: ${err?.message || err}`);
  error.code = err?.name || "Error";
  return error;
}

/** The camera API only exists on https:// or localhost. Returns a fix-it message, or null when fine. */
export function insecureCameraHint() {
  if (window.isSecureContext && navigator.mediaDevices?.getUserMedia) return null;
  let port = location.port;
  try {
    port = new URL(new URLSearchParams(location.search).get("streamlitUrl") || location.href).port || port;
  } catch { /* keep the frame's own port */ }
  const url = `http://localhost${port ? `:${port}` : ""}/`;
  return {
    url,
    message: !window.isSecureContext
      ? `Browsers only allow the camera on localhost or https. Open ${url} on this PC (the Network / External URL blocks the camera).`
      : "This browser has no camera support. Use Microsoft Edge or Google Chrome.",
  };
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
    this.previewEnabled = true;
    this.mirror = true;
    this.showSkeleton = true;
    this.turbo = true;
    this.pipCanvas = null;
    this.hands = [];
    this.drawPts = null;
    this.busy = false;
    this.missed = 0;
    this.lastEvent = { state: "NO HAND" };
    this.counters = { cam: 0, ai: 0, hud: 0 };
    this.latency = 0;
    this.light = null;
    this.delegate = "--";
    this.engineMode = "--";
    this.trackInfo = null;
    this.camPulse = 0;
    this.gain = 1;
    this.lumaCanvas = document.createElement("canvas");
    this.lumaCanvas.width = 32;
    this.lumaCanvas.height = 24;
    this.lumaCtx = this.lumaCanvas.getContext("2d", { willReadFrequently: true });
    this.initPromise = null;
    this._hudLoop = this._hudLoop.bind(this);
    video.addEventListener("resize", () => this._fitCanvas());
  }

  init() {
    this.initPromise ??= this._init().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  /**
   * Downloads the hand model and the WebAssembly engine once, reporting progress (they are ~17 MB,
   * which takes a while on a slow connection or a cold Streamlit Cloud start). The bytes are handed
   * to the detector as blob URLs, so nothing is downloaded twice and no loader can time out.
   */
  async _download() {
    const base = new URL("vendor/mediapipe/", document.baseURI).href;
    const { FilesetResolver } = await import("../vendor/mediapipe/vision_bundle.mjs");
    const simd = await FilesetResolver.isSimdSupported().catch(() => true);
    const name = simd ? "vision_wasm_internal" : "vision_wasm_nosimd_internal";
    const files = [[`${base}hand_landmarker.task`, 7.82e6], [`${base}wasm/${name}.wasm`, 9.4e6], [`${base}wasm/${name}.js`, 2.1e5]];
    const loaded = files.map(() => 0);
    const totals = files.map(([, size]) => size);
    const sum = (a) => a.reduce((s, v) => s + v, 0);
    let last = -1;
    const report = () => {
      const pct = Math.min(99, Math.floor((sum(loaded) / sum(totals)) * 100));
      if (pct !== last) this.onProgress?.((last = pct));
    };
    const blobs = await Promise.all(files.map(async ([url], i) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not download ${url.split("/").pop()} (HTTP ${res.status})`);
      const len = Number(res.headers.get("content-length"));
      if (len && !res.headers.get("content-encoding")) totals[i] = len;
      if (!res.body) return res.blob();
      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded[i] += value.length;
        report();
      }
      return new Blob(chunks);
    }));
    const url = (blob, type) => URL.createObjectURL(new Blob([blob], { type }));
    return {
      modelUrl: url(blobs[0], "application/octet-stream"),
      fileset: { wasmBinaryPath: url(blobs[1], "application/wasm"), wasmLoaderPath: url(blobs[2], "text/javascript") },
    };
  }

  async _init() {
    const urls = await this._download();
    this.onProgress?.(100);
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
      // Files are already downloaded, so this only covers compiling the engine on a slow PC.
      const timer = setTimeout(() => fail(new Error("Hand tracking worker timed out")), 60000);
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
    const fileset = urls.fileset;
    const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: urls.modelUrl, delegate },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
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

  /** Opens the camera, retrying through fallbacks: exact settings → any size → default camera. */
  async _open(deviceId, width, height, fps) {
    const device = deviceId ? { deviceId: { exact: deviceId } } : {};
    const attempts = [
      { ...device, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } },
      { ...device, frameRate: { ideal: fps } },
      { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } }, // saved camera gone
      true,
    ];
    let lastError = null;
    for (const video of attempts) {
      // A camera that was just released (another tab, a restart) can report "busy" for a moment.
      for (let busyRetry = 0; busyRetry < 3; busyRetry++) {
        try {
          return await navigator.mediaDevices.getUserMedia({ video, audio: false });
        } catch (err) {
          lastError = err;
          if (err.name === "NotAllowedError" || err.name === "SecurityError") throw friendlyCameraError(err);
          if (err.name !== "NotReadableError" && err.name !== "AbortError") break;
          await sleep(500 * (busyRetry + 1));
        }
      }
    }
    throw friendlyCameraError(lastError);
  }

  /**
   * Many webcams only deliver 60 FPS at particular sizes. When the hardware can do more than it is
   * currently giving, try the common 60 FPS modes until one sticks; otherwise keep the first mode.
   */
  async _maximizeFrameRate(track, fps, width, height) {
    const caps = track.getCapabilities?.() || {};
    const current = track.getSettings().frameRate || 0;
    if (current >= fps - 1 || !caps.frameRate?.max || caps.frameRate.max < fps - 1) return false;
    const sizes = [[width, height], [640, 480], [640, 360], [848, 480], [1280, 720], [320, 240]];
    for (const [w, h] of sizes) {
      if (caps.width?.max && (w > caps.width.max || h > caps.height.max)) continue;
      try {
        await track.applyConstraints({ width: { exact: w }, height: { exact: h }, frameRate: { exact: fps } });
        if ((track.getSettings().frameRate || 0) >= fps - 1) return true;
      } catch { /* mode not offered, try the next */ }
    }
    await track.applyConstraints({ width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } }).catch(() => {});
    return false;
  }

  async start({ deviceId, width, height, fps }) {
    const hint = insecureCameraHint();
    if (hint) {
      const error = new Error(hint.message);
      error.code = "Insecure";
      error.url = hint.url;
      throw error;
    }
    this.stop();
    const stream = await this._open(deviceId, width, height, fps);
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    this.requestedFps = fps;
    await this._maximizeFrameRate(track, fps, width, height);

    const v = this.video;
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    await v.play();
    if (!v.videoWidth) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
    this._fitCanvas();

    const s = track.getSettings();
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
    this.drawPts = null;
    this.missed = 0;
    this.busy = false;
    this.counters = { cam: 0, ai: 0, hud: 0 };
    this.lastStats = performance.now();
    this.lastVideoTime = -1;
    this.useRVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
    this._schedule();
    this.hudHandle = requestAnimationFrame(this._hudLoop);
    this.statsTimer = setInterval(() => this._emitStats(), 500);
    return this.trackInfo;
  }

  _fitCanvas() {
    const v = this.video;
    if (!v.videoWidth) return;
    // The HUD is drawn at a fixed 480-wide size whatever the camera resolution (it is shown about
    // 340 px wide): cheaper at 60 FPS, and identical since no camera pixels are drawn.
    const w = 480;
    const h = Math.round((w * v.videoHeight) / v.videoWidth);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.backdrop = null;
    }
  }

  stop() {
    this.running = false;
    if (this.frameHandle != null) {
      if (this.useRVFC) this.video.cancelVideoFrameCallback(this.frameHandle);
      else cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    cancelAnimationFrame(this.hudHandle);
    clearInterval(this.statsTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.hands = [];
    this.drawPts = null;
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
    const fps = Math.min(this.requestedFps || 30, track.getSettings().frameRate || 30, caps.frameRate?.max || 30);
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
    this.camPulse = performance.now();
    this.frameCount = (this.frameCount || 0) + 1;
    if (this.frameCount % 15 === 1) this._measureLight();
    if (this.paused) return;
    // Turbo: every camera frame goes to the model, and a frame that arrives while the model is
    // busy is processed the moment it is free. Balanced: while no hand is tracked (the heavier
    // palm search) use every other frame to leave GPU time to the 3D scene.
    const tracking = this.hands.length > 0;
    if (this.busy) this.frameWaiting = true;
    else if (this.turbo || tracking || this.frameCount % 2 === 0) this._detect();
  };

  _detect() {
    const v = this.video;
    if (v.readyState < 2) return;
    this.busy = true;
    this.frameWaiting = false;
    this.sentAt = performance.now();
    if (this.worker) {
      const scale = Math.min(1, DETECT_WIDTH / v.videoWidth);
      createImageBitmap(v, {
        resizeWidth: Math.round(v.videoWidth * scale),
        resizeHeight: Math.round(v.videoHeight * scale),
        resizeQuality: "low",
      })
        .then((bitmap) => this.worker.postMessage({ type: "frame", bitmap, ts: this.sentAt, gain: this.gain }, [bitmap]))
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
      if (this.turbo || this.hands.length) this._detect();
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
      this.lastPalm = null;
      this.jumpTo = null;
      event = this.controller.lost(now);
    } else {
      this.missed = 0;
      const raw = hands[0];
      // Movement is always measured from the presenter's point of view (selfie coordinates).
      const selfie = raw.landmarks.map((p) => ({ x: 1 - p.x, y: p.y }));
      const aspect = this.video.videoWidth / this.video.videoHeight || 4 / 3;
      const span = (i, j) => Math.hypot((selfie[i].x - selfie[j].x) * aspect, selfie[i].y - selfie[j].y);
      // Pinch uses depth too, so fingers that only overlap in the image are not read as a pinch.
      const lm = raw.landmarks;
      const span3 = (i, j) => Math.hypot((lm[i].x - lm[j].x) * aspect, lm[i].y - lm[j].y, ((lm[i].z || 0) - (lm[j].z || 0)) * aspect);
      const palm = {
        x: PALM.reduce((s, i) => s + selfie[i].x, 0) / PALM.length,
        y: PALM.reduce((s, i) => s + selfie[i].y, 0) / PALM.length,
      };
      const size = (span(0, 9) + span(5, 17)) / 2;
      // Outlier rejection: a palm that "teleports" more than a quarter of the frame in one result is
      // usually a mis-detection (another object, motion blur). It is ignored unless the next result
      // confirms the new position.
      if (this.lastPalm && dist(palm, this.lastPalm) > 0.25 && !(this.jumpTo && dist(palm, this.jumpTo) < 0.08)) {
        this.jumpTo = palm;
        return;
      }
      this.jumpTo = null;
      this.lastPalm = palm;
      // A finger is curled when its tip is nearer the wrist than its middle (PIP) joint.
      const curled = (tip, pip) => span(0, tip) < span(0, pip);
      const pose = {
        pinch: span3(4, 8) / Math.max(size, 1e-3),
        indexExt: span(0, 8) > span(0, 6) * 1.08 && span(5, 8) > size * 0.55,
        indexCurled: curled(8, 6),
        othersCurled: curled(12, 10) && curled(16, 14) && curled(20, 18),
        vx: (selfie[8].x - selfie[5].x) * aspect,
        vy: selfie[8].y - selfie[5].y,
        tip: { x: selfie[8].x, y: selfie[8].y },
      };
      this.controller.aspect = aspect;
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
      // Auto low-light boost: brighten the frames given to the model (never shown) so landmarks stay
      // accurate in a dim room. Hysteresis keeps it from toggling.
      if (this.light < 0.3) this.gain = Math.min(2.2, Math.max(1.15, 0.4 / Math.max(this.light, 0.05)));
      else if (this.light > 0.36) this.gain = 1;
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
      hudFps: this.counters.hud / seconds,
      latency: this.latency,
      light: this.light,
      gain: this.gain,
      delegate: this.delegate,
      engine: this.engineMode,
      track: this.trackInfo,
    });
    this.counters = { cam: 0, ai: 0, hud: 0 };
    this.lastStats = now;
  }

  // ------------------------------------------------------------------ hand-signal HUD (60 FPS)

  /**
   * The HUD runs at the display refresh rate, independent of the camera. Landmarks glide toward
   * each new detection, so the skeleton moves smoothly at 60 FPS even with a 30 FPS webcam.
   */
  _hudLoop(now) {
    if (!this.running) return;
    this.hudHandle = requestAnimationFrame(this._hudLoop);
    if (!this.previewEnabled && !this.pipCanvas) return;
    const dt = Math.min((now - (this.lastHud || now)) / 1000, 0.1);
    this.lastHud = now;
    const target = this.hands[0]?.pts;
    if (!target) this.drawPts = null;
    else if (!this.drawPts) this.drawPts = target.map((p) => ({ ...p }));
    else {
      const k = 1 - Math.exp(-dt * 28);
      for (let i = 0; i < target.length; i++) {
        this.drawPts[i].x += (target[i].x - this.drawPts[i].x) * k;
        this.drawPts[i].y += (target[i].y - this.drawPts[i].y) * k;
      }
    }
    this.counters.hud++;
    this._drawHud(now);
  }

  _drawHud(now) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    const k = w / 640;
    ctx.drawImage(this._backdrop(w, h, k), 0, 0);
    const hand = this.hands[0];

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
    } else if (hand && this.drawPts) {
      this._drawDeadZone(k);
      if (this.showSkeleton) this._drawHand(hand, this.drawPts, k);
    } else {
      this._drawRadar(now, w, h, k);
    }

    // Camera heartbeat: flashes on every frame the webcam delivers.
    const beat = Math.max(0, 1 - (now - this.camPulse) / 120);
    ctx.fillStyle = `rgba(0, 255, 102, ${0.25 + beat * 0.75})`;
    ctx.beginPath();
    ctx.arc(w - 16 * k, h - 16 * k, 4 * k, 0, Math.PI * 2);
    ctx.fill();

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
    const bg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.7);
    bg.addColorStop(0, "#03200d");
    bg.addColorStop(1, "#000703");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(0, 255, 102, 0.07)";
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= w; x += 32 * k) { g.moveTo(x, 0); g.lineTo(x, h); }
    for (let y = 0; y <= h; y += 32 * k) { g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    g.strokeStyle = "rgba(0, 255, 102, 0.22)";
    g.beginPath();
    for (const r of [60, 120, 180]) {
      g.moveTo(w / 2 + r * k, h / 2);
      g.arc(w / 2, h / 2, r * k, 0, Math.PI * 2);
    }
    g.moveTo(w / 2 - 200 * k, h / 2); g.lineTo(w / 2 + 200 * k, h / 2);
    g.moveTo(w / 2, h / 2 - 200 * k); g.lineTo(w / 2, h / 2 + 200 * k);
    g.stroke();
    g.fillStyle = "rgba(0, 255, 102, 0.5)";
    g.font = `${13 * k}px "Share Tech Mono", Consolas, monospace`;
    g.textAlign = "center";
    g.fillText("PRIVACY MODE · HAND SIGNAL ONLY · NO CAMERA IMAGE", w / 2, h - 14 * k);
    this.backdrop = c;
    return c;
  }

  _drawRadar(now, w, h, k) {
    const { ctx } = this;
    const a = (now / 1000) * 2.4;
    const r = 200 * k;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(a);
    const sweep = ctx.createLinearGradient(0, 0, r, 0);
    sweep.addColorStop(0, "rgba(0, 255, 102, 0.0)");
    sweep.addColorStop(1, "rgba(0, 255, 102, 0.35)");
    ctx.fillStyle = sweep;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, -0.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(160, 255, 200, 0.85)";
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(r, 0);
    ctx.stroke();
    ctx.restore();
    ctx.font = `${18 * k}px Orbitron, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = `rgba(200, 255, 217, ${0.55 + Math.sin(now / 260) * 0.35})`;
    ctx.fillText("SCANNING FOR HAND", w / 2, h - 40 * k);
    ctx.textAlign = "start";
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
    const tw = hud.tx * w;
    const th = hud.ty * h;
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

  _drawHand(hand, pts, k) {
    const { ctx } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const P = pts.map((p) => [p.x * w, p.y * h]);

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

    // Palm glow
    const palm = P[9];
    const glow = ctx.createRadialGradient(palm[0], palm[1], 0, palm[0], palm[1], 70 * k);
    glow.addColorStop(0, "rgba(0, 255, 102, 0.28)");
    glow.addColorStop(1, "rgba(0, 255, 102, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(palm[0] - 70 * k, palm[1] - 70 * k, 140 * k, 140 * k);

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
