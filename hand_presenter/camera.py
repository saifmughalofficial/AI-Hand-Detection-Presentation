"""Browser camera bridge (no WebRTC, no TURN server needed on Streamlit Cloud).

The visitor's browser opens the webcam and runs MediaPipe hand landmark detection itself (in a
Web Worker). Only the 21 hand points are sent to Python, about 9 times a second, where
``gestures.GestureController`` decides every action. Python answers through a hidden
``<div class="hp-state">`` (written by app.py); this script reads it to play the visual effects
(arrow flash, toast, laser pointer, live pinch-zoom preview, presenter HUD, fullscreen).
No video is uploaded and the camera image is not shown unless the presenter turns it on.
"""
from __future__ import annotations

import streamlit as st

MP_VERSION = "0.10.14"   # @mediapipe/tasks-vision on jsDelivr

_HTML = """
<div class="hc">
  <canvas class="hc-view" width="640" height="480"></canvas>
  <div class="hc-bar">
    <button class="hc-btn hc-start" type="button">▶ START CAMERA</button>
    <button class="hc-btn hc-pause" type="button" disabled>Ⅱ PAUSE</button>
    <button class="hc-btn hc-present" type="button">⛶ PRESENT</button>
  </div>
  <div class="hc-status">Camera is OFF (privacy). Press START CAMERA.</div>
</div>
"""

_CSS = """
.hc { font-family: "Rajdhani", "Segoe UI", system-ui, sans-serif; }
.hc-view { width: 100%; aspect-ratio: 4 / 3; display: block; background: #010a05;
           border: 1px solid rgba(0,255,102,.35); box-shadow: 0 0 24px rgba(0,255,102,.18); }
.hc-bar { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-top: 8px; }
.hc-btn { padding: 8px 6px; border: 1px solid rgba(0,255,102,.35); background: rgba(0,255,102,.06); color: #00ff66;
          font: 700 13px "Rajdhani", "Segoe UI", sans-serif; letter-spacing: .1em; cursor: pointer;
          clip-path: polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px); }
.hc-btn:hover:not(:disabled) { background: rgba(0,255,102,.18); color: #c8ffd9; }
.hc-btn:disabled { opacity: .35; cursor: not-allowed; }
.hc-start { background: linear-gradient(90deg,#00d957,#00ff88); color: #001a09; border-color: transparent; }
.hc-start.on { background: rgba(255,77,109,.08); color: #ff4d6d; border-color: rgba(255,77,109,.5); }
.hc-present { background: linear-gradient(90deg,#00d957,#00ff88); color: #001a09; border-color: transparent; }
.hc-status { margin-top: 6px; color: #69b886; font: 13px "Share Tech Mono", Consolas, monospace; min-height: 1.3em; }
"""

