// ============================================================================
// online: LAN multiplayer and update checks
// ============================================================================
// LAN multiplayer. The apps (Windows, Android) carry a small WebSocket relay (src-tauri/src/lan.rs): the host starts
// it, every peer (the host's own page included, over 127.0.0.1) connects, and each text message is forwarded to all
// other peers as "<sender id>|<json>". Games are found through a UDP beacon, or joined by address.
//
// The host is the authority for the shared world. Ten times a second it sends
//   { t: 'w', n: name, s: seed, tm: world clock, p: [x, y, z, yaw, pitch], lev: [per leviathan: 4 slot + 8 path] }
// and each client sends { t: 'p', n: name, p: [...] }. A client takes the host's seed (reloading into the host's
// world, next to the host, then rejoining by itself), locks its clock to the host's (water, kelp sway, creature
// animation and leviathan paths are functions of the clock) and takes the host's leviathans. Terrain, structures and
// plants follow from the seed on every device. Every client renders the scene itself.
const APP = !!(self.__TAURI_INTERNALS__ && self.__TAURI_INTERNALS__.invoke);
const invokeApp = (cmd, args) => self.__TAURI_INTERNALS__.invoke(cmd, args);
const NET_PORT = 47820;
const NET = { mode: 0, ws: null, addr: '', name: '', peers: new Map(), sendT: 0, err: '', ips: [] }; // mode 0 off, 1 host, 2 client
let netLevSync = false;

