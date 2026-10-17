// Presentation / document viewer: PDF (PDF.js), images, and DOCX-as-HTML fallback.
// Slide Mode shows one page with a 3D holographic flip; Document Mode is a continuous,
// lazily rendered page stream that can be scrolled and panned.

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
      await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport, background: "#ffffff" }).promise;
    },
  };
}

function imagePage(bitmap) {
  return {
    w: bitmap.width,
    h: bitmap.height,
    async draw(canvas, scale) {
      const dpr = pixelRatioFor(bitmap.width * scale, bitmap.height * scale);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale * dpr));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale * dpr));
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    },
  };
}

function cloneCanvas(src) {
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  out.getContext("2d").drawImage(src, 0, 0);
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

  go(dir, axis = "x") {
    if (!this.loaded) return "none";
    if (this.kind === "html") return this.scroll(dir) ? "moved" : "edge";
    const next = this.index + dir;
    if (next < 0 || next >= this.pages.length) return "edge";
    this.index = next;
    if (this.effectiveMode === "document") this._scrollToIndex(next, true);
    else this._showSlide(dir, axis);
    this._changed();
    return "moved";
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
    return { w: Math.max(200, r.width - 56), h: Math.max(150, r.height - 56) };
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

  async _showSlide(dir, axis = "x") {
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

    canvas.style.width = `${page.w * scale}px`;
    canvas.style.height = `${page.h * scale}px`;
    const card = document.createElement("div");
    card.className = "slide-card";
    card.append(canvas);

    const old = [...this.slideView.querySelectorAll(".slide-card:not(.leaving)")];
    const animate = dir !== 0 && !reduceMotion;
    // Horizontal moves flip like a page (rotateY); vertical moves roll like a drum (rotateX).
    const exitTo = axis === "y"
      ? `translate3d(0, ${-dir * 45}%, -260px) rotateX(${dir * 55}deg)`
      : `translate3d(${-dir * 38}%, 0, -260px) rotateY(${dir * 62}deg)`;
    const enterFrom = axis === "y"
      ? `translate3d(0, ${dir * 45}%, -260px) rotateX(${-dir * 55}deg)`
      : `translate3d(${dir * 38}%, 0, -260px) rotateY(${-dir * 62}deg)`;
    for (const o of old) {
      if (!animate) {
        o.remove();
        continue;
      }
      o.style.left = `${o.offsetLeft}px`;
      o.style.top = `${o.offsetTop}px`;
      o.classList.add("leaving");
      o.animate(
        [{ transform: "none", opacity: 1 }, { transform: exitTo, opacity: 0 }],
        { duration: 460, easing: "cubic-bezier(.55,0,.75,.2)", fill: "forwards" },
      ).finished.then(() => o.remove(), () => o.remove());
    }
    this.slideView.append(card);
    if (animate) {
      card.classList.add("scan");
      card.animate(
        [{ transform: enterFrom, opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: 560, easing: "cubic-bezier(.16,1,.3,1)" },
      );
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
