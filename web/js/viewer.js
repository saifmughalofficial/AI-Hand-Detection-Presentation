// Presentation / document viewer: PDF (PDF.js), images, and DOCX-as-HTML fallback.
// Slide Mode shows one page with 3D transitions (cube, flip, push, zoom, hologram) that follow the
// presenter's hand; Document Mode is a continuous, lazily rendered page stream that can be
// scrolled and panned.

let pdfjsPromise = null;
export function loadPdfEngine() {
  pdfjsPromise ??= import("../vendor/pdfjs/pdf.min.mjs").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
    return lib;
  });
  return pdfjsPromise;
}

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;
const MAX_CANVAS_PIXELS = 16_000_000;
const CACHE_SIZE = 8;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function pixelRatioFor(cssW, cssH) {
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  while (cssW * cssH * dpr * dpr > MAX_CANVAS_PIXELS && dpr > 0.5) dpr *= 0.8;
  return dpr;
}

// Every page canvas remembers its pixel ratio (canvas._dpr), so it can be shown at exactly one
// canvas pixel per screen pixel: no resampling blur on text and lines.
function pdfPage(page) {
  const base = page.getViewport({ scale: 1 });
  return {
    w: base.width,
    h: base.height,
    async draw(canvas, scale) {
      const dpr = pixelRatioFor(base.width * scale, base.height * scale);
      const viewport = page.getViewport({ scale: scale * dpr });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas._dpr = dpr;
      await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport, background: "#ffffff" }).promise;
    },
  };
}

/**
 * Light unsharp mask (3×3 Laplacian) for enlarged images: recovers edge contrast lost when a small
 * picture or screenshot is stretched to full screen.
 */
function sharpen(ctx, w, h, amount) {
  if (w * h > 6_000_000) return;
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;
  const out = new Uint8ClampedArray(src);
  const row = w * 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * row + x * 4;
      for (let c = 0; c < 3; c++) {
        const v = src[i + c];
        out[i + c] = v + amount * (4 * v - src[i + c - 4] - src[i + c + 4] - src[i + c - row] - src[i + c + row]);
      }
    }
  }
  img.data.set(out);
  ctx.putImageData(img, 0, 0);
}

function imagePage(bitmap) {
  return {
    w: bitmap.width,
    h: bitmap.height,
    async draw(canvas, scale) {
      const dpr = pixelRatioFor(bitmap.width * scale, bitmap.height * scale);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale * dpr));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale * dpr));
      canvas._dpr = dpr;
      const ctx = canvas.getContext("2d", { willReadFrequently: false });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const up = canvas.width / bitmap.width;
      if (up < 0.5) {
        // Large downscale in halving steps: avoids the aliasing of one big shrink.
        let src = bitmap;
        let w = bitmap.width;
        let h = bitmap.height;
        while (w / 2 > canvas.width) {
          w = Math.round(w / 2);
          h = Math.round(h / 2);
          const step = new OffscreenCanvas(w, h);
          const sctx = step.getContext("2d");
          sctx.imageSmoothingQuality = "high";
          sctx.drawImage(src, 0, 0, w, h);
          src = step;
        }
        ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (up > 1.25) sharpen(ctx, canvas.width, canvas.height, Math.min(0.6, (up - 1) * 0.35));
      }
    },
  };
}

/** Average colour of a canvas's outer edge, used to tint the letterbox around the slide. */
function edgeColor(canvas) {
  const n = 24;
  const c = new OffscreenCanvas(n, n);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(canvas, 0, 0, n, n);
  const d = g.getImageData(0, 0, n, n).data;
  let r = 0, gr = 0, b = 0, k = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (x > 1 && x < n - 2 && y > 1 && y < n - 2) continue;
      const i = (y * n + x) * 4;
      r += d[i]; gr += d[i + 1]; b += d[i + 2]; k++;
    }
  }
  return [r / k, gr / k, b / k].map(Math.round);
}

