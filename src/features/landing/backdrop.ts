/*
 * The landing cover's two canvases, ported from design-previews/S-orbit.html:
 *  - a deep neural web that fills the whole screen (hundreds of neurons at different depths, near ones soft like bokeh)
 *  - a globe of data with lit continents, orbited by icon chips on tilted rings
 * Both are calm: a slow brightness wave, a few dim signals, no flashing. The pointer steers the camera and you can drag the
 * globe. `scene.pull` draws everything into the cursor point and `scene.boost` flies the camera forward; the Landing
 * component drives both from scrolling.
 */

export interface Scene {
  boost: number;
  pull: number;
  warp: number;
  hidden: boolean;
  core: { x: number; y: number };
}

export interface BackdropOptions {
  host: HTMLElement;
  web: HTMLCanvasElement;
  webBloom: HTMLCanvasElement;
  orb: HTMLCanvasElement;
  orbBloom: HTMLCanvasElement;
  scene: Scene;
  /** Reduced motion: draw one still frame and stop. */
  calm: boolean;
}

type Vec3 = [number, number, number];
type Proj = [number, number, number, number];

const TAU = Math.PI * 2;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const ri = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function sprite(size: number, stops: [number, string][]) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => r.addColorStop(o, col));
  g.fillStyle = r;
  g.fillRect(0, 0, size, size);
  return c;
}

/* ------------------------------------------------------------------ the neural web */

interface WNode {
  x: number; y: number; z: number; c: number; s: number; ph: number; n: number[];
  sx: number; sy: number; pz: number; vis: boolean; near: number; a: number;
}
interface Packet { a: number; b: number; u: number; hops: number }

