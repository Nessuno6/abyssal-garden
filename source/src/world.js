// ============================================================================
// world: procedural meshes (load time) + the CPU side of the open world (per frame)
// ============================================================================
// The GPU owns the dense content: the clipmap terrain and the population of kelp, ground cover, rocks, sponges,
// coral and boulders (W_CLIP / W_POP / W_CULL). The CPU owns the sparse content, everything that needs Float64
// positions or game logic:
//  * landmarks: one optional set piece (sunken ship, stone whale fluke, monumental rock arch) per 512 m macro
//    cell, picked by a cell hash and the biome, anchored to h(x, z), at least 256 m from its neighbours
//  * collision: the analytic seabed h(x, z) plus the SDFs of the landmarks near the camera
//  * wildlife: fish schools and manta rays live in slots that are re-seeded ahead of the swimmer when they fall
//    behind the active bubble, so the sea never empties; bubble vents come from a 40 m cell hash
//  * biome / landmark search for the 1-7 keys
// Everything here that runs per frame allocates nothing.

// stone whale fluke: tapered capsules, x y z r (start) x y z r (end), z squash
const FLUKE_C = (() => {
  const C = [];
  const chain = (pts, zs) => { for (let i = 0; i < pts.length - 1; i++) C.push([...pts[i], ...pts[i + 1], zs]); };
  chain([[0, -1.6, 3.7, 1.2], [0, 1.8, 2.35, 0.98], [0, 4.6, 1.0, 0.76], [0, 6.9, 0.1, 0.6]], 0.8);
  chain([[0, 6.6, 0.1, 0.72], [1.9, 7.9, 0, 0.98], [3.9, 8.8, -0.1, 0.9], [5.7, 9.8, -0.25, 0.64], [7.0, 11.2, -0.4, 0.38], [7.7, 12.8, -0.55, 0.2], [7.9, 14.1, -0.65, 0.1]], 0.18);
  chain([[0, 6.6, 0.1, 0.72], [-1.7, 8.3, 0.05, 0.96], [-3.3, 9.7, -0.05, 0.88], [-4.7, 11.2, -0.2, 0.64], [-5.6, 12.9, -0.4, 0.38], [-6.0, 14.6, -0.5, 0.2], [-5.9, 15.9, -0.6, 0.1]], 0.18);
  return C;
})();
function flukeSD(x, y, z) {
  let d = 1e9;
  for (let i = 0; i < FLUKE_C.length; i++) {
    const c = FLUKE_C[i], zs = c[8], pz = z / zs, az = c[2] / zs, bz = c[6] / zs;
    const bax = c[4] - c[0], bay = c[5] - c[1], baz = bz - az, pax = x - c[0], pay = y - c[1], paz = pz - az;
    const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
    const e = (hypot(pax - bax * h, pay - bay * h, paz - baz * h) - mix(c[3], c[7], h)) * zs;
    const k = 0.45, hh = max(k - abs(d - e), 0) / k;
    d = min(d, e) - hh * hh * k * 0.25;
  }
  return d;
}
// monumental rock arch: a standing torus (ring in the xy plane), squashed tall, with lumpy weathered rock
const ARCH_R = 14, ARCH_T = 2.9, ARCH_SQ = 1.2;
const archSD = (x, y, z) => hypot(hypot(x, y / ARCH_SQ) - ARCH_R, z) - ARCH_T;

// ---------------------------------------------------------------- procedural meshes (load time)
function meshChunk(sd, sub = 2, det = sub > 2) {
  if (LV > 1 && sub > 1) sub--; // Low: a quarter of the triangles
  rseed(100 + sd);
  const pl = []; for (let i = 0; i < 4; i++) { const q = qRand(); pl.push([q[0], q[1], q[2], rr(0.8, 0.98)]); const l = hypot(q[0], q[1], q[2]) || 1; pl[i][0] /= l; pl[i][1] /= l; pl[i][2] /= l; }
  return icosphere(sub, (x, y, z) => {
    let r = 1 + (fbm(x * 1.6 + sd, y * 1.6, z * 1.6, 2) - 0.5) * 0.9 + (det ? (fbm(x * 4 + sd, y * 4, z * 4, 2) - 0.5) * 0.25 : 0);
    let px = x * r, py = y * r * 0.8, pz = z * r;
    for (const p of pl) { const d = px * p[0] + py * p[1] + pz * p[2] - p[3]; if (d > 0) { px -= p[0] * d; py -= p[1] * d; pz -= p[2] * d; } }
    return [px, py, pz];
  });
}
function meshLathe(prof, seg, lump, ribs = 0) {
  const m = new Mesh(), rings = [];
  for (const [r, h, ao] of prof) { const ring = []; for (let s = 0; s < seg; s++) { const a = s / seg * TAU, rl = r * (1 + lump * (fbm(cos(a) * 1.5 + h * 2, h * 3, sin(a) * 1.5, 2) - 0.5) + 0.07 * cos(ribs * a + h * 1.5)); ring.push(m.v(cos(a) * rl, h, sin(a) * rl, ao)); } rings.push(ring); }
  for (let k = 0; k < rings.length - 1; k++) for (let s = 0; s < seg; s++) { const s2 = (s + 1) % seg; m.quad(rings[k][s], rings[k + 1][s], rings[k + 1][s2], rings[k][s2]); }
  return m;
}
function meshCoral(fan, lo = LV > 1) {
  rseed(200 + fan);
  const m = new Mesh();
  const nrm = (v) => { const l = hypot(...v) || 1; return v.map((c) => c / l); };
  const br = (p, d, r, len, depth) => {
    const pts = [p]; let q = p;
    for (let i = 0; i < 3; i++) { d = nrm([d[0] + rr(-0.3, 0.3), d[1] + rr(-0.1, 0.3), d[2] + (fan ? rr(-0.05, 0.05) : rr(-0.3, 0.3))]); q = [q[0] + d[0] * len / 3, q[1] + d[1] * len / 3, q[2] + d[2] * len / 3]; pts.push(q); }
    if (!depth) pts.push([q[0] + d[0] * r * 1.6, q[1] + d[1] * r * 1.6, q[2] + d[2] * r * 1.6]);
    if (lo) m.tube(depth ? [pts[0], pts[3]] : [pts[0], pts[3], pts[4]], (k) => (k > 1 ? r * 0.36 : r * (1 - 0.22 * k)) * 1.25, 3, true, (k) => clamp(1 - (depth + 1 - k) / 5, 0, 1));
    else m.tube(pts, (k) => k > 3 ? r * 0.36 : r * (1 - 0.22 * k / 3), fan ? 5 : 6, true, (k) => clamp(1 - (depth + 1 - k / 3) / 5, 0, 1));
    if (depth > 0) { const n = 2 + (rnd() < 0.5); for (let i = 0; i < n; i++) br(q, nrm([d[0] + rr(-0.8, 0.8), d[1] + rr(-0.1, 0.5), d[2] + (fan ? rr(-0.08, 0.08) : rr(-0.8, 0.8))]), r * 0.78, len * 0.8, depth - 1); }
  };
  const n0 = fan ? 1 : 2 + (rnd() * 2 | 0);
  for (let i = 0; i < n0; i++) br([rr(-0.08, 0.08), 0, rr(-0.08, 0.08)], nrm([rr(-0.5, 0.5), 1, fan ? 0 : rr(-0.5, 0.5)]), fan ? 0.06 : 0.08, fan ? 0.5 : 0.45, 3);
  return m;
}
function meshTubes() {
  rseed(210);
  const m = new Mesh();
  for (let i = 0; i < 9; i++) {
    const a = rnd() * TAU, r0 = rr(0, 0.28), h = rr(0.45, 1.1), rad = rr(0.07, 0.12), lean = rr(0.05, 0.3), pts = [];
    for (let k = 0; k <= 4; k++) pts.push([cos(a) * (r0 + lean * k / 4 * h), h * k / 4, sin(a) * (r0 + lean * k / 4 * h)]);
    m.tube(pts, (k) => rad * (0.8 + 0.25 * k / 4), 12, false, (k) => 0.35 + 0.65 * k / 4);
    // rim + dark throat
    const e = pts[4], n = m.p.length / 3, c = m.v(e[0], e[1] - rad * 1.2, e[2], 0.05);
    for (let s2 = 0; s2 < 12; s2++) m.tri(n - 12 + s2, n - 12 + (s2 + 1) % 12, c);
  }
  return m;
}
// stone whale fluke: SDF of tapered capsules -> surface nets
function meshFluke() {
  const sdf = flukeSD;
  const vs = 0.09, ox = -7.6, oy = -2.6, oz = -2.2, nx = 186, ny = 216, nz = 76, D = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) D[x + nx * (y + ny * z)] = -sdf(ox + x * vs, oy + y * vs, oz + z * vs);
  const sn = surfaceNets(D, nx, ny, nz), smp = sampler3(D, nx, ny, nz);
  const vb = new ArrayBuffer(sn.nv * 16), f = new Float32Array(vb), s = new Int8Array(vb);
  for (let k = 0; k < sn.nv; k++) {
    const x = sn.pos[k * 3], y = sn.pos[k * 3 + 1], z = sn.pos[k * 3 + 2], e = 0.7;
    let ax = smp(x - e, y, z) - smp(x + e, y, z), ay = smp(x, y - e, z) - smp(x, y + e, z), az = smp(x, y, z - e) - smp(x, y, z + e);
    const l = hypot(ax, ay, az) || 1;
    f[k * 4] = ox + x * vs; f[k * 4 + 1] = oy + y * vs; f[k * 4 + 2] = oz + z * vs;
    s[k * 16 + 12] = round(ax / l * 127); s[k * 16 + 13] = round(ay / l * 127); s[k * 16 + 14] = round(az / l * 127); s[k * 16 + 15] = 127;
  }
  return { vb, ib: new Uint32Array(sn.idx), nv: sn.nv };
}
// sunken ship (bow at +x): keel with stem and stern posts, curved ribs, hull planking with a breach,
// raised stern castle with transom, deck remnants, two masts with yards, bowsprit
function meshShip() {
  rseed(220);
  const m = new Mesh(), Lh = 17, B = 5.6, Dp = 7.6;
  const hb = (x) => B * pow(max(1 - pow(abs(x / Lh), x < 0 ? 3.6 : 2.6), 0), 0.5);
  const dp = (x) => Dp * (1 - 0.36 * pow(abs(x / Lh), 2.5));
  const sheer = (x) => 0.5 + (x > 0 ? 3.0 : 3.8) * pow(abs(x / Lh), 2.2);
  const pt = (x, ph, off = 0) => { const b = hb(x) + off, d = dp(x) + off, s = sheer(x); return [x, s - (d + s) * pow(max(cos(ph), 0), 0.66), b * Math.sign(ph) * pow(abs(sin(ph)), 0.8)]; };
  const out = (p) => { const l = hypot(p[1] + 0.5, p[2] * 1.3) || 1; return [0, (p[1] + 0.5) / l, p[2] * 1.3 / l]; };
  const up = () => [0, 1, 0];
  const keel = [];
  for (let i = 0; i <= 44; i++) { const x = mix(-Lh - 1.0, Lh + 2.4, i / 44), e = max(abs(x) / Lh - 0.78, 0) * 4.2; keel.push([x, -dp(clamp(x, -Lh, Lh)) - 0.3 + e * e * e * 4.2, 0]); }
  m.sweep(keel, 0.55, 0.95, up);
  for (let x = -Lh + 0.7; x < Lh - 0.3; x += 0.8) {
    const a0 = rnd() < 0.1 ? rr(-0.9, -0.2) : -PI / 2, a1 = rnd() < 0.1 ? rr(0.2, 0.9) : PI / 2, pts = [];
    for (let i = 0; i <= 16; i++) pts.push(pt(x, mix(a0, a1, i / 16)));
    m.sweep(pts, 0.24, 0.3, out);
  }
  const holeX = rr(-6, 2), holeS = rnd() < 0.5 ? 1 : -1;
  const BR = [[holeX, holeS * 0.8, 3.2, 0.42], [7, -holeS * 0.95, 2.4, 0.34], [12, holeS * 0.5, 1.7, 0.28], [-11, -holeS * 0.55, 2.1, 0.3]];
  const holed = (x, ph) => { for (const h of BR) { const a = (x - h[0]) / h[2], b = (ph - h[1]) / h[3]; if (a * a + b * b < 1 + 0.45 * sin(x * 3.1 + ph * 9)) return true; } return false; };
  const NS = 14, xs = []; for (let x = -Lh + 0.35; x <= Lh - 0.3; x += 0.85) xs.push(x);
  for (let j = 0; j < NS; j++) {
    const p0 = mix(-1.5, 1.5, j / NS), p1 = mix(-1.5, 1.5, (j + 1) / NS), sg = p0 + p1 < 0 ? -1 : 1, lo = sg < 0 ? p1 : p0, hi = sg < 0 ? p0 : p1;
    let pv = null;
    for (const x of xs) {
      const cu = [m.v(...pt(x, lo, 0.27)), m.v(...pt(x, hi, 0.14)), m.v(...pt(x, lo, 0.1)), m.v(...pt(x, hi, 0.1))];
      if (pv && !holed(x - 0.42, (p0 + p1) / 2)) {
        if (sg > 0) { m.quad(pv[0], pv[1], cu[1], cu[0]); m.quad(pv[2], cu[2], cu[3], pv[3]); }
        else { m.quad(pv[0], cu[0], cu[1], pv[1]); m.quad(pv[2], pv[3], cu[3], cu[2]); }
      }
      pv = cu;
    }
  }
  for (const sgn of [-1, 1]) {
    let pts = []; for (let x = -Lh + 0.6; x <= Lh - 0.6; x += 1) pts.push(pt(x, sgn * PI / 2, 0.2)); m.sweep(pts, 0.3, 0.28, up);
    // stern castle bulwarks
    for (let j = 0; j < 3; j++) { pts = []; for (let x = -Lh + 0.4; x <= -Lh + 8.5 - j; x += 0.9) pts.push([x, sheer(x) + 0.55 + j * 0.86, sgn * (max(hb(x), 2.6) + 0.15)]); m.sweep(pts, 0.82, 0.09, () => [0, 0, sgn]); }
  }
  // transom
  for (let y = -3; y < sheer(-Lh) + 3; y += 0.86) { const w = max(1.2, 2.9 * sstep(-4.5, 1.5, y)); if (rnd() < 0.9) m.sweep([[-Lh + 0.35, y, -w], [-Lh + 0.35, y, w]], 0.82, 0.1, () => [1, 0, 0]); }
  for (let x = -Lh + 2; x < Lh - 2; x += rr(1.8, 3.2)) m.sweep([[x, sheer(x) - 0.25, -hb(x)], [x, sheer(x) - 0.2, 0], [x, sheer(x) - 0.25, hb(x)]], 0.26, 0.26, up);
  for (let z = -3.9; z <= 3.9; z += 0.62) { let x = -Lh + rr(1, 5); while (x < Lh - 4) { const x1 = min(x + rr(3, 9), Lh - 3.5); if (rnd() < 0.6) { const pts = []; for (let xx = x; xx <= x1; xx += 1) if (hb(xx) > abs(z) + 0.3) pts.push([xx, sheer(xx) - 0.05, z]); if (pts.length > 1) m.sweep(pts, 0.56, 0.07, up); } x = x1 + rr(0.5, 3); } }
  // foremast with yard, broken main mast, bowsprit
  m.sweep([[7, -Dp + 0.6, 0], [7.1, 1, 0], [7.4, 8, 0.3], [7.8, 15, 0.8]], (k) => 0.62 - k * 0.1, (k) => 0.62 - k * 0.1, () => [1, 0, 0]);
  m.sweep([[7.5, 9.5, -5.2], [7.5, 9.6, 0.3], [7.5, 9.2, 5.6]], 0.26, 0.26, up);
  m.sweep([[7.7, 13.2, -3.2], [7.7, 13.3, 3.6]], 0.2, 0.2, up);
  m.sweep([[-3, -Dp + 0.6, 0], [-3.2, 1, 0.2], [-3.9, 6, 1.0], [-5.2, 9.5, 2.6]], (k) => 0.74 - k * 0.1, (k) => 0.74 - k * 0.1, () => [1, 0, 0]);
  m.sweep([[Lh + 1.4, 2.6, 0], [Lh + 8, 5.2, 0.2]], 0.34, 0.34, up);
  return m;
}
// manta ray: span along x (half span = 1), nose +z; aux = span coordinate for the flap animation
function meshManta() {
  const m = new Mesh(), NU = 72, M = 22, rings = [];
  for (let j = 0; j <= NU; j++) {
    const u = j / NU * 2 - 1, au = abs(u);
    let zl = 0.52 - 0.74 * pow(au, 1.35) + 0.07 * exp(-pow((au - 0.13) / 0.05, 2)) - 0.05 * exp(-pow(au / 0.05, 2)) - 0.08 * pow(au, 5);
    const zt = -0.5 + 0.3 * pow(au, 0.8) + 0.02 - 0.08 * pow(au, 5);
    if (zl < zt + 0.004) zl = zt + 0.004;
    const th = 0.08 * pow(1 - au, 1.15) + 0.004 + 0.12 * exp(-pow(u / 0.2, 2)), ring = [];
    for (let k = 0; k < M; k++) { const a = k / M * TAU; ring.push(m.v(u, th * sin(a) * (0.62 + 0.38 * cos(a)), mix(zt, zl, 0.5 + 0.5 * cos(a)), u)); }
    rings.push(ring);
  }
  for (let j = 0; j < NU; j++) for (let k = 0; k < M; k++) { const k2 = (k + 1) % M; m.quad(rings[j][k], rings[j + 1][k], rings[j + 1][k2], rings[j][k2]); }
  const tail = []; for (let i = 0; i <= 8; i++) tail.push([0, 0, -0.42 - i * 0.19]);
  const n0 = m.p.length / 3;
  m.tube(tail, (k) => 0.016 * (1 - k / 9), 4, true);
  for (let k = n0; k < m.aux.length; k++) m.aux[k] = 0;
  for (const sx of [-1, 1]) { // cephalic fins
    const n1 = m.p.length / 3;
    m.tube([[sx * 0.12, -0.02, 0.48], [sx * 0.135, -0.05, 0.6], [sx * 0.115, -0.09, 0.69], [sx * 0.085, -0.125, 0.74]], (k) => 0.045 * (1 - k / 4.4), 6, true);
    for (let k = n1; k < m.aux.length; k++) m.aux[k] = sx * 0.1;
  }
  return m;
}
function meshFish() {
  const m = new Mesh();
  const X = [0.5, 0.3, 0.05, -0.22, -0.34], H = [0.01, 0.13, 0.17, 0.09, 0.035], Wd = [0.01, 0.05, 0.065, 0.03, 0.012], rings = [];
  for (let i = 0; i < 5; i++) { const r = []; for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; r.push(m.v(X[i], sin(a) * H[i], cos(a) * Wd[i])); } rings.push(r); }
  for (let i = 0; i < 4; i++) for (let k = 0; k < 6; k++) { const k2 = (k + 1) % 6; m.quad(rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2]); }
  const a = m.v(-0.33, 0, 0), b = m.v(-0.56, 0.2, 0), c = m.v(-0.47, 0, 0), d = m.v(-0.56, -0.2, 0);
  m.tri(a, b, c); m.tri(a, c, d);
  return m;
}

