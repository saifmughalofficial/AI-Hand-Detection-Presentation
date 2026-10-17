// Binary "digital rain" on a 2D canvas behind the 3D scene, stepped at a fixed 30 Hz.
export class MatrixRain {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.size = 16;
    this.acc = 0;
    this.enabled = true;
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  resize() {
    const w = (this.canvas.width = innerWidth);
    const h = (this.canvas.height = innerHeight);
    this.drops = Array.from({ length: Math.ceil(w / this.size) }, () => this._drop(true));
    this.ctx.fillStyle = "#010603";
    this.ctx.fillRect(0, 0, w, h);
  }

  _drop(initial) {
    return {
      y: initial ? -Math.random() * 80 : -Math.random() * 30,
      speed: 0.3 + Math.random() * 0.8,
      bright: Math.random() < 0.1,
      row: -1,
    };
  }

  step(dt) {
    if (!this.enabled) return;
    this.acc += dt;
    if (this.acc < 1 / 30) return;
    const ticks = Math.min(this.acc * 30, 3);
    this.acc = 0;
    const { ctx, size } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = "rgba(1, 6, 3, 0.14)";
    ctx.fillRect(0, 0, w, h);
    ctx.font = `${size - 2}px "Share Tech Mono", Consolas, monospace`;
    ctx.textAlign = "center";
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      d.y += d.speed * ticks;
      const row = Math.floor(d.y);
      if (row !== d.row && row >= 0) {
        d.row = row;
        ctx.fillStyle = d.bright ? "#c8ffd9" : "rgba(0, 255, 102, 0.8)";
        ctx.fillText(Math.random() < 0.5 ? "0" : "1", i * size + size / 2, row * size);
      }
      if (row * size > h && Math.random() < 0.04) this.drops[i] = this._drop(false);
    }
  }

  start() {
    let last = performance.now();
    const tick = (now) => {
      this.step((now - last) / 1000);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
