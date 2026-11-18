// ============================================================================
// WGSL sources
// ============================================================================
// Coordinate spaces shared by every file:
//  * world: Float64, CPU only (F[CX..CZ]); y is depth with the sea surface at y = 0
//  * render space: x and z relative to the camera, y absolute, so the camera sits at (0, camY, 0). Every vertex,
//    instance, light and fog computation on the GPU happens here; nothing is ever far from the origin. y needs no
//    shift because the dive is bounded vertically (-180 .. 0 m), where f32 keeps sub-millimetre precision.
//  * wrapped world, WP(p): render space + (camX mod 1024, 0, camZ mod 1024). Repeating textures (caustics, rock
//    detail, surface ripples) and sway phases are looked up here. Every such frequency is k / 1024 per metre with
//    k an integer, so nothing jumps when the wrap steps by 1024 m.
//  * anchored world (A, l): integer 1024 m cell + f32 local offset, for the world noise (W_WORLD / math.js).
//
// Buffer layouts (all WGSL structs keep the 16-byte uniform alignment rules: only vec4 / mat4 / arrays of vec4):
//  G   uniform 288 B: vp mat4 | sm mat4 | cam (0, camY, 0, time) | right (xyz, tanX) | up (xyz, tanY) |
//      fwd (xyz, near) | sun (dir, grotto zone at camera) | res (W, H, 1/W, 1/H; W = 0 marks the shadow pass) |
//      mis (exposure, ray gain, detail scale, 0) | wrap (camX mod 1024, camZ mod 1024, camX mod 44, camZ mod 44) |
//      fog (far, distance scale, 0, 0) | wat (water colour of the biomes around the camera, murk)   = 288 B
//  LVU uniform 128 B: o[8] per clipmap level (corner x, corner z in render space, spacing, texture layer)
//  WT  uniform 1088 B: sch[16] | man[8] | vent[16] | jel[8] | tur[8] | lev[4] | sq[8] (render-space xyz + fade / column height)
//  records (storage, 64 B each, PER per tile slot): a (tile-local x, y, tile-local z, size) | b | c | d
//  visible lists: KV kelp columns 2 x vec4 | TV tuft clumps 2 x vec4 | SV solids 4 x vec4 (= vertex layout)
//  ARG indirect args, 8 u32 per list slot (draw or drawIndexed, instanceCount at +1) | CNT one u32 per list
const CM = TQ.M, CML = TQ.L;
const KCAP = TQ.kcap, KBASE = KCAP.map((_, i) => KCAP.slice(0, i).reduce((a, b) => a + b, 0)), KTOT = KCAP.reduce((a, b) => a + b, 0);
const KINC = [TQ.B, TQ.B, TQ.B / 2, TQ.G, TQ.B / 2];

const W_NOISE3 = /*wgsl*/`
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn h31(p: vec3f) -> f32 { var q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
fn h33(p: vec3f) -> vec3f { var q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yxz + 33.33); return fract((q.xxy + q.yxx) * q.zyx); }
`;

// ---------------------------------------------------------------- world noise: mirror of math.js (wheight & co)
const W_WORLD = /*wgsl*/`
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn hu(x: i32, z: i32, s: u32) -> u32 {
  var h = (bitcast<u32>(x) * 0x8da6b343u) ^ (bitcast<u32>(z) * 0xd8163841u) ^ (s * 0xcb1ab31fu);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  return h ^ (h >> 16u);
}
fn hf(x: i32, z: i32, s: u32) -> f32 { return f32(hu(x, z, s) >> 8u) / 16777216.; }
fn vn(A: vec2i, l: vec2f, n: i32, s: u32) -> f32 {
  let p = l * (f32(n) / 1024.); let fl = floor(p); var u = p - fl; u = u * u * (3. - 2. * u);
  let i = A * n + vec2i(fl);
  let a = hf(i.x, i.y, s); let b = hf(i.x + 1, i.y, s); let c = hf(i.x, i.y + 1, s); let d = hf(i.x + 1, i.y + 1, s);
  let e = a + (b - a) * u.x; let f = c + (d - c) * u.x;
  return e + (f - e) * u.y;
}
fn fbm(A: vec2i, l: vec2f, n0: i32, o: i32, s: u32) -> f32 {
  var a = .5; var t = 0.; var n = n0;
  for (var k = 0; k < o; k++) { t += a * vn(A, l, n, s + u32(k) * 7919u); n *= 2; a *= .5; }
  return t / (1. - 2. * a);
}
fn wor(A: vec2i, l: vec2f, n: i32, s: u32) -> vec2f {
  let p = l * (f32(n) / 1024.); let fl = floor(p); let f = p - fl; let i = A * n + vec2i(fl);
  var d1 = 9.; var d2 = 9.;
  for (var z = -1; z <= 1; z++) { for (var x = -1; x <= 1; x++) {
    let c = i + vec2i(x, z);
    let o = vec2f(f32(x) + hf(c.x, c.y, s), f32(z) + hf(c.x, c.y, s + 1u)) - f;
    let d = dot(o, o);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  } }
  return sqrt(vec2f(d1, d2));
}
fn cliff(y: f32, st: f32) -> f32 { let k = y / st; let f = floor(k); return (f + ss(.86, 1., k - f)) * st; }
fn fdiv(a: i32, m: i32) -> i32 { return select(a / m, (a - m + 1) / m, a < 0); }
// value noise on m x 1024 m cells (math.js wvnL)
fn vnL(A: vec2i, l: vec2f, m: i32, s: u32) -> f32 {
  let bc = vec2i(fdiv(A.x, m), fdiv(A.y, m)); let L = f32(m) * 1024.;
  let gp = vec2f(A - bc * m) * 1024. + l; let o = floor(gp / L); var u = gp / L - o; u = u * u * (3. - 2. * u);
  let i = bc + vec2i(o);
  let a = hf(i.x, i.y, s); let b = hf(i.x + 1, i.y, s); let c = hf(i.x, i.y + 1, s); let d = hf(i.x + 1, i.y + 1, s);
  let e = a + (b - a) * u.x; let f = c + (d - c) * u.x;
  return e + (f - e) * u.y;
}
// seamounts (math.js wsea)
fn sea(A: vec2i, l: vec2f, n: i32, s: u32) -> f32 {
  let p = l * (f32(n) / 1024.); let fl = floor(p); let f = p - fl; let i = A * n + vec2i(fl);
  var m = 0.;
  for (var z = -1; z <= 1; z++) { for (var x = -1; x <= 1; x++) {
    let c = i + vec2i(x, z);
    if (hf(c.x, c.y, s + 2u) < .4) {
      let o = vec2f(f32(x) + .15 + .7 * hf(c.x, c.y, s), f32(z) + .15 + .7 * hf(c.x, c.y, s + 1u)) - f;
      let d = length(o) / (.55 + .35 * hf(c.x, c.y, s + 3u));
      if (d < 1.) { let t = 1. - ss(0., 1., d); m = max(m, (.45 + .55 * hf(c.x, c.y, s + 4u)) * t * sqrt(t)); }
    }
  } }
  return m;
}
fn terrace(y: f32, st: f32) -> f32 { let k = y / st; let f = floor(k); return (f + ss(.5, 1., k - f)) * st; }
// Worley F1 / F2 plus the integer cells of the two nearest points
struct WR { d: vec2f, c1: vec2i, c2: vec2i };
fn worc(A: vec2i, l: vec2f, n: i32, s: u32) -> WR {
  let p = l * (f32(n) / 1024.); let fl = floor(p); let f = p - fl; let i = A * n + vec2i(fl);
  var r: WR; r.d = vec2f(9.);
  for (var z = -1; z <= 1; z++) { for (var x = -1; x <= 1; x++) {
    let c = i + vec2i(x, z);
    let o = vec2f(f32(x) + hf(c.x, c.y, s), f32(z) + hf(c.x, c.y, s + 1u)) - f;
    let d = dot(o, o);
    if (d < r.d.x) { r.d.y = r.d.x; r.c2 = r.c1; r.d.x = d; r.c1 = c; } else if (d < r.d.y) { r.d.y = d; r.c2 = c; }
  } }
  r.d = sqrt(r.d);
  return r;
}
// biome weights: a = kelp, grotto, trench, plains; b = reef, crystal, volcanic, -
struct BW { a: vec4f, b: vec4f };
fn bid(c: vec2i, s: u32) -> i32 {
  let r = hf(c.x, c.y, s + 73u);
  return select(select(select(select(select(select(6, 5, r < .87), 4, r < .74), 3, r < .6), 2, r < .46), 1, r < .32), 0, r < .19);
}
fn oh(i: i32, w: f32) -> BW { var o: BW; o.a = vec4f(f32(i == 0), f32(i == 1), f32(i == 2), f32(i == 3)) * w; o.b = vec4f(f32(i == 4), f32(i == 5), f32(i == 6), 0.) * w; return o; }
// warped ~512 m Voronoi regions, one biome each; soft Voronoi over the 9 nearby regions (math.js wbio), so borders
// blend over ~250 m and three regions meet without a seam
fn biomes(A: vec2i, l: vec2f, s: u32) -> BW {
  let q = l + (vec2f(fbm(A, l, 4, 3, s + 71u), fbm(A, l, 4, 3, s + 72u)) - .5) * 260.;
  let p = q * (2. / 1024.); let fl = floor(p); let f = p - fl; let i = A * 2 + vec2i(fl);
  var D: array<f32, 9>; var d1 = 9.;
  for (var j = 0; j < 9; j++) {
    let c = i + vec2i(j % 3 - 1, j / 3 - 1);
    let o = vec2f(f32(j % 3 - 1) + hf(c.x, c.y, s + 74u), f32(j / 3 - 1) + hf(c.x, c.y, s + 75u)) - f;
    D[j] = length(o); d1 = min(d1, D[j]);
  }
  var o: BW; o.a = vec4f(0.); o.b = vec4f(0.); var sum = 0.;
  for (var j = 0; j < 9; j++) {
    let w = ss(.5, 0., D[j] - d1);
    let c = i + vec2i(j % 3 - 1, j / 3 - 1);
    let e = oh(bid(c, s), w); o.a += e.a; o.b += e.b; sum += w;
  }
  o.a /= sum; o.b /= sum;
  return o;
}
struct HB { h: f32, a: vec4f, b: vec4f };
// seabed height h(x, z) and the biome weights
fn terrain(A: vec2i, l: vec2f, s: u32) -> HB {
  let B = biomes(A, l, s);
  let q = l + (vec2f(fbm(A, l, 8, 2, s + 5u), fbm(A, l, 8, 2, s + 6u)) - .5) * 36.;
  let base = -46. + 10. * (fbm(A, l, 4, 4, s + 1u) - .5) + 2.4 * (fbm(A, q, 32, 3, s + 2u) - .5);
  var h = 0.;
  if (B.a.x > 0.) { let r = 1. - abs(2. * fbm(A, q, 16, 3, s + 3u) - 1.); h += B.a.x * (base + 3. + 8. * ss(.62, .95, r) + .9 * (fbm(A, l, 128, 2, s + 4u) - .5)); }
  if (B.a.y > 0.) { let w = wor(A, q, 16, s + 9u); h += B.a.y * (base - 14. + terrace(22. * (1. - ss(0., .3, w.y - w.x)), 4.) + 5. * (1. - ss(0., .75, w.x))); }
  if (B.a.z > 0.) { let w = wor(A, q, 8, s + 13u); let e = w.y - w.x; h += B.a.z * (base + terrace(16. * ss(.3, .55, e) - 40. * (1. - ss(.04, .32, e)), 5.) + 1.2 * (fbm(A, l, 64, 2, s + 14u) - .5)); }
  if (B.a.w > 0.) { h += B.a.w * (base - 5. + 1.6 * (fbm(A, l, 32, 2, s + 15u) - .5)); }
  if (B.b.x > 0.) { let w = wor(A, q, 32, s + 21u); let ch = 1. - ss(0., .07, abs(fbm(A, q, 8, 2, s + 22u) - .5)); h += B.b.x * (-19. + 5. * (fbm(A, l, 16, 3, s + 23u) - .5) + 4. * (1. - ss(0., .6, w.x)) - 6. * ch); }
  if (B.b.y > 0.) { let r = 1. - abs(2. * fbm(A, q, 16, 3, s + 25u) - 1.); h += B.b.y * (base - 3. + 10. * pow(r, 2.5)); }
  if (B.b.z > 0.) { let w = wor(A, q, 8, s + 27u); h += B.b.z * (base - 22. + 26. * pow(1. - ss(0., .55, w.x), 1.6) - 7. * (1. - ss(0., .1, w.x)) + 1.5 * (fbm(A, l, 64, 2, s + 28u) - .5)); }
  let pm = ss(.55, .7, fbm(A, l, 4, 2, s + 17u));
  if (pm > 0. && B.a.w + B.a.x > 0.) { let w = wor(A, q, 32, s + 19u); h += (B.a.w + .6 * B.a.x) * pm * 16. * pow(1. - ss(0., .38, w.x), 2.5); }
  // large-scale depth: shelves, abyssal plains, cliff steps, seamounts, chasms (math.js wheight)
  let w2 = l + (vec2f(fbm(A, l, 2, 2, s + 85u), fbm(A, l, 2, 2, s + 86u)) - .5) * 320.;
  let rg = ss(.2, .8, .55 * vnL(A, w2, 6, s + 81u) + .3 * vnL(A, w2, 2, s + 82u) + .15 * vn(A, w2, 1, s + 83u));
  let dp = ss(.55, .97, rg);
  var off = 26. * (1. - ss(.12, .38, rg)) - 210. * dp * sqrt(sqrt(dp));
  let cl = ss(.35, .65, vn(A, w2, 2, s + 84u));
  off += cl * (cliff(off, 38.) - off);
  h += off * (1. - .6 * B.b.x);
  let sm = sea(A, w2, 1, s + 87u) * ss(.3, .6, rg);
  if (sm > 0.) { h += sm * max(0., -12. - h) + sm * (1. - sm) * 30. * (fbm(A, l, 16, 2, s + 88u) - .5); }
  let cm = ss(.42, .6, vn(A, l, 1, s + 89u));
  if (cm > 0.) { let c = abs(fbm(A, w2, 2, 3, s + 90u) - .5); h -= cm * (80. + 90. * vn(A, l, 2, s + 91u)) * ss(.035, .016, c); }
  var o: HB; o.h = clamp(h, -480., -6.); o.a = B.a; o.b = B.b;
  return o;
}
fn hgt(A: vec2i, l: vec2f, s: u32) -> f32 { return terrain(A, l, s).h; }
// x: magenta ground cover, y: rippled / coral sand
fn cover(A: vec2i, l: vec2f, s: u32, T: HB) -> vec2f {
  let mag = T.a.y * ss(.36, .5, fbm(A, l, 32, 3, s + 21u)) + T.a.x * .35 * ss(.62, .72, fbm(A, l, 16, 2, s + 22u));
  let sand = ss(.4, .6, fbm(A, l, 16, 3, s + 8u)) * (T.a.w + T.a.x * .6 + T.a.z * .3 + T.b.y * .15) + T.b.x * ss(.3, .55, fbm(A, l, 16, 2, s + 24u));
  return vec2f(mag, sand);
}
fn rn(s: ptr<function, u32>) -> f32 {
  *s = *s * 747796405u + 2891336453u;
  var w = ((*s >> ((*s >> 28u) + 4u)) ^ *s) * 277803737u; w = (w >> 22u) ^ w;
  return f32(w >> 8u) / 16777216.;
}
`;

// ---------------------------------------------------------------- clipmap update (compute): one level per job
// Texel (i, j) of layer L holds the seabed at the level's corner + (i, j) * spacing: rgba32f (h, normal x, normal z,
// occlusion), rgba8 (magenta cover, sand, grotto, volcanic) and rgba8 (reef, crystal, kelp, plains). Levels are
// recomputed only when their snapped origin moves.
const W_CLIP = W_WORLD + /*wgsl*/`
struct CL { seed: u32, n: u32, m: u32, p: u32, job: array<vec4i, 8>, org: array<vec4f, 8> };
@group(0) @binding(0) var<uniform> u: CL;
@group(0) @binding(1) var oH: texture_storage_2d_array<rgba32float, write>;
@group(0) @binding(2) var oB: texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(3) var oX: texture_storage_2d_array<rgba8unorm, write>;
fn hh(A: vec2i, l: vec2f) -> f32 { return hgt(A, l, u.seed); }
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x > u.m || id.y > u.m || id.z >= u.n) { return; }
  let j = u.job[id.z]; let o = u.org[id.z]; let A = j.yz; let s = o.z;
  let l = o.xy + vec2f(id.xy) * s;
  let T = terrain(A, l, u.seed);
  let e = max(s, .5); let r = max(9., s * 2.);
  // neighbours: +x, -x, +z, -z at e (normal), then at r (occlusion). One call site in a loop whose length comes from
  // the uniform: terrain() is large, and mobile compilers (Mali) fail on a shader with many inlined copies of it.
  var nb: array<f32, 8>;
  for (var k = 0u; k < min(u.m, 8u); k++) {
    let d = select(e, r, k >= 4u) * select(1., -1., (k & 1u) == 1u);
    nb[k] = hh(A, l + select(vec2f(d, 0.), vec2f(0., d), (k & 2u) == 2u));
  }
  let gx = nb[0] - nb[1]; let gz = nb[2] - nb[3];
  let n = normalize(vec3f(-gx, 2. * e, -gz));
  let av = (nb[4] + nb[5] + nb[6] + nb[7]) * .25;
  let occ = clamp(.62 + (T.h - av) / 9., 0., 1.);
  textureStore(oH, id.xy, j.x, vec4f(T.h, n.x, n.z, occ));
  let c = cover(A, l, u.seed, T);
  textureStore(oB, id.xy, j.x, vec4f(c.x, c.y, T.a.y, T.b.z));
  textureStore(oX, id.xy, j.x, vec4f(T.b.x, T.b.y, T.a.x, T.a.w));
}
`;

