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
  minHandDetectionConfidence: 0.65,
  minHandPresenceConfidence: 0.6,
  minTrackingConfidence: 0.5,
});

async function init({ wasmUrl, modelUrl: model }) {
  modelUrl = model;
  fileset = await FilesetResolver.forVisionTasks(wasmUrl);
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
      self.postMessage({ type: "result", hands: toHands(landmarker.detectForVideo(bitmap, lastTs)) });
    } catch (err) {
      self.postMessage({ type: "result", hands: [], error: String(err?.message || err) });
    } finally {
      bitmap.close();
    }
  }
};
