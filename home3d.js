/* ===========================================================
   home3d.js — scroll-driven Three.js homepage experience
   "TECHNICAL DOCUMENT": camera travels a CatmullRom path
   through one continuous bright scene; chapters choreographed
   to camera progress; HTML overlays synced in the same loop.

   Loaded lazily by home-boot.js (after gsap + ScrollTrigger).
   ?DEBUG=1 shows the camera curve, waypoint editor and FPS.
   =========================================================== */

import * as THREE from '/vendor/three/three.module.min.js';

const PAPER = 0xfcfcfa;
const INK = 0x16161c;
const RED = 0xe8362d;

// ---------- camera path (tuned via DEBUG=1) ----------
const WAYPOINTS = [
  [0.0, 0.30, 7.4],   // CH1 hero
  [0.5, 0.40, 4.6],   // approach
  [2.6, 0.60, 1.6],   // entering the explosion
  [3.1, 0.80, -1.6],  // side of exploded stack
  [-6.8, 0.80, -4.4], // swing to bench row, left end
  [0.0, 0.80, -5.0],  // bench row mid
  [6.8, 0.80, -4.4],  // bench row right end
  [3.2, 1.80, -6.8],  // pull back toward vault
  [0.0, 2.60, -8.0]   // settle
];
const LOOK_KEYS = [
  { t: 0.00, p: [0.9, 0.0, 0.0] },
  { t: 0.20, p: [0.9, 0.0, 0.0] },
  { t: 0.36, p: [0.9, 0.0, -0.6] },
  { t: 0.44, p: [-6.8, 0.0, -8.2] },
  { t: 0.53, p: [-3.4, 0.0, -8.2] },
  { t: 0.62, p: [0.0, 0.0, -8.2] },
  { t: 0.71, p: [3.4, 0.0, -8.2] },
  { t: 0.80, p: [6.8, 0.0, -8.2] },
  { t: 0.88, p: [0.0, 0.6, -13.0] },
  { t: 1.00, p: [0.0, 0.6, -13.0] }
];
// Mobile-simplified: hero + deconstruction only
const WAYPOINTS_SIMPLE = [
  [0.0, 0.30, 7.8],
  [0.6, 0.40, 4.8],
  [2.7, 0.70, 1.4],
  [3.1, 0.90, -1.2]
];
const LOOK_KEYS_SIMPLE = [
  { t: 0.00, p: [0.9, 0.0, 0.0] },
  { t: 0.45, p: [0.9, 0.0, 0.0] },
  { t: 1.00, p: [0.9, 0.0, -0.6] }
];
const CHAPTER_BOUNDS = [0, 0.18, 0.40, 0.80, 1];
const CHAPTER_BOUNDS_SIMPLE = [0, 0.45, 1];

// ---------- module state ----------
let renderer, scene, camera, clock;
let curve, lookKeys, waypoints;
let docGroup, explodeLines = [], benches = [], vaultGroup = null;
let progress = 0, targetProgress = 0;
let running = false, rafId = 0;
let simpleMode = false, onFallback = null;
let debug = null;
let chapters = [], prFill = null, glCanvas = null;
let benchCards = [], strikeItems = [];
const fps = { acc: 0, frames: 0, value: 60, lowSince: 0 };

export function start(opts = {}) {
  simpleMode = !!opts.simple;
  onFallback = opts.onFallback || (() => {});
  glCanvas = document.getElementById('gl');
  if (!glCanvas) return;

  try {
    initRenderer();
    initScene();
    initPath();
    initScroll();
    initOverlayRefs();
    initLifecycle();
    if (new URLSearchParams(location.search).get('DEBUG') === '1') initDebug();
    setRunning(true);
  } catch (err) {
    console.warn('home3d init failed', err);
    onFallback();
  }
}

