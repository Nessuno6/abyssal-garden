// ============================================================================
// caves: tunnels and chambers under the seabed, wide enough for a submarine
// ============================================================================
// One cave system per 640 m cell at most (about half the cells), kept inside its cell so systems never cross. A system
// is a skeleton of capsules: two mouths that slope down from the seabed, a winding tunnel 26-36 m wide between them,
// 30-50 m below the rock surface, a chamber halfway and, often, a side passage to a dead-end grotto. Its field is the
// smooth union of the capsules (flattened a little) plus 3D noise; the noise fades to nothing at the mouths, where the
// GPU cuts the seabed open along the bare capsule (g.cm, mouthD in shaders.js).
// The walls are meshed on the CPU with surface nets over 16^3-cell blocks, a few blocks per frame (caveTick), and drawn
// by the rock shader with the daylight that reaches each vertex (n.w) and the cave's theme (fungus, crystal, lava).
// Things grow on the walls (giant glowing fungi, crystals, vent chimneys, rocks) and the brightest of them light the
// cave: the 8 nearest are point lights in G (cavL). Collision: sdScene() takes the cave as water (caveWater).
const CAVE_CELL = 640, CVS = new Map(), CV_CS = LV > 1 ? 3.2 : 2.5, CV_B = 16, CV_AMP = 4, CV_LIP = -0.35; // the walls stop just under the seabed: no rim above it (the GPU hole is a little smaller)
const CVR = []; // the systems with a finished mesh
let cvGenS = null, cvGenI = null; // the one being meshed
const CAVE_THEMES = ['glowing fungus', 'crystal', 'lava', 'brine river', 'bioluminescent cove'];

// small local random stream (the shared rnd() belongs to the load-time generators)
function cvRand(s) { let a = s | 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// 3D value noise in [0, 1]
function cvH(x, y, z) { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177) + WSEED * 97) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function cvVN(x, y, z) {
  const ix = floor(x), iy = floor(y), iz = floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const a = cvH(ix, iy, iz), b = cvH(ix + 1, iy, iz), c = cvH(ix, iy + 1, iz), d = cvH(ix + 1, iy + 1, iz);
  const e = cvH(ix, iy, iz + 1), f = cvH(ix + 1, iy, iz + 1), g = cvH(ix, iy + 1, iz + 1), h = cvH(ix + 1, iy + 1, iz + 1);
  const x1 = a + (b - a) * u, x2 = c + (d - c) * u, x3 = e + (f - e) * u, x4 = g + (h - g) * u;
  const y1 = x1 + (x2 - x1) * v, y2 = x3 + (x4 - x3) * v;
  return y1 + (y2 - y1) * w;
}
const cvNoise = (x, y, z) => (cvVN(x * 0.05, y * 0.065, z * 0.05) * 0.62 + cvVN(x * 0.14 + 5.2, y * 0.16, z * 0.14 - 3.1) * 0.38) * 2 - 1;
// lowest seabed within r of (x, z)
const cvLow = (x, z, r) => min(hAt(x, z), hAt(x + r, z), hAt(x - r, z), hAt(x, z + r), hAt(x, z - r));