// weathered rock for the arch: the torus pushed in and out by 3D noise, with faint horizontal strata
const archField = (x, y, z) => archSD(x, y, z) + (fbm(x * 0.17 + 3.1, y * 0.17, z * 0.17, 3) - 0.5) * 2.4 + (fbm(x * 0.55, y * 0.55 + 9, z * 0.55, 2) - 0.5) * 0.7
  + 0.3 * (abs(fract(y * 0.21 + fbm(x * 0.05, y * 0.05, z * 0.05, 2) * 2.2) - 0.5) - 0.25);
function meshArch() {
  const vs = LV > 1 ? 0.55 : 0.38, ex = ARCH_R + ARCH_T + 1.8, ey = (ARCH_R + ARCH_T) * ARCH_SQ + 1.8, ez = ARCH_T + 2;
  const nx = ceil(2 * ex / vs) + 1, ny = ceil(2 * ey / vs) + 1, nz = ceil(2 * ez / vs) + 1, D = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const edge = x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1;
    D[x + nx * (y + ny * z)] = edge ? -1 : -archField(-ex + x * vs, -ey + y * vs, -ez + z * vs);
  }
  const sn = surfaceNets(D, nx, ny, nz), smp = sampler3(D, nx, ny, nz);
  const vb = new ArrayBuffer(sn.nv * 16), f = new Float32Array(vb), s = new Int8Array(vb);
  for (let k = 0; k < sn.nv; k++) {
    const x = sn.pos[k * 3], y = sn.pos[k * 3 + 1], z = sn.pos[k * 3 + 2], e = 0.8;
    const ax = smp(x - e, y, z) - smp(x + e, y, z), ay = smp(x, y - e, z) - smp(x, y + e, z), az = smp(x, y, z - e) - smp(x, y, z + e), l = hypot(ax, ay, az) || 1;
    f[k * 4] = -ex + x * vs; f[k * 4 + 1] = -ey + y * vs; f[k * 4 + 2] = -ez + z * vs;
    s[k * 16 + 12] = round(ax / l * 127); s[k * 16 + 13] = round(ay / l * 127); s[k * 16 + 14] = round(az / l * 127); s[k * 16 + 15] = 127;
  }
  return { vb, ib: new Uint32Array(sn.idx), nv: sn.nv };
}

// ---------------------------------------------------------------- landmarks (deterministic per 512 m macro cell)
// mesh ids (see main.js): 16 fluke, 17 ship, 20 arch, 29 ruins, 30 skeleton; materials: 1 rock, 2 pale stone, 3 ship wood, 9 bone
// kinds: 1 sunken ship, 2 stone whale tail, 3 monumental arch, 10 temple ruins, 11 leviathan skeleton
const MACRO = 384, LMC = new Map();
const LM_NAMES = { 1: 'sunken ship', 2: 'stone whale tail', 3: 'rock arch', 4: 'natural bridge', 5: 'giant mushrooms', 6: 'small arch', 7: 'crystal spires', 8: 'vent chimneys', 9: 'coral bommie', 10: 'temple ruins', 11: 'leviathan skeleton', 12: 'table coral', 13: 'your model' };
function landmark(cx, cz) {
  const key = cx * 65536 + cz;
  let L = LMC.get(key);
  if (L) return L;
  if (LMC.size > 2000) LMC.clear();
  L = { k: 0, x: 0, y: 0, z: 0, q: [0, 0, 0, 1], sc: 1, rad: 0, mesh: 0, mat: 1, seed: hash2(cx, cz, 106), yaw: 0 };
  LMC.set(key, L);
  // kept inside the middle 60 % of the cell, so two set pieces are always >= 150 m apart and never overlap
  const x = (cx + 0.2 + 0.6 * hash2(cx, cz, 102)) * MACRO, z = (cz + 0.2 + 0.6 * hash2(cx, cz, 103)) * MACRO;
  // every kind equally likely in every biome (and an empty cell one time in six)
  const W = [1, 1, 1, 1, 1, 1];
  let sum = 0; for (const v of W) sum += v;
  let r = hash2(cx, cz, 101) * sum, pick = 0; while (pick < 5 && r >= W[pick]) { r -= W[pick]; pick++; }
  const yaw = hash2(cx, cz, 104) * TAU, s2 = hash2(cx, cz, 105), dx = cos(yaw), dz = -sin(yaw); // local +x after the yaw
  L.x = x; L.z = z; L.yaw = yaw;
  if (pick === 1) { // sunken ship: rests on the average of the ground under its keel, listing to one side
    let sum = 0, lo = 1e9;
    for (let t = -16; t <= 16; t += 8) { const h = hAt(x + dx * t, z + dz * t); sum += h; lo = min(lo, h); }
    L.k = 1; L.mesh = 17; L.mat = 3; L.y = (sum / 5) * 0.5 + lo * 0.5 + 6.3; L.rad = 27;
    L.q = qMul(qAxis(0, 1, 0, yaw), qMul(qAxis(0, 0, 1, -0.08), qAxis(1, 0, 0, 0.3)));
  } else if (pick === 2) { // stone whale fluke rising from the seabed
    L.k = 2; L.mesh = 16; L.mat = 2; L.sc = 0.95 + 0.5 * s2; L.y = hAt(x, z) - 0.6 * L.sc; L.rad = 17 * L.sc;
    L.q = qMul(qAxis(0, 1, 0, yaw), qMul(qAxis(0, 0, 1, 0.16), qAxis(1, 0, 0, -0.3)));
  } else if (pick === 3) { // monumental arch: both legs sunk into the lower of the two footings
    L.k = 3; L.mesh = 20; L.mat = 1; L.sc = 0.85 + 0.6 * s2;
    const R = ARCH_R * L.sc, hl = min(hAt(x + dx * R, z + dz * R), hAt(x - dx * R, z - dz * R), hAt(x, z));
    L.y = hl + ARCH_R * ARCH_SQ * L.sc * 0.42; L.rad = (ARCH_R + ARCH_T) * ARCH_SQ * L.sc + 3;
    L.q = qAxis(0, 1, 0, yaw);
  } else if (pick === 4) { // temple ruins: the platform settles on the average ground, its low side half buried
    L.k = 10; L.mesh = 29; L.mat = 2; L.sc = 0.9 + 0.4 * s2;
    let sum = 0; for (let t = -1; t <= 1; t++) for (let u = -1; u <= 1; u++) sum += hAt(x + 11 * L.sc * t, z + 8 * L.sc * u);
    L.y = sum / 9 - 0.6 * L.sc; L.rad = 17 * L.sc; L.q = qAxis(0, 1, 0, yaw);
  } else if (pick === 5) { // leviathan skeleton half sunk in the silt
    L.k = 11; L.mesh = 30; L.mat = 9; L.sc = 0.8 + 0.5 * s2;
    let sum = 0; for (let t = -20; t <= 20; t += 10) sum += hAt(x + dx * t * L.sc, z + dz * t * L.sc);
    L.y = sum / 5 - 0.7 * L.sc; L.rad = 28 * L.sc; L.q = qAxis(0, 1, 0, yaw);
  }
  return L;
}
// the landmarks and minor features within draw distance this frame: instance records for the GPU grouped by mesh
// (LMRUN: mesh, first instance, count per run), and the ones near enough to collide (NEARLM)
const MAXLM = 256, LMV = new Array(MAXLM), LMD = new Float32Array(MAXLM * 16), NEARLM = new Array(16), LMTMP = new Array(MAXLM), LMRUN = new Int32Array(48 * 3), LMCNT = new Int32Array(48);
let nLM = 0, nNear = 0, nRun = 0, nTmp = 0;
function addLM(L, cx, cy, cz, R) {
  if (!L.k || nTmp >= MAXLM) return;
  const dh = hypot(L.x - cx, L.z - cz);
  if (dh > R + L.rad) return;
  LMTMP[nTmp++] = L;
  if (nNear < 16 && L.k !== 12 && hypot(dh, L.y - cy) < L.rad + 4) NEARLM[nNear++] = L;
}
function updateLandmarks() {
  const cx = F[CX], cy = F[CY], cz = F[CZ], R = TQ.fogFar + 30, R2 = min(TQ.fogFar, 420) + 20;
  nTmp = 0; nNear = 0;
  let x0 = floor((cx - R) / MACRO), x1 = floor((cx + R) / MACRO), z0 = floor((cz - R) / MACRO), z1 = floor((cz + R) / MACRO);
  for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) addLM(landmark(gx, gz), cx, cy, cz, R);
  x0 = floor((cx - R2) / MINOR); x1 = floor((cx + R2) / MINOR); z0 = floor((cz - R2) / MINOR); z1 = floor((cz + R2) / MINOR);
  for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) { const A = minorFeatures(gx, gz); for (let i = 0; i < A.length; i++) addLM(A[i], cx, cy, cz, R2); }
  netAvatars(); // other divers (LAN multiplayer)
  // counting sort by mesh id, so each mesh is one instanced draw
  LMCNT.fill(0);
  for (let i = 0; i < nTmp; i++) if (LMTMP[i].mesh >= 0) LMCNT[LMTMP[i].mesh]++;
  nRun = 0; let o = 0;
  for (let m = 0; m < 48; m++) if (LMCNT[m]) { LMRUN[nRun * 3] = m; LMRUN[nRun * 3 + 1] = o; LMRUN[nRun * 3 + 2] = LMCNT[m]; LMCNT[m] = o; o += LMRUN[nRun * 3 + 2]; nRun++; }
  for (let i = 0; i < nTmp; i++) {
    const L = LMTMP[i];
    if (L.mesh < 0) continue; // imported structures: drawn by the textured model pipeline
    const j = LMCNT[L.mesh]++, b = j * 16;
    LMD[b] = L.x - cx; LMD[b + 1] = L.y; LMD[b + 2] = L.z - cz; LMD[b + 3] = L.sc;
    LMD[b + 4] = L.q[0]; LMD[b + 5] = L.q[1]; LMD[b + 6] = L.q[2]; LMD[b + 7] = L.q[3];
    LMD[b + 8] = L.mat; LMD[b + 9] = L.seed; LMD[b + 10] = 1; LMD[b + 11] = 0;
    LMD[b + 12] = 0; LMD[b + 13] = 1; LMD[b + 14] = 0; LMD[b + 15] = 0;
    LMV[j] = L;
  }
  nLM = o;
}

// ---------------------------------------------------------------- collision: seabed h(x, z) + landmark SDFs
// distance > 0 in water. The camera is a sphere of radius CR; collide() (main.js) slides it along the gradient.
const V3 = new Float64Array(3), GR = new Float64Array(3);
// v rotated by the quaternion (qx, qy, qz, qw), into V3
function qrotInto(qx, qy, qz, qw, vx, vy, vz) {
  const cx = qy * vz - qz * vy + qw * vx, cy = qz * vx - qx * vz + qw * vy, cz = qx * vy - qy * vx + qw * vz;
  V3[0] = vx + 2 * (qy * cz - qz * cy); V3[1] = vy + 2 * (qz * cx - qx * cz); V3[2] = vz + 2 * (qx * cy - qy * cx);
}
function sdLM(L, x, y, z) {
  qrotInto(-L.q[0], -L.q[1], -L.q[2], L.q[3], x - L.x, y - L.y, z - L.z);
  const s = L.sc, px = V3[0] / s, py = V3[1] / s, pz = V3[2] / s;
  let d;
  if (L.k === 1) { const e = (hypot(px / 18.5, (py + 1.8) / 6.2, pz / 5.9) - 1) * 5.4; d = e < -1.6 ? 99 : e; } // hull: a solid shell, open inside
  else if (L.k === 2) d = flukeSD(px, py, pz);
  else if (L.k === 4) d = bridgeField(px, py, pz) * 0.8;
  else if (L.k === 5) d = mushSD(px, py, pz);
  else if (L.k === 7) d = crystalSD(px, py, pz);
  else if (L.k === 8) d = chimneySD(px, py, pz);
  else if (L.k === 9) d = bommieSD(px, py, pz);
  else if (L.k === 10) d = ruinsSD(px, py, pz);
  else if (L.k === 11) d = skelSD(px, py, pz);
  else if (L.k === 13) { const hb = CUSTOM[L.cm].hb; d = sdBox(px, py - hb[1], pz, hb[0], hb[1], hb[2]) * 0.9; }
  else d = archField(px, py, pz) * 0.8;
  return d * s;
}
// Moving colliders: capsules (ax ay az bx by bz r, Float64 world) for everything that swims near the camera.
// [0, nDynMov) are the imported movers, gathered while their instances are written (main.js ciPut); the rest are added
// each frame before the collision step: the leviathans' bodies along their swim path and the other divers.
const MAXDYN = 96, DYN = new Float64Array(MAXDYN * 7);
let nDyn = 0, nDynMov = 0;
function dynAdd(ax, ay, az, bx, by, bz, r) {
  if (nDyn >= MAXDYN) return;
  const o = nDyn++ * 7; DYN[o] = ax; DYN[o + 1] = ay; DYN[o + 2] = az; DYN[o + 3] = bx; DYN[o + 4] = by; DYN[o + 5] = bz; DYN[o + 6] = r;
}
// a leviathan's body: 8 capsules following its swim path back from the head (the same path as leviathanHeads / vsLev)
function levColliders() {
  const cx = F[CX], cy = F[CY], cz = F[CZ];
  for (let i = 0; i < NLEV; i++) {
    const o = i * 8, R = LB.lev[o + 3], w = LB.lev[o + 5], len = LB.lev[o + 6], sg = w < 0 ? -1 : 1, a0 = F[TIME] * w + LB.lev[o + 4];
    if (hypot(LEV[i * 4] - cx, LEV[i * 4 + 2] - cz) > R + len + 20) continue;
    let px = 0, py = 0, pz = 0;
    for (let k = 0; k <= 8; k++) {
      const a = a0 - sg * (k / 8) * len / R;
      const x = LEV[i * 4] + R * cos(a), y = LEV[i * 4 + 1] + 5 * sin(0.45 * a + LB.lev[o + 7]), z = LEV[i * 4 + 2] + R * 0.85 * sin(a);
      if (k) dynAdd(px, py, pz, x, y, z, len * (0.045 - 0.025 * k / 8));
      px = x; py = y; pz = z;
    }
  }
}
function sdScene(x, y, z) {
  const e = 0.35, h0 = hAt(x, z), hx = (hAt(x + e, z) - h0) / e, hz = (hAt(x, z + e) - h0) / e, il = 1 / sqrt(1 + hx * hx + hz * hz);
  let d = (y - h0) * il;
  GR[0] = -hx * il; GR[1] = il; GR[2] = -hz * il;
  for (let i = 0; i < nNear; i++) {
    const L = NEARLM[i], dl = sdLM(L, x, y, z);
    if (dl < d) {
      d = dl; const k = 0.15;
      const gx = sdLM(L, x + k, y, z) - sdLM(L, x - k, y, z), gy = sdLM(L, x, y + k, z) - sdLM(L, x, y - k, z), gz = sdLM(L, x, y, z + k) - sdLM(L, x, y, z - k), l = hypot(gx, gy, gz);
      if (l > 1e-6) { GR[0] = gx / l; GR[1] = gy / l; GR[2] = gz / l; }
    }
  }
  // moving capsules: the gradient points from the closest point on the segment
  for (let i = 0; i < nDyn; i++) {
    const o = i * 7, ax = DYN[o], ay = DYN[o + 1], az = DYN[o + 2], bax = DYN[o + 3] - ax, bay = DYN[o + 4] - ay, baz = DYN[o + 5] - az;
    const h = clamp(((x - ax) * bax + (y - ay) * bay + (z - az) * baz) / (bax * bax + bay * bay + baz * baz || 1), 0, 1);
    const vx = x - ax - bax * h, vy = y - ay - bay * h, vz = z - az - baz * h, l = hypot(vx, vy, vz), dc = l - DYN[o + 6];
    if (dc < d) { d = dc; if (l > 1e-6) { GR[0] = vx / l; GR[1] = vy / l; GR[2] = vz / l; } }
  }
  return d;
}