// ---------- renderer / scene ----------
function initRenderer() {
  const wantCapture = new URLSearchParams(location.search).get('DEBUG') === '1';
  renderer = new THREE.WebGLRenderer({
    canvas: glCanvas,
    antialias: true,
    alpha: true,                      // CSS vellum shows through
    preserveDrawingBuffer: wantCapture // only for the debug screenshot
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  clock = new THREE.Clock();

  camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1, 120);
  camera.position.set(...WAYPOINTS[0]);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function initScene() {
  scene = new THREE.Scene();

  // Bright, even studio light — this property is light.
  scene.add(new THREE.HemisphereLight(0xffffff, 0xeeeee9, 1.05));
  scene.add(new THREE.AmbientLight(0xffffff, 0.30));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(4, 8, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -10; key.shadow.camera.right = 10;
  key.shadow.camera.top = 10; key.shadow.camera.bottom = -10;
  key.shadow.camera.far = 30;
  key.shadow.radius = 6;
  scene.add(key);

  // Soft contact-shadow ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.ShadowMaterial({ opacity: 0.10 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2.5;
  ground.receiveShadow = true;
  scene.add(ground);

  docGroup = buildDocument();
  scene.add(docGroup);
  buildExplodeLines();

  if (!simpleMode) {
    buildBenches();
    vaultGroup = buildVault();
    scene.add(vaultGroup);
  }
}

// A paper sheet with a gentle bow, like a real held page.
function bentPlaneGeometry(w, h, bow) {
  const geo = new THREE.PlaneGeometry(w, h, 18, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / (w / 2); // -1..1
    pos.setZ(i, (1 - Math.cos(x * Math.PI * 0.5)) * bow);
  }
  geo.computeVertexNormals();
  return geo;
}

// Procedural page-face texture: faint text blocks on white.
function makePageTexture(kind) {
  const c = document.createElement('canvas');
  c.width = 384; c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = 'rgba(22,22,28,0.32)';
  const line = (lx, ly, lw, lh) => x.fillRect(lx, ly, lw, lh);
  if (kind === 'cover') {
    x.fillStyle = 'rgba(22,22,28,0.6)';
    line(40, 56, 200, 14);
    x.fillStyle = 'rgba(22,22,28,0.28)';
    for (let i = 0; i < 16; i++) line(40, 110 + i * 22, 110 + ((i * 73) % 190), 6);
  } else if (kind === 'text') {
    for (let i = 0; i < 20; i++) line(36, 48 + i * 22, 130 + ((i * 97) % 180), 6);
  } else if (kind === 'image') {
    x.strokeStyle = 'rgba(232,54,45,0.8)';
    x.lineWidth = 3;
    x.strokeRect(60, 90, 264, 200);
    x.beginPath(); x.moveTo(60, 290); x.lineTo(170, 170); x.lineTo(240, 250); x.lineTo(324, 150);
    x.stroke();
    for (let i = 0; i < 6; i++) line(60, 330 + i * 22, 180 + ((i * 67) % 120), 6);
  } else if (kind === 'form') {
    x.strokeStyle = 'rgba(22,22,28,0.5)';
    x.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      line(48, 70 + i * 80, 90, 6);
      x.strokeRect(48, 88 + i * 80, 288, 34);
    }
    x.fillStyle = 'rgba(232,54,45,0.85)';
    x.fillRect(48, 88 + 4 * 80, 16, 16);
  } else if (kind === 'sig') {
    for (let i = 0; i < 10; i++) line(36, 48 + i * 22, 150 + ((i * 53) % 160), 6);
    x.strokeStyle = 'rgba(232,54,45,0.9)';
    x.lineWidth = 3;
    x.beginPath();
    x.moveTo(70, 420);
    x.bezierCurveTo(120, 360, 150, 470, 200, 410);
    x.bezierCurveTo(240, 365, 260, 440, 320, 400);
    x.stroke();
    line(60, 452, 270, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

function paperMaterial(tex) {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: tex || null,
    roughness: 0.94,
    metalness: 0.0,
    side: THREE.DoubleSide
  });
}

// The hero document: a thin stack of bowed sheets + red PDF bookmark tab.
// Layer kinds line up with CH2's exploded anatomy.
function buildDocument() {
  const g = new THREE.Group();
  const kinds = ['cover', 'text', 'image', 'form', 'sig'];
  const geo = bentPlaneGeometry(3, 4, 0.10);
  kinds.forEach((kind, i) => {
    const m = new THREE.Mesh(geo, paperMaterial(makePageTexture(kind)));
    m.position.z = -i * 0.02;
    m.castShadow = true;
    m.userData.kind = kind;
    m.userData.stackIndex = i;
    g.add(m);
  });

  const tab = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.28, 0.035),
    new THREE.MeshStandardMaterial({ color: RED, roughness: 0.55 })
  );
  tab.position.set(1.05, 1.78, 0.02);
  tab.castShadow = true;
  tab.userData.kind = 'tab';
  g.add(tab);

  g.position.set(0.9, 0, 0); // copy sits left, document right of center
  return g;
}

// ---------- camera path ----------
function initPath() {
  waypoints = (simpleMode ? WAYPOINTS_SIMPLE : WAYPOINTS).map(p => new THREE.Vector3(...p));
  lookKeys = simpleMode ? LOOK_KEYS_SIMPLE : LOOK_KEYS;
  rebuildCurve();
}

function rebuildCurve() {
  curve = new THREE.CatmullRomCurve3(waypoints, false, 'catmullrom', 0.5);
}

const _look = new THREE.Vector3();
function lookTargetAt(t) {
  if (t <= lookKeys[0].t) return _look.set(...lookKeys[0].p);
  for (let i = 0; i < lookKeys.length - 1; i++) {
    const a = lookKeys[i], b = lookKeys[i + 1];
    if (t >= a.t && t <= b.t) {
      let k = (t - a.t) / Math.max(1e-6, b.t - a.t);
      k = k * k * (3 - 2 * k); // smoothstep between targets
      return _look.set(
        a.p[0] + (b.p[0] - a.p[0]) * k,
        a.p[1] + (b.p[1] - a.p[1]) * k,
        a.p[2] + (b.p[2] - a.p[2]) * k
      );
    }
  }
  return _look.set(...lookKeys[lookKeys.length - 1].p);
}

function updateCamera(t) {
  curve.getPointAt(Math.min(0.9999, Math.max(0, t)), camera.position);
  camera.lookAt(lookTargetAt(t));
}

// ---------- scroll wiring ----------
function initScroll() {
  const gsap = window.gsap, ScrollTrigger = window.ScrollTrigger;
  gsap.registerPlugin(ScrollTrigger);

  const bounds = simpleMode ? CHAPTER_BOUNDS_SIMPLE : CHAPTER_BOUNDS;

  ScrollTrigger.create({
    trigger: '#stage',
    start: 'top top',
    end: 'bottom bottom',
    onUpdate: st => { targetProgress = st.progress; },
    onLeave: () => { setRunning(false); glCanvas.style.opacity = '0'; },
    onEnterBack: () => { glCanvas.style.opacity = ''; setRunning(true); },
    // subtle snap: only when already near a chapter boundary
    snap: {
      snapTo: value => {
        for (const b of bounds) if (Math.abs(value - b) < 0.035) return b;
        return value;
      },
      duration: { min: 0.2, max: 0.6 },
      ease: 'power1.inOut',
      delay: 0.25
    }
  });
}

// ---------- HTML overlay sync ----------
function initOverlayRefs() {
  chapters = Array.from(document.querySelectorAll('.chapter')).map(el => {
    const band = (el.dataset.band || '0,1').split(',').map(Number);
    return { el, a: band[0], b: band[1] };
  });
  if (simpleMode) {
    // remap: ch1 0–0.45, ch2 0.45–1; ch3/ch4 are plain sections
    const map = { ch1: [0, 0.45], ch2: [0.45, 1] };
    chapters = chapters.filter(c => {
      for (const k in map) if (c.el.classList.contains(k)) { [c.a, c.b] = map[k]; return true; }
      return false;
    });
  }
  prFill = document.getElementById('pr-fill');
  if (!simpleMode) {
    benchCards = Array.from(document.querySelectorAll('.bench-card'));
    strikeItems = Array.from(document.querySelectorAll('.strike-list li'));
  }
}

const clamp01 = v => Math.min(1, Math.max(0, v));

function updateOverlays(t) {
  for (const c of chapters) {
    const local = (t - c.a) / (c.b - c.a);
    let op;
    if (local < 0 || local > 1) {
      op = 0;                                        // outside this chapter's band
    } else if (c.a === 0) {
      op = 1 - clamp01((local - 0.78) / 0.18);       // hero starts fully visible
    } else if (c.b === 1) {
      op = clamp01(local / 0.10);                    // last chapter holds; canvas fades instead
    } else {
      op = Math.min(clamp01(local / 0.10), clamp01((1 - local) / 0.10));
    }
    c.el.style.opacity = String(op);
    c.el.style.transform = `translateY(${(1 - op) * 18}px)`;
    c.el.classList.toggle('active', op > 0.02);
  }
  if (prFill) prFill.style.height = (t * 100).toFixed(2) + '%';

  // CH3: one card at a time, pinned beside the focused workbench
  for (let i = 0; i < benchCards.length; i++) {
    const f = benchFocus(t, i);
    const card = benchCards[i];
    card.style.opacity = String(f);
    card.style.transform = `translateY(${(1 - f) * 24}px)`;
    card.style.pointerEvents = f > 0.5 ? 'auto' : 'none';
  }

  // CH4: competitor limits strike in one by one, then dissolve
  for (let k = 0; k < strikeItems.length; k++) {
    const tin = 0.825 + k * 0.018;
    const inF = smooth01((t - tin) / 0.022);
    const outF = smooth01((t - (0.945 + k * 0.006)) / 0.03);
    const op = inF * (1 - outF);
    strikeItems[k].style.opacity = String(op);
    strikeItems[k].style.transform = `translateY(${(1 - inF) * 14 - outF * 26}px)`;
  }
}

// ---------- CH2: exploded-view anatomy ----------
// Each sheet's resting spot in the exploded diagram (local to docGroup).
function explodedTarget(i) {
  return {
    x: (i - 2) * 0.18,
    y: (i % 2 ? 1 : -1) * 0.10,
    z: (2 - i) * 1.15,            // camera pushes through the spread
    ry: (i - 2) * 0.07
  };
}

// Fine red annotation leaders that extend from each layer while exploded.
function buildExplodeLines() {
  for (let i = 0; i < 5; i++) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const mat = new THREE.LineBasicMaterial({ color: RED, transparent: true, opacity: 0 });
    const line = new THREE.Line(geo, mat);
    docGroup.add(line);
    explodeLines.push(line);
  }
}