// ---------------------------------------------------------------- skeleton
function caveSys(gx, gz) {
  const key = gx * 65536 + gz;
  let S = CVS.get(key);
  if (S) return S;
  if (CVS.size > 3000) { for (const [k, v] of CVS) if (!v.vb && v !== cvGenS) CVS.delete(k); }
  S = { key, gx, gz, ok: false };
  CVS.set(key, S);
  if (hash2(gx, gz, 601) > 0.5) return S;
  const R = cvRand(hash2(gx, gz, 602) * 4294967296);
  const M = 70, x0 = gx * CAVE_CELL + M, z0 = gz * CAVE_CELL + M, W = CAVE_CELL - 2 * M;
  const inC = (x, z) => x >= x0 && x <= x0 + W && z >= z0 && z <= z0 + W;
  const cl = (x, z) => [clamp(x, x0, x0 + W), clamp(z, z0, z0 + W)];
  // two mouths 250-420 m apart, both inside the cell
  let ax = 0, az = 0, bx = 0, bz = 0, found = false;
  for (let t = 0; t < 12 && !found; t++) {
    ax = x0 + R() * W; az = z0 + R() * W;
    const yaw = R() * TAU, L = 250 + 170 * R();
    bx = ax + cos(yaw) * L; bz = az + sin(yaw) * L;
    found = inC(bx, bz);
  }
  if (!found) return S;
  const ha = hAt(ax, az), hb = hAt(bx, bz);
  if (ha > -24 || hb > -24 || ha < -400 || hb < -400) return S;
  const r = 13 + 4 * R();
  const dl = hypot(bx - ax, bz - az), ux = (bx - ax) / dl, uz = (bz - az) / dl, px = -uz, pz = ux;
  // mouth capsules: from just above the ground outside to well under it, sloping in
  // a mouth: a gently sloping capsule that starts just above the ground in front and runs in under a rocky knoll, so the
  // tunnel opens in the knoll's side (the knoll: an ellipsoid set back over the tunnel, lumpy with noise; cvMound)
  const mouth = (gx_, gz_, hg, sx, sz) => {
    const o = [gx_ - sx * r * 1.8, hg + r * 0.2, gz_ - sz * r * 1.8];
    const ix = gx_ + sx * r * 2.2, iz = gz_ + sz * r * 2.2;
    const i = [ix, min(hg - r * 1.3, hAt(ix, iz) - r * 1.25), iz];
    const c = [gx_ + sx * r, hg, gz_ + sz * r];
    return { a: o, b: i, r, g: [gx_, hg, gz_], mc: c, mh: r * 2.2, mv: r * 1.9 };
  };
  const mA = mouth(ax, az, ha, ux, uz), mB = mouth(bx, bz, hb, -ux, -uz);
  // interior control points, wandering sideways
  const pts = [mA.a, mA.b];
  const nMid = 3, side = (R() - 0.5) * 2;
  for (let i = 1; i <= nMid; i++) {
    const t = i / (nMid + 1), wob = (i === 2 ? side : (R() - 0.5) * 2) * (40 + 50 * R());
    const [x, z] = cl(ax + (bx - ax) * t + px * wob, az + (bz - az) * t + pz * wob);
    pts.push([x, cvLow(x, z, r) - r - 18 - 40 * R(), z]);
  }
  pts.push(mB.b, mB.a);
  // Catmull-Rom through the interior points (the mouths are straight capsules); samples about every 9 m
  const segs = [], add = (a, b, rad, sq) => segs.push(a[0], a[1], a[2], b[0], b[1], b[2], rad, sq);
  add(mA.a, mA.b, r, 1);
  const path = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2], n = max(2, ceil(hypot(p2[0] - p1[0], p2[2] - p1[2]) / 9));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t, c = (q) => 0.5 * (2 * p1[q] + (-p0[q] + p2[q]) * t + (2 * p0[q] - 5 * p1[q] + 4 * p2[q] - p3[q]) * t2 + (-p0[q] + 3 * p1[q] - 3 * p2[q] + p3[q]) * t3);
      path.push([c(0), c(1), c(2)]);
    }
  }
  path.push(mB.b);
  // keep the roof under the rock (not near the mouths, which are meant to open) and the floor above the dive limit
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (i === 0 || i === path.length - 1) continue; // the mouths' inner ends
    p[1] = min(p[1], cvLow(p[0], p[2], r * 1.2) - r - 9);
    if (p[1] - r < -486) { if (cvLow(p[0], p[2], r) - 9 < -486 + 2 * r) return S; p[1] = -486 + r; }
  }
  for (let i = 0; i + 1 < path.length; i++) add(path[i], path[i + 1], r * (0.86 + 0.3 * cvVN(i * 0.21, 3.7, gx * 1.3)), 1.12);
  add(mB.b, mB.a, r, 1);
  // a chamber halfway, three overlapping spheres
  const chambers = [];
  const room = (c, Rr) => {
    const y = min(c[1], cvLow(c[0], c[2], Rr) - Rr - 10);
    if (y - Rr < -486) return;
    chambers.push([c[0], y, c[2], Rr]);
    for (let k = 0; k < 3; k++) { const a = k * 2.1 + R(), o = Rr * 0.38; const q = [c[0] + cos(a) * o, y + (R() - 0.5) * Rr * 0.3, c[2] + sin(a) * o]; add(q, q, Rr * (0.62 + 0.15 * R()), 1.25); }
  };
  const mid = path[path.length >> 1];
  // a giant cavern instead of the chamber, 40 % of systems: a hall 140-220 m across and about 100 m high, deep under
  // the rock, made of flattened lobes, with rock pillars and a natural arch across it, joined to the tunnel by a shaft
  const rocks = []; let cav = null;
  if (R() < 0.4) {
    const Rh = 70 + 40 * R(), H = 42 + 18 * R();
    const cx = clamp(mid[0], x0 + Rh, x0 + W - Rh), cz = clamp(mid[2], z0 + Rh, z0 + W - Rh);
    const top = cvLow(cx, cz, Rh * 0.8) - 28;
    let cy = top - H; if (cy - H < -480) cy = -480 + H;
    if (cy + H < top + 1 && Rh * 2 < W) {
      cav = { x: cx, y: cy, z: cz, Rh, H };
      for (let k = 0; k < 6; k++) { const a = k * 1.05 + R() * 0.6, o = k ? Rh * (0.3 + 0.2 * R()) : 0; const q = [cx + cos(a) * o, cy + (R() - 0.5) * H * 0.3, cz + sin(a) * o]; add(q, q, Rh * (0.55 + 0.12 * R()), Rh / H); }
      add(mid, [cx + (mid[0] - cx) * 0.4, cy + H * 0.55, cz + (mid[2] - cz) * 0.4], r * 0.95, 1.1); // the shaft down from the tunnel
      for (let k = 0, n = 2 + (R() * 3 | 0); k < n; k++) { const a = R() * TAU, o = Rh * (0.25 + 0.35 * R()), x = cx + cos(a) * o, z = cz + sin(a) * o; rocks.push([x, cy - H * 1.2, z, x, cy + H * 1.2, z, 6 + 6 * R()]); }
      const a = R() * TAU, ay = cy + H * (0.05 + 0.35 * R()); rocks.push([cx - cos(a) * Rh * 0.9, ay, cz - sin(a) * Rh * 0.9, cx + cos(a) * Rh * 0.9, ay + (R() - 0.5) * 10, cz + sin(a) * Rh * 0.9, 6 + 4 * R()]);
      chambers.push([cx, cy, cz, Rh]);
    }
  }
  if (!cav) room(mid, 30 + 18 * R());
  // a side passage to a dead-end grotto, 45 % of systems
  if (R() < 0.45) {
    const sgn = R() < 0.5 ? -1 : 1, L = 110 + 60 * R();
    const [ex, ez] = cl(mid[0] + px * sgn * L + ux * (R() - 0.5) * 60, mid[2] + pz * sgn * L + uz * (R() - 0.5) * 60);
    const Rg = 22 + 10 * R(), ey = min(mid[1] + (R() - 0.5) * 30, cvLow(ex, ez, Rg) - Rg - 10);
    if (ey - Rg > -486) {
      const n = max(3, ceil(hypot(ex - mid[0], ez - mid[2]) / 10)), rb = r * 0.82;
      let prev = [mid[0], mid[1], mid[2]];
      for (let k = 1; k <= n; k++) {
        const t = k / n, w = sin(t * PI) * 18 * sgn;
        const x = mid[0] + (ex - mid[0]) * t + ux * w, z = mid[2] + (ez - mid[2]) * t + uz * w;
        const p = [x, min(mid[1] + (ey - mid[1]) * t, cvLow(x, z, rb) - rb - 9), z];
        add(prev, p, rb * (0.85 + 0.3 * cvVN(k * 0.3, 9.1, gz * 1.7)), 1.12); prev = p;
      }
      room([ex, ey, ez], Rg);
    }
  }
  S.ok = true; S.r = r; S.segs = new Float64Array(segs); S.n = segs.length / 8; S.mouths = [mA, mB]; S.chambers = chambers; S.cav = cav; S.rocks = rocks;
  S.ox = (gx + 0.5) * CAVE_CELL; S.oz = (gz + 0.5) * CAVE_CELL;
  let lo = 1e9, hi = -1e9, sum = 0;
  for (let i = 0; i < S.n; i++) { const o = i * 8; lo = min(lo, S.segs[o + 1] - S.segs[o + 6], S.segs[o + 4] - S.segs[o + 6]); hi = max(hi, S.segs[o + 1] + S.segs[o + 6], S.segs[o + 4] + S.segs[o + 6]); sum += S.segs[o + 1]; }
  S.ylo = lo - CV_AMP - 6; S.yhi = hi + CV_AMP + 6;
  S.theme = sum / S.n < -250 ? 2 : R() < 0.5 ? 0 : 1;
  // caverns: a lava lake in the deep; else a river of glowing brine or a bioluminescent cove
  if (cav) { S.theme = cav.y < -290 ? 2 : R() < 0.55 ? 3 : 4; if (S.theme !== 4) cav.pool = cav.y - cav.H * 0.62; }
  S.seed = R();
  S.all = new Int32Array(S.n).map((_, i) => i);
  return S;
}