const MOTION = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/**
 * Keyframes for a slide change. `motion` is where the outgoing slide travels: left / right / up /
 * down (it follows the presenter's hand) or in / out (zoom through). Sizes are the card's px size,
 * needed by the cube because CSS translateZ cannot use percentages.
 */
const MIX = ["cube", "flip", "push", "zoom", "hologram", "orbit", "door", "portal", "glitch", "shatter"];

function transitionFrames(style, motion, w, h) {
  if (style === "mix") style = MIX[Math.floor(Math.random() * MIX.length)];
  if (style === "auto") style = motion === "in" || motion === "out" ? "zoom" : "cube";
  const zoomMotion = motion === "in" || motion === "out";
  if (zoomMotion && !["zoom", "hologram", "portal", "glitch", "shatter"].includes(style)) style = "zoom";
  const [mx, my] = MOTION[motion] || [0, 0];
  const horizontal = my === 0;
  const ease = "cubic-bezier(.65,0,.35,1)";
  switch (style) {
    case "cube": {
      const d = (horizontal ? w : h) / 2;
      const rot = (a) => (horizontal ? `rotateY(${a}deg)` : `rotateX(${a}deg)`);
      const turn = horizontal ? mx * 90 : -my * 90;
      const face = (a) => `translateZ(${-d}px) ${rot(a)} translateZ(${d}px)`;
      return {
        duration: 620, exitEase: ease, enterEase: ease,
        exit: [{ transform: face(0), filter: "brightness(1)" }, { transform: face(turn), filter: "brightness(0.35)" }],
        enter: [{ transform: face(-turn), filter: "brightness(0.35)" }, { transform: face(0), filter: "brightness(1)" }],
      };
    }
    case "push":
      return {
        duration: 520, exitEase: ease, enterEase: ease,
        exit: [{ transform: "none" }, { transform: `translate3d(${mx * 115}%, ${my * 115}%, 0)` }],
        enter: [{ transform: `translate3d(${-mx * 115}%, ${-my * 115}%, 0)` }, { transform: "none" }],
      };
    case "zoom": {
      // "in": the old slide flies past the viewer and the next one rises from depth; "out" reverses.
      const into = zoomMotion ? motion === "in" : mx + my > 0;
      const t = (s, x = 0, y = 0) => `translate3d(${x}%, ${y}%, 0) scale(${s})`;
      return {
        duration: 560, exitEase: "cubic-bezier(.55,0,.75,.2)", enterEase: "cubic-bezier(.16,1,.3,1)",
        exit: [{ transform: t(1), opacity: 1, filter: "blur(0px)" }, { transform: t(into ? 2.4 : 0.35, mx * 25, my * 25), opacity: 0, filter: "blur(6px)" }],
        enter: [{ transform: t(into ? 0.45 : 1.9, -mx * 25, -my * 25), opacity: 0 }, { transform: t(1), opacity: 1 }],
      };
    }
    case "hologram":
      return {
        duration: 560, exitEase: "cubic-bezier(.7,0,.84,0)", enterEase: "cubic-bezier(.16,1,.3,1)", enterDelay: 160,
        exit: [
          { transform: "scale(1, 1)", filter: "brightness(1)", opacity: 1 },
          { transform: "scale(1.03, 0.006)", filter: "brightness(3)", opacity: 1, offset: 0.7 },
          { transform: "scale(0, 0.006)", filter: "brightness(3)", opacity: 0 },
        ],
        enter: [
          { transform: "scale(0.02, 0.006)", filter: "brightness(3)", opacity: 0 },
          { transform: "scale(1, 0.006)", filter: "brightness(2.5)", opacity: 1, offset: 0.35 },
          { transform: "scale(1, 1)", filter: "brightness(1)", opacity: 1 },
        ],
      };
    case "orbit": // both slides ride a wide 3D ring around the viewer
      return {
        duration: 680, exitEase: ease, enterEase: ease,
        exit: [
          { transform: "none", opacity: 1 },
          { transform: `translate3d(${mx * 80}%, ${my * 80}%, -700px) rotateY(${mx * 50}deg) rotateX(${-my * 50}deg)`, opacity: 0 },
        ],
        enter: [
          { transform: `translate3d(${-mx * 80}%, ${-my * 80}%, -700px) rotateY(${-mx * 50}deg) rotateX(${my * 50}deg)`, opacity: 0 },
          { transform: "none", opacity: 1 },
        ],
      };
    case "door": { // the old slide swings open on the edge the hand moves toward
      const origin = horizontal ? `${mx > 0 ? 100 : 0}% 50%` : `50% ${my > 0 ? 100 : 0}%`;
      const swing = horizontal ? `rotateY(${-mx * 105}deg)` : `rotateX(${my * 105}deg)`;
      return {
        duration: 640, exitEase: "cubic-bezier(.5,0,.75,0)", enterEase: "cubic-bezier(.16,1,.3,1)",
        exit: [{ transformOrigin: origin, transform: "none", opacity: 1 }, { transformOrigin: origin, transform: swing, opacity: 0 }],
        enter: [{ transform: "translateZ(-220px) scale(0.92)", opacity: 0, filter: "brightness(0.4)" }, { transform: "none", opacity: 1, filter: "brightness(1)" }],
        front: "old",
      };
    }
    case "portal": { // spiral into a vortex, the next slide spirals out
      const s = zoomMotion ? (motion === "in" ? 1 : -1) : mx + my >= 0 ? 1 : -1;
      return {
        duration: 640, exitEase: "cubic-bezier(.6,0,.8,.3)", enterEase: "cubic-bezier(.16,1,.3,1)",
        exit: [{ transform: "none", opacity: 1, filter: "blur(0px)" }, { transform: `rotate(${s * 200}deg) scale(0.05)`, opacity: 0, filter: "blur(8px) hue-rotate(60deg)" }],
        enter: [{ transform: `rotate(${-s * 200}deg) scale(0.05)`, opacity: 0, filter: "blur(8px)" }, { transform: "none", opacity: 1, filter: "blur(0px)" }],
      };
    }
    case "glitch": { // RGB-split slices jitter in the hand direction
      const j = (k) => `translate3d(${(mx || 0.6) * k}px, ${my * k}px, 0)`;
      return {
        duration: 460, exitEase: "linear", enterEase: "linear",
        exit: [
          { transform: "none", clipPath: "inset(0 0 0 0)", filter: "none", opacity: 1 },
          { transform: j(-14), clipPath: "inset(12% 0 48% 0)", filter: "hue-rotate(90deg) saturate(3)", opacity: 1, offset: 0.25 },
          { transform: j(22), clipPath: "inset(55% 0 8% 0)", filter: "hue-rotate(-90deg) saturate(3)", opacity: 0.8, offset: 0.5 },
          { transform: j(60), clipPath: "inset(40% 0 40% 0)", filter: "brightness(3)", opacity: 0 },
        ],
        enter: [
          { transform: j(-60), clipPath: "inset(45% 0 45% 0)", filter: "brightness(3)", opacity: 0 },
          { transform: j(18), clipPath: "inset(5% 0 60% 0)", filter: "hue-rotate(90deg) saturate(3)", opacity: 1, offset: 0.4 },
          { transform: j(-8), clipPath: "inset(30% 0 0 0)", filter: "hue-rotate(-60deg)", opacity: 1, offset: 0.7 },
          { transform: "none", clipPath: "inset(0 0 0 0)", filter: "none", opacity: 1 },
        ],
      };
    }
    case "shatter": // the old slide breaks into tiles that fly the hand's way (built in _shatter)
      return {
        duration: 760, shatter: true, mx, my, zoom: zoomMotion ? motion : null,
        enterEase: "cubic-bezier(.16,1,.3,1)", enterDelay: 120,
        enter: [{ transform: "scale(0.9)", opacity: 0, filter: "brightness(2)" }, { transform: "none", opacity: 1, filter: "brightness(1)" }],
      };
    default: { // "flip": the original holographic page flip
      const exitTo = horizontal
        ? `translate3d(${mx * 38}%, 0, -260px) rotateY(${-mx * 62}deg)`
        : `translate3d(0, ${my * 45}%, -260px) rotateX(${-my * 55}deg)`;
      const enterFrom = horizontal
        ? `translate3d(${-mx * 38}%, 0, -260px) rotateY(${mx * 62}deg)`
        : `translate3d(0, ${-my * 45}%, -260px) rotateX(${my * 55}deg)`;
      return {
        duration: 520, exitEase: "cubic-bezier(.55,0,.75,.2)", enterEase: "cubic-bezier(.16,1,.3,1)",
        exit: [{ transform: "none", opacity: 1 }, { transform: exitTo, opacity: 0 }],
        enter: [{ transform: enterFrom, opacity: 0 }, { transform: "none", opacity: 1 }],
      };
    }
  }
}

