// Runs the MediaPipe Hand Landmarker off the main thread so the UI and 3D scene keep 60 FPS.
import { FilesetResolver, HandLandmarker } from "../vendor/mediapipe/vision_bundle.mjs";

// MediaPipe loads its WASM glue with importScripts(), which module workers do not allow.
// A synchronous shim (sync XHR is permitted inside workers) restores it.
self.importScripts = (...urls) => {
  for (const url of urls) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.send();
    if (xhr.status !== 200) throw new Error(`Could not load ${url} (${xhr.status})`);
    (0, eval)(xhr.responseText);
  }
};

let fileset = null;
let landmarker = null;
let delegate = "CPU";
let modelUrl = "";
let lastTs = 0;

const create = (target) => HandLandmarker.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: modelUrl, delegate: target },
  runningMode: "VIDEO",
  numHands: 1,
  // Lower gates pick the hand up a frame or two sooner; the gesture filter rejects any noise.
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
});

async function init({ fileset: files, wasmUrl, modelUrl: model }) {
  modelUrl = model;
  // The page downloads the engine once and passes blob URLs; a plain folder URL also works.
  fileset = files || await FilesetResolver.forVisionTasks(wasmUrl);
  try {
    landmarker = await create("GPU");
    delegate = "GPU";
    // Warm up now so a GPU delegate that cannot actually run falls back before the presentation.
    const probe = new OffscreenCanvas(128, 128);
    probe.getContext("2d").fillRect(0, 0, 128, 128);
    landmarker.detectForVideo(probe.transferToImageBitmap(), ++lastTs);
  } catch (err) {
    landmarker?.close?.();
    landmarker = await create("CPU");
    delegate = "CPU";
  }
}

// Low-light boost: in a dim room the frame is brightened (and contrast lifted) before detection,
// which keeps the landmark model confident. Frames are never shown or stored.
let boost = null;
function enhance(bitmap, gain) {
  if (!(gain > 1.05)) return bitmap;
  if (!boost || boost.width !== bitmap.width || boost.height !== bitmap.height) {
    boost = new OffscreenCanvas(bitmap.width, bitmap.height);
  }
  const g = boost.getContext("2d");
  g.filter = `brightness(${gain.toFixed(2)}) contrast(1.12)`;
  g.drawImage(bitmap, 0, 0);
  return boost;
}

function toHands(result) {
  return (result.landmarks || []).map((points, i) => ({
    landmarks: points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    handedness: result.handedness?.[i]?.[0]?.categoryName || "",
    score: result.handedness?.[i]?.[0]?.score ?? 0,
  }));
}

self.onmessage = async ({ data }) => {
  if (data.type === "init") {
    try {
      await init(data);
      self.postMessage({ type: "ready", delegate });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err?.message || err) });
    }
    return;
  }
  if (data.type === "frame") {
    const { bitmap } = data;
    lastTs = Math.max(data.ts, lastTs + 1);
    try {
      self.postMessage({ type: "result", hands: toHands(landmarker.detectForVideo(enhance(bitmap, data.gain), lastTs)) });
    } catch (err) {
      self.postMessage({ type: "result", hands: [], error: String(err?.message || err) });
    } finally {
      bitmap.close();
    }
  }
};