const nameHue = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 8) / 16777216; };
function netStatus(t) { NET.err = ''; const el = $('nst'); if (el) el.textContent = t; }
function netDescribe() {
  if (!NET.mode) return netStatus(NET.err || (APP ? 'Host a game or find one on this network.' : 'The web version can join a game by address; hosting needs the Windows or Android app.'));
  const n = NET.peers.size + 1;
  netStatus(NET.mode === 1 ? `Hosting “${NET.name}” at ${NET.ips.join(', ') || 'this device'} · ${n} diver${n > 1 ? 's' : ''}${mob ? ' · keep the game on screen: Android cuts the network of apps in the background' : ''}` : `In ${NET.addr}'s world · ${n} diver${n > 1 ? 's' : ''}`);
}
function netOpen(addr, host) {
  netClose(false);
  let ws;
  try { ws = new WebSocket(`ws://${addr}:${NET_PORT}`); } catch (e) { NET.err = 'Could not connect: ' + e.message; return netDescribe(); }
  NET.ws = ws; NET.addr = addr; NET.mode = host ? 1 : 2; NET.loading = false; NET.rx = new Map(); NET.met = false;
  netStatus(host ? 'Starting…' : `Connecting to ${addr}…`);
  // no answer within 6 s: usually the host is not on screen (Android cuts the network of apps in the background)
  const to = setTimeout(() => { if (NET.ws === ws && ws.readyState !== 1) { NET.err = `No answer from ${addr}. Check the address, that both devices are on the same network, and that the game is open on the host's screen.`; netClose(false); netDescribe(); } }, 6000);
  ws.onopen = () => { clearTimeout(to); netDescribe(); netSend(true); };
  ws.onmessage = (e) => netMessage(String(e.data));
  ws.onclose = () => { clearTimeout(to); if (NET.ws !== ws) return; NET.ws = null; NET.mode = 0; NET.peers.clear(); netTagsClear(); NET.err = host ? 'The game stopped.' : `Lost the connection to ${addr}.`; netDescribe(); netButtons(); };
  netButtons();
}
function netClose(stopHost = true) {
  const ws = NET.ws; NET.ws = null;
  if (ws) try { ws.close(); } catch {}
  if (stopHost && NET.mode === 1 && APP) invokeApp('lan_stop').catch(() => 0);
  NET.mode = 0; NET.peers.clear(); netTagsClear(); netButtons();
}
async function netHost() {
  NET.name = netName();
  netStatus('Starting…');
  try { NET.ips = await invokeApp('lan_host', { name: NET.name }); } catch (e) { NET.err = 'Could not host: ' + e; return netDescribe(); }
  netOpen('127.0.0.1', true);
}
async function netScan(auto) {
  if (NET.scanning) return; NET.scanning = true;
  const box = $('ng'); if (!auto) { box.textContent = ''; netStatus('Looking for games on this network…'); }
  let list = [];
  try { list = await invokeApp('lan_scan', { ms: 2500 }); } catch (e) { NET.scanning = false; if (!auto) { NET.err = 'Could not search: ' + e; netDescribe(); } return; }
  NET.scanning = false;
  if (NET.mode) return;
  box.textContent = '';
  if (!list.length) { netStatus(auto ? 'Looking for games on this network… none yet. You can also join by address.' : 'No games found. Check that both devices are on the same Wi-Fi, or join by address.'); return; }
  netStatus(`${list.length} game${list.length > 1 ? 's' : ''} on this network`);
  for (const g of list) {
    const b = document.createElement('button'); b.textContent = `Join “${g.n}” (${g.ip})`;
    b.onclick = () => { box.textContent = ''; NET.name = netName(); netOpen(g.ip, false); };
    box.appendChild(b);
  }
}
function netName() { const v = ($('nn').value || '').trim().slice(0, 16) || SAVE.nick; save({ nick: v }); return v; }
function netButtons() {
  if (!$('nh')) return;
  $('mp').hidden = !APP; $('nh').hidden = !APP || NET.mode !== 0; $('ns').hidden = !APP || NET.mode !== 0; $('nl').hidden = NET.mode === 0;
  $('nj').hidden = NET.mode !== 0;
}
function netSend(force) {
  const ws = NET.ws;
  if (!ws || ws.readyState !== 1) return;
  const m = { t: NET.mode === 1 ? 'w' : 'p', n: NET.name, p: [+F[CX].toFixed(2), +F[CY].toFixed(2), +F[CZ].toFixed(2), +F[YAW].toFixed(3), +F[PIT].toFixed(3)] };
  if (NET.mode === 1) {
    m.s = WSEED; m.tm = +F[TIME].toFixed(3); m.lev = []; m.mm = NET.manifest || (NET.manifest = netManifest());
    for (let i = 0; i < NLEV; i++) { for (let k = 0; k < 4; k++) m.lev.push(+LEV[i * 4 + k].toFixed(2)); for (let k = 0; k < 8; k++) m.lev.push(LB.lev[i * 8 + k]); }
  }
  ws.send(JSON.stringify(m));
}
function netMessage(s) {
  const bar = s.indexOf('|'); if (bar < 0) return;
  const id = s.slice(0, bar), body = s.slice(bar + 1);
  if (body === 'bye') { const P = NET.peers.get(id); if (P && P.tag) P.tag.remove(); NET.peers.delete(id); netDescribe(); return; }
  let m; try { m = JSON.parse(body); } catch { return; }
  if (m && (m.t === 'mreq' || m.t === 'mc')) return netOther(m);
  if (!m || !Array.isArray(m.p) || m.p.length < 5) return;
  let P = NET.peers.get(id);
  if (!P) {
    P = { x: m.p[0], y: m.p[1], z: m.p[2], yaw: m.p[3], pit: m.p[4], t: 0, tag: null, L: { k: 99, mesh: DIVER_MESH, mat: 10, sc: 1, seed: 0, rad: 2, x: 0, y: 0, z: 0, q: [0, 0, 0, 1] } };
    NET.peers.set(id, P); netDescribe();
  }
  P.tp = m.p; P.t = performance.now(); P.n = String(m.n || 'Diver').slice(0, 16); P.L.seed = nameHue(P.n); P.host = m.t === 'w';
  if (P.host && NET.mode === 2) netFromHost(m);
}
function netOther(m) {
  if (m.t === 'mreq' && NET.mode === 1 && Array.isArray(m.h)) netServeModels(m.h);
  else if (m.t === 'mc' && NET.mode === 2) netChunk(m);
}
// the host's world: same seed and models (else fetch the missing models, then reload into it next to the host),
// its clock and its leviathans
function netFromHost(m) {
  const hm = Array.isArray(m.mm) ? m.mm : [];
  const ids = hm.map((x) => x.h);
  if ((m.s >>> 0) !== WSEED || ids.join('\n') !== ACTIVE_IDS.join('\n')) {
    if (NET.loading) return;
    NET.loading = true;
    netModelsThen(hm, () => {
      save({ seed: m.s >>> 0, at: [m.p[0] + 4, m.p[2] + 4], join: NET.addr, netModels: ids, pix: 0, det: 0 });
      netStatus('Loading the host’s world…'); location.reload();
    });
    return;
  }
  // first word from the host: a diver far away (same seed, elsewhere in the world) starts next to the host
  if (!NET.met) {
    NET.met = true;
    if (Math.hypot(m.p[0] - F[CX], m.p[2] - F[CZ]) > 150) {
      place(m.p[0] + 6, m.p[2] + 6, m.p[0], m.p[2]); F[CY] = clamp(max(m.p[1], hAt(F[CX], F[CZ]) + 3), -490, -2); F[PIT] = 0;
      jumpName = (m.n || 'the host') + ' (host)';
    }
  }
  const d = m.tm - F[TIME];
  F[TIME] += Math.abs(d) > 2 ? d : d * 0.25;
  if (Array.isArray(m.lev)) NET.lev = m.lev;
}
// after updateLife: the host's leviathans replace this device's (slot centres every frame, path parameters on change)
function netAfterLife() {
  const L = NET.lev; if (NET.mode !== 2 || !L) return;
  const n = min(NLEV, (L.length / 12) | 0);
  let changed = false;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) LEV[i * 4 + k] += (L[i * 12 + k] - LEV[i * 4 + k]) * (k < 3 ? 0.2 : 1);
    for (let k = 0; k < 8; k++) if (LB.lev[i * 8 + k] !== Math.fround(L[i * 12 + 4 + k])) { LB.lev[i * 8 + k] = L[i * 12 + 4 + k]; changed = true; }
  }
  if (changed) Q.writeBuffer(ibLev, 0, LB.lev);
  netLevSync = n > 0;
}
// every frame: smooth the other divers towards their last pose, drop the silent ones, send our pose 10 times a second
function netTick(now, dt) {
  if (!NET.mode) return;
  const k = 1 - Math.exp(-dt * 10);
  for (const [id, P] of NET.peers) {
    if (now - P.t > 6000) { if (P.tag) P.tag.remove(); NET.peers.delete(id); netDescribe(); continue; }
    if (!P.tp) continue;
    const ox = P.x, oy = P.y, oz = P.z;
    P.x += (P.tp[0] - P.x) * k; P.y += (P.tp[1] - P.y) * k; P.z += (P.tp[2] - P.z) * k;
    if (dt > 0) { P.spd = (P.spd || 0) + (hypot(P.x - ox, P.y - oy, P.z - oz) / dt - (P.spd || 0)) * min(1, dt * 4); P.at = (P.at || 0) + dt * (P.spd < 0.8 ? 1 : 0.7 + P.spd / 14); }
    let dy = P.tp[3] - P.yaw; dy -= Math.round(dy / TAU) * TAU; P.yaw += dy * k; P.pit += (P.tp[4] - P.pit) * k;
  }
  if (now - NET.sendT > 100) { NET.sendT = now; netSend(); }
  // the relay's recent events, under the status line while hosting
  if (NET.mode === 1 && APP && now - (NET.logT || 0) > 1000) { NET.logT = now; invokeApp('lan_log').then((l) => { $('nlog').textContent = l.slice(-4).join(' · '); }).catch(() => 0); }
}
// the other divers as collision capsules (head to fins, along their heading)
function netColliders() {
  if (!NET.peers.size) return;
  for (const [, P] of NET.peers) {
    if (abs(P.x - F[CX]) > 20 || abs(P.z - F[CZ]) > 20) continue;
    const fx = sin(P.yaw) * cos(P.pit), fy = sin(P.pit), fz = -cos(P.yaw) * cos(P.pit);
    dynAdd(P.x - fx * 0.2, P.y - 0.35 - fy * 0.2, P.z - fz * 0.2, P.x - fx * 1.4, P.y - 0.35 - fy * 1.4, P.z - fz * 1.4, 0.35);
  }
}
// the other divers join the landmark list (drawn with the solid pipeline, material 10; not collidable)
function netAvatars() {
  if (!NET.peers.size || PLAYER >= 0) return; // the animated diver model draws them; this simple mesh is the fallback
  const t = F[TIME];
  for (const [, P] of NET.peers) {
    if (nTmp >= MAXLM) break;
    const L = P.L, pit = clamp(P.pit, -1.2, 1.2) * 0.7;
    L.x = P.x; L.y = P.y - 0.35 + 0.08 * sin(t * 1.7 + L.seed * 20); L.z = P.z;
    L.q = qMul(qAxis(0, 1, 0, -P.yaw), qAxis(1, 0, 0, pit));
    LMTMP[nTmp++] = L;
  }
}
// name tags over the other divers (within 160 m and in front of the camera)
function netTags() {
  if (!NET.peers.size) return;
  const cw = canvas.clientWidth, ch = canvas.clientHeight, asp = W / H;
  for (const [, P] of NET.peers) {
    if (!P.tag) { P.tag = document.createElement('p'); P.tag.className = 'tag'; document.body.appendChild(P.tag); }
    const rx = P.x - F[CX], ry = P.y + 0.9 - F[CY], rz = P.z - F[CZ];
    const z = rx * F[FX] + ry * F[FY] + rz * F[FZ], d = Math.hypot(rx, ry, rz);
    if (z < 0.5 || d > 160 || menu) { P.tag.style.display = 'none'; continue; }
    const sx = (rx * F[RX] + rz * F[RZ]) / (z * TANH * asp), sy = (rx * F[UX] + ry * F[UY] + rz * F[UZ]) / (z * TANH);
    P.tag.style.display = ''; P.tag.textContent = `${P.n}${P.host ? ' (host)' : ''} · ${d.toFixed(0)} m`;
    P.tag.style.transform = `translate(${((sx * 0.5 + 0.5) * cw).toFixed(1)}px, ${((0.5 - sy * 0.5) * ch).toFixed(1)}px) translate(-50%, -100%)`;
  }
}
function netTagsClear() { for (const [, P] of NET.peers) if (P.tag) P.tag.remove(); document.querySelectorAll('.tag').forEach((t) => t.remove()); }

