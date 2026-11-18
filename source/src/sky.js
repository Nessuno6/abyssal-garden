// ============================================================================
// sky: the day / night cycle and the weather
// ============================================================================
// Both follow the world clock (F[TIME], locked to the host's in LAN games), so everyone in a game sees the same sky.
// Day: one cycle every DAYLEN seconds (menu: World -> Time of day, or a fixed dawn / noon / dusk / night). The true sun
// lights the sky over the sea; under water the light comes from the refracted sun (Snell: never lower than ~41 deg), so
// the shadow map and every 1 / sun.y in the shaders stay well behaved; it moves the shadow map every couple of degrees.
// Weather: clear, cloudy, overcast, rain, storm, a new state every 4 minutes (weighted, hashed from the clock) blended
// over 60 s, or fixed from the menu. Clouds dim the sun and soften the caustics, rough weather raises the waves and the
// murk, rain falls above the surface, storms flash with lightning (and thunder, muffled under water).
// G: sunc (sun colour x intensity), env (ambient scale, cloud cover, waves, rain), sky (true sun, lightning);
// cav.z = night (the diver's lamp switches on).
const DAYLEN = 1440, WEATHERS = ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'thunderstorm'];
// rain: sunny showers (broken cloud, a rainbow when the sun is out); storm: wind, heavy rain, big waves, now and then
// lightning; thunderstorm: dark, lightning every few seconds with bolts you can see
const WX = { cloud: [0.12, 0.45, 0.85, 0.62, 0.95, 1], sun: [1, 0.8, 0.45, 0.62, 0.22, 0.12], amb: [1, 0.92, 0.72, 0.85, 0.5, 0.38], wave: [0.25, 0.4, 0.55, 0.45, 0.95, 1], rain: [0, 0, 0, 0.55, 1, 1], murk: [1, 1.04, 1.12, 1.08, 1.3, 1.4], storm: [0, 0, 0, 0, 0.25, 1] };
const WXW = [0.32, 0.27, 0.12, 0.13, 0.08, 0.08];
const TODS = { dawn: 0.265, noon: 0.5, dusk: 0.735, night: 0.0 };
let TODM = SAVE.tod || 'auto', WXM = SAVE.wx || 'auto';
const SKY = { tod: 0.42, day: 1, night: 0, S: [0, 1, 0], L: [0.27, 0.93, -0.24], cloud: 0, sun: 1, amb: 1, wave: 0.3, rain: 0, murk: 1, storm: 0, flash: 0, wx: 0, lastFl: -1, thunderAt: 0, bolt: 0, boltS: 0 };
let sunMoved = false;
const wxPick = (k) => { let r = hash2(k, 77, 901), i = 0; while (i < 5 && r >= WXW[i]) { r -= WXW[i]; i++; } return i; };
function skyTick() {
  const T = F[TIME];
  // time of day (0 midnight, .25 sunrise, .5 noon, .75 sunset)
  SKY.tod = TODM === 'auto' ? fract(T / DAYLEN + 0.42) : TODS[TODM];
  const th = TAU * (SKY.tod - 0.25);
  let sx = cos(th), sy = 0.92 * sin(th), sz = 0.38; const sl = hypot(sx, sy, sz); sx /= sl; sy /= sl; sz /= sl;
  SKY.S[0] = sx; SKY.S[1] = sy; SKY.S[2] = sz;
  SKY.day = sstep(-0.08, 0.22, sy); SKY.night = 1 - sstep(-0.18, 0.05, sy);
  // weather: this 4-minute slot's state, blending into the next over the last minute
  let a, b, f;
  if (WXM === 'auto') { const k = floor(T / 240); a = wxPick(k); b = wxPick(k + 1); f = sstep(180, 240, T - k * 240); }
  else { a = b = max(0, WEATHERS.indexOf(WXM)); f = 0; }
  SKY.wx = f < 0.5 ? a : b;
  for (const key of ['cloud', 'sun', 'amb', 'wave', 'rain', 'murk', 'storm']) SKY[key] = WX[key][a] + (WX[key][b] - WX[key][a]) * f;
  // lightning: in a storm, a flash now and then (hashed per half second); thunder follows 1-4 s later
  const fk = floor(T * 2), fl = SKY.storm > 0.15 && hash2(fk, 3, 905) < 0.12 * SKY.storm;
  if (fl && fk !== SKY.lastFl) { SKY.lastFl = fk; SKY.bolt = hash2(fk, 5, 907) * TAU; SKY.boltS = hash2(fk, 6, 908); SKY.thunderAt = T + 0.6 + 3 * hash2(fk, 4, 906); }
  const ft = T - SKY.lastFl / 2; // a strike: about 0.7 s, flickering two or three times
  SKY.flash = SKY.lastFl >= 0 && ft >= 0 ? exp(-ft * 3.5) * (0.35 + 0.65 * sin(ft * 38) ** 2) * min(1, SKY.storm * 1.5) : 0;
  if (SKY.thunderAt && T >= SKY.thunderAt) { SKY.thunderAt = 0; thunder(); }
  // the light under water: the refracted sun (a low sun still shines in at ~41 deg); night uses the same direction
  const e = max(sy, 0.05), ce = sqrt(1 - e * e) / 1.33, hl = hypot(sx, sz) || 1;
  const lx = sx / hl * ce, lz = sz / hl * ce, ly = sqrt(1 - ce * ce);
  if (abs(lx - SKY.L[0]) + abs(ly - SKY.L[1]) + abs(lz - SKY.L[2]) > 0.03) { SKY.L[0] = lx; SKY.L[1] = ly; SKY.L[2] = lz; setSun(SKY.L); sunMoved = true; }
}
// G indices: cav.z 86, env 184, sky 188, sunc 192
function skyUniforms(m) {
  const warm = sstep(0.45, 0.04, SKY.S[1]) * sstep(-0.12, 0.04, SKY.S[1]), k = SKY.day * SKY.sun;
  m[192] = 1.7 * k * (1 + 0.25 * warm); m[193] = 1.6 * k * (1 - 0.25 * warm); m[194] = 1.45 * k * (1 - 0.55 * warm); m[195] = 0;
  m[184] = (0.12 + 0.88 * SKY.day) * SKY.amb + SKY.flash * 0.35; m[185] = SKY.cloud; m[186] = SKY.wave; m[187] = SKY.rain;
  m[188] = SKY.S[0]; m[189] = SKY.S[1]; m[190] = SKY.S[2]; m[191] = SKY.flash;
  m[195] = SKY.flash > 0.02 ? (((SKY.bolt % TAU) + TAU) % TAU) + SKY.boltS * 0.001 : -1; // the bolt's bearing (and its shape seed in the fraction)
  rainSound();
  m[86] = SKY.night;
  m[71] *= SKY.murk;
  // the eye adapts to the dark
  m[56] *= 1 + (F[CY] > 0 ? 0.3 : 1.4) * (1 - (0.1 + 0.9 * SKY.day) * (0.5 + 0.5 * SKY.amb)); // less above the surface: the sky has its own light
}
// thunder: a low noise burst, muffled and quieter under water
function thunder() {
  if (!AC || muted) return;
  const t = AC.currentTime, n = AC.sampleRate * 4 | 0, buf = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: AC.sampleRate }), d = buf.getChannelData(0);
  for (let i = 0, b = 0; i < n; i++) { b = (b + 0.05 * (Math.random() * 2 - 1)) / 1.05; d[i] = b * 6 * exp(-i / n * 3) * (0.6 + 0.4 * sin(i / n * 40)); }
  const src = new AudioBufferSourceNode(AC, { buffer: buf }), lp = new BiquadFilterNode(AC, { type: 'lowpass', frequency: F[CY] > 0 ? 900 : 260 }), g = new GainNode(AC, { gain: F[CY] > 0 ? 0.9 : 0.35 });
  src.connect(lp); lp.connect(g); g.connect(OUT); src.start(t);
}
// the sound of rain: a hiss above the surface, a soft patter under it (with depth it fades out)
let rainG = null;
function rainSound() {
  if (!AC) return;
  if (!rainG) {
    const n = AC.sampleRate * 3 | 0, buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: AC.sampleRate });
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.02 ? 2.5 : 0.6); }
    const src = new AudioBufferSourceNode(AC, { buffer: buf, loop: true }); rainG = { f: new BiquadFilterNode(AC, { type: 'bandpass', frequency: 3000, Q: 0.6 }), g: new GainNode(AC, { gain: 0 }) };
    src.connect(rainG.f); rainG.f.connect(rainG.g); rainG.g.connect(OUT); src.start();
  }
  const up = F[CY] > 0, k = SKY.rain * (up ? 0.32 : 0.12 * clamp(1 + F[CY] / 25, 0, 1));
  rainG.g.gain.setTargetAtTime(muted ? 0 : k, AC.currentTime, 0.4); rainG.f.frequency.setTargetAtTime(up ? 3200 : 900, AC.currentTime, 0.3);
}
function skyName() { return `${['night', 'dawn', 'morning', 'noon', 'afternoon', 'dusk', 'evening', 'night'][floor(fract(SKY.tod + 0.0625) * 8)]}, ${WEATHERS[SKY.wx]}`; }