// ---------------------------------------------------------------- wildlife: recycled slots in a bubble around the swimmer
// SCH / MAN / JEL / TUR: x y z age per slot (Float64 world). WTD mirrors the WGSL struct WT: sch[16], man[8], vent[16],
// jel[8], tur[8], lev[4], sq[8] as vec4f,
// positions camera-relative in x / z: xyz + fade (schools, mantas) or xyz + bubble column height (vents).
const NSCH = TQ.schools, NMAN = TQ.mantas, MAXV = TQ.vents, NJEL = TQ.jel, NTUR = TQ.tur, NLEV = TQ.lev, NSQ = TQ.sqs;
const NCUS = 24, CUS = new Float64Array(NCUS * 4), CSM = new Int16Array(NCUS), CSK = new Uint8Array(NCUS);
// per class: behaviour kind for behave(), spawn lift above the seabed, orbit radius, size (m), instances per slot
const CK = [6, 4, 7, 8], CLO = [3, 22, 8, 0], CHI = [12, 38, 30, 0];
const CSP = new Float64Array(4); // slot params out: orbit radius, angular speed, phase, size
function cslot(s) {
  const k = CSK[s], h1 = hash2(s, 1, 601), h2 = hash2(s, 2, 602), sg = s & 1 ? -1 : 1;
  CSP[0] = k === 1 ? 40 + 30 * h1 : 5 + 6 * h1; CSP[1] = (k === 1 ? 0.05 + 0.03 * h2 : 0.25 + 0.2 * h2) * sg; CSP[2] = hash2(s, 4, 604) * TAU;
  CSP[3] = k === 1 ? 30 + 25 * hash2(s, 3, 603) : k === 2 ? 14 + 16 * hash2(s, 3, 603) : k === 3 ? 8 + 12 * hash2(s, 3, 603) : 0.9 + 2.2 * hash2(s, 3, 603);
}
const SCH = new Float64Array(NSCH * 4), MAN = new Float64Array(NMAN * 4), JEL = new Float64Array(NJEL * 4), TUR = new Float64Array(NTUR * 4), LEV = new Float64Array(NLEV * 4), SQ = new Float64Array(NSQ * 4), VNT = new Float64Array(MAXV * 6), WTD = new Float32Array(272);
const bubbleR = () => min(TQ.fogFar * 0.62, 230);
// pref: 0 open water, reefs and kelp edges (fish, mantas, squid), 1 grottos, canyons, crystals, vents (jellyfish),
// 2 kelp, plains, reefs (turtles), 3 open deep water: canyons, plains, vents (leviathans)
function spawnAnimal(A, i, ahead, lo, hi, pref = 0) {
  const R = bubbleR();
  for (let t = 0; t < 6; t++) {
    const a = ahead ? F[YAW] + rr(-1.25, 1.25) : rnd() * TAU, d = ahead ? rr(0.55, 0.92) * R : sqrt(rnd()) * R * 0.85;
    const x = F[CX] + sin(a) * d, z = F[CZ] - cos(a) * d;
    bioAt(x, z);
    const w = pref === 1 ? TB[2] + TB[3] + 0.7 * TB[6] + 0.6 * TB[7] : pref === 2 ? TB[1] + TB[4] + TB[5] : pref === 3 ? TB[3] + TB[4] + TB[7] + 0.5 * TB[6] : TB[4] + 0.5 * TB[1] + TB[5];
    if (t < 5 && rnd() > 0.3 + 0.7 * w) continue;
    A[i * 4] = x; A[i * 4 + 1] = min(hAt(x, z) + rr(lo, hi), -5); A[i * 4 + 2] = z; A[i * 4 + 3] = ahead ? 0 : 3;
    return;
  }
}
// k 6: imported creatures (positions go straight into the model instances, not WT: LIFEO -1)
const LIFE = [SCH, MAN, JEL, TUR, LEV, SQ, CUS], LIFEO = [0, 64, 160, 192, 224, 240, -1], LIFELO = [5, 12, 4, 4, 26, 6, 3], LIFEHI = [16, 26, 20, 14, 42, 18, 12], LIFEP = [0, 0, 1, 2, 3, 0, 0];
const LIFEN = [NSCH, NMAN, NJEL, NTUR, NLEV, NSQ, 0];
function initLife() {
  if (typeof BLIFT !== 'undefined') BLIFT.fill(NaN);
  for (let i = 0; i < NSCH; i++) spawnAnimal(SCH, i, false, 5, 16);
  for (let i = 0; i < NMAN; i++) spawnAnimal(MAN, i, false, 12, 26);
  for (let i = 0; i < NJEL; i++) spawnAnimal(JEL, i, false, 4, 20, 1);
  for (let i = 0; i < NTUR; i++) spawnAnimal(TUR, i, false, 4, 14, 2);
  for (let i = 0; i < NLEV; i++) spawnAnimal(LEV, i, false, 26, 42, 3);
  for (let i = 0; i < NSQ; i++) spawnAnimal(SQ, i, false, 6, 18, 0);
  for (let i = 0; i < LIFEN[6]; i++) { spawnAnimal(CUS, i, false, CLO[CSK[i]], CHI[CSK[i]], CSK[i] === 1 ? 3 : 0); if (CSK[i] === 3) CUS[i * 4 + 1] = 0; }
  VNT.fill(0);
}
function updateLife(dt) {
  const cx = F[CX], cz = F[CZ], R = bubbleR() * 1.12;
  CURA += dt * 0.01; nStalk = 0; nFlee = 0; nHunt = 0; nFollow = 0;
  leviathanHeads();
  for (let k = 0, g = 0; k < 7; k++) {
    const A = LIFE[k], n = LIFEN[k], o = LIFEO[k];
    for (let i = 0; i < n; i++, g++) {
      const ck = k === 6 ? CSK[i] : 0;
      if (hypot(A[i * 4] - cx, A[i * 4 + 2] - cz) > R) { if (k === 6) { spawnAnimal(A, i, true, CLO[ck], CHI[ck], ck === 1 ? 3 : 0); if (ck === 3) A[i * 4 + 1] = 0; } else spawnAnimal(A, i, true, LIFELO[k], LIFEHI[k], LIFEP[k]); BLIFT[g] = NaN; }
      if (dt > 0) behave(k === 6 ? CK[ck] : k, i, g, A, dt);
      A[i * 4 + 3] += dt;
      if (o < 0) continue;
      const f = A[i * 4 + 3] / 3, j = o + i * 4;
      WTD[j] = A[i * 4] - cx; WTD[j + 1] = A[i * 4 + 1]; WTD[j + 2] = A[i * 4 + 2] - cz; WTD[j + 3] = f > 1 ? 1 : f;
    }
  }
  // bubble vents: a 40 m cell hash, more of them in grottos and kelp; slots keep their vent while it stays in range
  const VC = 40, RV = min(TQ.fogFar * 0.4, 130);
  for (let i = 0; i < MAXV; i++) if (VNT[i * 6 + 5] && hypot(VNT[i * 6 + 2] - cx, VNT[i * 6 + 4] - cz) > RV + 15) VNT[i * 6 + 5] = 0;
  const x0 = floor((cx - RV) / VC), x1 = floor((cx + RV) / VC), z0 = floor((cz - RV) / VC), z1 = floor((cz + RV) / VC);
  for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
    if (hash2(gx, gz, 201) > 0.45) continue;
    let have = false, free = -1;
    for (let i = 0; i < MAXV; i++) { if (VNT[i * 6 + 5]) { if (VNT[i * 6] === gx && VNT[i * 6 + 1] === gz) { have = true; break; } } else if (free < 0) free = i; }
    if (have || free < 0) continue;
    const x = (gx + 0.2 + 0.6 * hash2(gx, gz, 203)) * VC, z = (gz + 0.2 + 0.6 * hash2(gx, gz, 204)) * VC;
    if (hypot(x - cx, z - cz) > RV) continue;
    bioAt(x, z);
    if (hash2(gx, gz, 202) > 0.25 + 0.6 * TB[2] + 0.3 * TB[1] + 0.9 * TB[7]) continue;
    const o = free * 6;
    VNT[o] = gx; VNT[o + 1] = gz; VNT[o + 2] = x; VNT[o + 3] = hAt(x, z); VNT[o + 4] = z; VNT[o + 5] = 1;
  }
  for (let i = 0; i < MAXV; i++) {
    const o = i * 6, j = 96 + i * 4, on = VNT[o + 5];
    WTD[j] = on ? VNT[o + 2] - cx : 0; WTD[j + 1] = on ? VNT[o + 3] : -50; WTD[j + 2] = on ? VNT[o + 4] - cz : 0; WTD[j + 3] = on ? -VNT[o + 3] - 0.2 : 0;
  }
}
// static per-instance data: fish (a: school slot, 0, 0, orbit radius; b: seed, angular speed, size, school seed),
// mantas (a: slot, 0, 0, orbit radius; b: phase, angular speed, size, flap phase), bubbles (a: vent slot, dx, dz,
// size; b: phase, rise speed, 0, wobble)
function lifeBuffers() {
  rseed(14);
  const fish = [], mantas = [], bub = [];
  for (let s = 0; s < NSCH; s++) {
    const R = rr(11, 25), dir = rnd() < 0.5 ? -1 : 1, sz = rr(0.28, 0.34), ss = rnd();
    for (let i = 0; i < TQ.fish; i++) fish.push(s, 0, 0, R, rnd(), dir * 1.9 / R, sz, ss);
  }
  for (let m = 0; m < NMAN; m++) mantas.push(m, 0, 0, rr(14, 40), rr(0, TAU), (rnd() < 0.5 ? -1 : 1) * rr(0.045, 0.085), rr(3.6, 5.6), rnd());
  for (let v = 0; v < MAXV; v++) for (let i = 0; i < TQ.bpv; i++) {
    const sz = rnd() < 0.24 ? rr(0.1, 0.3) : rr(0.025, 0.08);
    bub.push(v, rr(-0.3, 0.3), rr(-0.3, 0.3), sz, rnd(), rr(1.1, 2.4) * (0.6 + sz * 3), 0, rr(0.05, 0.16));
  }
  // jellyfish (a: swarm slot, offset x y z; b: seed, size, -, hue), turtles (a: slot, 0, 0, orbit radius; b: phase, angular speed, size, stroke phase)
  const jel = [], tur = [], lev = [], sq = [];
  for (let s = 0; s < NJEL; s++) for (let j = 0; j < TQ.jpn; j++) jel.push(s, rr(-14, 14), rr(-5, 5), rr(-14, 14), rnd(), rnd() < 0.08 ? rr(1.6, 2.4) : rr(0.45, 1.2), 0, rnd() < 0.5 ? 0 : 1);
  for (let t = 0; t < NTUR; t++) tur.push(t, 0, 0, rr(9, 24), rr(0, TAU), (rnd() < 0.5 ? -1 : 1) * rr(0.05, 0.09), rr(1.0, 1.6), rnd());
  // leviathans (a: slot, 0, 0, path radius; b: phase, angular speed, length in metres, wave phase); squid (a: swarm slot,
  // offset x y z; b: seed, size, -, hue)
  for (let t = 0; t < NLEV; t++) lev.push(t, 0, 0, rr(55, 85), rr(0, TAU), (rnd() < 0.5 ? -1 : 1) * rr(0.045, 0.07), rr(40, 60), rnd() * TAU);
  for (let s = 0; s < NSQ; s++) for (let j = 0; j < TQ.sqn; j++) sq.push(s, rr(-6, 6), rr(-2.5, 2.5), rr(-6, 6), rnd(), rr(0.6, 1.4), 0, rnd());
  const snow = new Float32Array(TQ.snow * 4);
  for (let i = 0; i < snow.length; i++) snow[i] = rnd();
  return { fish: new Float32Array(fish), mantas: new Float32Array(mantas), bub: new Float32Array(bub), snow, jel: new Float32Array(jel), tur: new Float32Array(tur), lev: new Float32Array(lev), sq: new Float32Array(sq) };
}

// ---------------------------------------------------------------- search: nearest biome / landmark (keys 1-7)
// biome: 0 kelp forest, 1 purple grotto, 2 trench canyons, 3 silt plain, 4 coral reef, 5 crystal fields, 6 volcanic vents. Returns [x, z] or null.
function findBiome(b, fromX, fromZ, skip = 250) {
  for (let r = skip; r < 12000; r += 64) {
    const n = max(8, ceil(TAU * r / 64)), a0 = hash2(r | 0, b, 301) * TAU;
    for (let i = 0; i < n; i++) {
      const a = a0 + i / n * TAU, x = fromX + cos(a) * r, z = fromZ + sin(a) * r;
      bioAt(x, z);
      const w = TB[b + 1];
      if (w > 0.9) return [x, z];
    }
  }
  return null;
}
function findLandmark(kind, fromX, fromZ) {
  const c0 = floor(fromX / MACRO), c1 = floor(fromZ / MACRO);
  let best = null, bd = 1e18;
  for (let r = 0; r < 40 && !best; r++) for (let gz = c1 - r; gz <= c1 + r; gz++) for (let gx = c0 - r; gx <= c0 + r; gx++) {
    if (max(abs(gx - c0), abs(gz - c1)) !== r) continue;
    const L = landmark(gx, gz);
    if (L.k !== kind) continue;
    const d = hypot(L.x - fromX, L.z - fromZ);
    if (d > 60 && d < bd) { bd = d; best = L; }
  }
  return best;
}

// ---------------------------------------------------------------- more meshes: corals, fungi, natural bridges, turtles, jellyfish
// append mesh `src` into `dst`, positions through f, with one aux value for all of it (or src's own)
function addMesh(dst, src, f, aux) {
  const o = dst.p.length / 3;
  for (let k = 0; k < src.p.length; k += 3) { const q = f(src.p[k], src.p[k + 1], src.p[k + 2]); dst.v(q[0], q[1], q[2], aux === undefined ? src.aux[k / 3] : aux); }
  for (const i of src.i) dst.i.push(i + o);
}
// table coral: a wide wavy plate on a short stem
function meshTableCoral() {
  rseed(230);
  return meshLathe([[0, 0, 0.3], [0.13, 0, 0.4], [0.1, 0.3, 0.5], [0.13, 0.5, 0.6], [0.55, 0.58, 0.8], [0.95, 0.63, 0.95], [1.02, 0.68, 1], [0.96, 0.73, 1], [0.5, 0.71, 0.9], [0, 0.7, 0.8]], LV > 1 ? 14 : 22, 0.35, 7);
}
// brain coral: a low dome with meandering grooves
function meshBrainCoral() {
  rseed(231);
  return icosphere(LV > 1 ? 2 : 3, (x, y, z) => {
    const g = 1 + 0.07 * sin(18 * (x + 0.6 * fbm(x * 2, y * 2 + 5, z * 2, 2)) + 9 * z), yy = y < -0.1 ? -0.1 + (y + 0.1) * 0.2 : y;
    return [x * g, (yy * 0.62 + 0.06) * g, z * g];
  });
}
// mushroom: flared stalk, cap with gills underneath (aux .1) and a domed top (aux 1); unit height ~2.5
function meshMushroom() {
  return meshLathe([[0, 0, 0.4], [0.34, 0, 0.5], [0.22, 0.15, 0.6], [0.17, 0.6, 0.7], [0.16, 1.3, 0.8], [0.19, 1.75, 0.85], [0.32, 1.82, 0.1], [0.75, 1.9, 0.1], [1.0, 1.96, 0.2],
    [1.03, 2.03, 1], [0.86, 2.26, 1], [0.5, 2.42, 1], [0, 2.48, 1]], LV > 1 ? 12 : 20, 0.12, 5);
}
// natural bridge: a thick rock span on an arc between two pillars, weathered like the arches
const BR_L = 17, BR_H = 30; // span half-length, pillar depth below the deck
function bridgeSD(x, y, z) {
  const u = clamp(x / BR_L, -1, 1), ay = 3 * (1 - u * u), t = 2.3 + 0.9 * u * u;
  let d = hypot(x - u * BR_L, (y - ay) / 1.15, z / 1.3) - t;
  for (let sx = -1; sx <= 1; sx += 2) {
    const px = x - sx * (BR_L + 1.5), h = clamp(-y / BR_H, 0, 1), e = hypot(px + sx * h * 1.2, z) - (3.2 + 1.6 * h) + (y > 1 ? y - 1 : y < -BR_H ? -BR_H - y : 0);
    const k = 3, hh = max(k - abs(d - e), 0) / k; d = min(d, e) - hh * hh * k * 0.25;
  }
  return d;
}
const bridgeField = (x, y, z) => bridgeSD(x, y, z) + (fbm(x * 0.17 + 7.1, y * 0.17, z * 0.17, 3) - 0.5) * 2.2 + (fbm(x * 0.55 + 3, y * 0.55, z * 0.55, 2) - 0.5) * 0.6
  + 0.3 * (abs(fract(y * 0.21 + fbm(x * 0.05, y * 0.05, z * 0.05, 2) * 2.2) - 0.5) - 0.25);