// ---------------------------------------------------------------- sharing imported models
// A model's id is its name, class and size; the host lists its models (in load order) in every world message. A
// client asks for the ones it has neither among its own nor among earlier copies, the host sends each one as
// base64 chunks of 192 KB (one binary blob: a JSON header, then the record's byte arrays), and the client stores
// it in the 'shared' store before reloading into the host's world.
function recBytes(r) {
  const n = (x) => (x == null ? 0 : typeof x === 'string' ? x.length : x.byteLength || 0);
  return n(r.data ?? r.text) + (r.files || []).reduce((a, f) => a + n(f[1]), 0);
}
function modelId(r) { return `${r.name}|${r.cls || 's'}|${recBytes(r)}`; }
function netManifest() { return CUSTOM.slice(0, ACTIVE_IDS.length).map((c, i) => ({ h: ACTIVE_IDS[i], n: c.name, c: c.cls })); }
// record <-> one byte blob (byte arrays keep their kind: ArrayBuffer or Uint8Array)
function packRec(rec) {
  const bins = [];
  const walk = (v) => {
    if (v instanceof ArrayBuffer) { bins.push(new Uint8Array(v)); return { $b: bins.length - 1, k: 'ab' }; }
    if (ArrayBuffer.isView(v)) { bins.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); return { $b: bins.length - 1, k: 'u8' }; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = walk(v[k]); return o; }
    return v;
  };
  const head = new TextEncoder().encode(JSON.stringify({ r: walk(rec), s: bins.map((b) => b.byteLength) }));
  const out = new Uint8Array(4 + head.length + bins.reduce((a, b) => a + b.byteLength, 0));
  new DataView(out.buffer).setUint32(0, head.length, true); out.set(head, 4);
  let o = 4 + head.length; for (const b of bins) { out.set(b, o); o += b.byteLength; }
  return out;
}
function unpackRec(u8) {
  const hl = new DataView(u8.buffer, u8.byteOffset).getUint32(0, true);
  const H = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + hl)));
  const offs = []; let o = 4 + hl; for (const s of H.s) { offs.push(o); o += s; }
  const walk = (v) => {
    if (v && typeof v === 'object' && '$b' in v) { const b = u8.slice(offs[v.$b], offs[v.$b] + H.s[v.$b]); return v.k === 'ab' ? b.buffer : b; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const r = {}; for (const k in v) r[k] = walk(v[k]); return r; }
    return v;
  };
  return walk(H.r);
}
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const CHUNK = 196608;
// host: send the requested models, chunk by chunk, keeping at most ~1 MB queued on the socket
async function netServeModels(ids) {
  if (NET.serving) return; NET.serving = true;
  try {
    const own = (await idbDo('readonly', (s) => s.getAll())) || [], shared = (await idbDo('readonly', (s) => s.getAll(), 'shared')) || [];
    for (const h of ids) {
      const rec = own.find((r) => modelId(r) === h) || (shared.find((x) => x.h === h) || {}).rec;
      if (!rec) continue;
      const data = packRec(rec), n = Math.ceil(data.length / CHUNK);
      for (let i = 0; i < n; i++) {
        while (NET.ws && NET.ws.bufferedAmount > 1 << 20) await new Promise((r) => setTimeout(r, 30));
        if (!NET.ws) return;
        NET.ws.send(JSON.stringify({ t: 'mc', h, i, n, d: b64(data.subarray(i * CHUNK, (i + 1) * CHUNK)) }));
      }
    }
  } catch (e) { console.warn('model sharing', e); } finally { NET.serving = false; }
}
// client: what is missing, ask for it, then run done() once everything is stored
async function netModelsThen(hm, done) {
  const own = (await idbDo('readonly', (s) => s.getAll())) || [], shared = (await idbDo('readonly', (s) => s.getAll(), 'shared')) || [];
  const have = new Set([...own.map(modelId), ...shared.map((x) => x.h)]);
  const miss = hm.filter((x) => !have.has(x.h));
  if (!miss.length) return done();
  NET.want = new Map(miss.map((x) => [x.h, x.n])); NET.done = done;
  netStatus(`Getting the host’s models: ${miss.map((x) => x.n).join(', ')}…`);
  NET.ws.send(JSON.stringify({ t: 'mreq', h: miss.map((x) => x.h) }));
}
async function netChunk(m) {
  if (!NET.want || !NET.want.has(m.h)) return; // someone else's download
  let r = NET.rx.get(m.h); if (!r) NET.rx.set(m.h, (r = { parts: new Array(m.n), got: 0 }));
  if (!r.parts[m.i]) { r.parts[m.i] = unb64(m.d); r.got++; }
  netStatus(`Getting “${NET.want.get(m.h)}” from the host: ${Math.round(r.got * 100 / m.n)} %`);
  if (r.got < m.n) return;
  const all = new Uint8Array(r.parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of r.parts) { all.set(p, o); o += p.length; }
  NET.rx.delete(m.h); NET.want.delete(m.h);
  try { await idbDo('readwrite', (s) => s.put({ h: m.h, rec: unpackRec(all) }), 'shared'); } catch (e) { NET.err = 'Could not store a shared model: ' + e.message; return netDescribe(); }
  if (!NET.want.size && NET.done) { const d = NET.done; NET.done = null; d(); }
}