// ---------- CH3: glass workbenches with tool vignettes ----------
const BENCH_X = [-6.8, -3.4, 0, 3.4, 6.8];
const BENCH_Z = -8.2;
const FOCUS_T = [0.44, 0.53, 0.62, 0.71, 0.80]; // matches LOOK_KEYS

function glassMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.32,
    roughness: 0.12,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.15
  });
}

function miniSheet(w = 0.62, h = 0.84) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), paperMaterial());
  m.castShadow = true;
  return m;
}

function buildBenches() {
  const glass = glassMaterial();
  const benchGeo = new THREE.BoxGeometry(2.1, 0.14, 1.25);
  for (let i = 0; i < 5; i++) {
    const g = new THREE.Group();
    g.position.set(BENCH_X[i], -0.85, BENCH_Z);
    const top = new THREE.Mesh(benchGeo, glass);
    top.castShadow = false;
    g.add(top);

    const v = { kind: ['merge', 'split', 'compress', 'ocr', 'protect'][i], parts: {} };
    if (v.kind === 'merge' || v.kind === 'split') {
      v.parts.a = miniSheet(); v.parts.b = miniSheet();
      g.add(v.parts.a, v.parts.b);
    } else if (v.kind === 'compress') {
      v.parts.a = miniSheet();
      g.add(v.parts.a);
      // red motion lines converging on the sheet
      v.parts.lines = [];
      for (let k = 0; k < 3; k++) {
        const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        const ln = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: RED, transparent: true, opacity: 0.85 }));
        g.add(ln);
        v.parts.lines.push(ln);
      }
    } else if (v.kind === 'ocr') {
      v.parts.a = miniSheet(0.8, 1.05);
      v.parts.a.material = paperMaterial(makePageTexture('text'));
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.22, 0.035, 10, 36),
        new THREE.MeshStandardMaterial({ color: INK, roughness: 0.4 })
      );
      const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8),
        new THREE.MeshStandardMaterial({ color: RED, roughness: 0.5 })
      );
      handle.position.set(0.22, -0.24, 0);
      handle.rotation.z = 0.8;
      const mag = new THREE.Group();
      mag.add(ring, handle);
      v.parts.mag = mag;
      g.add(v.parts.a, mag);
    } else if (v.kind === 'protect') {
      v.parts.a = miniSheet();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.24, 0.1),
        new THREE.MeshStandardMaterial({ color: RED, roughness: 0.45 })
      );
      const shackle = new THREE.Mesh(
        new THREE.TorusGeometry(0.11, 0.028, 8, 20, Math.PI),
        new THREE.MeshStandardMaterial({ color: INK, roughness: 0.35 })
      );
      shackle.position.y = 0.12;
      const lock = new THREE.Group();
      lock.add(body, shackle);
      v.parts.lock = lock;
      g.add(v.parts.a, lock);
    }
    g.userData.vignette = v;
    scene.add(g);
    benches.push(g);
  }
}