// ---------------------------------------------------------------- population (compute): fills newly entered tiles
// One job per tile (slot in the NT x NT ring, tile coordinates), one thread per record. Records are deterministic
// in (seed, tile, index), so a tile that leaves and comes back is rebuilt identically.
const W_POP = W_WORLD + /*wgsl*/`
struct PU { seed: u32, n: u32, capT: u32, lowq: u32, far: vec4f, job: array<vec4i, 64> };
@group(0) @binding(0) var<uniform> u: PU;
@group(0) @binding(1) var<storage, read_write> R: array<vec4f>;
const TAU = 6.2831853;
const PER = ${PER}u; const TOFF = ${TOFF}u; const SOFF = ${SOFF}u;
fn qmul(a: vec4f, b: vec4f) -> vec4f { return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz)); }
fn qaxis(v: vec3f, a: f32) -> vec4f { return vec4f(v * sin(a * .5), cos(a * .5)); }
fn qfromy(n: vec3f) -> vec4f { if (n.y < -.9999) { return vec4f(1., 0., 0., 0.); } return normalize(vec4f(n.z, 0., -n.x, 1. + n.y)); }
fn qrand(s: ptr<function, u32>) -> vec4f { return normalize(vec4f(rn(s), rn(s), rn(s), rn(s)) * 2. - 1. + vec4f(1e-4)); }
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= PER || id.y >= u.n) { return; }
  let j = u.job[id.y]; let tx = j.y; let tz = j.z;
  let A = vec2i(tx >> 5u, tz >> 5u);
  let lb = vec2f(f32(tx & 31), f32(tz & 31)) * 32.;
  var st = hu(tx, tz, u.seed ^ (i * 0x9E3779B9u));
  let o = (u32(j.x) * PER + i) * 4u;
  var a = vec4f(0.); var b = vec4f(0., 0., 0., 1.); var c = vec4f(0.); var d = vec4f(0.);
  // the record's spot: kelp on a jittered 7 x 7 grid, everything else anywhere in the tile; then its seabed and, for
  // kelp and solids, the slope (one terrain() and one hgt() call site: see W_CLIP)
  let kelp = i < TOFF;
  var lp = vec2f(rn(&st), rn(&st));
  if (kelp) { lp = (vec2f(f32(i % 7u), f32(i / 7u)) + .15 + .7 * lp) * (32. / 7.); } else { lp *= 32.; }
  let l = lb + lp; let T = terrain(A, l, u.seed);
  let ge = select(.7, 1., kelp); var gr = vec2f(0.);
  let ng = select(2u, 0u, i >= TOFF && i < SOFF);
  for (var k = 0u; k < ng; k++) { gr[k] = hgt(A, l + select(vec2f(ge, 0.), vec2f(0., ge), k == 1u), u.seed) - T.h; }
  if (kelp) {
    // kelp column on a jittered 7 x 7 grid: brown-gold in the forests, purple in the grottos, crimson in deep
    // canyons and around the vents
    let dens = (T.a.x * (.6 + .4 * ss(.4, .6, fbm(A, l, 16, 2, u.seed + 31u))) + T.a.y * .42 + T.a.z * .12 + T.a.w * .07 + T.b.x * .05 + T.b.z * .07 + T.b.y * .03) * (.3 + .7 * ss(-230., -110., T.h));
    if (rn(&st) < dens) {
      let gx = gr.x; let gz = gr.y;
      let H = min(mix(15., 40., rn(&st)) * (.75 + .4 * T.a.x), -T.h - 2.);
      if (gx * gx + gz * gz < .5 && H > 6.) {
        let r = rn(&st); var kind = 0.;
        if (T.a.y > .45 && r < .6) { kind = 1.; } else if (T.b.z > .4 || (T.a.z > .4 && T.h < -60.)) { kind = 3.; } else if (r < .04) { kind = 2.; }
        a = vec4f(lp.x, T.h - .3, lp.y, H); b = vec4f(kind, mix(.55, 1.3, rn(&st)), rn(&st), 0.); d = vec4f(0., 1., T.a.y, 0.);
      }
    }
  } else if (i < SOFF) {
    // ground cover clump: magenta carpet, teal / purple fronds, kelp-floor grass, reef anemones and fronds,
    // sparse seagrass on the plains and crystal fields (nothing grows on the vents)
    let cv = cover(A, l, u.seed, T);
    let r = rn(&st); var ty = -1.; var rad = .55;
    let pm = cv.x * .95; let pr = pm + T.b.x * .8; let pg = pr + T.a.y * .32; let pk = pg + T.a.x * (.12 + .3 * ss(.4, .6, fbm(A, l, 32, 2, u.seed + 41u)));
    let pp = pk + T.a.w * .14 + T.a.z * .12 + T.b.y * .08;
    if (r < pm) { ty = 5.; }
    else if (r < pr) { let k = rn(&st); ty = select(select(select(2., 7., k < .7), 5., k < .45), 6., k < .25); rad = .6; }
    else if (r < pg) { ty = select(7., 3., rn(&st) < .35); rad = .5; } else if (r < pk) { ty = 2.; rad = .5; } else if (r < pp) { ty = select(0., 7., T.b.y > .5); rad = .7; }
    if (ty >= 0.) { a = vec4f(lp.x, T.h, lp.y, rad); b = vec4f(ty, rn(&st), 0., 0.); d = vec4f(1., 1., T.a.y, 0.); }
  } else {
    let k = i - SOFF;
    let gx = gr.x; let gz = gr.y;
    let n = normalize(vec3f(-gx, .7, -gz));
    let vo = T.b.z;
    if (k < ${NROCK}u) {
      // loose rocks: more of them in canyons, kelp, crystal fields and around the vents (basalt there)
      if (rn(&st) < .14 + .5 * T.a.z + .3 * T.a.x + .25 * T.a.y + .4 * vo + .3 * T.b.y + .1 * T.b.x) {
        var sc = .3 + 2.2 * pow(rn(&st), 2.6);
        if (n.y > .85 && rn(&st) < .6) { sc *= .5; }
        let fd = select(u.far.x, u.far.y, sc < .5);
        a = vec4f(lp.x - n.x * sc * .3, T.h - n.y * sc * .3, lp.y - n.z * sc * .3, sc);
        b = qrand(&st); c = vec4f(1., rn(&st), 1., 0.); d = vec4f(floor(rn(&st) * 3.999), 1. + vo, T.a.y, fd);
      }
    } else if (k < ${NROCK + NPROP}u) {
      // sponges and corals (reefs are covered in them), glowing mushrooms in grottos, crystal clusters, vent chimneys
      let cl = ss(.45, .62, fbm(A, l, 32, 2, u.seed + 51u));
      let p = T.a.y * .95 + T.a.x * .45 + T.a.z * .35 + T.a.w * .12 + T.b.y * .9 + vo * .6;
      if (rn(&st) < p * (.3 + .7 * cl) + T.b.x * .95) {
        let r = rn(&st);
        var kind = 0.; var mat = 5.; var lift = .9;
        if (T.b.y > .4 && r < .75) { kind = 19.; mat = 7.; lift = 2.; }                              // crystal cluster
        else if (vo > .4 && r < .8) { kind = 20.; mat = 8.; lift = 6.; }                             // vent chimney
        else if (T.a.y > .35 && r < .32) { kind = 18.; mat = 6.; lift = 4.; }                        // glowing mushrooms
        else if (r < .44) { kind = 7.; } else if (r < .55) { kind = 8.; }                            // branching coral, sea fan
        else if (r < .67) { kind = 16.; lift = 3.; } else if (r < .78) { kind = 17.; lift = 1.4; }  // table coral, brain coral
        else if (r < .83) { kind = 9.; mat = 4.; lift = 1.1; }                                       // tube sponge
        else { kind = 4. + floor(rn(&st) * 2.999); mat = 4.; lift = 1.1; }                           // barrel / vase sponges
        let up = normalize(n + vec3f(0., lift, 0.));
        let q = qmul(qfromy(up), qaxis(vec3f(0., 1., 0.), rn(&st) * TAU));
        var sc = mix(.5, 1.5, rn(&st));
        if (mat == 4.) { sc = mix(.35, .9, rn(&st)) * select(1., 1.6, rn(&st) < .1); }
        else if (kind == 16.) { sc = mix(.6, 1.9, rn(&st)); } else if (kind == 17.) { sc = mix(.35, 1.1, rn(&st)); }
        else if (kind == 18.) { sc = mix(.3, 1.2, pow(rn(&st), 1.5)); } else if (kind == 19.) { sc = mix(.4, 1.6, pow(rn(&st), 1.4)); }
        else if (kind == 20.) { sc = mix(.35, 1.1, rn(&st)); }
        let hue = fract(hf(A.x * 128 + i32(floor(l.x / 8.)), A.y * 128 + i32(floor(l.y / 8.)), u.seed + 61u) + (rn(&st) - .5) * .06);
        a = vec4f(lp.x - up.x * .12 * sc, T.h - up.y * .12 * sc, lp.y - up.z * .12 * sc, sc);
        b = q; c = vec4f(mat, hue, 1., 0.); d = vec4f(kind, 1. + vo, T.a.y, u.far.z);
      }
    } else {
      // floating boulders above the canyons, bobbing slowly
      if (rn(&st) < T.a.z * .5 + .015) {
        var sc = mix(.35, 1.5, rn(&st));
        if (rn(&st) < .12) { sc = mix(1.8, 3.2, rn(&st)); }
        let y = min(T.h + mix(5., 22., rn(&st)), -3. - sc);
        a = vec4f(lp.x, y, lp.y, sc); b = qrand(&st); c = vec4f(1., rn(&st), 1., mix(.12, .4, rn(&st))); d = vec4f(floor(rn(&st) * 3.999), 1., T.a.y, u.far.x);
      }
    }
  }
  R[o] = a; R[o + 1u] = b; R[o + 2u] = c; R[o + 3u] = d;
}
`;

// ---------------------------------------------------------------- visibility (compute): frustum + distance culling into indirect draws
// One workgroup per tile slot. Tiles outside the frustum / draw distance leave at once; the rest test every live
// record and append it to its list with an atomic counter, bumping the instanceCount of that list's indirect args.
const W_CULL = /*wgsl*/`
struct CU { pl: array<vec4f, 6>, cam: vec4f, dk: vec4f, ds: vec4f, sh: vec4f };
@group(0) @binding(0) var<uniform> u: CU;
@group(0) @binding(1) var<storage, read> T: array<vec4f>;
@group(0) @binding(2) var<storage, read> R: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> KV: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> TV: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> SV: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> ARG: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> CNT: array<atomic<u32>>;
var<private> KC: array<u32, 5> = array<u32, 5>(${KCAP.map((v) => v + 'u').join(', ')});
var<private> KB: array<u32, 5> = array<u32, 5>(${KBASE.map((v) => v + 'u').join(', ')});
var<private> KI: array<u32, 5> = array<u32, 5>(${KINC.map((v) => v + 'u').join(', ')});
fn vis(c: vec3f, r: f32) -> bool {
  for (var k = 0; k < 6; k++) { if (dot(u.pl[k].xyz, c) + u.pl[k].w < -r) { return false; } }
  return true;
}
fn addK(l: u32, p: vec3f, a: vec4f, b: vec4f) {
  let k = atomicAdd(&CNT[l], 1u);
  if (k < KC[l]) { let w = (KB[l] + k) * 2u; KV[w] = vec4f(p, a.w); KV[w + 1u] = b; atomicAdd(&ARG[l * 8u + 1u], KI[l]); }
}
fn addS(kind: u32, a: vec4f, b: vec4f, c: vec4f, d: vec4f) {
  let k = atomicAdd(&CNT[6u + kind], 1u);
  if (k < ${TQ.scap}u) { let w = (kind * ${TQ.scap}u + k) * 4u; SV[w] = a; SV[w + 1u] = b; SV[w + 2u] = c; SV[w + 3u] = d; atomicAdd(&ARG[(6u + kind) * 8u + 1u], 1u); }
}
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let t = T[wg.x];
  if (t.z < .5) { return; }
  let o = t.xy;
  let cc = vec3f(o.x + 16., -60., o.y + 16.);
  let td = length(max(abs(cc.xz) - 16., vec2f(0.)));
  let shOn = u.sh.w > .5 && all(abs(cc.xz - u.sh.xy) < vec2f(u.sh.z + 16.));
  if (!shOn && (td > u.ds.z || !vis(cc, 72.))) { return; }
  for (var i = li; i < ${PER}u; i += 64u) {
    let b0 = (wg.x * ${PER}u + i) * 4u;
    let d = R[b0 + 3u];
    if (d.y < .5) { continue; }
    let a = R[b0]; let b = R[b0 + 1u];
    let p = vec3f(o.x + a.x, a.y, o.y + a.z);
    if (i < ${TOFF}u) {
      let dh = length(p.xz);
      if (shOn && all(abs(p.xz - u.sh.xy) < vec2f(u.sh.z))) { addK(4u, p, a, b); }
      if (dh < u.dk.z && vis(p + vec3f(0., a.w * .5, 0.), a.w * .5 + 4.)) {
        addK(select(select(2u, 1u, dh < u.dk.y), 0u, dh < u.dk.x), p, a, b);
        if (dh < u.ds.w) { addK(3u, p, a, b); }
      }
    } else if (i < ${SOFF}u) {
      if (length(p - u.cam.xyz) < u.dk.w && vis(p, a.w + 1.5)) {
        let k = atomicAdd(&CNT[5], 1u);
        if (k < ${TQ.tcap}u) { TV[k * 2u] = vec4f(p, a.w); TV[k * 2u + 1u] = b; atomicAdd(&ARG[41], ${TQ.K}u); }
      }
    } else {
      let c = R[b0 + 2u];
      var kind = u32(d.x); let dist = length(p - u.cam.xyz);
      if (dist < d.w * u.cam.w && vis(p, a.w * 1.9 + c.w)) {
        if (kind < 4u && dist > u.ds.x) { kind += 10u; }
        if ((kind == 7u || kind == 8u) && dist > u.ds.y) { kind += 7u; }
        addS(kind, vec4f(p, a.w), b, c, d);
      }
    }
  }
}
`;

// ---------------------------------------------------------------- fullscreen helpers
const W_FS = /*wgsl*/`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0., 1.); }
`;

// rock detail texture (tileable): rg = slope, b = height, a = mottling
const W_DETAIL = W_NOISE3 + W_FS + /*wgsl*/`
fn hp(p: vec2f, per: f32) -> f32 { return h31(vec3f(p - per * floor(p / per), per)); }
fn tn(p: vec2f, per: f32) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(hp(i, per), hp(i + vec2f(1., 0.), per), u.x), mix(hp(i + vec2f(0., 1.), per), hp(i + vec2f(1., 1.), per), u.x), u.y);
}
fn tf(uv: vec2f, per: f32, n: i32) -> f32 { var a = .5; var s = 0.; var pr = per; for (var i = 0; i < n; i++) { s += a * tn(uv * pr + f32(i) * 7.3, pr); pr *= 2.; a *= .5; } return s / (1. - 2. * a); }
fn tw(p: vec2f, per: f32) -> vec3f {
  let i = floor(p); let f = fract(p); var d = vec2f(9.); var id = 0.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) {
    let o = vec2f(f32(x), f32(y)); let c = i + o; let cw = c - per * floor(c / per);
    let hh = h33(vec3f(cw, per)); let r = o + hh.xy - f; let l = dot(r, r);
    if (l < d.x) { d.y = d.x; d.x = l; id = hh.z; } else if (l < d.y) { d.y = l; }
  } }
  return vec3f(sqrt(d), id);
}
fn H(uv: vec2f) -> f32 {
  let wq = uv + .11 * (vec2f(tf(uv, 3., 4), tf(uv + .5, 3., 4)) - .5);
  let f = tf(wq, 3., 8);
  let r1 = 1. - abs(tf(wq + 1.7, 5., 6) * 2. - 1.);
  let cr = min(abs(tf(wq + 4.1, 4., 5) * 2. - 1.) * 7., 1.);
  let cr2 = min(abs(tf(wq.yx + 2.3, 9., 4) * 2. - 1.) * 9., 1.);
  let pt = tw(wq * 29., 29.);
  let pit = (1. - ss(.0, .34, pt.x)) * step(.62, pt.z);
  return f * .50 + r1 * r1 * .24 + cr * cr2 * .26 - pit * .07;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / ${DTX}.; let e = 1. / ${DTX}.;
  let h = H(uv);
  let gx = H(uv + vec2f(e, 0.)) - H(uv - vec2f(e, 0.)); let gy = H(uv + vec2f(0., e)) - H(uv - vec2f(0., e));
  let s = clamp(vec2f(gx, gy) * ${DTX}. * .5 * .075, vec2f(-1.), vec2f(1.));
  return vec4f(-s * .5 + .5, h, tf(uv + 3.7, 3., 5));
}
`;

// blit / mip / bloom chain
const W_BLIT = W_FS + /*wgsl*/`
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
fn uvOf(fc: vec4f, k: f32) -> vec2f { return fc.xy * k / vec2f(textureDimensions(t)); }
@fragment fn fsMip(@builtin(position) fc: vec4f) -> @location(0) vec4f { return textureSampleLevel(t, s, uvOf(fc, 2.), 0.); }
fn kar(c: vec3f) -> vec4f { let w = 1. / (1. + max(c.r, max(c.g, c.b))); return vec4f(c * w, w); }
@fragment fn fsDown0(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  let a = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.).rgb, vec3f(24.)));
  let b = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.).rgb, vec3f(24.)));
  let c = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.).rgb, vec3f(24.)));
  let d = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.).rgb, vec3f(24.)));
  let m = a + b + c + d;
  return vec4f(m.rgb / m.a, 1.);
}
@fragment fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
@fragment fn fsUp(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, .5); let e = .75 / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
`;

// animated water texture: r = caustic, ba = surface slope
const W_WATER = W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> tm: vec4f;
fn caus(uv: vec2f, t: f32) -> f32 {
  let p = uv * 6.2831853;
  var i = p; var c = 0.;
  for (var n = 1; n <= 5; n++) {
    let tt = t * (1. - 3.5 / f32(n));
    i = p + vec2f(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    let s = sin(i.x + tt); let k = cos(i.y + tt);
    c += abs(s * k) / (1.25 * sqrt(s * s + k * k) + 1e-4);
  }
  c = 1.17 - pow(c / 5., 1.4);
  return pow(abs(c), 8.);
}
const WK = array<vec3f, 10>(vec3f(1., 2., 1.), vec3f(-2., 1., .9), vec3f(3., 1., .6), vec3f(1., -4., .5), vec3f(4., 3., .4),
  vec3f(-3., 5., .32), vec3f(6., -2., .28), vec3f(5., 7., .2), vec3f(-8., 3., .18), vec3f(2., 11., .14));
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / ${WATER}.; let t = tm.x;
  let c = caus(uv, t * .45 + 23.);
  let wu = uv + .02 * vec2f(sin(6.2831853 * (uv.y * 2. + .1 * t)), cos(6.2831853 * (uv.x * 3. - .07 * t)));
  var s = vec2f(0.);
  for (var i = 0; i < 10; i++) {
    let k = WK[i];
    s += k.xy * k.z * cos(dot(k.xy, wu) * 6.2831853 + t * (.5 + .35 * sqrt(length(k.xy))) * select(-1., 1., (i & 1) == 0) + f32(i) * 1.7);
  }
  return vec4f(c, c, s * .06);
}
`;

// ---------------------------------------------------------------- shared scene code
const S_G = /*wgsl*/`
struct G { vp: mat4x4f, sm: mat4x4f, cam: vec4f, right: vec4f, up: vec4f, fwd: vec4f, sun: vec4f, res: vec4f, mis: vec4f, wrap: vec4f, fog: vec4f, wat: vec4f, son: vec4f, sb: vec4f, sbh: vec4f,
  cav: vec4f, cm: array<vec4f, 8>, cl: array<vec4f, 8>, cc: array<vec4f, 8>,
  env: vec4f, sky: vec4f, sunc: vec4f, exp: vec4f, cl2: array<vec4f, 4>, cc2: array<vec4f, 4>, cvf: vec4f, cvp: vec4f };
