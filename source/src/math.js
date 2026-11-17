// ============================================================================
// math + procedural helpers
// ============================================================================
// Two kinds of noise live here:
//  * load-time 3D noise (ihash / vnoise / fbm) used to sculpt meshes once, from the fixed stream rnd()
//  * the world noise (whu / wvn / wfbm / wwor / wheight): stateless, seeded by WSEED, and mirrored bit for bit
//    by W_WORLD in shaders.js. Both sides evaluate a point as an integer anchor cell of 1024 m (ax, az) plus a
//    local offset (lx, lz) in metres, and every lattice frequency is n cells per 1024 m with n an integer, so
//    lattice coordinates are exact integers (ax * n + floor(lx * n / 1024)) however far from the origin the
//    point is. The GPU never sees a large float; the CPU keeps the camera in Float64.
const { sin, cos, sqrt, min, max, abs, floor, ceil, PI, pow, atan2, hypot, exp, round } = Math;
const TAU = PI * 2;
let _seed = 20261110;
const rnd = () => {
  _seed = (_seed + 0x6D2B79F5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rr = (a, b) => a + (b - a) * rnd();
// each generator system starts its own random stream, so the systems stay independent
const rseed = (s) => { _seed = (20261110 + Math.imul(s, 7919)) | 0; };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
const fract = (x) => x - floor(x);

const ihash = (x, y, z) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const vnoise = (x, y, z) => {
  const ix = floor(x), iy = floor(y), iz = floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const a = mix(mix(ihash(ix, iy, iz), ihash(ix + 1, iy, iz), fx), mix(ihash(ix, iy + 1, iz), ihash(ix + 1, iy + 1, iz), fx), fy);
  const b = mix(mix(ihash(ix, iy, iz + 1), ihash(ix + 1, iy, iz + 1), fx), mix(ihash(ix, iy + 1, iz + 1), ihash(ix + 1, iy + 1, iz + 1), fx), fy);
  return mix(a, b, fz);
};
const fbm = (x, y, z, o = 4) => {
  let a = 0.5, s = 0;
  for (let i = 0; i < o; i++) { s += a * vnoise(x, y, z); x = x * 2.03 + 17.1; y = y * 2.03 + 31.7; z = z * 2.03 + 5.3; a *= 0.5; }
  return s / (1 - 2 * a);
};

// ---------------------------------------------------------------- world noise (mirror of W_WORLD)
// integer hash of a lattice point: identical u32 arithmetic to hu() in WGSL (Math.imul wraps like u32 *)
const whu = (x, z, s) => {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(z, 0xd8163841) ^ Math.imul(s, 0xcb1ab31f);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
};
const whf = (x, z, s) => (whu(x, z, s) >>> 8) / 16777216;
// value noise with n lattice cells per 1024 m
function wvn(ax, az, lx, lz, n, s) {
  const k = n / 1024, px = lx * k, pz = lz * k, x0 = floor(px), z0 = floor(pz);
  let u = px - x0, v = pz - z0; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
  const ix = ax * n + x0, iz = az * n + z0;
  const a = whf(ix, iz, s), b = whf(ix + 1, iz, s), c = whf(ix, iz + 1, s), d = whf(ix + 1, iz + 1, s);
  const e = a + (b - a) * u, f = c + (d - c) * u;
  return e + (f - e) * v;
}
// o octaves starting at n cells per 1024 m, normalised to [0, 1]
function wfbm(ax, az, lx, lz, n, o, s) {
  let a = 0.5, t = 0;
  for (let k = 0; k < o; k++) { t += a * wvn(ax, az, lx, lz, n, s + k * 7919); n *= 2; a *= 0.5; }
  return t / (1 - 2 * a);
}
// Worley F1 / F2 (in cell units) into WOR
const WOR = new Float64Array(2);
function wwor(ax, az, lx, lz, n, s) {
  const k = n / 1024, px = lx * k, pz = lz * k, x0 = floor(px), z0 = floor(pz), fx = px - x0, fz = pz - z0;
  const ix = ax * n + x0, iz = az * n + z0;
  let d1 = 9, d2 = 9;
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
    const cx = ix + x, cz = iz + z, ox = x + whf(cx, cz, s) - fx, oz = z + whf(cx, cz, s + 1) - fz, d = ox * ox + oz * oz;
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  WOR[0] = sqrt(d1); WOR[1] = sqrt(d2);
}
// value noise on big cells of m x 1024 m (m whole tiles): the tile index is split into big cell + offset in integers,
// so it stays exact far from the origin. Mirror of vnL() in WGSL.
function wvnL(ax, az, lx, lz, m, s) {
  const bx = floor(ax / m), bz = floor(az / m), L = m * 1024;
  const gx = (ax - bx * m) * 1024 + lx, gz = (az - bz * m) * 1024 + lz, ox = floor(gx / L), oz = floor(gz / L);
  let u = gx / L - ox, v = gz / L - oz; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
  const ix = bx + ox, iz = bz + oz;
  const a = whf(ix, iz, s), b = whf(ix + 1, iz, s), c = whf(ix, iz + 1, s), d = whf(ix + 1, iz + 1, s);
  const e = a + (b - a) * u, f = c + (d - c) * u;
  return e + (f - e) * v;
}
// seamounts: 40 % of the cells (n per 1024 m) hold one, a rounded cone up to 0.9 cell wide; the result is the
// tallest one here, 0..1 (a maximum, not a sum, so it is continuous where cones overlap)
function wsea(ax, az, lx, lz, n, s) {
  const k = n / 1024, px = lx * k, pz = lz * k, x0 = floor(px), z0 = floor(pz), fx = px - x0, fz = pz - z0;
  const ix = ax * n + x0, iz = az * n + z0;
  let m = 0;
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
    const cx = ix + x, cz = iz + z;
    if (whf(cx, cz, s + 2) < 0.4) {
      const ox = x + 0.15 + 0.7 * whf(cx, cz, s) - fx, oz = z + 0.15 + 0.7 * whf(cx, cz, s + 1) - fz;
      const d = sqrt(ox * ox + oz * oz) / (0.55 + 0.35 * whf(cx, cz, s + 3));
      if (d < 1) { const t = 1 - sstep(0, 1, d), v = (0.45 + 0.55 * whf(cx, cz, s + 4)) * t * sqrt(t); if (v > m) m = v; }
    }
  }
  return m;
}
// steps with steep risers (the last 14 % of each step): cliff walls between flat shelves
const wcliff = (y, st) => { const k = y / st, f = floor(k); return (f + sstep(0.86, 1, k - f)) * st; };
const wterrace = (y, st) => { const k = y / st, f = floor(k); return (f + sstep(0.5, 1, k - f)) * st; };
// Biomes: the sea floor is split into warped Voronoi regions of ~512 m (2 cells per 1024 m), each one biome picked
// by its cell hash, blended across a ~110 m band at the borders. TB[1..7] = weights of
//   1 kelp forest, 2 purple grotto, 3 trench / arch canyons, 4 silt plain, 5 coral reef shallows,
//   6 crystal fields, 7 volcanic vents        (TB[0] = height after wheight)
const TB = new Float64Array(8), BIOP = [0.19, 0.32, 0.46, 0.6, 0.74, 0.87, 1], WORC = new Int32Array(4);
const bioId = (cx, cz) => { const r = whf(cx, cz, WSEED + 73); let i = 0; while (r >= BIOP[i]) i++; return i; };
// Worley F1 / F2 plus the integer coordinates of the two nearest cells (WORC)
function wworc(ax, az, lx, lz, n, s) {
  const k = n / 1024, px = lx * k, pz = lz * k, x0 = floor(px), z0 = floor(pz), fx = px - x0, fz = pz - z0;
  const ix = ax * n + x0, iz = az * n + z0;
  let d1 = 9, d2 = 9;
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
    const cx = ix + x, cz = iz + z, ox = x + whf(cx, cz, s) - fx, oz = z + whf(cx, cz, s + 1) - fz, d = ox * ox + oz * oz;
    if (d < d1) { d2 = d1; WORC[2] = WORC[0]; WORC[3] = WORC[1]; d1 = d; WORC[0] = cx; WORC[1] = cz; } else if (d < d2) { d2 = d; WORC[2] = cx; WORC[3] = cz; }
  }
  WOR[0] = sqrt(d1); WOR[1] = sqrt(d2);
}
function wbio(ax, az, lx, lz) {
  const s = WSEED;
  const qx = lx + (wfbm(ax, az, lx, lz, 4, 3, s + 71) - 0.5) * 260, qz = lz + (wfbm(ax, az, lx, lz, 4, 3, s + 72) - 0.5) * 260;
  wworc(ax, az, qx, qz, 2, s + 74);
  const b = sstep(0, 0.22, WOR[1] - WOR[0]);
  for (let i = 1; i < 8; i++) TB[i] = 0;
  TB[1 + bioId(WORC[0], WORC[1])] += 0.5 + 0.5 * b;
  TB[1 + bioId(WORC[2], WORC[3])] += 0.5 - 0.5 * b;
}
// seabed height h(x, z) in metres (sea surface at y = 0); also leaves the biome weights in TB
function wheight(ax, az, lx, lz) {
  const s = WSEED;
  wbio(ax, az, lx, lz);
  const kp = TB[1], gr = TB[2], tr = TB[3], pl = TB[4], rf = TB[5], cr = TB[6], vo = TB[7];
  const qx = lx + (wfbm(ax, az, lx, lz, 8, 2, s + 5) - 0.5) * 36, qz = lz + (wfbm(ax, az, lx, lz, 8, 2, s + 6) - 0.5) * 36;
  const base = -46 + 10 * (wfbm(ax, az, lx, lz, 4, 4, s + 1) - 0.5) + 2.4 * (wfbm(ax, az, qx, qz, 32, 3, s + 2) - 0.5);
  let h = 0;
  if (kp > 0) { const r = 1 - abs(2 * wfbm(ax, az, qx, qz, 16, 3, s + 3) - 1); h += kp * (base + 3 + 8 * sstep(0.62, 0.95, r) + 0.9 * (wfbm(ax, az, lx, lz, 128, 2, s + 4) - 0.5)); }
  if (gr > 0) { wwor(ax, az, qx, qz, 16, s + 9); h += gr * (base - 14 + wterrace(22 * (1 - sstep(0, 0.3, WOR[1] - WOR[0])), 4) + 5 * (1 - sstep(0, 0.75, WOR[0]))); }
  if (tr > 0) { wwor(ax, az, qx, qz, 8, s + 13); const e = WOR[1] - WOR[0]; h += tr * (base + wterrace(16 * sstep(0.3, 0.55, e) - 40 * (1 - sstep(0.04, 0.32, e)), 5) + 1.2 * (wfbm(ax, az, lx, lz, 64, 2, s + 14) - 0.5)); }
  if (pl > 0) h += pl * (base - 5 + 1.6 * (wfbm(ax, az, lx, lz, 32, 2, s + 15) - 0.5));
  // reef: a shallow plateau of coral knolls cut by sandy channels, ending in a drop-off at its border
  if (rf > 0) { wwor(ax, az, qx, qz, 32, s + 21); const ch = 1 - sstep(0, 0.07, abs(wfbm(ax, az, qx, qz, 8, 2, s + 22) - 0.5)); h += rf * (-19 + 5 * (wfbm(ax, az, lx, lz, 16, 3, s + 23) - 0.5) + 4 * (1 - sstep(0, 0.6, WOR[0])) - 6 * ch); }
  // crystal fields: sharp-ridged dark rock
  if (cr > 0) { const r = 1 - abs(2 * wfbm(ax, az, qx, qz, 16, 3, s + 25) - 1); h += cr * (base - 3 + 10 * pow(r, 2.5)); }
  // volcanic vents: a deep basin of cones with craters
  if (vo > 0) { wwor(ax, az, qx, qz, 8, s + 27); h += vo * (base - 22 + 26 * pow(1 - sstep(0, 0.55, WOR[0]), 1.6) - 7 * (1 - sstep(0, 0.1, WOR[0])) + 1.5 * (wfbm(ax, az, lx, lz, 64, 2, s + 28) - 0.5)); }
  // patches of rock pinnacles rising from the plains and kelp floors (32 m Worley cells)
  const pm = sstep(0.55, 0.7, wfbm(ax, az, lx, lz, 4, 2, s + 17));
  if (pm > 0 && pl + kp > 0) { wwor(ax, az, qx, qz, 32, s + 19); h += (pl + 0.6 * kp) * pm * 16 * pow(1 - sstep(0, 0.38, WOR[0]), 2.5); }
  // Large-scale depth, across all biomes. rg (0..1) is a regional field on 6 km, 2 km and 1 km cells, warped by
  // +-160 m: low = shallow shelves (up to 26 m higher), mid = the usual floor, high = abyssal plains (up to 210 m
  // deeper). In about half of the world the change comes in 38 m steps with cliff walls instead of a slope.
  const wx = lx + (wfbm(ax, az, lx, lz, 2, 2, s + 85) - 0.5) * 320, wz = lz + (wfbm(ax, az, lx, lz, 2, 2, s + 86) - 0.5) * 320;
  const rg = sstep(0.2, 0.8, 0.55 * wvnL(ax, az, wx, wz, 6, s + 81) + 0.3 * wvnL(ax, az, wx, wz, 2, s + 82) + 0.15 * wvn(ax, az, wx, wz, 1, s + 83));
  const dp = sstep(0.55, 0.97, rg);
  let off = 26 * (1 - sstep(0.12, 0.38, rg)) - 210 * dp * sqrt(sqrt(dp));
  const cl = sstep(0.35, 0.65, wvn(ax, az, wx, wz, 2, s + 84));
  off += cl * (wcliff(off, 38) - off);
  h += off * (1 - 0.6 * rf); // reefs keep closer to the light
  // seamounts rising from the deeper regions, the tallest to 12 m under the surface
  const sm = wsea(ax, az, wx, wz, 1, s + 87) * sstep(0.3, 0.6, rg);
  if (sm > 0) h += sm * max(0, -12 - h) + sm * (1 - sm) * 30 * (wfbm(ax, az, lx, lz, 16, 2, s + 88) - 0.5);
  // chasms: winding cracks 80-170 m deep with steep walls, in stretches of the world
  const cm = sstep(0.42, 0.6, wvn(ax, az, lx, lz, 1, s + 89));
  if (cm > 0) { const c = abs(wfbm(ax, az, wx, wz, 2, 3, s + 90) - 0.5); h -= cm * (80 + 90 * wvn(ax, az, lx, lz, 2, s + 91)) * sstep(0.035, 0.016, c); }
  h = max(min(h, -6), -480);
  TB[0] = h;
  return h;
}
// world-space (Float64) entry points
const hAt = (x, z) => { const ax = floor(x / 1024), az = floor(z / 1024); return wheight(ax, az, x - ax * 1024, z - az * 1024); };
const bioAt = (x, z) => { const ax = floor(x / 1024), az = floor(z / 1024); wbio(ax, az, x - ax * 1024, z - az * 1024); };
const hash2 = (x, z, s) => whf(x | 0, z | 0, (WSEED + s) | 0);