function meshBridge() {
  const vs = LV > 1 ? 0.6 : 0.42, x0 = -(BR_L + 8), y0 = -BR_H - 3, z0 = -7, nx = ceil(2 * (BR_L + 8) / vs) + 1, ny = ceil((BR_H + 12) / vs) + 1, nz = ceil(14 / vs) + 1;
  const D = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const edge = x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1;
    D[x + nx * (y + ny * z)] = edge ? -1 : -bridgeField(x0 + x * vs, y0 + y * vs, z0 + z * vs);
  }
  const sn = surfaceNets(D, nx, ny, nz), smp = sampler3(D, nx, ny, nz);
  const vb = new ArrayBuffer(sn.nv * 16), f = new Float32Array(vb), s = new Int8Array(vb);
  for (let k = 0; k < sn.nv; k++) {
    const x = sn.pos[k * 3], y = sn.pos[k * 3 + 1], z = sn.pos[k * 3 + 2], e = 0.8;
    const ax = smp(x - e, y, z) - smp(x + e, y, z), ay = smp(x, y - e, z) - smp(x, y + e, z), az = smp(x, y, z - e) - smp(x, y, z + e), l = hypot(ax, ay, az) || 1;
    f[k * 4] = x0 + x * vs; f[k * 4 + 1] = y0 + y * vs; f[k * 4 + 2] = z0 + z * vs;
    s[k * 16 + 12] = round(ax / l * 127); s[k * 16 + 13] = round(ay / l * 127); s[k * 16 + 14] = round(az / l * 127); s[k * 16 + 15] = 127;
  }
  return { vb, ib: new Uint32Array(sn.idx), nv: sn.nv };
}
// sea turtle, nose +z, ~1.3 m long at scale 1. aux: shell 1, head .9, front flippers +-.6, back flippers +-.3
function meshTurtle() {
  const m = new Mesh();
  addMesh(m, icosphere(LV > 1 ? 1 : 2), (x, y, z) => [x * 0.44, y > 0 ? y * 0.24 * (1 - 0.15 * z * z) : y * 0.1, z * 0.56 - 0.03 * z * z], 1);
  addMesh(m, icosphere(1), (x, y, z) => [x * 0.11, y * 0.085 + 0.015, z * 0.16 + 0.63], 0.9);
  for (const [sx, front] of [[-1, 1], [1, 1], [-1, 0], [1, 0]]) {
    const n0 = m.p.length / 3, z0 = front ? 0.28 : -0.4, len = front ? 0.66 : 0.3;
    m.tube([[sx * 0.3, -0.02, z0], [sx * (0.3 + len * 0.55), -0.05, z0 - len * 0.22], [sx * (0.3 + len), -0.06, z0 - len * 0.55]], (k) => (front ? 0.1 : 0.075) * (1 - k * 0.3), 6, true, () => sx * (front ? 0.6 : 0.3));
    for (let k = n0 * 3 + 1; k < m.p.length; k += 3) m.p[k] = (m.p[k] + 0.04) * 0.32 - 0.04; // flatten into paddles
  }
  return m;
}
// jellyfish: a ribbed bell (aux 1) with trailing tentacles and frilly oral arms (aux = minus the position along them)
// another player's diver (LAN multiplayer, material 10): head first along -z, about 1.9 m from mask to fins
function meshDiver() {
  const m = new Mesh();
  addMesh(m, icosphere(2), (x, y, z) => [x * 0.21, y * 0.15, z * 0.42], 0.1); // torso
  addMesh(m, icosphere(1), (x, y, z) => [x * 0.12, y * 0.13 + 0.06, z * 0.13 - 0.55], 0.1); // head
  addMesh(m, icosphere(1), (x, y, z) => [x * 0.05, y * 0.05 + 0.13, z * 0.03 - 0.67], 1); // lamp
  m.tube([[0, 0.2, -0.32], [0, 0.22, 0.22]], () => 0.085, 8, true, () => 0.5); // tank
  for (const sx of [-1, 1]) {
    m.tube([[sx * 0.18, 0.02, -0.3], [sx * 0.2, -0.04, -0.62], [sx * 0.14, -0.06, -0.86]], (k) => 0.055 * (1 - k * 0.3), 6, true, () => 0.75); // arms
    m.tube([[sx * 0.1, -0.02, 0.35], [sx * 0.12, -0.03, 0.72], [sx * 0.13, -0.02, 1.02]], (k) => 0.075 * (1 - k * 0.35), 6, true, () => 0.1); // legs
    addMesh(m, icosphere(1), (x, y, z) => [sx * 0.13 + x * 0.09, y * 0.015 - 0.02, z * 0.2 + 1.2], 0.75); // fins
  }
  return m;
}
// ---------------------------------------------------------------- 4 x 4 matrices (column-major) and skeletal poses
function mat4Mul(a, b, o = new Array(16)) { for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
function mat4AffInv(m) {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1;
  const r = [A / det, (c * h - b * i) / det, (b * f - c * e) / det, 0, B / det, (a * i - c * g) / det, (c * d - a * f) / det, 0, C / det, (b * g - a * h) / det, (a * e - b * d) / det, 0, 0, 0, 0, 1];
  r[12] = -(r[0] * m[12] + r[4] * m[13] + r[8] * m[14]); r[13] = -(r[1] * m[12] + r[5] * m[13] + r[9] * m[14]); r[14] = -(r[2] * m[12] + r[6] * m[13] + r[10] * m[14]);
  return r;
}
// one channel at time t into L (10 floats per node: translation, rotation quaternion, scale)
function sampleCh(c, t, L) {
  const T = c.t, n = T.length, nc = c.path === 'rotation' ? 4 : 3, o = c.node * 10 + (c.path === 'translation' ? 0 : c.path === 'rotation' ? 3 : 7), V = c.v, cs = c.mode === 2 ? 3 : 1;
  let k = c.k < n - 1 && T[c.k] <= t ? c.k : 0;
  while (k < n - 2 && T[k + 1] <= t) k++;
  c.k = k;
  const t0 = T[k], t1 = T[min(k + 1, n - 1)], u = c.mode === 1 || t1 <= t0 ? (t >= t1 ? 1 : 0) : clamp((t - t0) / (t1 - t0), 0, 1);
  const a = (k * cs + (cs === 3 ? 1 : 0)) * nc, b = (min(k + 1, n - 1) * cs + (cs === 3 ? 1 : 0)) * nc;
  if (nc === 4) {
    let dot = 0; for (let i = 0; i < 4; i++) dot += V[a + i] * V[b + i];
    const sg = dot < 0 ? -1 : 1; let l = 0;
    for (let i = 0; i < 4; i++) { const q = V[a + i] + (V[b + i] * sg - V[a + i]) * u; L[o + i] = q; l += q * q; }
    l = 1 / (sqrt(l) || 1); for (let i = 0; i < 4; i++) L[o + i] *= l;
  } else for (let i = 0; i < 3; i++) L[o + i] = V[a + i] + (V[b + i] - V[a + i]) * u;
}
// joint matrices of animation ai at time t (looped) into out from index o (16 floats each, nJ joints, then the
// identity of the static slot). Matrices map normalised model space to normalised model space.
function skinPose(S, ai, t, out, o) {
  const nN = S.nodes.length;
  if (!S.L) {
    S.L = new Float64Array(nN * 10); S.Wm = new Float64Array(nN * 16); S.tmp = new Array(16); S.tmp2 = new Array(16); S.loc = new Array(16);
    // parents before children
    S.order = []; const seen = new Uint8Array(nN);
    const add = (i) => { if (seen[i]) return; seen[i] = 1; if (S.nodes[i].parent >= 0) add(S.nodes[i].parent); S.order.push(i); };
    for (let i = 0; i < nN; i++) add(i);
  }
  const L = S.L, A = S.anims[ai];
  for (let i = 0; i < nN; i++) { const nd = S.nodes[i], b = i * 10; L[b] = nd.t[0]; L[b + 1] = nd.t[1]; L[b + 2] = nd.t[2]; L[b + 3] = nd.r[0]; L[b + 4] = nd.r[1]; L[b + 5] = nd.r[2]; L[b + 6] = nd.r[3]; L[b + 7] = nd.s[0]; L[b + 8] = nd.s[1]; L[b + 9] = nd.s[2]; }
  if (A) { if (!A.set) A.set = new Set(A.ch.map((c) => c.node)); const tt = ((t % A.dur) + A.dur) % A.dur; for (const c of A.ch) if (c.node < nN) sampleCh(c, tt, L); }
  const M = S.loc, Wm = S.Wm;
  for (const i of S.order) {
    const nd = S.nodes[i], b = i * 10;
    if (nd.m && !(A && A.set.has(i))) for (let k = 0; k < 16; k++) M[k] = nd.m[k];
    else {
      const x = L[b + 3], y = L[b + 4], z = L[b + 5], w = L[b + 6], sx = L[b + 7], sy = L[b + 8], sz = L[b + 9];
      M[0] = (1 - 2 * (y * y + z * z)) * sx; M[1] = 2 * (x * y + z * w) * sx; M[2] = 2 * (x * z - y * w) * sx; M[3] = 0;
      M[4] = 2 * (x * y - z * w) * sy; M[5] = (1 - 2 * (x * x + z * z)) * sy; M[6] = 2 * (y * z + x * w) * sy; M[7] = 0;
      M[8] = 2 * (x * z + y * w) * sz; M[9] = 2 * (y * z - x * w) * sz; M[10] = (1 - 2 * (x * x + y * y)) * sz; M[11] = 0;
      M[12] = L[b]; M[13] = L[b + 1]; M[14] = L[b + 2]; M[15] = 1;
    }
    const p = nd.parent;
    if (p >= 0) { for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += Wm[p * 16 + k * 4 + r] * M[c * 4 + k]; Wm[i * 16 + c * 4 + r] = s; } }
    else for (let k = 0; k < 16; k++) Wm[i * 16 + k] = M[k];
  }
  const T1 = S.tmp, T2 = S.tmp2, JW = S.JW || (S.JW = new Array(16)), IB = S.IB || (S.IB = new Array(16));
  for (let j = 0; j < S.nJ; j++) {
    const ni = S.joints[j];
    for (let k = 0; k < 16; k++) { JW[k] = Wm[ni * 16 + k]; IB[k] = S.ibm[j * 16 + k]; }
    mat4Mul(JW, IB, T1); mat4Mul(S.N, T1, T2); mat4Mul(T2, S.Ni, T1);
    for (let k = 0; k < 16; k++) out[o + j * 16 + k] = T1[k];
  }
  for (let k = 0; k < 16; k++) out[o + S.nJ * 16 + k] = k % 5 === 0 ? 1 : 0;
}
function meshJelly() {
  rseed(240);
  const m = new Mesh(), NA = 12, NR = LV > 1 ? 12 : 18, rings = [];
  for (let j = 0; j <= NA; j++) {
    const a = j / NA * 1.75, ring = [];
    for (let k = 0; k < NR; k++) { const b = k / NR * TAU, r = 0.5 * sin(a) * (1 + 0.06 * cos(8 * b)), h = 0.32 * cos(a) - (a > 1.4 ? (a - 1.4) * 0.25 : 0); ring.push(m.v(cos(b) * r, h, sin(b) * r, 1)); }
    rings.push(ring);
  }
  for (let j = 0; j < NA; j++) for (let k = 0; k < NR; k++) { const k2 = (k + 1) % NR; m.quad(rings[j][k], rings[j + 1][k], rings[j + 1][k2], rings[j][k2]); }
  const NT = LV > 1 ? 6 : 10;
  for (let k = 0; k < NT; k++) { const b = k / NT * TAU, L = rr(1.2, 2.4), pts = []; for (let s = 0; s <= 8; s++) pts.push([cos(b) * 0.44, 0.04 - s / 8 * L, sin(b) * 0.44]); m.tube(pts, () => 0.014, 3, false, (s) => -s / 8); }
  for (let k = 0; k < 4; k++) { const b = k / 4 * TAU + 0.4, pts = []; for (let s = 0; s <= 6; s++) pts.push([cos(b) * 0.06 * (1 + s * 0.4), 0.1 - s * 0.15, sin(b) * 0.06 * (1 + s * 0.4)]); m.tube(pts, (s) => 0.05 * (1 - s / 8), 5, true, (s) => -(s / 6) * 0.95 - 0.02); }
  return m;
}

// ---------------------------------------------------------------- minor features (deterministic per 128 m cell)
// natural bridges across canyons, smaller arches in canyons and kelp, clusters of giant glowing mushrooms in the grottos.
// They join the landmark list: drawn by the CPU (grouped per mesh) and collidable through sdLM.
// kinds: 4 bridge (mesh 24), 5 giant mushroom (23, material 6), 6 small arch (20), 7 crystal spire (27, material 7),
// 8 vent chimney (28, material 8), 9 coral bommie (22) with 12 table corals around it (21, no collision)
const MINOR = 128, MNC = new Map(), NONE = [];
function minorFeatures(cx, cz) {
  const key = cx * 65536 + cz;
  let A = MNC.get(key);
  if (A) return A;
  if (MNC.size > 4000) MNC.clear();
  A = NONE;
  const x = (cx + 0.2 + 0.6 * hash2(cx, cz, 402)) * MINOR, z = (cz + 0.2 + 0.6 * hash2(cx, cz, 403)) * MINOR;
  // keep clear of the macro cell's set piece
  const B = landmark(floor(x / MACRO), floor(z / MACRO));
  if (!(B.k && hypot(B.x - x, B.z - z) < B.rad + 40)) {
    bioAt(x, z);
    const kp = TB[1], gr = TB[2], tr = TB[3], pl = TB[4], rf = TB[5], cr = TB[6], vo = TB[7], r = hash2(cx, cz, 401), yaw = hash2(cx, cz, 404) * TAU, s2 = hash2(cx, cz, 405);
    // any structure in any biome: 6 kinds equally likely, 3 cells in 4 hold one
    const pB = 0.125, pA = 0.25, pM = 0.375, pC = 0.5, pV = 0.625, pR = 0.75;
    const mk = (k, mesh, mat, px, pz, sc, rad, y, q) => ({ k, x: px, y, z: pz, q, sc, rad, mesh, mat, seed: hash2(cx, cz, 406 + k), yaw });
    // a loose ring of n pieces around the cell point: f(i, px, pz, a) builds piece i
    const ring = (n, spread, f) => { const out = []; for (let i = 0; i < n; i++) { const a = yaw + i * 2.4, d = i ? spread * (0.5 + 0.5 * hash2(cx + i, cz, 408)) : 0; out.push(f(i, x + cos(a) * d, z + sin(a) * d, a)); } return out; };
    const hs = (i, s) => hash2(cx + i * 7, cz - i * 3, s);
    if (r < pB) { // natural bridge across a canyon: the deck just above the higher footing, the pillars reach 30 m down
      const sc = 0.8 + 0.5 * s2, dx = cos(yaw), dz = -sin(yaw), R = (BR_L + 1.5) * sc;
      const hi = max(hAt(x + dx * R, z + dz * R), hAt(x - dx * R, z - dz * R), hAt(x, z));
      A = [mk(4, 24, 1, x, z, sc, (BR_L + 6) * sc, min(hi + 3 * sc, -8), qAxis(0, 1, 0, yaw))];
    } else if (r < pA) { // a smaller arch
      const sc = 0.32 + 0.3 * s2, dx = cos(yaw), dz = -sin(yaw), R = ARCH_R * sc;
      const lo = min(hAt(x + dx * R, z + dz * R), hAt(x - dx * R, z - dz * R), hAt(x, z));
      A = [mk(6, 20, 1, x, z, sc, (ARCH_R + ARCH_T) * ARCH_SQ * sc + 2, lo + ARCH_R * ARCH_SQ * sc * 0.42, qAxis(0, 1, 0, yaw))];
    } else if (r < pM) { // giant glowing mushrooms, 1-4 in a loose ring
      const seed = hash2(cx, cz, 411);
      A = ring(1 + (hash2(cx, cz, 407) * 4 | 0), 11, (i, px, pz, a) => { const sc = (i ? 2.2 : 3.4) + 2.6 * hs(i, 409), L = mk(5, 23, 6, px, pz, sc, 2.6 * sc, hAt(px, pz) - 0.3 * sc, qMul(qAxis(0, 1, 0, a), qAxis(1, 0, 0, 0.12 * (hs(i, 410) - 0.5)))); L.seed = seed; return L; });
    } else if (r < pC) { // crystal spires, 1-5, leaning out of the rock
      const seed = hash2(cx, cz, 412);
      A = ring(1 + (hash2(cx, cz, 413) * 5 | 0), 9, (i, px, pz, a) => { const sc = (i ? 2.4 : 4.6) + 3 * hs(i, 414), L = mk(7, 27, 7, px, pz, sc, 2.5 * sc, hAt(px, pz) - 0.3 * sc, qMul(qAxis(0, 1, 0, a), qAxis(1, 0, 0, (i ? 0.35 : 0.1) * (hs(i, 415) - 0.3)))); L.seed = fract(seed + 0.07 * i); return L; });
    } else if (r < pV) { // hydrothermal chimneys, 1-4
      A = ring(1 + (hash2(cx, cz, 416) * 4 | 0), 8, (i, px, pz, a) => { const sc = (i ? 1.8 : 3.2) + 1.6 * hs(i, 417); return mk(8, 28, 8, px, pz, sc, 3.6 * sc, hAt(px, pz) - 0.25 * sc, qAxis(0, 1, 0, a)); });
    } else if (r >= pR && r < pR + 0.12 && STRUCTS.length) { // one of your own structure models (menu: Models)
      const ci = STRUCTS[hash2(cx, cz, 421) * STRUCTS.length | 0], sc = 8 + 10 * s2, hb = CUSTOM[ci].hb;
      const dx = cos(yaw), dz = -sin(yaw), ex = hb[0] * sc, ez = hb[2] * sc;
      // the average ground under its footprint (the lowest point would bury a long model on a slope)
      const lo = (hAt(x, z) + hAt(x + dx * ex, z + dz * ex) + hAt(x - dx * ex, z - dz * ex) + hAt(x - dz * ez, z + dx * ez) + hAt(x + dz * ez, z - dx * ez)) / 5;
      const L = mk(13, -1, 2, x, z, sc, hypot(hb[0], hb[1] * 2, hb[2]) * sc + 2, lo - 0.04 * sc, qAxis(0, 1, 0, yaw)); L.cm = ci;
      A = [L];
    } else if (r < pR) { // coral bommie: a huge brain coral ringed by table corals
      const seed = hash2(cx, cz, 418);
      A = ring(3 + (hash2(cx, cz, 419) * 3 | 0), 7, (i, px, pz, a) => { const sc = i ? 2 + 1.5 * hs(i, 420) : 3 + 2.5 * hs(i, 420), L = i ? mk(12, 21, 5, px, pz, sc, 1.2 * sc, hAt(px, pz) - 0.2, qAxis(0, 1, 0, a)) : mk(9, 22, 5, px, pz, sc, 1.1 * sc, hAt(px, pz) - 0.25 * sc, qAxis(0, 1, 0, a)); L.seed = fract(seed + 0.11 * i); return L; });
    }
  }
  MNC.set(key, A);
  return A;
}
// mushroom (unit scale): stalk capsule + cap ellipsoid
const mushSD = (x, y, z) => min(hypot(x, y < 0 ? y : y > 1.8 ? y - 1.8 : 0, z) - 0.2, (hypot(x / 1.02, (y - 2.15) / 0.36, z / 1.02) - 1) * 0.36);

