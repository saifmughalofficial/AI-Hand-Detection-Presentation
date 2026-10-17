// Holographic cyber scene: dotted Earth with data arcs, orbit rings, light beam, ripple floor,
// neon skyline, falling 3D binary streams, floating hex icons and live holographic HUD windows.
// Reacts to hand gestures.
import * as THREE from "../vendor/three.module.min.js";
import { MASK_W, MASK_H, MASK_HEX } from "./worldmask.js";
import { HoloPanels } from "./panels.js";

const R = 2;
const GREEN = 0x00ff66;
const MASK = Uint8Array.from(MASK_HEX.match(/../g), (h) => parseInt(h, 16));

function isLand(lat, lon) {
  const x = Math.min(MASK_W - 1, Math.max(0, Math.floor(((lon + 180) / 360) * MASK_W)));
  const y = Math.min(MASK_H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * MASK_H)));
  const i = y * MASK_W + x;
  return (MASK[i >> 3] >> (7 - (i & 7))) & 1;
}

function latLon(lat, lon, r = R) {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lon + 180);
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

const CITIES = {
  lahore: [31.5, 74.3], london: [51.5, -0.1], ny: [40.7, -74], tokyo: [35.7, 139.7], sydney: [-33.9, 151.2],
  sao: [-23.5, -46.6], dubai: [25.2, 55.3], singapore: [1.35, 103.8], sf: [37.8, -122.4], moscow: [55.8, 37.6],
  cairo: [30, 31.2], joburg: [-26.2, 28], mumbai: [19, 72.8], beijing: [39.9, 116.4], paris: [48.9, 2.35],
};
const ROUTES = [
  ["lahore", "london"], ["lahore", "dubai"], ["lahore", "beijing"], ["ny", "london"], ["sf", "tokyo"],
  ["sydney", "singapore"], ["sao", "ny"], ["dubai", "joburg"], ["paris", "moscow"], ["mumbai", "singapore"],
  ["london", "cairo"], ["tokyo", "sydney"], ["sf", "ny"], ["dubai", "london"], ["beijing", "moscow"],
];