_JS = r"""
const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@__MP__";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
// The app serves the two big binaries itself (static/mediapipe, ~17 MB) so the camera starts fast;
// the public CDN copies are the fallback.
const LOCAL = new URL("app/static/mediapipe/", document.baseURI).href;
const SOURCES = [
  { loader: MP + "/wasm/vision_wasm_internal.js", wasm: LOCAL + "vision_wasm_internal.wasm", model: LOCAL + "hand_landmarker.task" },
  { loader: MP + "/wasm/vision_wasm_internal.js", wasm: MP + "/wasm/vision_wasm_internal.wasm", model: MODEL },
];
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],
               [14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const TIPS = new Set([4, 8, 12, 16, 20]);
const SEND_MS = 110;      // hand points -> Python about 9 times a second (each one is a rerun)
const IDLE_MS = 2000;     // no hand: heartbeat only
const MISSES = 3;         // AI frames without a hand before Python hears "hand gone"
const KEYMAP = { ArrowLeft: "KEY_LEFT", ArrowRight: "KEY_RIGHT", ArrowUp: "KEY_UP", ArrowDown: "KEY_DOWN",
                 "+": "ZOOM_IN", "=": "ZOOM_IN", "-": "ZOOM_OUT", "_": "ZOOM_OUT", "0": "FIT",
                 m: "MODE", M: "MODE", c: "RECALIBRATE", C: "RECALIBRATE" };

function el(S, cls) { return S.parent ? S.parent.querySelector("." + cls) : null; }
function setStatus(S, text) { S.statusText = text; const s = el(S, "hc-status"); if (s) s.textContent = text; }
function paint(S) {
  const b = el(S, "hc-start"), p = el(S, "hc-pause");
  if (b) { b.textContent = S.running ? "■ STOP" : (S.busy ? "… STARTING" : "▶ START CAMERA"); b.classList.toggle("on", S.running); }
  if (p) { p.disabled = !S.running; p.textContent = S.paused ? "▶ RESUME" : "Ⅱ PAUSE"; }
}

// ---------------------------------------------------------------- MediaPipe (Web Worker first)
function workerMain() {
  let det = null;
  self.onmessage = async (ev) => {
    const m = ev.data;
    if (m.type === "init") {
      let lastError = "no source";
      try {
        const v = await import(m.mp + "/vision_bundle.mjs");
        for (const src of m.sources) {
          const files = { wasmLoaderPath: src.loader, wasmBinaryPath: src.wasm };
          const opts = (d) => ({ baseOptions: { modelAssetPath: src.model, delegate: d }, runningMode: "VIDEO", numHands: 1,
                                 minHandDetectionConfidence: 0.65, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.5 });
          let delegate = "GPU";
          try {
            try { det = await v.HandLandmarker.createFromOptions(files, opts("GPU")); }
            catch (e) { delegate = "CPU"; det = await v.HandLandmarker.createFromOptions(files, opts("CPU")); }
          } catch (e) { lastError = String((e && e.message) || e); continue; }
          try { det.detectForVideo(new ImageData(320, 240), 1); } catch (e) { /* warm-up */ }
          self.postMessage({ type: "ready", delegate, local: src === m.sources[0] });
          return;
        }
      } catch (e) { lastError = String((e && e.message) || e); }
      self.postMessage({ type: "error", message: lastError });
    } else if (m.type === "frame") {
      const out = { type: "result", hands: [] };
      try {
        const r = det.detectForVideo(m.bitmap, m.ts);
        const hd = r.handedness || r.handednesses || [];
        out.hands = (r.landmarks || []).map((lm, i) => ({ lm: lm.map((p) => ({ x: p.x, y: p.y })),
          score: (hd[i] && hd[i][0] && hd[i][0].score) || 1, side: (hd[i] && hd[i][0] && hd[i][0].categoryName) || "" }));
      } catch (e) { out.error = String(e); }
      if (m.bitmap && m.bitmap.close) m.bitmap.close();
      self.postMessage(out);
    }
  };
}

async function makeDetector(S) {
  const v = await import(MP + "/vision_bundle.mjs");
  let lastError = null;
  for (const src of SOURCES) {
    const files = { wasmLoaderPath: src.loader, wasmBinaryPath: src.wasm };
    const opts = (d) => ({ baseOptions: { modelAssetPath: src.model, delegate: d }, runningMode: "VIDEO", numHands: 1,
                           minHandDetectionConfidence: 0.65, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.5 });
    try {
      try { const d = await v.HandLandmarker.createFromOptions(files, opts("GPU")); S.delegate = "GPU"; return d; }
      catch (e) { S.delegate = "CPU"; return await v.HandLandmarker.createFromOptions(files, opts("CPU")); }
    } catch (e) { lastError = e; }
  }
  throw lastError;
}

function makeWorker(S) {
  return new Promise((resolve) => {
    let w = null;
    const fail = () => { clearTimeout(timer); if (w) w.terminate(); resolve(null); };
    const timer = setTimeout(fail, 90000);
    try {
      const url = URL.createObjectURL(new Blob(["(" + workerMain.toString() + ")()"], { type: "text/javascript" }));
      w = new Worker(url);
    } catch (e) { fail(); return; }
    w.onerror = fail;
    w.onmessage = (ev) => {
      if (ev.data.type !== "ready") { fail(); return; }
      clearTimeout(timer);
      S.delegate = ev.data.delegate + (ev.data.local ? "" : " · CDN");
      w.onmessage = (e2) => onResult(S, e2.data.hands || []);
      w.onerror = () => { S.worker = null; S.workerBusy = false; };
      resolve(w);
    };
    w.postMessage({ type: "init", mp: MP, sources: SOURCES });
  });
}

function onResult(S, hands) {
  S.workerBusy = false;
  if (!S.running || S.paused) return;
  S.aiN++;
  if (hands.length) { S.miss = 0; S.hands = hands; }
  else if (++S.miss >= MISSES) S.hands = [];
  maybeSend(S);
}

// ---------------------------------------------------------------- camera start / stop
async function start(S) {
  if (S.busy || S.running) return;
  S.busy = true; paint(S);
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw { name: "NotSupported", message: "This browser cannot open a camera here (the page must be https or localhost)." };
    setStatus(S, "Opening the camera… allow access if the browser asks.");
    const want = { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } };
    try { S.stream = await navigator.mediaDevices.getUserMedia({ video: { ...want, frameRate: { ideal: 60 } }, audio: false }); }
    catch (e) {
      if (e && (e.name === "NotAllowedError" || e.name === "NotReadableError")) throw e;
      S.stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: false });
    }
    await lockExposure(S);
    if (!S.video) {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
      v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
      document.body.appendChild(v); S.video = v;
    }
    S.video.srcObject = S.stream;
    await S.video.play();
    if (!S.worker && !S.detector) { setStatus(S, "Loading the hand model (first time 5-20 s)…"); S.worker = await makeWorker(S); }
    if (!S.worker && !S.detector) { S.detector = await makeDetector(S); }
    S.running = true; S.paused = false; S.hands = []; S.miss = 0; S.lastSend = 0;
    S.vidN = 0; S.aiN = 0; S.statT = performance.now(); S.fps = 0; S.aiFps = 0;
    setStatus(S, "Camera ON · show your hand");
    requestAnimationFrame(() => renderLoop(S));
    setTimeout(() => detectLoop(S), 0);
    maybeSend(S, true);
  } catch (e) {
    stopTracks(S);
    setStatus(S, e && e.name === "NotAllowedError" ? "Camera permission denied: allow it in the address bar and press START again."
      : e && e.name === "NotReadableError" ? "The camera is busy (Zoom, Teams, another tab…). Close it and press START again."
      : e && e.name === "NotFoundError" ? "No camera was found on this device."
      : "Could not start: " + ((e && (e.message || e.name)) || e));
  } finally { S.busy = false; paint(S); }
}

// Webcams slow down in indoor light (30 -> ~15 FPS). Locking exposure keeps the full frame rate.
async function lockExposure(S) {
  try {
    const t = S.stream.getVideoTracks()[0], c = t.getCapabilities ? t.getCapabilities() : {};
    if (!c.exposureMode || !c.exposureMode.includes("manual") || !c.exposureTime) return;
    const fps = Math.min(60, (c.frameRate && c.frameRate.max) || 30), step = c.exposureTime.step || 1;
    const exp = Math.min(c.exposureTime.max, Math.max(c.exposureTime.min, Math.floor(10000 / fps * 0.94 / step) * step));
    await t.applyConstraints({ advanced: [{ exposureMode: "manual", exposureTime: exp }] });
    S.exposureLocked = true;
  } catch (e) { /* camera without exposure control */ }
}

function stopTracks(S) { if (S.stream) S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }

function stop(S) {
  S.running = false; S.paused = false; S.hands = []; stopTracks(S); paint(S);
  maybeSend(S, true);
  setStatus(S, "Camera is OFF (privacy). Press START CAMERA.");
  drawIdle(S);
}

function togglePause(S) {
  if (!S.running) return;
  S.paused = !S.paused; S.hands = []; paint(S);
  setStatus(S, S.paused ? "Tracking PAUSED · press SPACE to resume" : "Camera ON · show your hand");
  maybeSend(S, true);
}

// ---------------------------------------------------------------- talking to Python
function readState(S) {
  const e = document.querySelector(".hp-state");
  if (!e || e.textContent === S.stateText) return;
  S.stateText = e.textContent;
  try { S.data = JSON.parse(e.textContent); } catch (err) { return; }
  onState(S);
}

function visiblePage(S) {
  const doc = document.querySelector(".hp-doc");
  if (!doc || performance.now() < (S.scrollLockUntil || 0)) return null;
  const top = doc.getBoundingClientRect().top + doc.clientHeight * 0.35;
  let page = null;
  doc.querySelectorAll("[data-page]").forEach((p) => { if (p.getBoundingClientRect().top <= top) page = +p.dataset.page; });
  if (page === null || page === S.reportedPage) return null;
  S.reportedPage = page;
  return page;
}

function maybeSend(S, force) {
  if (!S.trigger) return;
  const now = performance.now();
  readState(S);
  const acked = ((S.data && S.data.ack) || 0) >= (S.seq || 0);
  if (!acked && now - (S.lastSend || 0) < 1500) return;
  const has = S.running && !S.paused && S.hands.length > 0;
  const due = force || S.keys.length || has !== S.hadHand || (has && now - S.lastSend >= SEND_MS) || now - S.lastSend >= IDLE_MS;
  if (!due) return;
  const page = visiblePage(S);
  S.hadHand = has; S.lastSend = now; S.seq = (S.seq || 0) + 1;
  const h = has ? S.hands[0] : null, v = S.video;
  S.trigger("frame", {
    seq: S.seq, t: Math.round(now), running: !!S.running, paused: !!S.paused,
    w: (v && v.videoWidth) || 640, h: (v && v.videoHeight) || 480,
    fps: Math.round(S.fps || 0), ai: Math.round(S.aiFps || 0), delegate: S.delegate || "", light: S.light,
    hand: h ? { lm: h.lm.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4)]), score: +(h.score || 1).toFixed(3) } : null,
    keys: S.keys.splice(0), page,
  });
}

// ---------------------------------------------------------------- effects requested by Python
function overlays(S) {
  if (S.ov && document.body.contains(S.ov.root)) return S.ov;
  const root = document.createElement("div");
  root.className = "hp-ov";
  root.innerHTML = '<div class="hp-flash"><span>❯❯❯</span></div><div class="hp-toast"></div>' +
    '<div class="hp-zoomhud"><span>ZOOM</span><b>100%</b><i><u></u></i></div>' +
    '<div class="hp-phud"><span class="hp-phud-hand"><i></i><b>NO HAND</b></span><span class="hp-phud-page"></span></div>';
  const laser = document.createElement("div");
  laser.className = "hp-laser";
  document.body.append(root, laser);
  S.ov = { root, laser, flash: root.querySelector(".hp-flash"), glyph: root.querySelector(".hp-flash span"),
           toast: root.querySelector(".hp-toast"), zoom: root.querySelector(".hp-zoomhud"),
           zoomVal: root.querySelector(".hp-zoomhud b"), zoomBar: root.querySelector(".hp-zoomhud u"),
           hudHand: root.querySelector(".hp-phud-hand"), hudText: root.querySelector(".hp-phud-hand b"),
           hudPage: root.querySelector(".hp-phud-page") };
  return S.ov;
}

function toast(S, text, kind) {
  const ov = overlays(S);
  ov.toast.textContent = text;
  ov.toast.className = "hp-toast show " + (kind || "");
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => ov.toast.classList.remove("show"), kind === "err" ? 4000 : 1900);
}

function flash(S, action) {
  const ov = overlays(S);
  const zoom = action === "ZOOM_IN" || action === "ZOOM_OUT";
  const rot = { RIGHT: 0, DOWN: 90, LEFT: 180, UP: -90 }[action.replace("POINT_", "").replace("KEY_", "")];
  if (!zoom && rot === undefined) return;
  ov.glyph.textContent = zoom ? (action === "ZOOM_IN" ? "⊕" : "⊖") : action.startsWith("POINT_") ? "☛❯❯" : "❯❯❯";
  ov.flash.style.setProperty("--rot", (zoom ? 0 : rot) + "deg");
  ov.flash.style.setProperty("--from", action === "ZOOM_OUT" ? "1.8" : "0.4");
  ov.flash.style.setProperty("--to", action === "ZOOM_OUT" ? "0.4" : "1.8");
  ov.flash.classList.remove("go", "zoom");
  void ov.flash.offsetWidth;
  ov.flash.classList.add(zoom ? "zoom" : "go");
}

function once(S, key, item, fn) {        // run fn for a new command id; never replay old ones after a reload
  if (!item || item.id === undefined) return;
  if (S.seen[key] === undefined) { S.seen[key] = item.id; return; }
  if (item.id !== S.seen[key]) { S.seen[key] = item.id; fn(item); }
}

function onState(S) {
  const D = S.data, ov = overlays(S);
  once(S, "event", D.event, (e) => { if (e.text) toast(S, e.text, e.kind); if (e.action) flash(S, e.action); });
  once(S, "scroll", D.scroll, (c) => {
    const doc = document.querySelector(".hp-doc"); if (!doc) return;
    S.scrollLockUntil = performance.now() + 900;
    doc.scrollBy({ top: c.axis === "y" ? c.dir * doc.clientHeight * 0.6 : 0,
                   left: c.axis === "x" ? c.dir * doc.clientWidth * 0.35 : 0, behavior: "smooth" });
  });
  once(S, "goto", D.goto, (c) => {
    const go = () => {
      const doc = document.querySelector(".hp-doc"), p = doc && doc.querySelector('[data-page="' + c.page + '"]');
      if (!p) return false;
      S.scrollLockUntil = performance.now() + 900; S.reportedPage = c.page;
      doc.scrollTo({ top: p.offsetTop - 16, behavior: c.smooth === false ? "auto" : "smooth" });
      return true;
    };
    if (!go()) setTimeout(go, 250);   // the page list may still be rendering
  });
  document.querySelectorAll(".hp-doc-page").forEach((p) => p.classList.toggle("current", +p.dataset.page === D.index));
  const zp = D.zoom_preview;
  document.querySelectorAll(".hp-zoomable").forEach((img) => { img.style.transform = zp ? "scale(" + zp + ")" : ""; });
  if (D.zoom_pct) {
    ov.zoom.classList.add("on");
    ov.zoomVal.textContent = D.zoom_pct + "%";
    ov.zoomBar.style.width = Math.max(0, Math.min(100, (D.zoom_pct - 40) / 2.1)) + "%";
    clearTimeout(S.zoomTimer);
    if (!zp) S.zoomTimer = setTimeout(() => ov.zoom.classList.remove("on"), 900);
  }
  ov.hudHand.className = "hp-phud-hand " + (D.hand_state || "");
  ov.hudText.textContent = { on: "HAND READY", locked: "DONE · LOWER HAND", paused: "PAUSED", off: "CAMERA OFF" }[D.hand_state] || "NO HAND";
  ov.hudPage.textContent = D.page_label || "";
}

// ---------------------------------------------------------------- present mode (fullscreen slides)
async function togglePresent(S) {
  if (document.body.classList.contains("hp-presenting")) {
    document.body.classList.remove("hp-presenting");
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    return;
  }
  if (!(S.data && S.data.loaded)) { toast(S, "ADD A FILE FIRST, THEN PRESS PRESENT", "warn"); return; }
  document.body.classList.add("hp-presenting");
  try { await document.documentElement.requestFullscreen(); } catch (e) { /* the page still fills the window */ }
  if (!S.running) start(S); else if (S.paused) togglePause(S);
}

// ---------------------------------------------------------------- loops
function renderLoop(S) {
  if (!S.running) return;
  const v = S.video, c = el(S, "hc-view");
  if (c && v.readyState >= 2 && v.videoWidth) {
    const w = v.videoWidth, h = v.videoHeight;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; S.grid = null; }
    if (v.currentTime !== S.lastDrawn) { S.lastDrawn = v.currentTime; S.vidN++; }
    S.shown = S.hands.map((hand, i) => {
      const prev = S.shown && S.shown[i];
      return hand.lm.map((p, j) => prev ? { x: prev[j].x + (p.x - prev[j].x) * 0.55, y: prev[j].y + (p.y - prev[j].y) * 0.55 } : { x: p.x, y: p.y });
    });
    readState(S);
    draw(S, c, v, w, h);
  }
  effects(S);
  const now = performance.now();
  if (now - S.statT >= 1000) {
    S.fps = S.vidN * 1000 / (now - S.statT); S.aiFps = S.aiN * 1000 / (now - S.statT);
    S.vidN = 0; S.aiN = 0; S.statT = now;
    if (!S.paused) setStatus(S, "Camera ON · video " + Math.round(S.fps) + " FPS · hand AI " + Math.round(S.aiFps) + "/s (" + (S.delegate || "…") + ")");
  }
  requestAnimationFrame(() => renderLoop(S));
}

function effects(S) {
  const D = S.data || {}, ov = overlays(S), hand = S.shown && S.shown[0];
  const wrap = document.querySelector(".hp-stage-wrap");
  if (wrap) {
    const r = wrap.getBoundingClientRect();
    Object.assign(ov.root.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  }
  if (hand) {   // tilt the 3D globe towards the hand
    document.documentElement.style.setProperty("--hp-hx", (0.5 - hand[9].x).toFixed(3));
    document.documentElement.style.setProperty("--hp-hy", (hand[9].y - 0.5).toFixed(3));
  }
  const target = document.querySelector(".hp-zoomable") || document.querySelector(".hp-stage");
  if (D.pose === "laser" && D.laser && hand && target) {
    const r = target.getBoundingClientRect(), cl = (x) => Math.max(0, Math.min(1, x));
    const tx = r.left + cl((1 - hand[8].x - 0.2) / 0.6) * r.width, ty = r.top + cl((hand[8].y - 0.12) / 0.6) * r.height;
    if (!S.laserOn) { S.lx = tx; S.ly = ty; S.laserOn = true; ov.laser.classList.add("on"); }
    S.lx += (tx - S.lx) * 0.5; S.ly += (ty - S.ly) * 0.5;
    ov.laser.style.transform = "translate(" + S.lx.toFixed(1) + "px," + S.ly.toFixed(1) + "px)";
  } else if (S.laserOn) { S.laserOn = false; ov.laser.classList.remove("on"); }
}

function smallFrame(S, v) {
  const sw = 320, sh = Math.round(320 * v.videoHeight / v.videoWidth);
  if (!S.small) S.small = document.createElement("canvas");
  if (S.small.width !== sw || S.small.height !== sh) { S.small.width = sw; S.small.height = sh; }
  const g = S.small.getContext("2d", { willReadFrequently: true });
  g.drawImage(v, 0, 0, sw, sh);
  if ((S.lightN = (S.lightN || 0) + 1) % 30 === 1) {   // brightness check for the low-light hint
    const d = g.getImageData(0, 0, sw, sh).data; let s = 0;
    for (let i = 0; i < d.length; i += 64) s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    S.light = +(s / (d.length / 64) / 255).toFixed(2);
  }
  return S.small;
}

function detectLoop(S) {
  if (!S.running) return;
  const v = S.video, t0 = performance.now();
  if (S.paused) { setTimeout(() => detectLoop(S), 100); return; }
  if (S.worker) {
    if (S.workerBusy && t0 - S.workerSentAt > 3000) S.workerBusy = false;
    if (!S.workerBusy && v.readyState >= 2 && v.videoWidth && v.currentTime !== S.lastAi) {
      S.lastAi = v.currentTime; S.workerBusy = true; S.workerSentAt = t0;
      createImageBitmap(smallFrame(S, v)).then((bmp) => {
        if (!S.worker) { bmp.close(); S.workerBusy = false; return; }
        S.worker.postMessage({ type: "frame", bitmap: bmp, ts: performance.now() }, [bmp]);
      }).catch(() => { S.workerBusy = false; });
    }
    setTimeout(() => detectLoop(S), 15);
    return;
  }
  if (!S.detector) {
    if (!S.loading) { S.loading = true; makeDetector(S).then((d) => { S.detector = d; }).finally(() => { S.loading = false; }); }
    setTimeout(() => detectLoop(S), 200);
    return;
  }
  if (v.readyState >= 2 && v.videoWidth && v.currentTime !== S.lastAi) {
    S.lastAi = v.currentTime;
    let hands = [];
    try {
      const r = S.detector.detectForVideo(smallFrame(S, v), t0), hd = r.handedness || r.handednesses || [];
      hands = (r.landmarks || []).map((lm, i) => ({ lm, score: (hd[i] && hd[i][0] && hd[i][0].score) || 1 }));
    } catch (e) { /* skip one frame */ }
    S.workerBusy = true; onResult(S, hands);
  }
  const took = performance.now() - t0;
  setTimeout(() => detectLoop(S), Math.max(33 - took, took, 4));
}

// ---------------------------------------------------------------- camera panel drawing
function gridBackdrop(S, w, h) {
  if (S.grid && S.grid.width === w && S.grid.height === h) return S.grid;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"), k = w / 640;
  g.fillStyle = "#010a05"; g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(0,255,102,.08)"; g.beginPath();
  for (let x = 0; x <= w; x += 40 * k) { g.moveTo(x, 0); g.lineTo(x, h); }
  for (let y = 0; y <= h; y += 40 * k) { g.moveTo(0, y); g.lineTo(w, y); }
  g.stroke();
  g.strokeStyle = "rgba(0,255,102,.25)"; g.beginPath(); g.arc(w / 2, h / 2, 60 * k, 0, 7);
  g.moveTo(w / 2 - 80 * k, h / 2); g.lineTo(w / 2 + 80 * k, h / 2); g.moveTo(w / 2, h / 2 - 80 * k); g.lineTo(w / 2, h / 2 + 80 * k); g.stroke();
  g.fillStyle = "rgba(0,255,102,.45)"; g.font = 13 * k + "px 'Share Tech Mono', monospace"; g.textAlign = "center";
  g.fillText("PRIVACY MODE · HAND SIGNAL ONLY", w / 2, h - 16 * k);
  return (S.grid = c);
}

function draw(S, c, v, w, h) {
  const g = c.getContext("2d"), D = S.data || {}, mirror = D.mirror !== false, k = w / 640;
  if (D.show_video) {
    g.save(); if (mirror) { g.translate(w, 0); g.scale(-1, 1); } g.drawImage(v, 0, 0, w, h); g.restore();
    g.fillStyle = "rgba(0,40,14,.16)"; g.fillRect(0, 0, w, h);
  } else {
    g.drawImage(gridBackdrop(S, w, h), 0, 0);
  }
  if (S.paused) {
    g.fillStyle = "rgba(0,0,0,.55)"; g.fillRect(0, h / 2 - 28 * k, w, 56 * k);
    g.fillStyle = "#ffc94d"; g.font = "bold " + 22 * k + "px Orbitron, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("TRACKING PAUSED", w / 2, h / 2); g.textBaseline = "alphabetic";
    return;
  }
  const hand = S.shown && S.shown[0];
  if (!hand) return;
  const fx = (x) => (mirror ? 1 - x : x) * w;
  const hud = D.hud || {};
  if (hud.origin && hud.point) {   // dead zone (selfie coordinates from Python)
    const sx = (x) => (mirror ? x : 1 - x) * w, rgb = hud.armed ? "0,255,102" : "255,201,77";
    const ox = sx(hud.origin[0]), oy = hud.origin[1] * h, px = sx(hud.point[0]), py = hud.point[1] * h;
    const tw = hud.threshold * w, th = hud.threshold * h;
    g.lineWidth = 1.5 * k; g.setLineDash([6 * k, 6 * k]); g.strokeStyle = "rgba(" + rgb + ",.75)";
    g.strokeRect(ox - tw, oy - th, tw * 2, th * 2); g.setLineDash([]);
    g.strokeStyle = "rgba(" + rgb + ",.95)"; g.lineWidth = 2 * k; g.beginPath(); g.moveTo(ox, oy); g.lineTo(px, py); g.stroke();
    g.fillStyle = "rgb(" + rgb + ")"; g.beginPath(); g.arc(px, py, 6 * k, 0, 7); g.fill();
  }
  if (D.skeleton === false) return;
  const P = hand.map((p) => [fx(p.x), p.y * h]);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [x, y] of P) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const pad = 18 * k, cc = 16 * k; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  g.strokeStyle = "rgba(0,255,102,.9)"; g.lineWidth = 2 * k; g.beginPath();
  g.moveTo(x0, y0 + cc); g.lineTo(x0, y0); g.lineTo(x0 + cc, y0); g.moveTo(x1 - cc, y0); g.lineTo(x1, y0); g.lineTo(x1, y0 + cc);
  g.moveTo(x1, y1 - cc); g.lineTo(x1, y1); g.lineTo(x1 - cc, y1); g.moveTo(x0 + cc, y1); g.lineTo(x0, y1); g.lineTo(x0, y1 - cc); g.stroke();
  const pose = { "point-left": " · POINT ◀", "point-right": " · POINT ▶", pinch: " · PINCH", laser: " · LASER" }[hud.pose] || "";
  g.font = 13 * k + "px 'Share Tech Mono', monospace"; g.fillStyle = "#00ff66"; g.textAlign = "left";
  g.fillText("HAND · " + Math.round((S.hands[0] ? S.hands[0].score : 1) * 100) + "%" + pose + (hud.locked ? " · DONE" : ""), x0, y0 - 6 * k);
  g.save(); g.shadowColor = "#00ff66"; g.shadowBlur = 10 * k; g.strokeStyle = "rgba(0,255,120,.95)"; g.lineWidth = 3 * k; g.lineCap = "round";
  g.beginPath(); for (const [a, b] of BONES) { g.moveTo(P[a][0], P[a][1]); g.lineTo(P[b][0], P[b][1]); } g.stroke(); g.restore();
  P.forEach((p, i) => { g.beginPath(); g.arc(p[0], p[1], (TIPS.has(i) ? 5 : 3.2) * k, 0, 7); g.fillStyle = TIPS.has(i) ? "#eaffef" : "#00ff66"; g.fill(); });
}

function drawIdle(S) {
  const c = el(S, "hc-view"); if (!c) return;
  const g = c.getContext("2d");
  g.fillStyle = "#010a05"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#00ff66"; g.font = "bold 22px Orbitron, sans-serif"; g.textAlign = "center";
  g.fillText("CAMERA OFFLINE", c.width / 2, c.height / 2 - 6);
  g.fillStyle = "#69b886"; g.font = "16px Rajdhani, sans-serif"; g.fillText("Press START CAMERA", c.width / 2, c.height / 2 + 24);
}

// ---------------------------------------------------------------- page-wide helpers (installed once)
function installGlobal() {
  if (window.__hpGlobal) return;
  window.__hpGlobal = true;
  document.addEventListener("keydown", (e) => {
    const S = window.__hpCam;
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && t.closest && t.closest("input, textarea, select, [contenteditable='true']")) return;
    if (e.key === "Escape") { document.body.classList.remove("hp-presenting"); return; }
    if (e.key === "p" || e.key === "P" || e.key === "f" || e.key === "F") { togglePresent(S); e.preventDefault(); return; }
    if (e.key === " ") { togglePause(S); e.preventDefault(); return; }
    if (KEYMAP[e.key]) { S.keys.push(KEYMAP[e.key]); maybeSend(S, true); e.preventDefault(); }
  }, true);
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) document.body.classList.remove("hp-presenting"); });
  setInterval(() => {                                   // heartbeat, pending keys, scroll reports, clock
    const S = window.__hpCam; if (!S) return;
    readState(S);
    if (!S.running) effects(S);
    maybeSend(S, false);
    const clock = new Date().toLocaleTimeString([], { hour12: false });
    document.querySelectorAll(".hp-clock").forEach((c) => { if (c.textContent !== clock) c.textContent = clock; });
  }, 120);
}

export default function (component) {
  const { parentElement, setStateValue } = component;
  const S = (window.__hpCam = window.__hpCam || { keys: [], seen: {}, hands: [], shown: [], data: {} });
  S.parent = parentElement; S.trigger = setStateValue;
  installGlobal();
  const wire = (cls, fn) => { const b = el(S, cls); if (b && !b.__wired) { b.__wired = true; b.addEventListener("click", fn); } };
  wire("hc-start", () => (S.running ? stop(S) : start(S)));
  wire("hc-pause", () => togglePause(S));
  wire("hc-present", () => togglePresent(S));
  paint(S);
  if (S.statusText) setStatus(S, S.statusText);
  if (!S.running) drawIdle(S);
  readState(S);
}
""".replace("__MP__", MP_VERSION)

_COMPONENT = st.components.v2.component("hand_presenter_camera", html=_HTML, css=_CSS, js=_JS)


def hand_camera() -> dict | None:
    """Show the camera panel; return the newest message from the browser (or None)."""
    result = _COMPONENT(key="hand_presenter_camera", data={}, on_frame_change=lambda: None)
    frame = result.get("frame") if hasattr(result, "get") else getattr(result, "frame", None)
    return frame or None
