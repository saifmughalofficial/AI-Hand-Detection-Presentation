// AI Hand Detection Presentation — application controller.
import { Scene3D } from "./scene3d.js";
import { MatrixRain } from "./matrix.js";
import { HandEngine, insecureCameraHint } from "./hand.js";
import { Viewer, loadPdfEngine } from "./viewer.js";
import { addRecent, getRecent, listRecent, removeRecent } from "./recent.js";

const $ = (id) => document.getElementById(id);
const body = document.body;
// Streamlit serves this page as a component and adds ?streamlitUrl=... to its address.
const streamlitHost = new URLSearchParams(location.search).has("streamlitUrl");
// The local launcher (main.py) provides /api/* on the same origin. Under Streamlit, app.py starts
// the same converter on 127.0.0.1 and passes its address in the component arguments.
const serverMode = !streamlitHost && (location.protocol === "http:" || location.protocol === "https:");
let converterBase = serverMode ? "" : null;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "bmp", "webp", "gif"]);
const OFFICE_EXT = new Set(["pptx", "ppt", "ppsx", "pps", "odp", "docx", "doc", "odt", "rtf"]);
const extOf = (file) => (file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "");
const TRANSITIONS = ["auto", "cube", "flip", "push", "zoom", "hologram", "orbit", "door", "portal", "glitch", "shatter", "mix"];

// ------------------------------------------------------------------ settings

const SETTINGS_KEY = "ahdp.settings.v5";
const DEFAULTS = {
  sens: 72, smooth: 25, cool: 350, res: "640x480", fps: "60", zoom: "pinch", fx: "auto",
  upDown: true, skeleton: true, mirror: true, exposure: true, pip: false,
  once: true, point: true, laser: true, camera: "", mode: "slide",
  transition: "auto", detect: "turbo", flick: true, auto: true,
};
const settings = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
})();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

// ------------------------------------------------------------------ log, status, feedback

