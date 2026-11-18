// ============================================================================
// your submarine: board, pilot, walk inside, systems, LAN passengers
// ============================================================================
// Imported submarine-class models no longer cruise the world: the first one is every player's own sub (one each), and
// a model named "<sub name>_interior" is its inside (cockpit and command centre, built in the same frame as the hull,
// with marker nodes: pilot_seat, hatch, hatch_inside, sonar, lights_panel, power_panel, repair_panel, passenger_1..3,
// floor_min / floor_max). Without an interior the sub still works: boarding goes straight to the pilot's seat.
//
// Modes: out (swimming), inside (walking the command centre), pilot (driving), passenger (in a seat of someone's sub).
// F (or the Use button) interacts: board at the hatch, sit at the pilot seat, panels, leave by the hatch. L lights,
// R sonar ping, Shift boost (charges back like stamina). Arcade handling: the sub turns toward where you look.
// Systems: power (thrust, boost, lights, sonar and repairs use it; recharges, faster near the surface), hull (crashes,
// leviathan bites and crush depth hurt it; repair it at the repair panel), crush depth. Creative mode: no damage and
// no power use. In LAN games each player has a sub; others can board yours as passengers and work the lights / sonar.
const SUB_LEN = 22, CRUSH = -280;
const SUBM = { m: -1, i: -1, mode: 'out', x: 0, y: 0, z: 0, yaw: 0, pit: 0, vx: 0, vy: 0, vz: 0, yr: 0, hull: 100, power: 100, boost: 100, lights: false,
  lx: 0, ly: 0, lz: 0, ride: '', seat: 0, t: 0, clip: -1, bt: 0, boosting: false, boostHeld: false, msg: '', msgT: 0, use: null, ping: -1e9, blips: [], hit: 0 };