const FRESNEL_VS = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying float vY;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    vY = (modelMatrix * vec4(position, 1.0)).y;
    gl_Position = projectionMatrix * mv;
  }`;

function canvasTexture(draw, w = 256, h = 256) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const dotTexture = () => canvasTexture((g) => {
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.8)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
}, 64, 64);

const GLYPHS = {
  shield(g) {
    g.beginPath();
    g.moveTo(128, 66); g.lineTo(176, 84); g.lineTo(176, 124);
    g.quadraticCurveTo(174, 168, 128, 190); g.quadraticCurveTo(82, 168, 80, 124);
    g.lineTo(80, 84); g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(106, 128); g.lineTo(122, 144); g.lineTo(152, 112); g.stroke();
  },
  lock(g) {
    g.beginPath(); g.roundRect(88, 118, 80, 64, 8); g.stroke();
    g.beginPath(); g.moveTo(104, 118); g.lineTo(104, 100); g.arc(128, 100, 24, Math.PI, 0); g.lineTo(152, 118); g.stroke();
    g.beginPath(); g.arc(128, 143, 8, 0, Math.PI * 2); g.fill();
    g.fillRect(125, 146, 6, 18);
  },
  hand(g) {
    for (const [x, top] of [[104, 84], [122, 70], [140, 72], [158, 88]]) {
      g.beginPath(); g.moveTo(x, 132); g.lineTo(x, top); g.stroke();
    }
    g.beginPath(); g.moveTo(96, 128); g.quadraticCurveTo(94, 186, 132, 188); g.quadraticCurveTo(166, 186, 166, 128); g.stroke();
    g.beginPath(); g.moveTo(98, 152); g.lineTo(78, 124); g.stroke();
  },
  target(g) {
    for (const r of [52, 30]) { g.beginPath(); g.arc(128, 128, r, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.arc(128, 128, 7, 0, Math.PI * 2); g.fill();
    g.beginPath();
    g.moveTo(128, 60); g.lineTo(128, 88); g.moveTo(128, 168); g.lineTo(128, 196);
    g.moveTo(60, 128); g.lineTo(88, 128); g.moveTo(168, 128); g.lineTo(196, 128); g.stroke();
  },
  network(g) {
    const n = [[128, 78], [82, 162], [174, 162], [128, 132]];
    g.beginPath();
    for (const [a, b] of [[0, 1], [0, 2], [1, 2], [0, 3], [1, 3], [2, 3]]) { g.moveTo(...n[a]); g.lineTo(...n[b]); }
    g.stroke();
    for (const [x, y] of n) { g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill(); }
  },
  fingerprint(g) {
    for (const r of [12, 26, 40, 54]) { g.beginPath(); g.arc(128, 140, r, Math.PI * 1.05, Math.PI * 1.95 + r / 200); g.stroke(); }
    g.beginPath(); g.moveTo(74, 140); g.quadraticCurveTo(80, 186, 110, 192); g.moveTo(182, 140); g.quadraticCurveTo(180, 176, 158, 190); g.stroke();
  },
  chip(g) {
    g.beginPath(); g.roundRect(92, 92, 72, 72, 6); g.stroke();
    g.strokeRect(112, 112, 32, 32);
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      const p = 102 + i * 17;
      g.moveTo(p, 92); g.lineTo(p, 74); g.moveTo(p, 164); g.lineTo(p, 182);
      g.moveTo(92, p); g.lineTo(74, p); g.moveTo(164, p); g.lineTo(182, p);
    }
    g.stroke();
  },
  cloud(g) {
    g.beginPath();
    g.moveTo(92, 160); g.arc(96, 140, 20, Math.PI * 0.5, Math.PI * 1.5);
    g.arc(124, 116, 30, Math.PI * 1.1, Math.PI * 1.9); g.arc(160, 136, 24, Math.PI * 1.4, Math.PI * 0.5);
    g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(128, 178); g.lineTo(128, 142); g.moveTo(114, 156); g.lineTo(128, 142); g.lineTo(142, 156); g.stroke();
  },
};

const iconTexture = (kind) => canvasTexture((g) => {
  g.strokeStyle = g.fillStyle = "#00ff66";
  g.lineJoin = g.lineCap = "round";
  g.shadowColor = "#00ff66";
  g.shadowBlur = 16;
  const hex = (r) => {
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      g.lineTo(128 + r * Math.cos(a), 128 + r * Math.sin(a));
    }
    g.closePath();
  };
  g.lineWidth = 7; hex(112); g.stroke();
  g.globalAlpha = 0.12; hex(98); g.fill();
  g.globalAlpha = 0.4; g.lineWidth = 3; hex(98); g.stroke();
  g.globalAlpha = 1; g.lineWidth = 8;
  GLYPHS[kind](g);
});

const digitAtlas = () => canvasTexture((g) => {
  g.fillStyle = "#fff";
  g.font = "bold 54px Consolas, 'Courier New', monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("0", 32, 34);
  g.fillText("1", 96, 34);
}, 128, 64);

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x010603, 0.032);
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
    this.uTime = { value: 0 };
    this.uPointScale = { value: 400 };
    this.time = 0;
    this.spin = 0;
    this.beamBoost = 0;
    this.hand = { x: 0.5, y: 0.5, present: false };
    this.kick = new THREE.Vector2();
    this.kickVel = new THREE.Vector2();
    this.mouse = new THREE.Vector2();
    this.focus = null;
    this.extras = [];
    this.quality = "auto";
    this.panelsLive = true;
    this.background = false;
    this.prCap = 1.5;
    this.target = 60;
    this.fps = 0;
    this.onNotice = null;
    this._acc = 0;
    this._last = performance.now();
    this._frames = 0;
    this._fpsT = this._last;
    this._slowSeconds = 0;
    this._downgrades = 0;

    this.dot = dotTexture();
    this._build();
    this.resize();
    addEventListener("resize", () => this.resize());
    addEventListener("pointermove", (e) => this.mouse.set(e.clientX / innerWidth - 0.5, e.clientY / innerHeight - 0.5), { passive: true });
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ------------------------------------------------------------------ construction

  _pointsMaterial(size, color, opacity) {
    return new THREE.PointsMaterial({
      size, map: this.dot, color, opacity, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
  }

  _points(arr, size, color, opacity) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    return new THREE.Points(g, this._pointsMaterial(size, color, opacity));
  }

  _lineMaterial(opacity, color = GREEN) {
    return new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  }

  _build() {
    this.globe = new THREE.Group();
    this.globe.position.set(0, 0.9, 0);
    this.scene.add(this.globe);
    this.spinGroup = new THREE.Group();
    this.spinGroup.rotation.y = 4.0;
    this.globe.add(this.spinGroup);

    this._buildGlobe();
    this._buildArcs();
    this._buildOrbits();
    this._buildBeam();
    this._buildFloor();
    this._buildSkyline();
    this._buildStreams();
    this._buildIcons();
    this.panels = new HoloPanels(this.scene);
  }

  _buildGlobe() {
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.985, 64, 48),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(GREEN) }, uBase: { value: new THREE.Color(0x001a0b) } },
        vertexShader: FRESNEL_VS,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; uniform vec3 uBase; varying vec3 vN; varying vec3 vV;
          void main() {
            float f = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 3.2);
            gl_FragColor = vec4(uBase + uColor * f * 0.5, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.globe.add(core);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.2, 64, 48),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(GREEN) } },
        vertexShader: FRESNEL_VS,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
          void main() {
            float d = clamp(-dot(normalize(vN), normalize(vV)), 0.0, 1.0);
            float a = clamp(pow(d / 0.56, 3.0), 0.0, 1.0) * 0.85;
            gl_FragColor = vec4(uColor * a, 1.0);
            #include <colorspace_fragment>
          }`,
        side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    this.globe.add(atmosphere);

    const land = [];
    const ocean = [];
    const N = 15000;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const lat = THREE.MathUtils.radToDeg(Math.asin(y));
      const lon = THREE.MathUtils.radToDeg((golden * i) % (Math.PI * 2)) - 180;
      if (isLand(lat, lon)) land.push(...latLon(lat, lon, R * 1.003).toArray());
      else if (i % 4 === 0) ocean.push(...latLon(lat, lon, R * 1.002).toArray());
    }
    this.spinGroup.add(this._points(land, 0.075, 0x8dffb8, 1));
    this.spinGroup.add(this._points(ocean, 0.03, GREEN, 0.18));

    const grat = [];
    const push = (a, b) => grat.push(...a.toArray(), ...b.toArray());
    for (let lon = -180; lon < 180; lon += 20) {
      for (let lat = -90; lat < 90; lat += 3) push(latLon(lat, lon, R * 1.004), latLon(lat + 3, lon, R * 1.004));
    }
    for (let lat = -60; lat <= 60; lat += 20) {
      for (let lon = -180; lon < 180; lon += 3) push(latLon(lat, lon, R * 1.004), latLon(lat, lon + 3, R * 1.004));
    }
    const gratGeo = new THREE.BufferGeometry();
    gratGeo.setAttribute("position", new THREE.Float32BufferAttribute(grat, 3));
    this.spinGroup.add(new THREE.LineSegments(gratGeo, this._lineMaterial(0.13)));
  }

  _buildArcs() {
    this.arcs = ROUTES.map(([a, b], i) => {
      const A = latLon(...CITIES[a], R * 1.01);
      const B = latLon(...CITIES[b], R * 1.01);
      const mid = A.clone().add(B).multiplyScalar(0.5).setLength(R + 0.2 + A.distanceTo(B) * 0.3);
      const curve = new THREE.QuadraticBezierCurve3(A, mid, B);
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(64));
      this.spinGroup.add(new THREE.Line(geo, this._lineMaterial(0.75, 0x5cff9d)));
      return { curve, geo, count: 65, phase: i * 0.83 + Math.random() * 2, period: 5 + Math.random() * 3 };
    });
    this.pulsePositions = new Float32Array(this.arcs.length * 3);
    const pulseGeo = new THREE.BufferGeometry();
    pulseGeo.setAttribute("position", new THREE.BufferAttribute(this.pulsePositions, 3));
    this.pulses = new THREE.Points(pulseGeo, this._pointsMaterial(0.2, 0xd8ffe6, 1));
    this.spinGroup.add(this.pulses);

    const cityPts = [];
    this.cityRings = [];
    const ringGeo = new THREE.RingGeometry(0.05, 0.068, 32);
    for (const [lat, lon] of Object.values(CITIES)) {
      const p = latLon(lat, lon, R * 1.012);
      cityPts.push(...p.toArray());
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0x9dffc2, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      ring.position.copy(p);
      ring.lookAt(p.clone().multiplyScalar(2));
      ring.userData.phase = Math.random() * 2;
      this.spinGroup.add(ring);
      this.cityRings.push(ring);
    }
    this.spinGroup.add(this._points(cityPts, 0.13, 0xc8ffd9, 1));
  }

  _buildOrbits() {
    const satGeo = new THREE.OctahedronGeometry(0.075);
    const satMat = new THREE.MeshBasicMaterial({ color: 0xb9ffd2, wireframe: true });
    this.orbits = [[3.0, 1.15, 0.2, 0.25], [3.55, -0.45, 0.9, -0.17], [2.6, 0.25, -0.6, 0.34]].map(([r, rx, rz, speed], i) => {
      const group = new THREE.Group();
      group.rotation.set(rx, 0, rz);
      this.globe.add(group);
      const pts = [];
      for (let k = 0; k <= 180; k++) {
        const a = (k / 180) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = i === 1
        ? new THREE.Line(geo, new THREE.LineDashedMaterial({
          color: GREEN, dashSize: 0.14, gapSize: 0.1, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
        }))
        : new THREE.Line(geo, this._lineMaterial(0.35));
      if (i === 1) line.computeLineDistances();
      group.add(line);
      const sats = new THREE.Group();
      group.add(sats);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + i;
        const m = new THREE.Mesh(satGeo, satMat);
        m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.dot, color: GREEN, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        glow.scale.setScalar(0.42);
        m.add(glow);
        sats.add(m);
      }
      return { sats, speed };
    });
  }

  _buildBeam() {
    const mat = (strength) => new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(GREEN) }, uBoost: { value: 0 }, uStrength: { value: strength } },
      vertexShader: FRESNEL_VS,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uBoost; uniform float uStrength;
        varying vec3 vN; varying vec3 vV; varying float vY;
        void main() {
          float facing = abs(dot(normalize(vN), normalize(vV)));
          float v = smoothstep(-2.0, -1.2, vY) * smoothstep(15.0, 3.0, vY);
          float a = pow(facing, 2.5) * v * uStrength * (1.0 + uBoost);
          gl_FragColor = vec4(uColor * a, 1.0);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.beamMats = [mat(0.2), mat(0.9)];
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 18, 32, 1, true), this.beamMats[0]);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 18, 16, 1, true), this.beamMats[1]);
    outer.position.y = inner.position.y = 7;
    this.scene.add(outer, inner);
  }

  _buildFloor() {
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uColor: { value: new THREE.Color(GREEN) }, uPulse: { value: -100 } },
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform float uPulse; varying vec3 vW;
        float grid(vec2 p, float s) {
          vec2 q = p / s;
          vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
          return 1.0 - min(min(g.x, g.y), 1.0);
        }
        void main() {
          vec2 p = vW.xz;
          float d = length(p);
          float fade = smoothstep(32.0, 3.0, d);
          float g = grid(p, 1.0) * 0.35 + grid(p, 4.0) * 0.55;
          float rings = pow(max(0.0, sin(d * 4.0 - uTime * 2.2)), 16.0) * smoothstep(5.5, 0.8, d);
          float pool = exp(-d * d * 0.35);
          float pt = uTime - uPulse;
          float wave = exp(-abs(d - pt * 9.0) * 2.2) * smoothstep(2.4, 0.0, pt);
          float a = g * fade * 0.5 + rings * 0.85 + pool * 0.9 + wave * 1.5;
          gl_FragColor = vec4(uColor * a, 1.0);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.9;
    this.scene.add(floor);

    const map = [];
    for (let y = 0; y < MASK_H; y += 2) {
      for (let x = 0; x < MASK_W; x += 2) {
        const lat = 90 - ((y + 0.5) / MASK_H) * 180;
        const lon = ((x + 0.5) / MASK_W) * 360 - 180;
        if (isLand(lat, lon)) map.push((x / MASK_W - 0.5) * 18, -1.88, (y / MASK_H - 0.5) * 9 + 3.4);
      }
    }
    this.scene.add(this._points(map, 0.07, GREEN, 0.35));
  }

  _buildSkyline() {
    const boxes = [];
    for (let i = 0; i < 170; i++) {
      let x = (Math.random() * 2 - 1) * 30;
      const z = -9 - Math.random() * 26;
      if (Math.abs(x) < 4 && z > -15) x += Math.sign(x || 1) * 4.5;
      const w = 0.6 + Math.random() * 1.4;
      const d = 0.6 + Math.random() * 1.4;
      const h = 0.8 + Math.random() ** 2 * 5.5 * (1 + Math.abs(x) / 24);
      boxes.push({ x, z, w, d, h });
    }
    const body = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
      new THREE.MeshBasicMaterial({ color: 0x010d06 }),
      boxes.length,
    );
    const m = new THREE.Matrix4();
    const edges = [];
    const windows = [];
    const seeds = [];
    boxes.forEach((b, i) => {
      m.compose(new THREE.Vector3(b.x, -1.9, b.z), new THREE.Quaternion(), new THREE.Vector3(b.w, b.h, b.d));
      body.setMatrixAt(i, m);
      const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
      const y0 = -1.9, y1 = -1.9 + b.h;
      const c = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
      for (let k = 0; k < 4; k++) {
        const [ax, az] = c[k];
        const [bx, bz] = c[(k + 1) % 4];
        edges.push(ax, y0, az, bx, y0, bz, ax, y1, az, bx, y1, bz, ax, y0, az, ax, y1, az);
      }
      const n = Math.floor(b.h * 1.6);
      for (let k = 0; k < n; k++) {
        windows.push(x0 + 0.12 + Math.random() * (b.w - 0.24), y0 + 0.3 + Math.random() * (b.h - 0.5), z1 + 0.02);
        seeds.push(Math.random());
      }
    });
    this.scene.add(body);
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.Float32BufferAttribute(edges, 3));
    this.scene.add(new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: GREEN, transparent: true, opacity: 0.22 })));

    const winGeo = new THREE.BufferGeometry();
    winGeo.setAttribute("position", new THREE.Float32BufferAttribute(windows, 3));
    winGeo.setAttribute("aSeed", new THREE.Float32BufferAttribute(seeds, 1));
    this.scene.add(new THREE.Points(winGeo, new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uScale: this.uPointScale, uColor: { value: new THREE.Color(GREEN) } },
      vertexShader: /* glsl */ `
        attribute float aSeed; uniform float uTime; uniform float uScale; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uScale * 0.09 / -mv.z;
          float k = floor(uTime * 0.5 + aSeed * 10.0);
          float on = step(0.4, fract(sin(aSeed * 91.7 + k * 13.1) * 43758.5453));
          vA = on * (0.25 + 0.6 * fract(aSeed * 7.3)) * smoothstep(42.0, 10.0, -mv.z);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vA;
        void main() {
          vec2 c = abs(gl_PointCoord - 0.5);
          if (max(c.x, c.y) > 0.42) discard;
          gl_FragColor = vec4(uColor * vA, 1.0);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })));
  }

  _buildStreams() {
    const STREAMS = 120;
    const TRAIL = 14;
    const stream = [];
    const index = [];
    for (let s = 0; s < STREAMS; s++) {
      let x = (Math.random() * 2 - 1) * 17;
      const z = -17 + Math.random() * 20;
      if (Math.abs(x) < 2.8 && z > -2.5) x += Math.sign(x || 1) * 3;
      const speed = 1.6 + Math.random() * 2.6;
      const phase = Math.random() * 40;
      for (let t = 0; t < TRAIL; t++) {
        stream.push(x, z, speed, phase);
        index.push(t);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(STREAMS * TRAIL * 3), 3));
    geo.setAttribute("aStream", new THREE.Float32BufferAttribute(stream, 4));
    geo.setAttribute("aIndex", new THREE.Float32BufferAttribute(index, 1));
    this.streams = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uTime, uScale: this.uPointScale, uAtlas: { value: digitAtlas() },
        uColor: { value: new THREE.Color(GREEN) },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aStream; attribute float aIndex;
        uniform float uTime; uniform float uScale;
        varying float vAlpha; varying float vChar; varying float vHead;
        void main() {
          float head = 11.0 - mod(uTime * aStream.z + aStream.w, 17.0);
          float y = head + aIndex * 0.36;
          vec4 mv = modelViewMatrix * vec4(aStream.x, y, aStream.y, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uScale * 0.3 / -mv.z;
          float trail = 1.0 - aIndex / 14.0;
          vAlpha = trail * trail * smoothstep(-2.6, -1.2, y) * smoothstep(12.0, 8.0, y) * smoothstep(34.0, 8.0, -mv.z);
          vHead = step(aIndex, 0.5);
          vChar = step(0.5, fract(sin(dot(vec2(aIndex + aStream.x, floor(uTime * 5.0 + aStream.w)), vec2(12.9898, 78.233))) * 43758.5453));
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas; uniform vec3 uColor;
        varying float vAlpha; varying float vChar; varying float vHead;
        void main() {
          vec2 uv = vec2((gl_PointCoord.x + vChar) * 0.5, 1.0 - gl_PointCoord.y);
          float a = texture2D(uAtlas, uv).a * vAlpha;
          vec3 col = mix(uColor, vec3(0.85, 1.0, 0.9), vHead);
          gl_FragColor = vec4(col * a, 1.0);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.streams.frustumCulled = false;
    this.scene.add(this.streams);
  }

  _buildIcons() {
    const spots = [
      ["shield", -3.9, 2.6, -0.5, 0.95], ["lock", 3.9, 2.4, -0.8, 0.95], ["hand", -3.4, -0.5, 0.8, 0.85],
      ["fingerprint", 3.6, -0.3, 0.6, 0.85], ["network", -2.4, 3.8, -2.2, 0.75], ["target", 2.5, 3.9, -2.4, 0.75],
      ["chip", -6.0, 1.2, -3.4, 0.8], ["cloud", 6.2, 1.5, -3.6, 0.8],
    ];
    this.icons = spots.map(([kind, x, y, z, s], i) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: iconTexture(kind), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.85,
      }));
      sp.scale.setScalar(s);
      sp.position.set(x, y, z);
      this.scene.add(sp);
      return { sp, base: sp.position.clone(), phase: i * 1.3 };
    });
  }

  // ------------------------------------------------------------------ public API

  setQuality(q) {
    this.quality = q;
    this.canvas.style.visibility = q === "off" ? "hidden" : "visible";
    this.prCap = q === "ultra" ? 2 : q === "low" ? 0.75 : 1.5;
    this.target = q === "low" ? 30 : 60;
    this.streams.visible = q !== "low";
    this.panelsLive = q !== "low";
    this.panels.every = 3;
    this._downgrades = 0;
    this._slowSeconds = 0;
    this.resize();
  }

  setFocusRect(rect) {
    this.focus = rect;
    this._applyFocus();
    this.camera.updateProjectionMatrix();
  }

  setHand(point, present) {
    if (present && point) {
      this.hand.x = point.x;
      this.hand.y = point.y;
    }
    this.hand.present = present;
  }

  pulse(action) {
    this.floorMat.uniforms.uPulse.value = this.time;
    this.beamBoost = 1.6;
    this.panels.pulse();
    const [dx, dy] = { LEFT: [-1, 0], RIGHT: [1, 0], UP: [0, 1], DOWN: [0, -1] }[action] || [0, 0];
    this.spin += dx * 2.6;
    this.kickVel.x -= dx * 5;
    this.kickVel.y += dy * 3.5;
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.prCap));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this._applyFocus();
    this.camera.updateProjectionMatrix();
    this.uPointScale.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
  }

  _applyFocus() {
    const w = innerWidth;
    const h = innerHeight;
    if (!this.focus || !this.focus.width) {
      this.camera.clearViewOffset();
      return;
    }
    const ox = w / 2 - (this.focus.left + this.focus.width / 2);
    const oy = h / 2 - (this.focus.top + this.focus.height / 2);
    this.camera.setViewOffset(w, h, ox, oy, w, h);
  }

  // ------------------------------------------------------------------ animation

  _loop(now) {
    requestAnimationFrame(this._loop);
    const dt = Math.min((now - this._last) / 1000, 0.1);
    this._last = now;
    if (this.quality === "off") return;
    for (const fn of this.extras) fn(dt);

    this._acc += dt;
    const target = this.background ? Math.min(30, this.target) : this.target;
    if (target < 60 && this._acc < 1 / target - 0.002) return;
    const step = Math.min(this._acc, 0.1);
    this._acc = 0;
    this._update(step);
    this.renderer.render(this.scene, this.camera);

    this._frames++;
    if (now - this._fpsT >= 1000) {
      this.fps = (this._frames * 1000) / (now - this._fpsT);
      this._frames = 0;
      this._fpsT = now;
      this._adapt();
    }
  }

  _adapt() {
    if (this.quality !== "auto" || document.hidden || this.background) return;
    this._slowSeconds = this.fps < 45 ? this._slowSeconds + 1 : 0;
    if (this._slowSeconds < 3) return;
    this._slowSeconds = 0;
    // Each step frees GPU/CPU time for hand tracking; steps that would change nothing are skipped.
    const steps = [
      () => { this.panels.every = 6; return "slowed the holographic window refresh"; },
      () => {
        if (Math.min(window.devicePixelRatio || 1, this.prCap) <= 1) return null;
        this.prCap = 1;
        this.resize();
        return "lowered render resolution";
      },
      () => { this.streams.visible = false; return "disabled 3D binary streams"; },
      () => { this.target = 30; return "capped the background at 30 FPS (camera tracking keeps full speed)"; },
    ];
    while (this._downgrades < steps.length) {
      const done = steps[this._downgrades++]();
      if (done) {
        this.onNotice?.(`3D effects: ${done} to keep tracking smooth.`);
        return;
      }
    }
  }

  /**
   * Background mode (a document covers the scene): 30 FPS and frozen HUD windows, so almost all
   * of the GPU and CPU go to hand tracking and page rendering.
   */
  setBackground(on) {
    this.background = on;
  }

  _update(dt) {
    this.time += dt;
    const t = this.time;
    this.uTime.value = t;

    this.spin *= Math.exp(-dt * 1.6);
    this.spinGroup.rotation.y += (0.09 + this.spin) * dt;
    const tiltX = this.hand.present ? (this.hand.y - 0.5) * 0.7 : 0;
    const tiltZ = this.hand.present ? -(this.hand.x - 0.5) * 0.5 : 0;
    const ease = Math.min(1, dt * 3);
    this.globe.rotation.x += (tiltX - this.globe.rotation.x) * ease;
    this.globe.rotation.z += (tiltZ - this.globe.rotation.z) * ease;
    this.globe.position.y = 0.9 + Math.sin(t * 0.8) * 0.06;

    this.kickVel.addScaledVector(this.kick, -40 * dt);
    this.kickVel.multiplyScalar(Math.exp(-dt * 6));
    this.kick.addScaledVector(this.kickVel, dt);
    this.camera.position.set(
      Math.sin(t * 0.12) * 0.8 + this.mouse.x * 1.2 + this.kick.x,
      1.5 + Math.sin(t * 0.17) * 0.25 - this.mouse.y * 0.6 + this.kick.y * 0.5,
      10.5,
    );
    this.camera.lookAt(0, 0.7, 0);

    this.arcs.forEach((a, i) => {
      const u = ((t + a.phase) % a.period) / a.period;
      let start = 0;
      let end = 1;
      if (u < 0.35) end = u / 0.35;
      else if (u > 0.65) start = (u - 0.65) / 0.35;
      const s = Math.floor(start * a.count);
      a.geo.setDrawRange(s, Math.max(0, Math.ceil(end * a.count) - s));
      const p = a.curve.getPoint(start + (end - start) * ((t * 0.7 + a.phase) % 1));
      this.pulsePositions.set([p.x, p.y, p.z], i * 3);
    });
    this.pulses.geometry.attributes.position.needsUpdate = true;

    for (const ring of this.cityRings) {
      const k = ((t * 0.6 + ring.userData.phase) % 1);
      ring.scale.setScalar(1 + k * 2.2);
      ring.material.opacity = 1 - k;
    }
    for (const o of this.orbits) {
      o.sats.rotation.y += o.speed * dt;
      for (const m of o.sats.children) m.rotation.x += dt * 1.5;
    }
    for (const ic of this.icons) {
      ic.sp.position.y = ic.base.y + Math.sin(t * 0.9 + ic.phase) * 0.12;
      ic.sp.material.opacity = 0.6 + Math.sin(t * 1.7 + ic.phase) * 0.25;
    }
    this.beamBoost *= Math.exp(-dt * 2.5);
    for (const m of this.beamMats) m.uniforms.uBoost.value = this.beamBoost;
    this.panels.live = this.panelsLive && !this.background;
    this.panels.update(t, dt);
  }
}