// Per-bench focus: 1 when the camera is looking straight at it.
function benchFocus(t, i) {
  return clamp01(1 - Math.abs(t - FOCUS_T[i]) / 0.05);
}

function animateBench(g, f, time) {
  const v = g.userData.vignette;
  const hover = 0.9 + Math.sin(time * 1.4 + g.position.x) * 0.03;
  if (v.kind === 'merge') {
    const gap = 0.85 - f * 0.7;            // sheets slide together
    v.parts.a.position.set(-gap / 2, hover, 0);
    v.parts.b.position.set(gap / 2, hover, -0.02);
    v.parts.a.rotation.y = 0.25 - f * 0.25;
    v.parts.b.rotation.y = -0.25 + f * 0.25;
  } else if (v.kind === 'split') {
    const gap = 0.15 + f * 0.7;            // one sheet separates
    v.parts.a.position.set(-gap / 2, hover, 0);
    v.parts.b.position.set(gap / 2, hover, 0.01);
    v.parts.a.rotation.y = f * 0.22;
    v.parts.b.rotation.y = -f * 0.22;
  } else if (v.kind === 'compress') {
    const s = 1 - f * 0.4;                 // sheet shrinks
    v.parts.a.scale.set(s, s, 1);
    v.parts.a.position.y = hover;
    v.parts.lines.forEach((ln, k) => {
      const ang = (k - 1) * 0.9 + Math.PI / 2;
      const r1 = 0.75, r0 = 0.48 + (1 - f) * 0.2;
      const pos = ln.geometry.attributes.position;
      pos.setXYZ(0, Math.cos(ang) * r1, hover + Math.sin(ang) * r1 * 0.9, 0.02);
      pos.setXYZ(1, Math.cos(ang) * r0, hover + Math.sin(ang) * r0 * 0.9, 0.02);
      pos.needsUpdate = true;
      ln.material.opacity = 0.15 + f * 0.75;
    });
  } else if (v.kind === 'ocr') {
    v.parts.a.position.y = hover;
    v.parts.mag.position.set(
      Math.sin(time * 0.9) * 0.22 * f,
      hover + 0.1 + Math.cos(time * 0.7) * 0.12 * f,
      0.25
    );
  } else if (v.kind === 'protect') {
    v.parts.a.position.y = hover;
    v.parts.lock.position.set(0, hover + 0.55 - f * 0.45, 0.12); // padlock clicks on
    v.parts.lock.rotation.z = (1 - f) * 0.35;
  }
}