const logEl = $("log");
function log(message, level = "info") {
  const line = document.createElement("div");
  line.className = level;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  line.textContent = `${time} [${level.toUpperCase()}] ${message}`;
  logEl.append(line);
  while (logEl.childElementCount > 80) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(message) {
  $("status").textContent = message;
  updateStatusRight();
}

function trackingOn() {
  return hand.running && !hand.paused;
}

function updateStatusRight() {
  const s = viewer.state();
  const page = !s.loaded ? "NO FILE" : s.kind === "html" ? "DOCUMENT" : `PAGE ${s.index + 1}/${s.count}`;
  setText($("statusRight"), `MODE: ${settings.mode === "slide" ? "SLIDE" : "DOCUMENT"} · FX: ${settings.transition.toUpperCase()} · TRACKING: ${trackingOn() ? "ON" : "OFF"} · ${page}`);
}

let toastTimer = 0;
function toast(message, kind = "", ms = 1800) {
  const t = $("toast");
  t.textContent = message;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function restartAnimation(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function flashDirection(action) {
  if (reduceMotion) return;
  const el = $("dirFlash");
  const zoom = action === "ZOOM_IN" || action === "ZOOM_OUT";
  const pointed = action.startsWith("POINT_");
  const rot = { RIGHT: 0, DOWN: 90, LEFT: 180, UP: -90 }[action.replace("POINT_", "")];
  if (!zoom && rot === undefined) return;
  $("dirGlyph").textContent = zoom ? (action === "ZOOM_IN" ? "⊕" : "⊖") : pointed ? "☛❯❯" : "❯❯❯";
  el.style.setProperty("--rot", `${zoom ? 0 : rot}deg`);
  el.style.setProperty("--from", action === "ZOOM_OUT" ? "1.8" : "0.4");
  el.style.setProperty("--to", action === "ZOOM_OUT" ? "0.4" : "1.8");
  el.classList.remove("go", "zoom");
  void el.offsetWidth;
  el.classList.add(zoom ? "zoom" : "go");
  // A light sweep along the screen edge the hand moved toward.
  const edge = $("edgeFlash");
  edge.dataset.dir = zoom ? "center" : action.replace("POINT_", "").toLowerCase();
  restartAnimation(edge, "on");
  restartAnimation($("stage"), "pulse");
}

function updatePresentHud(handState) {
  const el = $("hudHand");
  if (handState !== undefined) {
    el.classList.toggle("on", handState === "on");
    el.classList.toggle("paused", handState === "paused");
    el.classList.toggle("locked", handState === "locked");
    setText($("hudHandText"), {
      on: "HAND READY", locked: "DONE · LOWER HAND", paused: "PAUSED", off: "CAMERA OFF",
    }[handState] || "NO HAND");
  }
  const s = viewer.state();
  setText($("hudPage"), s.loaded && s.kind !== "html" ? `${pad(s.index + 1)} / ${pad(s.count)}` : "-- / --");
}

function showLoader(text) {
  $("loaderText").textContent = text;
  $("loader").hidden = false;
}
function hideLoader() {
  $("loader").hidden = true;
}

// ------------------------------------------------------------------ core objects

let scene = null;
let matrix = null;
let converters = [];

const viewer = new Viewer({
  stage: $("stage"),
  slideView: $("slideView"),
  docView: $("docView"),
  docPages: $("docPages"),
  onChange: onViewerChange,
  onError: (err) => log(`Render error: ${err.message}`, "err"),
});
viewer.mode = settings.mode;
viewer.transition = settings.transition;

const hand = new HandEngine({
  video: $("video"),
  canvas: $("camCanvas"),
  onResult: onHandResult,
  onStats: onHandStats,
  onEnded: () => {
    camUI("err", "CAMERA DISCONNECTED", "The camera was unplugged or taken by another app. Press START CAMERA.");
    log("Camera stream ended unexpectedly.", "warn");
    setStatus("Camera disconnected.");
  },
  onNotice: (message) => log(message, "warn"),
});

// ------------------------------------------------------------------ viewer

let shownIndex = -1;
function onViewerChange(s) {
  body.classList.toggle("has-doc", s.loaded);
  scene?.setBackground(s.loaded);
  if (s.loaded && s.index !== shownIndex && !reduceMotion) {
    requestAnimationFrame(() => ["pageInfo", "hudPage"].forEach((id) => restartAnimation($(id), "pop")));
  }
  shownIndex = s.loaded ? s.index : -1;
  $("home").hidden = s.loaded;
  setText($("fileName"), s.loaded ? s.name : "NO FILE LOADED");
  const label = s.kind === "images" ? "IMAGE" : "PAGE";
  setText($("pageInfo"), !s.loaded ? "PAGE -- / --" : s.kind === "html" ? "DOCUMENT" : `${label} ${pad(s.index + 1)} / ${pad(s.count)}`);
  const pct = s.loaded && s.kind !== "html" && s.count ? `${((s.index + 1) / s.count) * 100}%` : s.loaded ? "100%" : "0";
  $("progressBar").style.width = pct;
  $("presentBar").style.width = pct;
  setText($("zoomVal"), `${Math.round(s.zoom * 100)}%`);
  for (const id of ["btnPrev", "btnNext", "btnZoomOut", "btnZoomIn", "btnFit", "btnClose", "btnGrid"]) $(id).disabled = !s.loaded;
  if (s.loaded && s.kind !== "html") {
    $("btnPrev").disabled = s.index === 0;
    $("btnNext").disabled = s.index >= s.count - 1;
  } else {
    $("btnGrid").disabled = true;
  }
  if (!s.loaded) closeGrid();
  updateModeUI();
  updateStatusRight();
  updatePresentHud();
}

function updateModeUI() {
  for (const b of $("modeSeg").querySelectorAll("button")) {
    const active = b.dataset.mode === settings.mode;
    b.classList.toggle("active", active);
    b.setAttribute("aria-checked", String(active));
  }
}

function navigate(dir, motion) {
  if (!viewer.loaded) {
    setStatus("Open a PDF to use page navigation.");
    return false;
  }
  const result = viewer.go(dir, motion);
  if (result === "edge") {
    toast(dir > 0 ? "LAST PAGE REACHED" : "FIRST PAGE REACHED", "warn");
    setStatus(dir > 0 ? "Already on the last page." : "Already on the first page.");
    return false;
  }
  setStatus(dir > 0 ? "Next page" : "Previous page");
  return true;
}

function scrollDocument(dir) {
  if (settings.mode === "document" || viewer.state().kind === "html") {
    if (viewer.scroll(dir)) setStatus("Document scroll command");
  } else if (viewer.loaded) {
    navigate(dir > 0 ? 1 : -1, dir > 0 ? "up" : "down");
  }
}

function zoomBy(delta) {
  if (!viewer.loaded) {
    setStatus("Open a file to use zoom.");
    return;
  }
  viewer.setZoom(viewer.zoom + delta);
  setStatus(`Zoom: ${Math.round(viewer.zoom * 100)}%`);
}

function setMode(mode) {
  settings.mode = mode;
  saveSettings();
  viewer.setMode(mode);
  updateModeUI();
  setStatus(`Mode: ${mode === "slide" ? "Slide Mode" : "Document Mode"} • Tracking: ${trackingOn() ? "On" : "Off"}`);
  if (viewer.state().kind === "html" && mode === "slide") toast("WORD FALLBACK VIEW SCROLLS AS A DOCUMENT", "warn", 2600);
}

function setTransition(name, announce = true) {
  settings.transition = TRANSITIONS.includes(name) ? name : "auto";
  saveSettings();
  viewer.transition = settings.transition;
  for (const b of $("transGrid").querySelectorAll("button")) {
    const active = b.dataset.t === settings.transition;
    b.classList.toggle("active", active);
    b.setAttribute("aria-checked", String(active));
  }
  setText($("transName"), settings.transition.toUpperCase());
  updateStatusRight();
  if (announce) {
    toast(`SLIDE ANIMATION · ${settings.transition.toUpperCase()}`);
    log(`Slide animation: ${settings.transition}.`);
  }
}

/** Plays a transition on the current slide without changing page (the TEST buttons). */
function previewTransition(motion) {
  if (!viewer.loaded || viewer.effectiveMode !== "slide") {
    toast("ADD A FILE IN SLIDE MODE TO PREVIEW ANIMATIONS", "warn", 2400);
    return;
  }
  viewer._showSlide(1, motion);
  flashDirection({ left: "LEFT", right: "RIGHT", up: "UP", down: "DOWN", in: "ZOOM_IN", out: "ZOOM_OUT" }[motion]);
}

async function openFiles(files, { remember = true } = {}) {
  if (!files.length) return;
  const exts = files.map(extOf);
  const name = files.length > 1 ? `${files.length} files` : files[0].name;
  showLoader("LOADING");
  try {
    if (files.length > 1 && exts.every((e) => IMAGE_EXT.has(e))) {
      await viewer.openImages(files);
    } else {
      const file = files[0];
      const ext = exts[0];
      if (ext === "pdf") await viewer.openPdf(await file.arrayBuffer(), file.name);
      else if (IMAGE_EXT.has(ext)) await viewer.openImages([file]);
      else if (OFFICE_EXT.has(ext)) await openOffice(file, ext);
      else throw new Error(`Unsupported file type ".${ext}". Use PDF, PowerPoint, Word or an image.`);
      if (files.length > 1) log("Several files were selected; opened the first one. Select only images to build a slideshow.", "warn");
      if (remember) addRecent(file).then(refreshRecent).catch(() => {});
    }
    const s = viewer.state();
    log(`Loaded ${s.name} · ${s.kind === "html" ? "document" : `${s.count} page(s)`}`, "ok");
    setStatus(`Loaded: ${s.name} · press PRESENT (P) for full-screen hand control`);
    toast(`LOADED · ${s.name.toUpperCase()}`);
    scene?.pulse("LOAD");
  } catch (err) {
    log(`Could not open ${name}: ${err.message}`, "err");
    toast("COULD NOT OPEN FILE — SEE DATA STREAM", "err", 4000);
    setStatus(`Could not open file: ${err.message}`);
  } finally {
    hideLoader();
  }
}

async function openOffice(file, ext) {
  showLoader(`CONVERTING ${ext.toUpperCase()} → PDF LOCALLY`);
  log(`Converting ${file.name} to PDF on this PC…`);
  try {
    if (converterBase === null) {
      throw new Error(streamlitHost
        ? "Office conversion needs this app running on your own PC (streamlit run app.py); export the file to PDF first"
        : "the converter needs the launcher (python main.py)");
    }
    const res = await fetch(`${converterBase}/api/convert?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "X-Requested-With": "hand-presenter", "Content-Type": "application/octet-stream" },
      body: file,
    });
    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      throw new Error(info.error || `HTTP ${res.status}`);
    }
    await viewer.openPdf(await res.arrayBuffer(), file.name);
  } catch (err) {
    if (ext !== "docx") throw new Error(`Conversion failed: ${err.message}`);
    log(`Exact conversion unavailable (${err.message}). Using built-in Word reader.`, "warn");
    showLoader("READING WORD DOCUMENT");
    await loadScript("vendor/mammoth.browser.min.js");
    const { value } = await window.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    viewer.openHtml(value, file.name);
    toast("SIMPLIFIED WORD LAYOUT · INSTALL LIBREOFFICE FOR EXACT PAGES", "warn", 3500);
  }
}

function loadScript(src) {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}

function closeFile() {
  if (!viewer.loaded) return;
  viewer.close();
  setStatus("File closed. Choose a PDF or image to begin.");
  log("File closed.");
}

// ------------------------------------------------------------------ recent files

async function refreshRecent() {
  let items = [];
  try {
    items = await listRecent();
  } catch {
    return; // IndexedDB unavailable (private window): no recent list
  }
  const list = $("recentList");
  list.replaceChildren(...items.map((it) => {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "recent-open";
    open.title = `Open ${it.name}`;
    open.textContent = it.name;
    open.addEventListener("click", async () => {
      const file = await getRecent(it.name).catch(() => null);
      if (file) openFiles([file]);
      else refreshRecent();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "recent-del";
    del.title = "Remove from recent files";
    del.setAttribute("aria-label", `Remove ${it.name}`);
    del.textContent = "✕";
    del.addEventListener("click", () => removeRecent(it.name).then(refreshRecent));
    li.append(open, del);
    return li;
  }));
  $("recentPanel").hidden = items.length === 0;
}

// ------------------------------------------------------------------ slide grid

let gridToken = 0;
async function openGrid() {
  const s = viewer.state();
  if (!s.loaded || s.kind === "html") return;
  const token = ++gridToken;
  const items = $("gridItems");
  items.replaceChildren();
  $("gridView").hidden = false;
  body.classList.add("grid-open");
  const cells = Array.from({ length: s.count }, (_, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `grid-cell${i === s.index ? " current" : ""}`;
    b.style.animationDelay = `${Math.min(i, 24) * 22}ms`;
    const num = document.createElement("span");
    num.textContent = pad(i + 1);
    b.append(num);
    b.addEventListener("click", () => {
      closeGrid();
      viewer.goTo(i);
    });
    items.append(b);
    return b;
  });
  for (let i = 0; i < cells.length; i++) {
    const c = await viewer.thumbnail(i).catch(() => null);
    if (token !== gridToken) return;
    if (c) cells[i].prepend(c);
  }
}

function closeGrid() {
  gridToken++;
  $("gridView").hidden = true;
  body.classList.remove("grid-open");
}

function toggleGrid() {
  if ($("gridView").hidden) openGrid();
  else closeGrid();
}

// ------------------------------------------------------------------ camera & gestures

const STATE_TEXT = {
  "NO HAND": ["NO HAND", "Show your hand to the camera"],
  LOCKING: ["LOCKING", "Hold your hand still…"],
  READY: ["READY", "Move your hand to control"],
  STILL: ["STILL", "Hand still · no action"],
  "RE-ARM": ["RE-ARM", "Pause your hand briefly"],
  RETURN: ["RETURN", "Return stroke ignored"],
  CONFIRM: ["CONFIRM", "Swipe detected · confirming"],
  DIAGONAL: ["DIAGONAL", "Move straight left, right, up or down"],
  COOLDOWN: ["COOLDOWN", "Waiting before next action"],
  LOCKED: ["DONE", "Lower your hand, then show it again"],
  POINT: ["POINTING", "Hold to confirm"],
  PINCH: ["PINCH", "Move up / down to zoom"],
  LASER: ["LASER", "Point at the slide"],
};

function setMoveState(main, sub) {
  setText($("moveVal"), main);
  setText($("moveSub"), sub);
}

function camUI(state, title, text, fixUrl) {
  const pill = $("camPill");
  pill.className = `pill ${state === "live" ? "live" : state === "paused" ? "paused" : state === "err" ? "err" : ""}`;
  pill.textContent = { live: "LIVE", paused: "PAUSED", err: "ERROR", starting: "STARTING" }[state] || "OFFLINE";
  $("camBox").classList.toggle("live", state === "live" || state === "paused");
  body.classList.toggle("cam-live", state === "live" || state === "paused");
  const off = $("camOff");
  off.classList.toggle("err", state === "err");
  if (title) $("camOffTitle").textContent = title;
  if (text) $("camOffText").textContent = text;
  const fix = $("camFix");
  fix.hidden = !fixUrl;
  if (fixUrl) fix.href = fixUrl;
  $("btnStart").disabled = state === "live" || state === "paused" || state === "starting";
  $("btnPause").textContent = state === "paused" ? "▶ Resume" : "Ⅱ Pause";
  if (state !== "live" && state !== "paused") {
    for (const id of ["stCam", "stAi", "stLat", "stConf", "stLight"]) setText($(id), "--");
    setText($("camRate"), "--");
    $("compass").className = "compass idle";
  }
  lastHudState = "";
  finishZoomGesture();
  hideLaser();
  updatePresentHud(state === "paused" ? "paused" : state === "live" ? "none" : "off");
  updateStatusRight();
}

let starting = false;
async function startCamera() {
  if (hand.running || starting) {
    if (hand.running) setStatus("Camera is already running.");
    return;
  }
  starting = true;
  camUI("starting", "STARTING CAMERA", "Requesting webcam access…");
  try {
    if (!hand.ready) {
      setMoveState("LOADING", "Loading the hand model…");
      camUI("starting", "LOADING HAND MODEL", "Downloading the hand model, the camera starts right after…");
      await hand.init();
    }
    const [width, height] = settings.res.split("x").map(Number);
    const info = await hand.start({ deviceId: settings.camera, width, height, fps: Number(settings.fps) });
    camUI("live");
    setText($("camRes"), `${info.width}×${info.height}`);
    log(`Camera online: ${info.label} · ${info.width}×${info.height} @ ${info.fps || "?"} FPS`, "ok");
    if (info.maxFps && info.maxFps < Number(settings.fps)) {
      log(`This camera's hardware maximum is ${info.maxFps} FPS (${settings.fps} requested), so it runs at its maximum. The hand HUD still animates at 60 FPS.`, "warn");
    } else if (info.fps >= 59) {
      log("60 FPS camera mode active.", "ok");
    }
    if (info.exposureMs) log(`Exposure locked at ${info.exposureMs.toFixed(1)} ms so the camera keeps its full frame rate.`, "ok");
    setMoveState("LOCKING", "Hold your hand still…");
    setStatus("Camera started. Hold your hand still briefly to calibrate.");
    refreshCameras().catch(() => {});
  } catch (err) {
    camUI("err", "CAMERA ERROR", err.message, err.url);
    setMoveState("ERROR", "Camera unavailable");
    log(err.message, "err");
    toast("CAMERA ERROR — SEE HAND SIGNAL PANEL", "err", 4000);
    setStatus(err.message);
  } finally {
    starting = false;
  }
}

function stopCamera() {
  if (!hand.running) {
    setStatus("Camera is not running.");
    return;
  }
  hand.stop();
  camUI("off", "CAMERA OFFLINE", "Press START CAMERA");
  setMoveState("WAITING", "Start the camera to begin");
  scene?.setHand(null, false);
  setStatus("Camera stopped.");
  log("Camera stopped.");
}

function toggleTracking() {
  if (!hand.running) {
    setStatus("Start the camera first.");
    return;
  }
  hand.setPaused(!hand.paused);
  camUI(hand.paused ? "paused" : "live");
  setMoveState(hand.paused ? "PAUSED" : "LOCKING", hand.paused ? "Press SPACE to resume" : "Hold your hand still…");
  setStatus(hand.paused ? "Tracking paused." : "Tracking resumed.");
  log(hand.paused ? "Tracking paused." : "Tracking resumed.");
}

function recalibrate() {
  hand.controller.reset();
  setMoveState("LOCKING", "Hold your hand still…");
  setStatus("Recalibrating: keep your hand still briefly.");
  log("Recalibrating neutral hand position.");
}

async function restartCamera() {
  if (!hand.running) return;
  hand.stop();
  await startCamera();
}

/** Starts the camera by itself once permission is granted (also when granted later). */
async function watchCameraPermission() {
  if (insecureCameraHint()) {
    const hint = insecureCameraHint();
    camUI("err", "CAMERA BLOCKED ON THIS ADDRESS", hint.message, hint.url);
    log(hint.message, "err");
    return;
  }
  let status = null;
  try {
    status = await navigator.permissions.query({ name: "camera" });
    status.addEventListener("change", () => {
      if (status.state === "granted" && settings.auto && !hand.running) startCamera();
    });
  } catch { /* Permissions API without camera support */ }
  if (settings.auto && status?.state !== "denied") startCamera();
  else if (status?.state === "denied") {
    camUI("err", "CAMERA BLOCKED", "Camera permission is blocked for this page. Click the camera icon in the address bar → Allow, then press START CAMERA.");
  }
}

let actionHoldUntil = 0;
let lastHudState = "";

// ---- pinch zoom: live CSS preview while pinching, crisp re-render on release
const pinch = { start: null, target: null, hideTimer: 0 };

function showZoomHud(z) {
  const hud = $("zoomHud");
  hud.classList.add("on");
  setText($("zoomHudVal"), `${Math.round(z * 100)}%`);
  $("zoomHudBar").style.width = `${((z - 0.4) / (2.5 - 0.4)) * 100}%`;
  clearTimeout(pinch.hideTimer);
}

function onZoomGesture(zoom) {
  if (zoom.phase === "start") {
    pinch.start = viewer.zoom;
    log("Pinch zoom: move your pinched hand up to zoom in, down to zoom out.");
  }
  if (pinch.start === null) return;
  pinch.target = viewer.previewZoom(pinch.start * zoom.factor);
  showZoomHud(pinch.target);
  setText($("zoomVal"), `${Math.round(pinch.target * 100)}%`);
  setMoveState("ZOOM", `${Math.round(pinch.target * 100)}% · open fingers to finish`);
  if (zoom.phase === "end") finishZoomGesture();
}

function finishZoomGesture() {
  if (pinch.start === null) return;
  const z = pinch.target ?? pinch.start;
  pinch.start = null;
  viewer.setZoom(z, false);
  setStatus(`Pinch zoom → ${Math.round(viewer.zoom * 100)}%`);
  log(`Pinch zoom set to ${Math.round(viewer.zoom * 100)}%.`, "ok");
  pinch.hideTimer = setTimeout(() => $("zoomHud").classList.remove("on"), 700);
}

// ---- laser pointer: index finger pointing up
const laser = { x: 0, y: 0, on: false, timer: 0 };

function showLaser(tip) {
  const r = $("stage").getBoundingClientRect();
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  // The central part of the camera view maps to the whole slide, so small finger moves are enough.
  const tx = clamp01((tip.x - 0.2) / 0.6) * r.width;
  const ty = clamp01((tip.y - 0.12) / 0.6) * r.height;
  if (!laser.on) {
    laser.x = tx;
    laser.y = ty;
    laser.on = true;
    $("laser").classList.add("on");
  } else {
    laser.x += (tx - laser.x) * 0.5;
    laser.y += (ty - laser.y) * 0.5;
  }
  $("laser").style.transform = `translate(${laser.x.toFixed(1)}px, ${laser.y.toFixed(1)}px)`;
  clearTimeout(laser.timer);
  laser.timer = setTimeout(hideLaser, 250);
}

function hideLaser() {
  laser.on = false;
  $("laser").classList.remove("on");
}
const compassArrows = Object.fromEntries([...$("compass").querySelectorAll(".c-arrow")].map((el) => [el.dataset.dir, el]));

function onHandResult({ event, hand: h, hud }) {
  scene?.setHand(hud.point, Boolean(h));
  const compass = $("compass");
  const dot = $("compassDot");
  const hudDot = $("hudDot");
  if (hud.origin && hud.point && h) {
    const clamp = (v) => Math.max(-1.5, Math.min(1.5, v));
    const dx = clamp((hud.point.x - hud.origin.x) / hud.tx).toFixed(3);
    const dy = clamp((hud.point.y - hud.origin.y) / hud.ty).toFixed(3);
    compass.style.setProperty("--p", hud.progress.toFixed(3));
    dot.style.setProperty("--dx", dx);
    dot.style.setProperty("--dy", dy);
    hudDot.style.setProperty("--dx", dx);
    hudDot.style.setProperty("--dy", dy);
    compass.className = hud.armed ? "compass" : "compass rearm";
  } else {
    dot.style.setProperty("--dx", 0);
    dot.style.setProperty("--dy", 0);
    hudDot.style.setProperty("--dx", 0);
    hudDot.style.setProperty("--dy", 0);
    compass.style.setProperty("--p", 0);
    compass.className = "compass idle";
  }
  setText($("stConf"), h ? `${Math.round(h.score * 100)}%` : "--");
  const hudState = !h ? "none" : hud.locked ? "locked" : "on";
  if (hudState !== lastHudState) {
    lastHudState = hudState;
    updatePresentHud(hudState);
  }

  if (event.zoom) onZoomGesture(event.zoom);
  if (event.laser) showLaser(event.laser);
  if (event.action) {
    handleAction(event.action, event.flick);
    actionHoldUntil = performance.now() + 900;
  } else if (event.state === "ZOOM") {
    actionHoldUntil = 0;
  } else if (performance.now() > actionHoldUntil) {
    const [main, sub] = STATE_TEXT[event.state] || [event.state, ""];
    setMoveState(main, sub);
  }
}

function handleAction(action, flick = false) {
  const s = viewer.state();
  const slide = settings.mode === "slide" && s.kind !== "html";
  let result;
  if (!$("gridView").hidden) closeGrid();
  if (!s.loaded) {
    result = "Add a file to control it";
  } else {
    // In Slide Mode the outgoing slide travels the way the hand moved.
    switch (action) {
      case "LEFT":
        result = slide ? (navigate(-1, "left") ? "Previous slide" : "First slide") : (viewer.pan(-1) ? "Pan left" : "Nothing to pan · zoom in");
        break;
      case "RIGHT":
        result = slide ? (navigate(1, "right") ? "Next slide" : "Last slide") : (viewer.pan(1) ? "Pan right" : "Nothing to pan · zoom in");
        break;
      case "UP":
        if (!slide) result = viewer.scroll(-1) ? "Scroll up" : "Top of document";
        else if (settings.upDown) result = navigate(-1, "up") ? "Previous slide" : "First slide";
        else result = "No action in Slide Mode";
        break;
      case "DOWN":
        if (!slide) result = viewer.scroll(1) ? "Scroll down" : "End of document";
        else if (settings.upDown) result = navigate(1, "down") ? "Next slide" : "Last slide";
        else result = "No action in Slide Mode";
        break;
      case "POINT_RIGHT":
        result = navigate(1, "in") ? (slide ? "Next slide" : "Next page") : "Last page";
        break;
      case "POINT_LEFT":
        result = navigate(-1, "out") ? (slide ? "Previous slide" : "Previous page") : "First page";
        break;
      case "ZOOM_IN":
        zoomBy(0.15);
        result = `Zoom ${Math.round(viewer.zoom * 100)}%`;
        break;
      case "ZOOM_OUT":
        zoomBy(-0.15);
        result = `Zoom ${Math.round(viewer.zoom * 100)}%`;
        break;
      default:
        return;
    }
  }
  const word = action.replace("_", " ");
  setMoveState(word, flick ? `${result} · flick` : result);
  restartAnimation($("moveVal"), "flash");
  const arrow = compassArrows[action.replace("POINT_", "")];
  if (arrow) {
    arrow.classList.add("hit");
    setTimeout(() => arrow.classList.remove("hit"), 450);
  }
  toast(`HAND ${word} → ${result.toUpperCase()}`);
  flashDirection(action);
  setStatus(`Hand moved ${word.toLowerCase()} → ${result}`);
  log(`Gesture ${word}${flick ? " (flick)" : ""} → ${result}`, "ok");
  scene?.pulse(action);
}

let lastStats = null;
let lowLightWarned = false;
function onHandStats(s) {
  lastStats = s;
  const max = s.track?.maxFps;
  setText($("stCam"), `${Math.round(s.camFps)}${max ? `/${max}` : ""}`);
  setText($("stAi"), hand.paused ? "--" : Math.round(s.aiFps).toString());
  setText($("stLat"), s.latency && !hand.paused ? `${Math.round(s.latency)}ms` : "--");
  setText($("stEngine"), s.delegate);
  setText($("camRate"), `● LIVE ${Math.round(s.camFps)} FPS · HUD ${Math.round(s.hudFps)}`);
  const lightEl = $("stLight");
  if (s.light == null) {
    setText(lightEl, "--");
  } else {
    const low = s.light < 0.2;
    setText(lightEl, s.gain > 1.05 ? `BOOST ×${s.gain.toFixed(1)}` : low ? "LOW" : "GOOD");
    lightEl.classList.toggle("warn", low);
    if (low && !lowLightWarned) {
      lowLightWarned = true;
      log("Low light detected. Face a window or lamp for reliable tracking.", "warn");
      toast("LOW LIGHT · TRACKING MAY BE UNSTABLE", "warn", 3000);
    } else if (!low && s.light > 0.26) {
      lowLightWarned = false;
    }
  }
}

function updateFpsChip() {
  const live = hand.running && lastStats;
  const cam = live ? Math.round(lastStats.camFps) : "--";
  const ai = live && !hand.paused ? Math.round(lastStats.aiFps) : "--";
  const hud = live ? Math.round(lastStats.hudFps) : "--";
  const fx = scene && settings.fx !== "off" && !body.classList.contains("presenting") ? Math.round(scene.fps) : "--";
  setText($("fpsChip"), `CAM ${cam} · AI ${ai} · HUD ${hud} · FX ${fx}`);
}

async function refreshCameras() {
  const cams = await hand.listCameras();
  const sel = $("camSelect");
  const named = cams.filter((c) => c.id);
  sel.replaceChildren(new Option("Default camera", ""), ...named.map((c) => new Option(c.label, c.id)));
  sel.value = named.some((c) => c.id === settings.camera) ? settings.camera : "";
  return cams.length ? `${cams.length} detected` : "none detected";
}

// ------------------------------------------------------------------ fullscreen presenter

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (err) {
    log(`Fullscreen unavailable: ${err.message}`, "warn");
  }
}

async function present() {
  if (!viewer.loaded) {
    toast("ADD A FILE FIRST, THEN PRESS PRESENT", "warn", 2600);
    $("fileInput").click();
    return;
  }
  closeGrid();
  if (settings.mode !== "slide") setMode("slide");
  if (!document.fullscreenElement) await toggleFullscreen();
  if (!hand.running) await startCamera();
  else if (hand.paused) toggleTracking();
  log("Presenting: full-screen slides, invisible hand control, no camera image.", "ok");
}

function applyPresenting(updateFx = true) {
  const on = body.classList.contains("presenting");
  body.classList.toggle("show-pip", settings.pip);
  hand.pipCanvas = on && settings.pip ? $("pipCanvas") : null;
  // While presenting the sidebar is hidden: skip drawing its HUD and pause the 3D scene,
  // so the GPU and CPU go to hand detection.
  hand.previewEnabled = !on;
  if (!updateFx) return;
  if (on) {
    scene?.setQuality("off");
    if (matrix) matrix.enabled = false;
  } else {
    applyFx();
  }
}

document.addEventListener("fullscreenchange", () => {
  const on = Boolean(document.fullscreenElement);
  body.classList.toggle("presenting", on);
  body.classList.remove("show-tools");
  applyPresenting();
  // Auto quality: presenting always starts fitted to the screen; the slide is then re-rendered
  // at full screen resolution by the viewer's resize handling.
  if (on && viewer.loaded && viewer.zoom !== 1) viewer.setZoom(1, false);
  setStatus(on ? "Presenting · move the mouse to the top for tools · Esc to exit." : "Presenter mode closed.");
  if (on) toast("PRESENTING · MOVE YOUR HAND TO CHANGE SLIDES", "", 2200);
  requestAnimationFrame(updateFocus);
});

addEventListener("mousemove", (e) => {
  if (body.classList.contains("presenting")) body.classList.toggle("show-tools", e.clientY < 70);
}, { passive: true });

// ------------------------------------------------------------------ visuals

function updateFocus() {
  scene?.setFocusRect($("stage").getBoundingClientRect());
}

function applyFx() {
  scene?.setQuality(settings.fx);
  $("matrix").hidden = settings.fx === "off";
  if (matrix) matrix.enabled = settings.fx !== "off";
}

function initVisuals() {
  matrix = new MatrixRain($("matrix"));
  try {
    scene = new Scene3D($("scene"));
  } catch (err) {
    $("scene").hidden = true;
    matrix.start();
    throw new Error(`WebGL unavailable (${err.message}); 3D effects off`);
  }
  scene.extras.push((dt) => matrix.step(dt));
  scene.onNotice = (m) => log(m, "warn");
  applyFx();
  updateFocus();
  new ResizeObserver(updateFocus).observe($("stage"));
  return scene.renderer.capabilities.isWebGL2 ? "WebGL2" : "WebGL";
}

// ------------------------------------------------------------------ UI wiring

function bindUI() {
  const fileInput = $("fileInput");
  const pick = () => fileInput.click();
  $("btnOpen").addEventListener("click", pick);
  $("dropzone").addEventListener("click", pick);
  fileInput.addEventListener("change", () => {
    const files = [...fileInput.files];
    fileInput.value = "";
    openFiles(files);
  });

  $("btnPrev").addEventListener("click", () => navigate(-1));
  $("btnNext").addEventListener("click", () => navigate(1));
  $("btnGrid").addEventListener("click", toggleGrid);
  $("btnZoomIn").addEventListener("click", () => zoomBy(0.1));
  $("btnZoomOut").addEventListener("click", () => zoomBy(-0.1));
  $("btnFit").addEventListener("click", () => {
    viewer.setZoom(1);
    setStatus("Zoom: 100%");
  });
  $("btnFull").addEventListener("click", toggleFullscreen);
  $("btnPresent").addEventListener("click", present);
  $("btnClose").addEventListener("click", closeFile);
  $("modeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (b) setMode(b.dataset.mode);
  });
  $("transGrid").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-t]");
    if (!b) return;
    setTransition(b.dataset.t);
    if (viewer.loaded) previewTransition("left");
  });
  document.querySelector(".fx-test").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-test]");
    if (b) previewTransition(b.dataset.test);
  });
  $("gridView").addEventListener("click", (e) => {
    if (e.target === $("gridView") || e.target === $("gridItems")) closeGrid();
  });

  $("btnStart").addEventListener("click", startCamera);
  $("btnPause").addEventListener("click", toggleTracking);
  $("btnCalib").addEventListener("click", recalibrate);
  $("btnStop").addEventListener("click", stopCamera);

  // Mouse clicks should not leave focus on a button, or Space would press it instead of pausing.
  document.addEventListener("pointerup", (e) => e.target.closest?.("button")?.blur());

  let dragDepth = 0;
  addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    dragDepth++;
    body.classList.add("dragging");
  });
  addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) body.classList.remove("dragging");
  });
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    body.classList.remove("dragging");
    openFiles([...(e.dataTransfer?.files || [])]);
  });

  let wheelLock = 0;
  $("stage").addEventListener("wheel", (e) => {
    if (!viewer.loaded || !$("gridView").hidden) return;
    if (e.ctrlKey) {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 0.1 : -0.1);
      return;
    }
    if (viewer.effectiveMode === "slide" && !viewer.canScroll()) {
      e.preventDefault();
      const now = performance.now();
      if (now < wheelLock || Math.abs(e.deltaY) < 8) return;
      wheelLock = now + 380;
      navigate(e.deltaY > 0 ? 1 : -1, e.deltaY > 0 ? "up" : "down");
    }
  }, { passive: false });

  addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.("input, select, textarea")) return;
    switch (e.key) {
      case "ArrowLeft": navigate(-1); break;
      case "ArrowRight": navigate(1); break;
      case "ArrowUp": scrollDocument(-1); break;
      case "ArrowDown": scrollDocument(1); break;
      case "PageUp": navigate(-1); break;
      case "PageDown": navigate(1); break;
      case "+": case "=": zoomBy(0.1); break;
      case "-": case "_": zoomBy(-0.1); break;
      case "0": viewer.setZoom(1); setStatus("Zoom: 100%"); break;
      case " ": toggleTracking(); break;
      case "Escape":
        if (!$("gridView").hidden) closeGrid();
        else if (!document.fullscreenElement) stopCamera();
        break;
      case "f": case "F": toggleFullscreen(); break;
      case "p": case "P": present(); break;
      case "o": case "O": pick(); break;
      case "c": case "C": recalibrate(); break;
      case "g": case "G": toggleGrid(); break;
      case "t": case "T": setTransition(TRANSITIONS[(TRANSITIONS.indexOf(settings.transition) + 1) % TRANSITIONS.length]); break;
      case "m": case "M": setMode(settings.mode === "slide" ? "document" : "slide"); break;
      default: return;
    }
    e.preventDefault();
  });

  navigator.mediaDevices?.addEventListener?.("devicechange", () => refreshCameras().catch(() => {}));
}