const SIG = vec3f(.058, .0235, .0195);
const KD = vec3f(.056, .0245, .0170);
const WCOL = vec3f(.16, .58, .90);
const KDZ = vec3f(.034, .023, .018);
const PCOL = vec3f(.58, .66, .98);
const SUNC = vec3f(1.7, 1.6, 1.45);
const TAU = 6.2831853;
const LOW = ${LV > 1};
fn sat(x: f32) -> f32 { return clamp(x, 0., 1.); }
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(.06711056, .00583715)))); }
fn hs(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }
fn kd(z: f32) -> vec3f { return mix(KD, KDZ, z); }
// depth used for light attenuation: true depth to 60 m, then 35 % of the rest
fn dz(y: f32) -> f32 { let d = min(y, 0.); return select(d, -60. + (d + 60.) * .35, d < -60.); }
// diver's lamp: a soft cone along the view, on from 70 m down (full at 150 m)
// cave light sources (glowing fungi, crystals, vents): g.cl xyz render space + radius, g.cc colour; g.cav.y of them
fn cavL(p: vec3f, n: vec3f) -> vec3f {
  var s = vec3f(0.);
  let nl = i32(g.cav.y);
  for (var i = 0; i < nl; i++) {
    var L = vec4f(0.); var C = vec3f(0.);
    if (i < 8) { L = g.cl[i]; C = g.cc[i].rgb; } else { L = g.cl2[i - 8]; C = g.cc2[i - 8].rgb; }
    let v = L.xyz - p; let d2 = dot(v, v); let rr = L.w * L.w;
    if (d2 < rr) { let d = sqrt(d2); let f = 1. - d2 / rr; s += C * (f * f / (1. + d2 * .006)) * sat(dot(n, v / max(d, .001)) * .7 + .3); }
  }
  // the glow of the cave you are in fills the dark, more from below (a lava lake, a brine river)
  return s + g.cvf.rgb * (.55 + .45 * sat(-n.y + .4));
}
// horizontal distance into the nearest cave-entrance patch (g.cm[2i]: centre xyz, radius), g.cav.w of them; < 0
// inside. There the seabed is part of the cave's mesh (cave.js), so the clipmap and the plants keep out.
fn mouthD(p: vec3f) -> f32 {
  var d = 1e9;
  let nm = i32(g.cav.w);
  for (var i = 0; i < nm; i++) { let a = g.cm[i * 2]; d = min(d, length(p.xz - a.xz) - a.w); }
  return d;
}
// the rock knolls over the mouths (cave.js cvMound without its noise): an ellipsoid set back over each tunnel
fn knollD(p: vec3f) -> f32 { return 1e9; } // the knolls are inside the entrance patches now (mouthD covers them)
// the sky over the sea (camera above the surface): blue gradient, sun disc and halo, a layer of slow clouds
fn vh2(p: vec2f) -> f32 { let i = floor(p); let f = p - i; let u = f * f * (3. - 2. * f);
  let a = hs(i.x + i.y * 57.); let b = hs(i.x + 1. + i.y * 57.); let c = hs(i.x + (i.y + 1.) * 57.); let d = hs(i.x + 1. + (i.y + 1.) * 57.);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y); }
// (sky.js: g.sky = the true sun + lightning, g.env = ambient, cloud cover, waves, rain)
fn skyC(rd: vec3f) -> vec3f {
  let S = g.sky.xyz; let y = max(rd.y, 0.); let mu = max(dot(rd, S), 0.); let cv = g.env.y;
  let day = ss(-.1, .25, S.y); let warm = ss(.45, .02, S.y) * ss(-.15, .03, S.y); let night = 1. - ss(-.2, .05, S.y);
  var c = mix(vec3f(.70, .82, .93), vec3f(.13, .34, .74), pow(y, .45)) * 1.5 * day * day;
  // dawn and dusk: a deep orange glow low over the horizon toward the sun, pink and violet above and away from it
  let hz = pow(1. - y, 3.);
  c = mix(c, (vec3f(1.7, .5, .14) * (.25 + .75 * pow(mu, 4.)) * hz + vec3f(.45, .2, .42) * (1. - hz) * .7 + vec3f(.1, .06, .2)) * (.5 + .5 * day), warm * .9);
  // night: deep blue, stars, the moon opposite the sun
  c += vec3f(.006, .012, .03) * (1. + y) * night;
  let st = rd * 260.; let cell = floor(st);
  let star = step(.9972, hs(dot(cell, vec3f(1., 57., 113.)))) * ss(.45, .1, length(fract(st) - .5));
  c += vec3f(.9, .95, 1.) * star * night * 2.5 * (1. - cv) * ss(0., .12, rd.y);
  let mm = max(dot(rd, -S), 0.);
  c += vec3f(.8, .85, .95) * (ss(.9995, .9998, mm) * 5. + pow(mm, 90.) * .2) * night * (1. - cv * .85);
  // the sun: disc and halo (hidden by heavy cloud)
  c += vec3f(1., .88, .66) * (pow(mu, 6.) * .3 + pow(mu, 60.) * .9) * (day + warm) * (1. - .8 * cv) + vec3f(1., .97, .9) * ss(.9993, .9997, mu) * 30. * (1. - cv) * ss(-.05, .02, S.y);
  // clouds: more of them with the cover, lit by day, glowing at dusk, dark at night
  if (rd.y > .015) {
    let q = rd.xz / rd.y * 1.4 + vec2f(g.cam.w * .004, g.cam.w * .002) * (1. + 2. * g.env.z) + g.wrap.xy * .0006;
    let th = mix(.74, .3, cv);
    let cl = ss(th - .2, th + .08, vh2(q) * .55 + vh2(q * 2.3 + 7.) * .3 + vh2(q * 5.1 + 3.) * .15) * ss(.015, .2, rd.y);
    let cc = mix(vec3f(.025, .03, .04), vec3f(1.45, 1.45, 1.42), day * (1. - .72 * cv)) + vec3f(1.3, .55, .3) * warm * .7;
    c = mix(c, cc * (.8 + .4 * mu), cl * .92);
  }
  // overcast: a grey veil over everything; rain darkens it
  c = mix(c, vec3f(.55, .6, .66) * (.03 + .97 * day) * (1. - .45 * g.env.w), cv * cv * .72);
  // a rainbow in sunny showers: 40-42 deg around the point opposite the sun
  let ra = dot(rd, -S);
  let rt = (ra - .712) / .066;
  if (rt > 0. && rt < 1. && g.env.w > .01) {
    let spec = clamp(.5 + .5 * cos(TAU * (rt * .85 + vec3f(0., .33, .67))), vec3f(0.), vec3f(1.));
    c += spec * sin(rt * 3.14159) * g.env.w * ss(0., .15, S.y) * (1. - ss(.75, .95, cv)) * ss(0., .04, rd.y) * .45;
  }
  // lightning (g.sunc.w: the bolt's bearing; its fraction seeds the shape): a jagged bolt from the clouds to the sea
  if (g.sunc.w >= 0. && g.sky.w > .01) {
    let sd = fract(g.sunc.w * 1000.) * 97.;
    var da = atan2(rd.z, rd.x) - floor(g.sunc.w * 100.) / 100.; da -= round(da / TAU) * TAU;
    let e = rd.y;
    let jag = (vh2(vec2f(e * 26., sd)) - .5) * .06 + (vh2(vec2f(e * 85., sd + 9.)) - .5) * .018;
    let bolt = ss(.004, 0., abs(da - jag)) * ss(.42, .3, e) * ss(-.01, .01, e);
    let br = ss(.003, 0., abs(da - jag - (e - .22) * .5)) * ss(.3, .22, e) * ss(.08, .14, e); // a branch
    c += vec3f(1., .96, 1.25) * (bolt + br * .6) * g.sky.w * 14. + vec3f(.7, .75, 1.) * ss(.12, 0., abs(da)) * g.sky.w * ss(.5, .1, e) * .8;
  }
  return c + vec3f(.8, .85, 1.) * g.sky.w * .45;
}
fn lamp(p: vec3f, n: vec3f) -> vec3f {
  // g.fog.z: your submarine's lights (on at any depth, brighter)
  let k = max(max(ss(-70., -150., g.cam.y), g.fog.z), g.cav.z) * (1. + 1.5 * g.fog.z); // g.cav.z: night
  if (k <= 0.) { return cavL(p, n); }
  let v = g.cam.xyz - p; let d = length(v); let l = v / max(d, 1e-3);
  let cone = ss(.72, .96, dot(-l, g.fwd.xyz));
  return vec3f(.85, .95, 1.) * k * 2.4 * (.2 + .8 * cone) * sat(dot(n, l) * .8 + .2) * exp(-.03 * d) / (1. + .005 * d * d) + cavL(p, n);
}
fn sg(z: f32) -> vec3f { return mix(SIG, vec3f(.034, .026, .022), z); }
fn fin(c: vec3f) -> vec4f { return vec4f(min(max(c, vec3f(0.)), vec3f(40.)), 1.); }
const KDF = vec3f(.043, .045, .042);
// water colour: each biome has its own (main.js WATER), blended on the CPU from the biomes around the camera
fn wcol(z: f32) -> vec3f { return g.wat.rgb; }
fn fogIn(ro: vec3f, rd: vec3f, d: f32, z: f32, sun: vec3f) -> vec3f {
  let k = mix(KD, KDF, z);
  let a = sg(z) - k * rd.y * select(1., .35, ro.y < -60.);
  let I = (1. - exp(-a * d)) / a;
  let mu = max(dot(rd, sun), 0.);
  let m2 = mu * mu;
  // g.cav.x: how far the camera is inside a cave (the water there gets no daylight)
  return wcol(z) * sg(z) * exp(k * dz(ro.y)) * I * (1.22 + .3 * m2 * m2) * (1. - .93 * g.cav.x) * g.env.x;
}
`;

const S_B = S_G + /*wgsl*/`
struct LVU { o: array<vec4f, 8> };
struct WT { sch: array<vec4f, 16>, man: array<vec4f, 8>, vent: array<vec4f, 16>, jel: array<vec4f, 8>, tur: array<vec4f, 8>, lev: array<vec4f, 4>, sq: array<vec4f, 8> };
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sR: sampler;
@group(0) @binding(2) var sC: sampler;
@group(0) @binding(3) var sS: sampler_comparison;
@group(0) @binding(4) var tSh: texture_depth_2d;
@group(0) @binding(5) var tW: texture_2d<f32>;
@group(0) @binding(6) var tD: texture_2d<f32>;
@group(0) @binding(7) var tM: texture_2d_array<f32>; // baked world textures: 0 lava, 1 cave rock (a: height), 2 brine, 3 moss, 4 sand (a: height)
@group(1) @binding(0) var tCH: texture_2d_array<f32>;
@group(1) @binding(1) var tCB: texture_2d_array<f32>;
@group(1) @binding(2) var<uniform> lv: LVU;
@group(1) @binding(3) var<storage, read> KV: array<vec4f>;
@group(1) @binding(4) var<storage, read> TV: array<vec4f>;
@group(1) @binding(5) var<uniform> wt: WT;
@group(1) @binding(6) var tCX: texture_2d_array<f32>;
fn WP(p: vec3f) -> vec3f { return p + vec3f(g.wrap.x, 0., g.wrap.y); }
fn shUV(p: vec3f) -> vec3f { let s = g.sm * vec4f(p, 1.); return vec3f(s.x * .5 + .5, .5 - s.y * .5, s.z - .0007); }
fn shadow1(p: vec3f) -> f32 { let s = shUV(p); return textureSampleCompareLevel(tSh, sS, s.xy, s.z); }
fn shadow4(p: vec3f) -> f32 {
  let s = shUV(p); let e = 1.8 / ${SHADOW}.;
  return (textureSampleCompareLevel(tSh, sS, s.xy + vec2f(-e, -e), s.z) + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(e, -e), s.z)
        + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(-e, e), s.z) + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(e, e), s.z)) * .25;
}
fn shadow9(p: vec3f) -> f32 {
  if (LOW) { return shadow1(p); }
  let s = shUV(p); let e = 2.1 / ${SHADOW}.; var a = 0.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) { a += textureSampleCompareLevel(tSh, sS, s.xy + vec2f(f32(x), f32(y)) * e, s.z); } }
  return a / 9.;
}
// a baked world texture at uv (tiles per metre given), with an explicit mip from the distance (usable anywhere in a shader)
// No visible tiling: a slow noise picks, region by region, one of 8 rotated and shifted copies of the texture, blended
// where two regions meet; a second, 4x larger copy and a large-scale brightness noise vary it further.
fn wtex(uv: vec2f, layer: i32, tpm: f32, dist: f32) -> vec4f {
  let lod = clamp(log2(max(512. * tpm * dist * 1.1 / max(g.res.y, 1.), 1e-4)), 0., 9.);
  let k = textureSampleLevel(tD, sR, uv * .061 + .13, 0.).a;
  let id = k * 8.; let ii = floor(id); let f = fract(id);
  let ra = ii * 2.39996; let rb = (ii + 1.) * 2.39996;
  let ua = mat2x2f(cos(ra), sin(ra), -sin(ra), cos(ra)) * uv + sin(vec2f(3., 7.) * ii);
  let ub = mat2x2f(cos(rb), sin(rb), -sin(rb), cos(rb)) * uv + sin(vec2f(3., 7.) * (ii + 1.));
  let a = textureSampleLevel(tM, sR, ua, layer, lod); let b = textureSampleLevel(tM, sR, ub, layer, lod);
  var c = mix(a, b, ss(.2, .8, f - .1 * dot(a.rgb - b.rgb, vec3f(1.))));
  let big = textureSampleLevel(tM, sR, mat2x2f(.6, .8, -.8, .6) * uv * .27 + .41, layer, min(lod + 2., 9.));
  c = mix(c, big, .3 + .25 * textureSampleLevel(tD, sR, uv * .023 + .7, 0.).b);
  let lum = .72 + .56 * textureSampleLevel(tD, sR, uv * .011 + .29, 0.).a;
  return vec4f(c.rgb * lum, c.a);
}
// triplanar version (cave walls)
fn wtex3(p: vec3f, n: vec3f, layer: i32, tpm: f32, dist: f32) -> vec4f {
  var w = pow(abs(n), vec3f(4.)); w /= (w.x + w.y + w.z);
  return wtex(p.zy * tpm, layer, tpm, dist) * w.x + wtex(p.xz * tpm, layer, tpm, dist) * w.y + wtex(p.xy * tpm, layer, tpm, dist) * w.z;
}
fn cuv(p: vec3f) -> vec2f { return WP(p).xz - g.sun.xz * (p.y / g.sun.y); }
fn caus(p: vec3f, d: f32) -> vec3f {
  let q = cuv(p);
  let o = vec2f(.004, .0025);
  let a = vec3f(textureSample(tW, sR, q * (310. / 1024.) + o).r, textureSample(tW, sR, q * (310. / 1024.)).r, textureSample(tW, sR, q * (310. / 1024.) - o).r);
  let b = textureSample(tW, sR, q.yx * (148. / 1024.) + .37).r;
  let c = min(pow(a, vec3f(2.3)) * 5. * (.45 + b * 1.3), vec3f(4.));
  return mix(c, vec3f(.33), max(ss(35., 100., d), g.env.y * .7)); // clouds soften the caustics
}
fn caus2(p: vec3f, d: f32) -> f32 {
  let q = cuv(p);
  let c = min(pow(textureSample(tW, sR, q * (250. / 1024.)).r, 1.4) * 2.6 * (.45 + textureSample(tW, sR, q.yx * (148. / 1024.) + .37).r * 1.3), 2.6);
  return mix(c, .33, max(ss(35., 100., d), g.env.y * .7));
}
fn sunE(y: f32, z: f32) -> vec3f { return g.sunc.rgb * exp(kd(z) * (dz(y) / g.sun.y)) * (.5 + .5 * sat(-y / 30.)); }
fn amb(p: vec3f, n: vec3f, sky: f32, z: f32) -> vec3f {
  let up = n.y * .5 + .5;
  return mix(vec3f(.22, .60, .80), g.wat.rgb * 1.05, .55) * (1. - .3 * z) * exp(kd(z) * dz(p.y) * 1.2) * (.3 + .7 * sky) * (.24 + .76 * up * up) * 1.3 * (.55 + .45 * sat(-p.y / 30.)) * g.env.x + vec3f(.003, .010, .016) + lamp(p, n);
}
// grotto weight under the camera (fog colour is per view, not per pixel)
fn zone(p: vec3f) -> f32 { return g.sun.w; }
fn side(p: vec3f, n: vec3f, open: f32, z: f32) -> vec3f { return mix(WCOL, PCOL, z) * exp(kd(z) * dz(p.y)) * open * (1. - abs(n.y)) * .7 * g.env.x; }
// exponential depth fog; g.fog.y scales the optical distance so a farther draw distance (desktop) still fades to the
// background colour exactly at g.fog.x, with no pop-in at the edge
fn fog(c: vec3f, wp: vec3f, z: f32) -> vec3f {
  // optical distance: g.wat.w is the biome's murk (vents thick, reefs clear)
  let v = wp - g.cam.xyz; let d = length(v); let rd = v / d; let ds = d * g.fog.y * g.wat.w;
  // above the surface: a light sea haze (anything under the water is behind the opaque surface)
  if (g.cam.y > 0.) { let a = exp(-d * .0004 * (1. + 3. * g.env.w)); return c * a + skyC(vec3f(rd.x, max(rd.y, .02), rd.z)) * .75 * (1. - a); }
  // in caves the haze takes the colour of the cave's glow (and of a brine river's surface when you look across it)
  let hz = 1. - exp(-ds * .008);
  // inside a cavern the water keeps the cave's own colours (lava stays red, brine green): less of the blue-green tint
  let sgc = mix(sg(z), vec3f(dot(sg(z), vec3f(.333))), sat(length(g.cvf.rgb) * 14.));
  return c * exp(-sgc * ds) * ss(g.fog.x, g.fog.x * .8, d) + fogIn(g.cam.xyz, rd, ds, z, g.sun.xyz) * (.92 - .26 * z) + g.cvf.rgb * .9 * hz;
}
fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
`;

// ---------------------------------------------------------------- solid meshes (clipmap terrain, rocks, set pieces, sponges, coral)
const W_SOLID = S_B + /*wgsl*/`
struct VI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) b: vec4f, @location(4) c: vec4f, @location(5) d: vec4f };
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) op: vec3f, @location(3) on: vec3f,
  @location(4) @interpolate(flat) m: vec4f, @location(5) @interpolate(flat) q: vec4f, @location(6) ao: f32, @location(7) bio: vec4f, @location(8) bio2: vec4f };
