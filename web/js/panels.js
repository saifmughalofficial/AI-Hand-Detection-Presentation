// Floating holographic HUD windows around the globe: live code, boot log, network analysis,
// world map, fingerprint scanner and data stream. Each is a canvas texture on a glowing plane,
// redrawn a few times per second in round-robin so the GPU upload cost stays tiny.
import * as THREE from "../vendor/three.module.min.js";
import { MASK_W, MASK_H, MASK_HEX } from "./worldmask.js";

const TW = 512;
const TH = 352;
const G = "#00ff66";
const HI = "#c8ffd9";
const DIM = "rgba(0, 255, 102, 0.55)";
const AMBER = "#ffc94d";
const MONO = '"Share Tech Mono", Consolas, monospace';
const MASK = Uint8Array.from(MASK_HEX.match(/../g), (h) => parseInt(h, 16));
const land = (x, y) => {
  const i = y * MASK_W + x;
  return (MASK[i >> 3] >> (7 - (i & 7))) & 1;
};

const CODE_MAIN = [
  "#include <iostream>", "#include <vector>", "#include <string>", "#include <algorithm>",
  "#include <network>", "#include <security>", "", "int main() {",
  '    std::string msg = "Access Granted";', "    std::cout << msg << std::endl;", "    return 0;", "}",
];
const CODE_AUTH = [
  "bool authorize(User u) {", '    if (u.role == "admin") {', "        return true;", "    } else {",
  "        return false;", "    }", "}", "", "void log(const std::string& event) {",
  '    std::cout << "[LOG] " << event << std::endl;', "}",
];
const BOOT = ["Booting kernel", "Loading modules", "Network interface", "Security protocols", "Firewall activated", "Hand model loaded", "Threat scan"];
const IPS = ["192.168.1.1", "10.0.0.24", "172.16.0.8", "203.0.113.5", "8.8.8.8", "192.168.0.254"];
const IP_STATES = ["ACTIVE", "SCANNING", "SECURED", "ROUTED"];
const PROTOCOLS = [["Encryption", "ENABLED"], ["Authentication", "ENABLED"], ["Data Integrity", "ENABLED"], ["Intrusion Detection", "ENABLED"], ["Firewall", "ACTIVE"], ["VPN Tunnel", "CONNECTED"]];
const STREAM = [
  "[INFO] Packet received...", "[INFO] Analyzing...", "[WARN] Suspicious activity detected", "[INFO] Connection stabilized",
  "[INFO] Data encrypted", "[INFO] Transmission complete", "[INFO] Hand signal locked", "[INFO] Gesture RIGHT -> next slide",
  "[INFO] Frame 60 fps", "[WARN] Low light compensated", "[INFO] Node handshake ok", "[INFO] Cipher rotated",
];

function frame(g, title) {
  g.clearRect(0, 0, TW, TH);
  g.fillStyle = "rgba(0, 46, 18, 0.55)";
  g.fillRect(6, 6, TW - 12, TH - 12);
  g.strokeStyle = "rgba(0, 255, 102, 0.75)";
  g.lineWidth = 2;
  g.beginPath();
  const c = 16;
  g.moveTo(6 + c, 6); g.lineTo(TW - 6, 6); g.lineTo(TW - 6, TH - 6 - c); g.lineTo(TW - 6 - c, TH - 6);
  g.lineTo(6, TH - 6); g.lineTo(6, 6 + c); g.closePath();
  g.stroke();
  g.fillStyle = "rgba(0, 255, 102, 0.16)";
  g.fillRect(8, 8, TW - 16, 32);
  g.font = `20px ${MONO}`;
  g.fillStyle = HI;
  g.textBaseline = "middle";
  g.fillText(title, 20, 25);
  g.strokeStyle = G;
  g.lineWidth = 1.5;
  g.strokeRect(TW - 78, 18, 12, 12);
  g.beginPath();
  g.moveTo(TW - 100, 30); g.lineTo(TW - 88, 30);
  g.moveTo(TW - 52, 18); g.lineTo(TW - 40, 30); g.moveTo(TW - 40, 18); g.lineTo(TW - 52, 30);
  g.stroke();
  g.textBaseline = "alphabetic";
}

