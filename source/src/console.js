// ============================================================================
// console (creative mode): commands to spawn creatures and test their behaviours
// ============================================================================
// T or / opens it on a keyboard, the ⌨ button on touch screens; Esc or the button closes it. Commands start with an
// optional slash; /help lists them. Everything works on the slots the world already simulates: spawning puts a
// creature slot (or a built-in animal slot) in front of you, and the behaviour / clip commands act on the nearest one.
let conOpen = false, conBase = -1;
const conHist = [];
function conLog(t) { const el = $('conlog'); el.textContent = (el.textContent + '\n' + t).split('\n').slice(-14).join('\n').trim(); }
function conShow(on) {
  conOpen = on && CREATIVE; $('con').hidden = !conOpen;
  if (conOpen) { if (document.pointerLockElement) document.exitPointerLock(); $('coni').value = ''; $('coni').focus(); if (!$('conlog').textContent) conLog('Creative console: /help for the commands'); }
  else $('coni').blur();
}
// a spot d metres ahead of the diver (on the seabed side of the surface)
function ahead(d) {
  const cp = cos(F[PIT]), x = F[CX] + sin(F[YAW]) * cp * d, z = F[CZ] - cos(F[YAW]) * cp * d;
  return [x, clamp(F[CY] + sin(F[PIT]) * d, hAt(x, z) + 3, -3), z];
}
// where a mover instance is now (the same path as its instances in ciEmit)
function moverAt(s, j = 0) {
  cslot(s);
  const a = F[TIME] * CSP[1] + CSP[2] + j * 2.1;
  return CSK[s] >= 2 ? [CUS[s * 4], CUS[s * 4 + 1], CUS[s * 4 + 2]] : [CUS[s * 4] + CSP[0] * cos(a), CUS[s * 4 + 1] + 1.4 * sin(a * 1.3 + j), CUS[s * 4 + 2] + CSP[0] * 0.85 * sin(a)];
}
function nearestMover(cls) {
  let best = -1, bd = 1e18;
  for (let s = 0; s < LIFEN[6]; s++) { if (cls >= 0 && CSK[s] !== cls) continue; const p = moverAt(s), d = hypot(p[0] - F[CX], p[1] - F[CY], p[2] - F[CZ]); if (d < bd) { bd = d; best = s; } }
  return best;
}
const KIND = { c: 0, l: 1, m: 2, b: 3 };
const ANIMALS = { school: [SCH, NSCH], fish: [SCH, NSCH], manta: [MAN, NMAN], jelly: [JEL, NJEL], jellyfish: [JEL, NJEL], turtle: [TUR, NTUR], squid: [SQ, NSQ] };
function cmdSpawn(what, n) {
  n = clamp(n | 0 || 1, 1, 12);
  if (!what) return 'spawn what? an imported model (name or its start) or: leviathan, school, manta, turtle, jelly, squid';
  if (what === 'leviathan' && NLEV) { // the nearest built-in leviathan circles here
    const p = ahead(60); LEV[0] = p[0]; LEV[1] = p[1]; LEV[2] = p[2]; LEV[3] = 3; return 'a leviathan circles 60 m ahead';
  }
  if (ANIMALS[what]) { const [A, N] = ANIMALS[what]; let k = 0; for (let i = 0; i < min(n, N); i++, k++) { const p = ahead(14 + i * 6); A[i * 4] = p[0]; A[i * 4 + 1] = p[1]; A[i * 4 + 2] = p[2]; A[i * 4 + 3] = 3; } return `${k} ${what} moved in front of you`; }
  const mi = CUSTOM.findIndex((c, i) => i < ACTIVE_IDS.length && c.name.toLowerCase().startsWith(what));
  if (mi < 0) return `no model or animal called “${what}” (/list shows the models)`;
  const C = CUSTOM[mi];
  if (!(C.cls in KIND)) return `${C.name} is a ${MODEL_CLASSES[C.cls]}: only creatures, leviathans, submarines and boats can be spawned`;
  if (conBase < 0) conBase = LIFEN[6];
  let k = 0;
  for (; k < n && LIFEN[6] < NCUS; k++) {
    const s = LIFEN[6]++, g = NSLOT - NCUS + s, p = ahead(C.cls === 'l' ? 55 : 12 + k * 4);
    CSM[s] = mi; CSK[s] = KIND[C.cls];
    CUS[s * 4] = p[0]; CUS[s * 4 + 1] = C.cls === 'b' ? 0 : p[1]; CUS[s * 4 + 2] = p[2]; CUS[s * 4 + 3] = 3;
    BLIFT[g] = NaN; BVEL[g * 2] = BVEL[g * 2 + 1] = 0; BST[g] = 0; BTMR[g] = 0;
    MV.clip[s * 2] = MV.clip[s * 2 + 1] = -1; MV.once[s * 2] = MV.once[s * 2 + 1] = 0; MV.lw[s * 2] = MV.lw[s * 2 + 1] = 0;
  }
  return k ? `spawned ${k} × ${C.name} (${MODEL_CLASSES[C.cls]})${k < n ? ` (all ${NCUS} slots in use)` : ''}` : `all ${NCUS} creature slots are in use: /kill first`;
}
// force a clip (one-shot) on the nearest animated mover; attack also lunges at the diver
function cmdClip(name, cls, lunge) {
  const s = nearestMover(cls);
  if (s < 0) return cls === 1 ? 'no imported leviathan nearby (/spawn one)' : 'no imported creature nearby';
  const m = CSM[s], c = clipOf(m, name), ix = s * 2;
  if (c < 0) { const S = CUSTOM[m].skin; return `${CUSTOM[m].name} has no “${name}” clip${S ? ` (it has: ${S.anims.map((a) => a.name).join(', ')})` : ' (it is not animated)'}`; }
  MV.clip[ix] = c; MV.t[ix] = 0; MV.once[ix] = 1;
  // a leviathan farther than 40 m first swims in: its swim circle moves so it is about 30 m in front of you
  if (cls === 1) {
    const q = moverAt(s), t = ahead(30), d = hypot(q[0] - F[CX], q[1] - F[CY], q[2] - F[CZ]);
    if (d > 40) { CUS[s * 4] += t[0] - q[0]; CUS[s * 4 + 1] += t[1] - q[1]; CUS[s * 4 + 2] += t[2] - q[2]; }
  }
  if (lunge) {
    const p = moverAt(s), ex = F[CX] - p[0], ey = F[CY] - p[1], ez = F[CZ] - p[2], l = hypot(ex, ey, ez) || 1, reach = max(0, min(l - 4, 18)), o = ix * 3;
    MV.lv[o] = ex / l * reach; MV.lv[o + 1] = ey / l * reach; MV.lv[o + 2] = ez / l * reach; MV.cd[ix] = 12;
    return `${CUSTOM[m].name} lunges at you (${l.toFixed(0)} m away, reach ${reach.toFixed(0)} m)`;
  }
  return `${CUSTOM[m].name} plays ${name}`;
}
function conRun(line) {
  const w = line.trim().replace(/^\//, '').split(/\s+/), c = (w[0] || '').toLowerCase(), a = w.slice(1).map((x) => x.toLowerCase());
  switch (c) {
    case '': return '';
    case 'help': return ['/spawn <model | leviathan | school | manta | turtle | jelly | squid> [count]: in front of you',
      '/kill: remove what /spawn added', '/attack: the nearest imported leviathan lunges at you', '/roar, /hunt: its roar, or start hunting',
      '/anim <clip>: the nearest animated model plays that clip', '/tp <x> <z> [y] | /tp leviathan | landmark | structure | cave | surface | biome',
      '/sub: park your submarine in front of you; /hull <0-100>, /power <0-100>',
      '/mode survival | creative', '/time cycle | dawn | noon | dusk | night', '/weather auto | clear | cloudy | overcast | rain | storm', '/list: loaded models and their clips', '/import <url> [class | auto]: add a model from a URL',
      '/clear: empty this log'].join('\n');
    case 'spawn': case 'summon': return cmdSpawn(a[0], +a[1]);
    case 'kill': { if (conBase < 0) return 'nothing spawned'; const k = LIFEN[6] - conBase; LIFEN[6] = conBase; conBase = -1; return `removed ${k}`; }
    case 'attack': return cmdClip('attack', 1, true);
    case 'roar': return cmdClip('roar', 1, false);
    case 'hunt': { const s = nearestMover(1); if (s < 0) return 'no imported leviathan nearby'; const g = NSLOT - NCUS + s; BST[g] = 0; BTMR[g] = 0; return `${CUSTOM[CSM[s]].name} looks for prey`; }
    case 'anim': return a[0] ? cmdClip(a[0], -1, false) : 'which clip? /list shows them';
    case 'tp': {
      if (a[0] === 'leviathan') { toLeviathan(); return 'jumped to ' + jumpName; }
      if (a[0] === 'cave') { toCave(); return 'jumped to ' + jumpName; }
      if (a[0] === 'surface') { F[CY] = YTOP(); F[PIT] = 0.15; return 'at the surface'; }
      if (a[0] === 'landmark') { jump(7); return 'jumped to ' + jumpName; }
      if (a[0] === 'structure') { jump(8); return 'jumped to ' + jumpName; }
      if (a[0] === 'biome') { jump((+a[1] || 1) - 1); return 'jumped to ' + jumpName; }
      const x = +a[0], z = +a[1];
      if (!isFinite(x) || !isFinite(z)) return 'tp <x> <z> [y], or tp leviathan | landmark | structure | cave | surface | biome <1-7>';
      place(x, z); if (isFinite(+a[2]) && a[2] !== undefined) F[CY] = clamp(+a[2], hAt(x, z) + 1, YTOP());
      return `at ${x.toFixed(0)}, ${F[CY].toFixed(0)}, ${z.toFixed(0)}`;
    }
    case 'time': if (['auto', 'cycle', 'dawn', 'noon', 'dusk', 'night'].includes(a[0])) { setTod(a[0] === 'cycle' ? 'auto' : a[0]); return 'time: ' + a[0]; } return 'time cycle | dawn | noon | dusk | night';
    case 'weather': if (a[0] === 'auto' || WEATHERS.includes(a[0])) { setWx(a[0]); return 'weather: ' + a[0]; } return 'weather auto | ' + WEATHERS.join(' | ');
    case 'mode': if (a[0] === 'survival' || a[0] === 'creative') { setMode(a[0]); if (a[0] === 'survival') conShow(false); return 'mode ' + a[0]; } return 'mode survival | creative';
    case 'list': return CUSTOM.slice(0, ACTIVE_IDS.length).map((m) => `${m.name} (${MODEL_CLASSES[m.cls]})${m.skin ? ': ' + m.skin.anims.map((x) => x.name).join(', ') : ''}`).join('\n') || 'no models loaded';
    case 'clear': $('conlog').textContent = ''; return '';
    case 'sub': if (SUBM.m < 0) return 'no submarine: import a submarine model (and its _interior)'; if (SUBM.mode !== 'out') return 'leave it first'; subPark(25); return 'your submarine is parked 25 m ahead';
    case 'hull': if (SUBM.m < 0) return 'no submarine'; SUBM.hull = clamp(+a[0] || 0, 0, 100); return `hull ${SUBM.hull} %`;
    case 'power': if (SUBM.m < 0) return 'no submarine'; SUBM.power = clamp(+a[0] || 0, 0, 100); return `power ${SUBM.power} %`;
    case 'import': {
      const url = w[1]; if (!url) return 'import <url> [structure | plant | creature | leviathan | submarine | boat | auto]';
      const want = { structure: 's', plant: 'p', creature: 'c', leviathan: 'l', submarine: 'm', boat: 'b' }[a[1]] || 'auto';
      (async () => {
        try {
          conLog(`downloading ${url}…`);
          const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
          const name = decodeURIComponent(url.split('/').pop() || 'model');
          const rec = await fileToRec(new File([await r.arrayBuffer()], name)), m = await parseModelRecord(rec, 64, false);
          const it = { rec, anims: m.skin ? m.skin.anims.map((x) => x.name) : [] }, cls = want === 'auto' ? guessClass(it) : want;
          await idbDo('readwrite', (st) => st.put({ ...rec, cls }));
          conLog(`added ${rec.name} as ${MODEL_CLASSES[cls]}; reloading`); setTimeout(() => location.reload(), 600);
        } catch (e) { conLog('import failed: ' + e.message); }
      })();
      return '';
    }
    default: return `unknown command “${c}” (/help)`;
  }
}
function conInit() {
  const inp = $('coni');
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { const l = inp.value; inp.value = ''; if (l.trim()) { conHist.push(l); conLog('> ' + l); const r = conRun(l); if (r) conLog(r); } }
    else if (e.key === 'Escape') conShow(false);
    else if (e.key === 'ArrowUp' && conHist.length) inp.value = conHist[conHist.length - 1];
  });
  $('cb').onclick = (e) => { e.currentTarget.blur(); conShow(!conOpen); };
  $('cb').tabIndex = -1;
  $('cb').addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
}