function bindSettings() {
  const ranges = {
    sens: (v) => `${v}% · ${((0.16 - (v / 100) * 0.125) * 100).toFixed(1)}% move`,
    smooth: (v) => `${v}%`,
    cool: (v) => `${(v / 1000).toFixed(2)}s`,
  };
  const outputs = { sens: "sensOut", smooth: "smoothOut", cool: "coolOut" };
  const apply = () => {
    const c = hand.controller;
    c.threshold = 0.16 - (settings.sens / 100) * 0.125;
    c.smoothing = settings.smooth / 100;
    c.cooldownMs = settings.cool;
    c.zoomMode = settings.zoom;
    c.oncePerAppearance = settings.once;
    c.pointing = settings.point;
    c.laser = settings.laser;
    c.flick = settings.flick;
    if (!settings.once) c.locked = false;
    hand.mirror = settings.mirror;
    hand.showSkeleton = settings.skeleton;
    hand.lockExposure = settings.exposure;
    hand.turbo = settings.detect !== "balanced";
    applyPresenting(false);
  };
  for (const [key, fmt] of Object.entries(ranges)) {
    const el = $(key);
    const paint = () => {
      const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
      el.style.setProperty("--fill", `${pct}%`);
      $(outputs[key]).textContent = fmt(Number(el.value));
    };
    el.value = settings[key];
    paint();
    el.addEventListener("input", () => {
      settings[key] = Number(el.value);
      paint();
      apply();
      saveSettings();
    });
  }

  const selects = { resSelect: "res", fpsSelect: "fps", zoomSelect: "zoom", fxSelect: "fx", camSelect: "camera", detSelect: "detect" };
  for (const [id, key] of Object.entries(selects)) {
    const el = $(id);
    el.value = settings[key];
    if (el.value !== settings[key]) el.value = DEFAULTS[key];
    el.addEventListener("change", () => {
      settings[key] = el.value;
      saveSettings();
      apply();
      if (key === "fx") applyFx();
      if (key === "res" || key === "fps" || key === "camera") restartCamera();
      if (key === "zoom" || key === "detect") log(`${key === "zoom" ? "Zoom gesture" : "Detection"}: ${el.options[el.selectedIndex].text}.`);
    });
  }

  const toggles = {
    optUpDown: "upDown", optSkeleton: "skeleton", optMirror: "mirror", optExposure: "exposure",
    optPip: "pip", optOnce: "once", optPoint: "point", optLaser: "laser", optFlick: "flick", optAuto: "auto",
  };
  for (const [id, key] of Object.entries(toggles)) {
    const el = $(id);
    el.checked = settings[key];
    el.addEventListener("change", async () => {
      settings[key] = el.checked;
      saveSettings();
      apply();
      if (key === "exposure" && hand.running) {
        try {
          const ms = await hand.applyExposure();
          log(ms ? `Exposure locked at ${ms.toFixed(1)} ms for full frame rate.` : "Auto exposure on (brighter image, camera may run slower).");
        } catch (err) {
          log(`This camera does not allow exposure control: ${err.message}`, "warn");
        }
      }
    });
  }
  apply();
  setTransition(settings.transition, false);
}