function bars(g, x, y, w, h, n, t, seed) {
  for (let i = 0; i < n; i++) {
    const v = 0.25 + 0.75 * Math.abs(Math.sin(t * (0.9 + (i % 5) * 0.21) + i * 1.7 + seed));
    g.fillStyle = i % 4 === 0 ? HI : G;
    const bw = w / n - 3;
    g.fillRect(x + i * (w / n), y + h - v * h, bw, v * h);
  }
}

const DRAW = {
  code(g, t, p) {
    frame(g, p.title);
    const lines = p.lines;
    const total = lines.join("").length + lines.length;
    const shown = Math.floor(((t * 26) % (total + 60)));
    g.font = `19px ${MONO}`;
    let left = shown;
    lines.forEach((line, i) => {
      if (left <= 0) return;
      const part = line.slice(0, left);
      left -= line.length + 1;
      const y = 66 + i * 23;
      g.fillStyle = line.startsWith("#") ? HI : /return|bool|void|int|if|else/.test(line) ? G : DIM;
      g.fillText(part, 22, y);
      if (left <= 0 && Math.floor(t * 3) % 2 === 0) g.fillRect(22 + g.measureText(part).width + 2, y - 16, 10, 19);
    });
  },
  boot(g, t, p) {
    frame(g, p.title);
    g.font = `19px ${MONO}`;
    const step = Math.floor(t * 2.2) % (BOOT.length + 6);
    BOOT.forEach((label, i) => {
      if (i > step) return;
      const y = 70 + i * 28;
      g.fillStyle = DIM;
      g.fillText(`> ${label}`.padEnd(26, "."), 22, y);
      const ok = i < step;
      g.fillStyle = ok ? G : AMBER;
      g.fillText(ok ? "[OK]" : "[..]", TW - 86, y);
    });
    if (step >= BOOT.length) {
      g.fillStyle = HI;
      g.fillText("> All systems online.", 22, 70 + BOOT.length * 28);
      g.fillText(`root@cyber:~$ ${Math.floor(t * 3) % 2 ? "_" : ""}`, 22, TH - 24);
    }
  },
  network(g, t, p) {
    frame(g, p.title);
    g.font = `19px ${MONO}`;
    IPS.forEach((ip, i) => {
      const y = 72 + i * 30;
      const state = IP_STATES[(Math.floor(t * 0.8 + i * 1.7)) % IP_STATES.length];
      g.fillStyle = DIM;
      g.fillText(`IP ${ip}`, 22, y);
      g.fillStyle = state === "SCANNING" ? AMBER : state === "SECURED" ? HI : G;
      g.fillText(state, 300, y);
    });
    bars(g, 22, TH - 70, TW - 44, 46, 26, t, 1);
  },
  protocol(g, t, p) {
    frame(g, p.title);
    g.font = `19px ${MONO}`;
    PROTOCOLS.forEach(([name, state], i) => {
      const y = 72 + i * 30;
      g.fillStyle = DIM;
      g.fillText(`> ${name}`, 22, y);
      g.fillStyle = G;
      g.fillText(`[${state}]`, 330, y);
    });
    g.fillStyle = Math.floor(t * 2) % 2 ? HI : G;
    g.fillText("> System Secure", 22, TH - 28);
  },
  map(g, t, p) {
    frame(g, p.title);
    g.drawImage(p.mapCanvas, 18, 50);
    const pts = p.cities;
    g.strokeStyle = "rgba(160, 255, 200, 0.7)";
    g.lineWidth = 1.5;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i * 5 + 3) % pts.length];
      const mx = (a[0] + b[0]) / 2;
      const my = Math.min(a[1], b[1]) - 30;
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.quadraticCurveTo(mx, my, b[0], b[1]);
      g.stroke();
      const u = (t * 0.45 + i * 0.13) % 1;
      const qx = (1 - u) ** 2 * a[0] + 2 * (1 - u) * u * mx + u * u * b[0];
      const qy = (1 - u) ** 2 * a[1] + 2 * (1 - u) * u * my + u * u * b[1];
      g.fillStyle = "#fff";
      g.fillRect(qx - 2, qy - 2, 4, 4);
    }
    for (const [x, y] of pts) {
      g.fillStyle = HI;
      g.beginPath();
      g.arc(x, y, 3.5, 0, Math.PI * 2);
      g.fill();
    }
    g.font = `16px ${MONO}`;
    const stats = [["NODES", 1280 + Math.floor(t * 3) % 40], ["COUNTRIES", 195], ["TCP", "42.6K"], ["UDP", "13.3K"], ["THREATS", 32], ["STATUS", "SECURE"]];
    stats.forEach(([k, v], i) => {
      g.fillStyle = DIM;
      g.fillText(k, 22 + (i % 3) * 160, TH - 44 + Math.floor(i / 3) * 22);
      g.fillStyle = HI;
      g.fillText(String(v), 112 + (i % 3) * 160, TH - 44 + Math.floor(i / 3) * 22);
    });
  },
  fingerprint(g, t, p) {
    frame(g, p.title);
    const cx = TW / 2;
    const cy = 170;
    g.strokeStyle = G;
    g.lineWidth = 3;
    g.lineCap = "round";
    for (let r = 14; r <= 98; r += 12) {
      g.beginPath();
      g.arc(cx, cy, r, Math.PI * (1.02 + (r % 24) / 300), Math.PI * (1.98 + r / 900));
      g.stroke();
      g.beginPath();
      g.arc(cx, cy + 6, r * 0.92, Math.PI * 0.15, Math.PI * (0.85 - r / 600));
      g.stroke();
    }
    const scan = cy - 100 + ((t * 120) % 210);
    const grad = g.createLinearGradient(0, scan - 24, 0, scan);
    grad.addColorStop(0, "rgba(0, 255, 102, 0)");
    grad.addColorStop(1, "rgba(200, 255, 220, 0.85)");
    g.fillStyle = grad;
    g.fillRect(cx - 120, scan - 24, 240, 24);
    for (const [x, y, sx, sy] of [[cx - 130, cy - 110, 1, 1], [cx + 130, cy - 110, -1, 1], [cx - 130, cy + 110, 1, -1], [cx + 130, cy + 110, -1, -1]]) {
      g.beginPath();
      g.moveTo(x, y + sy * 26); g.lineTo(x, y); g.lineTo(x + sx * 26, y);
      g.stroke();
    }
    if (Math.floor(t * 1.6) % 3 !== 0) {
      g.fillStyle = "rgba(0, 255, 102, 0.2)";
      g.fillRect(cx - 120, TH - 54, 240, 34);
      g.strokeRect(cx - 120, TH - 54, 240, 34);
      g.font = `20px ${MONO}`;
      g.fillStyle = HI;
      g.textAlign = "center";
      g.fillText("ACCESS GRANTED", cx, TH - 30);
      g.textAlign = "start";
    }
  },
  stream(g, t, p) {
    frame(g, p.title);
    g.font = `18px ${MONO}`;
    const start = Math.floor(t * 1.5);
    for (let i = 0; i < 9; i++) {
      const line = STREAM[(start + i) % STREAM.length];
      g.fillStyle = line.includes("WARN") ? AMBER : i === 8 ? HI : DIM;
      g.fillText(line, 22, 70 + i * 30);
    }
  },
  words(g, t) {
    g.clearRect(0, 0, TW, TH);
    const words = ["ANALYZE", "DETECT", "PROTECT", "PREVENT"];
    const lit = Math.floor(t * 1.2) % words.length;
    g.font = `bold 54px ${MONO}`;
    words.forEach((w, i) => {
      // Glow without shadowBlur (expensive on the CPU): a wide faint stroke under the text.
      if (i === lit) {
        g.strokeStyle = "rgba(0, 255, 102, 0.35)";
        g.lineWidth = 8;
        g.strokeText(w, 40, 82 + i * 76);
      }
      g.fillStyle = i === lit ? HI : DIM;
      g.fillText(w, 40, 82 + i * 76);
    });
    g.fillStyle = G;
    g.fillRect(18, 34, 4, TH - 60);
  },
};

function mapCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(0, 255, 102, 0.75)";
  const step = 2;
  for (let y = 0; y < MASK_H; y += step) {
    for (let x = 0; x < MASK_W; x += step) {
      if (land(x, y)) g.fillRect((x / MASK_W) * w, (y / MASK_H) * h, 2.2, 2.2);
    }
  }
  return c;
}

export class HoloPanels {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.panels = [];
    this.next = 0;
    this.tick = 0;
    this.every = 3;
    this.boost = 0;
    this.live = true;
    const mapW = TW - 36;
    const mapH = 210;
    const cities = [[0.70, 0.33], [0.50, 0.22], [0.29, 0.28], [0.89, 0.30], [0.92, 0.69], [0.37, 0.63], [0.65, 0.36], [0.79, 0.49], [0.17, 0.29], [0.60, 0.19], [0.54, 0.40]]
      .map(([x, y]) => [18 + x * mapW, 50 + y * mapH]);
    const specs = [
      // kind, title, x, y, z, rotY, width, extra
      ["code", "// MAIN.CPP", -7.4, 3.7, -4.6, 0.5, 3.0, { lines: CODE_MAIN }],
      ["boot", "// SYSTEM INITIALIZATION", -7.0, 1.15, -3.4, 0.46, 2.8],
      ["network", "// NETWORK ANALYSIS", -6.5, -1.15, -2.4, 0.42, 2.6],
      ["protocol", "// SECURITY PROTOCOL", -10.6, 0.6, -7.5, 0.55, 3.0],
      ["words", "", -4.7, 1.35, -1.6, 0.32, 1.7],
      ["map", "// GLOBAL NETWORK", 7.4, 3.6, -4.6, -0.5, 3.1, { mapCanvas: mapCanvas(mapW, mapH), cities }],
      ["code", "// CYBER SECURITY", 7.0, 1.1, -3.4, -0.46, 2.8, { lines: CODE_AUTH }],
      ["stream", "// DATA STREAM", 6.5, -1.15, -2.4, -0.42, 2.6],
      ["fingerprint", "// BIOMETRIC SCAN", 10.6, 0.8, -7.5, -0.55, 2.6],
    ];
    specs.forEach(([kind, title, x, y, z, rotY, width, extra = {}], i) => {
      const canvas = document.createElement("canvas");
      canvas.width = TW;
      canvas.height = TH;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 2;
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, (width * TH) / TW), mat);
      mesh.position.set(x, y, z);
      mesh.rotation.y = rotY;
      this.group.add(mesh);
      const p = { kind, title, mesh, mat, tex, g: canvas.getContext("2d"), base: mesh.position.clone(), phase: i * 0.9, ...extra };
      DRAW[kind](p.g, i * 3.1, p);
      tex.needsUpdate = true;
      this.panels.push(p);
    });
  }

  pulse() {
    this.boost = 1;
  }

  update(t, dt) {
    for (const p of this.panels) {
      p.mesh.position.y = p.base.y + Math.sin(t * 0.6 + p.phase) * 0.07;
      const flicker = Math.sin(t * 23 + p.phase * 7) > 0.995 ? 0.5 : 1;
      p.mat.color.setScalar((0.82 + Math.sin(t * 1.3 + p.phase) * 0.1 + this.boost * 0.9) * flicker);
    }
    this.boost *= Math.exp(-dt * 3);
    if (!this.live) return;
    // Redraw one panel every few frames (round-robin): each window refreshes ~2-3 times per
    // second, which keeps typing/scrolling alive at a tiny CPU and texture-upload cost.
    if (++this.tick % this.every) return;
    const p = this.panels[this.next];
    this.next = (this.next + 1) % this.panels.length;
    DRAW[p.kind](p.g, t + p.phase * 3, p);
    p.tex.needsUpdate = true;
  }
}