// instance: a (render-space position, scale), b (rotation), c (material, seed, texture scale, bob), d (kind, live, grotto, fade distance)
@vertex fn vs(i: VI) -> VO {
  var o: VO;
  var sc = i.a.w;
  // population instances shrink away before their cull distance, so nothing pops
  if (i.d.w > 1.5 && g.res.x > 0.) { sc *= 1. - ss(i.d.w * .7, i.d.w, distance(i.a.xyz, g.cam.xyz) / g.mis.z); if (min(mouthD(i.a.xyz), knollD(i.a.xyz) + 3.) < i.a.w * .5) { sc = 0.; } }
  var w = i.a.xyz + qrot(i.b, i.p * sc);
  w.y += sin(g.cam.w * .3 + i.c.y * 40.) * i.c.w;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = qrot(i.b, i.n.xyz); o.op = i.p * i.a.w + i.c.y * 37.; o.on = i.n.xyz;
  o.m = i.c; o.q = i.b; o.ao = i.n.w; o.bio = vec4f(0., 0., i.d.z, .85); o.bio2 = vec4f(0., 0., max(i.d.y - 1., 0.), 0.);
  // caves (d.x): 99 + theme (0 fungus, 1 crystal, 2 lava) for the walls (n.w = daylight reaching the vertex), 98 for
  // the things growing in them (d.w = daylight there)
  if (i.d.x > 98.5) {
    let th = i.d.x - 99.;
    o.ao = 1.; o.bio = vec4f(0., 0., select(0., .8, th < .5 || th > 3.5), i.n.w); o.bio2 = vec4f(th * .25, select(0., .8, th > .5 && th < 1.5), select(0., 1., th > 1.5 && th < 2.5), 2.);
  } else if (i.d.x > 97.5) { o.bio.w = i.d.w; o.bio2.w = 1.; }
  return o;
}
// clipmap terrain: level = instance index, the grid vertex from the vertex index, height from the level's texture
@vertex fn vsT(@builtin(vertex_index) vi: u32, @builtin(instance_index) li: u32) -> VO {
  var o: VO;
  let L = lv.o[li]; let ly = i32(L.w);
  let i = vi % ${CM + 1}u; let j = vi / ${CM + 1}u;
  var t = textureLoad(tCH, vec2u(i, j), ly, 0);
  var b = textureLoad(tCB, vec2u(i, j), ly, 0);
  var x = textureLoad(tCX, vec2u(i, j), ly, 0);
  // geomorph: towards the outer edge, odd vertices slide onto the next coarser level's surface, so the levels meet
  // without cracks and change resolution without popping
  let e = max(abs(i32(i) - ${CM / 2}), abs(i32(j) - ${CM / 2}));
  let mo = clamp(f32(e - ${CM / 2 - CM / 8}) / ${CM / 8}., 0., 1.);
  if (mo > 0. && ((i | j) & 1u) == 1u) {
    let i0 = i & ~1u; let j0 = j & ~1u; let i1 = min(i0 + (i & 1u) * 2u, ${CM}u); let j1 = min(j0 + (j & 1u) * 2u, ${CM}u);
    let ct = (textureLoad(tCH, vec2u(i0, j0), ly, 0) + textureLoad(tCH, vec2u(i1, j0), ly, 0) + textureLoad(tCH, vec2u(i0, j1), ly, 0) + textureLoad(tCH, vec2u(i1, j1), ly, 0)) * .25;
    let cb = (textureLoad(tCB, vec2u(i0, j0), ly, 0) + textureLoad(tCB, vec2u(i1, j0), ly, 0) + textureLoad(tCB, vec2u(i0, j1), ly, 0) + textureLoad(tCB, vec2u(i1, j1), ly, 0)) * .25;
    let cx = (textureLoad(tCX, vec2u(i0, j0), ly, 0) + textureLoad(tCX, vec2u(i1, j0), ly, 0) + textureLoad(tCX, vec2u(i0, j1), ly, 0) + textureLoad(tCX, vec2u(i1, j1), ly, 0)) * .25;
    t = mix(t, ct, mo); b = mix(b, cb, mo); x = mix(x, cx, mo);
  }
  let p = vec3f(L.x + f32(i) * L.z, t.x, L.y + f32(j) * L.z);
  let n = normalize(vec3f(t.y, sqrt(max(1. - t.y * t.y - t.z * t.z, .01)), t.z));
  o.cp = g.vp * vec4f(p, 1.); o.wp = p; o.n = n; o.on = n; o.op = WP(p);
  o.m = vec4f(0., 0., 1., 0.); o.q = vec4f(0., 0., 0., 1.); o.ao = 1.; o.bio = vec4f(b.x, b.y, b.z, t.w); o.bio2 = vec4f(x.x, x.y, b.w, -1.);
  return o;
}
struct TP { h: f32, c: f32, n: vec3f };
fn tri(p: vec3f, n: vec3f, s: f32) -> TP {
  var w = pow(abs(n), vec3f(4.)); w /= (w.x + w.y + w.z);
  let x = textureSample(tD, sR, p.zy * s); let y = textureSample(tD, sR, p.xz * s); let z = textureSample(tD, sR, p.xy * s);
  var o: TP;
  o.h = x.b * w.x + y.b * w.y + z.b * w.z;
  o.c = x.a * w.x + y.a * w.y + z.a * w.z;
  let a = x.rg * 2. - 1.; let b = y.rg * 2. - 1.; let c = z.rg * 2. - 1.;
  o.n = vec3f(0., a.y, a.x) * w.x + vec3f(b.x, 0., b.y) * w.y + vec3f(c.x, c.y, 0.) * w.z;
  return o;
}
@fragment fn fs(i: VO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let mat = i32(i.m.x + .5); let sd = i.m.y; let cwall = i.bio2.w > 1.5; let fl_ = select(-1., 1., ff || mat == 0 || cwall);
  let on = normalize(i.on) * fl_; let n0 = normalize(i.n) * fl_;
  let dist = length(i.wp - g.cam.xyz);
  // flat facet normal from screen derivatives (crystals), and the crystal growth-band sample: both taken outside the
  // material branches, which derivatives and implicit-LOD sampling require (uniform control flow)
  let fN0 = normalize(cross(dpdx(i.wp), dpdy(i.wp))); let fN = select(-fN0, fN0, dot(fN0, g.cam.xyz - i.wp) > 0.);
  let cst = textureSample(tD, sR, vec2f(i.op.y * 1.3 + sd * 5., (i.op.x - i.op.z) * 1.9));
  let ts = select(1., i.m.z, mat >= 2);
  // detail frequencies are k / 1024 so the terrain's wrapped coordinates (op) tile seamlessly
  let A = tri(i.op, on, .1015625 * ts); let B = tri(i.op, on, .4296875 * ts); let C = tri(i.op, on, 1.900390625 * ts); let F = tri(i.op, on, 6.69921875 * ts); let fk = ss(10., 1.5, dist) * f32(mat <= 1);
  let Wd = textureSample(tD, sR, vec2f(i.op.x * .06, (i.op.y + i.op.z) * .7));
  let big = textureSample(tD, sR, i.op.xz * .0126953125 + i.op.y * .021).a;
  let big2 = textureSample(tD, sR, i.op.zx * .03125 + i.op.y * .043 + .37).a;
  var sgro = 0.;
  let sk = textureSample(tD, sR, vec2f((i.op.x + i.op.z) * .33, i.op.y * .035));
  let sk2 = textureSample(tD, sR, vec2f((i.op.x - i.op.z) * 1.1, i.op.y * .11));
  let spt = textureSample(tD, sR, i.op.xz * 2.3 + sd * 7.).a; // fungus cap spots (sampled outside the material branches: uniform control flow)
  let gm = i.bio;
  let pool = i.bio2.w > 1.5 && gm.w < -.5; // a cavern's lava lake or brine river
  let occ = max(gm.w, 0.);
  let ca = caus(i.wp, dist);
  let hgt = A.h * .5 + B.h * .35 + C.h * .15;
  var bump = 1.7; var gloss = .1; var alb = vec3f(0.); var emi = vec3f(0.); var vao = 1.; var flu = 0.;
  let flt = ss(.72, .93, n0.y);
  let sandK = select(0., flt * gm.y, mat == 0);
  if (mat <= 1) {
    // layered rock: grey / olive / brown beds, warm encrustation patches, algae on up-facing parts
    let st = i.op.y * .55 + A.h * 1.6 + big * 5. + big2 * 3.;
    let bed = hs(floor(st)); let sf = fract(st);
    alb = mix(vec3f(.11, .12, .13), vec3f(.33, .30, .25), sat(A.c * 1.5 - .25));
    alb = mix(alb, mix(vec3f(.26, .19, .10), vec3f(.20, .22, .14), bed), ss(.42, .66, big) * .7);
    alb *= mix(.72, 1.15, bed) * (1. - .45 * ss(.12, .0, sf) * (1. - abs(on.y)));
    let enc = ss(.46, .6, big2 * .6 + B.c * .5) * ss(.3, .6, hgt);
    alb = mix(alb, mix(vec3f(.34, .07, .10), vec3f(.40, .25, .07), ss(.45, .6, A.c)) * (.5 + .8 * B.h), enc * .75);
    alb = mix(alb, vec3f(.50, .50, .46) * (.5 + .7 * C.h), ss(.60, .70, B.c * .6 + C.c * .5) * .5);
    let alg = ss(-.1, .6, n0.y) * ss(.3, .52, B.c * .55 + big * .5);
    alb = mix(alb, vec3f(.035, .14, .07), alg * .8);
    alb *= mix(.22 + 1.3 * hgt, .62 + .55 * hgt, sandK) * mix(1., .62 + .76 * F.h, fk);
    sgro = -ss(.14, .0, sf) * (1. - abs(on.y)) * 1.2;
    // volcanic: black basalt with glowing lava veins (terrain and the rocks lying there)
    let vo = i.bio2.z;
    alb = mix(alb, vec3f(.05, .044, .042) * (.6 + .8 * hgt), vo * .9);
    let vein = ss(.009, .0, abs(big - .5)) * ss(.3, .6, hgt) + ss(.005, .0, abs(big2 - .5)) * .5;
    emi += vec3f(1., .3, .05) * vein * vo * vo * (1.3 + .5 * sin(g.cam.w * 1.1 + big * 37.));
    // crystal fields: cold blue-grey rock
    alb = mix(alb, vec3f(.08, .1, .14) * (.6 + .8 * hgt), i.bio2.y * .7);
    if (mat == 0) {
      // reef: white coral sand on the flats, pink coralline crust on the rock
      let rf = i.bio2.x;
      alb = mix(alb, vec3f(.62, .58, .5) * (.7 + .4 * B.h), flt * rf * gm.y * .85);
      alb = mix(alb, vec3f(.5, .22, .32) * (.5 + .7 * B.h), rf * (1. - gm.y) * (.3 + .3 * flt));
      // seabed: rippled sand on the flats (baked: ripples, pebbles, shells), glowing magenta ground cover in the grottos
      let sd4 = wtex(i.op.xz * .25, 4, .25, dist);
      alb = mix(alb, mix(vec3f(.13, .15, .14) * (.55 + .6 * B.h), sd4.rgb * .42 * (.7 + .5 * sd4.a), .6), flt * gm.y * .7);
      let mg = flt * sat(gm.x * 1.5 - .45 + (B.c - .5) * 1.6) * ss(.35, .6, A.h) * ss(-16., -24., i.wp.y);
      alb = mix(alb, vec3f(.20, .02, .12) * (.4 + .9 * B.h), mg * .8);
      flu = mg * .35;
      alb = mix(alb, alb * vec3f(.85, .8, 1.4) + vec3f(.015, .0, .05), gm.z * .8);
    }
  } else if (mat == 2) {
    // whale fluke: smooth pale stone with dark streaks running along its length
    alb = mix(vec3f(.42, .47, .48), vec3f(.10, .13, .15), ss(.40, .62, sk.a * .6 + sk2.b * .5)) * (.75 + .3 * B.h);
    alb = mix(alb, vec3f(.60, .64, .62), ss(.62, .75, sk2.a) * .5);
    gloss = .9; bump = .3;
  } else if (mat == 3) {
    alb = mix(vec3f(.13, .085, .05), vec3f(.36, .25, .14), Wd.b) * (.6 + .5 * B.h);
    let pk = fract(atan2(i.op.z, 2. - i.op.y) * 7.);
    alb *= .35 + .65 * ss(0., .12, min(pk, 1. - pk));
    alb = mix(alb, vec3f(.08, .22, .16), ss(.5, .7, A.c) * .6);
    gloss = .2; bump = .7;
  } else if (mat == 4) {
    let hue = fract(sd * 7.31);
    alb = mix(vec3f(.60, .17, .08), vec3f(.64, .35, .10), fract(hue * 3.));
    if (hue > .75) { alb = vec3f(.44, .18, .42); }
    alb *= (.45 + .75 * B.h) * (.7 + .3 * C.h);
    vao = i.ao * i.ao; gloss = .2; bump = 1.4; flu = .55;
  } else if (mat == 6) {
    // bioluminescent fungus: pale stalk, spotted violet / teal cap, glowing gills under the cap (aux .1)
    let hue = fract(sd * 3.7);
    let capC = mix(vec3f(.24, .05, .36), vec3f(.03, .2, .3), step(.5, hue));
    let glowC = mix(vec3f(1., .3, .9), vec3f(.25, 1., .85), step(.5, hue));
    let cap = ss(.8, .95, i.ao); let gill = ss(.32, .12, i.ao);
    let spots = ss(.68, .76, spt) * cap;
    alb = mix(vec3f(.55, .52, .47) * (.6 + .5 * B.h), capC * (.6 + .6 * B.h), cap);
    alb = mix(alb, vec3f(.85, .8, .95), spots * .5);
    emi = glowC * (gill * 3.5 + spots * .7 + cap * .06) * (.85 + .15 * sin(g.cam.w * .8 + sd * 40.));
    gloss = .35; bump = .6; flu = .5;
  } else if (mat == 7) {
    // crystal: dark glassy prisms glowing from inside, brightest at the tips (aux 0 base .. 1 tip)
    // crystal: dark faceted glass lit from inside. Growth bands and cloudy inclusions run along the prism, the glow
    // gathers toward the tip (aux 0 base .. 1 tip), and the facet edges catch a bright rim at grazing angles
    let hue = fract(sd * 2.9);
    let gc = select(select(vec3f(.22, .95, 1.), vec3f(1., .6, .16), hue > .55), vec3f(.72, .32, 1.), hue > .82);
    let ndv0 = sat(dot(fN, normalize(g.cam.xyz - i.wp)));
    let band = ss(.35, .75, cst.b) * .6 + ss(.56, .7, cst.a) * .5;
    alb = gc * .05 + vec3f(.012, .016, .022);
    emi = gc * ((.14 + 1.45 * i.ao * i.ao) * (.5 + .9 * band) + pow(1. - ndv0, 3.) * 1.4) * (.86 + .14 * sin(g.cam.w * 1.7 + sd * 60. + i.op.y * 3.));
    gloss = 1.; bump = 0.; flu = .15;
  } else if (mat == 8) {
    // vent chimney: crusted basalt with glowing cracks, an incandescent throat (aux < .2)
    alb = vec3f(.06, .05, .045) * (.5 + .9 * B.h) + vec3f(.12, .08, .04) * ss(.55, .75, C.c) * .6;
    let crack = ss(.03, .0, abs(B.c - .5)) * ss(.3, .6, i.ao);
    emi = vec3f(1., .32, .05) * (crack * 1.8 + ss(.22, .08, i.ao) * 4.) * (.8 + .2 * sin(g.cam.w * 2.3 + sd * 20.));
    gloss = .15; bump = 1.6;
  } else if (mat == 10) {
    // another player's diver: dark suit, yellow tank, arms and fins in the player's colour (seed), a glowing lamp
    let pc = .5 + .5 * cos(TAU * (sd + vec3f(0., .33, .67)));
    alb = select(select(vec3f(.025, .03, .045), vec3f(.75, .55, .08), i.ao > .3), pc * .75, i.ao > .6);
    emi = select(pc * .18 * step(.6, i.ao), vec3f(4., 4.2, 4.5), i.ao > .9);
    gloss = .5; bump = .15; vao = 1.;
  } else if (mat == 9) {
    // bone: porous ivory, stained darker below, algae on the upper surfaces
    alb = vec3f(.62, .58, .5) * (.55 + .5 * B.h) * (.75 + .35 * C.h);
    alb = mix(alb, vec3f(.3, .26, .2), ss(.2, -.5, n0.y) * .5);
    alb = mix(alb, vec3f(.1, .2, .1), ss(.4, .9, n0.y) * ss(.5, .65, B.c) * .6);
    gloss = .3; bump = 1.1;
  } else {
    let hue = fract(sd * 5.73);
    alb = mix(vec3f(.80, .08, .10), vec3f(.90, .22, .40), fract(hue * 4.));
    if (hue > .7) { alb = vec3f(.88, .42, .10); }
    if (hue > .9) { alb = vec3f(.55, .22, .75); }
    alb *= (.4 + .8 * B.h) * (.5 + .9 * i.ao * i.ao);
    alb = mix(alb, vec3f(1., .75, .6), ss(.8, 1., i.ao) * .35);
    emi = alb * .01; flu = .75; gloss = .25; bump = 1.5;
  }
  let rip = select(0., flt * gm.y * cos(dot(i.op.xz, vec2f(4.0003890, 1.7487380)) + A.c * 9.) * .65, mat == 0);
  let N0 = normalize(qrot(i.q, normalize(on + (A.n * .85 + B.n * .65 + C.n * .45 * ss(60., 12., dist) + F.n * .5 * fk) * bump + vec3f(.8, sgro, .35) * vec3f(rip, 1., rip))));
  let N = select(N0, fN, mat == 7);
  let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let sky = sat(occ * 1.3); let open = sat(occ * 1.2 - .1);
  let ao = (.25 + .75 * sat(occ * 1.4 - .05)) * vao * mix(ss(.12, .6, hgt), .85, sandK) * select(1., .1 + .9 * occ, i.bio2.w > .5);
  let z = mix(zone(i.wp), gm.z, .3);
  // in caves daylight only reaches near the mouths (occ); the walls glow with the cave's theme colour
  let E = sunE(i.wp.y, z) * shadow9(i.wp + n0 * .35) * select(1., occ * occ, i.bio2.w > .5);
  if (cwall) {
    let th = i32(i.bio2.x * 4. + .5);
    var tc = vec3f(.8, .3, 1.);
    if (th == 1) { tc = vec3f(.25, 1., .8); } else if (th == 2) { tc = vec3f(1.1, .12, .015); } else if (th == 3) { tc = vec3f(.35, 1., .3); } else if (th == 4) { tc = vec3f(.35, .5, 1.); }
    // glowing growths in patches (large-scale patterns only: the small detail textures would show their tiling)
    // baked cave rock (strata, fractures) and baked glowing growths, tinted with the cave's colour
    let rk = wtex3(i.op, on, 1, 1. / 6., dist);
    alb = mix(alb, rk.rgb * vec3f(.9, .92, 1.), .8) * (.55 + .7 * rk.a);
    let mo = wtex3(i.op * 1.0, on, 3, 1. / 5., dist).rgb;
    emi += tc * dot(mo, vec3f(.4, .4, .3)) * 1.6 * ss(.35, .65, big2 * .6 + A.h * .5) * (1. - occ) * (.8 + .2 * sin(g.cam.w * .9 + big * 30.));
    alb *= .8;
    bump = .6; sgro = 0.;
    if (pool) {
      // lava: crusted, flowing, bright in its cracks; brine: a soft glowing green sheet with slow ripples
      let flow = big * .6 + A.h * .5 + .08 * sin(g.cam.w * .4 + big2 * 9.);
      let lvt = wtex(i.op.xz / 18. + vec2f(g.cam.w * .004, g.cam.w * .002), 0, 1. / 18., dist).rgb;
      let br = wtex(i.op.xz / 26. + vec2f(g.cam.w * .006, -g.cam.w * .004), 2, 1. / 26., dist).rgb;
      if (th == 2 && true) { alb = vec3f(.03, .012, .01); emi = lvt * vec3f(1.2, .55, .35) * (.7 + .3 * sin(g.cam.w * .8 + flow * 9.)); }
      else if (th == 3) { alb = br * .1; emi = br * vec3f(.35, .7, .45) * (.75 + .25 * sin(g.cam.w * .6 + flow * 7.)); }
      else if (th == 2) { alb = vec3f(.04, .015, .008); emi = vec3f(.55, .045, .004) * (.25 + 1.2 * ss(.45, .62, flow)) + vec3f(.8, .2, .02) * ss(.66, .7, flow) * .7; } // dim and red: the deep-water exposure and the tone map push bright lava to yellow
      else { alb = vec3f(.02, .08, .04); emi = vec3f(.14, .7, .3) * (.45 + .35 * sin(g.cam.w * .7 + flow * 12.) * .5 + .3 * B.h); }
      bump = .15;
    }
  }
  let ndl = sat(dot(N, L));
  let am = (amb(i.wp, N, sky, z) + side(i.wp, N, open, z)) * ao + lamp(i.wp, N) * (1. - ao); // the lamp reaches into occluded places
  let dl = E * ndl * (.10 + mix(vec3f(.33), ca, ss(.1, .45, dot(n0, L))) * 2.5);
  var c = alb * (dl + am) + emi + alb * flu * dot(dl + am, vec3f(.1, .5, .5));
  let H = normalize(V + L);
  c += E * (.25 + ca) * pow(sat(dot(N, H)), mix(10., 70., gloss)) * gloss * ndl * 1.8;
  c += (amb(i.wp, reflect(-V, N), sky, z) + side(i.wp, reflect(-V, N), open, z)) * ao * (.08 + gloss) * .6 * pow(1. - sat(dot(N, V)), 2.5);
  // the seabed opens at cave mouths
  if (i.bio2.w < -.5 && mouthD(i.wp) < -1.5) { discard; } // inside an entrance patch the cave's mesh is the seabed (1.5 m overlap at the edge, under the boulders)
  // lit by the local biome, fogged by the camera's (so distant terrain melts into the same background)
  return fin(fog(c, i.wp, zone(i.wp)));
}
`;

// ---------------------------------------------------------------- leaves: kelp columns, ground cover clumps, glints
// Blades are not stored: each visible kelp column (KV) or clump (TV) expands into its blades in the vertex shader,
// from a hash stream seeded by the column, so millions of blades cost a few bytes each on the GPU.
const W_LEAF = S_B + /*wgsl*/`
override ROWS: f32 = 7.;
override FAR: f32 = 150.;
override BASE: u32 = 0u;
override BL: u32 = 64u;
override STEP: u32 = 1u;
override WM: f32 = 1.;
override KN: u32 = 8u;
override GN: u32 = 16u;
struct LO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f,
  @location(3) @interpolate(flat) col: vec3f, @location(4) @interpolate(flat) pr: vec4f,
  @location(5) @interpolate(flat) sd: vec2f, @location(6) @interpolate(flat) spc: vec3f };