// ---------- CH4: wireframe vault ----------
function buildVault() {
  const g = new THREE.Group();
  g.position.set(0, 0.4, -13);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(4.6, 5.4, 3.2)),
    new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0 })
  );
  g.add(edges);

  // red corner ticks
  const tickGeo = new THREE.BufferGeometry();
  const pts = [];
  const hx = 2.3, hy = 2.7, hz = 1.6, L = 0.45;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    pts.push(sx * hx, sy * hy, hz, sx * (hx - L), sy * hy, hz);
    pts.push(sx * hx, sy * hy, hz, sx * hx, sy * (hy - L / hy * hx), hz);
  }
  tickGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const ticks = new THREE.LineSegments(
    tickGeo,
    new THREE.LineBasicMaterial({ color: RED, transparent: true, opacity: 0 })
  );
  g.add(ticks);

  // the sealed document inside
  const inner = new THREE.Mesh(bentPlaneGeometry(2.4, 3.2, 0.06), paperMaterial(makePageTexture('cover')));
  inner.castShadow = false;
  g.add(inner);

  g.userData = { edges, ticks, inner };
  g.visible = false;
  return g;
}

// ---------- per-frame choreography of the 3D scene ----------
const smooth01 = v => { const k = clamp01(v); return k * k * (3 - 2 * k); };