// ---------------------------------------------------------------- field: < 0 inside the cave (water), > 0 in the rock
function cvDist(S, list, n, x, y, z) {
  const s = S.segs; let d = 1e9;
  for (let k = 0; k < n; k++) {
    const o = list[k] * 8, ax = s[o], ay = s[o + 1], az = s[o + 2], bx = s[o + 3] - ax, by = s[o + 4] - ay, bz = s[o + 5] - az;
    const px = x - ax, py = y - ay, pz = z - az, bb = bx * bx + by * by + bz * bz;
    let h = bb > 0 ? (px * bx + py * by + pz * bz) / bb : 0; h = h < 0 ? 0 : h > 1 ? 1 : h;
    const qx = px - bx * h, qy = (py - by * h) * s[o + 7], qz = pz - bz * h;
    const di = sqrt(qx * qx + qy * qy + qz * qz) - s[o + 6], e = 7 - abs(d - di);
    d = e > 0 ? min(d, di) - e * e / 28 : min(d, di);
  }
  return d;
}
function cvField(S, list, n, x, y, z) {
  let d = cvDist(S, list, n, x, y, z);
  if (d < CV_AMP + 1.5 && d > -CV_AMP - 1.5) {
    let a = CV_AMP;
    for (const m of S.mouths) { const g = m.g; a *= sstep(S.r * 1.25, S.r * 2.6, hypot(x - g[0], y - g[1], z - g[2])); }
    d += a * cvNoise(x, y, z);
  }
  // rock inside a cavern: pillars floor to ceiling, an arch across (lumpy)
  for (const k of S.rocks) {
    const ax = k[0], ay = k[1], az = k[2], bx = k[3] - ax, by = k[4] - ay, bz = k[5] - az, px = x - ax, py = y - ay, pz = z - az, bb = bx * bx + by * by + bz * bz;
    let h = (px * bx + py * by + pz * bz) / bb; h = h < 0 ? 0 : h > 1 ? 1 : h;
    const dr = hypot(px - bx * h, py - by * h, pz - bz * h) - k[6] * (1 + 0.35 * sin(h * 17 + k[0])) - 2.5 * cvNoise(x * 1.6, y * 1.6, z * 1.6);
    if (-dr > d) d = -dr;
  }
  return d;
}
// the knolls over the mouths: < 0 inside the rock
function cvMound(S, x, y, z) {
  let d = 1e9;
  for (const m of S.mouths) {
    const c = m.mc, qx = (x - c[0]) / m.mh, qy = (y - c[1]) / m.mv, qz = (z - c[2]) / m.mh, l = sqrt(qx * qx + qy * qy + qz * qz);
    if (l > 2.2) continue;
    d = min(d, (l - 1) * m.mv + (l < 1.6 ? 3.2 * cvNoise(x * 1.7, y * 1.9, z * 1.7) + 1.4 * cvNoise(x * 4.1 + 9, y * 4.4, z * 4.1) : 0));
  }
  return d;
}
// the segments that can matter within rad of a point
function cvNear(S, x, y, z, rad, out) {
  const s = S.segs; let n = 0;
  for (let i = 0; i < S.n; i++) {
    const o = i * 8, ax = s[o], ay = s[o + 1], az = s[o + 2], bx = s[o + 3] - ax, by = s[o + 4] - ay, bz = s[o + 5] - az;
    const px = x - ax, py = y - ay, pz = z - az, bb = bx * bx + by * by + bz * bz;
    let h = bb > 0 ? (px * bx + py * by + pz * bz) / bb : 0; h = h < 0 ? 0 : h > 1 ? 1 : h;
    if (hypot(px - bx * h, py - by * h, pz - bz * h) - s[o + 6] < rad + 8) out[n++] = i;
  }
  return n;
}
// daylight at a point of the cave: full at the mouths, none 2.6 radii in
function cvOpen(S, x, y, z) {
  let o = 0;
  for (const m of S.mouths) { const g = m.g; o = max(o, sstep(S.r * 2.7, S.r * 0.6, hypot(x - g[0], y - g[1], z - g[2]))); }
  return o;
}

