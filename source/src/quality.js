// ============================================================================
// hardware tiers + saved settings
// ============================================================================
// Runs first: shaders.js bakes the chosen tier's numbers into the WGSL, so the adapter is requested here.
// Saved state lives in localStorage.abyssalOW (JSON): q quality ('auto' | 'low' | 'medium' | 'high'), seed (u32),
// pix / det (where the frame-time tuner settled), loading (set while the world builds: still set on the next visit
// means that load crashed the tab, so this one runs a tier lower).
const $ = (id) => document.getElementById(id);
const fail = (m) => { throw new Error(m, { cause: 1 }); }; // cause marks a message that is shown as it is
const keep = (k, v) => { try { localStorage[k] = v; } catch {} };
let SAVE = {};
try { SAVE = JSON.parse(localStorage.abyssalOW || '{}') || {}; } catch {}
const save = (o) => { Object.assign(SAVE, o); keep('abyssalOW', JSON.stringify(SAVE)); };

const UA = navigator.userAgent;
const mob = matchMedia('(pointer:coarse)').matches || /Android|Mobile|iPad|iPhone/i.test(UA);
const mem = navigator.deviceMemory || 8;
if (!navigator.gpu) fail('This world needs WebGPU. Use a current Chrome or Edge (Windows), or update Chrome / Android System WebView.');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) fail('No WebGPU adapter found.');
const AI = adapter.info || {};
const GPUNAME = [AI.vendor, AI.architecture, AI.device, AI.description].filter(Boolean).join(' ') || 'unknown GPU';
const gpuLow = GPUNAME.toLowerCase();
// tile-based deferred renderers (phones, tablets, Apple): bandwidth-bound, so fewer pixels and no MSAA
const TBDR = mob || /adreno|mali|immortalis|powervr|xclipse|qualcomm|apple|\barm\b/.test(gpuLow);
const DISCRETE = !TBDR && /nvidia|geforce|rtx|gtx|quadro|radeon|amd|rdna|ampere|turing|lovelace|blackwell|\barc\b|alchemist|battlemage/.test(gpuLow);
const SHORT = Math.min(screen.width, screen.height), DPR = devicePixelRatio || 1;
const TABLET = TBDR && SHORT >= 600 && SHORT * DPR >= 1500;
const FLAGSHIP = /adreno[^0-9]*(7[3-9]\d|8\d\d)|adreno-?8|immortalis|mali-?g(7[1-9]\d|9\d\d|1\b)|xclipse/.test(gpuLow) || mem >= 8;