const SBQ = [0, 0, 0, 1], SV = new Float64Array(3);
let subNoCol = false;
// model space (normalised units) -> world, for a sub at (x, y, z) heading yaw (camera style) with pitch
function subQ(yaw, pit) { const q = qMul(qAxis(0, 1, 0, PI - yaw), qAxis(1, 0, 0, -pit)); SBQ[0] = q[0]; SBQ[1] = q[1]; SBQ[2] = q[2]; SBQ[3] = q[3]; return SBQ; }
function subW(T, p) { const q = subQ(T.yaw, T.pit); qrotInto(q[0], q[1], q[2], q[3], p[0] * SUB_LEN, p[1] * SUB_LEN, p[2] * SUB_LEN); SV[0] = T.x + V3[0]; SV[1] = T.y + V3[1]; SV[2] = T.z + V3[2]; return SV; }
// world -> sub-local metres (inverse rotation)
function subL(T, x, y, z) { const q = subQ(T.yaw, T.pit); qrotInto(-q[0], -q[1], -q[2], q[3], x - T.x, y - T.y, z - T.z); return V3; }
// markers of the interior (normalised), with fallbacks for a sub without one
function mark(name) {
  const I = SUBM.i >= 0 ? CUSTOM[SUBM.i].markers || {} : {}, hb = CUSTOM[SUBM.m].hb;
  if (I[name]) return I[name];
  if (name === 'pilot_seat') return [0, hb[1] * 0.3, hb[2] * 0.55];
  if (name === 'hatch') return [0, hb[1] + 0.03, 0];
  if (/^passenger_/.test(name)) return [(+name.slice(-1) - 2) * hb[0] * 0.5, hb[1] * 0.2, hb[2] * 0.1];
  return null;
}
function subInit() {
  SUBM.m = CUSTOM.findIndex((c, i) => i < ACTIVE_IDS.length && c.cls === 'm');
  if (SUBM.m < 0) return;
  const base = CUSTOM[SUBM.m].name.toLowerCase();
  SUBM.i = CUSTOM.findIndex((c) => c.cls === 'i' && c.name.toLowerCase().replace(/_?interior$/, '') === base);
  const S = SAVE.sub;
  if (S && isFinite(S.x) && (S.s >>> 0) === WSEED) Object.assign(SUBM, { x: S.x, y: S.y, z: S.z, yaw: S.yaw, hull: S.hull ?? 100, power: S.power ?? 100, boost: S.boost ?? 100, lights: !!S.lights });
  else subPark(28);
}
// park the sub d metres in front of the diver, level, above the seabed
function subPark(d) {
  const x = F[CX] + sin(F[YAW]) * d, z = F[CZ] - cos(F[YAW]) * d, hb = CUSTOM[SUBM.m].hb;
  SUBM.x = x; SUBM.z = z; SUBM.y = clamp(F[CY], hAt(x, z) + hb[1] * SUB_LEN + 2, -hb[1] * SUB_LEN - 1); SUBM.yaw = F[YAW] + PI / 2; SUBM.pit = 0; SUBM.vx = SUBM.vy = SUBM.vz = 0;
}
function subSave() { if (SUBM.m >= 0) save({ sub: { x: +SUBM.x.toFixed(2), y: +SUBM.y.toFixed(2), z: +SUBM.z.toFixed(2), yaw: +SUBM.yaw.toFixed(3), hull: SUBM.hull | 0, power: SUBM.power | 0, boost: SUBM.boost | 0, lights: SUBM.lights ? 1 : 0, s: WSEED } }); }
function subSay(t) { SUBM.msg = t; SUBM.msgT = 4; }
function subDamage(n, why) {
  if (CREATIVE || n <= 0) return;
  SUBM.hull = max(0, SUBM.hull - n); subSay(`Hull −${n.toFixed(0)} % (${why})`);
  if (SUBM.hull <= 0) subSay('Hull breached: power is off. Repair it at the repair panel.');
}
// the transform of the sub you are in: your own, or the one you ride in (a LAN peer's)
function rideT() { if (SUBM.mode !== 'passenger' && !(SUBM.mode === 'inside' && SUBM.ride)) return SUBM; const P = NET.peers.get(SUBM.ride); return P && P.sub ? P.sub : null; }
// ------------------------------------------------------------- the frame step while in a sub (replaces swimming)
function subStep(dt) {
  const T = rideT();
  if (!T) { subLeave(); return; } // the sub you rode in is gone (its pilot left the game)
  const C = CUSTOM[SUBM.m], hb = C.hb, inf = CREATIVE;
  // systems: power recharges (faster near the surface), boost charges back like stamina
  if (!SUBM.ride) {
    const surf = SUBM.y > -30 ? 1 : 0.25, use = (SUBM.lights ? 0.4 : 0) + (SUBM.boosting ? 2 : 0) + hypot(SUBM.vx, SUBM.vy, SUBM.vz) * 0.025;
    if (!inf) SUBM.power = clamp(SUBM.power + (surf - use) * dt, 0, 100); else SUBM.power = 100;
    if (SUBM.power <= 0 && SUBM.lights) { SUBM.lights = false; subSay('Out of power: lights off'); }
    SUBM.bt -= dt; if (!SUBM.boosting && SUBM.bt <= 0) SUBM.boost = min(100, SUBM.boost + 15 * dt);
    // crush depth
    if (SUBM.y < CRUSH && !inf) { SUBM.hull = max(0, SUBM.hull - 2.5 * (1 + (CRUSH - SUBM.y) / 20) * dt); if (((SUBM.t * 2) | 0) % 6 === 0) subSay(`Below crush depth (${CRUSH} m): the hull is failing`); }
  }
  SUBM.t += dt; SUBM.msgT -= dt;
  if (SUBM.mode === 'pilot') subDrive(dt, C, hb);
  else if (!SUBM.ride && SUBM.mode !== 'passenger') subDrift(dt, hb);
  // where you are: the pilot's eye, a passenger seat, or walking the command centre
  if (SUBM.mode === 'pilot' && THIRD) {
    // behind and well above the hull, so you look over it (and see what you fire); pulled in when rock is in the way
    fpWas = false;
    const fw = [sin(SUBM.yaw) * cos(SUBM.pit), sin(SUBM.pit), -cos(SUBM.yaw) * cos(SUBM.pit)], D = SUB_LEN * 0.95, H = SUB_LEN * 0.36;
    let d = D;
    const nd = nDyn; nDyn = 0;
    for (let k = 1; k <= 10; k++) { const t = k / 10; if (sdScene(SUBM.x - fw[0] * D * t, SUBM.y - fw[1] * D * t + H * t, SUBM.z - fw[2] * D * t) < 1.5) { d = D * (k - 1) / 10; break; } }
    nDyn = nd;
    SUBM.camD = SUBM.camD === undefined ? d : SUBM.camD + (d - SUBM.camD) * (d < SUBM.camD ? 1 : 1 - exp(-dt * 2));
    const t = SUBM.camD / D;
    F[CX] = SUBM.x - fw[0] * SUBM.camD; F[CY] = min(SUBM.y - fw[1] * SUBM.camD + H * t, YTOP() + 0.6); F[CZ] = SUBM.z - fw[2] * SUBM.camD;
  } else if (SUBM.mode === 'pilot' || SUBM.mode === 'passenger') {
    const p = subW(T, mark(SUBM.mode === 'pilot' ? 'pilot_seat' : 'passenger_' + (SUBM.seat + 1))); F[CX] = p[0]; F[CY] = p[1]; F[CZ] = p[2];
    if (SUBM.mode === 'pilot' && !SUBM.ride) pilotEye(T);
  } else subWalk(dt, T);
  F[VX] = F[VY] = F[VZ] = 0;
  subPrompt(T);
}
// arcade: turn toward the view, thrust along it, strafe and rise, boost while charge and power last
function subDrive(dt, C, hb) {
  const dead = SUBM.hull <= 0, low = SUBM.power <= 0;
  const k = 1 - exp(-dt * 3);
  let dy = F[YAW] - SUBM.yaw; dy -= Math.round(dy / TAU) * TAU;
  const turn = clamp(dy, -1, 1) * 2.6 * k / max(dt, 1e-3) * dt;
  SUBM.yaw += turn; SUBM.yr = turn / max(dt, 1e-3);
  // first person at the controls you look a little down at your hands and the stick: that view counts as level
  const pv = THIRD ? 0 : FP_TILT;
  SUBM.pit += (clamp((F[PIT] + pv) * 0.8, -0.55, 0.55) - SUBM.pit) * k;
  const wantBoost = (ks || SUBM.boostHeld) && !dead && !low && SUBM.boost > 3;
  SUBM.boosting = wantBoost; if (wantBoost) { SUBM.boost = max(0, SUBM.boost - 25 * dt); SUBM.bt = 1; }
  const sp = dead ? 1 : low ? 3 : wantBoost ? 24 : 12;
  const mf = tId >= 0 ? 0.7 : kf - kb, mr = kr - kl, mu = ku - kd, cp = cos(SUBM.pit), sy = sin(SUBM.yaw), cw = cos(SUBM.yaw);
  const tx = (sy * cp * mf + cw * mr) * sp, ty = (sin(SUBM.pit) * mf + mu * 0.6) * sp, tz = (-cw * cp * mf + sy * mr) * sp;
  SUBM.vx += (tx - SUBM.vx) * k; SUBM.vy += (ty - SUBM.vy) * k; SUBM.vz += (tz - SUBM.vz) * k;
  subMove(dt, hb);
}
// parked / unpiloted: slows to a stop, drifts gently, and still collides
function subDrift(dt, hb) { const k = 1 - exp(-dt * 1.5); SUBM.vx -= SUBM.vx * k; SUBM.vy -= SUBM.vy * k; SUBM.vz -= SUBM.vz * k; SUBM.yr = 0; subMove(dt, hb); }
// move, then push out of rock and structures at bow, middle and stern; hard hits damage the hull
function subMove(dt, hb) {
  SUBM.x += SUBM.vx * dt; SUBM.y += SUBM.vy * dt; SUBM.z += SUBM.vz * dt;
  SUBM.x = clamp(SUBM.x, -WORLD_MAX, WORLD_MAX); SUBM.z = clamp(SUBM.z, -WORLD_MAX, WORLD_MAX);
  SUBM.y = clamp(SUBM.y, -485, -hb[1] * SUB_LEN * 0.05); // it can surface: the upper hull out of the water
  const r = max(hb[0], hb[1]) * SUB_LEN * 0.85, fw = [sin(SUBM.yaw) * cos(SUBM.pit), sin(SUBM.pit), -cos(SUBM.yaw) * cos(SUBM.pit)], half = max(hb[2] * SUB_LEN - r, 0);
  const nd = nDyn; nDyn = 0; // rock and structures only (the moving capsules include this sub's own)
  for (const s of [-1, 0, 1]) {
    const px = SUBM.x + fw[0] * half * s, py = SUBM.y + fw[1] * half * s, pz = SUBM.z + fw[2] * half * s;
    const d = sdScene(px, py, pz) - r;
    if (d < 0) {
      const gx = GR[0], gy = GR[1], gz = GR[2], vn = SUBM.vx * gx + SUBM.vy * gy + SUBM.vz * gz;
      SUBM.x -= gx * d; SUBM.y -= gy * d; SUBM.z -= gz * d;
      if (vn < 0) { if (-vn > 6 && SUBM.mode === 'pilot') subDamage((-vn - 6) * 4, 'crash'); SUBM.vx -= gx * vn; SUBM.vy -= gy * vn; SUBM.vz -= gz * vn; }
    }
  }
  nDyn = nd;
}
// walking the command centre: on the floor, inside its rectangle, relative to the sub
function subWalk(dt, T) {
  const fmin = mark('floor_min'), fmax = mark('floor_max');
  if (!fmin || !fmax) { SUBM.mode = SUBM.ride ? 'passenger' : 'pilot'; return; }
  const sp = 2.2, mf = tId >= 0 ? 0.7 : kf - kb, mr = kr - kl;
  // view yaw relative to the sub's heading
  const ry = F[YAW] - T.yaw, f = [sin(ry), -cos(ry)], rt = [cos(ry), sin(ry)];
  // sub-local axes: model +z is forward (camera-style -z), so local forward = (sin, -cos) maps to model (x, z) = (-sin, cos)
  SUBM.lx += (-(f[0] * mf + rt[0] * mr)) * sp * dt; SUBM.lz += (-(f[1] * mf + rt[1] * mr)) * sp * dt;
  const x0 = min(fmin[0], fmax[0]) * SUB_LEN + 0.3, x1 = max(fmin[0], fmax[0]) * SUB_LEN - 0.3, z0 = min(fmin[2], fmax[2]) * SUB_LEN + 0.3, z1 = max(fmin[2], fmax[2]) * SUB_LEN - 0.3;
  SUBM.lx = clamp(SUBM.lx, x0, x1); SUBM.lz = clamp(SUBM.lz, z0, z1); SUBM.ly = fmin[1] * SUB_LEN + 1.55;
  const p = subW(T, [SUBM.lx / SUB_LEN, SUBM.ly / SUB_LEN, SUBM.lz / SUB_LEN]); F[CX] = p[0]; F[CY] = p[1]; F[CZ] = p[2];
}
// what F / Use does here
const STATIONS = [['pilot_seat', 'Sit and pilot'], ['sonar', 'Sonar ping'], ['lights_panel', 'Lights on / off'], ['power_panel', 'Power status'], ['repair_panel', 'Repair the hull (hold)'], ['hatch_inside', 'Leave by the hatch']];
function subPrompt(T) {
  SUBM.use = null;
  if (SUBM.mode === 'pilot') SUBM.use = ['stand', 'Stand up'];
  else if (SUBM.mode === 'passenger') SUBM.use = ['stand', mark('floor_min') ? 'Stand up' : 'Leave the sub'];
  else if (SUBM.mode === 'inside') {
    let best = null, bd = 1.6;
    for (const [n, label] of STATIONS) {
      if (SUBM.ride && n === 'pilot_seat') continue;
      const p = mark(n); if (!p) continue;
      const d = hypot(p[0] * SUB_LEN - SUBM.lx, p[2] * SUB_LEN - SUBM.lz); if (d < bd) { bd = d; best = [n, label]; }
    }
    SUBM.use = best;
  }
  const b = $('use');
  b.hidden = !SUBM.use; if (SUBM.use) b.textContent = `${SUBM.use[1]}  [F]`;
}
// out in the water: the hatch of your sub or a LAN peer's
function subNearHatch() {
  if (SUBM.m < 0) return null;
  const hp = mark('hatch');
  let p = subW(SUBM, hp); if (hypot(p[0] - F[CX], p[1] - F[CY], p[2] - F[CZ]) < 5) return { own: true };
  for (const [id, P] of NET.peers) if (P.sub) { p = subW(P.sub, hp); if (hypot(p[0] - F[CX], p[1] - F[CY], p[2] - F[CZ]) < 5) return { id, n: P.n }; }
  return null;
}
function subTickOut() {
  const b = $('use');
  if (SUBM.m < 0 || SUBM.mode !== 'out') return;
  const h = subNearHatch();
  b.hidden = !h; if (h) b.textContent = h.own ? 'Board your submarine  [F]' : `Board ${h.n}'s submarine  [F]`;
}
function subEnter(h) {
  if (h.own) {
    const hi = mark('hatch_inside');
    if (hi && mark('floor_min')) { SUBM.mode = 'inside'; SUBM.ride = ''; SUBM.lx = hi[0] * SUB_LEN; SUBM.lz = hi[2] * SUB_LEN; } else SUBM.mode = 'pilot';
    subSay('Aboard. F at the pilot seat to drive.');
  } else {
    // a seat in someone else's sub
    let seat = 0; for (const [, P] of NET.peers) if (P.ride === h.n) seat++;
    SUBM.mode = 'passenger'; SUBM.ride = h.id; SUBM.seat = min(seat, 2); subSay(`Aboard ${h.n}'s submarine`);
  }
}
function subLeave() {
  const T = rideT() || SUBM, p = subW(T, mark('hatch'));
  SUBM.mode = 'out'; SUBM.ride = ''; place(p[0], p[2]); F[CY] = clamp(p[1] + 1, hAt(p[0], p[2]) + 1, -1.2); F[PIT] = -0.3;
}
function subUse(down) {
  if (!down) { SUBM.repairing = false; return; }
  if (SUBM.mode === 'out') { const h = subNearHatch(); if (h) subEnter(h); return; }
  const u = SUBM.use && SUBM.use[0];
  if (u === 'stand') { if (mark('floor_min')) { const p = mark('pilot_seat'); SUBM.mode = 'inside'; SUBM.lx = p[0] * SUB_LEN; SUBM.lz = p[2] * SUB_LEN - 1.2; } else subLeave(); }
  else if (u === 'pilot_seat') SUBM.mode = 'pilot';
  else if (u === 'sonar') subPing();
  else if (u === 'lights_panel') subLights();
  else if (u === 'power_panel') subSay(`Power ${SUBM.power.toFixed(0)} %, hull ${SUBM.hull.toFixed(0)} %, boost ${SUBM.boost.toFixed(0)} %${SUBM.y > -30 ? ' · charging fast near the surface' : ''}`);
  else if (u === 'repair_panel') SUBM.repairing = true;
  else if (u === 'hatch_inside') subLeave();
}
function subLights() {
  if (SUBM.ride) { NET.ws && NET.ws.send(JSON.stringify({ t: 'subcmd', to: NET.peers.get(SUBM.ride)?.n, c: 'lights' })); subSay('Asked the pilot to switch the lights'); return; }
  if (!SUBM.lights && SUBM.power <= 0) { subSay('No power for the lights'); return; }
  SUBM.lights = !SUBM.lights; subSay(SUBM.lights ? 'Lights on' : 'Lights off');
}
// Sonar. On (R, the Sonar button or the sonar table), a sweep turns once every 4 s. Each turn starts with a ping (a
// sound, and the pulse through the 3D view), takes in what is within 300 m, and each contact lights up when the sweep
// passes its bearing, with a faint echo, then fades over about 40 s. It uses power while on (not in creative).
const SON = { on: false, t0: 0, turn: -1, blips: [], topo: null, tx: 1e9, tz: 1e9, tickT: 0 };
const SON_PERIOD = 4, SON_RANGE = 300;
function subPing() {
  if (!SON.on && !SUBM.ride && SUBM.power < 2 && !CREATIVE) { subSay('Not enough power for the sonar'); return; }
  SON.on = !SON.on; SON.t0 = performance.now() / 1000; SON.turn = -1; subSay(SON.on ? 'Sonar on' : 'Sonar off');
}
function sonarContacts(T, now) {
  const out = [], add = (x, y, z, kind) => { const dx = x - T.x, dz = z - T.z, d = hypot(dx, dz); if (d < SON_RANGE && d > 3) out.push({ x, z, kind, d, b: atan2(dx, -dz), t: now }); };
  for (let s = 0; s < LIFEN[6]; s++) { const p = moverAt(s); add(p[0], p[1], p[2], CSK[s] === 1 ? 'L' : 'c'); }
  for (let i = 0; i < nLH; i++) add(LHEAD[i * 3], LHEAD[i * 3 + 1], LHEAD[i * 3 + 2], 'L');
  for (let i = 0; i < NSCH; i++) add(SCH[i * 4], SCH[i * 4 + 1], SCH[i * 4 + 2], 'f');
  for (let i = 0; i < NTUR; i++) add(TUR[i * 4], TUR[i * 4 + 1], TUR[i * 4 + 2], 'c');
  for (const [, P] of NET.peers) if (P.sub) add(P.sub.x, P.sub.y, P.sub.z, 's');
  for (let i = 0; i < nTmp; i++) { const L = LMTMP[i]; if (L.k && L.k < 12) add(L.x, L.y, L.z, 'r'); }
  return out;
}
function sonarStep(T) {
  if (!SON.on) return;
  if (!SUBM.ride && !CREATIVE) { SUBM.power = max(0, SUBM.power - 0.8 * FDT); if (SUBM.power <= 0) { SON.on = false; subSay('Sonar off: no power'); return; } }
  const now = performance.now() / 1000, turn = Math.floor((now - SON.t0) / SON_PERIOD);
  if (turn !== SON.turn) {
    // a new sweep: ping, pulse, fresh contacts (each revealed when the sweep reaches its bearing)
    SON.turn = turn; const start = SON.t0 + turn * SON_PERIOD;
    for (const c of sonarContacts(T, now)) { let rb = c.b - T.yaw; rb -= Math.floor(rb / TAU) * TAU; c.rt = start + rb / TAU * SON_PERIOD; c.done = false; SON.blips.push(c); }
    if (SON.blips.length > 400) SON.blips.splice(0, SON.blips.length - 400);
    sonarSound('ping', 0); SUBM.pulse = F[TIME]; SUBM.pulseO = [T.x, T.y, T.z];
  }
  // echoes for contacts the sweep just reached (at most one tick every 70 ms)
  for (const c of SON.blips) if (!c.done && now >= c.rt) { c.done = true; if (now - SON.tickT > 0.07) { SON.tickT = now; sonarSound('echo', 0, c.kind, c.d); } }
}
// the seabed around the sub: depth colours and 15 m contour lines, north-up, rebuilt when the sub has moved 40 m
function sonarTopo(T) {
  if (SON.topo && hypot(T.x - SON.tx, T.z - SON.tz) < 40) return;
  const N = 72, cv = SON.topo || (SON.topo = Object.assign(document.createElement('canvas'), { width: N, height: N })), g = cv.getContext('2d'), img = g.createImageData(N, N), H = new Float32Array(N * N);
  SON.tx = T.x; SON.tz = T.z;
  const span = SON_RANGE * 2.4, step = span / N;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = hAt(T.x + (i + 0.5 - N / 2) * step, T.z + (j + 0.5 - N / 2) * step);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const h = H[j * N + i], k = clamp(-h / 300, 0, 1), o = (j * N + i) * 4;
    const band = Math.floor(h / 15), line = (i < N - 1 && Math.floor(H[j * N + i + 1] / 15) !== band) || (j < N - 1 && Math.floor(H[(j + 1) * N + i] / 15) !== band);
    img.data[o] = (line ? 60 : 8) + 30 * (1 - k); img.data[o + 1] = (line ? 170 : 40) + 70 * (1 - k); img.data[o + 2] = (line ? 190 : 60) + 80 * (1 - k); img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
// sounds: the ping (a falling sine with a long, echoing tail) and faint echoes, delayed by distance
function sonarSound(kind, delay, what, d) {
  if (typeof AC === 'undefined' || !AC || muted) return;
  const t = AC.currentTime + delay, o = new OscillatorNode(AC, { type: 'sine', frequency: kind === 'ping' ? 1320 : what === 'L' ? 520 : 2100 }), g = new GainNode(AC, { gain: 0 });
  o.connect(g); g.connect(OUT || AC.destination);
  if (kind === 'ping') {
    o.frequency.setValueAtTime(1320, t); o.frequency.exponentialRampToValueAtTime(1180, t + 1.2);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.32, t + 0.012); g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    // its echo off the water around
    const e = new DelayNode(AC, { delayTime: 0.33 }), eg = new GainNode(AC, { gain: 0.28 }); g.connect(e); e.connect(eg); eg.connect(e); eg.connect(OUT || AC.destination);
    o.start(t); o.stop(t + 1.9); setTimeout(() => { try { eg.disconnect(); e.disconnect(); } catch {} }, 4000);
  } else {
    const v = 0.07 * (1 - min(d || 0, SON_RANGE) / SON_RANGE * 0.6);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.005); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.start(t); o.stop(t + 0.14);
  }
}
// ------------------------------------------------------------- per frame, after the move: systems that act over time
function subAfter(dt) {
  if (SUBM.m < 0) return;
  if (SUBM.mode === 'out') { if (!SUBM.ride) subDrift(dt, CUSTOM[SUBM.m].hb); subTickOut(); }
  if (SUBM.repairing && SUBM.mode === 'inside' && !SUBM.ride) {
    if (SUBM.power > 0 || CREATIVE) { SUBM.hull = min(100, SUBM.hull + 8 * dt); if (!CREATIVE) SUBM.power = max(0, SUBM.power - 2 * dt); }
    if (SUBM.hull >= 100) { SUBM.repairing = false; subSay('Hull repaired'); }
  }
  if (SUBM.mode !== 'out') { const T = rideT(); if (T) sonarStep(T); } else if (SON.on) SON.on = false;
  subHud();
}
// lights and the cabin light for the shader (g.fog.z: the sub's lights, g.fog.w: cabin light)
function subUniforms(m) {
  const inside = SUBM.mode !== 'out', T = inside ? rideT() : null;
  const lit = inside && (SUBM.ride ? !!(NET.peers.get(SUBM.ride)?.sub?.lights) : SUBM.lights && SUBM.power > 0);
  // sonar pulse: origin (render space: x / z relative to the camera) and age; -1 when none
  const age = SUBM.pulse !== undefined && inside ? F[TIME] - SUBM.pulse : -1, o = SUBM.pulseO;
  m[72] = o ? o[0] - F[CX] : 0; m[73] = o ? o[1] : 0; m[74] = o ? o[2] - F[CZ] : 0; m[75] = age >= 0 && age < 6 ? age : -1;
  // the hull as a box, for culling plants inside it (sub-local: x across, y up, z along)
  if (SUBM.m >= 0) {
    const hb = CUSTOM[SUBM.m].hb;
    m[76] = SUBM.x - F[CX]; m[77] = SUBM.y; m[78] = SUBM.z - F[CZ]; m[79] = PI - SUBM.yaw;
    m[80] = hb[2] * SUB_LEN; m[81] = hb[0] * SUB_LEN; m[82] = hb[1] * SUB_LEN * 1.1; m[83] = 0;
  } else m[80] = 0;
  m[66] = lit ? 1 : 0; m[67] = inside && SUBM.mode !== 'pilot' || (SUBM.mode === 'pilot' && !THIRD) ? (SUBM.power > 0 || SUBM.ride ? 0.4 : 0.12) : 0;
}
// ------------------------------------------------------------- drawing: your sub (with its inside while aboard) and the others'
// first person at the controls: you sit at the pilot seat (the 'drive' clip), the camera at your eyes, your hands on
// the stick. PB = where the body goes (world), with the stick's grip, from the character's head and hands in the pose.
const FP_TILT = 0.45, RECLINE = -0.6; // the view's tilt at the controls; the pilot seat leans back (radians)
let fpWas = false;
const PB = { ok: false, x: 0, y: 0, z: 0, gx: 0, gy: 0, gz: 0, t: 0 };
function pilotEye(T) {
  PB.ok = false; if (PLAYER < 0) return;
  if (!fpWas) { fpWas = true; F[PIT] = -FP_TILT; } // just sat down: look at the controls
  PB.t = SUBM.t; const clip = pclip(PLAYER, 'drive');
  const head = modelJoint(PLAYER, /^(mixamorig:?)?head$/i, clip, PB.t) || [0, 0.3, 0.05];
  const hl = modelJoint(PLAYER, /^(mixamorig:?)?(left.?hand|hand[._]?l)$/i, clip, PB.t), hr = modelJoint(PLAYER, /^(mixamorig:?)?(right.?hand|hand[._]?r)$/i, clip, PB.t);
  const grip = hl && hr ? [(hl[0] + hr[0]) / 2, (hl[1] + hr[1]) / 2, (hl[2] + hr[2]) / 2] : [0, head[1] - 0.45, head[2] + 0.35];
  // the body: its eyes (a little above and in front of the head joint) where the camera is
  const qs = subQ(T.yaw, T.pit), q = qMul(qs, qAxis(1, 0, 0, RECLINE)), ex = head[0], ey = head[1] + 0.08, ez = head[2] + 0.16;
  qrotInto(q[0], q[1], q[2], q[3], ex, ey, ez);
  PB.x = F[CX] - V3[0]; PB.y = F[CY] - V3[1]; PB.z = F[CZ] - V3[2];
  qrotInto(q[0], q[1], q[2], q[3], grip[0], grip[1], grip[2]);
  const gx = PB.x + V3[0], gy = PB.y + V3[1], gz = PB.z + V3[2];
  qrotInto(qs[0], qs[1], qs[2], qs[3], 0, -0.33, 0); // the stick's base: 0.33 m under the grip, upright in the sub
  PB.gx = gx + V3[0]; PB.gy = gy + V3[1]; PB.gz = gz + V3[2];
  PB.q = [q[0], q[1], q[2], q[3]]; PB.qs = [qs[0], qs[1], qs[2], qs[3]]; PB.ok = true;
}
// the stick, tilting with what you do: forward / back with the throttle, sideways with the turn
const JOYL = { k: 12, x: 0, y: 0, z: 0, q: [0, 0, 0, 1], sc: 1, rad: 1, mesh: 0, mat: 10, seed: 0.1, free: true };
function subJoy(add, cx, cy, cz, R) {
  if (!PB.ok || SUBM.mode !== 'pilot' || THIRD || SUBM.ride) return;
  const fwd = (tId >= 0 ? 0.7 : kf - kb) * 0.35, side = clamp((SUBM.yr || 0) * 0.25, -0.35, 0.35);
  JOYL.mesh = JOY_MESH; JOYL.seed = nameHue(SAVE.nick || '');
  JOYL.x = PB.gx; JOYL.y = PB.gy; JOYL.z = PB.gz; JOYL.q = qMul(PB.qs, qMul(qAxis(1, 0, 0, fwd), qAxis(0, 0, 1, -side)));
  add(JOYL, cx, cy, cz, R);
}
function subEmit() {
  if (SUBM.m < 0) return;
  if (PB.ok && SUBM.mode === 'pilot' && !THIRD && !SUBM.ride && PLAYER >= 0) {
    const S = CUSTOM[PLAYER].skin, pose = S && ciPass === 1 ? poseAlloc(PLAYER, pclip(PLAYER, 'drive'), PB.t) : -2;
    ciPut(PLAYER, PB.x, PB.y, PB.z, 1.8, PB.q[0], PB.q[1], PB.q[2], PB.q[3], 0, nameHue(SAVE.nick || ''), 0, 0, pose, PLAYER === PLAYERS.custom ? null : [1, 1, 1]);
  }
  const C = CUSTOM[SUBM.m], aboard = SUBM.mode !== 'out' && !SUBM.ride;
  MODELS[SUBM.m].noGlass = SUBM.mode !== 'out' && !(SUBM.mode === 'pilot' && THIRD);
  const put = (T, clipT, clip, own) => {
    const q = subQ(T.yaw, T.pit), pose = C.skin && ciPass === 1 ? poseAlloc(SUBM.m, max(clip, 0), clipT) : -2;
    subNoCol = own && SUBM.mode !== 'out';
    ciPut(SUBM.m, T.x, T.y, T.z, SUB_LEN, q[0], q[1], q[2], q[3], 0, 0.5, 0, 0, pose);
    subNoCol = false;
    if (SUBM.i >= 0 && (own ? aboard : SUBM.ride && T === rideT())) ciPut(SUBM.i, T.x, T.y, T.z, SUB_LEN, q[0], q[1], q[2], q[3], 0, 0.5, 0, 0);
  };
  // own sub: clip by speed and turning (cruise, turn, idle)
  if (ciPass === 1) {
    const spd = hypot(SUBM.vx, SUBM.vy, SUBM.vz), want = abs(SUBM.yr) > 0.4 ? 'turn' : spd > 1 ? 'cruise' : 'idle', c = clipOf(SUBM.m, want);
    SUBM.clip = c >= 0 ? c : clipOf(SUBM.m, 'cruise'); SUBM.ct = (SUBM.ct || 0) + FDT * (0.6 + min(spd, 24) / 12);
  }
  put(SUBM, SUBM.ct || 0, SUBM.clip, true);
  for (const [, P] of NET.peers) if (P.sub) put(P.sub, F[TIME], P.sub.clip, false);
}
// ------------------------------------------------------------- HUD and sonar screen
function subHud() {
  const show = SUBM.m >= 0 && SUBM.mode !== 'out' && !menu;
  $('subh').hidden = !show; $('sbt').hidden = !(show && SUBM.mode === 'pilot' && mob);
  if (!show) { if (SUBM.msgT > 0 && SUBM.m >= 0 && !menu) { $('submsg').hidden = false; $('submsg').textContent = SUBM.msg; } else $('submsg').hidden = true; return; }
  const T = rideT() || SUBM, own = !SUBM.ride, depth = -T.y, warn = depth > -CRUSH - 25;
  // the arcs: hull (shield), power (bolt), boost (rocket); depth and speed in the middle
  const bar = (id, v) => { v = clamp(v, 0, 100); $(id).style.strokeDasharray = `${v.toFixed(1)} 100`; $(id + 'v').textContent = v.toFixed(0) + '%'; };
  bar('subhull', own ? SUBM.hull : T.hull ?? 100); bar('subpow', own ? SUBM.power : 100); bar('subbst', own ? SUBM.boost : 100);
  $('subdep').textContent = `${depth.toFixed(0)} m`; $('subspd').textContent = `${hypot(SUBM.vx, SUBM.vy, SUBM.vz).toFixed(1)} m/s`;
  $('subd').textContent = `crush ${-CRUSH} m${SUBM.lights ? ' · lights' : ''}${SON.on ? ' · sonar' : ''}${own ? ` · missiles ${CREATIVE ? '∞' : wpnAmmo}` : ' · passenger'}`;
  $('subd').className = warn ? 'warn' : '';
  $('submsg').hidden = !(SUBM.msgT > 0); $('submsg').textContent = SUBM.msg;
  // sonar screen: the seabed map turned heading-up, range rings, the sweep and the contacts it has lit
  const cv = $('sonar'), g = cv.getContext('2d'), W2 = cv.width / 2, now = performance.now() / 1000;
  sonarTopo(T);
  g.clearRect(0, 0, cv.width, cv.height);
  g.save(); g.beginPath(); g.arc(W2, W2, W2 - 1, 0, TAU); g.clip();
  // the map: centred where it was built, scaled so the range fills the screen, turned so ahead is up
  g.save(); g.translate(W2, W2); g.rotate(-T.yaw); const sc = (W2 - 2) / SON_RANGE, span = SON_RANGE * 2.4;
  g.globalAlpha = SON.on ? 0.95 : 0.5; g.imageSmoothingEnabled = true;
  g.drawImage(SON.topo, (SON.tx - T.x - span / 2) * sc, (SON.tz - T.z - span / 2) * sc, span * sc, span * sc);
  // north marker
  g.globalAlpha = 0.9; g.fillStyle = '#9ff6ff'; g.font = '700 11px system-ui'; g.textAlign = 'center'; g.fillText('N', 0, -(W2 - 12));
  g.restore(); g.globalAlpha = 1;
  g.strokeStyle = '#7ff3ff40'; g.lineWidth = 1;
  for (const r of [1 / 3, 2 / 3]) { g.beginPath(); g.arc(W2, W2, (W2 - 2) * r, 0, TAU); g.stroke(); }
  if (SON.on) {
    const a = ((now - SON.t0) % SON_PERIOD) / SON_PERIOD * TAU - PI / 2;
    // the trailing glow of the sweep, then its line
    for (let k = 0; k < 24; k++) { g.fillStyle = `rgba(127,243,255,${0.16 * (1 - k / 24)})`; g.beginPath(); g.moveTo(W2, W2); g.arc(W2, W2, W2 - 2, a - (k + 1) * 0.04, a - k * 0.04); g.fill(); }
    g.strokeStyle = 'rgba(190,250,255,.9)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(W2, W2); g.lineTo(W2 + cos(a) * (W2 - 2), W2 + sin(a) * (W2 - 2)); g.stroke();
  }
  // contacts: where they were when the sweep lit them, fading slowly
  const cy = cos(T.yaw), sy = sin(T.yaw);
  SON.blips = SON.blips.filter((c) => now - c.rt < 45);
  for (const c of SON.blips) {
    if (now < c.rt) continue;
    const a = exp(-(now - c.rt) / 12), dx = c.x - T.x, dz = c.z - T.z, fx = dx * sy - dz * cy, rx = dx * cy + dz * sy;
    const px = W2 + rx * sc, py = W2 - fx * sc;
    g.fillStyle = c.kind === 'L' ? `rgba(255,90,80,${a})` : c.kind === 's' ? `rgba(120,240,255,${a})` : c.kind === 'f' ? `rgba(130,255,150,${a})` : c.kind === 'r' ? `rgba(220,220,230,${a * 0.8})` : `rgba(255,220,110,${a})`;
    g.beginPath(); g.arc(px, py, c.kind === 'L' ? 4 : c.kind === 'r' ? 3 : 2.5, 0, TAU); g.fill();
  }
  g.restore();
  g.fillStyle = '#e8fbff'; g.beginPath(); g.moveTo(W2, W2 - 5); g.lineTo(W2 - 4, W2 + 4); g.lineTo(W2 + 4, W2 + 4); g.fill();
}
// leviathan bites: a lunging leviathan that reaches your sub damages it once per attack
function subBite(ix, x, y, z) {
  if (SUBM.m < 0 || SUBM.mode === 'out' || SUBM.ride) return;
  if (MV.hit[ix]) return;
  const r = max(CUSTOM[SUBM.m].hb[0], CUSTOM[SUBM.m].hb[1]) * SUB_LEN + 6;
  if (hypot(x - SUBM.x, y - SUBM.y, z - SUBM.z) < r) { MV.hit[ix] = 1; subDamage(22, 'leviathan bite'); }
}
// LAN: your sub in your messages, the others' subs from theirs, lights asked by your passengers
function subNetOut(m) {
  if (SUBM.m < 0) return;
  m.sub = [+SUBM.x.toFixed(2), +SUBM.y.toFixed(2), +SUBM.z.toFixed(2), +SUBM.yaw.toFixed(3), +SUBM.pit.toFixed(3), SUBM.clip, SUBM.lights ? 1 : 0, SUBM.hull | 0];
  m.ride = SUBM.mode === 'passenger' || (SUBM.mode === 'inside' && SUBM.ride) ? NET.peers.get(SUBM.ride)?.n || '' : SUBM.mode !== 'out' ? '@own' : '';
}
function subNetIn(P, m) {
  if (Array.isArray(m.sub)) {
    const s = m.sub;
    if (!P.sub) P.sub = { x: s[0], y: s[1], z: s[2], yaw: s[3], pit: s[4] };
    const k = 0.35; P.sub.x += (s[0] - P.sub.x) * k; P.sub.y += (s[1] - P.sub.y) * k; P.sub.z += (s[2] - P.sub.z) * k;
    let dy = s[3] - P.sub.yaw; dy -= Math.round(dy / TAU) * TAU; P.sub.yaw += dy * k; P.sub.pit += (s[4] - P.sub.pit) * k;
    P.sub.clip = s[5]; P.sub.lights = !!s[6]; P.sub.hull = s[7];
  }
  P.ride = m.ride || '';
}
function subCmd(m) { if (m.to === NET.name && m.c === 'lights') subLights(); }
// touch buttons and keys
function subInit2() {
  // press acts (and holds a repair), release lets go
  $('use').addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); subUse(true); });
  $('use').addEventListener('pointerup', () => subUse(false));
  $('sbl').onclick = () => subLights(); $('sbs').onclick = () => subPing(); $('sbf').onclick = () => subFire();
  $('sbb').addEventListener('pointerdown', (e) => { e.stopPropagation(); SUBM.boostHeld = true; });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('sbb').addEventListener(ev, () => { SUBM.boostHeld = false; });
  for (const id of ['use', 'sbl', 'sbs', 'sbb', 'sbf']) $(id).tabIndex = -1;
}