function makeWeb(o: BackdropOptions) {
  const cv = o.web, bl = o.webBloom, ctx = cv.getContext('2d')!, bctx = bl.getContext('2d')!, scene = o.scene, calm = o.calm;
  const TINT = [[190, 232, 255], [120, 215, 255], [95, 227, 214], [150, 190, 255]];
  const spr = sprite(64, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,.4)'], [1, 'rgba(255,255,255,0)']]);
  const tint = TINT.map(c => {
    const k = document.createElement('canvas');
    k.width = k.height = 64;
    const g = k.getContext('2d')!;
    g.drawImage(spr, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    g.fillRect(0, 0, 64, 64);
    return k;
  });

  let W = 0, H = 0, dpr = 1, bw = 0, bh = 0, F = 600, XM = 2, YM = 1.7;
  let nodes: WNode[] = [], links: [number, number][] = [], packets: Packet[] = [], sorted: WNode[] = [];
  let t = calm ? 30000 : 0, mx = 0, my = 0, cx = 0, cy = 0, spawnT = 0;
  const target = { cx: 0, cy: 0, mx: 0, my: 0, havePointer: false };

  function build() {
    nodes = []; links = []; packets = [];
    const n = Math.round(Math.min(1500, Math.max(220, (W * H) / 1000)));
    for (let i = 0; i < n; i++) nodes.push({ x: rnd(-XM, XM), y: rnd(-YM, YM), z: rnd(0.7, 3.8), c: ri(0, 3), s: rnd(0.7, 1.4), ph: rnd(0, TAU), n: [], sx: 0, sy: 0, pz: 0, vis: false, near: 0, a: 0 });
    for (let i = 0; i < n; i++) {
      const a = nodes[i], near: [number, number][] = [];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const b = nodes[j], d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + ((a.z - b.z) * 0.8) ** 2;
        if (d < 0.2) near.push([d, j]);
      }
      near.sort((p, q) => p[0] - q[0]);
      for (const [, j] of near.slice(0, 3)) if (!a.n.includes(j)) { a.n.push(j); nodes[j].n.push(i); links.push([i, j]); }
    }
    sorted = nodes.slice();
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    bw = Math.round(W / 3); bh = Math.round(H / 3); bl.width = bw; bl.height = bh;
    F = H * 0.62; YM = ((H / 2) * 1.12 * 1.9) / F; XM = (YM * W) / H;
    if (!target.havePointer) { target.cx = cx = W * (W > 1000 ? 0.72 : 0.5); target.cy = cy = H * (W > 1000 ? 0.48 : 0.72); }
    build();
    if (calm) draw(0);
  }

  function addPacket() {
    if (!links.length || packets.length > 12) return;
    const l = links[ri(0, links.length - 1)], fwd = Math.random() < 0.5;
    packets.push({ a: fwd ? l[0] : l[1], b: fwd ? l[1] : l[0], u: 0, hops: ri(2, 4) });
  }

  function draw(dt: number) {
    if (scene.hidden && !calm) return;
    t += dt; mx += (target.mx - mx) * 0.03; my += (target.my - my) * 0.03; cx += (target.cx - cx) * 0.08; cy += (target.cy - cy) * 0.08;
    scene.core.x = cx; scene.core.y = cy;
    const pull = scene.pull, boost = scene.boost, warp = scene.warp, wide = W > 1000;
    const dolly = boost * 1.55 + warp * 1.1, ke = 1 - pull * 0.96;
    spawnT += dt; if (spawnT > 850) { spawnT = 0; addPacket(); }
    const yaw = Math.sin(t * 0.00011) * 0.1 + mx * 0.07 + boost * 0.35, cyw = Math.cos(yaw), syw = Math.sin(yaw), ZC = 2.3;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); ctx.globalCompositeOperation = 'lighter';
    for (const n of nodes) {
      const xr = n.x * cyw + (n.z - ZC) * syw, z = -n.x * syw + (n.z - ZC) * cyw + ZC - dolly;
      n.pz = z;
      if (z < 0.12) { n.vis = false; continue; }
      let sx = W / 2 + ((xr + mx * 0.12) * F) / z, sy = H / 2 + ((n.y + my * 0.09) * F) / z;
      if (pull > 0) { sx = cx + (sx - cx) * ke; sy = cy + (sy - cy) * ke; }
      n.sx = sx; n.sy = sy; n.vis = true;
      const near = Math.max(0, Math.min(1, (3.6 - z) / 3)), wave = 0.55 + 0.45 * Math.sin(n.x * 1.25 + n.y * 0.6 + n.z * 0.9 - t * 0.00042);
      n.near = near;
      n.a = (0.3 + 0.8 * near) * (0.5 + 0.5 * wave) * Math.min(1, (z - 0.12) * 3) * (wide ? 0.3 + 0.7 * sstep(W * 0.08, W * 0.55, sx) : 1);
    }
    const bands: [number, number, number, string][] = [[0, 0.35, 0.1, 'rgba(120,180,255,'], [0.35, 0.7, 0.16, 'rgba(130,215,255,'], [0.7, 1.01, 0.22, 'rgba(160,235,255,']];
    for (const [lo, hi, al, col] of bands) {
      ctx.lineWidth = lo < 0.3 ? 0.6 : lo < 0.6 ? 0.9 : 1.3;
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        let any = false;
        for (const [i, j] of links) {
          const a = nodes[i], b = nodes[j];
          if (!a.vis || !b.vis) continue;
          const nr = (a.near + b.near) / 2;
          if (nr < lo || nr >= hi) continue;
          const w = (a.a + b.a) / 2 > 0.3;
          if (pass ? !w : w) continue;
          ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); any = true;
        }
        if (any) { ctx.strokeStyle = col + (pass ? al * 2.1 : al * 1.1) + ')'; ctx.stroke(); }
      }
    }
    sorted.sort((p, q) => q.pz - p.pz);
    for (const n of sorted) {
      if (!n.vis) continue;
      const c = tint[n.c], f = n.near;
      if (f > 0.55) {
        const r = (12 + (40 * (f - 0.55)) / 0.45) * n.s * (3 / n.pz) ** 0.3;
        ctx.globalAlpha = n.a * 0.3; ctx.drawImage(c, n.sx - r, n.sy - r, r * 2, r * 2);
      } else {
        const r = (3.4 + 12 * f) * n.s;
        ctx.globalAlpha = Math.min(1, n.a * 0.85); ctx.drawImage(c, n.sx - r, n.sy - r, r * 2, r * 2);
        ctx.globalAlpha = Math.min(1, n.a * 0.95);
        const d = 1 + 2.2 * f;
        ctx.fillStyle = 'rgb(235,250,255)'; ctx.fillRect(n.sx - d / 2, n.sy - d / 2, d, d);
      }
    }
    ctx.globalAlpha = 1;
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i], a = nodes[p.a], b = nodes[p.b];
      p.u += (dt / 3800) * (1 + boost * 2);
      if (p.u >= 1) {
        if (--p.hops <= 0 || !b.n.length) { packets.splice(i, 1); continue; }
        const nx = b.n[ri(0, b.n.length - 1)];
        p.a = p.b; p.b = nx; p.u = 0;
        continue;
      }
      if (!a.vis || !b.vis) continue;
      const x = a.sx + (b.sx - a.sx) * p.u, y = a.sy + (b.sy - a.sy) * p.u, al = Math.sin(p.u * Math.PI) * 0.55 * Math.min(1, a.a + b.a);
      ctx.globalAlpha = al;
      const r = 8 + (6 * (a.near + b.near)) / 2;
      ctx.drawImage(tint[2], x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    if (pull > 0.05) {
      const r = 20 + pull * 170, g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(235,255,252,${pull * 0.85})`); g.addColorStop(1, 'rgba(95,227,214,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    bctx.clearRect(0, 0, bw, bh); bctx.drawImage(cv, 0, 0, bw, bh);
  }

  const onMove = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    target.cx = e.clientX - r.left; target.cy = e.clientY - r.top; target.havePointer = true;
    target.mx = (e.clientX / window.innerWidth - 0.5) * 2; target.my = (e.clientY / window.innerHeight - 0.5) * 2;
  };
  return { resize, draw, onMove };
}

/* ------------------------------------------------------------------ the globe */

interface Pt { x: number; y: number; z: number; land: boolean; s: number }
interface Arc { u: number; a: Pt | null; b: Pt | null; sp: number }

const ICONS: Record<string, string> = {
  csv: 'M6 3.5h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2zM4 9h16M4 14.5h16M10 3.5v17',
  filter: 'M4 5h16l-6 8v5l-4 2v-7z',
  tf: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  ai: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  http: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17',
  db: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zM5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
  out: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  kept: 'M5 12.5l4.5 4.5L19 7',
  flag: 'M6 21V4M6 5h11l-2 4 2 4H6',
  left: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM8 12h8',
};

function makeOrb(o: BackdropOptions) {
  const cv = o.orb, bl = o.orbBloom, ctx = cv.getContext('2d')!, bctx = bl.getContext('2d')!, scene = o.scene, calm = o.calm;
  const land = (la: number, lo: number) => Math.sin(lo * 2.1 + 1.3) * Math.cos(la * 2.7) + 0.6 * Math.sin(lo * 4.3 - la * 3.1 + 2) + 0.35 * Math.cos(lo * 7 + la * 5) > 0.28;
  const NP = 5200, pts: Pt[] = [], lands: Pt[] = [];
  for (let i = 0; i < NP; i++) {
    const y = 1 - (2 * (i + 0.5)) / NP, r = Math.sqrt(1 - y * y), th = i * 2.399963;
    const p: Pt = { x: Math.cos(th) * r, y, z: Math.sin(th) * r, land: false, s: rnd(0.8, 1.25) };
    p.land = land(Math.asin(y), Math.atan2(p.z, p.x));
    pts.push(p); if (p.land) lands.push(p);
  }
  const MER: Vec3[][] = [], PAR: Vec3[][] = [], D2R = Math.PI / 180;
  for (let m = 0; m < 24; m++) { const lo = (m / 24) * TAU, line: Vec3[] = []; for (let a = -90; a <= 90; a += 6) { const la = a * D2R; line.push([Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo)]); } MER.push(line); }
  for (let a = -60; a <= 60; a += 30) { const la = a * D2R, line: Vec3[] = []; for (let k = 0; k <= 80; k++) { const lo = (k / 80) * TAU; line.push([Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo)]); } PAR.push(line); }
  const RINGS = [{ r: 1.42, tilt: 0.5, rot: -0.32, sp: 1 }, { r: 1.82, tilt: -0.38, rot: 0.42, sp: -0.72 }, { r: 2.3, tilt: 0.22, rot: -0.1, sp: 0.5 }];
  const PATHS: Record<string, Path2D> = {};
  Object.keys(ICONS).forEach(k => { PATHS[k] = new Path2D(ICONS[k]); });
  const RAW: [string, number, string][] = [['csv', 0, '#5be3d6'], ['filter', 0, '#7cc4ff'], ['ai', 0, '#c4b5ff'], ['kept', 1, '#5be3d6'], ['tf', 1, '#7cc4ff'], ['flag', 1, '#ffb454'], ['out', 2, '#5be3d6'], ['db', 2, '#7cc4ff'], ['left', 2, '#a9bdd2'], ['http', 0, '#7cc4ff']];
  const CHIPS = RAW.map((c, i) => ({ k: c[0], ring: c[1], col: c[2], a0: (RAW.filter((q, j) => j < i && q[1] === c[1]).length / RAW.filter(q => q[1] === c[1]).length) * TAU + c[1] }));
  const arcs: Arc[] = Array.from({ length: 4 }, (_, i) => ({ u: -i * 0.6, a: null, b: null, sp: rnd(0.00013, 0.0002) }));
  const pick = () => lands[ri(0, lands.length - 1)];
  const slerp = (a: Pt, b: Pt, k: number): Vec3 => {
    const d = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))), s = Math.sin(d) || 1, wa = Math.sin((1 - k) * d) / s, wb = Math.sin(k * d) / s;
    return [a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb];
  };
  const glow = sprite(32, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(160,245,235,.5)'], [1, 'rgba(95,227,214,0)']]);

  // face the side with the most land, so the globe never opens on an empty ocean
  let yaw0 = 0;
  { let best = -1; for (let k = 0; k < 72; k++) { const y = (k / 72) * TAU, c = Math.cos(y), s = Math.sin(y); let n = 0; for (const p of lands) { const z1 = -p.x * s + p.z * c; if (p.y * Math.sin(0.3) + z1 * Math.cos(0.3) > 0.15) n++; } if (n > best) { best = n; yaw0 = y; } } }

  let W = 0, H = 0, dpr = 1, bw = 0, bh = 0, R = 300, bx = 0, by = 0, t = calm ? 8000 : 0, mx = 0, my = 0, spin = 0, dragYaw = 0, vel = 0, near = 0;
  const target = { mx: 0, my: 0 };
  const drag = { on: false, lastX: 0, lastT: 0 };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); bw = Math.round(W / 3); bh = Math.round(H / 3); bl.width = bw; bl.height = bh;
    const wide = W > 1000;
    R = wide ? Math.min(H * 0.36, W * 0.21) : W * 0.46; bx = wide ? W * 0.745 : W * 0.5; by = wide ? H * 0.52 : H * 0.76;
    if (calm) draw(0);
  }

  function draw(dt: number) {
    if (scene.hidden && !calm) return;
    t += dt; mx += (target.mx - mx) * 0.035; my += (target.my - my) * 0.035;
    if (!drag.on) { dragYaw += vel * dt; vel *= Math.exp(-dt / 700); }
    spin += dt * 0.00009 * (1 + scene.boost * 3);
    const pull = scene.pull, boost = scene.boost, core = scene.core;
    const Rr = R * (1 + 0.012 * Math.sin(t * 0.0007) + near * 0.025 + boost * 0.18) * (1 - pull * 0.94) * (0.84 + 0.16 * (1 - Math.exp(-t / 500)));
    const ox = bx + mx * W * 0.008 + (core.x - bx) * pull, oy = by + my * H * 0.01 + (core.y - by) * pull;
    const yaw = yaw0 + spin + dragYaw + mx * 0.35 + 2.6 * Math.exp(-t / 650), pit = 0.3 + my * 0.22, cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pit), sp = Math.sin(pit);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const G = (v: Vec3): Proj => { const x1 = v[0] * cyw + v[2] * syw, z1 = -v[0] * syw + v[2] * cyw, y2 = v[1] * cp - z1 * sp, z2 = v[1] * sp + z1 * cp, sc = 1 / (1 + -z2 * 0.1); return [ox + x1 * Rr * sc, oy + y2 * Rr * sc, z2, sc]; };
    const C = (v: Vec3): Proj => { const y2 = v[1] * cp - v[2] * sp, z2 = v[1] * sp + v[2] * cp, x1 = v[0] * Math.cos(mx * 0.1) + z2 * Math.sin(mx * 0.1), z1 = -v[0] * Math.sin(mx * 0.1) + z2 * Math.cos(mx * 0.1), sc = 1 / (1 + -z1 * 0.1); return [ox + x1 * Rr * sc, oy + y2 * Rr * sc, z1, sc]; };
    const ringPt = (rg: (typeof RINGS)[number], a: number): Vec3 => { const x = Math.cos(a) * rg.r, z = Math.sin(a) * rg.r, y1 = -z * Math.sin(rg.tilt), z1 = z * Math.cos(rg.tilt); return [x * Math.cos(rg.rot) - y1 * Math.sin(rg.rot), x * Math.sin(rg.rot) + y1 * Math.cos(rg.rot), z1]; };
    ctx.globalCompositeOperation = 'lighter';
    let g = ctx.createRadialGradient(ox, oy, Rr * 0.8, ox, oy, Rr * 1.55);
    g.addColorStop(0, 'rgba(90,225,255,.34)'); g.addColorStop(0.3, 'rgba(60,160,255,.13)'); g.addColorStop(1, 'rgba(40,110,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ox, oy, Rr * 1.55, 0, TAU); ctx.fill();
    const drawRing = (rg: (typeof RINGS)[number], front: boolean) => {
      ctx.strokeStyle = front ? 'rgba(170,240,255,.62)' : 'rgba(110,180,255,.2)'; ctx.lineWidth = front ? 1.5 : 1; ctx.beginPath();
      let started = false;
      for (let k = 0; k <= 120; k++) { const q = C(ringPt(rg, (k / 120) * TAU)); if (q[2] >= 0 === front) { if (started) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); started = true; } else started = false; }
      ctx.stroke();
    };
    RINGS.forEach(rg => drawRing(rg, false));
    const chip = (c: (typeof CHIPS)[number], q: Proj) => {
      const d = 38 * q[3], front = q[2] >= 0, dist = Math.hypot(q[0] - ox, q[1] - oy), hid = !front && dist < Rr * 0.96;
      const al = hid ? 0 : front ? 0.96 : 0.4;
      if (!al) return;
      ctx.globalAlpha = al; ctx.fillStyle = 'rgba(6,26,66,.84)'; ctx.strokeStyle = 'rgba(150,225,255,.55)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(q[0], q[1], d / 2, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.save(); ctx.translate(q[0] - 10 * q[3], q[1] - 10 * q[3]); ctx.scale((20 * q[3]) / 24, (20 * q[3]) / 24);
      ctx.strokeStyle = c.col; ctx.lineWidth = 1.9; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(PATHS[c.k]); ctx.restore(); ctx.globalAlpha = 1;
    };
    const placed = CHIPS.map(c => { const rg = RINGS[c.ring]; return [c, C(ringPt(rg, c.a0 + t * 0.00011 * rg.sp))] as const; });
    ctx.globalCompositeOperation = 'source-over'; placed.filter(p => p[1][2] < 0).forEach(p => chip(p[0], p[1])); ctx.globalCompositeOperation = 'lighter';
    g = ctx.createRadialGradient(ox - Rr * 0.3, oy - Rr * 0.35, Rr * 0.05, ox, oy, Rr);
    g.addColorStop(0, 'rgba(70,170,255,.16)'); g.addColorStop(0.55, 'rgba(25,100,210,.1)'); g.addColorStop(1, 'rgba(10,60,160,.1)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ox, oy, Rr, 0, TAU); ctx.fill();
    g = ctx.createRadialGradient(ox, oy, 0, ox, oy, Rr * 0.7);
    g.addColorStop(0, `rgba(190,245,255,${0.2 + 0.05 * Math.sin(t * 0.0009)})`); g.addColorStop(1, 'rgba(90,200,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ox, oy, Rr * 0.7, 0, TAU); ctx.fill();
    g = ctx.createRadialGradient(ox, oy, Rr * 0.94, ox, oy, Rr * 1.06);
    g.addColorStop(0, 'rgba(120,230,255,0)'); g.addColorStop(0.5, 'rgba(140,235,255,.5)'); g.addColorStop(1, 'rgba(120,230,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ox, oy, Rr * 1.06, 0, TAU); ctx.fill();
    ctx.lineWidth = 1;
    for (const set of [MER, PAR]) for (const line of set) {
      let prev = G(line[0]);
      for (let k = 1; k < line.length; k++) {
        const cur = G(line[k]), z = (prev[2] + cur[2]) / 2;
        if (z > -0.05) { ctx.strokeStyle = `rgba(130,225,255,${0.07 + 0.3 * Math.max(0, z)})`; ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(cur[0], cur[1]); ctx.stroke(); }
        prev = cur;
      }
    }
    for (let i = 0; i < NP; i++) {
      const p = pts[i], q = G([p.x, p.y, p.z]), z = q[2];
      if (z < -0.08) continue;
      const f = Math.max(0, z), a = p.land ? 0.3 + 0.7 * f : 0.09 + 0.3 * f, s = (p.land ? 2.5 : 1.1) * p.s * q[3] * (Rr / 330 + 0.35);
      ctx.fillStyle = p.land ? `rgba(150,245,235,${a})` : `rgba(120,185,255,${a})`; ctx.fillRect(q[0] - s / 2, q[1] - s / 2, s, s);
    }
    for (const A of arcs) {
      if (!A.a || !A.b || A.u > 1.3) { A.a = pick(); A.b = pick(); A.u = -rnd(0, 0.4); }
      A.u += dt * A.sp;
      const head = Math.min(1, A.u), tail = Math.max(0, A.u - 0.4);
      if (head <= 0 || tail >= 1) continue;
      const env = Math.sin(Math.min(1, (A.u + 0.1) / 1.3) * Math.PI);
      ctx.beginPath();
      let started = false, lastq: Proj | null = null;
      for (let k = 0; k <= 36; k++) {
        const u = tail + ((head - tail) * k) / 36, v = slerp(A.a, A.b, u), lift = 1 + 0.24 * Math.sin(Math.PI * u), q = G([v[0] * lift, v[1] * lift, v[2] * lift]);
        if (q[2] < -0.05) { started = false; continue; }
        if (started) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
        started = true; lastq = q;
      }
      ctx.strokeStyle = `rgba(180,250,245,${0.5 * env})`; ctx.lineWidth = 1.6; ctx.stroke();
      if (lastq) { ctx.globalAlpha = 0.55 * env; ctx.drawImage(glow, lastq[0] - 9, lastq[1] - 9, 18, 18); ctx.globalAlpha = 1; }
    }
    RINGS.forEach(rg => drawRing(rg, true));
    ctx.globalCompositeOperation = 'source-over'; placed.filter(p => p[1][2] >= 0).forEach(p => chip(p[0], p[1]));
    bctx.clearRect(0, 0, bw, bh); bctx.drawImage(cv, 0, 0, bw, bh);
  }

  const onMove = (e: PointerEvent) => {
    target.mx = (e.clientX / window.innerWidth - 0.5) * 2; target.my = (e.clientY / window.innerHeight - 0.5) * 2;
    near = Math.hypot(e.clientX - bx, e.clientY - by) < R * 1.1 ? 1 : 0;
    if (drag.on) { const dx = e.clientX - drag.lastX; dragYaw += dx * 0.006; vel = (dx * 0.006) / Math.max(8, e.timeStamp - (drag.lastT || e.timeStamp)); drag.lastX = e.clientX; drag.lastT = e.timeStamp; }
  };
  const onDown = (e: PointerEvent) => {
    const el = e.target as Element | null;
    if (el?.closest('input,button,a,form,[data-nodrag]') || e.clientX < window.innerWidth * 0.4) return;
    drag.on = true; drag.lastX = e.clientX; drag.lastT = e.timeStamp; vel = 0; document.body.style.cursor = 'grabbing';
  };
  const onUp = () => { drag.on = false; document.body.style.cursor = ''; vel = Math.max(-0.0012, Math.min(0.0012, vel)); };
  return { resize, draw, onMove, onDown, onUp };
}

/* ------------------------------------------------------------------ both, one loop */

export function createBackdrop(o: BackdropOptions) {
  const web = makeWeb(o), orb = makeOrb(o);
  let raf = 0, last = 0;
  const resize = () => { web.resize(); orb.resize(); };
  const loop = (now: number) => {
    const dt = last ? Math.min(now - last, 40) : 16;
    last = now;
    web.draw(dt); orb.draw(dt);
    raf = requestAnimationFrame(loop);
  };
  const start = () => { if (!raf && !o.calm && !document.hidden) { last = 0; raf = requestAnimationFrame(loop); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  const onVisibility = () => (document.hidden ? stop() : start());
  const onMove = (e: PointerEvent) => { web.onMove(e); orb.onMove(e); };
  const ro = new ResizeObserver(resize);
  ro.observe(o.host);
  window.addEventListener('pointermove', onMove, { passive: true });
  o.host.addEventListener('pointerdown', orb.onDown);
  window.addEventListener('pointerup', orb.onUp);
  document.addEventListener('visibilitychange', onVisibility);
  resize();
  start();
  return {
    destroy() {
      stop(); ro.disconnect();
      window.removeEventListener('pointermove', onMove);
      o.host.removeEventListener('pointerdown', orb.onDown);
      window.removeEventListener('pointerup', orb.onUp);
      document.removeEventListener('visibilitychange', onVisibility);
      document.body.style.cursor = '';
    },
  };
}