// kd: kelp near / mid / far distance (m). kcap: kelp column list capacities (near, mid, far, glint, shadow).
// B blades per kelp column, G glints per column, capT tuft clumps per 32 m tile, K blades per clump,
// tcap / scap: visible tuft clumps / visible instances per solid mesh kind. Flora budget = the sum of
// kcap[0]*B + kcap[1]*B + kcap[2]*B/2 + tcap*K (blade instances on screen at most).
const TIERS = {
  desk: { label: 'Desktop IMR', scale: [1, 1], pixMax: 2560 * 1440, fogFar: 850, M: 128, L: 5, kd: [24, 58, 150], tuftFar: 70, rockNear: 40, rockFar: 150, smallFar: 50, propFar: 110, glintFar: 110, coralLod: 8,
    B: 640, G: 48, capT: 1024, K: 16, kcap: [1200, 2400, 5000, 4000, 6000], tcap: 160000, scap: 8192, aa: 4, shadow: 4096, shR: 200, water: 512, rayN: 34, rayDiv: 2,
    schools: 14, fish: 320, mantas: 6, jel: 8, jpn: 26, tur: 6, lev: 2, sqs: 5, sqn: 8, vents: 16, bpv: 140, snow: 9000, popMax: 32, LV: 0 },
  mid: { label: 'Desktop integrated', scale: [0.75, 1], pixMax: 1920 * 1080, fogFar: 450, M: 64, L: 5, kd: [20, 48, 120], tuftFar: 50, rockNear: 30, rockFar: 120, smallFar: 40, propFar: 90, glintFar: 80, coralLod: 6,
    B: 320, G: 24, capT: 420, K: 12, kcap: [400, 900, 1800, 1200, 2400], tcap: 30000, scap: 4096, aa: 1, shadow: 2048, shR: 140, water: 256, rayN: 18, rayDiv: 2,
    schools: 10, fish: 200, mantas: 4, jel: 6, jpn: 18, tur: 4, lev: 1, sqs: 4, sqn: 6, vents: 10, bpv: 110, snow: 5000, popMax: 16, LV: 1 },
  phone: { label: 'Mobile TBDR flagship phone', scale: [0.70, 0.75], pixMax: 2.0e6, fogFar: 320, M: 64, L: 5, kd: [18, 40, 100], tuftFar: 40, rockNear: 25, rockFar: 100, smallFar: 30, propFar: 70, glintFar: 50, coralLod: 0,
    B: 192, G: 16, capT: 200, K: 10, kcap: [150, 420, 800, 400, 1200], tcap: 8000, scap: 2048, aa: 1, shadow: 2048, shR: 110, water: 256, rayN: 14, rayDiv: 4,
    schools: 8, fish: 140, mantas: 3, jel: 5, jpn: 14, tur: 3, lev: 1, sqs: 3, sqn: 6, vents: 8, bpv: 90, snow: 3500, popMax: 8, LV: 1 },
  tab: { label: 'Mobile TBDR high-DPI tablet', scale: [0.60, 0.65], pixMax: 2960 * 1848 * 0.65 * 0.65, fogFar: 320, M: 64, L: 5, kd: [18, 40, 100], tuftFar: 40, rockNear: 25, rockFar: 100, smallFar: 30, propFar: 70, glintFar: 50, coralLod: 0,
    B: 208, G: 16, capT: 220, K: 10, kcap: [170, 470, 900, 450, 1300], tcap: 9000, scap: 2048, aa: 1, shadow: 2048, shR: 110, water: 256, rayN: 14, rayDiv: 4,
    schools: 8, fish: 150, mantas: 3, jel: 5, jpn: 14, tur: 3, lev: 1, sqs: 3, sqn: 6, vents: 8, bpv: 90, snow: 3500, popMax: 8, LV: 1 },
  low: { label: 'Low', scale: [0.5, 0.6], pixMax: 1.0e6, fogFar: 240, M: 64, L: 4, kd: [14, 32, 80], tuftFar: 30, rockNear: 20, rockFar: 80, smallFar: 24, propFar: 55, glintFar: 36, coralLod: 0,
    B: 128, G: 10, capT: 120, K: 8, kcap: [120, 300, 500, 200, 600], tcap: 4000, scap: 1024, aa: 1, shadow: 1024, shR: 90, water: 256, rayN: 10, rayDiv: 4,
    schools: 5, fish: 90, mantas: 2, jel: 3, jpn: 10, tur: 2, lev: 1, sqs: 2, sqn: 5, vents: 6, bpv: 70, snow: 2000, popMax: 6, LV: 2 },
};
const AUTO = TBDR ? (TABLET ? 'tab' : FLAGSHIP ? 'phone' : 'low') : DISCRETE ? 'desk' : mem <= 4 ? 'low' : 'mid';
// manual overrides: High is the desktop tier everywhere, Medium the device's mid tier, Low the low tier
const QPICK = { auto: AUTO, low: 'low', medium: TBDR ? (TABLET ? 'tab' : 'phone') : 'mid', high: 'desk' };
if (!QPICK[SAVE.q]) SAVE.q = 'auto';
let TIER = QPICK[SAVE.q];
// the last load crashed the tab: one step down, remembered as an explicit choice
if (SAVE.loading) {
  const down = { desk: 'mid', mid: 'phone', tab: 'low', phone: 'low', low: 'low' }[TIER];
  save({ q: down === 'low' ? 'low' : 'medium', loading: 0, pix: 0, det: 0 }); TIER = down;
}
const TQ = TIERS[TIER];
TQ.tbdr = TBDR;
const LV = TQ.LV; // 0 High, 1 Medium, 2 Low: picks cheaper meshes and shading paths
// texture quality (applied on reload): rock detail texture size, animated water texture size, anisotropic filtering,
// largest side of imported model textures. Auto keeps the tier's own values.
const TXQ = {
  low: { det: 512, water: 128, aniso: 1, model: 512 },
  medium: { det: 1024, water: 256, aniso: 4, model: 1024 },
  high: { det: 2048, water: 512, aniso: 16, model: TBDR ? 2048 : 4096 },
};
if (!TXQ[SAVE.tex]) SAVE.tex = 'auto';
const TX = TXQ[SAVE.tex] || { det: 1024, water: TQ.water, aniso: LV > 1 ? 1 : 8, model: TBDR ? 1024 : 2048 };
const DTX = TX.det;
const SHADOW = TQ.shadow, AA = TQ.aa, WATER = TX.water, RAYN = TQ.rayN, RAYDIV = TQ.rayDiv;
// population ring: NT x NT tiles of 32 m around the camera, enough for the farthest population category
const TILE = 32;
const POPR = max0(TQ.kd[2], TQ.rockFar, TQ.propFar);
function max0(...a) { let m = 0; for (const v of a) if (v > m) m = v; return m; }
const NT = 2 * Math.ceil(POPR / TILE) + 1, NTILE = NT * NT;
// per-tile record layout (records are 4 x vec4f = 64 bytes): kelp columns, tuft clumps, rocks, props, boulders
const NKELP = 49, NROCK = 64, NPROP = 112, NBOUL = 16; // kelp: a 7 x 7 jittered grid per tile
const TOFF = NKELP, SOFF = NKELP + TQ.capT, PER = SOFF + NROCK + NPROP + NBOUL;
// visible-instance mesh kinds for the solid pipeline: 0-3 rocks near, 4-6 sponges, 7-8 coral, 9 tube sponge,
// 10-13 rocks far, 14-15 coral far, 16 table coral, 17 brain coral, 18 glowing mushroom, 19 crystal cluster, 20 vent chimney
const NK = 21;
// indirect list slots: 0 kelp near, 1 kelp mid, 2 kelp far, 3 glints, 4 kelp shadow, 5 tufts, 6.. solid kinds
const NLIST = 6 + NK;
let WSEED = (SAVE.seed >>> 0) || 20261110;