fn rn(s: ptr<function, u32>) -> f32 {
  *s = *s * 747796405u + 2891336453u;
  var w = ((*s >> ((*s >> 28u) + 4u)) ^ *s) * 277803737u; w = (w >> 22u) ^ w;
  return f32(w >> 8u) / 16777216.;
}
// sway in the current; phases are k / 1024 per metre of wrapped position
fn sway(p: vec2f, h: f32, t: f32) -> vec2f {
  let ph = dot(p, vec2f(.0306796, .0184078)); let ph2 = dot(p, vec2f(.0429515, .0245437));
  let a = .024 * pow(max(h, 0.), 1.25);
  return a * (vec2f(sin(t * .5 + ph + h * .09), cos(t * .37 + ph2 + h * .07)) + .35 * vec2f(sin(t * 1.3 + ph * 3. + h * .3), cos(t * 1.1 + ph * 2. + h * .23)));
}
fn shape2(v: f32) -> f32 { return sin(3.14159 * sat(v)); }
fn pal(h: f32) -> vec3f {
  if (h < .3) { return vec3f(1., .62, .08); }
  if (h < .6) { return vec3f(.12, 1., .22); }
  if (h < .8) { return vec3f(.2, .85, 1.); }
  return vec3f(1., .3, .8);
}
// one blade: A = (render-space base, length), Bv = (yaw, tilt, width, height above the floor for sway)
fn leafV(vi: u32, A: vec4f, Bv: vec4f, ty: i32, s1: f32, s2: f32, bend: f32) -> LO {
  var o: LO;
  let u = f32(vi & 1u) * 2. - 1.; let v = sin(f32(vi >> 1u) / (ROWS - 1.) * 1.5708);
  let t = g.cam.w;
  let len = A.w; let hA = Bv.w;
  let cy = cos(Bv.x); let sy = sin(Bv.x); let ct = cos(Bv.y); let st = sin(Bv.y);
  let d = vec3f(st * cy, ct, st * sy); let pe = vec3f(ct * cy, -st, ct * sy); let sd = vec3f(-sy, 0., cy);
  // per type: x sparkle prob, y translucency, z iridescence, w emissive
  var col = vec3f(0.); var pr = vec4f(0.); var spc = vec3f(0.); var shp = vec2f(.75, .7); var wav = 1.; var fls = 1.;
  let hsel = hs(s1 * 13.7 + s2 * 71.3);
  switch ty {
    case 0 { col = mix(vec3f(.11, .125, .022), vec3f(.04, .10, .04), s1); col = mix(col, vec3f(.25, .17, .025), step(.72, s2)); pr = vec4f(.24, .9, 0., 0.); spc = pal(hsel * .72); shp = vec2f(.5, .32); wav = 1.9; }
    case 1 { col = vec3f(.10, .11, .035); pr = vec4f(0., .2, 0., 0.); shp = vec2f(.05, .1); wav = .3; fls = .3; }
    case 2 { col = mix(vec3f(.05, .20, .16), vec3f(.12, .26, .22), s1); col = mix(col, vec3f(.30, .14, .24), step(.85, s2)); pr = vec4f(.05, 1.0, .25, 0.); spc = vec3f(.6, 1., .9); shp = vec2f(.45, .35); wav = 2.2; }
    case 3 { col = mix(vec3f(.02, .05, .065), vec3f(.05, .03, .08), s1); col = mix(col, vec3f(.09, .03, .09), step(.8, s2)); pr = vec4f(.2, .85, .55, .02); spc = mix(vec3f(.5, .35, 1.), vec3f(.2, 1., .7), step(.6, hsel)); shp = vec2f(.7, .6); wav = 2.4; }
    case 4 { col = mix(vec3f(.30, .15, .02), vec3f(.42, .25, .04), s1); pr = vec4f(.2, 1., .1, 0.); spc = vec3f(1., .85, .5); shp = vec2f(.5, .4); wav = 1.8; }
    case 5 { col = mix(vec3f(.85, .05, .40), vec3f(.60, .10, .80), step(.7, s1)); col = mix(col, vec3f(.95, .25, .55), step(.75, s2)); pr = vec4f(.22, .8, 0., .30); spc = vec3f(1., .35, .8); shp = vec2f(.6, .6); fls = 2.; }
    case 6 { col = mix(vec3f(.80, .16, .16), vec3f(.92, .36, .42), s1); pr = vec4f(.06, 1., 0., .10); spc = vec3f(1., .5, .5); shp = vec2f(.4, .3); wav = 2.; }
    default { col = mix(vec3f(.05, .40, .36), vec3f(.10, .52, .58), s1); pr = vec4f(.1, .9, .2, .04); spc = vec3f(.3, 1., .9); shp = vec2f(.6, .5); }
  }
  pr.x = step(hs(s1 * 91.7 + s2 * 37.1 + Bv.x), pr.x);
  let k = (bend - .3) * 2.0 + sin(t * (.8 + s1) * fls + s2 * 40. + hA * .25) * .10 * fls;
  let wph = v * (3. + 5. * s2) + s1 * 30. + t * 1.1;
  let wv = sin(wph) * .12 * wav;
  let kq = k * 1.7; let ka = select(kq, .06, abs(kq) < .06);
  let sK = sin(ka * v); let cK = cos(ka * v);
  let c = A.xyz + len * (d * (sK / ka) + pe * ((1. - cK) / ka + wv * v));
  let sl = sK + wv + cos(wph) * .10 * wav * v * (3. + 5. * s2);
  let N = normalize(pe * cK - d * sl); let T0 = normalize(d * cK + pe * sl);
  let tw = (s1 - .5) * 2.4 * v + sin(t * .9 + s2 * 20.) * .25 * v;
  let S = sd * cos(tw) + N * sin(tw); let N2 = N * cos(tw) - sd * sin(tw);
  let shape = pow(max(sin(3.14159 * pow(v, shp.x)), 0.), shp.y);
  let shp_ = g.res.x == 0.;
  let cd = distance(A.xyz, g.cam.xyz); let far = FAR * g.mis.z;
  let nearK = select(1. - ss(26., 40., cd), 0., shp_);
  let farK = select((1. - ss(far * .8, far, cd)) * ss(.6, 2.2, distance(c, g.cam.xyz)) * ss(len * 1.1 + .5, len * 2.2 + 1.2, distance(A.xyz + d * (len * .5), g.cam.xyz)), 1., shp_);
  let ruf = sin(v * 10. + s2 * 30. + t * .6) * Bv.z * .36 * u * shape2(v) * nearK;
  var p = c + S * (u * farK * select(Bv.z * .5 * shape, select(max(Bv.z * .5, .09) * shape, 0., ty == 1), shp_));
  p += N2 * ruf;
  let sw = sway(WP(A.xyz).xz, hA + (p.y - A.y), t);
  p.x += sw.x; p.z += sw.y;
  o.cp = g.vp * vec4f(p, 1.); o.wp = p; o.n = normalize(N2 + S * u * .55 - T0 * cos(v * 10. + s2 * 30. + t * .6) * u * .7 * nearK); o.uv = vec2f(u, v);
  // no plants inside your submarine's hull (g.sb: centre in render space + heading, g.sbh: half length, width, height)
  if (min(mouthD(A.xyz), knollD(A.xyz) + 3.) < 1.5) { o.cp = vec4f(0., 0., -1., 1.); }
  if (g.sbh.x > 0.) {
    let r = A.xyz - g.sb.xyz; let ca = cos(g.sb.w); let sa = sin(g.sb.w);
    let q = vec3f(r.x * ca - r.z * sa, r.y, r.x * sa + r.z * ca); // into the sub's frame (inverse of its yaw quaternion)
    if (all(abs(q) < vec3f(g.sbh.y, g.sbh.z, g.sbh.x))) { o.cp = vec4f(0., 0., -1., 1.); }
  }
  o.col = col; o.pr = pr; o.sd = vec2f(s1, s2); o.spc = spc;
  return o;
}
// kelp column parameters, from the column's own hash stream
struct KC { strands: u32, ph: f32, tw: f32, sr: f32, sc: f32, la: f32, lm: f32, st: u32 };
fn kcol(seed: f32) -> KC {
  var c: KC; var s = u32(seed * 16777216.) * 2654435761u + 12345u;
  c.strands = 2u + u32(rn(&s) < .6) + u32(rn(&s) < .3);
  c.ph = rn(&s) * TAU; c.tw = mix(.1, .28, rn(&s)); c.sr = mix(.2, .55, rn(&s)); c.sc = mix(.75, 1.25, rn(&s));
  c.la = rn(&s) * TAU; c.lm = rn(&s) * .11; c.st = s;
  return c;
}
// a kelp column of BL blades: stem segments every few metres of each strand, then leaves spread along the strands
@vertex fn vsK(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LO {
  let nb = BL / STEP; let col = BASE + ii / nb; let k = (ii % nb) * STEP;
  let c0 = KV[col * 2u]; let c1 = KV[col * 2u + 1u];
  let H = c0.w; let kind = i32(c1.x + .5); let C = kcol(c1.z);
  let sstep = select(1.7, 3.4, BL < 300u);
  let nper = u32(ceil((H - 1.) / sstep)); let nst = C.strands * nper;
  var s = (C.st ^ (k * 0x9E3779B9u)) * 1664525u + 1013904223u;
  var sti: u32; var h: f32;
  if (k < nst) { sti = k % C.strands; h = f32(k / C.strands) * sstep; }
  else { h = pow(rn(&s), .9) * H; sti = min(u32(rn(&s) * f32(C.strands)), C.strands - 1u); }
  let ang = C.ph + f32(sti) * TAU / f32(C.strands) + h * C.tw; let r = C.sr * (1. - .6 * h / H); let ln = C.lm * h * h / H;
  let bp = c0.xyz + vec3f(cos(ang) * r + cos(C.la) * ln, h, sin(ang) * r + sin(C.la) * ln);
  if (k < nst) { return leafV(vi, vec4f(bp, sstep + .4), vec4f(ang + 1.5708, .1, .17, h), 1, rn(&s), rn(&s), .3); }
  let t = h / H; let rk = rn(&s);
  let L = ((.55 + .75 * rk * rn(&s)) * (1. - .5 * t * t) * C.sc + .25) * select(1.15, 1.25, kind == 1);
  let tilt = mix(mix(.4, 1., rn(&s)), mix(.15, .45, rn(&s)), t);
  var ty = 0; let rt = rn(&s);
  if (kind == 1) { ty = select(4, 3, rt < .8); } else if (kind == 2) { ty = select(0, 4, rt < .5); } else if (kind == 3) { ty = select(6, 4, rt < .25); }
  let wid = (L * select(mix(.15, .21, rn(&s)), mix(.09, .13, rn(&s)), kind == 1) + .03) * WM * (.5 + .5 * f32(STEP));
  let yaw = rn(&s) * TAU;
  return leafV(vi, vec4f(bp, L), vec4f(yaw, tilt, wid, h), ty, rn(&s), rn(&s), mix(.38, .95, rn(&s)));
}
// ground cover clump of KN blades
@vertex fn vsTu(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LO {
  let cl = ii / KN; let j = ii % KN;
  let c0 = TV[cl * 2u]; let c1 = TV[cl * 2u + 1u];
  var s = (u32(c1.y * 16777216.) ^ (j * 0x9E3779B9u)) * 1664525u + 1013904223u;
  var ty = i32(c1.x + .5);
  let an = rn(&s) * TAU; let rr = sqrt(rn(&s)) * c0.w;
  var L = 0.; var tilt = 0.; var wid = 0.; var hA = 0.; var bend = mix(.3, .7, rn(&s)); var dy = -.05;
  if (ty == 5) {
    if (rn(&s) < .18) { ty = 7; L = mix(.2, .55, rn(&s)); tilt = mix(.05, .6, rn(&s)); wid = mix(.03, .06, rn(&s)); }
    else { L = mix(.12, .34, rn(&s)); tilt = mix(.05, .75, rn(&s)); wid = mix(.04, .08, rn(&s)); }
  } else if (ty == 7) { L = mix(.25, .7, rn(&s)); tilt = mix(.1, .8, rn(&s)); wid = mix(.05, .1, rn(&s)); }
  else if (ty == 3) { if (rn(&s) > .8) { ty = 4; } L = mix(.9, 2.6, rn(&s)); tilt = mix(.05, .9, rn(&s)); wid = mix(.14, .28, rn(&s)); hA = 1.5; dy = -.15; }
  else if (ty == 2) { L = mix(1., 3., rn(&s)); tilt = mix(.05, .6, rn(&s)); wid = mix(.13, .26, rn(&s)); hA = 2.5; dy = -.15; bend = mix(.3, .8, rn(&s)); }
  else { L = mix(.3, .9, rn(&s)); tilt = mix(.05, .4, rn(&s)); wid = mix(.04, .07, rn(&s)); hA = .8; }
  let bp = c0.xyz + vec3f(cos(an) * rr, dy, sin(an) * rr);
  return leafV(vi, vec4f(bp, L), vec4f(rn(&s) * TAU, tilt, wid * WM, hA), ty, rn(&s), rn(&s), bend);
}
struct GO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) col: vec3f };
// sparkles drifting in the kelp: GN per visible column
@vertex fn vsGl(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GO {
  var o: GO;
  let col = BASE + ii / GN; let j = ii % GN;
  let c0 = KV[col * 2u]; let c1 = KV[col * 2u + 1u]; let C = kcol(c1.z); let H = c0.w;
  var s = (C.st ^ (j * 0x85EBCA6Bu)) * 1664525u + 1013904223u;
  let h = rn(&s) * H; let an = rn(&s) * TAU; let r = mix(.15, .8, rn(&s)) * (1. - .5 * h / H); let ln = C.lm * h * h / H;
  let a = c0.xyz + vec3f(cos(an) * r + cos(C.la) * ln, h, sin(an) * r + sin(C.la) * ln);
  let b = vec3f(rn(&s), select(rn(&s) * .6, rn(&s), c1.x > .5 && c1.x < 1.5), mix(.018, .05, rn(&s)));
  let q = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2. - 1.; let t = g.cam.w;
  var p = a; let sw = sway(WP(a).xz, h, t); p.x += sw.x; p.z += sw.y;
  p += .1 * vec3f(sin(t * .7 + b.x * 50.), sin(t * .9 + b.x * 70.), cos(t * .8 + b.x * 90.));
  let d = length(p - g.cam.xyz);
  if (d > ${TQ.glintFar.toFixed(1)} || dot(p - g.cam.xyz, g.fwd.xyz) < -1.) { o.cp = vec4f(0., 0., 2., 1.); return o; }
  let tw = pow(.5 + .5 * sin(t * (.35 + .9 * hs(b.x)) + b.x * 100.), 4.);
  let sz = min(max(b.z, d * .0026), d * .0045);
  let w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * sz;
  o.cp = g.vp * vec4f(w, 1.); o.uv = q;
  let z = zone(p);
  let lit = .3 + 1.8 * shadow1(p) * sunE(p.y, z).g;
  let e = b.z / sz;
  o.col = pal(b.y) * (.12 + tw * 1.7) * lit * e * e * exp(-SIG.g * d) * ss(.4, 1.5, d) * ss(${TQ.glintFar.toFixed(1)}, ${(TQ.glintFar * 0.7).toFixed(1)}, d) * 17.;
  return o;
}
@fragment fn fsGl(i: GO) -> @location(0) vec4f {
  let r = dot(i.uv, i.uv);
  return vec4f(min(i.col * exp(-r * 7.) * (1. - ss(.7, 1., r)), vec3f(10.)), 0.);
}
@fragment fn fs(i: LO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let dist = length(i.wp - g.cam.xyz);
  let ca = caus2(i.wp, dist);
  var n = normalize(i.n); if (!ff) { n = -n; }
  let V = normalize(g.cam.xyz - i.wp); let L = g.sun.xyz;
  let z = zone(i.wp);
  let lt = textureSample(tD, sR, vec2f(i.uv.x * .13 + i.sd.x * 3.7, i.uv.y * .8 + i.sd.y * 5.3));
  let sky = mix(.55, 1., i.uv.y);
  let E = sunE(i.wp.y, z) * shadow1(i.wp + L * .3);
  let ndl = dot(n, L);
  var alb = i.col * (.72 + .28 * ss(0., .25, abs(i.uv.x))) * mix(.5, 1.12, i.uv.y) * (1. - .45 * ss(30., 8., dist) * ss(.6, 1., sin(i.uv.y * 40. - abs(i.uv.x) * 7. + i.sd.x * 40.))) * (.58 + .42 * ss(0., .13, abs(i.uv.x))) * (.5 + 1.0 * lt.b) * (.65 + .7 * lt.a);
  let ndv = sat(dot(n, V));
  let ir = .5 + .5 * cos(TAU * (vec3f(0., .33, .67) + ndv * 1.1 + i.sd.x * .22 + i.uv.y * .5 + .55));
  alb = mix(alb, alb * .5 + ir * vec3f(.15, .13, .30), i.pr.z * (1. - ndv) * .8);
  let tr = (max(-ndl, 0.) * .85 + .15) * i.pr.y;
  let trc = alb * mix(vec3f(1.), vec3f(1.5, 1.4, .75), sat(i.pr.y) * (1. - i.pr.z));
  let aov = mix(.45, 1., i.uv.y);
  let am = (amb(i.wp, n, sky, z) + amb(i.wp, -n, sky, z) * i.pr.y * .55 * vec3f(1.1, 1.15, .7) + side(i.wp, n, .6, z) * .6) * (.3 + .7 * aov);
  var c = E * (.06 + ca * 1.5) * (alb * max(ndl, 0.) + trc * tr) + alb * am;
  let H = normalize(V + L);
  c += E * (pow(sat(dot(n, H)), 40.) * (.45 + ir * i.pr.z * 2.) + pow(sat(dot(n, H)), 9.) * .07) + am * ir * i.pr.z * pow(1. - ndv, 3.) * 1.5;
  c += E * trc * i.pr.y * pow(sat(dot(-V, L)), 3.) * 1.2;
  c += alb * i.pr.w * (.5 + 3. * dot(am + E * .3, vec3f(.1, .5, .5)));
  // sparkle: whole-leaf glints that twinkle slowly
  let tw = pow(.5 + .5 * sin(g.cam.w * (.5 + i.sd.y * 1.4) + i.sd.x * 90.), 5.);
  let m = ss(.2, .0, abs(i.uv.y - (.35 + .45 * i.sd.y))) * (1. - i.uv.x * i.uv.x);
  let lit = .35 + E.g * 1.2;
  c += i.spc * i.pr.x * (.1 + tw) * m * lit * .6;
  return fin(fog(c, i.wp, z));
}
`;

// ---------------------------------------------------------------- fish + mantas (orbiting recycled slot centres from WT)
const W_ANIM = S_B + /*wgsl*/`
struct VI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) b: vec4f };
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) op: vec3f, @location(3) @interpolate(flat) sd: f32, @location(4) lt: f32 };
@vertex fn vsFish(i: VI) -> VO {
  var o: VO;
  let S = wt.sch[u32(i.a.x + .5)];
  let s = i.b.x; let h = vec3f(hs(s), hs(s + .37), hs(s + .71));
  let R = i.a.w; let t = g.cam.w;
  let ta = t * i.b.y + i.b.w * 6.3 + (h.x - .5) * (26. / R);
  let ph = i.b.w * 17.;
  let P = S.xyz + vec3f(R * cos(ta), 2.2 * sin(3. * ta + ph), R * .6 * sin(ta));
  let T = normalize(vec3f(-R * sin(ta), 6.6 * cos(3. * ta + ph), R * .6 * cos(ta))) * sign(i.b.y);
  let Sd = normalize(cross(vec3f(0., 1., 0.), T)); let Up = cross(T, Sd);
  let off = Sd * ((h.y - .5) * 5. + sin(t * .6 + s * 40.) * .5) + Up * ((h.z - .5) * 3.2 + cos(t * .5 + s * 31.) * .4);
  var l = i.p * i.b.z * (.75 + .5 * h.z) * S.w;
  l.z += sin(t * 9. + s * 50. + l.x * 5.) * .22 * (.25 * i.b.z - l.x);
  var w = P + off + T * l.x + Up * l.y + Sd * l.z;
  // scatter: each fish swerves away from the diver inside ~9 m
  let dv = (P + off) - g.cam.xyz; let dd = length(dv); w += dv / max(dd, .01) * ss(9., 1.5, dd) * 4. * (1. - g.mis.w); // not in creative
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = T * i.n.x + Up * i.n.y + Sd * i.n.z; o.op = i.p; o.sd = s;
  o.lt = shadow1(w);
  return o;
}
@fragment fn fsFish(i: VO) -> @location(0) vec4f {
  let n = normalize(i.n); let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let z = zone(i.wp);
  var alb = mix(vec3f(.50, .68, .80), vec3f(.10, .22, .40), ss(-.05, .2, i.op.y));
  alb = mix(alb, vec3f(.95, .8, .3), step(.86, fract(i.sd * 7.7)) * .6);
  let E = sunE(i.wp.y, z) * i.lt;
  var c = alb * (E * (.25 + .75 * sat(dot(n, L))) + amb(i.wp, n, .9, z) * 1.3);
  c += E * pow(sat(dot(n, normalize(V + L))), 24.) * 1.6 + vec3f(.3, .6, .7) * pow(1. - sat(dot(n, V)), 3.) * .25 * .9;
  return fin(fog(c, i.wp, z));
}
@vertex fn vsManta(i: VI) -> VO {
  var o: VO;
  let S = wt.man[u32(i.a.x + .5)];
  let t = g.cam.w; let R = i.a.w; let sz = i.b.z * S.w;
  let ta = t * i.b.y + i.b.x;
  let P = S.xyz + vec3f(R * cos(ta), 2.5 * sin(2. * ta + i.b.w), R * .75 * sin(ta));
  let T = normalize(vec3f(-R * sin(ta), 5. * cos(2. * ta + i.b.w) * 1., R * .75 * cos(ta))) * sign(i.b.y);
  var Sd = normalize(cross(vec3f(0., 1., 0.), T)); var Up = cross(T, Sd);
  let bank = -.28 * sign(i.b.y);
  let S2 = Sd * cos(bank) + Up * sin(bank); Up = Up * cos(bank) - Sd * sin(bank); Sd = S2;
  let u = i.n.w; let au = abs(u);
  let fp = t * 1.25 + i.b.w * 5. - au * 1.2;
  let amp = .36 * pow(au, 1.6);
  var l = i.p;
  l.y += amp * sin(fp) - .1 * sin(t * 1.25 + i.b.w * 5.);
  let tail = ss(-.5, -1.9, l.z) * step(au, .001);
  l.x += tail * sin(t * .8 + l.z * 2.) * .12;
  let sl = (.576 * pow(au, .6) * sin(fp) - .43 * pow(au, 1.6) * cos(fp)) * sign(u);
  let ln = normalize(vec3f(i.n.x - sl * i.n.y, i.n.y + sl * i.n.x, i.n.z));
  let w = P + (Sd * l.x + Up * l.y + T * l.z) * sz;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = Sd * ln.x + Up * ln.y + T * ln.z; o.op = i.p; o.sd = i.b.w;
  o.lt = 1.;
  return o;
}
@fragment fn fsManta(i: VO) -> @location(0) vec4f {
  let dist = length(i.wp - g.cam.xyz);
  let ca = caus(i.wp, dist);
  let tx = textureSample(tD, sR, i.op.xz * .9 + i.sd);
  let n = normalize(i.n + (vec3f(tx.r, 0., tx.g) - vec3f(.5, 0., .5)) * .5); let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let z = zone(i.wp);
  let top = ss(-.2, .25, normalize(i.n).y);
  let au = abs(i.op.x);
  let gill = ss(.25, .0, abs(au - .13) * 8.) * ss(.04, .12, i.op.z) * ss(.34, .26, i.op.z) * ss(.2, .8, sin(i.op.z * 110.));
  var belly = vec3f(.13, .17, .21) * (.6 + .6 * tx.b) * (1. - .7 * gill);
  belly = mix(belly, vec3f(.05, .08, .11), sat(ss(.45, .9, au + tx.a * .35) + ss(-.1, -.4, i.op.z + tx.b * .2) * .7));
  var back = vec3f(.04, .065, .10) + vec3f(.10, .16, .2) * ss(.5, .75, tx.a);
  back = mix(back, vec3f(.36, .46, .52), ss(.25, .0, abs(au - .26) * 3.5 + abs(i.op.z - .12) * 5.) * .8);
  var alb = mix(belly, back, top);
  let E = sunE(i.wp.y, z) * shadow4(i.wp + n * .3);
  let ndv = sat(dot(n, V));
  let ir = .5 + .5 * cos(TAU * (vec3f(0., .33, .67) + ndv * 1.1 + tx.a * 1.5 + .55));
  let fillN = vec3f(n.x, abs(n.y) * .55 + .25, n.z);
  var c = alb * (E * sat(dot(n, L)) * (.3 + ca) + amb(i.wp, fillN, .95, z) * 1.1 + side(i.wp, n, 1., z) * .8);
  c += ir * vec3f(.35, .16, .6) * (.07 + .22 * tx.b) * (.4 + E.g * .2 * ca.g) * (1. - top * .3);
  c += E * pow(sat(dot(n, normalize(V + L))), 30.) * .5 * (.3 + ca);
  let sky = amb(i.wp, vec3f(0., 1., 0.), .95, z);
  c += alb * sky * ca * .45 * (1. - top) + sky * pow(1. - ndv, 3.) * .35;
  return fin(fog(c, i.wp, z));
}
// sea turtle: slow banking orbits around a recycled slot centre; the paddle-shaped flippers stroke around the shoulder
@vertex fn vsTurtle(i: VI) -> VO {
  var o: VO;
  let S = wt.tur[u32(i.a.x + .5)];
  let t = g.cam.w; let R = i.a.w; let sz = i.b.z * S.w;
  let ta = t * i.b.y + i.b.x;
  let P = S.xyz + vec3f(R * cos(ta), 3. * sin(.7 * ta + i.b.w * 6.), R * .8 * sin(ta));
  let T = normalize(vec3f(-R * sin(ta), 2.1 * cos(.7 * ta + i.b.w * 6.), R * .8 * cos(ta))) * sign(i.b.y);
  var Sd = normalize(cross(vec3f(0., 1., 0.), T)); var Up = cross(T, Sd);
  let bank = -.18 * sign(i.b.y);
  let S2 = Sd * cos(bank) + Up * sin(bank); Up = Up * cos(bank) - Sd * sin(bank); Sd = S2;
  var l = i.p; var nn = i.n.xyz; let au = abs(i.n.w);
  if (au > .2 && au < .75) {
    let front = au > .45; let sx = sign(i.n.w);
    let ang = sin(t * 1.3 + i.b.w * 6.3 + select(1.7, 0., front)) * select(.3, .8, front) * sx;
    let c = cos(ang); let s = sin(ang); let px = l.x - sx * .3;
    l = vec3f(sx * .3 + px * c - l.y * s, px * s + l.y * c, l.z + select(0., cos(t * 1.3 + i.b.w * 6.3) * .1 * abs(px), front));
    nn = vec3f(nn.x * c - nn.y * s, nn.x * s + nn.y * c, nn.z);
  } else if (au > .85 && au < .95) { l.y += sin(t * .9 + i.b.w * 4.) * .02; }
  let w = P + (Sd * l.x + Up * l.y + T * l.z) * sz;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = Sd * nn.x + Up * nn.y + T * nn.z; o.op = i.p; o.sd = i.n.w;
  o.lt = shadow1(w);
  return o;
}
@fragment fn fsTurtle(i: VO) -> @location(0) vec4f {
  let dist = length(i.wp - g.cam.xyz);
  let ca = caus(i.wp, dist);
  let shell = i.sd > .95;
  let tx = textureSample(tD, sR, i.op.xz * 2.3 + .31); let tx2 = textureSample(tD, sR, i.op.xz * 6.1 + .7);
  let n = normalize(i.n + (vec3f(tx.r, 0., tx.g) - vec3f(.5, 0., .5)) * select(.25, .55, shell)); let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let z = zone(i.wp);
  var alb = vec3f(0.);
  if (shell) {
    // scutes: warm brown plates with darker seams and pale radiating streaks; a cream plastron below
    let seam = ss(.36, .26, tx.b) * .6;
    alb = mix(vec3f(.20, .12, .05), vec3f(.44, .31, .12), ss(.3, .7, tx.a)) * (1. - seam);
    alb = mix(alb, vec3f(.55, .45, .22), ss(.62, .72, tx2.a) * .5);
    alb = mix(alb, vec3f(.62, .58, .40), ss(.05, -.25, normalize(i.n).y));
  } else {
    // skin: grey-olive with pale scales
    alb = mix(vec3f(.24, .27, .21), vec3f(.52, .55, .44), ss(.55, .68, tx2.a));
  }
  let E = sunE(i.wp.y, z) * i.lt;
  let ndl = sat(dot(n, L));
  var c = alb * (E * ndl * (.3 + ca) + amb(i.wp, n, .95, z) * 1.15 + side(i.wp, n, 1., z) * .7);
  c += E * pow(sat(dot(n, normalize(V + L))), select(20., 60., shell)) * select(.15, .6, shell) * (.3 + ca);
  return fin(fog(c, i.wp, z));
}
// leviathan: each cross-section of the body (aux u = 0 head .. 1 tail) is laid on the swim path u body-lengths behind
// the head, so the whole 40-60 m body follows its curve, with a travelling sideways wave on top
@vertex fn vsLev(i: VI) -> VO {
  var o: VO;
  let S = wt.lev[u32(i.a.x + .5)];
  let t = g.cam.w; let R = i.a.w; let L = i.b.z; let sgn = sign(i.b.y);
  let u = clamp(i.n.w, 0., 1.);
  let ang = t * i.b.y + i.b.x - sgn * u * L / R;
  let P = S.xyz + vec3f(R * cos(ang), 5. * sin(.45 * ang + i.b.w), R * .85 * sin(ang));
  let T = normalize(vec3f(-R * sin(ang), 2.25 * cos(.45 * ang + i.b.w), R * .85 * cos(ang))) * sgn;
  let Sd = normalize(cross(vec3f(0., 1., 0.), T)); let Up = cross(T, Sd);
  let wave = sin(u * 9. - t * 1.5 + i.b.w) * L * (.006 + .045 * u * u);
  let sc = L * S.w;
  let w = P + Sd * (i.p.x * sc + wave * S.w) + Up * (i.p.y * sc) + T * ((i.p.z + u) * sc);
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = Sd * i.n.x + Up * i.n.y + T * i.n.z; o.op = i.p; o.sd = u;
  o.lt = shadow1(w);
  return o;
}
@fragment fn fsLev(i: VO) -> @location(0) vec4f {
  let dist = length(i.wp - g.cam.xyz);
  let ca = caus(i.wp, dist);
  let tx = textureSample(tD, sR, vec2f(i.op.z * 6.3 + i.op.x * 3., atan2(i.op.y, i.op.x) * .45 + i.op.z * 1.7));
  let n = normalize(i.n + (vec3f(tx.r, 0., tx.g) - vec3f(.5, 0., .5)) * .35); let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let z = zone(i.wp);
  // dark slate back, pale belly, scales, and rows of bioluminescent cyan spots along the flanks; amber eyes
  let up = ss(-.01, .015, i.op.y);
  var alb = mix(vec3f(.2, .22, .21), vec3f(.04, .06, .08) + vec3f(.05, .08, .1) * ss(.5, .75, tx.a), up) * (.8 + .3 * tx.b);
  let flank = abs(i.op.y) / max(length(i.op.xy), 1e-4);
  let spots = ss(.62, .9, sin(i.op.z * 310.) * .5 + .5) * ss(.2, .0, abs(flank - .35)) * ss(.98, .9, i.sd);
  let eye = ss(.009, .004, length(vec2f(abs(i.op.x) - .027, i.op.y - .012)) + abs(i.op.z + .03) * .5);
  let E = sunE(i.wp.y, z) * i.lt;
  var c = alb * (E * sat(dot(n, L)) * (.3 + ca) + amb(i.wp, n, .9, z) * 1.1 + side(i.wp, n, 1., z) * .6);
  c += E * pow(sat(dot(n, normalize(V + L))), 30.) * .4;
  c += vec3f(.2, .9, 1.) * spots * (.6 + .4 * sin(g.cam.w * 2. - i.op.z * 40.)) * 1.6 + vec3f(1., .65, .2) * eye * 3.;
  return fin(fog(c, i.wp, z));
}
// squid: small swarms circling slowly, mantle first; the mantle pumps (jet) and the arms trail and curl behind
@vertex fn vsSquid(i: VI) -> VO {
  var o: VO;
  let S = wt.sq[u32(i.a.x + .5)]; let t = g.cam.w; let sd = i.b.x;
  let ta = t * (.16 + .05 * sd) * select(-1., 1., sd > .5) + sd * 40.;
  let R = 7. + 4. * sd;
  let C = S.xyz + i.a.yzw + vec3f(R * cos(ta), 1.5 * sin(ta * 2. + sd * 9.), R * .8 * sin(ta));
  let T = normalize(vec3f(-R * sin(ta), 3. * cos(ta * 2. + sd * 9.), R * .8 * cos(ta))) * select(-1., 1., sd > .5);
  let Sd = normalize(cross(vec3f(0., 1., 0.), T)); let Up = cross(T, Sd);
  let pu = sin(t * 2.4 + sd * 30.) * .5 + .5;
  var l = i.p; let f = -i.n.w;
  if (i.n.w > .5) { l = vec3f(l.x * (1. - .12 * pu), l.y, l.z * (1. - .12 * pu)); }
  else { l.x += sin(t * 2.4 + sd * 30. + f * 4.) * f * .08; l.z += cos(t * 2. + sd * 20. + f * 3.) * f * .08; l.y -= pu * f * .05; }
  let sz = i.b.y * S.w;
  // mantle axis (+y) points along the swim direction
  let dv = C - g.cam.xyz; let dd = length(dv);
  let w = C + dv / max(dd, .01) * ss(7., 1., dd) * 3. + (Sd * l.x + T * l.y + Up * l.z) * sz;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = Sd * i.n.x + T * i.n.y + Up * i.n.z; o.op = i.p; o.sd = i.b.w;
  o.lt = shadow1(w);
  return o;
}
@fragment fn fsSquid(i: VO) -> @location(0) vec4f {
  let n = normalize(i.n); let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let z = zone(i.wp);
  let tx = textureSample(tD, sR, i.op.xy * 4. + i.sd * 3.);
  // chromatophores: flickering red-orange spots on a translucent pinkish body, iridescent sheen
  var alb = mix(vec3f(.62, .4, .38), vec3f(.55, .1, .06), ss(.5, .62, tx.a + .1 * sin(g.cam.w * 3. + i.op.y * 20.)));
  alb = mix(alb, vec3f(.45, .35, .7), step(.75, i.sd) * .5);
  let ndv = sat(dot(n, V));
  let ir = .5 + .5 * cos(TAU * (vec3f(0., .33, .67) + ndv * 1.3 + tx.b));
  let E = sunE(i.wp.y, z) * i.lt;
  var c = alb * (E * (.25 + .75 * sat(dot(n, L))) + amb(i.wp, n, .9, z) * 1.25) + ir * pow(1. - ndv, 3.) * .25 + E * pow(sat(dot(n, normalize(V + L))), 40.) * .8;
  return fin(fog(c, i.wp, z));
}
// jellyfish: translucent glowing bells drifting around a swarm centre; the bell pulses and the tentacles trail
struct JO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) @interpolate(flat) h: vec2f, @location(3) f: f32 };
@vertex fn vsJelly(i: VI) -> JO {
  var o: JO;
  let S = wt.jel[u32(i.a.x + .5)]; let t = g.cam.w; let sd = i.b.x;
  let ph = t * (1.1 + sd * .6) + sd * 40.; let pu = sin(ph) * .5 + .5;
  let C = S.xyz + i.a.yzw + vec3f(sin(t * .11 + sd * 20.) * 2.2, sin(t * .23 + sd * 9.) * 1.6 + pu * .15, cos(t * .13 + sd * 30.) * 2.2);
  let sz = i.b.y * S.w;
  var l = i.p; let f = -i.n.w;
  if (i.n.w > .5) { l = vec3f(l.x * (1. - .14 * pu), l.y * (1. + .1 * pu), l.z * (1. - .14 * pu)); }
  else { let sw = vec2f(sin(t * 1.3 + f * 4. + sd * 10.), cos(t * 1.1 + f * 3.5 + sd * 7.)) * f * f * .28; l.x += sw.x; l.z += sw.y; l.y += pu * .1 * f; }
  let w = C + l * sz;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = i.n.xyz; o.h = vec2f(i.b.w, sd); o.f = i.n.w;
  return o;
}
@fragment fn fsJelly(i: JO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var n = normalize(i.n); if (!ff) { n = -n; }
  let v = i.wp - g.cam.xyz; let d = length(v); let V = -v / d;
  let z = zone(i.wp);
  let fres = pow(1. - abs(dot(n, V)), 2.);
  let bell = i.f > .5;
  let hc = mix(vec3f(1., .38, .78), vec3f(.35, .85, 1.), i.h.x);
  let tw = .75 + .25 * sin(g.cam.w * 2.1 + i.h.y * 50.);
  // glow: brighter in the grottos and in deep water, where the light is low
  let glow = hc * (.18 + .7 * g.sun.w + .5 * ss(-25., -60., i.wp.y)) * tw;
  var c = hc * (amb(i.wp, n, 1., z) * .5 + sunE(i.wp.y, z) * .08) * (.4 + fres) + glow * (select(.5, .25, bell) + fres * .9);
  var a = select(.45, .1 + fres * .55, bell);
  let T = exp(-SIG.g * d * g.fog.y) * ss(g.fog.x, g.fog.x * .8, d) * ss(.3, 1.2, d);
  a *= T;
  return vec4f(min(c * a, vec3f(12.)), a);
}
`;

// ---------------------------------------------------------------- water surface seen from below + background
const W_SURF = S_B + /*wgsl*/`
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let p = vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.;
  let R = select(g.fog.x * 1.1, 9000., g.cam.y > 0.); // from above, the sea reaches the horizon
  o.wp = vec3f(p.x * R, 0., p.y * R);
  o.cp = g.vp * vec4f(o.wp, 1.);
  return o;
}
// the sea seen from above: sky reflected with Fresnel, the deep body colour of the local water, the sun's glitter
fn seaTop(V: vec3f, s: vec2f, d: f32, W: vec2f) -> vec3f {
  // raindrops: rings spreading on the water (a cell of 1.4 m each, its own phase), close by
  var rg = 0.; var rs = vec2f(0.);
  if (g.env.w > .01 && d < 70.) {
    let cq = W * .7; let ci = floor(cq);
    for (var k = 0; k < 2; k++) {
      let cc = ci + vec2f(f32(k) * .5);
      let h = hs(cc.x * 17.3 + cc.y * 91.1 + f32(k) * 7.);
      let ph = fract(g.cam.w * 1.4 + h * 7.);
      let o = cq - cc - vec2f(fract(h * 13.), fract(h * 29.)) * .6 - .2;
      let r = length(o) - ph * .42;
      let w = ss(.05, 0., abs(r)) * (1. - ph) * step(1. - g.env.w * .8, fract(h * 51.));
      rg += w; rs += normalize(o + 1e-4) * w;
    }
    rg *= ss(70., 8., d);
  }
  let nu = normalize(vec3f(s.x * .45 + rs.x * .3, 1., s.y * .45 + rs.y * .3));
  let ci = sat(dot(-V, nu));
  let fr = .02 + .98 * pow(1. - ci, 5.);
  let R = reflect(V, nu);
  let refl = skyC(vec3f(R.x, abs(R.y), R.z));
  let body = (g.wat.rgb * vec3f(.05, .09, .12) * (1. + .6 * pow(sat(dot(-V, g.sky.xyz)), 2.)) + vec3f(.004, .02, .03)) * g.env.x;
  return mix(body, refl, fr) + vec3f(.5, .55, .6) * rg * (.15 + .85 * g.env.x) * .5 + g.sunc.rgb * .6 * (1. - g.env.y) * (pow(sat(dot(R, g.sky.xyz)), 350.) * 30. + pow(sat(dot(R, g.sky.xyz)), 40.) * .4);
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let v = i.wp - g.cam.xyz; let d = length(v); let V = v / d;
  let fl = ss(260., 60., d);
  let W = WP(i.wp);
  let s = (textureSample(tW, sR, W.xz * (79. / 1024.)).ba + textureSample(tW, sR, W.zx * (218. / 1024.) + .2).ba * .7 + textureSample(tW, sR, W.xz * (28. / 1024.) + .6).ba * .8) * fl * (.5 + 1.3 * g.env.z); // rougher in bad weather
  if (g.cam.y > 0.) { return fin(fog(seaTop(V, s, d, W.xz), i.wp, 0.)); }
  let n = normalize(vec3f(-s.x * .8, -1., -s.y * .8));
  let ci = sat(dot(V, -n));
  let k = 1. - 1.769 * (1. - ci * ci);
  let win = ss(0., .22, k);
  let rr = refract(V, n, 1.33);
  let sd = max(dot(rr, g.sun.xyz), 0.);
  let fr = pow(1. - sqrt(max(k, 0.)), 5.);
  // Snell's window: the sky itself (day, dusk, night, clouds) seen through the rippled surface
  let sky = (skyC(normalize(rr + vec3f(0., .02, 0.))) * .85 * clamp(1. + 3.8 * (s.x * .6 - s.y * .8), .25, 3.) + g.sunc.rgb * .6 * (1. - g.env.y) * (pow(sd, 60.) * 1.3 + pow(sd, 500.) * 12.)) * (1. - fr);
  let z = zone(i.wp);
  let R = reflect(V, n);
  let refl = fogIn(i.wp, R, 300., z, g.sun.xyz) * 1.15;
  let c = mix(refl, sky, win);
  return fin(fog(c, i.wp, z));
}
// behind everything: past the draw distance the water looks as it does at that distance
@vertex fn vsB(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let p = vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.;
  o.wp = g.cam.xyz + g.fwd.xyz + g.right.xyz * (p.x * g.right.w) + g.up.xyz * (p.y * g.up.w);
  o.cp = vec4f(p, 1e-7, 1.);
  return o;
}
@fragment fn fsB(i: VO) -> @location(0) vec4f {
  let rd = normalize(i.wp - g.cam.xyz);
  // above the surface: sky, and past the sea quad the open sea to the horizon
  if (g.cam.y > 0.) {
    if (rd.y >= 0.) { return fin(skyC(rd)); }
    return fin(mix(seaTop(rd, vec2f(0.), 9000., vec2f(0.)), skyC(vec3f(rd.x, .02, rd.z)) * .75, ss(-.08, 0., rd.y)));
  }
  let p = g.cam.xyz + rd * g.fog.x;
  return fin(fog(vec3f(0.), p, zone(p)));
}
`;

// ---------------------------------------------------------------- sprites: bubbles (alpha) and drifting particles (additive)
const W_SPR = S_B + /*wgsl*/`
struct VO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) pr: vec4f, @location(2) wp: vec3f };
fn quad(i: u32) -> vec2f { return vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.; }
// a: (vent slot, dx, dz, size), b: (phase, rise speed, -, wobble); the vent table gives the column base and height
@vertex fn vsBub(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> VO {
  var o: VO; let q = quad(vi); let t = g.cam.w;
  let V = wt.vent[u32(a.x + .5)]; let H = max(V.w, .1);
  let life = fract(t * b.y / H + b.x);
  let h = life * H;
  var p = vec3f(V.x + a.y, V.y + h, V.z + a.z);
  let wob = b.w * (.3 + h * .035);
  p.x += sin(t * 1.7 + b.x * 50. + h * .6) * wob + sin(h * .13 + b.x * 9.) * b.w * 2.;
  p.z += cos(t * 1.3 + b.x * 33. + h * .5) * wob + cos(h * .11 + b.x * 7.) * b.w * 2.;
  let sz = a.w * (.55 + .7 * life) * ss(0., .03, life) * ss(0., -1.2, p.y) * step(.2, V.w);
  let w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * sz;
  o.cp = g.vp * vec4f(w, 1.); o.uv = q; o.wp = p;
  o.pr = vec4f(b.x, sz, shadow1(p), 0.);
  return o;
}
@fragment fn fsBub(i: VO) -> @location(0) vec4f {
  let t = g.cam.w;
  let an = atan2(i.uv.y, i.uv.x + 1e-4);
  let big = ss(.04, .22, i.pr.y);
  let r = length(i.uv) / (.9 + big * .05 * sin(an * 3. + t * 5. + i.pr.x * 40.) + big * .02 * sin(an * 5. - t * 7.));
  let aa = fwidth(r) * 1.5;
  let disc = 1. - ss(1. - aa, 1., r);
  let rim = ss(.55, .98, r);
  let hl = ss(.34, .0, length(i.uv - vec2f(-.36, .42))) + .5 * ss(.2, .0, length(i.uv - vec2f(.4, -.42)));
  let z = zone(i.wp);
  let E = sunE(i.wp.y, z) * (.25 + .75 * i.pr.z);
  let hi = fogIn(i.wp, vec3f(0., 1., 0.), 80., z, g.sun.xyz) * 1.5;
  let lo = fogIn(i.wp, vec3f(0., -1., 0.), 80., z, g.sun.xyz);
  var c = mix(lo, hi, ss(-.5, .8, i.uv.y + rim * .4)) * (.5 + 1.2 * rim) + E * hl * 1.6;
  var al = disc * sat(.03 + rim * rim * rim * .9 + hl);
  let v = i.wp - g.cam.xyz; let d = length(v);
  let T = exp(-SIG.g * d) * ss(1.2, 3., d);
  c = c * T + fogIn(g.cam.xyz, v / d, d, z, g.sun.xyz) * (1. - T);
  al *= mix(.35, 1., T);
  return vec4f(min(max(c * al, vec3f(0.)), vec3f(20.)), al);
}
// drifting specks in a 44 m box that wraps around the camera (g.wrap.zw = camera x / z mod 44)
@vertex fn vsSnow(@builtin(vertex_index) vi: u32, @location(0) a: vec4f) -> VO {
  var o: VO; let q = quad(vi); let t = g.cam.w;
  let B = 44.;
  let pw = a.xyz * B + vec3f(t * .22, t * .05, t * .13) + .5 * vec3f(sin(t * .3 + a.x * 60.), sin(t * .23 + a.y * 50.), cos(t * .27 + a.z * 70.));
  let p = (fract((pw - vec3f(g.wrap.z, g.cam.y, g.wrap.w)) / B + .5) - .5) * B + g.cam.xyz;
  let d = length(p - g.cam.xyz);
  let sz = (.012 + .045 * a.w * a.w * a.w);
  let w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * max(sz, d * .0011);
  o.cp = g.vp * vec4f(w, 1.); o.uv = q; o.wp = p;
  let fade = ss(B * .5, B * .32, d) * ss(.6, 2.5, d) * min(1., sz / (d * .0011)) * ss(-.3, -1.5, p.y);
  let tw = .6 + .4 * sin(t * (1. + a.w * 2.) + a.x * 100.);
  o.pr = vec4f(fade * tw, shadow1(p), a.w, d);
  return o;
}
@fragment fn fsSnow(i: VO) -> @location(0) vec4f {
  let r = length(i.uv);
  let m = ss(1., .2, r);
  let z = zone(i.wp);
  let c = (sunE(i.wp.y, z) * i.pr.y * .8 + amb(i.wp, vec3f(0., 1., 0.), 1., z) * .3) * mix(vec3f(1.), vec3f(.7, 1., .9), i.pr.z);
  return vec4f(min(max(c * m * m * i.pr.x * exp(-SIG.g * i.pr.w), vec3f(0.)), vec3f(8.)), 0.);
}
`;

// ---------------------------------------------------------------- volumetric light shafts (1/RAYDIV resolution)
const W_RAYS = S_G + W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sR: sampler;
@group(0) @binding(2) var sS: sampler_comparison;
@group(0) @binding(3) var tSh: texture_depth_2d;
@group(0) @binding(4) var tW: texture_2d<f32>;
@group(0) @binding(5) var tDp: texture_depth${AA > 1 ? '_multisampled' : ''}_2d;
const RF = ${RAYDIV}.;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let dp = textureLoad(tDp, min(vec2i(fc.xy * RF), vec2i(textureDimensions(tDp)) - 1), 0);
  if (g.cam.y > 0.) { return vec4f(0., 0., 0., min(g.fwd.w / max(dp, 1e-6), 6e4)); }
  let uv = fc.xy * RF * g.res.zw;
  let nd = vec2f(uv.x * 2. - 1., 1. - uv.y * 2.);
  let rv = g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w);
  let rl = length(rv); let rd = rv / rl;
  // view distance, clamped: it is stored in an rgba16float target (max 65504) and the background's would overflow
  let zl = min(g.fwd.w / max(dp, 1e-6), 6e4);
  var tm = min(zl * rl, 120.);
  if (rd.y > 1e-4) { tm = min(tm, -g.cam.y / rd.y); }
  let ro = g.cam.xyz; let sx = g.sun.xyz; let k = kd(g.sun.w); let sgz = sg(g.sun.w);
  let dt = tm / ${RAYN}.;
  let j = ign(fc.xy);
  var acc = vec3f(0.);
  for (var n = 0; n < ${RAYN}; n++) {
    let t = (f32(n) + j) * dt;
    let p = ro + rd * t;
    let s = g.sm * vec4f(p, 1.);
    let vis = textureSampleCompareLevel(tSh, sS, vec2f(s.x * .5 + .5, .5 - s.y * .5), s.z - .0006);
    let q = p.xz + g.wrap.xy - sx.xz * (p.y / sx.y);
    let pat = ss(.3, .7, textureSampleLevel(tW, sR, q * (38. / 1024.), 2.5).r) * ss(.15, .6, textureSampleLevel(tW, sR, q.yx * (93. / 1024.) + .3, 2.).r);
    acc += exp(-sgz * t + k * (p.y / sx.y)) * (vis * (.012 + pat * 6.) * 1.3);
  }
  let mu = max(dot(rd, sx), 0.);
  let ph = mix(.2 + 2.0 * mu * mu * mu, .5, g.sun.w);
  let wc = g.wat.rgb + mix(vec3f(.04, .07, .05), vec3f(.28, .16, .12), g.sun.w);
  return vec4f(min(acc * dt * sgz * wc * g.sunc.rgb * ph * g.mis.y * (1. - .78 * g.sun.w) * (1. - g.cav.x) * (1. - .8 * g.env.y), vec3f(20.)), zl);
}
`;
// depth-aware 3x3 blur of the low-res shafts (hides the sampling dither)
const W_RBLUR = W_FS + /*wgsl*/`
@group(0) @binding(0) var tR: texture_2d<f32>;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = vec2i(fc.xy); let mx = vec2i(textureDimensions(tR)) - 1;
  let c = textureLoad(tR, p, 0);
  var acc = vec3f(0.); var ws = 0.;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let r = textureLoad(tR, clamp(p + vec2i(x, y), vec2i(0), mx), 0);
    let w = 1. / (.03 + abs(r.a - c.a) / max(c.a, 1e-3));
    acc += r.rgb * w; ws += w;
  } }
  return vec4f(acc / ws, c.a);
}
`;

// ---------------------------------------------------------------- final composite
const W_POST = S_G + W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sC: sampler;
@group(0) @binding(2) var tS: texture_2d<f32>;
@group(0) @binding(3) var tR: texture_2d<f32>;
@group(0) @binding(4) var tB: texture_2d<f32>;
@group(0) @binding(5) var tDp: texture_depth${AA > 1 ? '_multisampled' : ''}_2d;
@group(0) @binding(6) var tDs: texture_depth${AA > 1 ? '_multisampled' : ''}_2d; // depth before the flora (sonar)
const RF = ${RAYDIV}.;
fn tmap(x: vec3f) -> vec3f { return sat3((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14)); }
fn sat3(x: vec3f) -> vec3f { return clamp(x, vec3f(0.), vec3f(1.)); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = vec2i(fc.xy);
  let uv = fc.xy * g.res.zw;
  let zf = min(g.fwd.w / max(textureLoad(tDp, px, 0), 1e-6), 6e4);
  // bilateral (depth-aware) upsample of the low-res shafts
  let h = fc.xy / RF - .5; let b = floor(h); let f = h - b; let bi = vec2i(b);
  let mx = vec2i(textureDimensions(tR)) - 1;
  var acc = vec3f(0.); var ws = 0.;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let r = textureLoad(tR, clamp(bi + o, vec2i(0), mx), 0);
    let bw = mix(1. - f.x, f.x, f32(o.x)) * mix(1. - f.y, f.y, f32(o.y));
    let w = (bw + .02) / (.02 + abs(r.a - zf) / zf);
    acc += r.rgb * w; ws += w;
  }
  var c = textureLoad(tS, px, 0).rgb + acc / max(ws, 1e-6);
  let bl = textureSampleLevel(tB, sC, uv, 0.).rgb;
  c = mix(c, bl, .06) + bl * .03;
  c *= g.mis.x;
  // sonar pulse (from your submarine): a ring that sweeps out at 110 m/s, outlining rock, creatures and structures in
  // cyan as it passes; the outlines it leaves fade over a few seconds (g.son: origin in render space, age in seconds)
  if (g.son.w >= 0. && g.son.w < 6.) {
    // the pulse passes through kelp, grass and algae: it reads the depth of the rock and creatures only
    let zf = min(g.fwd.w / max(textureLoad(tDs, px, 0), 1e-6), 6e4);
    let nd = vec2f(uv.x * 2. - 1., 1. - uv.y * 2.);
    let ray = g.fwd.xyz + nd.x * g.right.w * g.right.xyz + nd.y * g.up.w * g.up.xyz;
    let D = distance(g.cam.xyz + ray * zf, g.son.xyz); let R = g.son.w * 110.;
    let mxp = vec2i(textureDimensions(tS)) - 1;
    let zr = min(g.fwd.w / max(textureLoad(tDs, min(px + vec2i(1, 0), mxp), 0), 1e-6), 6e4);
    let zu = min(g.fwd.w / max(textureLoad(tDs, min(px + vec2i(0, 1), mxp), 0), 1e-6), 6e4);
    let edge = ss(.015, .1, (abs(zr - zf) + abs(zu - zf)) / max(zf, 1.));
    let band = exp(-pow((D - R) / 6., 2.));
    let seen = select(0., exp(-(g.son.w - D / 110.) * .8), D < R);
    let geo = select(1., 0., zf > 5e4) * ss(6., 18., D) * ss(330., 280., D);
    let glow = (band * (.5 + edge) * 1.6 + seen * (.06 + edge * 1.3)) * geo;
    c = c * (1. - .3 * min(band + seen, 1.) * geo) + vec3f(.25, .95, 1.) * glow;
  }
  // rain above the surface: thin falling streaks, a darker, greyer view
  // three layers: near (big, fast, slanted by the wind), middle and far (fine, slow); drops catch the light of the sky
  if (g.cam.y > 0. && g.env.w > .01) {
    var rain = 0.;
    for (var l = 0; l < 3; l++) {
      let fl = f32(l); let sc = vec2f(55. + fl * 70., 2.5 + fl * 2.);
      let rp = vec2f((uv.x + uv.y * (.12 + .1 * g.env.z) / (1. + fl)) * sc.x, uv.y * sc.y - g.cam.w * (5. - fl * 1.2) + fl * .37);
      let cid = floor(rp); let fr = fract(rp);
      let h = hs(cid.x * 13.1 + cid.y * 71.7 + fl * 5.);
      let len = .35 + .4 * fract(h * 7.);
      rain += step(1. - (.22 + .1 * fl) * g.env.w, h) * ss(.16, 0., abs(fr.x - .5 + (fract(h * 3.) - .5) * .6)) * ss(0., .15, fr.y) * ss(len, len * .6, fr.y) * (1. - fl * .3);
    }
    c = c * (1. - .1 * g.env.w) + (vec3f(.3, .34, .4) * (.3 + 1.2 * g.env.x) + g.sky.w * 2.) * rain * .55;
  }
  // a missile blast (g.exp: centre in render space, age): a flash and a shock ring racing out at 60 m/s
  if (g.exp.w >= 0.) {
    let nd2 = vec2f(uv.x * 2. - 1., 1. - uv.y * 2.);
    let ray2 = g.fwd.xyz + nd2.x * g.right.w * g.right.xyz + nd2.y * g.up.w * g.up.xyz;
    let Db = distance(g.cam.xyz + ray2 * min(zf, 400.), g.exp.xyz); let Rb = g.exp.w * 60.;
    let ring = exp(-pow((Db - Rb) / 3.5, 2.)) * (1. - g.exp.w / 1.2) * ss(220., 60., Db);
    let near = ss(260., 20., distance(g.cam.xyz, g.exp.xyz));
    c += vec3f(1., .72, .45) * (ring * 1.4 + exp(-g.exp.w * 7.) * .5 * near);
  }
  let q = uv - .5;
  c *= 1. - dot(q, q) * .55;
  c = tmap(c);
  let l0 = dot(c, vec3f(.2126, .7152, .0722));
  let l = mix(l0, l0 * l0 * (3. - 2. * l0), .55);
  c *= l / max(l0, 1e-4);
  c = mix(c, vec3f(l), ss(.55, 1., l) * .1);
  c = mix(vec3f(l), c, .93) + vec3f(.008, .002, 0.);
  c = pow(max(c, vec3f(0.)), vec3f(1. / 2.2));
  let n = ign(fc.xy) + ign(fc.xy + 37.) - 1.;
  return vec4f(c + n / 255., 1.);
}
`;

// ---------------------------------------------------------------- upscaling (FSR 1) and frame generation
// The scene renders at a lower internal resolution; these passes write the display image.
// AMD FidelityFX Super Resolution 1.0 (MIT licence, Copyright (c) 2021 Advanced Micro Devices, Inc.), ported to WGSL.
// EASU: edge-adaptive spatial upsampling. 12 taps around the input pixel, a direction and an edge length estimated from
// the luma gradients of the 4 nearest pixels, then a Lanczos-2-like kernel stretched along the edge, clamped to the
// 2x2 neighbourhood (no ringing).
const W_EASU = W_FS + /*wgsl*/`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> U: vec4f; // input size, output size
fn ld(p: vec2i) -> vec3f { return textureLoad(src, clamp(p, vec2i(0), vec2i(U.xy) - 1), 0).rgb; }
fn lu(c: vec3f) -> f32 { return c.b * .5 + (c.r * .5 + c.g); }
var<private> dir: vec2f; var<private> len: f32;
fn eset(w: f32, a: f32, b: f32, c: f32, d: f32, e: f32) {
  let dc = d - c; let cb = c - b; let dx = d - b;
  dir.x += dx * w; var lx = clamp(abs(dx) / max(max(abs(dc), abs(cb)), 1e-5), 0., 1.); len += lx * lx * w;
  let ec = e - c; let ca = c - a; let dy = e - a;
  dir.y += dy * w; var ly = clamp(abs(dy) / max(max(abs(ec), abs(ca)), 1e-5), 0., 1.); len += ly * ly * w;
}
var<private> aC: vec3f; var<private> aW: f32;
fn tap(off: vec2f, d: vec2f, l2: vec2f, lob: f32, clp: f32, c: vec3f) {
  var v = vec2f(off.x * d.x + off.y * d.y, off.x * -d.y + off.y * d.x) * l2;
  let d2 = min(dot(v, v), clp);
  var wB = .4 * d2 - 1.; var wA = lob * d2 - 1.; wB *= wB; wA *= wA;
  let w = (1.5625 * wB - .5625) * wA;
  aC += c * w; aW += w;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let pq = fc.xy * U.xy / U.zw - .5; let fp = floor(pq); let pp = pq - fp; let i = vec2i(fp);
  let b = ld(i + vec2i(0, -1)); let c = ld(i + vec2i(1, -1));
  let e = ld(i + vec2i(-1, 0)); let f = ld(i); let g = ld(i + vec2i(1, 0)); let h = ld(i + vec2i(2, 0));
  let ii = ld(i + vec2i(-1, 1)); let j = ld(i + vec2i(0, 1)); let k = ld(i + vec2i(1, 1)); let l = ld(i + vec2i(2, 1));
  let n = ld(i + vec2i(0, 2)); let o = ld(i + vec2i(1, 2));
  let bL = lu(b); let cL = lu(c); let eL = lu(e); let fL = lu(f); let gL = lu(g); let hL = lu(h);
  let iL = lu(ii); let jL = lu(j); let kL = lu(k); let lL = lu(l); let nL = lu(n); let oL = lu(o);
  dir = vec2f(0.); len = 0.;
  eset((1. - pp.x) * (1. - pp.y), bL, eL, fL, gL, jL);
  eset(pp.x * (1. - pp.y), cL, fL, gL, hL, kL);
  eset((1. - pp.x) * pp.y, fL, iL, jL, kL, nL);
  eset(pp.x * pp.y, gL, jL, kL, lL, oL);
  var d = dir; let r2 = dot(d, d); let zro = r2 < 1. / 32768.;
  d = select(d * inverseSqrt(max(r2, 1e-12)), vec2f(1., 0.), zro);
  var ln = len * .5; ln *= ln;
  let st = dot(d, d) / max(abs(d.x), abs(d.y));
  let l2 = vec2f(1. + (st - 1.) * ln, 1. - .5 * ln);
  let lob = .5 + ((1. / 4. - .04) - .5) * ln; let clp = 1. / lob;
  aC = vec3f(0.); aW = 0.;
  tap(vec2f(0., -1.) - pp, d, l2, lob, clp, b); tap(vec2f(1., -1.) - pp, d, l2, lob, clp, c);
  tap(vec2f(-1., 1.) - pp, d, l2, lob, clp, ii); tap(vec2f(0., 1.) - pp, d, l2, lob, clp, j);
  tap(vec2f(0., 0.) - pp, d, l2, lob, clp, f); tap(vec2f(-1., 0.) - pp, d, l2, lob, clp, e);
  tap(vec2f(1., 1.) - pp, d, l2, lob, clp, k); tap(vec2f(2., 1.) - pp, d, l2, lob, clp, l);
  tap(vec2f(2., 0.) - pp, d, l2, lob, clp, h); tap(vec2f(1., 0.) - pp, d, l2, lob, clp, g);
  tap(vec2f(1., 2.) - pp, d, l2, lob, clp, o); tap(vec2f(0., 2.) - pp, d, l2, lob, clp, n);
  let mn = min(min(f, g), min(j, k)); let mx = max(max(f, g), max(j, k));
  return vec4f(clamp(aC / aW, mn, mx), 1.);
}
`;
// RCAS: robust contrast-adaptive sharpening (5 taps, the lobe limited so it never clips), at output resolution.
// U.x is the strength (0 = plain copy, 1 = FSR's maximum).
const W_RCAS = W_FS + /*wgsl*/`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> U: vec4f;
fn ld(p: vec2i) -> vec3f { return textureLoad(src, clamp(p, vec2i(0), vec2i(textureDimensions(src)) - 1), 0).rgb; }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = vec2i(fc.xy);
  let b = ld(p + vec2i(0, -1)); let d = ld(p + vec2i(-1, 0)); let e = ld(p); let f = ld(p + vec2i(1, 0)); let h = ld(p + vec2i(0, 1));
  let mn4 = min(min(b, d), min(f, h)); let mx4 = max(max(b, d), max(f, h));
  let hitMin = min(mn4, e) / max(4. * max(mx4, e), vec3f(1e-5));
  let hitMax = (1. - max(mx4, e)) / min(4. * mn4 - 4., vec3f(-1e-5));
  let lr = max(-hitMin, hitMax);
  let lobe = max(-(.25 - 1. / 16.), min(max(lr.r, max(lr.g, lr.b)), 0.)) * U.x;
  return vec4f(clamp((lobe * (b + d + f + h) + e) / (4. * lobe + 1.), vec3f(0.), vec3f(1.)), 1.);
}
`;
// Frame generation: an in-between frame made from the last rendered one. Each output pixel looks for the point of the
// last frame that lands on it with the current camera: start at the same screen position, read the depth there, move
// the point into the current view and step the guess by the error (4 iterations). Depth 0 is the far plane (reverse
// Z): those pixels only rotate. Moving creatures keep their last pose until the next rendered frame.
const W_GEN = W_FS + /*wgsl*/`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var sm: sampler;
@group(0) @binding(2) var tDp: texture_depth${AA > 1 ? '_multisampled' : ''}_2d;
@group(0) @binding(3) var<uniform> U: array<vec4f, 7>; // last r, u, f (+ tan x, tan y, near), current r, u, f (+ size), move
fn proj(p: vec3f) -> vec3f { let z = dot(p, U[5].xyz); return vec3f(dot(p, U[3].xyz) / (z * U[0].w), dot(p, U[4].xyz) / (z * U[1].w), z); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let sz = vec2f(U[3].w, U[4].w);
  let t = vec2f(fc.x / sz.x * 2. - 1., 1. - fc.y / sz.y * 2.);
  var g = t;
  for (var it = 0; it < 4; it++) {
    let uv = vec2f(g.x * .5 + .5, .5 - g.y * .5);
    let d = textureLoad(tDp, clamp(vec2i(uv * sz), vec2i(0), vec2i(sz) - 1), 0);
    let ray = U[2].xyz + g.x * U[0].w * U[0].xyz + g.y * U[1].w * U[1].xyz;
    let p = select(ray * (U[2].w / max(d, 1e-9)) - U[6].xyz, ray, d < 1e-7);
    let c = proj(p);
    if (c.z <= 1e-4) { break; }
    g = clamp(g + t - c.xy, vec2f(-1.), vec2f(1.));
  }
  return vec4f(textureSampleLevel(src, sm, vec2f(g.x * .5 + .5, .5 - g.y * .5), 0.).rgb, 1.);
}
`;

// ---------------------------------------------------------------- imported models (glTF / OBJ): textured, three classes
// instance: a (render-space position, scale), b (rotation), c (class 0 structure / 1 plant / 2 creature, seed, phase, speed)
// group 2: the material's base-colour texture (sRGB) and (base colour rgb, alpha cutout)
const W_CUST = S_B + /*wgsl*/`
@group(2) @binding(0) var tA: texture_2d<f32>;
// material: base colour + alpha cut-off, emission
struct MT { c: vec4f, e: vec4f };
@group(2) @binding(1) var<uniform> mt: MT;
@group(2) @binding(2) var tE: texture_2d<f32>; // emissive texture (1x1 white when the material has none)
// skinned models: joint matrices of every pose this frame (main.js skinPose); an instance's pose starts at d.x
@group(3) @binding(0) var<storage, read> JM: array<mat4x4f>;
// instance: a (position, scale), b (rotation), c (class, seed, phase, speed), d (pose index or -1, tint rgb or 0)
struct CI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) uv: vec2f, @location(3) a: vec4f, @location(4) b: vec4f, @location(5) c: vec4f, @location(6) d: vec4f };
struct SK { @location(7) j: vec4u, @location(8) w: vec4f };
struct CO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) tint: vec3f };
fn placeC(i: CI, l: vec3f, n: vec3f) -> CO {
  var o: CO;
  let w = i.a.xyz + qrot(i.b, l * i.a.w);
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = qrot(i.b, n); o.uv = i.uv;
  o.tint = select(vec3f(1.), i.d.yzw, i.d.y + i.d.z + i.d.w > 0.);
  return o;
}
// skinned: the four weighted joints of the instance's pose move the vertex
@vertex fn vsCS(i: CI, s: SK) -> CO {
  let b = u32(max(i.d.x, 0.));
  let M = JM[b + s.j.x] * s.w.x + JM[b + s.j.y] * s.w.y + JM[b + s.j.z] * s.w.z + JM[b + s.j.w] * s.w.w;
  return placeC(i, (M * vec4f(i.p, 1.)).xyz, (M * vec4f(i.n.xyz, 0.)).xyz);
}
@vertex fn vsC(i: CI) -> CO {
  let t = g.cam.w; var l = i.p; let cls = i32(i.c.x + .5);
  if (cls == 1) {
    // plants sway, more toward the top
    let k = l.y * l.y;
    l.x += sin(t * .9 + i.c.y * 20. + l.y * 2.) * .07 * k; l.z += cos(t * .7 + i.c.y * 13. + l.y * 1.7) * .05 * k;
  } else if (cls == 2) {
    // creatures swim: a body wave running from the head (+z) to the tail, growing toward the tail
    let tail = max(.35 - l.z, 0.);
    l.x += sin(l.z * 9. - t * i.c.w * 7. + i.c.z) * .1 * tail * tail;
  }
  return placeC(i, l, i.n.xyz);
}
@fragment fn fsC(i: CO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let tx = textureSample(tA, sR, i.uv); let te = textureSample(tE, sR, i.uv).rgb;
  let dist = length(i.wp - g.cam.xyz);
  let ca = caus(i.wp, dist);
  if (mt.c.w > 0. && tx.a < mt.c.w) { discard; }
  var n = normalize(i.n); if (!ff) { n = -n; }
  let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp); let z = zone(i.wp);
  let alb = tx.rgb * mt.c.rgb * i.tint;
  let E = sunE(i.wp.y, z) * shadow4(i.wp + n * .2);
  var c = alb * (E * sat(dot(n, L)) * (.25 + ca) + amb(i.wp, n, .9, z) * 1.15 + side(i.wp, n, .8, z) * .6);
  c += E * pow(sat(dot(n, normalize(V + L))), 32.) * .25;
  // inside a submarine: the cabin light (g.fog.w), and every material's own glow
  c += alb * g.fog.w + mt.e.rgb * te;
  return fin(fog(c, i.wp, z));
}
`;
