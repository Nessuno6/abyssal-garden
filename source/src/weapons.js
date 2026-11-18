// ============================================================================
// weapons: your submarine's missile launcher
// ============================================================================
// X (or the Fire button) while piloting launches a missile from the sub's nose: 6 in the rack, one reloads every 5 s
// (and takes 3 % power; creative: free). It leaves at 45 m/s plus the sub's speed, accelerates to 85 m/s and homes on
// the leviathan or creature nearest the line of fire (within 30 deg and 260 m), turning up to 1.4 rad/s. It explodes on
// rock or structures, near its target, or after 7 s. The blast lights the water (a moving light while it flies), sends
// a shock ring out (post shader, g.exp), shakes the camera and is heard (muffled with distance).
// Leviathans hit within 22 m flee and roar; three hits drive one off (it fades and comes back far away). Fish and
// creatures nearby scatter. In LAN games other players see your missiles fly and explode (no damage from theirs).
const MIS = [], BLAST = [], WLIGHTS = [], MIS_MAX = 6, MIS_RELOAD = 5;
const LHP = new Float64Array(64).fill(3), LDIE = new Float64Array(64).fill(-1);
let wpnAmmo = MIS_MAX, wpnReload = 0, shake = 0;
function subFire() {
  if (SUBM.mode !== 'pilot' || SUBM.m < 0) return;
  if (wpnAmmo <= 0 && !CREATIVE) { subSay(`Reloading… (${wpnReload.toFixed(1)} s)`); return; }
  if (!CREATIVE) { if (SUBM.power < 3) { subSay('Not enough power to fire'); return; } SUBM.power -= 3; wpnAmmo--; }
  const hb = CUSTOM[SUBM.m].hb, fw = [sin(SUBM.yaw) * cos(SUBM.pit), sin(SUBM.pit), -cos(SUBM.yaw) * cos(SUBM.pit)], L = hb[2] * SUB_LEN + 2;
  const p = [SUBM.x + fw[0] * L, SUBM.y + fw[1] * L - hb[1] * SUB_LEN * 0.3, SUBM.z + fw[2] * L];
  const v = [SUBM.vx + fw[0] * 45, SUBM.vy + fw[1] * 45, SUBM.vz + fw[2] * 45];
  MIS.push({ p, v, t: 0, own: true, tg: wpnTarget(p, fw) });
  wpnSound('launch', p);
  subSay(CREATIVE ? 'Missile away' : `Missile away · ${wpnAmmo} left`);
  if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify({ t: 'mis', p: p.map((x) => +x.toFixed(2)), v: v.map((x) => +x.toFixed(2)) }));
}
// the target: built-in leviathan heads, imported leviathans, creatures (slot centres), nearest to the line of fire
function wpnTarget(p, fw) {
  let best = null, bs = 1e9;
  const look = (x, y, z, ref) => {
    const dx = x - p[0], dy = y - p[1], dz = z - p[2], d = hypot(dx, dy, dz); if (d > 260 || d < 4) return;
    const c = (dx * fw[0] + dy * fw[1] + dz * fw[2]) / d; if (c < 0.866) return;
    const s = d * (2 - c); if (s < bs) { bs = s; best = ref; }
  };
  for (let i = 0; i < nLH; i++) if (i >= NLEV || LDIE[i] < 0) look(LHEAD[i * 3], LHEAD[i * 3 + 1], LHEAD[i * 3 + 2], { k: 'h', i });
  for (let s = 0; s < LIFEN[6]; s++) if (CSK[s] === 0) look(CUS[s * 4], CUS[s * 4 + 1], CUS[s * 4 + 2], { k: 'c', i: s });
  return best;
}
function wpnTargetPos(tg) {
  if (!tg) return null;
  if (tg.k === 'h') return tg.i < nLH ? [LHEAD[tg.i * 3], LHEAD[tg.i * 3 + 1], LHEAD[tg.i * 3 + 2]] : null;
  return [CUS[tg.i * 4], CUS[tg.i * 4 + 1], CUS[tg.i * 4 + 2]];
}
function wpnNetIn(m) { if (Array.isArray(m.p) && Array.isArray(m.v)) { MIS.push({ p: m.p.slice(), v: m.v.slice(), t: 0, own: false, tg: null }); wpnSound('launch', m.p); } }
// per frame (after the sub moves): fly, steer, hit, blast; reload; the lights and the instances to draw
function wpnTick(dt) {
  if (wpnAmmo < MIS_MAX) { wpnReload -= dt; if (wpnReload <= 0) { wpnAmmo++; wpnReload = MIS_RELOAD; if (SUBM.mode === 'pilot') subSay(`Missile reloaded · ${wpnAmmo}`); } } else wpnReload = MIS_RELOAD;
  for (let k = MIS.length - 1; k >= 0; k--) {
    const M = MIS[k]; M.t += dt;
    const sp = hypot(M.v[0], M.v[1], M.v[2]) || 1, want = min(85, sp + 60 * dt);
    let ux = M.v[0] / sp, uy = M.v[1] / sp, uz = M.v[2] / sp;
    const T = M.t > 0.25 ? wpnTargetPos(M.tg) : null;
    if (T) { // turn toward the target, at most 1.4 rad/s
      let tx = T[0] - M.p[0], ty = T[1] - M.p[1], tz = T[2] - M.p[2]; const tl = hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const a = Math.acos(clamp(ux * tx + uy * ty + uz * tz, -1, 1)), f = a > 1e-4 ? min(1, 1.4 * dt / a) : 1;
      ux += (tx - ux) * f; uy += (ty - uy) * f; uz += (tz - uz) * f; const l = hypot(ux, uy, uz) || 1; ux /= l; uy /= l; uz /= l;
      if (tl < 9) { wpnBlast(M, M.p); MIS.splice(k, 1); continue; }
    }
    M.v[0] = ux * want; M.v[1] = uy * want; M.v[2] = uz * want;
    // move in steps under 2 m, testing rock and structures (not the moving capsules: the sub that fired is one)
    const n = ceil(want * dt / 2), nd = nDyn; nDyn = 0; let hit = null;
    for (let s = 0; s < n && !hit; s++) {
      M.p[0] += M.v[0] * dt / n; M.p[1] += M.v[1] * dt / n; M.p[2] += M.v[2] * dt / n;
      if (sdScene(M.p[0], M.p[1], M.p[2]) < 0.6 || M.p[1] > -0.3) hit = M.p;
      else if (M.t > 0.3) for (let i = 0; i < nLH; i++) if (hypot(LHEAD[i * 3] - M.p[0], LHEAD[i * 3 + 1] - M.p[1], LHEAD[i * 3 + 2] - M.p[2]) < 7) { hit = M.p; break; }
    }
    nDyn = nd;
    if (hit || M.t > 7) { wpnBlast(M, M.p); MIS.splice(k, 1); }
  }
  for (let k = BLAST.length - 1; k >= 0; k--) { BLAST[k].t += dt; if (BLAST[k].t > 2.5) BLAST.splice(k, 1); }
  shake *= exp(-dt * 5);
  // leviathans driven off: fade over 2 s, then back far away (behind you), healed
  for (let i = 0; i < NLEV; i++) if (LDIE[i] >= 0 && F[TIME] - LDIE[i] > 2) {
    LDIE[i] = -1; LHP[i] = 3; spawnAnimal(LEV, i, true, LIFELO[4], LIFEHI[4], 3);
    LEV[i * 4] = 2 * F[CX] - LEV[i * 4]; LEV[i * 4 + 2] = 2 * F[CZ] - LEV[i * 4 + 2]; LEV[i * 4 + 1] = min(hAt(LEV[i * 4], LEV[i * 4 + 2]) + 30, -5);
  }
  // lights: each missile's flare, each blast's flash
  WLIGHTS.length = 0;
  for (const M of MIS) WLIGHTS.push({ x: M.p[0], y: M.p[1], z: M.p[2], rad: 24, c: [1, 0.62, 0.3], i: 1.6 });
  for (const B of BLAST) WLIGHTS.push({ x: B.p[0], y: B.p[1], z: B.p[2], rad: 80, c: [1, 0.7, 0.4], i: 9 * exp(-B.t * 3.2) });
}
function wpnBlast(M, p) {
  const P = [p[0], p[1], p[2]]; BLAST.push({ p: P, t: 0 });
  const d = hypot(P[0] - F[CX], P[1] - F[CY], P[2] - F[CZ]);
  shake = max(shake, clamp(1.5 - d / 80, 0, 1.5));
  wpnSound('blast', P);
  if (!M.own) return;
  // damage: built-in leviathans (head or body within 22 m), your own sub if you were too close
  const LG = NSCH + NMAN + NJEL + NTUR;
  for (let i = 0; i < NLEV; i++) {
    if (LDIE[i] >= 0) continue;
    const o = i * 8, R = LB.lev[o + 3], w = LB.lev[o + 5], len = LB.lev[o + 6], sg = w < 0 ? -1 : 1, a0 = F[TIME] * w + LB.lev[o + 4];
    let near = 1e9;
    for (let k = 0; k <= 6; k++) { const a = a0 - sg * (k / 6) * len / R; near = min(near, hypot(LEV[i * 4] + R * cos(a) - P[0], LEV[i * 4 + 1] + 5 * sin(0.45 * a + LB.lev[o + 7]) - P[1], LEV[i * 4 + 2] + R * 0.85 * sin(a) - P[2])); }
    if (near > 22) continue;
    LHP[i]--; BST[LG + i] = 2; BTMR[LG + i] = 30;
    if (LHP[i] <= 0) { LDIE[i] = F[TIME]; subSay('The leviathan is driven off'); } else subSay(`Hit! The leviathan flees (${LHP[i]} more to drive it off)`);
  }
  if (SUBM.m >= 0 && hypot(P[0] - SUBM.x, P[1] - SUBM.y, P[2] - SUBM.z) < 14) subDamage(12, 'too close to your own blast');
}
// fade of a built-in leviathan being driven off (levPut)
const levFade = (i) => (LDIE[i] < 0 ? 1 : clamp(1 - (F[TIME] - LDIE[i]) / 2, 0, 1));
// the missiles as instances (updateLandmarks): mesh TORP_MESH, material 10 (dark body, a band in your colour, a glowing tail)
function wpnInstances(add, cx, cy, cz, R) {
  for (const M of MIS) {
    const sp = hypot(M.v[0], M.v[1], M.v[2]) || 1, nx = M.v[0] / sp, ny = M.v[1] / sp, nz = M.v[2] / sp;
    const ax = nz, az = -nx, l = hypot(ax, az), q = l < 1e-4 ? (ny > 0 ? [0, 0, 0, 1] : [1, 0, 0, 0]) : qAxis(ax, 0, az, Math.acos(clamp(ny, -1, 1)));
    if (!M.L) M.L = { k: 12, x: 0, y: 0, z: 0, q, sc: 1, rad: 3, mesh: TORP_MESH, mat: 10, seed: M.own ? nameHue(SAVE.nick || '') : 0.6, free: true };
    M.L.x = M.p[0]; M.L.y = M.p[1]; M.L.z = M.p[2]; M.L.q = q;
    add(M.L, cx, cy, cz, R);
    // the trail: glowing amber sparks along the last ~0.5 s of the path, shrinking
    if (!M.tr) { M.tr = []; M.trT = 0; }
    if (M.t - M.trT > 0.035) { M.trT = M.t; M.tr.unshift({ k: 12, x: M.p[0], y: M.p[1], z: M.p[2], q: [0, 0, 0, 1], sc: 0.3, rad: 1, mesh: 27, mat: 7, seed: 0.2276 + 0.01 * Math.random(), free: true }); if (M.tr.length > 14) M.tr.pop(); }
    for (let j = 0; j < M.tr.length; j++) { const T = M.tr[j]; T.sc = 0.42 * (1 - j / 15); T.q = qAxis(1, 0.3, 0.2, M.t * 7 + j); add(T, cx, cy, cz, R); }
  }
}
// G.exp: the nearest fresh blast (render space, age) for the shock ring in the post shader
function wpnUniforms(m) {
  let B = null; for (const b of BLAST) if (!B || b.t < B.t) B = b;
  if (B && B.t < 1.2) { m[196] = B.p[0] - F[CX]; m[197] = B.p[1]; m[198] = B.p[2] - F[CZ]; m[199] = B.t; } else m[199] = -1;
  // the camera shakes after a blast nearby
  if (shake > 0.01) { m[13] += (Math.random() - 0.5) * shake * 0.04; m[15] += 0; }
}
function wpnSound(kind, p) {
  if (!AC || muted) return;
  const t = AC.currentTime, d = hypot(p[0] - F[CX], p[1] - F[CY], p[2] - F[CZ]), far = clamp(1 - d / 400, 0, 1);
  if (!(far > 0)) return;
  const dur = kind === 'blast' ? 2.2 : 0.9, n = AC.sampleRate * dur | 0, buf = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: AC.sampleRate }), D = buf.getChannelData(0);
  for (let i = 0, b = 0; i < n; i++) {
    const u = i / n;
    if (kind === 'blast') { b = (b + 0.09 * (Math.random() * 2 - 1)) / 1.09; D[i] = b * 9 * (u < 0.01 ? u / 0.01 : exp(-(u - 0.01) * 4)) + 0.6 * sin(i / AC.sampleRate * TAU * 38 * (1 - 0.5 * u)) * exp(-u * 6); }
    else { D[i] = (Math.random() * 2 - 1) * 0.5 * sin(PI * u) * (1 - u) + 0.4 * sin(i / AC.sampleRate * TAU * 70) * exp(-u * 12); }
  }
  const src = new AudioBufferSourceNode(AC, { buffer: buf }), f = new BiquadFilterNode(AC, { type: 'lowpass', frequency: kind === 'blast' ? 140 + 900 * far * far : 2500 * (0.3 + far) }), g = new GainNode(AC, { gain: (kind === 'blast' ? 1.1 : 0.45) * far });
  src.connect(f); f.connect(g); g.connect(OUT); src.start(t);
}