function cloneCanvas(src) {
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  out.getContext("2d").drawImage(src, 0, 0);
  out._dpr = src._dpr;
  return out;
}

export class Viewer {
  constructor({ stage, slideView, docView, docPages, onChange, onError }) {
    Object.assign(this, { stage, slideView, docView, docPages, onChange, onError });
    this.kind = null;
    this.pages = [];
    this.html = null;
    this.name = "";
    this.index = 0;
    this.zoom = 1;
    this.mode = "slide";
    this.transition = "auto";
    this.gen = 0;
    this.token = 0;
    this.syncLock = 0;
    this.docDirty = true;
    this.cache = new Map();
    this.pending = new Map();

    new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.relayout(), 120);
    }).observe(stage);

    docView.addEventListener("scroll", () => {
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0;
        this._syncIndexFromScroll();
      });
    }, { passive: true });

    this.renderObserver = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && this._renderDocPage(e.target)),
      { root: docView, rootMargin: "900px 0px" },
    );
    this.releaseObserver = new IntersectionObserver(
      (entries) => entries.forEach((e) => !e.isIntersecting && this._releaseDocPage(e.target)),
      { root: docView, rootMargin: "4000px 0px" },
    );
  }

  get loaded() { return this.kind !== null; }
  get count() { return this.kind === "html" ? 1 : this.pages.length; }
  get effectiveMode() { return this.kind === "html" ? "document" : this.mode; }

  state() {
    return {
      loaded: this.loaded, kind: this.kind, name: this.name, index: this.index,
      count: this.count, zoom: this.zoom, mode: this.effectiveMode,
    };
  }

  // ------------------------------------------------------------------ loading

  async openPdf(buffer, name) {
    const pdfjs = await loadPdfEngine();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
    const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1).then(pdfPage)));
    this._reset();
    this.pdf = doc;
    this._load("pdf", pages, name);
  }

  async openImages(files) {
    const pages = [];
    for (const file of files) pages.push(imagePage(await createImageBitmap(file)));
    this._reset();
    this._load("images", pages, files.length > 1 ? `${files.length} images` : files[0].name);
  }

  openHtml(html, name) {
    this._reset();
    this.html = html;
    this._load("html", [], name);
  }

  close() {
    this._reset();
    this.kind = null;
    this.name = "";
    this.slideView.hidden = true;
    this.docView.hidden = true;
    this._changed();
  }

  _reset() {
    this.gen++;
    this.token++;
    this.pdf?.destroy();
    this.pdf = null;
    this.pages = [];
    this.html = null;
    this.cache.clear();
    this.pending.clear();
    this.renderObserver.disconnect();
    this.releaseObserver.disconnect();
    this.slideView.replaceChildren();
    this.docPages.replaceChildren();
    this.index = 0;
    this.zoom = 1;
    this.docDirty = true;
  }

  _load(kind, pages, name) {
    this.kind = kind;
    this.pages = pages;
    this.name = name;
    this._showMode(1);
    this._changed();
  }

  _changed() {
    if (this.effectiveMode === "document" && this.kind !== "html") {
      for (const el of this.docPages.children) el.classList.toggle("current", +el.dataset.index === this.index);
    }
    this.onChange?.(this.state());
  }

  // ------------------------------------------------------------------ modes & navigation

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.loaded) this._showMode(0);
    this._changed();
  }

  _showMode(dir) {
    const doc = this.effectiveMode === "document";
    this.slideView.hidden = doc;
    this.docView.hidden = !doc;
    if (doc) {
      if (this.docDirty) this._buildDoc();
      this._scrollToIndex(this.index, false);
    } else {
      this.docDirty = true;
      this._showSlide(dir);
    }
  }

  /** `motion`: where the outgoing slide travels (left/right/up/down/in/out). Default: classic. */
  go(dir, motion = dir > 0 ? "left" : "right") {
    if (!this.loaded) return "none";
    if (this.kind === "html") return this.scroll(dir) ? "moved" : "edge";
    const next = this.index + dir;
    if (next < 0 || next >= this.pages.length) return "edge";
    this.index = next;
    if (this.effectiveMode === "document") this._scrollToIndex(next, true);
    else this._showSlide(dir, motion);
    this._changed();
    return "moved";
  }

  /** Jump straight to a page (used by the slide grid). */
  goTo(index) {
    if (!this.loaded || this.kind === "html") return false;
    const i = Math.max(0, Math.min(this.pages.length - 1, index));
    if (i === this.index) return false;
    const dir = i > this.index ? 1 : -1;
    this.index = i;
    if (this.effectiveMode === "document") this._scrollToIndex(i, true);
    else this._showSlide(dir, dir > 0 ? "in" : "out");
    this._changed();
    return true;
  }

  /** Small page thumbnails for the slide grid. */
  async thumbnail(i, width = 220) {
    const page = this.pages[i];
    if (!page) return null;
    const c = document.createElement("canvas");
    await page.draw(c, width / page.w);
    return c;
  }

  _scrollTarget() {
    return this.effectiveMode === "document" ? this.docView : this.slideView;
  }

  canScroll() {
    const el = this._scrollTarget();
    return el.scrollHeight > el.clientHeight + 2;
  }

  scroll(dir) {
    const el = this._scrollTarget();
    const atEdge = dir < 0 ? el.scrollTop <= 1 : el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    if (!this.canScroll() || atEdge) return false;
    el.scrollBy({ top: dir * el.clientHeight * 0.6, behavior: reduceMotion ? "auto" : "smooth" });
    return true;
  }

  pan(dir) {
    const el = this._scrollTarget();
    const atEdge = dir < 0 ? el.scrollLeft <= 1 : el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    if (el.scrollWidth <= el.clientWidth + 2 || atEdge) return false;
    el.scrollBy({ left: dir * el.clientWidth * 0.35, behavior: reduceMotion ? "auto" : "smooth" });
    return true;
  }

  clampZoom(value) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
  }

  /** Live zoom while a pinch gesture moves: a GPU-cheap CSS scale, committed later by setZoom(). */
  previewZoom(value) {
    if (!this.loaded) return this.zoom;
    const z = this.clampZoom(value);
    const doc = this.effectiveMode === "document";
    const el = doc ? this.docPages : this.slideView.querySelector(".slide-card:not(.leaving)");
    if (!el) return z;
    if (doc) this.docPages.style.transformOrigin = `50% ${this.docView.scrollTop + this.docView.clientHeight / 2}px`;
    el.style.transform = z === this.zoom ? "" : `scale(${z / this.zoom})`;
    this.previewEl = el;
    return z;
  }

  setZoom(value, animate = true) {
    const z = this.clampZoom(value);
    const preview = this.previewEl;
    this.previewEl = null;
    // The slide card is replaced once re-rendered; the document column is resized right away.
    if (preview && (preview === this.docPages || z === this.zoom)) preview.style.transform = "";
    if (!this.loaded || z === this.zoom) return false;
    this.zoomAnim = animate ? this.zoom / z : null;
    this.zoom = z;
    this.relayout();
    this._changed();
    return true;
  }

  relayout() {
    if (!this.loaded) return;
    if (this.effectiveMode === "document") {
      if (this.docDirty) this._buildDoc();
      else this._layoutDoc(true);
    } else {
      this.docDirty = true;
      this._showSlide(0);
    }
  }

  _stageSize() {
    const r = this.stage.getBoundingClientRect();
    // Presenting: the slide fills the screen edge to edge.
    const pad = document.body.classList.contains("presenting") ? 0 : 56;
    return { w: Math.max(200, r.width - pad), h: Math.max(150, r.height - pad) };
  }

  // ------------------------------------------------------------------ slide mode

  _slideScale(page) {
    const s = this._stageSize();
    return Math.min(s.w / page.w, s.h / page.h) * this.zoom;
  }

  async _renderCached(i, scale, clone = true) {
    const page = this.pages[i];
    const key = `${this.gen}:${i}@${scale.toFixed(4)}`;
    let src = this.cache.get(key);
    if (src) {
      this.cache.delete(key);
    } else {
      let job = this.pending.get(key);
      if (!job) {
        job = (async () => {
          const c = document.createElement("canvas");
          await page.draw(c, scale);
          return c;
        })();
        this.pending.set(key, job);
        job.finally(() => this.pending.delete(key)).catch(() => {});
      }
      src = await job;
    }
    this.cache.set(key, src);
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
    return clone ? cloneCanvas(src) : src;
  }

  async _showSlide(dir, motion = dir > 0 ? "left" : "right") {
    const token = ++this.token;
    const zoomFrom = this.zoomAnim;
    this.zoomAnim = null;
    const page = this.pages[this.index];
    if (!page) return;
    const scale = this._slideScale(page);
    let canvas;
    try {
      canvas = await this._renderCached(this.index, scale);
    } catch (err) {
      if (token === this.token) this.onError?.(err);
      return;
    }
    if (token !== this.token) return;

    // Pixel-exact size: one canvas pixel per screen pixel (crisp text at any zoom).
    const dpr = canvas._dpr || 1;
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
    this._tintBackdrop(canvas);
    const card = document.createElement("div");
    card.className = "slide-card";
    card.append(canvas);

    const old = [...this.slideView.querySelectorAll(".slide-card:not(.leaving)")];
    const animate = dir !== 0 && !reduceMotion && this.transition !== "none";
    const fx = animate ? transitionFrames(this.transition, motion, page.w * scale, page.h * scale) : null;
    for (const o of old) {
      // Any slide still leaving from an earlier, fast gesture is dropped at once.
      if (!animate) {
        o.remove();
        continue;
      }
      if (fx.shatter) {
        this._shatter(o, fx);
        o.remove();
        continue;
      }
      if (fx.front === "old") o.style.zIndex = "2";
      o.style.left = `${o.offsetLeft}px`;
      o.style.top = `${o.offsetTop}px`;
      o.classList.add("leaving");
      o.getAnimations().forEach((a) => a.cancel());
      o.animate(fx.exit, { duration: fx.duration, easing: fx.exitEase, fill: "forwards" })
        .finished.then(() => o.remove(), () => o.remove());
    }
    for (const stale of this.slideView.querySelectorAll(".slide-card.leaving")) {
      if (!old.includes(stale)) stale.remove();
    }
    this.slideView.append(card);
    if (animate) {
      card.classList.add("scan");
      card.dataset.fx = this.transition;
      card.animate(fx.enter, {
        duration: fx.duration, easing: fx.enterEase, delay: fx.enterDelay || 0, fill: "backwards",
      });
    } else if (zoomFrom && !reduceMotion) {
      card.animate(
        [{ transform: `scale(${zoomFrom})`, filter: "brightness(1.25)" }, { transform: "none", filter: "none" }],
        { duration: 380, easing: "cubic-bezier(.16,1,.3,1)" },
      );
    }
    const v = this.slideView;
    v.scrollLeft = (v.scrollWidth - v.clientWidth) / 2;
    v.scrollTop = (v.scrollHeight - v.clientHeight) / 2;
    this._prefetch();
  }

  /** Letterbox colour follows the slide's own edge colour, so the slide blends into the screen. */
  _tintBackdrop(canvas) {
    try {
      const [r, g, b] = edgeColor(canvas);
      this.stage.style.setProperty("--slide-bg", `rgb(${r}, ${g}, ${b})`);
      this.stage.style.setProperty("--slide-bg-dim", `rgb(${Math.round(r * 0.35)}, ${Math.round(g * 0.35)}, ${Math.round(b * 0.35)})`);
    } catch { /* tainted or unsupported: keep the default */ }
  }

  /** Breaks a slide into 24 tiles that fly off in the hand's direction (or burst for zoom). */
  _shatter(card, fx) {
    const src = card.querySelector("canvas");
    if (!src) return;
    const cols = 6;
    const rows = 4;
    const W = card.offsetWidth;
    const H = card.offsetHeight;
    const layer = document.createElement("div");
    layer.className = "shatter";
    layer.style.cssText = `left:${card.offsetLeft}px;top:${card.offsetTop}px;width:${W}px;height:${H}px`;
    const sw = src.width / cols;
    const sh = src.height / rows;
    const rnd = () => Math.random() - 0.5;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tile = document.createElement("canvas");
        tile.width = Math.ceil(sw);
        tile.height = Math.ceil(sh);
        tile.getContext("2d").drawImage(src, c * sw, r * sh, sw, sh, 0, 0, tile.width, tile.height);
        tile.style.cssText = `left:${(c * W) / cols}px;top:${(r * H) / rows}px;width:${W / cols + 0.5}px;height:${H / rows + 0.5}px`;
        const cx = (c + 0.5) / cols - 0.5;
        const cy = (r + 0.5) / rows - 0.5;
        let tx, ty, tz, lag;
        if (fx.zoom) {
          const k = fx.zoom === "in" ? 1100 : -260;
          [tx, ty, tz] = [cx * k + rnd() * 120, cy * k + rnd() * 120, fx.zoom === "in" ? 700 : -900];
          lag = Math.hypot(cx, cy) * (fx.zoom === "in" ? -1 : 1) + 0.6;
        } else {
          tx = fx.mx * (520 + Math.random() * 520) + cx * 180 + rnd() * 60;
          ty = fx.my * (420 + Math.random() * 420) + cy * 180 + rnd() * 60 + (fx.my ? 0 : 140 * Math.random());
          tz = rnd() * 500;
          // Tiles on the leading edge go first, so the break sweeps across the slide.
          lag = fx.mx ? (fx.mx > 0 ? 1 - c / cols : c / cols) : fx.my > 0 ? 1 - r / rows : r / rows;
        }
        tile.animate(
          [{ transform: "none", opacity: 1 },
            { transform: `translate3d(${tx}px, ${ty}px, ${tz}px) rotate3d(${rnd()}, ${rnd()}, ${rnd()}, ${rnd() * 540}deg)`, opacity: 0 }],
          { duration: 640, delay: Math.max(0, lag) * 200, easing: "cubic-bezier(.45,0,.85,.35)", fill: "both" },
        );
        layer.append(tile);
      }
    }
    this.slideView.append(layer);
    setTimeout(() => layer.remove(), 1000);
  }

  _prefetch() {
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => {
      for (const j of [this.index + 1, this.index - 1]) {
        if (j >= 0 && j < this.pages.length) this._renderCached(j, this._slideScale(this.pages[j]), false).catch(() => {});
      }
    }, 150);
  }

  // ------------------------------------------------------------------ document mode

  _docScale(page) {
    // Leave room for the page column's side padding, page numbers and the scrollbar.
    const avail = Math.max(200, Math.min(this.stage.clientWidth - 150, 1100));
    return (avail / page.w) * this.zoom;
  }

  _buildDoc() {
    this.renderObserver.disconnect();
    this.releaseObserver.disconnect();
    this.docPages.replaceChildren();
    if (this.kind === "html") {
      const paper = document.createElement("article");
      paper.className = "paper";
      paper.innerHTML = this.html;
      this.docPages.append(paper);
    } else {
      this.pages.forEach((_, i) => {
        const el = document.createElement("div");
        el.className = "doc-page";
        el.dataset.index = i;
        const num = document.createElement("span");
        num.className = "doc-page-num";
        num.textContent = String(i + 1).padStart(2, "0");
        el.append(num);
        this.docPages.append(el);
      });
    }
    this._layoutDoc(false);
  }

  _layoutDoc(preserve) {
    const v = this.docView;
    const ry = v.scrollHeight ? v.scrollTop / v.scrollHeight : 0;
    const rx = v.scrollWidth ? v.scrollLeft / v.scrollWidth : 0;
    if (this.kind === "html") {
      this.docPages.firstElementChild.style.zoom = this.zoom;
    } else {
      for (const el of this.docPages.children) {
        const page = this.pages[+el.dataset.index];
        const s = this._docScale(page);
        el.style.width = `${page.w * s}px`;
        el.style.height = `${page.h * s}px`;
        this.renderObserver.unobserve(el);
        this.releaseObserver.unobserve(el);
        this.renderObserver.observe(el);
        this.releaseObserver.observe(el);
      }
    }
    if (preserve) {
      this.syncLock = performance.now() + 120;
      v.scrollTop = ry * v.scrollHeight;
      v.scrollLeft = rx * v.scrollWidth;
    }
    if (this.zoomAnim && !reduceMotion) {
      this.docPages.style.transformOrigin = `50% ${v.scrollTop + v.clientHeight / 2}px`;
      this.docPages.animate([{ transform: `scale(${this.zoomAnim})` }, { transform: "none" }],
        { duration: 380, easing: "cubic-bezier(.16,1,.3,1)" });
    }
    this.zoomAnim = null;
    this.docDirty = false;
  }

  async _renderDocPage(el) {
    const page = this.pages[+el.dataset.index];
    if (!page) return;
    const scale = this._docScale(page);
    const key = `${this.gen}:${scale.toFixed(4)}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    const canvas = document.createElement("canvas");
    try {
      await page.draw(canvas, scale);
    } catch (err) {
      delete el.dataset.key;
      this.onError?.(err);
      return;
    }
    if (el.dataset.key !== key || !el.isConnected) return;
    el.querySelector("canvas")?.remove();
    el.prepend(canvas);
    el.classList.add("ready");
  }

  _releaseDocPage(el) {
    el.querySelector("canvas")?.remove();
    delete el.dataset.key;
    el.classList.remove("ready");
  }

  _scrollToIndex(i, smooth) {
    const el = this.docPages.children[i];
    if (!el || this.kind === "html") return;
    const animate = smooth && !reduceMotion;
    this.syncLock = performance.now() + (animate ? 800 : 80);
    this.docView.scrollTo({ top: el.offsetTop - 20, behavior: animate ? "smooth" : "auto" });
  }

  _syncIndexFromScroll() {
    if (this.effectiveMode !== "document" || this.kind === "html" || performance.now() < this.syncLock) return;
    const y = this.docView.scrollTop + this.docView.clientHeight * 0.35;
    const els = this.docPages.children;
    let idx = 0;
    for (let i = 0; i < els.length; i++) {
      if (els[i].offsetTop <= y) idx = i;
      else break;
    }
    if (idx !== this.index) {
      this.index = idx;
      this._changed();
    }
  }
}