// nearest minor feature of a kind (4 bridge, 5 giant mushroom), spiralling out over 128 m cells
function findMinor(kind, fromX, fromZ) {
  const c0 = floor(fromX / MINOR), c1 = floor(fromZ / MINOR);
  for (let r = 0; r < 80; r++) {
    let best = null, bd = 1e18;
    for (let gz = c1 - r; gz <= c1 + r; gz++) for (let gx = c0 - r; gx <= c0 + r; gx++) {
      if (max(abs(gx - c0), abs(gz - c1)) !== r) continue;
      const A = minorFeatures(gx, gz);
      for (let i = 0; i < A.length; i++) { const L = A[i], d = hypot(L.x - fromX, L.z - fromZ); if (L.k === kind && d > 40 && d < bd) { bd = d; best = L; } }
    }
    if (best) return best;
  }
  return null;
}

// ---------------------------------------------------------------- crystals, vent chimneys, ruins, leviathan skeleton
// crystal cluster: 5-8 hexagonal prisms with pointed tips fanning out of one base; aux 0 at the base .. 1 at the tip
function meshCrystal() {
  rseed(260);
  const m = new Mesh(), n = 5 + (rnd() * 4 | 0);
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU, tilt = i ? rr(0.15, 0.75) : rr(0, 0.1), L = i ? rr(0.6, 1.5) : rr(1.6, 2.2), r = i ? rr(0.08, 0.17) : rr(0.18, 0.24);
    const dx = sin(tilt) * cos(a), dy = cos(tilt), dz = sin(tilt) * sin(a), b = [dx * 0.1, -0.1, dz * 0.1];
    const t = [b[0] + dx * L, b[1] + dy * L, b[2] + dz * L], tip = [t[0] + dx * r * 2.2, t[1] + dy * r * 2.2, t[2] + dz * r * 2.2];
    m.tube([b, t, tip], (k) => (k < 2 ? r : 0.001), 6, false, (k) => k === 0 ? 0 : k === 1 ? 0.75 : 1);
  }
  return m;
}
// hydrothermal chimney: a lumpy tapering stack with a flared lip and a glowing throat (aux .05-.1); unit height ~3.4
function meshChimney() {
  rseed(261);
  return meshLathe([[0, 0, 0.2], [0.95, 0, 0.3], [0.72, 0.4, 0.4], [0.52, 1.2, 0.5], [0.44, 2.2, 0.6], [0.38, 3.0, 0.7], [0.5, 3.3, 0.8], [0.4, 3.46, 0.9], [0.24, 3.32, 0.1], [0, 3.0, 0.05]], LV > 1 ? 10 : 16, 0.4, 3);
}
// sunken temple ruins: a three-step platform, two rows of columns (some broken, one fallen), lintels on the intact
// pairs. RUIN_PARTS keeps the solid pieces for collision: [0, cx, cy, cz, hx, hy, hz] boxes, [1, ax, ay, az, bx, by, bz, r] capsules
const RUIN_PARTS = [];
function meshRuins() {
  rseed(250);
  const m = new Mesh(), up = () => [0, 1, 0];
  for (let s = 0; s < 3; s++) {
    const w = 26 - s * 4, dd = 18 - s * 3, y = s * 0.9 + 0.45;
    m.sweep([[-w / 2, y, 0], [w / 2, y, 0]], dd, 0.9, up);
    RUIN_PARTS.push([0, 0, y, 0, w / 2, 0.45, dd / 2]);
  }
  const top = 2.7, cols = [];
  for (const z of [-5, 5]) for (let x = -9; x <= 9; x += 3.6) {
    const broken = rnd() < 0.35, H = broken ? rr(1.4, 4.2) : 7.2, lean = broken ? rr(-0.15, 0.15) : 0;
    m.sweep([[x - 0.9, top + 0.25, z], [x + 0.9, top + 0.25, z]], 1.8, 0.5, up);
    const pts = []; for (let k = 0; k <= 6; k++) pts.push([x + lean * k / 6 * H, top + 0.5 + k / 6 * H, z]);
    m.tube(pts, (k) => 0.62 * (1 - 0.06 * k / 6) * (1 + 0.04 * cos(k * 3)), 12, broken, () => 1);
    RUIN_PARTS.push([1, x, top, z, x + lean * H, top + 0.5 + H, z, 0.7]);
    if (!broken) m.sweep([[x - 0.85, top + 0.75 + H, z], [x + 0.85, top + 0.75 + H, z]], 1.7, 0.5, up);
    cols.push([x, z, broken, H]);
  }
  for (let i = 0; i + 1 < cols.length; i++) {
    const a = cols[i], b = cols[i + 1];
    if (a[1] === b[1] && !a[2] && !b[2]) m.sweep([[a[0] - 0.6, top + 1.25 + a[3], a[1]], [b[0] + 0.6, top + 1.25 + a[3], a[1]]], 1.4, 0.75, up);
  }
  // a fallen column lying across the steps, and a broken gateway at the front
  m.tube([[-6, 1.4, 9.5], [1.5, 0.9, 11.5]], 0.6, 12, true, () => 1);
  RUIN_PARTS.push([1, -6, 1.4, 9.5, 1.5, 0.9, 11.5, 0.62]);
  for (const x of [-2.4, 2.4]) { m.sweep([[x, 0, -9.8], [x, 5.5 + (x > 0 ? -1.8 : 0), -9.8]], 1.3, 1.3, () => [1, 0, 0]); RUIN_PARTS.push([1, x, 0, -9.8, x, 5.5, -9.8, 0.75]); }
  m.sweep([[-3.3, 6.0, -9.8], [0.6, 5.8, -9.8]], 1.1, 0.8, up);
  return m;
}
// leviathan skeleton lying on the seabed: a vertebral column with knobbed vertebrae, a cage of ribs and a long skull.
// SKEL_SPINE: capsule chain (x y z r) for collision; the ribs are left open to swim through
const SKEL_SPINE = [];
function meshSkeleton() {
  rseed(270);
  const m = new Mesh(), N = 48, sp = [];
  for (let k = 0; k <= N; k++) { const t = k / N; sp.push([(t - 0.5) * 46, 0.8 + 2.6 * sin(t * PI) * (1 - 0.4 * t), 4.5 * sin(t * 2.3 - 0.4)]); }
  m.tube(sp, (k) => { const t = k / N; return (1.05 - 0.75 * t) * (1 + 0.28 * max(0, sin(k * PI * 0.999))); }, 10, true, () => 1);
  for (let k = 0; k <= N; k += 6) SKEL_SPINE.push([...sp[k], 1.1 - 0.7 * k / N]);
  // ribs over the front 60 %: arcs that rise from the spine and curl back over the top
  for (let k = 3; k < N * 0.62; k += 2) {
    const t = k / N, R = 3.2 + 2.6 * sin(t * PI * 1.3), p0 = sp[k];
    for (const side of [-1, 1]) {
      const pts = [];
      for (let u = 0; u <= 8; u++) { const a = u / 8 * PI * 0.86; pts.push([p0[0] - 0.4 * u / 8, p0[1] + R * 0.85 * (1 - cos(a)), p0[2] + side * R * sin(a)]); }
      m.tube(pts, (u) => 0.2 * (1 - 0.5 * u / 8), 5, true, () => 1);
    }
  }
  // skull: a long cranium, eye ridges and an open lower jaw, at the front end (-x)
  const h = sp[0];
  addMesh(m, icosphere(2), (x, y, z) => [h[0] - 3.6 + x * 4.2, h[1] + 0.6 + y * 1.5 * (x > 0 ? 1 : 0.8), h[2] + z * 1.9 * (1 - 0.35 * max(-x, 0))], 1);
  m.tube([[h[0] - 0.6, h[1] - 0.6, h[2] - 1.2], [h[0] - 4.5, h[1] - 1.6, h[2] - 1.0], [h[0] - 7.6, h[1] - 1.9, h[2] - 0.4]], (k) => 0.45 - k * 0.12, 6, true, () => 1);
  m.tube([[h[0] - 0.6, h[1] - 0.6, h[2] + 1.2], [h[0] - 4.5, h[1] - 1.6, h[2] + 1.0], [h[0] - 7.6, h[1] - 1.9, h[2] + 0.4]], (k) => 0.45 - k * 0.12, 6, true, () => 1);
  SKEL_SPINE.push([h[0] - 3.4, h[1] + 0.6, h[2], 1.9]);
  return m;
}
const sdBox = (px, py, pz, hx, hy, hz) => { const qx = abs(px) - hx, qy = abs(py) - hy, qz = abs(pz) - hz; return hypot(max(qx, 0), max(qy, 0), max(qz, 0)) + min(max(qx, max(qy, qz)), 0); };
const sdSeg = (px, py, pz, ax, ay, az, bx, by, bz, r) => { const bax = bx - ax, bay = by - ay, baz = bz - az, pax = px - ax, pay = py - ay, paz = pz - az, h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz || 1), 0, 1); return hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r; };
function ruinsSD(x, y, z) {
  let d = 1e9;
  for (const p of RUIN_PARTS) d = min(d, p[0] ? sdSeg(x, y, z, p[1], p[2], p[3], p[4], p[5], p[6], p[7]) : sdBox(x - p[1], y - p[2], z - p[3], p[4], p[5], p[6]));
  return d;
}
function skelSD(x, y, z) {
  let d = 1e9;
  for (let i = 0; i + 1 < SKEL_SPINE.length - 1; i++) { const a = SKEL_SPINE[i], b = SKEL_SPINE[i + 1]; d = min(d, sdSeg(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2], (a[3] + b[3]) * 0.5)); }
  const s = SKEL_SPINE[SKEL_SPINE.length - 1];
  return min(d, (hypot((x - s[0]) / 4.2, (y - s[1]) / 1.5, (z - s[2]) / 1.9) - 1) * 1.5);
}
// unit crystal / chimney / bommie collision shapes
const crystalSD = (x, y, z) => sdSeg(x, y, z, 0, -0.1, 0, 0, 2.2, 0, 0.35);
const chimneySD = (x, y, z) => sdSeg(x, y, z, 0, 0, 0, 0, 3.3, 0, 0.5 + 0.35 * max(0, 1 - y / 1.2));
const bommieSD = (x, y, z) => (hypot(x, (y - 0.06) / 0.62, z) - 1) * 0.62;

// ---------------------------------------------------------------- living leviathan and squid
// leviathan: a long serpentine body along -z, length 1 (scaled to 40-60 m in the shader), head at z = 0. aux = u, the
// position along the body (0 head .. 1 tail); the vertex shader lays each cross-section on the swim path at u.
function meshLeviathan() {
  const m = new Mesh(), N = LV > 1 ? 40 : 76, S = LV > 1 ? 8 : 12, rings = [];
  const rad = (u) => u < 0.07 ? 0.016 + 0.5 * u : 0.051 * (1 - 0.86 * pow(max(0, (u - 0.18) / 0.82), 1.25)) + 0.004;
  for (let k = 0; k <= N; k++) {
    const u = k / N, r = rad(u), ring = [];
    for (let s = 0; s < S; s++) { const a = s / S * TAU; ring.push(m.v(cos(a) * r, sin(a) * r * 0.82, -u, u)); }
    rings.push(ring);
  }
  for (let k = 0; k < N; k++) for (let s = 0; s < S; s++) { const s2 = (s + 1) % S; m.quad(rings[k][s], rings[k][s2], rings[k + 1][s2], rings[k + 1][s]); }
  const nose = m.v(0, 0, 0.012, 0), tail = m.v(0, 0, -1.01, 1);
  for (let s = 0; s < S; s++) { m.tri(rings[0][(s + 1) % S], rings[0][s], nose); m.tri(rings[N][s], rings[N][(s + 1) % S], tail); }
  // lower jaw, slightly open
  for (let k = 0; k < 6; k++) {
    const u0 = 0.004 + k * 0.012, u1 = u0 + 0.012, w0 = 0.02 - k * 0.002, w1 = w0 - 0.002;
    const a = m.v(-w0, -0.024 - k * 0.002, -u0, u0), b = m.v(w0, -0.024 - k * 0.002, -u0, u0), c = m.v(w1, -0.026 - k * 0.002, -u1, u1), d = m.v(-w1, -0.026 - k * 0.002, -u1, u1);
    m.quad(a, b, c, d);
  }
  // a dorsal crest of spines and two pairs of long pectoral fins (thin, double sided)
  for (let k = 0; k < 26; k++) {
    const u = 0.08 + k * 0.028, r = rad(u), h = 0.03 * (1 - k / 30) + 0.008;
    const a = m.v(0, r * 0.8, -u, u), b = m.v(0, r * 0.8 + h, -u - 0.012, u), c = m.v(0, r * 0.8, -u - 0.022, u + 0.022);
    m.tri(a, b, c);
  }
  for (const [u, L] of [[0.12, 0.11], [0.42, 0.07]]) for (const sx of [-1, 1]) {
    const r = rad(u), a = m.v(sx * r * 0.9, -r * 0.3, -u, u), b = m.v(sx * (r + L), -r * 0.7, -u - L * 0.6, u), c = m.v(sx * (r + L * 0.55), -r * 0.6, -u - L * 0.95, u), d = m.v(sx * r * 0.9, -r * 0.3, -u - L * 0.5, u + L * 0.5);
    m.quad(a, b, c, d);
  }
  // tail fluke: a tall vertical blade
  const t0 = m.v(0, 0.004, -0.96, 0.96), t1 = m.v(0, 0.06, -1.05, 1), t2 = m.v(0, 0.004, -1.02, 1), t3 = m.v(0, -0.05, -1.05, 1);
  m.tri(t0, t1, t2); m.tri(t0, t2, t3);
  return m;
}
// squid: a torpedo mantle along +y with two side fins (aux 1), eight arms and two long tentacles trailing toward -y
// (aux = minus the position along them)
function meshSquid() {
  rseed(280);
  const m = meshLathe([[0, -0.04, 1], [0.1, 0.0, 1], [0.15, 0.25, 1], [0.15, 0.6, 1], [0.11, 0.85, 1], [0.05, 0.97, 1], [0, 1.02, 1]], LV > 1 ? 8 : 12, 0.04, 0);
  for (const sx of [-1, 1]) { const a = m.v(sx * 0.1, 0.72, 0, 1), b = m.v(sx * 0.3, 0.86, 0, 1), c = m.v(sx * 0.05, 1.0, 0, 1); m.tri(a, b, c); }
  for (let k = 0; k < 10; k++) {
    const a = k / 10 * TAU, long = k >= 8, L = long ? rr(0.95, 1.2) : rr(0.45, 0.6), pts = [];
    for (let s = 0; s <= 6; s++) pts.push([cos(a) * 0.08 * (1 - 0.3 * s / 6), -0.02 - s / 6 * L, sin(a) * 0.08 * (1 - 0.3 * s / 6)]);
    m.tube(pts, (s) => (long ? 0.012 : 0.024) * (1 - 0.6 * s / 6), 4, true, (s) => -s / 6 * 0.98 - 0.01);
  }
  return m;
}