// ------------------------------------------------------------------ boot

function bootLine(label) {
  const line = document.createElement("div");
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = `> ${label}`;
  const res = document.createElement("span");
  res.className = "res";
  res.textContent = "[ .... ]";
  line.append(lbl, res);
  $("bootLog").append(line);
  return {
    ok: (detail) => { res.className = "res ok"; res.textContent = detail ? `[ OK ] ${detail}` : "[ OK ]"; },
    fail: () => { res.className = "res fail"; res.textContent = "[FAIL]"; },
  };
}

function sysStatus(key, text, cls) {
  const b = $("sysList").querySelector(`[data-key="${key}"] b`);
  if (!b) return;
  b.textContent = text;
  b.className = cls;
}

async function checkConverters() {
  if (streamlitHost) {
    const args = await streamlitArgs;
    if (args.converter) converterBase = args.converter;
  }
  if (converterBase === null) {
    if (streamlitHost) return "PDF · images · DOCX";
    throw new Error("launcher not running · open via python main.py");
  }
  try {
    const res = await fetch(`${converterBase}/api/info`, { cache: "no-store" });
    converters = (await res.json()).converters || [];
  } catch (err) {
    converterBase = null;
    if (streamlitHost) return "PDF · images · DOCX";
    throw err;
  }
  return converters.length ? converters.join(" + ") : "PDF & images only";
}