// ---------------------------------------------------------------- meshing (surface nets, generator: one block per step)
function* cvMesh(S) {
  const CS = CV_CS, B = CV_B, N = B + 2, C1 = B + 1, BW = B * CS, hd = BW * 0.87;
  let cap = 16384, nv = 0, ni = 0, pos = new Float32Array(cap * 3), nrm = new Int8Array(cap * 4), idx = new Uint32Array(cap * 3);
  const grow = () => {
    cap *= 2; const p = new Float32Array(cap * 3); p.set(pos); pos = p; const q = new Int8Array(cap * 4); q.set(nrm); nrm = q;
  };
  const growI = () => { const q = new Uint32Array(idx.length * 2); q.set(idx); idx = q; };
  // blocks near the cave surface
  let xlo = 1e9, xhi = -1e9, zlo = 1e9, zhi = -1e9;
  const s = S.segs;
  for (let i = 0; i < S.n; i++) { const o = i * 8, rr = s[o + 6] + CV_AMP + 4; xlo = min(xlo, s[o] - rr, s[o + 3] - rr); xhi = max(xhi, s[o] + rr, s[o + 3] + rr); zlo = min(zlo, s[o + 2] - rr, s[o + 5] - rr); zhi = max(zhi, s[o + 2] + rr, s[o + 5] + rr); }
  const bx0 = floor((xlo - S.ox) / BW), bx1 = floor((xhi - S.ox) / BW), bz0 = floor((zlo - S.oz) / BW), bz1 = floor((zhi - S.oz) / BW), by0 = floor(S.ylo / BW), by1 = floor(S.yhi / BW);
  const blocks = [];
  for (let by = by0; by <= by1; by++) for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) {
    const cx = S.ox + (bx + 0.5) * BW, cy = (by + 0.5) * BW, cz = S.oz + (bz + 0.5) * BW;
    let near = abs(cvDist(S, S.all, S.n, cx, cy, cz)) < hd + CV_AMP + 2;
    for (const m of S.mouths) if (hypot(cx - m.mc[0], cy - m.mc[1], cz - m.mc[2]) < m.mh + hd + 6) near = true;
    for (const k of S.rocks) { const bx = k[3] - k[0], by = k[4] - k[1], bz = k[5] - k[2], px = cx - k[0], py = cy - k[1], pz = cz - k[2]; let h = (px * bx + py * by + pz * bz) / (bx * bx + by * by + bz * bz); h = h < 0 ? 0 : h > 1 ? 1 : h; if (hypot(px - bx * h, py - by * h, pz - bz * h) < k[6] * 1.4 + hd + 6) near = true; }
    if (near) blocks.push([bx, by, bz]);
  }
  S.nBlocks = blocks.length;
  const F = new Float32Array(N * N * N), T = new Uint8Array(N * N * N), H = new Float64Array(N * N), CI = new Int32Array(C1 * C1 * C1), list = new Int32Array(S.n);
  const ex = [0, 1, 0, 1, 0, 1, 0, 1], ey = [0, 0, 1, 1, 0, 0, 1, 1], ez = [0, 0, 0, 0, 1, 1, 1, 1];
  const EDG = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  let nl = 0, ground = false;
  // water-positive field at a world point (the cave, cut off LIP above the seabed)
  const wf = (x, y, z, hg) => { const c = -cvField(S, list, nl, x, y, z); return ground ? max(c, min(y - hg - CV_LIP, cvMound(S, x, y, z))) : c; };
  let bn = 0;
  for (const [bx, by, bz] of blocks) {
    const X0 = S.ox + bx * BW - CS, Y0 = by * BW - CS, Z0 = S.oz + bz * BW - CS; // corner (-1, -1, -1)
    nl = cvNear(S, X0 + (N - 1) * CS * 0.5, Y0 + (N - 1) * CS * 0.5, Z0 + (N - 1) * CS * 0.5, hd + CS * 2 + CV_AMP + 7, list);
    // the seabed only matters for blocks that reach up to it
    const hc = [hAt(X0, Z0), hAt(X0 + (N - 1) * CS, Z0), hAt(X0, Z0 + (N - 1) * CS), hAt(X0 + (N - 1) * CS, Z0 + (N - 1) * CS), hAt(X0 + (N - 1) * CS * 0.5, Z0 + (N - 1) * CS * 0.5)];
    ground = Y0 + (N - 1) * CS > min(...hc) - 25;
    if (ground) for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) H[k * N + i] = hAt(X0 + i * CS, Z0 + k * CS);
    for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = X0 + i * CS, y = Y0 + j * CS, z = Z0 + k * CS, c = -cvField(S, list, nl, x, y, z), o = (k * N + j) * N + i;
      // the seabed (drawn by the clipmap: its faces are skipped), the knolls and the cave
      if (ground) { const g = y - H[k * N + i] - CV_LIP, m = cvMound(S, x, y, z), wt = min(g, m); F[o] = max(c, wt); T[o] = g <= m && wt > c ? 1 : 0; } else { F[o] = c; T[o] = 0; }
    }
    // one vertex per cell the surface crosses: the mean of its edge crossings, normal from the field's gradient
    for (let k = 0; k < C1; k++) for (let j = 0; j < C1; j++) for (let i = 0; i < C1; i++) {
      const c0 = (k * N + j) * N + i; let m = 0;
      const v = [F[c0], F[c0 + 1], F[c0 + N], F[c0 + N + 1], F[c0 + N * N], F[c0 + N * N + 1], F[c0 + N * N + N], F[c0 + N * N + N + 1]];
      for (let q = 0; q < 8; q++) if (v[q] > 0) m |= 1 << q;
      const ci = (k * C1 + j) * C1 + i;
      if (m === 0 || m === 255) { CI[ci] = -1; continue; }
      let sx = 0, sy = 0, sz = 0, c = 0;
      for (const [a, b] of EDG) {
        if ((v[a] > 0) === (v[b] > 0)) continue;
        const t = v[a] / (v[a] - v[b]);
        sx += ex[a] + (ex[b] - ex[a]) * t; sy += ey[a] + (ey[b] - ey[a]) * t; sz += ez[a] + (ez[b] - ez[a]) * t; c++;
      }
      const x = X0 + (i + sx / c) * CS, y = Y0 + (j + sy / c) * CS, z = Z0 + (k + sz / c) * CS;
      const hg = ground ? hAt(x, z) : 0, e = CS * 0.5;
      let gx = wf(x + e, y, z, hg) - wf(x - e, y, z, hg), gy = wf(x, y + e, z, hg) - wf(x, y - e, z, hg), gz = wf(x, y, z + e, hg) - wf(x, y, z - e, hg);
      const gl = hypot(gx, gy, gz) || 1; gx /= gl; gy /= gl; gz /= gl;
      if (nv >= cap) grow();
      pos[nv * 3] = x - S.ox; pos[nv * 3 + 1] = y; pos[nv * 3 + 2] = z - S.oz;
      const op = ground && y > hg - 1 ? 1 : cvOpen(S, x, y, z);
      nrm[nv * 4] = round(gx * 127); nrm[nv * 4 + 1] = round(gy * 127); nrm[nv * 4 + 2] = round(gz * 127); nrm[nv * 4 + 3] = round(op * 127);
      CI[ci] = nv++;
    }
    // a quad across every crossed edge this block owns (base corner in 0..B-1), unless it is the seabed's (drawn by the
    // clipmap): both ends on the seabed side of the field
    const quad = (a, b, c, d) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      if (ni + 6 > idx.length) growI();
      idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d;
    };
    const cid = (i, j, k) => CI[(k * C1 + j) * C1 + i];
    for (let k = 1; k <= B; k++) for (let j = 1; j <= B; j++) for (let i = 1; i <= B; i++) {
      const o = (k * N + j) * N + i, f0 = F[o] > 0;
      // x edge (i, j, k) -> (i + 1, j, k): cells (i, j-1.., k-1..) in cell coords = corner - 1 + ...
      if (i < B + 1 && f0 !== (F[o + 1] > 0) && !(T[o] && T[o + 1])) quad(cid(i, j - 1, k - 1), cid(i, j, k - 1), cid(i, j, k), cid(i, j - 1, k));
      if (j < B + 1 && f0 !== (F[o + N] > 0) && !(T[o] && T[o + N])) quad(cid(i - 1, j, k - 1), cid(i, j, k - 1), cid(i, j, k), cid(i - 1, j, k));
      if (k < B + 1 && f0 !== (F[o + N * N] > 0) && !(T[o] && T[o + N * N])) quad(cid(i - 1, j - 1, k), cid(i, j - 1, k), cid(i, j, k), cid(i - 1, j, k));
    }
    bn++;
    yield bn;
  }
  // the cavern's pool: a lava lake or a glowing brine river, a flat sheet over the cavern floor (n.w = -1 marks it)
  if (S.cav && S.cav.pool !== undefined) {
    const C = S.cav, st = 4, py = C.pool, n = ceil(C.Rh * 2.4 / st), xs = C.x - n * st / 2, zs = C.z - n * st / 2, row = new Int32Array((n + 1) * (n + 1)).fill(-1);
    nl = cvNear(S, C.x, py, C.z, C.Rh * 1.3, list);
    const inside = new Uint8Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) inside[j * (n + 1) + i] = cvField(S, list, nl, xs + i * st, py, zs + j * st) < -0.5 ? 1 : 0;
    const vtx = (i, j) => { const k = j * (n + 1) + i; if (row[k] >= 0) return row[k]; if (nv >= cap) grow(); pos[nv * 3] = xs + i * st - S.ox; pos[nv * 3 + 1] = py; pos[nv * 3 + 2] = zs + j * st - S.oz; nrm[nv * 4] = 0; nrm[nv * 4 + 1] = 127; nrm[nv * 4 + 2] = 0; nrm[nv * 4 + 3] = -127; return (row[k] = nv++); };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i; if (!(inside[a] || inside[a + 1] || inside[a + n + 1] || inside[a + n + 2])) continue;
      if (ni + 6 > idx.length) growI();
      const p0 = vtx(i, j), p1 = vtx(i + 1, j), p2 = vtx(i + 1, j + 1), p3 = vtx(i, j + 1);
      idx[ni++] = p0; idx[ni++] = p1; idx[ni++] = p2; idx[ni++] = p0; idx[ni++] = p2; idx[ni++] = p3;
    }
  }
  S.nv = nv; S.ni = ni;
  const vb = new ArrayBuffer(nv * 16), vf = new Float32Array(vb), vi = new Int8Array(vb);
  for (let v = 0; v < nv; v++) { vf[v * 4] = pos[v * 3]; vf[v * 4 + 1] = pos[v * 3 + 1]; vf[v * 4 + 2] = pos[v * 3 + 2]; for (let q = 0; q < 4; q++) vi[v * 16 + 12 + q] = nrm[v * 4 + q]; }
  S.vb = vb; S.ib = idx.slice(0, ni); S.pos = pos; S.nrm = nrm;
  cvDecor(S);
  S.pos = S.nrm = null;
}