// ---------------------------------------------------------------- seed parity: world fingerprint
// FNV-1a over the seabed height (to the centimetre) at 24 fixed points and the set piece of 12 fixed cells. The CPU
// side of the world (heights, biomes, structures, collision) is Float64 JavaScript on every platform, so the same seed
// gives the same fingerprint on Windows, Android and in the browser: compare it to know two devices share one world.
function fingerprint() {
  let h = 0x811c9dc5;
  const add = (v) => { h = Math.imul(h ^ (v | 0), 16777619); };
  for (let i = 0; i < 24; i++) add(round(hAt((i % 6 - 2.5) * 1931.7, (floor(i / 6) - 1.5) * 2417.3) * 100));
  for (let i = 0; i < 12; i++) add(landmark(i * 3 - 17, 11 - i * 2).k);
  return (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// ---------------------------------------------------------------- creature behaviours (per slot, CPU)
// Every slot centre moves: a heading that wanders slowly, eased velocity, a height that keeps its lift above the seabed.
// On top of that, per kind:
//   fish schools: wander (individual fish also scatter from the diver, in the vertex shader)
//   mantas: curious; when the diver is within 70 m they glide over for ~20 s, then lose interest for ~45 s
//   jellyfish: drift with a slow, shared current
//   turtles: graze, wandering low over the seabed
//   leviathans: patrol; within 160 m one starts circling the diver for ~40 s, then moves off for ~35 s
//   squid: wander; a swarm darts away when the diver comes within 18 m
//   imported creatures: wander, shy of the diver within 9 m
// Interactions: prey (fish, turtles, squid, imported creatures) flee from a leviathan's head within 55 m; an idle
// leviathan hunts, steering its swim circle over the nearest fish school for ~30 s; idle mantas follow turtles.
const NSLOT = NSCH + NMAN + NJEL + NTUR + NLEV + NSQ + NCUS, BTGT = new Int16Array(NSLOT), BVEL = new Float64Array(NSLOT * 2), BHEAD = new Float64Array(NSLOT), BLIFT = new Float64Array(NSLOT).fill(NaN),
  BTMR = new Float64Array(NSLOT), BST = new Uint8Array(NSLOT), BSPD = [1.2, 0.9, 0.3, 0.7, 1.6, 1.0, 1.1, 2.2, 1.3];
let CURA = 0, nStalk = 0;
// what a hunting leviathan (slot g) is after: a fish school (BTGT >= 0) or an imported creature (-1 - slot)
const HT = new Float64Array(3);
function huntTarget(g) {
  const t = BTGT[g], A = t >= 0 ? SCH : CUS, o = (t >= 0 ? t : -1 - t) * 4;
  HT[0] = A[o]; HT[1] = A[o + 1]; HT[2] = A[o + 2]; return HT;
}
// game mode: in creative the diver is invisible to creatures (none stalks, flees from, approaches or scatters from you)
let CREATIVE = SAVE.mode === 'creative';
function behave(k, i, g, A, dt) {
  const o = i * 4, x = A[o], z = A[o + 2], dx = F[CX] - x, dz = F[CZ] - z, d = CREATIVE ? 1e9 : hypot(dx, dz) || 1;
  if (BLIFT[g] !== BLIFT[g]) { BLIFT[g] = A[o + 1] - hAt(x, z); BHEAD[g] = rnd() * TAU; BST[g] = 0; BTMR[g] = rr(5, 25); }
  BHEAD[g] += (rnd() - 0.5) * dt * (k >= 7 ? 0.2 : 0.7); BTMR[g] -= dt;
  let tx = cos(BHEAD[g]) * BSPD[k], tz = sin(BHEAD[g]) * BSPD[k];
  if (k === 2) { tx = cos(CURA) * 0.35; tz = sin(CURA) * 0.35; }
  else if (k === 1) {
    if (BST[g] === 0 && d < 70 && BTMR[g] <= 0) { BST[g] = 1; BTMR[g] = 20; }
    else if (BST[g] === 1 && BTMR[g] <= 0) { BST[g] = 0; BTMR[g] = 45; }
    if (BST[g] === 1) { const s = d > 14 ? 2.2 : 0; tx = dx / d * s; tz = dz / d * s; }
    else { // companions: an idle manta drifts along with the nearest turtle
      let bt = -1, bd = 60;
      for (let j = 0; j < NTUR; j++) { const e = hypot(TUR[j * 4] - x, TUR[j * 4 + 2] - z); if (e < bd) { bd = e; bt = j; } }
      if (bt >= 0 && bd > 8) { tx = (TUR[bt * 4] - x) / bd * 1.1; tz = (TUR[bt * 4 + 2] - z) / bd * 1.1; nFollow++; }
    }
  } else if (k === 4) {
    if (BST[g] === 0 && d < 160 && BTMR[g] <= 0) { BST[g] = 1; BTMR[g] = 40; }
    else if (BST[g] === 0 && BTMR[g] <= 0) { // hunt: steer its swim circle over the nearest fish school or imported creature
      let bs = 0, bd = 240, found = false;
      for (let j = 0; j < NSCH; j++) { const e = hypot(SCH[j * 4] - x, SCH[j * 4 + 2] - z); if (e < bd) { bd = e; bs = j; found = true; } }
      for (let j = 0; j < LIFEN[6]; j++) if (CSK[j] === 0) { const e = hypot(CUS[j * 4] - x, CUS[j * 4 + 2] - z); if (e < bd) { bd = e; bs = -1 - j; found = true; } }
      if (found) { BST[g] = 3; BTMR[g] = 30; BTGT[g] = bs; } else BTMR[g] = 10;
    }
    if (BST[g] === 3) {
      if (BTMR[g] <= 0) { BST[g] = 0; BTMR[g] = 25; }
      else { const P = huntTarget(g), ex = P[0] - x, ez = P[2] - z, ed = hypot(ex, ez) || 1; tx = ex / ed * 3.5; tz = ez / ed * 3.5; nHunt++; }
    }
    else if (BST[g] === 1 && BTMR[g] <= 0) { BST[g] = 2; BTMR[g] = 35; }
    else if (BST[g] === 2 && BTMR[g] <= 0) { BST[g] = 0; BTMR[g] = 20; }
    if (BST[g] === 1) { const s = d > 12 ? 4 : 0; tx = dx / d * s; tz = dz / d * s; nStalk++; }
    else if (BST[g] === 2) { tx = -dx / d * 4; tz = -dz / d * 4; }
  } else if (k === 6 && hash2(g, 0, 77) < 0.5) {
    // curious creatures (half of the imported ones): come over to look at the diver, hover close by
    if (d > 10 && d < 45) { tx = dx / d * 1.6; tz = dz / d * 1.6; } else if (d <= 10) { tx = -dx / d * 0.3; tz = -dz / d * 0.3; }
  } else if ((k === 5 && d < 18) || (k === 6 && d < 9)) { tx = -dx / d * 7; tz = -dz / d * 7; }
  // prey (fish schools, turtles, squid, imported creatures) flee from a leviathan head within 55 m
  if (k === 0 || k === 3 || k === 5 || k === 6) for (let j = 0; j < nLH; j++) {
    const ex = x - LHEAD[j * 3], ez = z - LHEAD[j * 3 + 2], ed = hypot(ex, ez);
    if (ed < 55) { const s = 2 + 6 * (1 - ed / 55); tx = ex / (ed || 1) * s; tz = ez / (ed || 1) * s; nFlee++; break; }
  }
  const e = min(1, dt * 0.8);
  BVEL[g * 2] += (tx - BVEL[g * 2]) * e; BVEL[g * 2 + 1] += (tz - BVEL[g * 2 + 1]) * e;
  A[o] += BVEL[g * 2] * dt; A[o + 2] += BVEL[g * 2 + 1] * dt;
  if (k === 8) { A[o + 1] = 0; return; } // boats stay on the surface
  const ty = min(hAt(A[o], A[o + 2]) + BLIFT[g], -5);
  A[o + 1] += (ty - A[o + 1]) * min(1, dt * 0.35);
}

// ---------------------------------------------------------------- imported models: formats, zips, textures
// Accepted: binary glTF (.glb), glTF with its .bin and images (.gltf, from a zip), binary FBX 7.x (.fbx), Wavefront
// (.obj, with .mtl materials and UVs), and a .zip holding any of these with their textures (zips inside zips too).
// Every parser returns one CPU format: P positions, N normals (zero where missing), UV, I indices, groups (one per
// material: first, count, color used with a texture, flat colour used without one, alpha cutout, material name, and the
// texture as embedded bytes or a file name to find in the zip). loadTextures() then finds and decodes the textures and
// finishModel() normalises the model (largest side 1, base on y = 0; movers turned to face +z along their longest side)
// and packs the vertex buffer: f32x3 position | snorm8x4 normal | f32x2 uv = 24 bytes.
// classes: s structure, p plant, c creature, l leviathan (creature), m submarine, b boat (vehicles)
const MODEL_CLASSES = { s: 'structure', p: 'plant', c: 'creature', l: 'leviathan', m: 'submarine', b: 'boat' };
const MOVERS = 'clmb'; // classes that swim / sail: forward along +z, longest side turned onto z
// texture maps that are not colour: never used as a base colour, and not kept from a zip
const NONCOLOR = /normal|rough|metal|spec|gloss|occlu|(^|[_\s.-])ao([_\s.-]|$)|opacity|alpha|emiss|illum|height|bump|displac|mask|transmis|cavity|curvature/i;
const IMGEXT = /\.(png|jpe?g|webp)$/i;
const baseName = (p) => String(p).replace(/\\/g, '/').split('/').pop().toLowerCase();

// zip (stored or deflate; entries that are zips are opened too). Returns Map(path -> { usize, get() -> Uint8Array })
async function openZip(buf, prefix = '', out = new Map(), depth = 0) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), td = new TextDecoder();
  let e = -1;
  for (let i = u8.length - 22; i >= max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('this zip could not be read');
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  for (let k = 0; k < n && dv.getUint32(p, true) === 0x02014b50; k++) {
    const meth = dv.getUint16(p + 10, true), csz = dv.getUint32(p + 20, true), usz = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nl)); p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    const ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), raw = u8.subarray(ds, ds + csz);
    const get = async () => meth === 0 ? raw : meth === 8 ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : null;
    if (/\.zip$/i.test(name) && depth < 3) { const inner = await get(); if (inner) await openZip(inner.slice().buffer, prefix + name + '/', out, depth + 1); continue; }
    out.set(prefix + name, { usize: usz, get });
  }
  return out;
}
// the model inside a zip (glb > gltf > fbx > obj, the largest of a kind; an extension-less OBJ is recognised by its
// text) and the files it needs: .bin / .mtl, and the colour textures
async function bundleFromZip(buf) {
  const ent = await openZip(buf), names = [...ent.keys()];
  const pick = (re) => names.filter((n) => re.test(n)).sort((a, b) => ent.get(b).usize - ent.get(a).usize)[0];
  let main = pick(/\.glb$/i) || pick(/\.gltf$/i) || pick(/\.fbx$/i) || pick(/\.obj$/i);
  if (!main) for (const n of names) {
    if (/\.[a-z0-9]{2,4}$/i.test(baseName(n))) continue;
    const head = new TextDecoder().decode((await ent.get(n).get()).subarray(0, 4096));
    if (/^\s*v\s+-?[\d.]/m.test(head)) { main = n; break; }
  }
  if (!main) throw new Error('no .glb, .gltf, .fbx or .obj model in this zip');
  const files = [];
  for (const n of names) if (n === main || /\.(bin|mtl)$/i.test(n) || (IMGEXT.test(n) && !NONCOLOR.test(baseName(n)))) files.push([n, (await ent.get(n).get()).slice().buffer]);
  return { main, files };
}
// look-ups in a bundle: exact file name, the same name with any image extension (a model may name .tif or .tga
// textures that were shipped as .png / .jpg), and the colour-texture candidates
function bundleResolver(files) {
  const byBase = new Map(), byStem = new Map(), byTileless = new Map(), color = [];
  const tileless = (stem) => stem.replace(/\.(1\d\d\d|<udim>|<uvtile>)$/i, '');
  for (const [p, b] of files) {
    const base = baseName(p), stem = base.replace(/\.[^.]+$/, '');
    if (!byBase.has(base)) byBase.set(base, { name: base, b });
    if (IMGEXT.test(base)) {
      if (!byStem.has(stem)) byStem.set(stem, { name: base, b });
      if (!byTileless.has(tileless(stem))) byTileless.set(tileless(stem), { name: base, b });
      if (!NONCOLOR.test(stem)) color.push({ name: base, stem, b });
    }
  }
  return {
    file: (name) => { const r = name && byBase.get(baseName(name)); return r ? r.b : null; },
    // exact name, the same name with another image extension, or (UDIM) another tile of the same texture
    image: (name) => {
      if (!name) return null;
      const base = baseName(name), stem = base.replace(/\.[^.]+$/, '');
      const r = (IMGEXT.test(base) && byBase.get(base)) || byStem.get(stem) || byTileless.get(tileless(stem));
      return r ? r.b : null;
    },
    color,
  };
}
// UDIM: a texture named *.1001.png covers UV tile 1001, *.1002.png the tile to its right, and so on; a group whose
// texture is a UDIM tile is split by the tile of each triangle (UVs here have v flipped: tile from 1 - v)
function udimSplit(m) {
  const out = [];
  for (const g of m.groups) {
    if (!m.flipV || !g.texName || !/\.(1\d\d\d|<udim>|<uvtile>)\.[a-z]+$/i.test(g.texName)) { out.push(g); continue; }
    const tiles = new Map();
    for (let t = g.first; t < g.first + g.count; t += 3) {
      let su = 0, sv = 0;
      for (let k = 0; k < 3; k++) { const v = m.I[t + k]; su += m.UV[v * 2]; sv += 1 - m.UV[v * 2 + 1]; }
      const tile = 1001 + floor(su / 3) + 10 * floor(sv / 3);
      if (!tiles.has(tile)) tiles.set(tile, []);
      tiles.get(tile).push(m.I[t], m.I[t + 1], m.I[t + 2]);
    }
    let at = g.first;
    for (const [tile, L] of tiles) { m.I.set(L, at); out.push({ ...g, first: at, count: L.length, texName: g.texName.replace(/\.(1\d\d\d|<udim>|<uvtile>)\.([a-z]+)$/i, `.${tile}.$2`) }); at += L.length; }
  }
  m.groups = out;
}
async function decodeTex(bytes, maxTex) {
  const png = bytes[0] === 0x89 && bytes[1] === 0x50, jpg = bytes[0] === 0xff && bytes[1] === 0xd8, webp = bytes[8] === 0x57 && bytes[9] === 0x45;
  if (!png && !jpg && !webp) return null;
  const blob = new Blob([bytes], { type: png ? 'image/png' : jpg ? 'image/jpeg' : 'image/webp' });
  // PNG size from its header, so big textures (8k UDIM tiles) are decoded straight to the target size
  const w = png ? (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0 : 0, h = png ? (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0 : 0;
  if (w && h && max(w, h) > maxTex) { const s = maxTex / max(w, h); return createImageBitmap(blob, { resizeWidth: max(1, round(w * s)), resizeHeight: max(1, round(h * s)), resizeQuality: 'high' }); }
  const b0 = await createImageBitmap(blob), s = min(1, maxTex / max(b0.width, b0.height));
  return s < 1 ? createImageBitmap(b0, { resizeWidth: max(1, round(b0.width * s)), resizeHeight: max(1, round(b0.height * s)), resizeQuality: 'high' }) : b0;
}
// find each group's texture: embedded bytes; the named file; a colour texture whose name contains the material's name;
// and, for a single-material model or a zip with a single colour texture, the most likely base colour in the zip.
// decode = false only reports what was found (g.src).
async function loadTextures(m, R, maxTex, decode = true) {
  udimSplit(m);
  const kw = /diffuse|albedo|base_?colou?r|basecolou?r|_col\b|_d\b/i;
  const best = R && R.color.length ? R.color.slice().sort((a, b) => (kw.test(b.stem) - kw.test(a.stem)) || b.b.length - a.b.length)[0] : null;
  const cache = new Map();
  const decodable = (b) => b && b.length > 12 && ((b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || (b[8] === 0x57 && b[9] === 0x45));
  const generic = /^(material|default|defaultmaterial|mat|lambert|phong|blinn|standard|standardsurface|initialshadinggroup|none|untitled)\d*$/;
  for (const g of m.groups) {
    let bytes = decodable(g.texBytes) ? g.texBytes : null, src = bytes ? 'embedded' : '';
    if (!bytes && R && g.texName) { bytes = R.image(g.texName); if (bytes) src = baseName(g.texName); }
    if (!bytes && R && g.mat) {
      const mn = g.mat.toLowerCase().replace(/[^a-z0-9]/g, '');
      const c = mn.length >= 3 && !generic.test(mn) && R.color.filter((c) => c.stem.replace(/[^a-z0-9]/g, '').includes(mn)).sort((a, b) => kw.test(b.stem) - kw.test(a.stem))[0];
      if (c) { bytes = c.b; src = c.name + ' (by material name)'; }
    }
    // the best guess only for a single-material model, or a material that names a texture the zip does not hold
    if (!bytes && best && (m.groups.length === 1 || (g.texName && R.color.length === 1))) { bytes = best.b; src = best.name + ' (best guess)'; }
    g.src = src;
    let img = null;
    if (bytes && decode) {
      if (cache.has(bytes)) img = cache.get(bytes);
      else { try { img = await decodeTex(bytes, maxTex); } catch (err) { console.warn('model texture', err); } cache.set(bytes, img); }
    }
    g.img = img;
    if (!img && decode) g.color = g.flat || g.color;
    delete g.texBytes;
  }
}
// any stored model record -> CPU model (with textures unless withTex is false)
async function parseModelRecord(rec, maxTex, withTex = true) {
  let R = null, type = rec.type, data = rec.data ?? rec.text;
  if (type === 'bundle') {
    const files = new Map(rec.files.map(([n, b]) => [n, new Uint8Array(b)]));
    R = bundleResolver(files);
    const mb = files.get(rec.main), ext = (baseName(rec.main).match(/\.([a-z0-9]+)$/) || [0, ''])[1];
    type = ext === 'glb' ? 'glb' : ext === 'gltf' ? 'gltf' : ext === 'fbx' ? 'fbx' : 'obj';
    data = type === 'gltf' || type === 'obj' ? new TextDecoder().decode(mb) : mb.slice().buffer;
  }
  const m = type === 'glb' ? await parseGLB(data) : type === 'gltf' ? await parseGLTF(data, R) : type === 'fbx' ? await parseFBX(data) : parseOBJ(data, R);
  if (withTex) await loadTextures(m, R, maxTex);
  return m;
}

// ---- glTF 2.0: the document plus its buffers (the .glb chunk, files from a zip, or data: URIs)
const dataURI = (u) => { const b = atob(u.slice(u.indexOf(',') + 1)), o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; };
async function parseGLB(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) throw new Error('not a glTF 2.0 binary (.glb) file');
  let off = 12, J = null, BIN = new Uint8Array(0);
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === 0x4e4f534a) J = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, len)));
    else if (type === 0x004e4942) BIN = new Uint8Array(buf, off + 8, len);
    off += 8 + len;
  }
  if (!J) throw new Error('the .glb has no JSON chunk');
  return gltfDoc(J, (J.buffers || [{}]).map((b, i) => (b.uri ? (b.uri.startsWith('data:') ? dataURI(b.uri) : null) : i === 0 ? BIN : null)));
}
async function parseGLTF(text, R) {
  const J = JSON.parse(text);
  const bufs = (J.buffers || []).map((b) => (!b.uri ? null : b.uri.startsWith('data:') ? dataURI(b.uri) : R && R.file(decodeURIComponent(b.uri))));
  bufs.forEach((b, i) => { if (!b) throw new Error(`the .gltf needs ${J.buffers[i].uri || 'a buffer'}, which is not in the zip`); });
  return gltfDoc(J, bufs);
}
function gltfDoc(J, bufs) {
  // only compressed geometry is unreadable; other extensions are read (spec-gloss materials, WebP, quantized meshes) or
  // safely ignored (KTX2 textures fall back to the material colour)
  const comp = (J.extensionsRequired || []).filter((e) => e === 'KHR_draco_mesh_compression' || e === 'EXT_meshopt_compression');
  if (comp.length) throw new Error(`its meshes are compressed (${comp.join(', ')}); export it again without mesh compression`);
  const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }, CS = { 5126: 4, 5125: 4, 5123: 2, 5122: 2, 5121: 1, 5120: 1 };
  const view = (i) => { const bv = J.bufferViews[i], b = bufs[bv.buffer || 0]; return { b, off: b.byteOffset + (bv.byteOffset || 0), len: bv.byteLength, stride: bv.byteStride || 0 }; };
  const acc = (ai) => {
    const a = J.accessors[ai], nc = NC[a.type], n = a.count, out = new Float32Array(n * nc);
    if (a.bufferView === undefined) return out;
    const v = view(a.bufferView), cs = CS[a.componentType], st = v.stride || cs * nc, d = new DataView(v.b.buffer, v.off, v.len), base = a.byteOffset || 0, t = a.componentType, nz = a.normalized;
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
      const o = base + i * st + c * cs;
      out[i * nc + c] = t === 5126 ? d.getFloat32(o, true) : t === 5125 ? d.getUint32(o, true) : t === 5123 ? d.getUint16(o, true) / (nz ? 65535 : 1)
        : t === 5122 ? max(d.getInt16(o, true) / (nz ? 32767 : 1), -1) : t === 5121 ? d.getUint8(o) / (nz ? 255 : 1) : max(d.getInt8(o) / (nz ? 127 : 1), -1);
    }
    return out;
  };
  const mul = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
  const trs = (nd) => {
    if (nd.matrix) return nd.matrix.slice();
    const [x, y, z, w] = nd.rotation || [0, 0, 0, 1], [sx, sy, sz] = nd.scale || [1, 1, 1], [tx, ty, tz] = nd.translation || [0, 0, 0];
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
  };
  const P = [], N = [], UV = [], prims = [], SKJ = [], SKW = [];
  let nv = 0, skinI = -1;
  const visit = (ni, M, depth) => {
    const nd = J.nodes[ni], W0 = mul(M, trs(nd));
    if (nd.mesh !== undefined) for (const pr of J.meshes[nd.mesh].primitives) {
      if ((pr.mode ?? 4) !== 4 || pr.attributes.POSITION === undefined) continue;
      const pos = acc(pr.attributes.POSITION), nrm = pr.attributes.NORMAL !== undefined ? acc(pr.attributes.NORMAL) : null, uv = pr.attributes.TEXCOORD_0 !== undefined ? acc(pr.attributes.TEXCOORD_0) : null;
      const n = pos.length / 3, v0 = nv; nv += n;
      if (nv > 1.5e6) throw new Error('more than 1.5 million vertices: pick a lighter version');
      // skinned (the first skin of the file): positions stay in bind space, the joints move them. Anything else is
      // static: placed by its node transform and bound to the extra identity slot (-1)
      const skinned = nd.skin !== undefined && pr.attributes.JOINTS_0 !== undefined && pr.attributes.WEIGHTS_0 !== undefined && (skinI < 0 || skinI === nd.skin) && J.skins && J.skins[nd.skin];
      if (skinned) skinI = nd.skin;
      const W = skinned ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : W0;
      const jo = skinned ? acc(pr.attributes.JOINTS_0) : null, we = skinned ? acc(pr.attributes.WEIGHTS_0) : null;
      for (let i = 0; i < n; i++) {
        if (skinned) for (let k = 0; k < 4; k++) { SKJ.push(jo[i * 4 + k]); SKW.push(we[i * 4 + k]); } else SKJ.push(-1, 0, 0, 0), SKW.push(1, 0, 0, 0);
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        P.push(W[0] * x + W[4] * y + W[8] * z + W[12], W[1] * x + W[5] * y + W[9] * z + W[13], W[2] * x + W[6] * y + W[10] * z + W[14]);
        if (nrm) { const a = nrm[i * 3], b = nrm[i * 3 + 1], c = nrm[i * 3 + 2]; N.push(W[0] * a + W[4] * b + W[8] * c, W[1] * a + W[5] * b + W[9] * c, W[2] * a + W[6] * b + W[10] * c); } else N.push(0, 0, 0);
        UV.push(uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0);
      }
      const ix = pr.indices !== undefined ? acc(pr.indices) : null, tri = new Uint32Array(ix ? ix.length : n);
      for (let i = 0; i < tri.length; i++) tri[i] = v0 + (ix ? ix[i] : i);
      prims.push({ mat: pr.material ?? -1, tri });
    }
    if (depth < 64) for (const c of nd.children || []) visit(c, W0, depth + 1);
  };
  const scene = J.scenes && J.scenes.length ? J.scenes[J.scene || 0] : { nodes: J.nodes.map((_, i) => i) };
  for (const r of scene.nodes) visit(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
  if (!nv) throw new Error('no triangles found in the glTF');
  // the base-colour image of a texture: embedded bytes (bufferView or data: URI) or a file name to find in the zip
  const texInfo = (ti) => {
    if (ti === undefined || !J.textures || !J.textures[ti]) return {};
    const tx = J.textures[ti], im = (J.images || [])[tx.source ?? (tx.extensions && tx.extensions.EXT_texture_webp && tx.extensions.EXT_texture_webp.source)];
    if (!im) return {};
    if (im.bufferView !== undefined) { const v = view(im.bufferView); return { texBytes: new Uint8Array(v.b.buffer, v.off, v.len) }; }
    if (im.uri) return im.uri.startsWith('data:') ? { texBytes: dataURI(im.uri) } : { texName: decodeURIComponent(im.uri) };
    return {};
  };
  const byMat = new Map();
  for (const p of prims) { if (!byMat.has(p.mat)) byMat.set(p.mat, []); byMat.get(p.mat).push(p.tri); }
  let total = 0; for (const p of prims) total += p.tri.length;
  const I = new Uint32Array(total), groups = [];
  let at = 0;
  for (const [mi, list] of byMat) {
    const first = at; for (const t of list) { I.set(t, at); at += t.length; }
    // metallic-roughness base colour, or the diffuse of the older specular-glossiness materials (common on Sketchfab)
    const m = (J.materials || [])[mi] || {}, pbr = m.pbrMetallicRoughness || {}, sg = m.extensions && m.extensions.KHR_materials_pbrSpecularGlossiness;
    const color = sg ? sg.diffuseFactor || [1, 1, 1, 1] : pbr.baseColorFactor || [1, 1, 1, 1], ti = sg ? sg.diffuseTexture && sg.diffuseTexture.index : pbr.baseColorTexture && pbr.baseColorTexture.index;
    groups.push({ first, count: at - first, color, flat: color, cut: m.alphaMode && m.alphaMode !== 'OPAQUE' ? (m.alphaCutoff ?? 0.5) : 0, mat: m.name || '', ...texInfo(ti) });
  }
  // skeleton and animations: rest TRS of every node, parents, the skin's joints and inverse bind matrices, and each
  // animation's translation / rotation / scale channels
  let skin = null;
  if (skinI >= 0) {
    const sk = J.skins[skinI], nJ = sk.joints.length;
    const ibm = sk.inverseBindMatrices !== undefined ? acc(sk.inverseBindMatrices) : (() => { const a = new Float32Array(nJ * 16); for (let j = 0; j < nJ; j++) for (let k = 0; k < 4; k++) a[j * 16 + k * 5] = 1; return a; })();
    const nodes = J.nodes.map((nd) => ({ t: nd.translation || [0, 0, 0], r: nd.rotation || [0, 0, 0, 1], s: nd.scale || [1, 1, 1], m: nd.matrix || null, parent: -1 }));
    J.nodes.forEach((nd, i) => { for (const c of nd.children || []) if (nodes[c]) nodes[c].parent = i; });
    const anims = (J.animations || []).map((a, i) => {
      const ch = a.channels.filter((c) => c.target && c.target.node !== undefined && c.target.path !== 'weights').map((c) => {
        const sm = a.samplers[c.sampler], t = acc(sm.input), v = acc(sm.output);
        return { node: c.target.node, path: c.target.path, t, v, mode: sm.interpolation === 'STEP' ? 1 : sm.interpolation === 'CUBICSPLINE' ? 2 : 0, k: 0 };
      });
      let dur = 0; for (const c of ch) if (c.t.length) dur = max(dur, c.t[c.t.length - 1]);
      return { name: a.name || 'animation ' + (i + 1), ch, dur };
    }).filter((a) => a.ch.length && a.dur > 0);
    skin = { joints: sk.joints, ibm, nodes, anims, J: new Float32Array(SKJ), W: new Float32Array(SKW) };
  }
  return { P: new Float32Array(P), N: new Float32Array(N), UV: new Float32Array(UV), I, groups, skin };
}