/**
 * The hand model (~17 MB) keeps downloading in the background after a few seconds, so the app opens
 * at once even on a slow connection; the camera starts as soon as the model is ready.
 */
async function loadModel() {
  const job = hand.init().then((detail) => {
    sysStatus("model", detail, "ok");
    return detail;
  }, (err) => {
    sysStatus("model", "UNAVAILABLE", "err");
    log(`Hand model: ${err.message}`, "err");
    throw err;
  });
  const quick = await Promise.race([job, sleep(4000).then(() => null)]);
  if (quick) return quick;
  log("Hand model is still downloading; it continues in the background.", "warn");
  job.then((d) => log(`Hand model ready: ${d}.`, "ok"), () => {});
  return "downloading in background";
}

hand.onProgress = (pct) => {
  sysStatus("model", pct >= 100 ? "starting…" : `downloading ${pct}%`, "");
  const line = [...$("bootLog")?.children || []].find((l) => l.textContent.includes("hand landmark"));
  if (line && !line.querySelector(".res.ok")) line.querySelector(".res").textContent = `[ ${String(pct).padStart(3)}% ]`;
  if (!hand.running && $("moveVal").textContent === "LOADING") setMoveState("LOADING", `Downloading hand model ${pct}%`);
};

async function boot() {
  const steps = [
    ["render", "Booting holographic 3D renderer", initVisuals],
    ["pdf", "Loading PDF engine", async () => { await loadPdfEngine(); return "PDF.js"; }],
    ["model", "Loading hand landmark model", loadModel],
    ["camera", "Scanning video devices", refreshCameras],
    ["office", "Checking local office converters", checkConverters],
  ];
  let done = 0;
  for (const [key, label, fn] of steps) {
    const line = bootLine(label);
    try {
      const detail = await fn();
      line.ok(detail);
      if (detail !== "downloading in background") sysStatus(key, detail || "OK", "ok");
    } catch (err) {
      line.fail();
      sysStatus(key, "UNAVAILABLE", "err");
      log(`${label}: ${err.message}`, "warn");
    }
    done++;
    $("bootBar").style.width = `${(done / steps.length) * 100}%`;
  }
  bootLine("All systems online").ok("");
  await sleep(reduceMotion ? 0 : 450);
  $("boot").classList.add("done");
  body.classList.remove("booting");
  setTimeout(() => $("boot").remove(), 900);
  requestAnimationFrame(updateFocus);
  log("System ready. Add your file; the camera starts by itself.", "ok");
  if (hand.ready) log(`Hand tracking engine: ${hand.delegate} on ${hand.engineMode === "WORKER" ? "a background thread" : "the main thread"}.`);
  refreshRecent();
  watchCameraPermission();
}