function choreograph(t) {
  const time = clock.elapsedTime;

  // CH1: document gently turns to face the camera path as scroll begins
  const turn = clamp01(t / (simpleMode ? 0.40 : 0.18));
  docGroup.rotation.y = -0.55 * turn * turn;
  docGroup.rotation.x = -0.06 * turn;

  // CH2: explode into the suspended anatomy diagram
  const exBand = simpleMode ? [0.50, 0.82] : [0.20, 0.34];
  const e = smooth01((t - exBand[0]) / (exBand[1] - exBand[0]));
  let coverZ = 0;
  docGroup.children.forEach(ch => {
    if (ch.userData.kind === 'tab') return;
    if (ch.isLine) return;
    const i = ch.userData.stackIndex;
    if (i == null) return;
    const tgt = explodedTarget(i);
    ch.position.x = tgt.x * e;
    ch.position.y = tgt.y * e;
    ch.position.z = -i * 0.02 + tgt.z * e;
    ch.rotation.y = tgt.ry * e;
    if (i === 0) coverZ = ch.position.z;
    const line = explodeLines[i];
    if (line) {
      const pos = line.geometry.attributes.position;
      pos.setXYZ(0, ch.position.x + 1.52, ch.position.y + 0.4, ch.position.z);
      pos.setXYZ(1, ch.position.x + 1.52 + 0.9 * e, ch.position.y + 0.72, ch.position.z);
      pos.needsUpdate = true;
      line.material.opacity = e * 0.9;
    }
  });
  // bookmark tab rides the cover sheet
  const tab = docGroup.children.find(ch => ch.userData.kind === 'tab');
  if (tab) tab.position.z = coverZ + 0.02;

  // CH3: workbench vignettes respond as the camera arrives
  for (let i = 0; i < benches.length; i++) {
    animateBench(benches[i], benchFocus(t, i), time);
  }

  // CH4: the vault draws itself around the sealed document
  if (vaultGroup) {
    const v = smooth01((t - 0.80) / 0.08);
    vaultGroup.visible = v > 0.001;
    if (vaultGroup.visible) {
      vaultGroup.userData.edges.material.opacity = v * 0.85;
      vaultGroup.userData.ticks.material.opacity = v;
      vaultGroup.scale.setScalar(0.86 + v * 0.14);
      vaultGroup.rotation.y = (t - 0.80) * 0.55;
      vaultGroup.userData.inner.position.y = Math.sin(time * 0.8) * 0.06;
    }
  }
}