// ---------------------------------------------------------------- updates
// The apps compare their version with the latest release of the GitHub repository and offer its APK (Android) or
// installer (Windows), opened in the system browser. Auto checks at most every 6 hours, at start. The web version
// is always the latest (the service worker swaps in each deployment), so it only says so.
const UPD_REPO = 'Nessuno6/abyssal-garden';
const verNewer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
function openLink(url) { if (APP) invokeApp('plugin:opener|open_url', { url }).catch(() => window.open(url, '_blank')); else window.open(url, '_blank', 'noopener'); }
async function checkUpdate(manual) {
  const st = $('ust'), dl = $('ud');
  if (manual) st.textContent = 'Checking…';
  try {
    const r = await fetch(`https://api.github.com/repos/${UPD_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    save({ updT: Date.now() });
    if (r.status === 404) { if (manual) st.textContent = `No release published yet · this is ${APP_VERSION}`; return; }
    if (!r.ok) throw new Error('GitHub answered ' + r.status);
    const j = await r.json(), v = String(j.tag_name || '').replace(/^v/i, '');
    if (!verNewer(v, APP_VERSION)) { if (manual) st.textContent = `Up to date (${APP_VERSION})`; return; }
    const want = mob || /Android/i.test(UA) ? /\.apk$/i : /setup\.exe$/i, a = (j.assets || []).find((x) => want.test(x.name));
    const url = a ? a.browser_download_url : j.html_url;
    st.textContent = `Version ${v} is available (this is ${APP_VERSION})`;
    $('udr').hidden = false; dl.textContent = a ? `Download ${v}` : 'Open the release page'; dl.onclick = () => openLink(url);
    $('ub').hidden = false; $('ub').textContent = `Update ${v} available: Online tab`;
  } catch (e) { if (manual) st.textContent = 'Could not check: ' + (e.message || e); }
}

// menu wiring, called by main.js once the menu exists; also rejoins a game after the reload into the host's world
function netInit() {
  $('nn').value = SAVE.nick || (SAVE.nick = 'Diver ' + (100 + ((Math.random() * 900) | 0)));
  save({ nick: $('nn').value });
  $('nn').addEventListener('change', () => netName());
  $('nh').onclick = netHost; $('ns').onclick = () => netScan(false);
  // auto-scan: every 6 s while the menu shows the Online tab and you are in no game
  setInterval(() => { if (APP && menu && !NET.mode && !$('nst').closest('.pg').hidden) netScan(true); }, 6000); $('nl').onclick = () => { netClose(); NET.err = ''; netDescribe(); };
  $('nb').onclick = () => { const a = $('na').value.trim(); if (a) { NET.name = netName(); netOpen(a, false); } };
  $('na').value = SAVE.lastJoin || '';
  $('na').addEventListener('change', () => save({ lastJoin: $('na').value.trim() }));
  netButtons(); netDescribe();
  if (SAVE.join) { const a = SAVE.join; save({ join: 0, netModels: 0 }); NET.name = netName(); netOpen(a, false); }
  // updates
  const auto = () => SAVE.autoUpd !== 0;
  const litA = () => $('up').querySelectorAll('[data-a]').forEach((b) => { b.className = +b.dataset.a === (auto() ? 1 : 0) ? 'on' : ''; });
  if (!APP) { $('up').hidden = true; $('ust').textContent = `Web version ${APP_VERSION}: it updates itself.`; return; }
  $('uc').onclick = () => checkUpdate(true);
  $('up').querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => { save({ autoUpd: +b.dataset.a }); litA(); }; });
  litA();
  $('ust').textContent = `Version ${APP_VERSION}`;
  if (auto() && Date.now() - (SAVE.updT || 0) > 6 * 3600e3) checkUpdate(false);
}