// ------------------------------------------------------------------ start

// Streamlit sends the component arguments (the local converter address) in its first render message.
const streamlitArgs = new Promise((resolve) => {
  if (!streamlitHost) return resolve({});
  addEventListener("message", (e) => {
    if (e.data?.type === "streamlit:render") resolve(e.data.args || {});
  });
  setTimeout(() => resolve({}), 3000);
});

bindUI();
bindSettings();
onViewerChange(viewer.state());
camUI("off");
setInterval(() => setText($("clock"), new Date().toLocaleTimeString([], { hour12: false })), 1000);
setInterval(updateFpsChip, 500);
if (serverMode) setInterval(() => fetch("/api/ping", { cache: "no-store" }).catch(() => {}), 3000);
addEventListener("resize", updateFocus);
if (streamlitHost) connectStreamlit();
boot();

// Minimal Streamlit component handshake: announce readiness and size the frame to the browser window.
function connectStreamlit() {
  const send = (type, data = {}) => window.parent.postMessage({ isStreamlitMessage: true, type, ...data }, "*");
  const viewportHeight = () => {
    try {
      return window.parent.innerHeight;
    } catch {
      return 900;
    }
  };
  const fit = () => send("streamlit:setFrameHeight", { height: Math.max(640, viewportHeight()) });
  send("streamlit:componentReady", { apiVersion: 1 });
  fit();
  try {
    window.parent.addEventListener("resize", fit);
  } catch {
    /* parent on another origin: keep the initial height */
  }
}
window.ahdp = { viewer, hand, get scene() { return scene; }, settings, handleAction, setTransition };