// ---------------------------------------------------------------- what grows in a cave, and the light it gives
// mesh ids (main.js): 0-3 rocks, 23 mushroom, 27 crystal cluster, 28 vent chimney; materials 1 rock, 6 fungus, 7
// crystal, 8 vent. Seeds pick the glow colour the shaders give them: fungus fract(seed * 3.7) < .5 pink, else teal;
// crystal fract(seed * 2.9): < .55 cyan, < .82 amber, else violet.
const CV_GLOW = { fungusPink: [1, 0.3, 0.9], fungusTeal: [0.25, 1, 0.85], cyan: [0.22, 0.95, 1], amber: [1, 0.6, 0.16], violet: [0.72, 0.32, 1], lava: [1, 0.32, 0.05] };
function cvDecor(S) {
  const R = cvRand(S.seed * 4294967296 + 77), P = S.pos, Nn = S.nrm, nv = S.nv, items = [], lights = [];
  const want = clamp((nv / 70) | 0, 40, S.cav ? 260 : 150);
  const qUp = (nx, ny, nz, spin) => {
    const ax = nz, az = -nx, l = hypot(ax, az), ang = Math.acos(clamp(ny, -1, 1));
    const q = l < 1e-4 ? (ny > 0 ? [0, 0, 0, 1] : [1, 0, 0, 0]) : qAxis(ax, 0, az, ang);
    return qMul(q, qAxis(0, 1, 0, spin));
  };
  const seedIn = (mul, lo, hi) => { const n = floor(R() * floor(mul - hi + 0.999)); return (n + lo + (hi - lo) * R()) / mul; };
  for (let t = 0; t < want * 4 && items.length < want; t++) {
    const v = (R() * nv) | 0, op = Nn[v * 4 + 3] / 127;
    if (op > 0.3 || op < -0.5) continue; // not near the mouths, not on the pool
    let nx = Nn[v * 4] / 127, ny = Nn[v * 4 + 1] / 127, nz = Nn[v * 4 + 2] / 127;
    const x = P[v * 3] + S.ox, y = P[v * 3 + 1], z = P[v * 3 + 2] + S.oz;
    let near = false; for (const L of items) if (abs(L.x - x) < 7 && abs(L.z - z) < 7 && abs(L.y - y) < 7) { near = true; break; }
    if (near) continue;
    const floorV = ny > 0.55, ceil_ = ny < -0.5, spin = R() * TAU, r = R();
    let k, mesh, mat, sc, seed = R(), glow = null, rad = 0, sink = 0.3;
    if (S.theme === 0) { // giant glowing fungi on the floor, violet crystals overhead, rocks
      if (floorV && r < 0.62) { k = 5; mesh = 23; mat = 6; sc = 1.4 + 2.2 * R(); seed = R() < 0.75 ? seedIn(3.7, 0.02, 0.48) : seedIn(3.7, 0.52, 0.98); glow = fract(seed * 3.7) < 0.5 ? CV_GLOW.fungusPink : CV_GLOW.fungusTeal; rad = 2.6 * sc; }
      else if (!floorV && r < 0.5) { k = 7; mesh = 27; mat = 7; sc = 1.2 + 1.8 * R(); seed = seedIn(2.9, 0.84, 0.98); glow = CV_GLOW.violet; rad = 2.5 * sc; }
      else { k = 12; mesh = (R() * 4) | 0; mat = 1; sc = 1.5 + 3 * R(); sink = 0.45; }
    } else if (S.theme === 1) { // crystal caves: clusters everywhere, mostly cyan with some amber
      if (r < 0.75) { k = 7; mesh = 27; mat = 7; sc = (ceil_ ? 1.4 : 1.6) + 3 * R(); seed = R() < 0.8 ? seedIn(2.9, 0.02, 0.53) : seedIn(2.9, 0.57, 0.8); glow = fract(seed * 2.9) < 0.55 ? CV_GLOW.cyan : CV_GLOW.amber; rad = 2.5 * sc; }
      else { k = 12; mesh = (R() * 4) | 0; mat = 1; sc = 1.5 + 3 * R(); sink = 0.45; }
    } else if (S.theme === 3) { // brine river: tall amber-tipped spires on the banks, teal fungi
      if (floorV && r < 0.5) { k = 7; mesh = 27; mat = 7; sc = 2.5 + 4 * R(); seed = seedIn(2.9, 0.57, 0.8); glow = CV_GLOW.amber; rad = 2.5 * sc; nx *= 0.4; nz *= 0.4; ny = 1; }
      else if (floorV && r < 0.75) { k = 5; mesh = 23; mat = 6; sc = 1.2 + 2 * R(); seed = seedIn(3.7, 0.52, 0.98); glow = CV_GLOW.fungusTeal; rad = 2.6 * sc; }
      else { k = 12; mesh = (R() * 4) | 0; mat = 1; sc = 2 + 4 * R(); sink = 0.45; }
    } else if (S.theme === 4) { // bioluminescent cove: violet and blue crystals everywhere, pink fungi
      if (r < 0.6) { k = 7; mesh = 27; mat = 7; sc = 1.5 + 3 * R(); seed = R() < 0.6 ? seedIn(2.9, 0.84, 0.98) : seedIn(2.9, 0.02, 0.53); glow = fract(seed * 2.9) > 0.82 ? CV_GLOW.violet : CV_GLOW.cyan; rad = 2.5 * sc; }
      else if (floorV && r < 0.85) { k = 5; mesh = 23; mat = 6; sc = 1.4 + 2.2 * R(); seed = seedIn(3.7, 0.02, 0.48); glow = CV_GLOW.fungusPink; rad = 2.6 * sc; }
      else { k = 12; mesh = (R() * 4) | 0; mat = 1; sc = 1.5 + 3 * R(); sink = 0.45; }
    } else { // lava: vent chimneys on the floor, amber crystals on the walls
      if (floorV && r < 0.5) { k = 8; mesh = 28; mat = 8; sc = 1.4 + 1.8 * R(); glow = CV_GLOW.lava; rad = 3.6 * sc; nx *= 0.3; nz *= 0.3; ny = 1; }
      else if (r < 0.7) { k = 7; mesh = 27; mat = 7; sc = 1.2 + 2 * R(); seed = seedIn(2.9, 0.57, 0.8); glow = CV_GLOW.amber; rad = 2.5 * sc; }
      else { k = 12; mesh = (R() * 4) | 0; mat = 1; sc = 1.5 + 3 * R(); sink = 0.45; }
    }
    if (k === 5) { const l = hypot(nx, ny + 1.5, nz); nx /= l; ny = (ny + 1.5) / l; nz /= l; } // fungi grow up
    const L = { k, x: x - nx * sink * sc * (k === 12 ? 1 : 0.4), y: y - ny * sink * sc * (k === 12 ? 1 : 0.4), z: z - nz * sink * sc * (k === 12 ? 1 : 0.4), q: qUp(nx, ny, nz, spin), sc, rad: rad || 2 * sc, mesh, mat, seed, yaw: spin, cv: true, open: op };
    items.push(L);
    if (glow && (k === 8 || R() < 0.7)) lights.push({ x: x + nx * sc * 1.5, y: y + ny * sc * 1.5, z: z + nz * sc * 1.5, rad: (k === 8 ? 26 : 16) + sc * 3, c: glow, i: k === 8 ? 1.6 : k === 5 ? 1.1 : 0.9 });
  }
  // the entrances: big glowing growths on the knoll around each mouth, and a light just inside it
  for (const M of S.mouths) {
    let n = 0;
    for (let t = 0; t < 600 && n < 7; t++) {
      const v = (R() * nv) | 0, op = Nn[v * 4 + 3] / 127;
      if (op < 0.95) continue;
      const nx = Nn[v * 4] / 127, ny = Nn[v * 4 + 1] / 127, nz = Nn[v * 4 + 2] / 127, x = P[v * 3] + S.ox, y = P[v * 3 + 1], z = P[v * 3 + 2] + S.oz;
      if (ny < 0.15 || hypot(x - M.g[0], z - M.g[2]) > M.r * 2.6) continue;
      let near = false; for (const L of items) if (abs(L.x - x) < 6 && abs(L.z - z) < 6 && abs(L.y - y) < 6) { near = true; break; }
      if (near) continue;
      const spin = R() * TAU; let L;
      if (S.theme === 0) { const sc = 3 + 3 * R(), seed = seedIn(3.7, 0.02, 0.48), l = hypot(nx, ny + 1.5, nz); L = { k: 5, mesh: 23, mat: 6, sc, seed, nx: nx / l, ny: (ny + 1.5) / l, nz: nz / l }; }
      else if (S.theme === 1) { const sc = 3 + 3.5 * R(); L = { k: 7, mesh: 27, mat: 7, sc, seed: seedIn(2.9, 0.02, 0.53), nx, ny, nz }; }
      else { const sc = 2.4 + 2 * R(); L = { k: 8, mesh: 28, mat: 8, sc, seed: R(), nx: nx * 0.3, ny: 1, nz: nz * 0.3 }; }
      const sk = L.sc * 0.12;
      items.push({ k: L.k, x: x - L.nx * sk, y: y - L.ny * sk, z: z - L.nz * sk, q: qUp(L.nx, L.ny, L.nz, spin), sc: L.sc, rad: 2.6 * L.sc, mesh: L.mesh, mat: L.mat, seed: L.seed, yaw: spin, cv: true, open: 1 });
      n++;
    }
    const c = S.theme === 0 ? CV_GLOW.fungusPink : S.theme === 1 ? CV_GLOW.cyan : CV_GLOW.lava, a = M.a, b = M.b;
    lights.push({ x: a[0] + (b[0] - a[0]) * 0.65, y: a[1] + (b[1] - a[1]) * 0.65, z: a[2] + (b[2] - a[2]) * 0.65, rad: 34, c, i: 1.6 });
  }
  // the cavern's pool lights it from below; the cove gets a great glowing growth in the middle of its floor
  if (S.cav) {
    const C = S.cav;
    if (C.pool !== undefined) for (let t = 0; t < 26; t++) { const a = R() * TAU, o = sqrt(R()) * C.Rh * 0.8; lights.push({ x: C.x + cos(a) * o, y: C.pool + 3, z: C.z + sin(a) * o, rad: 48, c: S.theme === 2 ? [1, 0.36, 0.06] : [0.3, 1, 0.42], i: S.theme === 2 ? 1.6 : 0.9 }); }
    if (S.theme === 4) {
      const fy = C.y - C.H * 0.75;
      for (let k = 0; k < 9; k++) { const a = k * 0.7, lean = k ? 0.35 + 0.25 * R() : 0, sc = k ? 6 + 5 * R() : 14, q = qMul(qAxis(0, 1, 0, a), qAxis(1, 0, 0, lean));
        items.push({ k: 7, x: C.x + cos(a) * (k ? 3 : 0), y: fy, z: C.z + sin(a) * (k ? 3 : 0), q, sc, rad: 2.5 * sc, mesh: 27, mat: 7, seed: k % 2 ? seedIn(2.9, 0.84, 0.98) : seedIn(2.9, 0.02, 0.4), yaw: a, cv: true, open: 0 }); }
      lights.push({ x: C.x, y: fy + 25, z: C.z, rad: 90, c: [0.45, 0.35, 1], i: 2.2 });
    }
  }
  // lava caves: glowing pools on the floor, no object needed
  if (S.theme === 2) for (let t = 0; t < 30; t++) { const v = (R() * nv) | 0; if (Nn[v * 4 + 1] > 90) lights.push({ x: P[v * 3] + S.ox, y: P[v * 3 + 1] + 2, z: P[v * 3 + 2] + S.oz, rad: 22, c: CV_GLOW.lava, i: 1.2 }); }
  S.decor = items; S.lights = lights;
}