// ---- Wavefront OBJ (+ MTL): positions, UVs, normals, materials (Kd, d, map_Kd); polygons fanned into triangles
function parseOBJ(text, R) {
  const V = [], VT = [], VN = [], P = [], N = [], UV = [], vmap = new Map(), tris = new Map(), mtl = {};
  let cur = '';
  const rel = (s, n) => { const i = parseInt(s, 10); return i < 0 ? n + i : i - 1; };
  const vid = (tok) => {
    const [a, b, c] = tok.split('/'), vi = rel(a, V.length / 3), ti = b ? rel(b, VT.length / 2) : -1, ni = c ? rel(c, VN.length / 3) : -1;
    if (!(vi >= 0 && vi < V.length / 3)) throw new Error('not a usable OBJ model (bad face index)');
    const key = vi + ',' + ti + ',' + ni;
    let k = vmap.get(key);
    if (k === undefined) {
      k = P.length / 3; vmap.set(key, k);
      P.push(V[vi * 3], V[vi * 3 + 1], V[vi * 3 + 2]);
      if (ni >= 0 && ni < VN.length / 3) N.push(VN[ni * 3], VN[ni * 3 + 1], VN[ni * 3 + 2]); else N.push(0, 0, 0);
      if (ti >= 0 && ti < VT.length / 2) UV.push(VT[ti * 2], 1 - VT[ti * 2 + 1]); else UV.push(0, 0);
    }
    return k;
  };
  const readMTL = (name) => {
    const b = R && R.file(name);
    if (!b) return;
    let m = null;
    for (const raw of new TextDecoder().decode(b).split('\n')) {
      const line = raw.trim(), sp = line.indexOf(' '), key = sp < 0 ? line : line.slice(0, sp), rest = sp < 0 ? '' : line.slice(sp + 1).trim();
      if (key === 'newmtl') { m = mtl[rest] = { kd: [0.8, 0.8, 0.8], d: 1, map: '' }; }
      else if (!m) continue;
      else if (key === 'Kd') { const t = rest.split(/\s+/).map(Number); m.kd = [t[0] || 0, t[1] ?? t[0] ?? 0, t[2] ?? t[0] ?? 0]; }
      else if (key === 'd') m.d = +rest || 1;
      else if (key === 'Tr') m.d = 1 - (+rest || 0);
      else if (key === 'map_Kd') m.map = rest.split(/\s+-\S+\s+\S+/).pop().trim().split(/\s+/).pop();
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const t = line.split(/\s+/);
    if (t[0] === 'v') V.push(+t[1] || 0, +t[2] || 0, +t[3] || 0);
    else if (t[0] === 'vt') VT.push(+t[1] || 0, +t[2] || 0);
    else if (t[0] === 'vn') VN.push(+t[1] || 0, +t[2] || 0, +t[3] || 0);
    else if (t[0] === 'usemtl') cur = line.slice(7).trim();
    else if (t[0] === 'mtllib') readMTL(line.slice(7).trim());
    else if (t[0] === 'f' && t.length > 3) {
      const ix = t.slice(1).map(vid);
      if (!tris.has(cur)) tris.set(cur, []);
      const L = tris.get(cur);
      for (let k = 1; k < ix.length - 1; k++) L.push(ix[0], ix[k], ix[k + 1]);
      if (P.length > 4.5e6) throw new Error('more than 1.5 million vertices: pick a lighter version');
    }
  }
  if (!P.length || !tris.size) throw new Error('not a usable OBJ model');
  let total = 0; for (const L of tris.values()) total += L.length;
  const I = new Uint32Array(total), groups = [];
  let at = 0;
  for (const [name, L] of tris) {
    I.set(L, at);
    const m = mtl[name] || { kd: [0.8, 0.8, 0.8], d: 1, map: '' };
    groups.push({ first: at, count: L.length, color: [1, 1, 1, 1], flat: [...m.kd, 1], cut: m.d < 0.99 ? 0.5 : 0, mat: name, texName: m.map });
    at += L.length;
  }
  return { P: new Float32Array(P), N: new Float32Array(N), UV: new Float32Array(UV), I, groups, flipV: true };
}
function finishModel(m, cls, name) {
  const P = m.P, N = m.N, I = m.I, n = P.length / 3;
  // fill in missing normals (area-weighted face normals)
  const need = new Uint8Array(n); let any = false;
  for (let i = 0; i < n; i++) if (!N[i * 3] && !N[i * 3 + 1] && !N[i * 3 + 2]) { need[i] = 1; any = true; }
  if (any) for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3, ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) if (need[k / 3]) { N[k] += nx; N[k + 1] += ny; N[k + 2] += nz; }
  }
  let x0 = 1e30, y0 = 1e30, z0 = 1e30, x1 = -1e30, y1 = -1e30, z1 = -1e30;
  for (let i = 0; i < P.length; i += 3) { x0 = min(x0, P[i]); x1 = max(x1, P[i]); y0 = min(y0, P[i + 1]); y1 = max(y1, P[i + 1]); z0 = min(z0, P[i + 2]); z1 = max(z1, P[i + 2]); }
  const turn = MOVERS.includes(cls) && x1 - x0 > z1 - z0; // movers travel along +z: turn the long side onto z
  const s = 1 / (max(x1 - x0, y1 - y0, z1 - z0) || 1), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, by = cls === 'c' || cls === 'l' || cls === 'm' ? (y0 + y1) / 2 : y0;
  const vb = new ArrayBuffer(n * 24), f = new Float32Array(vb), sb = new Int8Array(vb);
  for (let i = 0; i < n; i++) {
    let x = (P[i * 3] - cx) * s, y = (P[i * 3 + 1] - by) * s, z = (P[i * 3 + 2] - cz) * s, nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    if (turn) { const t = x; x = -z; z = t; const tn = nx; nx = -nz; nz = tn; }
    const l = hypot(nx, ny, nz) || 1;
    f[i * 6] = x; f[i * 6 + 1] = y; f[i * 6 + 2] = z;
    sb[i * 24 + 12] = round(nx / l * 127); sb[i * 24 + 13] = round(ny / l * 127); sb[i * 24 + 14] = round(nz / l * 127); sb[i * 24 + 15] = 127;
    f[i * 6 + 4] = m.UV[i * 2]; f[i * 6 + 5] = m.UV[i * 2 + 1];
  }
  const ex = (turn ? z1 - z0 : x1 - x0) * s, ez = (turn ? x1 - x0 : z1 - z0) * s;
  const out = { name, cls, vb, ib: I, groups: m.groups, hb: [ex / 2, (y1 - y0) * s / 2, ez / 2], tint: [0.55 + 0.4 * hash2(name.length, 7, 31), 0.55 + 0.4 * hash2(name.length, 9, 33), 0.55 + 0.4 * hash2(name.length, 11, 35)] };
  if (m.skin) {
    // vertices were normalised by N (centre, scale, maybe turn); a joint matrix M then acts as N * M * N^-1
    const ST = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, -s * cx, -s * by, -s * cz, 1], R = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1];
    const Nm = turn ? mat4Mul(R, ST) : ST, nJ = m.skin.joints.length;
    // per vertex: 4 joint indices (the static slot is nJ) and 4 weights, normalised, as bytes
    const sk = new Uint8Array(n * 8), SJ = m.skin.J, SW = m.skin.W;
    for (let i = 0; i < n; i++) {
      let t = 0; for (let k = 0; k < 4; k++) t += SW[i * 4 + k];
      let q = 0;
      for (let k = 0; k < 4; k++) {
        const j = SJ[i * 4 + k]; sk[i * 8 + k] = j < 0 ? nJ : min(j, nJ);
        const w = k < 3 ? round(SW[i * 4 + k] / (t || 1) * 255) : 255 - q; sk[i * 8 + 4 + k] = max(0, min(255, w)); q += sk[i * 8 + 4 + k];
      }
    }
    out.skin = { ...m.skin, N: Nm, Ni: mat4AffInv(Nm), nJ, sk };
    // the clip imported creatures play: one named like swimming or moving, else the first
    out.clip = max(0, m.skin.anims.findIndex((a) => /swim|fly|move|walk|idle/i.test(a.name)));
  }
  return out;
}

