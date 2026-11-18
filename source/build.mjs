// Builds the self-contained static bundle in ../dist (no network, no external assets):
//   dist/index.html      the whole app: src/*.js bundled and inlined into template.html
//   dist/manifest.json   PWA / Trusted Web Activity manifest
//   dist/sw.js           cache-first offline service worker (cache name = hash of this build)
//   dist/icons/*.png     app icons, drawn procedurally here (192, 512, maskable 512, 1024 for `tauri icon`)
//
//   npm run build            minified
//   npm run build:readable   unminified, for debugging
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gzipSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
mkdirSync(path.join(dist, 'icons'), { recursive: true });
// concatenation order matters: quality.js picks the tier (and requests the adapter) before shaders.js bakes it in;
// audio.js comes before main.js so its state exists before main.js attaches the input handlers
const FILES = ['quality.js', 'math.js', 'shaders.js', 'world.js', 'cave.js', 'sky.js', 'weapons.js', 'audio.js', 'net.js', 'console.js', 'sub.js', 'main.js'];
// the app version (update checks) comes from the Tauri config, the one place it is set
const APP_VERSION = JSON.parse(readFileSync(path.join(here, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
const readable = process.argv.includes('--readable');

// the player's animated diver (made in Blender from 'Diver' by nolanfa, CC-BY-4.0), bundled as base64 when present
const DIVER = existsSync(path.join(here, 'assets', 'diver_anim.glb')) ? path.join(here, 'assets', 'diver_anim.glb') : path.join(here, 'assets', 'diver_swim.glb');
// a second, custom player character (assets/player_custom.glb, same clips as the diver)
const PLAYERF = path.join(here, 'assets', 'player_custom.glb');
const PLAYER_GLB = existsSync(PLAYERF) ? readFileSync(PLAYERF).toString('base64') : '';
const DIVER_GLB = existsSync(DIVER) ? readFileSync(DIVER).toString('base64') : '';
// the built-in leviathans (made in Blender for the game; textures shrunk from leviathan_anim.glb into leviathan.glb)
const LEVF = path.join(here, 'assets', 'leviathan.glb');
const LEV_GLB = existsSync(LEVF) ? readFileSync(LEVF).toString('base64') : '';
// world textures baked in Blender (assets/tex/game, 512 px JPEGs): lava, cave rock + height, brine, moss, sand + height
const TEXD = path.join(here, 'assets', 'tex', 'game'), TEXN = ['lava_emission', 'caverock_color', 'caverock_height', 'brine_color', 'moss_emission', 'seabed_color', 'seabed_height'];
const WORLD_TEX = existsSync(TEXD) ? JSON.stringify(Object.fromEntries(TEXN.filter((n) => existsSync(path.join(TEXD, n + '.jpg'))).map((n) => [n, readFileSync(path.join(TEXD, n + '.jpg')).toString('base64')]))) : '{}';
let js = `const APP_VERSION = '${APP_VERSION}';\nconst DIVER_GLB = '${DIVER_GLB}';\nconst LEV_GLB = '${LEV_GLB}';\nconst PLAYER_GLB = '${PLAYER_GLB}';\nconst WORLD_TEX = ${WORLD_TEX};\n` + FILES.map((f) => readFileSync(path.join(here, 'src', f), 'utf8')).join('\n');
const tpl = readFileSync(path.join(here, 'template.html'), 'utf8');
// everything runs inside one async function; startup errors are shown on screen
const wrap = (body) => `if(!self.__DEVGO)(async()=>{${body}\n})().catch(e=>{console.error(e);document.body.className='l e';document.getElementById('s').textContent=(e.cause?'':'Failed to start: ')+e.message});`;

let html;
if (readable) {
  html = tpl.replace('/*SCRIPT*/', () => wrap(js));
} else {
  // shrink the WGSL inside /*wgsl*/ template literals, then minify the JS and the page's CSS
  const minWgsl = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/ ?([{}()\[\];,:=+\-*\/<>&|!%@]) ?/g, '$1').trim();
  js = js.replace(/\/\*wgsl\*\/`([^`]*)`/g, (_, w) => '`' + minWgsl(w) + '`');
  const code = transformSync(wrap(js), { minify: true, target: 'es2022', legalComments: 'none' }).code.trim();
  const css = (_, s) => '<style>' + transformSync(s, { loader: 'css', minify: true }).code.trim();
  html = tpl.replace(/<style>([^]*?)(?=<\/style>)/, css).replace(/>\s+</g, '><').replace('/*SCRIPT*/', () => code).replace(/<script>\s+/g, '<script>').replace(/\s+<\/script>/g, '</script>');
}
writeFileSync(path.join(dist, 'index.html'), html);
const hash = createHash('sha256').update(html).digest('hex').slice(0, 12);
writeFileSync(path.join(dist, 'sw.js'), readFileSync(path.join(here, 'sw.js'), 'utf8').replace('__BUILD__', hash));
writeFileSync(path.join(dist, 'manifest.json'), readFileSync(path.join(here, 'manifest.json'), 'utf8'));

// ---------------------------------------------------------------- procedural icon: light rays over a kelp silhouette
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(n, f) {
  const raw = Buffer.alloc((n * 4 + 1) * n);
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;
    for (let x = 0; x < n; x++) {
      let r = 0, g = 0, b = 0, a = 0; const S = 3; // 3x3 supersampling
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const c = f((x + (i + 0.5) / S) / n, (y + (j + 0.5) / S) / n); r += c[0]; g += c[1]; b += c[2]; a += c[3]; }
      const o = y * (n * 4 + 1) + 1 + x * 4, q = S * S;
      raw[o] = Math.round(Math.min(1, r / q) * 255); raw[o + 1] = Math.round(Math.min(1, g / q) * 255); raw[o + 2] = Math.round(Math.min(1, b / q) * 255); raw[o + 3] = Math.round(Math.min(1, a / q) * 255);
    }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(n, 0); ih.writeUInt32BE(n, 4); ih[8] = 8; ih[9] = 6; ih[10] = 0; ih[11] = 0; ih[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// u, v in [0, 1] over the full icon; `inset` shrinks the motif into the maskable safe zone; `round` cuts a squircle
function scene(u, v, inset, round) {
  const x = (u - 0.5) / inset + 0.5, y = (v - 0.5) / inset + 0.5;
  let c = mixc([0.08, 0.42, 0.55], [0.01, 0.07, 0.11], ss(0, 1, v));
  // sun rays fanning down from the surface
  const ang = Math.atan2(u - 0.62, v + 0.25), ray = Math.pow(0.5 + 0.5 * Math.cos(ang * 23 + 1.3), 6) * ss(1.0, 0.1, v) * 0.35;
  c = c.map((k, i) => k + ray * [0.6, 0.95, 1][i]);
  // a bright surface glow
  c = c.map((k, i) => k + Math.exp(-((u - 0.62) ** 2 * 8 + (v + 0.05) ** 2 * 30)) * [0.5, 0.9, 1][i] * 0.7);
  // three kelp strands with leaves
  for (const [x0, w, ph, col] of [[0.28, 0.035, 0.0, [0.10, 0.45, 0.20]], [0.5, 0.045, 1.7, [0.16, 0.62, 0.26]], [0.73, 0.032, 3.1, [0.08, 0.38, 0.18]]]) {
    const cx = x0 + 0.05 * Math.sin(y * 7 + ph) * (1 - y), d = Math.abs(x - cx);
    const leaf = Math.abs(Math.sin(y * 26 + ph * 3)) * 0.05 * ss(0.15, 0.5, y);
    const m = ss(w + leaf, w + leaf - 0.012, d) * ss(0.12, 0.2, y) * (y < 1.02 ? 1 : 0);
    c = mixc(c, col.map((k) => k * (0.6 + 0.6 * (1 - y))), m);
  }
  // magenta glow on the floor and a few bubbles
  c = c.map((k, i) => k + Math.exp(-((x - 0.5) ** 2 * 6 + (y - 1.02) ** 2 * 60)) * [0.9, 0.15, 0.6][i] * 0.6);
  for (const [bx, by, br] of [[0.6, 0.45, 0.022], [0.63, 0.36, 0.015], [0.585, 0.28, 0.011]]) {
    const d = Math.hypot(x - bx, y - by), ring = ss(br, br * 0.7, d) * ss(br * 0.45, br * 0.85, d);
    c = c.map((k) => k + ring * 0.9);
  }
  let a = 1;
  if (round) { const p = 4, qx = Math.abs(u - 0.5) / 0.5, qy = Math.abs(v - 0.5) / 0.5; a = ss(1, 0.985, Math.pow(qx ** p + qy ** p, 1 / p)); }
  return [...c, a];
}
writeFileSync(path.join(dist, 'icons', 'icon-192.png'), png(192, (u, v) => scene(u, v, 1, true)));
writeFileSync(path.join(dist, 'icons', 'icon-512.png'), png(512, (u, v) => scene(u, v, 1, true)));
writeFileSync(path.join(dist, 'icons', 'maskable-512.png'), png(512, (u, v) => scene(u, v, 0.8, false)));
writeFileSync(path.join(dist, 'icons', 'icon-1024.png'), png(1024, (u, v) => scene(u, v, 1, true)));

const gz = gzipSync(Buffer.from(html), { level: 9 }).length;
console.log(`dist/index.html: ${(html.length / 1024).toFixed(1)} kB${readable ? ' (readable)' : ''}, ${(gz / 1024).toFixed(1)} kB gzipped · sw cache abyssal-${hash}`);