// ---------------------------------------------------------------- per frame
// Mesh the nearest unmeshed system within reach (a few ms per frame), drop the far ones, and fill the cave part of G.
const CV_SEGL = new Int32Array(4096);
let cvEnc = 0, cvIn = null;
function caveTick(budget) {
  const cx = F[CX], cy = F[CY], cz = F[CZ];
  const g0 = floor((cx - 900) / CAVE_CELL), g1 = floor((cx + 900) / CAVE_CELL), h0 = floor((cz - 900) / CAVE_CELL), h1 = floor((cz + 900) / CAVE_CELL);
  if (!cvGenS) {
    let best = null, bd = 1e18;
    for (let gz = h0; gz <= h1; gz++) for (let gx = g0; gx <= g1; gx++) {
      const S = caveSys(gx, gz);
      if (!S.ok || S.vb) continue;
      const d = hypot(S.ox - cx, S.oz - cz);
      if (d < bd) { bd = d; best = S; }
    }
    if (best) { cvGenS = best; cvGenI = cvMesh(best); }
  }
  if (cvGenS) {
    const t0 = performance.now();
    while (performance.now() - t0 < budget) {
      if (cvGenI.next().done) { CVR.push(cvGenS); caveUpload(cvGenS); cvGenS = null; break; }
    }
  }
  // drop meshes far away
  for (let i = CVR.length - 1; i >= 0; i--) { const S = CVR[i]; if (hypot(S.ox - cx, S.oz - cz) > 1500) { caveDrop(S); S.vb = S.ib = null; S.decor = S.lights = null; CVR.splice(i, 1); } }
  // inside a cave? (the camera under the seabed, in a cave's water)
  const hg = hAt(cx, cz);
  let enc = 0;
  cvIn = null;
  if (cy < hg - 1) { const w = caveWater(cx, cy, cz, false); if (w > -2) { enc = sstep(0, 22, hg - cy); for (const S of CVR) if (abs(cx - S.ox) < CAVE_CELL * 0.6 && abs(cz - S.oz) < CAVE_CELL * 0.6) cvIn = S; } }
  cvEnc += (enc - cvEnc) * (1 - exp(-FDT * 2.5));
}
// G: cav (inside, lights, -, mouths), cm[8] (4 mouth capsules), cl[8] / cc[8] (8 lights)
const CVL = [];
function caveUniforms(m) {
  const cx = F[CX], cy = F[CY], cz = F[CZ];
  // mouths in view range, nearest first
  const ms = [];
  for (const S of CVR) for (const M of S.mouths) { const d = hypot(M.g[0] - cx, M.g[2] - cz); if (d < TQ.fogFar + 120) ms.push([d, M]); }
  ms.sort((a, b) => a[0] - b[0]);
  const nm = min(4, ms.length);
  for (let i = 0; i < nm; i++) {
    const M = ms[i][1], o = 88 + i * 8;
    m[o] = M.a[0] - cx; m[o + 1] = M.a[1]; m[o + 2] = M.a[2] - cz; m[o + 3] = M.r;
    m[o + 4] = M.b[0] - cx; m[o + 5] = M.b[1]; m[o + 6] = M.b[2] - cz; m[o + 7] = 0;
  }
  // lights within 110 m, nearest 8, fading out from 80 m
  CVL.length = 0;
  for (const S of CVR) {
    if (hypot(S.ox - cx, S.oz - cz) > CAVE_CELL + 110) continue;
    for (const L of S.lights) { const d = hypot(L.x - cx, L.y - cy, L.z - cz); if (d < 110) CVL.push([d, L]); }
  }
  for (const L of WLIGHTS) CVL.push([hypot(L.x - cx, L.y - cy, L.z - cz) * 0.25, L]); // missiles and blasts first
  CVL.sort((a, b) => a[0] - b[0]);
  const nl = min(12, CVL.length);
  for (let i = 0; i < nl; i++) {
    const [d, L] = CVL[i], o = i < 8 ? 120 + i * 4 : 200 + (i - 8) * 4, c = i < 8 ? 152 + i * 4 : 216 + (i - 8) * 4, f = sstep(110, 80, d) * L.i * (0.92 + 0.08 * sin(F[TIME] * 1.3 + L.x));
    m[o] = L.x - cx; m[o + 1] = L.y; m[o + 2] = L.z - cz; m[o + 3] = L.rad;
    m[c] = L.c[0] * f; m[c + 1] = L.c[1] * f; m[c + 2] = L.c[2] * f; m[c + 3] = 0;
  }
  m[84] = cvEnc; m[85] = nl; m[86] = 0; m[87] = nm;
  // the cave you are in: its glow fills the dark (cvf) and tints the haze; its pool (cvp: level, kind 1 lava 2 brine)
  const FILL = [[0.035, 0.012, 0.05], [0.01, 0.035, 0.04], [0.09, 0.025, 0.006], [0.012, 0.06, 0.025], [0.015, 0.025, 0.075]];
  let fc = [0, 0, 0], pool = -1e4, pk = 0;
  if (cvIn) { const S = cvIn, f = FILL[S.theme] || FILL[0], k = cvEnc * (S.cav && hypot(cx - S.cav.x, cz - S.cav.z) < S.cav.Rh * 1.2 ? 1.6 : 0.8); fc = f.map((v) => v * k); if (S.cav && S.cav.pool !== undefined) { pool = S.cav.pool; pk = S.theme === 2 ? 1 : 2; } }
  m[232] = fc[0]; m[233] = fc[1]; m[234] = fc[2]; m[235] = 0; m[236] = pool; m[237] = pk; m[238] = 0; m[239] = 0;
}
// how far a point is inside a cave's water (> 0 inside), over the meshed systems; with grad, its gradient in GR
function caveWater(x, y, z, grad) {
  let best = -1e9, BS = null, bn = 0;
  for (const S of CVR) {
    if (y < S.ylo - 4 || y > S.yhi + 4 || abs(x - S.ox) > CAVE_CELL * 0.5 + 40 || abs(z - S.oz) > CAVE_CELL * 0.5 + 40) continue;
    const n = cvNear(S, x, y, z, 6, CV_SEGL);
    if (!n) continue;
    const w = -cvField(S, CV_SEGL, n, x, y, z);
    if (w > best) { best = w; BS = S; bn = n; }
  }
  if (grad && BS) {
    bn = cvNear(BS, x, y, z, 6, CV_SEGL);
    const e = 0.3, f = (a, b, c) => -cvField(BS, CV_SEGL, bn, a, b, c);
    const gx = f(x + e, y, z) - f(x - e, y, z), gy = f(x, y + e, z) - f(x, y - e, z), gz = f(x, y, z + e) - f(x, y, z - e), l = hypot(gx, gy, gz);
    if (l > 1e-6) { GR[0] = gx / l; GR[1] = gy / l; GR[2] = gz / l; }
  }
  return best;
}
// is (x, z) within rad of a cave mouth (set pieces stay clear of them)
// rock of the knolls over the mouths (< 0 inside), over the meshed systems; with grad, its gradient in GR
function caveKnoll(x, y, z, grad) {
  let best = 1e9, BS = null;
  for (const S of CVR) for (const M of S.mouths) {
    if (abs(x - M.mc[0]) > M.mh * 2.3 || abs(z - M.mc[2]) > M.mh * 2.3 || y > M.mc[1] + M.mv * 2.3) continue;
    const d = cvMound(S, x, y, z); if (d < best) { best = d; BS = S; }
  }
  if (grad && BS) {
    const e = 0.3, f = (a, b, c) => cvMound(BS, a, b, c);
    const gx = f(x + e, y, z) - f(x - e, y, z), gy = f(x, y + e, z) - f(x, y - e, z), gz = f(x, y, z + e) - f(x, y, z - e), l = hypot(gx, gy, gz);
    if (l > 1e-6) { GR[0] = gx / l; GR[1] = gy / l; GR[2] = gz / l; }
  }
  return best;
}
function caveMouthNear(x, z, rad) {
  for (const S of CVR) for (const M of S.mouths) if (hypot(M.mc[0] - x, M.mc[2] - z) < rad + M.mh + 4) return true;
  return false;
}
// the nearest cave system (spiralling out over cells), for Go to and /cave
function findCave(fx, fz, cavern = false, theme = -1) {
  const c0 = floor(fx / CAVE_CELL), c1 = floor(fz / CAVE_CELL);
  for (let r = 0; r < 40; r++) {
    let best = null, bd = 1e18;
    for (let gz = c1 - r; gz <= c1 + r; gz++) for (let gx = c0 - r; gx <= c0 + r; gx++) {
      if (max(abs(gx - c0), abs(gz - c1)) !== r) continue;
      const S = caveSys(gx, gz);
      if (!S.ok || (cavern && !S.cav) || (theme >= 0 && S.theme !== theme)) continue;
      const d = hypot(S.mouths[0].g[0] - fx, S.mouths[0].g[2] - fz);
      if (d > 60 && d < bd) { bd = d; best = S; }
    }
    if (best) return best;
  }
  return null;
}
// mesh a system now (Go to: it should be there when you arrive)
function caveNow(S) {
  if (S.vb) return;
  if (cvGenS === S) { while (!cvGenI.next().done); }
  else { const it = cvMesh(S); while (!it.next().done); }
  if (cvGenS === S) cvGenS = null;
  CVR.push(S); caveUpload(S);
}