// ---------- lifecycle / render loop ----------
function setRunning(r) {
  if (r === running) return;
  running = r;
  if (running) { clock.getDelta(); rafId = requestAnimationFrame(tick); }
  else cancelAnimationFrame(rafId);
}

function initLifecycle() {
  document.addEventListener('visibilitychange', () => setRunning(!document.hidden));
  window.addEventListener('blur', () => setRunning(false));
  window.addEventListener('focus', () => { if (!document.hidden) setRunning(true); });
}

function tick() {
  if (!running) return;
  rafId = requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);

  // ~1s smoothing toward the ScrollTrigger-scrubbed target
  progress += (targetProgress - progress) * (1 - Math.exp(-3.2 * dt));

  updateCamera(progress);
  choreograph(progress);
  updateOverlays(progress);
  renderer.render(scene, camera);

  trackFps(dt);
  if (debug) debug.tick(dt);
}

// FPS guard: sustained <30 on mobile → static fallback (rule 4)
function trackFps(dt) {
  fps.acc += dt; fps.frames++;
  if (fps.acc >= 1) {
    fps.value = fps.frames / fps.acc;
    fps.acc = 0; fps.frames = 0;
    if (simpleMode && !debug) {
      if (fps.value < 30) {
        fps.lowSince = fps.lowSince || performance.now();
        if (performance.now() - fps.lowSince > 3000) {
          setRunning(false);
          onFallback();
        }
      } else fps.lowSince = 0;
    }
  }
}

// ---------- DEBUG=1: curve display + waypoint editor + capture ----------
function initDebug() {
  const group = new THREE.Group();
  scene.add(group);
  let line = null;
  const markers = waypoints.map((p, i) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 12, 12),
      new THREE.MeshBasicMaterial({ color: i === 0 ? RED : INK })
    );
    m.position.copy(p);
    group.add(m);
    return m;
  });
  function redraw() {
    if (line) { group.remove(line); line.geometry.dispose(); }
    line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(240)),
      new THREE.LineBasicMaterial({ color: RED })
    );
    group.add(line);
    markers.forEach((m, i) => m.position.copy(waypoints[i]));
  }
  redraw();

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99;background:#16161c;color:#fff;' +
    'font:11px/1.6 ui-monospace,monospace;padding:10px 12px;border-radius:6px;white-space:pre;max-width:340px;';
  document.body.appendChild(panel);

  let sel = 0;
  function select(i) {
    sel = (i + waypoints.length) % waypoints.length;
    markers.forEach((m, j) => m.material.color.set(j === sel ? RED : INK));
  }
  select(0);

  window.addEventListener('keydown', e => {
    const step = e.shiftKey ? 0.5 : 0.1;
    const p = waypoints[sel];
    switch (e.key) {
      case '[': select(sel - 1); break;
      case ']': select(sel + 1); break;
      case 'ArrowLeft': p.x -= step; break;
      case 'ArrowRight': p.x += step; break;
      case 'ArrowUp': p.z -= step; break;
      case 'ArrowDown': p.z += step; break;
      case 'PageUp': p.y += step; break;
      case 'PageDown': p.y -= step; break;
      case 'd': console.log('WAYPOINTS =', JSON.stringify(waypoints.map(v => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]))); break;
      case 'c': capture(); break;
      default: return;
    }
    rebuildCurve();
    redraw();
  });

  function capture() {
    renderer.render(scene, camera);
    const a = document.createElement('a');
    a.download = 'hero-render.png';
    a.href = renderer.domElement.toDataURL('image/png');
    a.click();
  }

  debug = {
    tick() {
      const p = camera.position;
      panel.textContent =
        `FPS ${fps.value.toFixed(0)}   progress ${progress.toFixed(3)}\n` +
        `cam ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}\n` +
        `wp[${sel}] ${waypoints[sel].x.toFixed(2)}, ${waypoints[sel].y.toFixed(2)}, ${waypoints[sel].z.toFixed(2)}\n` +
        `keys: [ ] select · arrows x/z · PgUp/Dn y · shift=big · d dump · c capture`;
    }
  };
}