// quaternion helpers (return plain arrays; load-time only)
const qAxis = (x, y, z, a) => { const l = hypot(x, y, z) || 1, s = sin(a / 2) / l; return [x * s, y * s, z * s, cos(a / 2)]; };
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qRand = () => { const q = [rr(-1, 1), rr(-1, 1), rr(-1, 1), rr(-1, 1)]; const l = hypot(...q) || 1; return q.map((v) => v / l); };
// shortest rotation taking +Y to n
const qFromY = (nx, ny, nz) => {
  if (ny < -0.9999) return [1, 0, 0, 0];
  const q = [nz, 0, -nx, 1 + ny]; const l = hypot(...q); return q.map((v) => v / l);
};

// ---------------------------------------------------------------- naive surface nets
// D: scalar field (>0 inside), dims nx,ny,nz. Returns grid-space positions + triangle indices.
function surfaceNets(D, nx, ny, nz) {
  let pos = new Float32Array(1 << 20), nv = 0;
  let idx = new Uint32Array(1 << 21), ni = 0;
  const sl = nx * ny;
  let cur = new Int32Array(sl), prev = new Int32Array(sl);
  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      let i0 = nx * (y + ny * z);
      for (let x = 0; x < nx - 1; x++, i0++) {
        const d0 = D[i0], d1 = D[i0 + 1], d2 = D[i0 + nx], d3 = D[i0 + nx + 1];
        const d4 = D[i0 + sl], d5 = D[i0 + sl + 1], d6 = D[i0 + sl + nx], d7 = D[i0 + sl + nx + 1];
        const m = (d0 > 0) | ((d1 > 0) << 1) | ((d2 > 0) << 2) | ((d3 > 0) << 3) | ((d4 > 0) << 4) | ((d5 > 0) << 5) | ((d6 > 0) << 6) | ((d7 > 0) << 7);
        if (m === 0 || m === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0, t;
        if ((d0 > 0) !== (d1 > 0)) { t = d0 / (d0 - d1); sx += t; n++; }
        if ((d2 > 0) !== (d3 > 0)) { t = d2 / (d2 - d3); sx += t; sy += 1; n++; }
        if ((d4 > 0) !== (d5 > 0)) { t = d4 / (d4 - d5); sx += t; sz += 1; n++; }
        if ((d6 > 0) !== (d7 > 0)) { t = d6 / (d6 - d7); sx += t; sy += 1; sz += 1; n++; }
        if ((d0 > 0) !== (d2 > 0)) { t = d0 / (d0 - d2); sy += t; n++; }
        if ((d1 > 0) !== (d3 > 0)) { t = d1 / (d1 - d3); sy += t; sx += 1; n++; }
        if ((d4 > 0) !== (d6 > 0)) { t = d4 / (d4 - d6); sy += t; sz += 1; n++; }
        if ((d5 > 0) !== (d7 > 0)) { t = d5 / (d5 - d7); sy += t; sx += 1; sz += 1; n++; }
        if ((d0 > 0) !== (d4 > 0)) { t = d0 / (d0 - d4); sz += t; n++; }
        if ((d1 > 0) !== (d5 > 0)) { t = d1 / (d1 - d5); sz += t; sx += 1; n++; }
        if ((d2 > 0) !== (d6 > 0)) { t = d2 / (d2 - d6); sz += t; sy += 1; n++; }
        if ((d3 > 0) !== (d7 > 0)) { t = d3 / (d3 - d7); sz += t; sx += 1; sy += 1; n++; }
        if (nv * 3 + 3 > pos.length) { const p2 = new Float32Array(pos.length * 2); p2.set(pos); pos = p2; }
        const vi = nv++;
        pos[vi * 3] = x + sx / n; pos[vi * 3 + 1] = y + sy / n; pos[vi * 3 + 2] = z + sz / n;
        const ci = x + nx * y;
        cur[ci] = vi;
        if (ni + 18 > idx.length) { const i2 = new Uint32Array(idx.length * 2); i2.set(idx); idx = i2; }
        const s0 = d0 > 0;
        let a, b, c, d;
        if ((d1 > 0) !== s0 && y > 0 && z > 0) {
          a = vi; b = cur[ci - nx]; c = prev[ci - nx]; d = prev[ci];
          if (s0) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
          else { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
        }
        if ((d2 > 0) !== s0 && x > 0 && z > 0) {
          a = vi; b = prev[ci]; c = prev[ci - 1]; d = cur[ci - 1];
          if (s0) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
          else { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
        }
        if ((d4 > 0) !== s0 && x > 0 && y > 0) {
          a = vi; b = cur[ci - 1]; c = cur[ci - 1 - nx]; d = cur[ci - nx];
          if (s0) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
          else { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
        }
      }
    }
    const tmp = cur; cur = prev; prev = tmp;
  }
  return { pos: pos.subarray(0, nv * 3), idx: idx.subarray(0, ni), nv, ni };
}

// trilinear sampler factory over a scalar grid (grid coords)
const sampler3 = (D, nx, ny, nz) => (x, y, z) => {
  x = clamp(x, 0, nx - 1.001); y = clamp(y, 0, ny - 1.001); z = clamp(z, 0, nz - 1.001);
  const ix = x | 0, iy = y | 0, iz = z | 0, fx = x - ix, fy = y - iy, fz = z - iz;
  const i = ix + nx * (iy + ny * iz), sl = nx * ny;
  const a = mix(mix(D[i], D[i + 1], fx), mix(D[i + nx], D[i + nx + 1], fx), fy);
  const b = mix(mix(D[i + sl], D[i + sl + 1], fx), mix(D[i + sl + nx], D[i + sl + nx + 1], fx), fy);
  return mix(a, b, fz);
};

// ---------------------------------------------------------------- mesh builder (solid vertex format: f32x3 pos, snorm8x4 normal+aux)
class Mesh {
  constructor() { this.p = []; this.i = []; this.aux = []; }
  v(x, y, z, aux = 1) { this.p.push(x, y, z); this.aux.push(aux); return this.p.length / 3 - 1; }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  // box-section sweep along a polyline; faces get their own vertices (hard edges)
  sweep(pts, w, h, upFn, caps = true) {
    const rings = [];
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], a = pts[max(k - 1, 0)], b = pts[min(k + 1, pts.length - 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2]; const tl = hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const u0 = upFn ? upFn(p, k) : [0, 1, 0];
      let sx = u0[1] * tz - u0[2] * ty, sy = u0[2] * tx - u0[0] * tz, sz = u0[0] * ty - u0[1] * tx; const sl = hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
      const ux = ty * sz - tz * sy, uy = tz * sx - tx * sz, uz = tx * sy - ty * sx;
      const ww = typeof w === 'function' ? w(k) : w, hh = typeof h === 'function' ? h(k) : h;
      const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([e, f]) => [p[0] + sx * e * ww / 2 + ux * f * hh / 2, p[1] + sy * e * ww / 2 + uy * f * hh / 2, p[2] + sz * e * ww / 2 + uz * f * hh / 2]);
      const r = [];
      for (let s = 0; s < 4; s++) { r.push(this.v(...c[s]), this.v(...c[(s + 1) % 4])); }
      rings.push(r);
      if (caps && (k === 0 || k === pts.length - 1)) {
        const q = c.map((cc) => this.v(...cc));
        if (k === 0) this.quad(q[0], q[1], q[2], q[3]); else this.quad(q[3], q[2], q[1], q[0]);
      }
    }
    for (let k = 0; k < rings.length - 1; k++) for (let s = 0; s < 4; s++) {
      const a = rings[k][s * 2], b = rings[k][s * 2 + 1], c = rings[k + 1][s * 2 + 1], d = rings[k + 1][s * 2];
      this.quad(a, d, c, b);
    }
  }
  // round tube along polyline with radius function
  tube(pts, rad, sides = 6, capEnd = true, auxFn = null) {
    const rings = [];
    let ux = 0.31, uy = 0.9, uz = 0.3;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], a = pts[max(k - 1, 0)], b = pts[min(k + 1, pts.length - 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2]; const tl = hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      let sx = uy * tz - uz * ty, sy = uz * tx - ux * tz, sz = ux * ty - uy * tx; const sl = hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
      ux = ty * sz - tz * sy; uy = tz * sx - tx * sz; uz = tx * sy - ty * sx;
      const r = typeof rad === 'function' ? rad(k) : rad, ring = [];
      for (let s = 0; s < sides; s++) { const an = s / sides * TAU; ring.push(this.v(p[0] + (sx * cos(an) + ux * sin(an)) * r, p[1] + (sy * cos(an) + uy * sin(an)) * r, p[2] + (sz * cos(an) + uz * sin(an)) * r, auxFn ? auxFn(k) : min(1, 0.35 + 0.65 * k / (pts.length - 1)))); }
      rings.push(ring);
    }
    for (let k = 0; k < rings.length - 1; k++) for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides; this.quad(rings[k][s], rings[k][s2], rings[k + 1][s2], rings[k + 1][s]);
    }
    if (capEnd) { const e = pts[pts.length - 1], c = this.v(e[0], e[1], e[2], auxFn ? auxFn(pts.length - 1) : 1); const r = rings[rings.length - 1]; for (let s = 0; s < sides; s++) this.tri(r[s], r[(s + 1) % sides], c); }
  }
  // returns {vb: ArrayBuffer, ib: Uint32Array}; normals area-weighted; aux -> normal.w
  build(nrmFn) {
    const n = this.p.length / 3, P = this.p, I = this.i, N = new Float32Array(n * 3);
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const k of [a, b, c]) { N[k] += nx; N[k + 1] += ny; N[k + 2] += nz; }
    }
    const vb = new ArrayBuffer(n * 16), f = new Float32Array(vb), s = new Int8Array(vb);
    for (let k = 0; k < n; k++) {
      let nx = N[k * 3], ny = N[k * 3 + 1], nz = N[k * 3 + 2];
      if (nrmFn) { const q = nrmFn(P[k * 3], P[k * 3 + 1], P[k * 3 + 2], nx, ny, nz); nx = q[0]; ny = q[1]; nz = q[2]; }
      const l = hypot(nx, ny, nz) || 1;
      f[k * 4] = P[k * 3]; f[k * 4 + 1] = P[k * 3 + 1]; f[k * 4 + 2] = P[k * 3 + 2];
      s[k * 16 + 12] = round(nx / l * 127); s[k * 16 + 13] = round(ny / l * 127); s[k * 16 + 14] = round(nz / l * 127); s[k * 16 + 15] = round(clamp(this.aux[k], -1, 1) * 127);
    }
    return { vb, ib: new Uint32Array(I), nv: n };
  }
}

// icosphere with shared vertices
function icosphere(sub, fn) {
  const m = new Mesh(), t = (1 + sqrt(5)) / 2;
  let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => { const l = hypot(...v); return v.map((c) => c / l); });
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const cache = new Map(), F2 = [];
    const mid = (a, b) => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let r = cache.get(key);
      if (r === undefined) { const p = [0, 1, 2].map((k) => V[a][k] + V[b][k]); const l = hypot(...p); V.push(p.map((c) => c / l)); r = V.length - 1; cache.set(key, r); }
      return r;
    };
    for (const [a, b, c] of F) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); F2.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    F = F2;
  }
  for (const v of V) { const p = fn ? fn(v[0], v[1], v[2]) : v; m.v(p[0], p[1], p[2]); }
  for (const f of F) m.tri(f[0], f[1], f[2]);
  return m;
}