// ---------------------------------------------------------------- imported plants: swaying clusters in 36 m cells near the swimmer
const PCELL = 36, PLC = new Map();
function plantCell(cx, cz) {
  const key = cx * 65536 + cz;
  let A = PLC.get(key);
  if (A) return A;
  if (PLC.size > 4000) PLC.clear();
  A = [];
  if (PLANTS.length && hash2(cx, cz, 501) < 0.5) {
    const mi = PLANTS[hash2(cx, cz, 502) * PLANTS.length | 0], n = 3 + (hash2(cx, cz, 503) * 8 | 0), x0 = (cx + 0.5) * PCELL, z0 = (cz + 0.5) * PCELL;
    for (let i = 0; i < n; i++) {
      const x = x0 + (hash2(cx + i, cz, 504) - 0.5) * 26, z = z0 + (hash2(cx, cz + i, 505) - 0.5) * 26, sc = 0.5 + 2.4 * hash2(cx - i, cz + i, 506) ** 2;
      A.push({ m: mi, x, y: hAt(x, z) - 0.04 * sc, z, sc, yaw: hash2(cx + i, cz - i, 507) * TAU, seed: hash2(cx, cz, 508 + i) });
    }
  }
  PLC.set(key, A);
  return A;
}

// ---------------------------------------------------------------- creature interactions (used by behave())
// leviathan heads this frame (the same path formula as vsLev), for prey to flee from and to drive the hunt
const LHEAD = new Float64Array(96);
let nFlee = 0, nHunt = 0, nFollow = 0, nLH = 0;
function leviathanHeads() {
  for (let i = 0; i < NLEV; i++) {
    const o = i * 8, R = LB.lev[o + 3], a = F[TIME] * LB.lev[o + 5] + LB.lev[o + 4];
    LHEAD[i * 3] = LEV[i * 4] + R * cos(a); LHEAD[i * 3 + 1] = LEV[i * 4 + 1] + 5 * sin(0.45 * a + LB.lev[o + 7]); LHEAD[i * 3 + 2] = LEV[i * 4 + 2] + R * 0.85 * sin(a);
  }
  nLH = NLEV;
  for (let s = 0; s < LIFEN[6] && nLH < 32; s++) if (CSK[s] === 1) { cslot(s); const a = F[TIME] * CSP[1] + CSP[2]; LHEAD[nLH * 3] = CUS[s * 4] + CSP[0] * cos(a); LHEAD[nLH * 3 + 1] = CUS[s * 4 + 1]; LHEAD[nLH * 3 + 2] = CUS[s * 4 + 2] + CSP[0] * 0.85 * sin(a); nLH++; }
}

// ---------------------------------------------------------------- binary FBX (7.x) import
// Reads the node tree (zlib-compressed arrays through the browser's DecompressionStream), then: every Geometry mesh
// (Vertices, PolygonVertexIndex, normals, the first UV set, per-polygon material indices), the Model hierarchy and its
// local transforms (Lcl Translation / Rotation / Scaling, PreRotation, rotation order, geometric offsets), the materials
// connected to each model (DiffuseColor and a diffuse texture whose image is embedded in the file as a Video), and the
// up axis from GlobalSettings. Polygons are fanned into triangles. Output: the same format as parseGLB.
async function parseFBX(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), td = new TextDecoder();
  if (td.decode(u8.subarray(0, 18)) !== 'Kaydara FBX Binary') {
    if (/^\s*;\s*FBX/.test(td.decode(u8.subarray(0, 64)))) throw new Error('this is a text (ASCII) FBX; export it again as binary FBX');
    throw new Error('not an FBX file');
  }
  const ver = dv.getUint32(23, true), wide = ver >= 7500;
  if (ver < 7000) throw new Error(`FBX version ${ver} is too old (7.0 or newer is needed)`);
  const inflate = async (b) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const u64 = (o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;
  async function node(o) {
    const end = wide ? u64(o) : dv.getUint32(o, true), np = wide ? u64(o + 8) : dv.getUint32(o + 4, true), hl = wide ? 24 : 12;
    if (!end) return null;
    const nl = u8[o + hl]; let p = o + hl + 1;
    const name = td.decode(u8.subarray(p, p + nl)); p += nl;
    const props = [];
    for (let i = 0; i < np; i++) {
      const t = String.fromCharCode(u8[p++]);
      if (t === 'Y') { props.push(dv.getInt16(p, true)); p += 2; }
      else if (t === 'C') { props.push(!!u8[p]); p += 1; }
      else if (t === 'I') { props.push(dv.getInt32(p, true)); p += 4; }
      else if (t === 'F') { props.push(dv.getFloat32(p, true)); p += 4; }
      else if (t === 'D') { props.push(dv.getFloat64(p, true)); p += 8; }
      else if (t === 'L') { props.push(dv.getBigInt64(p, true)); p += 8; }
      else if (t === 'S' || t === 'R') { const n = dv.getUint32(p, true); p += 4; props.push(t === 'S' ? td.decode(u8.subarray(p, p + n)) : u8.slice(p, p + n)); p += n; }
      else if ('fdlib'.includes(t)) {
        const n = dv.getUint32(p, true), enc = dv.getUint32(p + 4, true), cl = dv.getUint32(p + 8, true); p += 12;
        const raw = enc ? await inflate(u8.subarray(p, p + cl)) : u8.slice(p, p + cl); p += cl;
        const b = raw.buffer.byteLength === raw.length && raw.byteOffset === 0 ? raw.buffer : raw.slice().buffer;
        props.push(t === 'f' ? new Float32Array(b, 0, n) : t === 'd' ? new Float64Array(b, 0, n) : t === 'i' ? new Int32Array(b, 0, n) : t === 'l' ? new BigInt64Array(b, 0, n) : new Uint8Array(b, 0, n));
      } else throw new Error(`unknown FBX property type ${t}`);
    }
    const kids = [];
    while (p < end) { const k = await node(p); if (!k) break; kids.push(k); p = k.end; }
    return { name, props, kids, end };
  }
  const top = [];
  for (let o = 27; o < buf.byteLength - (wide ? 25 : 13);) { const n = await node(o); if (!n) break; top.push(n); o = n.end; }
  const kid = (n, name) => n && n.kids.find((k) => k.name === name);
  const arr = (n, name) => { const k = kid(n, name); return k ? k.props[0] : null; };
  const str = (n, name) => { const k = kid(n, name); return k ? String(k.props[0]) : ''; };
  // Properties70 -> { name: values }
  const P70 = (n) => { const o = {}, k = kid(n, 'Properties70'); if (k) for (const p of k.kids) o[p.props[0]] = p.props.slice(4); return o; };
  const id = (v) => String(v);
  const objects = kid({ kids: top }, 'Objects'), conns = kid({ kids: top }, 'Connections');
  if (!objects) throw new Error('the FBX has no objects');
  const byId = new Map();
  for (const o of objects.kids) byId.set(id(o.props[0]), o);
  // connections: child -> parents (OO) and parent -> children, with the property name for OP links
  const parents = new Map(), children = new Map();
  for (const c of conns ? conns.kids : []) {
    if (c.name !== 'C') continue;
    const ch = id(c.props[1]), pa = id(c.props[2]), pr = c.props[3] || '';
    if (!parents.has(ch)) parents.set(ch, []); parents.get(ch).push(pa);
    if (!children.has(pa)) children.set(pa, []); children.get(pa).push({ id: ch, prop: pr });
  }
  // up axis: Z-up files are turned to Y-up
  const gs = P70(kid({ kids: top }, 'GlobalSettings')), up = gs.UpAxis ? gs.UpAxis[0] : 1, upSign = gs.UpAxisSign ? gs.UpAxisSign[0] : 1;
  // 4x4 column-major helpers
  const mul = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
  const T = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1], S = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
  const Rx = (a) => { const c = cos(a), s = sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
  const Ry = (a) => { const c = cos(a), s = sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
  const Rz = (a) => { const c = cos(a), s = sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
  // FBX rotation orders 0-5: XYZ XZY YZX YXZ ZXY ZYX (applied in that order, so the matrix is the reverse product)
  const euler = (v, ord) => {
    const d = PI / 180, x = Rx((v[0] || 0) * d), y = Ry((v[1] || 0) * d), z = Rz((v[2] || 0) * d);
    return [mul(z, mul(y, x)), mul(y, mul(z, x)), mul(x, mul(z, y)), mul(z, mul(x, y)), mul(y, mul(x, z)), mul(x, mul(y, z))][ord || 0];
  };
  const local = new Map();
  const localOf = (mid) => {
    if (local.has(mid)) return local.get(mid);
    const m = byId.get(mid), p = m ? P70(m) : {};
    const t = p['Lcl Translation'] || [0, 0, 0], r = p['Lcl Rotation'] || [0, 0, 0], s = p['Lcl Scaling'] || [1, 1, 1], pre = p.PreRotation || [0, 0, 0], ord = p.RotationOrder ? p.RotationOrder[0] : 0;
    const L = mul(T(t[0], t[1], t[2]), mul(euler(pre, 0), mul(euler(r, ord), S(s[0], s[1], s[2]))));
    local.set(mid, L);
    return L;
  };
  const worldOf = (mid, depth = 0) => {
    const pa = (parents.get(mid) || []).find((x) => byId.has(x) && byId.get(x).name === 'Model');
    return pa && depth < 64 ? mul(worldOf(pa, depth + 1), localOf(mid)) : localOf(mid);
  };
  const geomOffset = (mid) => {
    const p = P70(byId.get(mid)), t = p.GeometricTranslation || [0, 0, 0], r = p.GeometricRotation || [0, 0, 0], s = p.GeometricScaling || [1, 1, 1];
    return mul(T(t[0], t[1], t[2]), mul(euler(r, 0), S(s[0], s[1], s[2])));
  };
  // materials: diffuse colour, and the diffuse texture as embedded bytes (Material <- Texture <- Video with Content) or
  // the file name it refers to (found later in the zip)
  const matInfo = new Map();
  const material = (matId) => {
    if (matInfo.has(matId)) return matInfo.get(matId);
    const m = byId.get(matId), p = m ? P70(m) : {}, c = p.DiffuseColor || p.Diffuse || [0.8, 0.8, 0.8], f = p.DiffuseFactor ? p.DiffuseFactor[0] : 1;
    const tex = (children.get(matId) || []).find((x) => byId.has(x.id) && byId.get(x.id).name === 'Texture' && (!x.prop || /diffuse|basecolor|base color|albedo/i.test(x.prop)));
    let texBytes = null, texName = '';
    if (tex) {
      const tn = byId.get(tex.id), vid = (children.get(tex.id) || []).map((x) => byId.get(x.id)).find((o) => o && o.name === 'Video');
      const content = vid && kid(vid, 'Content');
      if (content && content.props[0] && content.props[0].length > 8) texBytes = content.props[0];
      texName = str(tn, 'RelativeFilename') || str(tn, 'FileName') || (vid ? str(vid, 'RelativeFilename') || str(vid, 'FileName') : '');
    }
    const op = p.Opacity ? p.Opacity[0] : 1;
    const info = { color: [1, 1, 1, 1], flat: [c[0] * f, c[1] * f, c[2] * f, 1], texBytes, texName, cut: op < 0.99 ? 0.5 : 0, mat: m ? String(m.props[1]).split('\x00')[0] : '' };
    matInfo.set(matId, info);
    return info;
  };
  // geometry -> triangles, grouped by material
  const P = [], N = [], UV = [], tris = new Map(); // material id -> index list
  let nv = 0;
  for (const g of objects.kids) {
    if (g.name !== 'Geometry' || g.props[2] !== 'Mesh') continue;
    const V = arr(g, 'Vertices'), PI_ = arr(g, 'PolygonVertexIndex');
    if (!V || !PI_) continue;
    const ln = kid(g, 'LayerElementNormal'), lu = kid(g, 'LayerElementUV'), lm = kid(g, 'LayerElementMaterial');
    const NR = ln && arr(ln, 'Normals'), NI = ln && arr(ln, 'NormalsIndex'), nMap = ln ? str(ln, 'MappingInformationType') : '', nRef = ln ? str(ln, 'ReferenceInformationType') : '';
    const UVA = lu && arr(lu, 'UV'), UI = lu && arr(lu, 'UVIndex'), uMap = lu ? str(lu, 'MappingInformationType') : '', uRef = lu ? str(lu, 'ReferenceInformationType') : '';
    const MI = lm && arr(lm, 'Materials'), mMap = lm ? str(lm, 'MappingInformationType') : 'AllSame';
    // every model using this geometry gets its own copy, with its world transform
    const models = (parents.get(id(g.props[0])) || []).filter((x) => byId.has(x) && byId.get(x).name === 'Model');
    for (const mid of models.length ? models : ['']) {
      let M = mid ? mul(worldOf(mid), geomOffset(mid)) : T(0, 0, 0);
      if (up === 2) M = mul(Rx(-PI / 2 * upSign), M); else if (up === 0) M = mul(Rz(PI / 2 * upSign), M);
      const mats = mid ? (children.get(mid) || []).filter((x) => byId.has(x.id) && byId.get(x.id).name === 'Material').map((x) => x.id) : [];
      const pick = (map, ref, k, vi, poly, idx) => { const i = /ByPolygonVertex/.test(map) ? k : /ByVert/.test(map) ? vi : /ByPolygon/.test(map) ? poly : 0; return /Index/.test(ref) && idx ? idx[i] : i; };
      let poly = 0, start = 0;
      for (let k = 0; k < PI_.length; k++) {
        if (PI_[k] >= 0) continue;
        // polygon start..k: emit its vertices and fan it
        const v0 = nv, cnt = k - start + 1;
        for (let j = start; j <= k; j++) {
          const vi = PI_[j] < 0 ? ~PI_[j] : PI_[j], x = V[vi * 3], y = V[vi * 3 + 1], z = V[vi * 3 + 2];
          P.push(M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]);
          if (NR) { const ni = pick(nMap, nRef, j, vi, poly, NI) * 3, a = NR[ni], b = NR[ni + 1], c = NR[ni + 2]; N.push(M[0] * a + M[4] * b + M[8] * c, M[1] * a + M[5] * b + M[9] * c, M[2] * a + M[6] * b + M[10] * c); } else N.push(0, 0, 0);
          if (UVA) { const ui = pick(uMap, uRef, j, vi, poly, UI) * 2; UV.push(UVA[ui], 1 - UVA[ui + 1]); } else UV.push(0, 0);
          nv++;
        }
        if (nv > 1.5e6) throw new Error('more than 1.5 million vertices: pick a lighter version');
        const mk = mats.length ? mats[(MI ? (mMap === 'AllSame' ? MI[0] : MI[poly]) : 0) % mats.length] || mats[0] : '';
        if (!tris.has(mk)) tris.set(mk, []);
        const L = tris.get(mk);
        for (let j = 1; j < cnt - 1; j++) L.push(v0, v0 + j, v0 + j + 1);
        poly++; start = k + 1;
      }
    }
  }
  if (!nv) throw new Error('no meshes found in the FBX');
  let total = 0; for (const L of tris.values()) total += L.length;
  const I = new Uint32Array(total), groups = [];
  let at = 0;
  for (const [mk, L] of tris) {
    I.set(L, at);
    const m = mk ? material(mk) : { color: [1, 1, 1, 1], flat: [0.8, 0.8, 0.8, 1], cut: 0, mat: '' };
    groups.push({ first: at, count: L.length, ...m });
    at += L.length;
  }
  return { P: new Float32Array(P), N: new Float32Array(N), UV: new Float32Array(UV), I, groups, flipV: true };
}
