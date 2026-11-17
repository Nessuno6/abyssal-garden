// ============================================================================
// renderer, world streaming, camera, input, menu and app lifecycle
// ============================================================================
// Frame pipeline (one command buffer):
//   compute: clipmap levels whose snapped origin moved -> population of newly entered tiles -> cull into indirect args
//   render:  water texture -> shadow map (only when the shadow box re-centres) -> scene -> light shafts -> bloom -> post
// The camera lives in Float64 (F[CX..CZ]); everything sent to the GPU is relative to it (see shaders.js).
const canvas = $('c'), info = $('i'), body = document.body;
// a phone held upright gets the page turned on its side (see template.html)
const rot = matchMedia('(orientation:portrait) and (pointer:coarse)');
const TAURI = !!window.__TAURI__;
const STANDALONE = TAURI || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
// loading bar: each stage glides it to `to` (the share done) over ~`ms` on the compositor, so it moves while this
// thread is busy
let loaded = 0, dead; // dead: the graphics device was lost
const say = (m, to, ms) => {
  if (!dead) $('s').textContent = m;
  const a = $('b').animate({ transform: [`scaleX(${loaded})`, `scaleX(${to})`] }, { duration: ms, fill: 'forwards', easing: 'cubic-bezier(.3,.5,.5,1)' });
  loaded = to;
  return new Promise((r) => { a.ready.then(() => setTimeout(r)); setTimeout(r, document.hidden ? 0 : 1e3); });
};
$('w').hidden = !!navigator.userAgentData || STANDALONE; // only Chromium-based browsers have it
const hasTS = adapter.features.has('timestamp-query');
const device = await adapter.requestDevice({ requiredFeatures: hasTS ? ['timestamp-query'] : [] });
device.addEventListener('uncapturederror', (e) => console.error('GPU: ' + e.error.message));
// out of memory or a GPU timeout (TDR on Windows, a killed context on Android): reload a tier lower
device.lost.then((l) => {
  if (l.reason === 'destroyed') return; // the page is closing
  if (TIER !== 'low') { save({ q: TIER === 'desk' ? 'medium' : 'low', pix: 0, det: 0, loading: 0 }); location.reload(); return; }
  dead = body.className = 'l e'; $('s').textContent = 'The graphics device was lost. Reload to try again.';
});
const ctx = canvas.getContext('webgpu'), FMT = navigator.gpu.getPreferredCanvasFormat();
const Q = device.queue, HDR = 'rgba16float', DEPTH = 'depth32float';
const TU = GPUTextureUsage, BU = GPUBufferUsage, SS = GPUShaderStage;

const mod = (code) => device.createShaderModule({ code });
const buf = (data, usage) => { const b = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | BU.COPY_DST }); Q.writeBuffer(b, 0, data.buffer || data, data.byteOffset || 0, data.byteLength); return b; };
const ebuf = (size, usage) => device.createBuffer({ size: (size + 15) & ~15, usage });
const tex = (w, h, format, usage, o = {}) => device.createTexture({ size: [w, h, o.d || 1], format, usage, mipLevelCount: o.mips || 1, sampleCount: o.samples || 1, dimension: o.dim || '2d' });

// ---------------------------------------------------------------- static resources
const sRep = device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: TX.aniso });
const sClamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
const sCmp = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
const tShadow = tex(SHADOW, SHADOW, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
const tDummy = tex(1, 1, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
const tWater = tex(WATER, WATER, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { mips: 5 });
const tDetail = tex(DTX, DTX, 'rgba8unorm', TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { mips: Math.log2(DTX) + 1 });
// clipmap: one layer per level, (M + 1)^2 texels: height / normal / occlusion (rgba32f), cover + grotto + volcanic (rgba8),
// reef + crystal + kelp + plains (rgba8)
const tCH = tex(CM + 1, CM + 1, 'rgba32float', TU.STORAGE_BINDING | TU.TEXTURE_BINDING, { d: CML });
const tCB = tex(CM + 1, CM + 1, 'rgba8unorm', TU.STORAGE_BINDING | TU.TEXTURE_BINDING, { d: CML });
const tCX = tex(CM + 1, CM + 1, 'rgba8unorm', TU.STORAGE_BINDING | TU.TEXTURE_BINDING, { d: CML });
const arrView = (t) => t.createView({ dimension: '2d-array' });

// uniforms (layouts in shaders.js)
const UB = new Float32Array(84), UBS = new Float32Array(84); // G: 21 vec4 (sonar pulse, your sub's hull box)
const ubo = ebuf(336, BU.UNIFORM | BU.COPY_DST), uboS = ebuf(336, BU.UNIFORM | BU.COPY_DST);
const WTU = new Float32Array(4), uboW = ebuf(16, BU.UNIFORM | BU.COPY_DST);
const LVD = new Float32Array(32), lvBuf = ebuf(128, BU.UNIFORM | BU.COPY_DST);
const wtBuf = ebuf(1088, BU.UNIFORM | BU.COPY_DST);
const CLB = new ArrayBuffer(272), CLU = new Uint32Array(CLB), CLI = new Int32Array(CLB), CLF = new Float32Array(CLB), clipU = ebuf(272, BU.UNIFORM | BU.COPY_DST);
const PUB = new ArrayBuffer(1056), PUU = new Uint32Array(PUB), PUI = new Int32Array(PUB), PUF = new Float32Array(PUB), popU = ebuf(1056, BU.UNIFORM | BU.COPY_DST);
const CUD = new Float32Array(40), cullU = ebuf(160, BU.UNIFORM | BU.COPY_DST);
// population + visibility buffers
const TILED = new Float32Array(NTILE * 4), tileBuf = ebuf(NTILE * 16, BU.STORAGE | BU.COPY_DST);
const recBuf = ebuf(NTILE * PER * 64, BU.STORAGE);
const kvBuf = ebuf(KTOT * 32, BU.STORAGE), tvBuf = ebuf(TQ.tcap * 32, BU.STORAGE);
const SCAP = TQ.scap, svBuf = ebuf(NK * SCAP * 64, BU.STORAGE | BU.VERTEX);
const argBuf = ebuf(NLIST * 32, BU.STORAGE | BU.INDIRECT | BU.COPY_DST);
const cntBuf = ebuf(NLIST * 4, BU.STORAGE | BU.COPY_DST | BU.COPY_SRC), cntRead = ebuf(NLIST * 4, BU.MAP_READ | BU.COPY_DST);
const ZERO = new Uint32Array(NLIST), ARGT = new Uint32Array(NLIST * 8), CNTR = new Uint32Array(NLIST);
const lmBuf = ebuf(MAXLM * 64, BU.VERTEX | BU.COPY_DST);

const VF = SS.VERTEX | SS.FRAGMENT;
const bgl0 = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: VF, buffer: {} },
  { binding: 1, visibility: VF, sampler: {} }, { binding: 2, visibility: VF, sampler: {} }, { binding: 3, visibility: VF, sampler: { type: 'comparison' } },
  { binding: 4, visibility: VF, texture: { sampleType: 'depth' } },
  { binding: 5, visibility: VF, texture: {} }, { binding: 6, visibility: VF, texture: {} }] });
const bgl1 = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: VF, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
  { binding: 1, visibility: VF, texture: { viewDimension: '2d-array' } },
  { binding: 2, visibility: VF, buffer: {} },
  { binding: 3, visibility: VF, buffer: { type: 'read-only-storage' } },
  { binding: 4, visibility: VF, buffer: { type: 'read-only-storage' } },
  { binding: 5, visibility: VF, buffer: {} },
  { binding: 6, visibility: VF, texture: { viewDimension: '2d-array' } }] });
const mkBG0 = (u, sh) => device.createBindGroup({ layout: bgl0, entries: [
  { binding: 0, resource: { buffer: u } }, { binding: 1, resource: sRep }, { binding: 2, resource: sClamp }, { binding: 3, resource: sCmp },
  { binding: 4, resource: sh.createView() }, { binding: 5, resource: tWater.createView() }, { binding: 6, resource: tDetail.createView() }] });
const bg0 = mkBG0(ubo, tShadow), bg0s = mkBG0(uboS, tDummy);
const bg1 = device.createBindGroup({ layout: bgl1, entries: [
  { binding: 0, resource: arrView(tCH) }, { binding: 1, resource: arrView(tCB) }, { binding: 2, resource: { buffer: lvBuf } },
  { binding: 3, resource: { buffer: kvBuf } }, { binding: 4, resource: { buffer: tvBuf } }, { binding: 5, resource: { buffer: wtBuf } }, { binding: 6, resource: arrView(tCX) }] });
const pl0 = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] });
// imported models: group 2 = material (base-colour texture, colour + alpha cutout)
const bglT = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: {} }, { binding: 1, visibility: SS.FRAGMENT, buffer: {} }] });
const plC = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1, bglT] });
const bglJ = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.VERTEX, buffer: { type: 'read-only-storage' } }] });
const plCS = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1, bglT, bglJ] });

const bglBlit = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: {} }, { binding: 1, visibility: SS.FRAGMENT, sampler: {} }] });
const plBlit = device.createPipelineLayout({ bindGroupLayouts: [bglBlit] });
const mBlit = mod(W_BLIT);
const blitPipe = (entry, format, add) => device.createRenderPipeline({ layout: plBlit, vertex: { module: mBlit, entryPoint: 'vs' },
  fragment: { module: mBlit, entryPoint: entry, targets: [{ format, blend: add ? { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } : undefined }] } });
const pMip8 = blitPipe('fsMip', 'rgba8unorm'), pMip16 = blitPipe('fsMip', HDR), pDown0 = blitPipe('fsDown0', HDR), pDown = blitPipe('fsDown', HDR), pUp = blitPipe('fsUp', HDR, true);
const blitBG = (view) => device.createBindGroup({ layout: bglBlit, entries: [{ binding: 0, resource: view }, { binding: 1, resource: sClamp }] });
const colorAtt = (view, clear) => ({ view, loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] });

// vertex layouts
const A = (shaderLocation, offset, format) => ({ shaderLocation, offset, format });
const vbSolid = { arrayStride: 16, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4')] };
const ibSolid = { arrayStride: 64, stepMode: 'instance', attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4'), A(4, 32, 'float32x4'), A(5, 48, 'float32x4')] };
const ibAnim = { arrayStride: 32, stepMode: 'instance', attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4')] };
const ibBub = { arrayStride: 32, stepMode: 'instance', attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4')] };
const ibSnow = { arrayStride: 16, stepMode: 'instance', attributes: [A(0, 0, 'float32x4')] };
const vbCust = { arrayStride: 24, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4'), A(2, 16, 'float32x2')] };
const ibCust = { arrayStride: 64, stepMode: 'instance', attributes: [A(3, 0, 'float32x4'), A(4, 16, 'float32x4'), A(5, 32, 'float32x4'), A(6, 48, 'float32x4')] };
const vbSkin = { arrayStride: 8, attributes: [A(7, 0, 'uint8x4'), A(8, 4, 'unorm8x4')] };

const scenePipe = (m, vsE, fsE, buffers, o = {}) => device.createRenderPipelineAsync({ layout: o.layout || pl0,
  vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
  fragment: { module: m, entryPoint: fsE, targets: [{ format: HDR, blend: o.blend }] },
  primitive: { topology: o.strip ? 'triangle-strip' : 'triangle-list', cullMode: o.cull || 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: !o.blend, depthCompare: 'greater' }, multisample: { count: AA } });
const shadowPipe = (m, vsE, buffers, o = {}) => device.createRenderPipelineAsync({ layout: o.layout || pl0,
  vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
  primitive: { topology: o.strip ? 'triangle-strip' : 'triangle-list', cullMode: o.cull || 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 } });
const computePipe = (code, label) => device.createComputePipelineAsync({ label, layout: 'auto', compute: { module: mod(code), entryPoint: 'main' } });

await say('Compiling shaders…', 0.08, 600);
const mSolid = mod(W_SOLID), mLeaf = mod(W_LEAF), mAnim = mod(W_ANIM), mSurf = mod(W_SURF), mSpr = mod(W_SPR), mCust = mod(W_CUST);
const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
// kelp / ground cover blades are widened on tiers that draw fewer of them, so the forests keep their mass
const WMK = min(2, sqrt(640 / TQ.B)), WMT = min(2, sqrt(768 * 16 / (TQ.capT * TQ.K)));
const kc = (ROWS, list, STEP) => ({ ROWS, FAR: TQ.kd[2], BASE: KBASE[list], BL: TQ.B, STEP, WM: WMK });
const PREMUL = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
const [pTerr, pSolid, pKN, pKM, pKF, pTu, pGl, pFish, pManta, pTurtle, pLev, pSquid, pJelly, pSurf, pBack, pBub, pSnow, pTerrSh, pSolidSh, pKSh, pClip, pPop, pCull, pCust, pCustSh, pCustS, pCustShS] = await Promise.all([
  scenePipe(mSolid, 'vsT', 'fs', []),
  scenePipe(mSolid, 'vs', 'fs', [vbSolid, ibSolid]),
  scenePipe(mLeaf, 'vsK', 'fs', [], { strip: true, constants: kc(9, 0, 1) }),
  scenePipe(mLeaf, 'vsK', 'fs', [], { strip: true, constants: kc(5, 1, 1) }),
  scenePipe(mLeaf, 'vsK', 'fs', [], { strip: true, constants: kc(3, 2, 2) }),
  scenePipe(mLeaf, 'vsTu', 'fs', [], { strip: true, constants: { ROWS: 5, FAR: TQ.tuftFar, KN: TQ.K, WM: WMT } }),
  scenePipe(mLeaf, 'vsGl', 'fsGl', [], { strip: true, blend: ADD, constants: { BASE: KBASE[3], GN: TQ.G } }),
  scenePipe(mAnim, 'vsFish', 'fsFish', [vbSolid, ibAnim]),
  scenePipe(mAnim, 'vsManta', 'fsManta', [vbSolid, ibAnim]),
  scenePipe(mAnim, 'vsTurtle', 'fsTurtle', [vbSolid, ibAnim]),
  scenePipe(mAnim, 'vsLev', 'fsLev', [vbSolid, ibAnim]),
  scenePipe(mAnim, 'vsSquid', 'fsSquid', [vbSolid, ibAnim]),
  scenePipe(mAnim, 'vsJelly', 'fsJelly', [vbSolid, ibAnim], { blend: PREMUL }),
  scenePipe(mSurf, 'vs', 'fs', [], { strip: true }),
  scenePipe(mSurf, 'vsB', 'fsB', [], { strip: true }),
  scenePipe(mSpr, 'vsBub', 'fsBub', [ibBub], { strip: true, blend: PREMUL }),
  scenePipe(mSpr, 'vsSnow', 'fsSnow', [ibSnow], { strip: true, blend: ADD }),
  shadowPipe(mSolid, 'vsT', []),
  shadowPipe(mSolid, 'vs', [vbSolid, ibSolid]),
  shadowPipe(mLeaf, 'vsK', [], { strip: true, constants: kc(3, 4, 2) }),
  computePipe(W_CLIP, 'clipmap'), computePipe(W_POP, 'population'), computePipe(W_CULL, 'cull'),
  scenePipe(mCust, 'vsC', 'fsC', [vbCust, ibCust], { layout: plC }), shadowPipe(mCust, 'vsC', [vbCust, ibCust], { layout: plC }),
  scenePipe(mCust, 'vsCS', 'fsC', [vbCust, ibCust, vbSkin], { layout: plCS }), shadowPipe(mCust, 'vsCS', [vbCust, ibCust, vbSkin], { layout: plCS })]);

const mWater = mod(W_WATER);
const pWater = device.createRenderPipeline({ layout: 'auto', vertex: { module: mWater, entryPoint: 'vs' }, fragment: { module: mWater, entryPoint: 'fs', targets: [{ format: HDR }] } });
const bgWater = device.createBindGroup({ layout: pWater.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uboW } }] });
const waterViews = [0, 1, 2, 3, 4].map((m) => tWater.createView({ baseMipLevel: m, mipLevelCount: 1 }));
const waterBG = waterViews.map((v) => blitBG(v));
const waterPass = waterViews.map((v) => ({ colorAttachments: [colorAtt(v, true)] }));
const mRays = mod(W_RAYS), mPost = mod(W_POST), mRB = mod(W_RBLUR);
const pRB = device.createRenderPipeline({ layout: 'auto', vertex: { module: mRB, entryPoint: 'vs' }, fragment: { module: mRB, entryPoint: 'fs', targets: [{ format: HDR }] } });
const pRays = device.createRenderPipeline({ layout: 'auto', vertex: { module: mRays, entryPoint: 'vs' }, fragment: { module: mRays, entryPoint: 'fs', targets: [{ format: HDR }] } });
const pPost = device.createRenderPipeline({ layout: 'auto', vertex: { module: mPost, entryPoint: 'vs' }, fragment: { module: mPost, entryPoint: 'fs', targets: [{ format: FMT }] } });
const fsPipe = (code) => { const m = mod(code); return device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: FMT }] } }); };
const pEasu = fsPipe(W_EASU), pRcas = fsPipe(W_RCAS), pGen = fsPipe(W_GEN);
const easuU = new Float32Array(4), easuBuf = ebuf(16, BU.UNIFORM | BU.COPY_DST), rcasU = new Float32Array(4), rcasBuf = ebuf(16, BU.UNIFORM | BU.COPY_DST);
const GENU = new Float32Array(28), genBuf = ebuf(112, BU.UNIFORM | BU.COPY_DST);

const bgClip = device.createBindGroup({ layout: pClip.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: clipU } },
  { binding: 1, resource: arrView(tCH) }, { binding: 2, resource: arrView(tCB) }, { binding: 3, resource: arrView(tCX) }] });
const bgPop = device.createBindGroup({ layout: pPop.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: popU } }, { binding: 1, resource: { buffer: recBuf } }] });
const bgCull = device.createBindGroup({ layout: pCull.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: cullU } },
  { binding: 1, resource: { buffer: tileBuf } }, { binding: 2, resource: { buffer: recBuf } }, { binding: 3, resource: { buffer: kvBuf } },
  { binding: 4, resource: { buffer: tvBuf } }, { binding: 5, resource: { buffer: svBuf } }, { binding: 6, resource: { buffer: argBuf } }, { binding: 7, resource: { buffer: cntBuf } }] });

// ---------------------------------------------------------------- sun + shadow projection (render space, re-centred on SHC)
const SUN = (() => { const v = [0.27, 1, -0.24], l = hypot(...v); return v.map((c) => c / l); })();
const SM = new Float32Array(16), SHC = new Float64Array([1e18, 1e18]), SHR = TQ.shR;
{
  const L = SUN, lr = [L[1], -L[0], 0], ll = hypot(...lr); lr[0] /= ll; lr[1] /= ll;
  const lu = [L[1] * lr[2] - L[2] * lr[1], L[2] * lr[0] - L[0] * lr[2], L[0] * lr[1] - L[1] * lr[0]];
  const R = SHR, d0 = -175, d1 = 125, m = SM;
  m[0] = lr[0] / R; m[4] = lr[1] / R; m[8] = lr[2] / R; m[12] = 0;
  m[1] = lu[0] / R; m[5] = lu[1] / R; m[9] = lu[2] / R; m[13] = 0;
  m[2] = -L[0] / (d1 - d0); m[6] = -L[1] / (d1 - d0); m[10] = -L[2] / (d1 - d0); m[14] = d1 / (d1 - d0);
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
  for (let i = 0; i < 3; i++) UB[48 + i] = UBS[48 + i] = SUN[i];
  UBS[52] = 0; UBS[58] = 1; // res.x = 0 marks the shadow pass; detail scale 1
}

// ---------------------------------------------------------------- meshes
// custom models (IndexedDB 'abyssal'): 'models' holds the ones added from the menu ({ name, cls, type, data | main +
// files }); 'shared' holds copies of a LAN host's models ({ h: model id, rec }), kept apart so they never mix with
// your own. Parsed before the meshes are packed.
const idbOpen = () => new Promise((res, rej) => {
  const rq = indexedDB.open('abyssal', 2);
  rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains('models')) db.createObjectStore('models', { keyPath: 'name' }); if (!db.objectStoreNames.contains('shared')) db.createObjectStore('shared', { keyPath: 'h' }); };
  rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});
const idbDo = async (mode, f, store = 'models') => { const db = await idbOpen(); return new Promise((res, rej) => { const tx = db.transaction(store, mode), r = f(tx.objectStore(store)); tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); }); };
let CUSTOM = [], ACTIVE_IDS = [];
try {
  // rejoining a LAN game: exactly the host's models, in the host's order (structure placement depends on the list);
  // otherwise your own
  const own = (await idbDo('readonly', (s) => s.getAll())) || [];
  let recs = own.slice(0, 8);
  if (SAVE.join && Array.isArray(SAVE.netModels)) {
    const shared = (await idbDo('readonly', (s) => s.getAll(), 'shared')) || [];
    recs = SAVE.netModels.map((h) => own.find((r) => modelId(r) === h) || (shared.find((x) => x.h === h) || {}).rec).filter(Boolean);
  }
  if (recs.length) await say('Loading your models…', 0.28, 800);
  // submarine interiors last: each uses its hull's normalisation (same frame, so it sits inside the hull)
  recs = [...recs.filter((r) => r.cls !== 'i'), ...recs.filter((r) => r.cls === 'i')];
  for (const rec of recs) {
    try {
      let ref = null;
      if (rec.cls === 'i') {
        const base = rec.name.toLowerCase().replace(/_?interior$/, ''), hull = CUSTOM.find((c) => c.cls === 'm' && c.name.toLowerCase() === base);
        if (!hull) { console.warn('interior without its submarine', rec.name); continue; }
        ref = hull.norm;
      }
      CUSTOM.push(finishModel(await parseModelRecord(rec, TX.model), rec.cls || 's', rec.name, ref));
      ACTIVE_IDS.push(modelId(rec)); // only the models that loaded: the list must match CUSTOM
    } catch (err) { console.warn('model', rec.name, err); }
  }
} catch (err) { console.warn('models unavailable', err); }
const STRUCTS = [], PLANTS = [], CRE = [];
// submarines are not spawned in the world (each player has one: sub.js) and interiors only show inside them
CUSTOM.forEach((m, i) => { if (m.cls === 'm' || m.cls === 'i') return; (m.cls === 'p' ? PLANTS : MOVERS.includes(m.cls) ? CRE : STRUCTS).push(i); });
// slots for the movers: 6 per creature model (two animals each), 1 per leviathan, 2 per submarine, 2 per boat
{
  let n = 0;
  for (const i of CRE) { const k = 'clmb'.indexOf(CUSTOM[i].cls); for (let j = 0; j < [6, 1, 2, 2][k] && n < NCUS; j++, n++) { CSM[n] = i; CSK[n] = k; } }
  LIFEN[6] = n;
}
// the player's diver (assets/diver_swim.glb, bundled by build.mjs): you in third person and every other diver
let PLAYER = -1;
if (DIVER_GLB) {
  try {
    const fm = finishModel(await parseModelRecord({ name: 'diver', type: 'glb', data: unb64(DIVER_GLB).buffer }, TX.model), 'c', 'diver');
    fm.cls = 'player'; PLAYER = CUSTOM.length; CUSTOM.push(fm);
  } catch (err) { console.warn('diver model', err); }
}
await say('Building set pieces…', 0.3, 1500);
// mesh ids: 0-3 rocks, 4-6 sponges, 7-8 coral, 9 tube sponge, 10-13 far rocks, 14-15 far coral, 16 whale fluke, 17 ship,
// 18 manta, 19 fish, 20 rock arch, 21 table coral, 22 brain coral, 23 mushroom, 24 natural bridge, 25 turtle, 26 jellyfish,
// 27 crystal cluster, 28 vent chimney, 29 temple ruins, 30 leviathan skeleton, 31 living leviathan, 32 squid.
// KMESH maps the cull shader's NK population kinds to meshes.
const meshes = [meshChunk(1, 3), meshChunk(7, 3), meshChunk(13, 3), meshChunk(22, 3),
  meshLathe([[0, 0, 0.5], [0.34, 0, 0.6], [0.5, 0.2, 0.85], [0.6, 0.6, 1], [0.55, 0.95, 1], [0.47, 1.08, 1], [0.38, 1.1, 0.9], [0.3, 1.0, 0.45], [0.26, 0.6, 0.15], [0, 0.35, 0.05]], 18, 0.3, 9),
  meshLathe([[0, 0, 0.5], [0.2, 0, 0.6], [0.26, 0.5, 0.85], [0.4, 1.25, 1], [0.4, 1.42, 1], [0.33, 1.48, 0.9], [0.26, 1.38, 0.4], [0.18, 0.8, 0.12], [0, 0.5, 0.05]], 16, 0.35, 8),
  meshLathe([[0, 0, 0.5], [0.5, 0, 0.7], [0.72, 0.18, 1], [0.74, 0.38, 1], [0.62, 0.5, 0.9], [0.48, 0.42, 0.45], [0.4, 0.2, 0.15], [0, 0.14, 0.06]], 18, 0.25, 10),
  meshCoral(0), meshCoral(1), meshTubes(),
  meshChunk(1, 1), meshChunk(7, 1), meshChunk(13, 1), meshChunk(22, 1), meshCoral(0, 1), meshCoral(1, 1)].map((m) => m.build());
await say('Carving the whale tail…', 0.45, 1500);
meshes.push(meshFluke(), meshShip().build(), meshManta().build(), meshFish().build());
await say('Raising the arches…', 0.55, 1200);
meshes.push(meshArch());
await say('Growing coral and fungi…', 0.62, 1200);
meshes.push(meshTableCoral().build(), meshBrainCoral().build(), meshMushroom().build(), meshBridge(), meshTurtle().build(), meshJelly().build());
await say('Raising crystals, vents and ruins…', 0.67, 900);
meshes.push(meshCrystal().build(), meshChimney().build(), meshRuins().build(), meshSkeleton().build(), meshLeviathan().build(), meshSquid().build());
const DIVER_MESH = meshes.length; meshes.push(meshDiver().build()); // 33: other players (net.js)
const KMESH = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 21, 22, 23, 27, 28];
let nV = 0, nI = 0;
for (const m of meshes) { m.v0 = nV; m.i0 = nI; nV += m.nv; nI += m.ib.length; }
const allV = new Uint8Array(nV * 16), allI = new Uint32Array(nI);
for (const m of meshes) { allV.set(new Uint8Array(m.vb), m.v0 * 16); allI.set(m.ib, m.i0); }
const vbMesh = buf(allV, BU.VERTEX), ibMesh = buf(allI, BU.INDEX);
const MANTA = meshes[18], FISH = meshes[19], TURTLE = meshes[25], JELLY = meshes[26], LEVI = meshes[31], SQUID = meshes[32];
// indirect args template: leaf lists draw ROWS * 2 strip vertices per instance; solid kinds draw their mesh
ARGT.set([18, 0, 0, 0], 0); ARGT.set([10, 0, 0, 0], 8); ARGT.set([6, 0, 0, 0], 16); ARGT.set([4, 0, 0, 0], 24); ARGT.set([6, 0, 0, 0], 32); ARGT.set([10, 0, 0, 0], 40);
for (let k = 0; k < NK; k++) { const m = meshes[KMESH[k]]; ARGT.set([m.ib.length, 0, m.i0, m.v0, 0], (6 + k) * 8); }

// clipmap grid: (M + 1)^2 vertices addressed by vertex_index; level 0 draws the full grid, the others a ring whose
// (M / 2)^2 hole sits at quad offset M / 4 + {0, 1} on each axis (4 variants), where the finer level is
const GN = CM + 1, QF = CM * CM, QR = CM * CM - (CM / 2) * (CM / 2);
const gidx = new Uint32Array(6 * (QF + 4 * QR)), RING0 = new Uint32Array(4);
{
  let n = 0;
  const quad = (i, j) => { const a = j * GN + i; gidx[n++] = a; gidx[n++] = a + GN; gidx[n++] = a + 1; gidx[n++] = a + 1; gidx[n++] = a + GN; gidx[n++] = a + GN + 1; };
  for (let j = 0; j < CM; j++) for (let i = 0; i < CM; i++) quad(i, j);
  for (let v = 0; v < 4; v++) {
    RING0[v] = n;
    const hx = CM / 4 + (v & 1), hz = CM / 4 + (v >> 1);
    for (let j = 0; j < CM; j++) for (let i = 0; i < CM; i++) if (i < hx || i >= hx + CM / 2 || j < hz || j >= hz + CM / 2) quad(i, j);
  }
}
const ibGrid = buf(gidx, BU.INDEX);

// imported models on the GPU: vertex / index buffers, and per material an sRGB texture with mips (or a 1x1 white) and
// its colour uniform
const pMipS = blitPipe('fsMip', 'rgba8unorm-srgb');
const tWhite = tex(1, 1, 'rgba8unorm-srgb', TU.TEXTURE_BINDING | TU.COPY_DST);
Q.writeTexture({ texture: tWhite }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
const MODELS = CUSTOM.map((m) => {
  const groups = m.groups.map((gr) => {
    let t = tWhite;
    if (gr.img) {
      const w = gr.img.width, h = gr.img.height, mips = floor(Math.log2(max(w, h))) + 1;
      t = tex(w, h, 'rgba8unorm-srgb', TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT, { mips });
      Q.copyExternalImageToTexture({ source: gr.img }, { texture: t }, [w, h]);
      const e = device.createCommandEncoder();
      for (let i = 1; i < mips; i++) {
        const r = e.beginRenderPass({ colorAttachments: [colorAtt(t.createView({ baseMipLevel: i, mipLevelCount: 1 }), true)] });
        r.setPipeline(pMipS); r.setBindGroup(0, blitBG(t.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }))); r.draw(3); r.end();
      }
      Q.submit([e.finish()]);
    }
    const c = gr.img ? gr.color : gr.color.map((v, i) => (i < 3 ? v * m.tint[i] : v));
    const e = gr.emi || [0, 0, 0], ub = buf(new Float32Array([c[0], c[1], c[2], gr.cut, e[0], e[1], e[2], 0]), BU.UNIFORM);
    return { first: gr.first, count: gr.count, glass: /glass|canopy|window|windshield/i.test(gr.mat || ''), bg: device.createBindGroup({ layout: bglT, entries: [{ binding: 0, resource: t.createView() }, { binding: 1, resource: { buffer: ub } }] }) };
  });
  return { vb: buf(new Uint8Array(m.vb), BU.VERTEX), ib: buf(m.ib, BU.INDEX), sb: m.skin ? buf(m.skin.sk, BU.VERTEX) : null, groups, n0: 0, n: 0, pb: 0 };
});
// joint matrices of this frame's poses: 4 phase-shifted poses per skinned model (its instances pick one by seed),
// then one per diver avatar
const MAXJM = 4096, JMD = new Float32Array(MAXJM * 16), jmBuf = ebuf(MAXJM * 64, BU.STORAGE | BU.COPY_DST);
const bgJ = device.createBindGroup({ layout: bglJ, entries: [{ binding: 0, resource: { buffer: jmBuf } }] });
let jmN = 0;
function poseAlloc(mi, clip, t) {
  const S = CUSTOM[mi].skin, n = S.nJ + 1;
  if (jmN + n > MAXJM) return MODELS[mi].pb;
  const b = jmN; skinPose(S, clip, t, JMD, b * 16); jmN += n; return b;
}
// per-frame instances of the imported models: structures (from the structure list), plant clusters, creatures
const MAXCI = 1024, CI = new Float32Array(MAXCI * 16), ciBuf = ebuf(MAXCI * 64, BU.VERTEX | BU.COPY_DST);
let nCI = 0, ciPass = 0;
function ciPut(m, x, y, z, sc, qx, qy, qz, qw, cls, seed, ph, sp, pose = -2, tint = null) {
  const M = MODELS[m];
  if (ciPass === 0) { M.n++; return; }
  const j = M.n0 + M.n++;
  if (j >= MAXCI) return;
  const o = j * 16;
  CI[o] = x - F[CX]; CI[o + 1] = y; CI[o + 2] = z - F[CZ]; CI[o + 3] = sc; CI[o + 4] = qx; CI[o + 5] = qy; CI[o + 6] = qz; CI[o + 7] = qw;
  CI[o + 8] = cls; CI[o + 9] = seed; CI[o + 10] = ph; CI[o + 11] = sp;
  const Sk = CUSTOM[m].skin;
  CI[o + 12] = !Sk ? -1 : pose >= 0 ? pose : M.pb + ((((seed * 4) | 0) & 3) * (Sk.nJ + 1));
  CI[o + 13] = tint ? tint[0] : 0; CI[o + 14] = tint ? tint[1] : 0; CI[o + 15] = tint ? tint[2] : 0;
  // collision: a capsule along the mover's length (movers travel along +z; boats sit on their keel line)
  const C = CUSTOM[m];
  if (MOVERS.includes(C.cls) && C.cls.length === 1 && sc > 0.05 && !subNoCol) {
    const hb = C.hb, r = max(hb[0], hb[1]) * sc * 0.8, hl = max(hb[2] * sc - r, 0), dx = F[CX] - x, dz = F[CZ] - z;
    if (dx * dx + dz * dz < (hb[2] * sc + 40) ** 2) {
      const fx = 2 * (qx * qz + qw * qy), fy = 2 * (qy * qz - qw * qx), fz = 1 - 2 * (qx * qx + qy * qy), yc = y + (C.cls === 'b' ? hb[1] * sc : 0);
      dynAdd(x - fx * hl, yc - fy * hl, z - fz * hl, x + fx * hl, yc + fy * hl, z + fz * hl, r);
    }
  }
}
function ciEmit() {
  subEmit();
  if (PLAYER >= 0) {
    if (THIRD && SUBM.mode === 'out') avatarPut(TPP[0], TPP[1], TPP[2], F[YAW], F[PIT], ME.spd, ME.t, nameHue(SAVE.nick || ''));
    for (const [, P] of NET.peers) if (!P.ride) avatarPut(P.x, P.y, P.z, P.yaw, P.pit, P.spd || 0, P.at || 0, P.L.seed);
  }
  for (let i = 0; i < nTmp; i++) { const L = LMTMP[i]; if (L.k === 13) ciPut(L.cm, L.x, L.y, L.z, L.sc, L.q[0], L.q[1], L.q[2], L.q[3], 0, L.seed, 0, 0); }
  if (PLANTS.length) {
    const R = min(TQ.fogFar * 0.35, 150), x0 = floor((F[CX] - R) / PCELL), x1 = floor((F[CX] + R) / PCELL), z0 = floor((F[CZ] - R) / PCELL), z1 = floor((F[CZ] + R) / PCELL);
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) { const A = plantCell(gx, gz); for (let i = 0; i < A.length; i++) { const p = A[i]; ciPut(p.m, p.x, p.y, p.z, p.sc, 0, sin(p.yaw / 2), 0, cos(p.yaw / 2), 1, p.seed, 0, 0); } }
  }
  // movers. Creatures: two per slot circling its (wandering) centre; leviathans: one on a wide circle; both face along
  // their path and swim with the body wave. Submarines and boats sit at the slot centre facing their heading (boats on
  // the surface, rolling gently).
  for (let s = 0; s < LIFEN[6]; s++) {
    const m = CSM[s], k = CSK[s], fade = min(CUS[s * 4 + 3] / 3, 1), sk = !!CUSTOM[m].skin;
    cslot(s);
    const R = CSP[0], sp = CSP[1], p0 = CSP[2], sz = CSP[3], g = NSLOT - NCUS + s;
    if (k >= 2) {
      const vx = BVEL[g * 2], vz = BVEL[g * 2 + 1], yaw = atan2(vx, vz), cy = cos(yaw / 2), sy = sin(yaw / 2);
      const pose = sk && ciPass === 1 ? moverPose(s * 2, m, k, yaw, hypot(vx, vz), 0, 0, 0, 0) : -2;
      // an animated model swims with its clips; the procedural body wave (class 2) is for still models
      if (k === 2) ciPut(m, CUS[s * 4], CUS[s * 4 + 1] + 0.6 * sin(F[TIME] * 0.3 + s), CUS[s * 4 + 2], sz * fade, 0, sy, 0, cy, 0, 0, 0, 0, pose);
      else { const rl = 0.05 * sin(F[TIME] * 0.8 + s * 2), cz = cos(rl / 2), sz2 = sin(rl / 2); ciPut(m, CUS[s * 4], -0.7 * CUSTOM[m].hb[1] * sz, CUS[s * 4 + 2], sz * fade, sy * sz2, sy * cz, cy * sz2, cy * cz, 0, 0, 0, 0, pose); }
      continue;
    }
    for (let j = 0; j < (k === 1 ? 1 : 2); j++) {
      const a = F[TIME] * sp + p0 + j * 2.1, b = a * 1.3 + j, sg = sp < 0 ? -1 : 1;
      let tx = -R * sin(a) * sg, ty = 1.82 * cos(b) * sg, tz = R * 0.85 * cos(a) * sg; const tl = hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      let x = CUS[s * 4] + R * cos(a), y = CUS[s * 4 + 1] + 1.4 * sin(b), z = CUS[s * 4 + 2] + R * 0.85 * sin(a);
      const pose = sk && ciPass === 1 ? moverPose(s * 2 + j, m, k, atan2(tx, tz), abs(sp) * R, g, x, y, z) : -2;
      // a lunge (attack) carries the body toward its target, and points it there
      if (sk && MV.lw[s * 2 + j] > 0) {
        const o = (s * 2 + j) * 3, w = MV.lw[s * 2 + j];
        x += MV.lv[o] * w; y += MV.lv[o + 1] * w; z += MV.lv[o + 2] * w;
        const l = hypot(MV.lv[o], MV.lv[o + 1], MV.lv[o + 2]) || 1, e = min(1, w * 0.12);
        tx += (MV.lv[o] / l - tx) * e; ty += (MV.lv[o + 1] / l - ty) * e; tz += (MV.lv[o + 2] / l - tz) * e;
      }
      const yaw = atan2(tx, tz), pit = -Math.asin(clamp(ty, -0.6, 0.6)), cy = cos(yaw / 2), sy = sin(yaw / 2), cx = cos(pit / 2), sx = sin(pit / 2);
      ciPut(m, x, y, z, sz * (0.85 + 0.3 * j) * fade, cy * sx, sy * cx, -sy * sx, cy * cx, sk ? 0 : 2, hash2(s, j, 605), p0 + j, k === 1 ? 0.35 : 0.8 + 0.6 * hash2(s, j, 606), pose);
    }
  }
}
// ---------------------------------------------------------------- animated movers: clips follow behaviour
// Per mover instance (slot * 2 + j): the playing clip and its clock, one-shot clips (attack, roar) with cooldowns,
// and a lunge (direction, weight) during an attack. Clips are looked up by name; a model without one keeps its default.
const MV = { hit: new Uint8Array(NCUS * 2), clip: new Int16Array(NCUS * 2).fill(-1), t: new Float64Array(NCUS * 2), once: new Uint8Array(NCUS * 2), cd: new Float64Array(NCUS * 2),
  roar: new Float64Array(NCUS * 2), yaw: new Float64Array(NCUS * 2), lv: new Float64Array(NCUS * 6), lw: new Float64Array(NCUS * 2) };
let FDT = 0.016; // this frame's step (frame() sets it)
const clipOf = (m, name) => { const S = CUSTOM[m].skin; if (!S) return -1; const c = S.byName || (S.byName = {}); if (!(name in c)) c[name] = S.anims.findIndex((a) => a.name.toLowerCase() === name); return c[name]; };
function moverPose(ix, m, k, yaw, spd, g, x, y, z) {
  const dt = FDT, S = CUSTOM[m].skin;
  let dy = yaw - MV.yaw[ix]; dy -= Math.round(dy / TAU) * TAU; const turn = abs(dy) / max(dt, 1e-3); MV.yaw[ix] = yaw;
  MV.cd[ix] -= dt; MV.roar[ix] -= dt;
  const play = (name, once) => { const c = clipOf(m, name); if (c < 0 || (MV.once[ix] && c !== MV.clip[ix])) return false; if (c !== MV.clip[ix]) { MV.clip[ix] = c; MV.t[ix] = 0; MV.once[ix] = once ? 1 : 0; } return true; };
  // a one-shot clip runs to its end first
  if (MV.once[ix]) { const A = S.anims[MV.clip[ix]]; if (!A || MV.t[ix] >= A.dur) { MV.once[ix] = 0; MV.lw[ix] = 0; MV.hit[ix] = 0; } }
  if (k === 1) {
    // leviathan: lunges at the diver when its head comes close while stalking, roars now and then, bites when hunting
    const dPl = CREATIVE ? 1e9 : hypot(F[CX] - x, F[CY] - y, F[CZ] - z), st = BST[g];
    let tgt = null;
    if (st === 1 && dPl < 25) tgt = [F[CX], F[CY], F[CZ]];
    else if (st === 3) { const P = huntTarget(g); if (hypot(P[0] - x, P[1] - y, P[2] - z) < 20) tgt = [P[0], P[1], P[2]]; }
    if (tgt && MV.cd[ix] <= 0 && play('attack', true)) {
      MV.cd[ix] = 12; const o = ix * 3, ex = tgt[0] - x, ey = tgt[1] - y, ez = tgt[2] - z, l = hypot(ex, ey, ez) || 1, reach = max(0, min(l - 4, 18));
      MV.lv[o] = ex / l * reach; MV.lv[o + 1] = ey / l * reach; MV.lv[o + 2] = ez / l * reach;
    } else if (st === 1 && dPl < 70 && MV.roar[ix] <= 0 && play('roar', true)) MV.roar[ix] = 18;
    else play(st === 3 ? 'fast' : 'swim', false) || play('swim', false);
    // lunge weight: back during the first quarter of the attack, out to full reach in the middle, home at the end
    if (MV.once[ix] && MV.clip[ix] === clipOf(m, 'attack')) { const u = MV.t[ix] / S.anims[MV.clip[ix]].dur; MV.lw[ix] = u < 0.25 ? -0.15 * sin(u * 4 * PI) : sin((u - 0.25) / 0.75 * PI); }
    // the bite lands on your submarine if the lunge reaches it
    if (MV.lw[ix] > 0.5) { const o = ix * 3, w = MV.lw[ix]; subBite(ix, x + MV.lv[o] * w, y + MV.lv[o + 1] * w, z + MV.lv[o + 2] * w); }
  } else if (k === 0) {
    // creature: a quick turn then fast when fleeing a leviathan or the diver, idle when hovering by the diver
    const dPl = CREATIVE ? 1e9 : hypot(F[CX] - x, F[CZ] - z);
    let flee = dPl < 9 && hash2(g, 0, 77) >= 0.5;
    for (let j = 0; j < nLH && !flee; j++) if (hypot(x - LHEAD[j * 3], z - LHEAD[j * 3 + 2]) < 55) flee = true;
    if (flee) { if (MV.cd[ix] <= 0 && MV.clip[ix] !== clipOf(m, 'fast') && play('turn', true)) MV.cd[ix] = 6; else play('fast', false) || play('swim', false); }
    else if (dPl < 12 && hash2(g, 0, 77) < 0.5) play('idle', false) || play('swim', false);
    else play('swim', false);
  } else if (k === 2) {
    // submarine: cruise, turn while turning, idle when slow
    if (turn > 0.15) play('turn', false) || play('cruise', false); else if (spd > 0.5) play('cruise', false) || play('swim', false); else play('idle', false) || play('cruise', false);
  }
  if (MV.clip[ix] < 0) MV.clip[ix] = CUSTOM[m].clip;
  const rate = k === 2 ? 0.5 + min(spd, 4) / 4 : 1;
  MV.t[ix] += dt * rate;
  return poseAlloc(m, MV.clip[ix], MV.t[ix]);
}
function buildCustom() {
  if (!MODELS.length) return;
  for (const M of MODELS) M.n = 0;
  ciPass = 0; ciEmit();
  let o = 0; for (const M of MODELS) { M.n0 = o; o += M.n; M.n = 0; }
  // shared poses of the skinned models (the clip they play, at four phases)
  jmN = 0;
  for (let mi = 0; mi < CUSTOM.length; mi++) {
    const S = CUSTOM[mi].skin; if (!S) continue;
    MODELS[mi].pb = jmN; const A = S.anims[CUSTOM[mi].clip], d = A ? A.dur : 1;
    for (let v = 0; v < 4; v++) poseAlloc(mi, CUSTOM[mi].clip, F[TIME] + v * 0.27 * d);
  }
  ciPass = 1; nDyn = 0; ciEmit(); nDynMov = nDyn;
  if (jmN) Q.writeBuffer(jmBuf, 0, JMD, 0, jmN * 16);
  nCI = min(o, MAXCI);
  for (const M of MODELS) M.n = max(0, min(M.n, MAXCI - M.n0));
}
function drawCustom(r, pPlain, pSkin) {
  for (const M of MODELS) {
    if (!M.n) continue;
    if (M.sb) { r.setPipeline(pSkin); r.setBindGroup(3, bgJ); r.setVertexBuffer(2, M.sb); } else r.setPipeline(pPlain);
    r.setVertexBuffer(0, M.vb); r.setVertexBuffer(1, ciBuf, M.n0 * 64); r.setIndexBuffer(M.ib, 'uint32');
    for (const gr of M.groups) { if (M.noGlass && gr.glass) continue; r.setBindGroup(2, gr.bg); r.drawIndexed(gr.count, M.n, gr.first, 0, 0); }
  }
}

// wildlife buffers (static per-instance data; the slot centres move through WT)
const LB = lifeBuffers();
const ibFish = buf(LB.fish, BU.VERTEX), ibManta = buf(LB.mantas, BU.VERTEX), ibBubbles = buf(LB.bub, BU.VERTEX), ibSnowB = buf(LB.snow, BU.VERTEX);
const ibTurtle = buf(LB.tur, BU.VERTEX), ibJelly = buf(LB.jel, BU.VERTEX), ibLev = buf(LB.lev, BU.VERTEX), ibSquid = buf(LB.sq, BU.VERTEX);
const nFish = LB.fish.length / 8, nManta = LB.mantas.length / 8, nBub = LB.bub.length / 8, nSnow = LB.snow.length / 4, nTurtle = LB.tur.length / 8, nJelly = LB.jel.length / 8, nLev = LB.lev.length / 8, nSquid = LB.sq.length / 8;

// ---------------------------------------------------------------- one-time bake: rock detail texture
{
  const m = mod(W_DETAIL), p = device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
  const e = device.createCommandEncoder();
  let r = e.beginRenderPass({ colorAttachments: [colorAtt(tDetail.createView({ baseMipLevel: 0, mipLevelCount: 1 }), true)] });
  r.setPipeline(p); r.draw(3); r.end();
  for (let i = 1; i <= Math.log2(DTX); i++) {
    r = e.beginRenderPass({ colorAttachments: [colorAtt(tDetail.createView({ baseMipLevel: i, mipLevelCount: 1 }), true)] });
    r.setPipeline(pMip8); r.setBindGroup(0, blitBG(tDetail.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }))); r.draw(3); r.end();
  }
  Q.submit([e.finish()]);
}

// ---------------------------------------------------------------- render targets (rebuilt on resize)
// The scene is drawn at `pix` pixels and scaled up to the window. frame() tunes `pix` and the draw distance scale
// `det` for the tier's frame-time target; both start where the last visit left them.
const DETMIN = 0.45;
let W = 0, H = 0, DW = 0, DH = 0, pix = SAVE.pix || TQ.pixMax, det = SAVE.det || 1, PIXTOP = 0, PIXBOT = 0;
// Upscaling: 'auto' (on for tile-based mobile GPUs and whenever the scene renders below the display resolution),
// 'off' (the browser stretches the canvas), 'smooth' or 'sharp'. OW x OH is the display-side output, capped on mobile
// (4.5 MP: a 2960x1848 Mali tablet outputs at ~2690x1680) so the upscale pass itself stays cheap.
// Upscaler: 'auto' (FSR 1 at the scale the frame-time tuner picks), 'native' (no upscaling), or a fixed FSR 1 mode:
// 'q' Quality 1.5x, 'b' Balanced 1.7x, 'p' Performance 2x per axis. With a fixed mode the tuner only moves the draw
// distance. SHP: RCAS sharpening strength. Old saves ('off' / 'smooth' / 'sharp') map onto these.
const UPR = { q: 1.5, b: 1.7, p: 2 };
let UPS = { off: 'native', smooth: 'auto', sharp: 'auto' }[SAVE.ups] || SAVE.ups || 'auto', UPON = false, OW = 0, OH = 0, vLdr = null;
if (UPS !== 'auto' && UPS !== 'native' && !UPR[UPS]) UPS = 'auto';
let SHP = SAVE.shp ?? (SAVE.ups === 'smooth' ? 0.4 : SAVE.ups === 'sharp' ? 1 : 0.75);
// target frame rate: 0 = Auto (60 on phones and tablets, the display's rate on desktops), else a cap in fps
let TFPS = +SAVE.tfps || 0, nextT = 0;
// Present chain, used when upscaling or frame generation is on: the composite goes into an internal-resolution LDR
// target (vLdr); a generated frame reprojects it into a second one; FSR EASU scales either to OW x OH and RCAS
// sharpens into the swap chain. Without upscaling RCAS runs 1:1 at strength 0 (a copy).
// Frame generation (FG): every other display frame is generated instead of rendered (genOK once a frame exists).
let FG = !!SAVE.fg, PRES = false, genOK = false, genNext = false, fgN = 0;
let passEasu, passRcas, passGen, bgEasu = [], bgRcas = [], bgGen = null;
const LP = new Float64Array(12); // pose of the last rendered frame: r, u, f, camera x y z
let dynN = 0, dynT = 0, dynG = 0, dynGN = 0, dynBad = 0, dynOk = 0, dynWait = 3, dynMin = 1e9, period = 16.7;
let passScene, passRays, passBlur, bgBlur, passPost, bgRays, bgPost, passShadow, bloomPass = [], bloomBG = [], targets = [];
const NB = 6;
function resize(force) {
  DW = max(2, round(canvas.clientWidth * devicePixelRatio)); DH = max(2, round(canvas.clientHeight * devicePixelRatio));
  // the tier caps the internal resolution: a fraction of native and a hard pixel ceiling (TBDR bandwidth)
  const nat = DW * DH, smax = TQ.scale[1], smin = TQ.scale[0];
  const oc = min(1, sqrt((TQ.tbdr ? 4.5e6 : 8.3e6) / nat)), ow = round(DW * oc), oh = round(DH * oc);
  const fixed = UPS === 'native' ? oc : UPR[UPS] ? oc / UPR[UPS] : 0;
  if (fixed) PIXTOP = PIXBOT = nat * fixed * fixed;
  else { PIXTOP = min(TQ.pixMax, nat * smax * smax); PIXBOT = min(PIXTOP, max(2e5, nat * smin * smin * 0.55)); }
  pix = clamp(pix, PIXBOT, PIXTOP);
  const s = fixed || min(smax, sqrt(pix / nat));
  const w = max(2, round(DW * s) & ~1), h = max(2, round(DH * s) & ~1);
  const on = UPS !== 'native' && (UPS !== 'auto' || TQ.tbdr || w < DW * 0.97) && w < ow * 0.97;
  if (w === W && h === H && on === UPON && ow === OW && oh === OH && !force) return;
  dynN = dynG = dynGN = 0; dynT = -300; // let the new size settle before measuring again
  W = w; H = h; UPON = on; OW = ow; OH = oh; PRES = on || FG; genOK = false;
  canvas.width = UPON ? OW : W; canvas.height = UPON ? OH : H;
  ctx.configure({ device, format: FMT, alphaMode: 'opaque' });
  for (const t of targets) t.destroy();
  const tMS = tex(AA > 1 ? W : 1, H, HDR, TU.RENDER_ATTACHMENT, { samples: AA }), tDp = tex(W, H, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { samples: AA });
  const RW = max(1, ceil(W / RAYDIV)), RH = max(1, ceil(H / RAYDIV));
  const tRes = tex(W, H, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING), tRay = tex(RW, RH, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING), tRay2 = tex(RW, RH, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
  targets = [tMS, tDp, tRes, tRay, tRay2];
  const bl = [];
  for (let i = 0; i < NB; i++) { const t = tex(max(1, W >> (i + 1)), max(1, H >> (i + 1)), HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING); bl.push(t); targets.push(t); }
  const vDp = tDp.createView(), vRes = tRes.createView(), vRay = tRay.createView(), vRay2 = tRay2.createView(), vBl = bl.map((t) => t.createView());
  // without anti-aliasing the scene goes straight into the resolve target, and tMS is one unused column
  passScene = { colorAttachments: [{ view: AA > 1 ? tMS.createView() : vRes, resolveTarget: AA > 1 ? vRes : undefined, loadOp: 'clear', storeOp: AA > 1 ? 'discard' : 'store', clearValue: [0, 0, 0, 1] }],
    depthStencilAttachment: { view: vDp, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } };
  passRays = { colorAttachments: [colorAtt(vRay, true)] };
  passBlur = { colorAttachments: [colorAtt(vRay2, true)] };
  bgBlur = device.createBindGroup({ layout: pRB.getBindGroupLayout(0), entries: [{ binding: 0, resource: vRay }] });
  passPost = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] };
  if (PRES) {
    const RT = TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, tLdr = tex(W, H, FMT, RT); targets.push(tLdr); vLdr = tLdr.createView();
    const srcs = [vLdr];
    if (FG) {
      const tGen = tex(W, H, FMT, RT); targets.push(tGen); srcs.push(tGen.createView());
      passGen = { colorAttachments: [colorAtt(srcs[1], true)] };
      bgGen = device.createBindGroup({ layout: pGen.getBindGroupLayout(0), entries: [{ binding: 0, resource: vLdr }, { binding: 1, resource: sClamp }, { binding: 2, resource: vDp }, { binding: 3, resource: { buffer: genBuf } }] });
    }
    const rbg = (v) => device.createBindGroup({ layout: pRcas.getBindGroupLayout(0), entries: [{ binding: 0, resource: v }, { binding: 1, resource: { buffer: rcasBuf } }] });
    if (UPON) {
      const tE = tex(OW, OH, FMT, RT); targets.push(tE); const vE = tE.createView();
      passEasu = { colorAttachments: [colorAtt(vE, true)] };
      bgEasu = srcs.map((v) => device.createBindGroup({ layout: pEasu.getBindGroupLayout(0), entries: [{ binding: 0, resource: v }, { binding: 1, resource: { buffer: easuBuf } }] }));
      bgRcas = [rbg(vE), rbg(vE)];
      easuU[0] = W; easuU[1] = H; easuU[2] = OW; easuU[3] = OH; Q.writeBuffer(easuBuf, 0, easuU);
    } else bgRcas = srcs.map(rbg);
    passRcas = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] };
    rcasU[0] = UPON ? SHP : 0; Q.writeBuffer(rcasBuf, 0, rcasU);
  }
  bgRays = device.createBindGroup({ layout: pRays.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: sRep }, { binding: 2, resource: sCmp },
    { binding: 3, resource: tShadow.createView() }, { binding: 4, resource: tWater.createView() }, { binding: 5, resource: vDp }] });
  bgPost = device.createBindGroup({ layout: pPost.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: sClamp }, { binding: 2, resource: vRes },
    { binding: 3, resource: vRay2 }, { binding: 4, resource: vBl[0] }, { binding: 5, resource: vDp }] });
  bloomPass = []; bloomBG = [];
  // down: res -> b0 -> ... -> b5 ; up: b5 -> b4 (additive) ... -> b0
  for (let i = 0; i < NB; i++) { bloomPass.push({ colorAttachments: [colorAtt(vBl[i], true)] }); bloomBG.push(blitBG(i ? vBl[i - 1] : vRes)); }
  for (let i = NB - 1; i > 0; i--) { bloomPass.push({ colorAttachments: [colorAtt(vBl[i - 1], false)] }); bloomBG.push(blitBG(vBl[i])); }
  UB[52] = W; UB[53] = H; UB[54] = 1 / W; UB[55] = 1 / H;
}
passShadow = { colorAttachments: [], depthStencilAttachment: { view: tShadow.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } };
resize();
addEventListener('resize', resize);

// ---------------------------------------------------------------- timing (GPU timestamp queries)
let qs, qResolve, qRead = [], tsBegin, tsEnd;
if (hasTS) {
  qs = device.createQuerySet({ type: 'timestamp', count: 2 });
  qResolve = device.createBuffer({ size: 16, usage: BU.QUERY_RESOLVE | BU.COPY_SRC });
  for (let i = 0; i < 6; i++) {
    const b = device.createBuffer({ size: 16, usage: BU.MAP_READ | BU.COPY_DST });
    const o = { b, busy: false, done: null };
    o.done = () => {
      const a = new BigInt64Array(b.getMappedRange());
      const ms = Number(a[1] - a[0]) / 1e6; F[GPU] = ms; b.unmap(); o.busy = false;
      if (dynT > 0 && ms > 0 && ms < 1e3) { dynG += ms; dynGN++; }
    };
    qRead.push(o);
  }
  tsBegin = { querySet: qs, beginningOfPassWriteIndex: 0 }; tsEnd = { querySet: qs, endOfPassWriteIndex: 1 };
}

// ---------------------------------------------------------------- per-frame float state (no heap numbers in the loop)
const F = new Float64Array(32);
const CX = 0, CY = 1, CZ = 2, YAW = 3, PIT = 4, FX = 5, FY = 6, FZ = 7, RX = 8, RZ = 9, UX = 10, UY = 11, UZ = 12, VX = 13, VY = 14, VZ = 15, TIME = 16, LAST = 18, GPU = 19, HUDT = 20, MX = 22, MY = 23, MZ = 24, ZONE = 25;
// biome weights at the camera: kelp, grotto, trench, plains, reef, crystal, volcanic (audio + HUD + fog colour)
const BIO = new Float64Array(7);
const WORLD_MAX = 8e6; // the anchored noise stays exact in i32 lattice coordinates well past this

// ---------------------------------------------------------------- streaming: clipmap levels, population tiles, shadow box
const LO = new Float64Array(CML * 2).fill(NaN), HV = new Uint8Array(CML);
const slotTX = new Int32Array(NTILE).fill(0x7fffffff), slotTZ = new Int32Array(NTILE).fill(0x7fffffff), slotOK = new Uint8Array(NTILE);
// ring offsets ordered nearest first, so the tiles around the swimmer populate before the far ones
const HALF = (NT - 1) / 2, ORD = new Int32Array(NTILE * 2);
{
  const o = [];
  for (let z = -HALF; z <= HALF; z++) for (let x = -HALF; x <= HALF; x++) o.push([x, z]);
  o.sort((a, b) => a[0] * a[0] + a[1] * a[1] - b[0] * b[0] - b[1] * b[1]);
  o.forEach((v, i) => { ORD[i * 2] = v[0]; ORD[i * 2 + 1] = v[1]; });
}
let nClip = 0, nPop = 0, popMax = TQ.popMax, popPending = false, shadowNow = false, tilesOK = 0, clipCount = 0;
CLU[0] = PUU[0] = WSEED >>> 0; CLU[2] = CM; PUU[2] = TQ.capT; PUU[3] = LV > 1 ? 1 : 0;
PUF[4] = TQ.rockFar; PUF[5] = TQ.smallFar; PUF[6] = TQ.propFar;
const imod = (a, n) => ((a % n) + n) % n;
function stream() {
  const cx = F[CX], cz = F[CZ];
  // clipmap: level l has spacing 2^l m and snaps its centre to 2 * spacing
  nClip = 0;
  for (let l = 0; l < CML; l++) {
    const s = 1 << l, ox = floor(cx / (2 * s)) * 2 * s, oz = floor(cz / (2 * s)) * 2 * s, x0 = ox - CM / 2 * s, z0 = oz - CM / 2 * s;
    if (ox !== LO[l * 2] || oz !== LO[l * 2 + 1]) {
      LO[l * 2] = ox; LO[l * 2 + 1] = oz;
      const ax = floor(x0 / 1024), az = floor(z0 / 1024), j = 4 + nClip * 4, k = 36 + nClip * 4;
      CLI[j] = l; CLI[j + 1] = ax; CLI[j + 2] = az; CLI[j + 3] = 0;
      CLF[k] = x0 - ax * 1024; CLF[k + 1] = z0 - az * 1024; CLF[k + 2] = s; CLF[k + 3] = 0;
      nClip++; clipCount++;
    }
    LVD[l * 4] = x0 - cx; LVD[l * 4 + 1] = z0 - cz; LVD[l * 4 + 2] = s; LVD[l * 4 + 3] = l;
    if (l) HV[l] = (LO[l * 2 - 2] - ox) / s + 2 * ((LO[l * 2 - 1] - oz) / s);
  }
  CLU[1] = nClip;
  // population ring: NT x NT tiles of 32 m; a slot whose tile changed is rebuilt, nearest first, popMax per frame
  const tx0 = floor(cx / TILE), tz0 = floor(cz / TILE);
  nPop = 0;
  for (let k = 0; k < NTILE; k++) {
    const tx = tx0 + ORD[k * 2], tz = tz0 + ORD[k * 2 + 1], slot = imod(tx, NT) + NT * imod(tz, NT);
    if (slotTX[slot] === tx && slotTZ[slot] === tz) continue;
    slotOK[slot] = 0;
    if (nPop >= popMax) continue;
    const j = 8 + nPop * 4;
    PUI[j] = slot; PUI[j + 1] = tx; PUI[j + 2] = tz; PUI[j + 3] = 0;
    slotTX[slot] = tx; slotTZ[slot] = tz; slotOK[slot] = 1; nPop++;
  }
  PUU[1] = nPop;
  tilesOK = 0;
  for (let s = 0; s < NTILE; s++) {
    TILED[s * 4] = slotTX[s] * TILE - cx; TILED[s * 4 + 1] = slotTZ[s] * TILE - cz; TILED[s * 4 + 2] = slotOK[s]; TILED[s * 4 + 3] = 0;
    tilesOK += slotOK[s];
  }
  // shadow map: re-rendered when the swimmer leaves the middle of the box, and once more when population settles
  shadowNow = false;
  if (abs(cx - SHC[0]) > SHR * 0.2 || abs(cz - SHC[1]) > SHR * 0.2) { SHC[0] = round(cx / 8) * 8; SHC[1] = round(cz / 8) * 8; shadowNow = true; }
  if (nPop) popPending = true; else if (popPending) { popPending = false; shadowNow = true; }
  // the shadow matrix maps render space: translate by (camera - box centre)
  const dx = cx - SHC[0], dz = cz - SHC[1];
  for (let i = 0; i < 16; i++) UB[16 + i] = SM[i];
  for (let r = 0; r < 4; r++) UB[28 + r] = SM[12 + r] + SM[r] * dx + SM[8 + r] * dz;
  for (let i = 0; i < 16; i++) UBS[i] = UBS[16 + i] = UB[16 + i];
}

// ---------------------------------------------------------------- frame
// fpsMode: 0 off, 1 the small counter, 2 the full stats overlay (also toggled by H, or by tapping the counter)
let fpsMode = SAVE.fps === undefined ? 1 : +SAVE.fps, hud = fpsMode === 2, frameNo = 0, cntBusy = false, fpN = 0, fpT = 0, fpW = 0;
const fpEl = $('fp');
let kf = 0, kb = 0, kl = 0, kr = 0, ku = 0, kd = 0, ks = 0, kt = 0, mdx = 0, mdy = 0, lkx = 0, lky = 0, l2x = 0, l2y = 0, hN = 0, hMax = 0, hMin = 1e9, hPer = 1e9, hLate = 0, hTot = 0, tId = -1, tN = 0, tx0 = 0, ty0 = 0, tx = 0, ty = 0;
const TANH = 0.6, NEAR = 0.1, EXPO = 0.62, RAYS = 0.54;
const submitList = [null];
const MAXFAR = max0(TQ.kd[2], TQ.rockFar, TQ.propFar);
const FOGS = min(1, sqrt(240 / TQ.fogFar)); // optical distance scale (see fog() in shaders.js)
function drawLevels(r, maxR) {
  for (let l = 0; l < CML; l++) {
    if (l && (CM / 4) * (1 << l) > maxR) break; // the whole ring lies past the draw distance
    if (l === 0) r.drawIndexed(QF * 6, 1, 0, 0, 0); else r.drawIndexed(QR * 6, 1, RING0[HV[l]], 0, l);
  }
}
function drawLandmarks(r) {
  for (let i = 0; i < nRun; i++) { const m = meshes[LMRUN[i * 3]]; r.drawIndexed(m.ib.length, LMRUN[i * 3 + 2], m.i0, m.v0, LMRUN[i * 3 + 1]); }
}
function render() {
  // camera basis (right vector is horizontal); the view matrix has no x / z translation: render space is camera-relative
  const cy = F[CY], pitch = F[PIT], yaw = F[YAW];
  const cp = cos(pitch), fy = sin(pitch), rx = cos(yaw), rz = sin(yaw), fx = cp * rz, fz = -cp * rx;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  F[FX] = fx; F[FY] = fy; F[FZ] = fz; F[RX] = rx; F[RZ] = rz; F[UX] = ux; F[UY] = uy; F[UZ] = uz;
  const asp = W / H, sx = 1 / (TANH * asp), sy = 1 / TANH, m = UB;
  m[0] = rx * sx; m[4] = 0; m[8] = rz * sx; m[12] = 0;
  m[1] = ux * sy; m[5] = uy * sy; m[9] = uz * sy; m[13] = -uy * cy * sy;
  m[2] = 0; m[6] = 0; m[10] = 0; m[14] = NEAR;
  m[3] = fx; m[7] = fy; m[11] = fz; m[15] = -fy * cy;
  m[32] = 0; m[33] = cy; m[34] = 0; m[35] = F[TIME];
  m[36] = rx; m[37] = 0; m[38] = rz; m[39] = TANH * asp;
  m[40] = ux; m[41] = uy; m[42] = uz; m[43] = TANH;
  m[44] = fx; m[45] = fy; m[46] = fz; m[47] = NEAR;
  m[51] = F[ZONE];
  let ek = (-cy - 8) / 26; ek = ek < 0 ? 0 : ek > 1 ? 1 : ek;
  m[56] = EXPO * (0.6 + 0.4 * ek) * (1 + 0.9 * sstep(60, 260, -cy)); m[57] = RAYS; m[58] = det; m[59] = CREATIVE ? 1 : 0; subUniforms(m); // the eye adapts in the deep; mis.w: creative; fog.zw: sub lights, cabin
  const cx = F[CX], cz = F[CZ];
  m[60] = cx - floor(cx / 1024) * 1024; m[61] = cz - floor(cz / 1024) * 1024; m[62] = cx - floor(cx / 44) * 44; m[63] = cz - floor(cz / 44) * 44;
  m[64] = TQ.fogFar; m[65] = FOGS;
  // water colour + murk of the biomes around the camera
  let wr = 0, wg = 0, wb = 0, wm = 0, ws = 0;
  for (let i = 0; i < 7; i++) { const w = BIO[i], o = i * 4; wr += w * WATER_C[o]; wg += w * WATER_C[o + 1]; wb += w * WATER_C[o + 2]; wm += w * WATER_C[o + 3]; ws += w; }
  ws = ws || 1; m[68] = wr / ws; m[69] = wg / ws; m[70] = wb / ws; m[71] = wm / ws;
  for (let i = 32; i < 84; i++) if (i !== 52 && i !== 58) UBS[i] = UB[i];
  // frustum planes in render space, from the rows of the view-projection (reversed, infinite depth: no far plane)
  for (let p = 0; p < 5; p++) {
    const a = p >> 1, sg = p & 1 ? -1 : 1, o = p * 4;
    let x, y, z, w;
    if (p < 4) { x = m[3] + sg * m[a]; y = m[7] + sg * m[4 + a]; z = m[11] + sg * m[8 + a]; w = m[15] + sg * m[12 + a]; }
    else { x = m[3] - m[2]; y = m[7] - m[6]; z = m[11] - m[10]; w = m[15] - m[14]; }
    const l = sqrt(x * x + y * y + z * z) || 1;
    CUD[o] = x / l; CUD[o + 1] = y / l; CUD[o + 2] = z / l; CUD[o + 3] = w / l;
  }
  CUD[20] = 0; CUD[21] = 0; CUD[22] = 0; CUD[23] = 1;
  CUD[24] = 0; CUD[25] = cy; CUD[26] = 0; CUD[27] = det;
  CUD[28] = TQ.kd[0] * det; CUD[29] = TQ.kd[1] * det; CUD[30] = TQ.kd[2] * det; CUD[31] = TQ.tuftFar * det;
  CUD[32] = TQ.rockNear * det; CUD[33] = TQ.coralLod; CUD[34] = MAXFAR * det; CUD[35] = TQ.glintFar * det;
  CUD[36] = SHC[0] - cx; CUD[37] = SHC[1] - cz; CUD[38] = SHR; CUD[39] = shadowNow ? 1 : 0;
  Q.writeBuffer(ubo, 0, UB);
  if (shadowNow) Q.writeBuffer(uboS, 0, UBS);
  WTU[0] = F[TIME]; Q.writeBuffer(uboW, 0, WTU);
  Q.writeBuffer(lvBuf, 0, LVD); Q.writeBuffer(wtBuf, 0, WTD);
  Q.writeBuffer(cullU, 0, CUD); Q.writeBuffer(tileBuf, 0, TILED);
  Q.writeBuffer(argBuf, 0, ARGT); Q.writeBuffer(cntBuf, 0, ZERO);
  if (nClip) Q.writeBuffer(clipU, 0, CLB);
  if (nPop) Q.writeBuffer(popU, 0, PUB);
  if (nLM) Q.writeBuffer(lmBuf, 0, LMD, 0, nLM * 16);
  buildCustom();
  if (nCI) Q.writeBuffer(ciBuf, 0, CI, 0, nCI * 16);

  const e = device.createCommandEncoder();
  let slot = null;
  if (hasTS) { for (let i = 0; i < qRead.length; i++) if (!qRead[i].busy) { slot = qRead[i]; break; } }
  // compute: clipmap -> population -> visibility
  const c = e.beginComputePass(slot ? { timestampWrites: tsBegin } : undefined);
  if (nClip) { c.setPipeline(pClip); c.setBindGroup(0, bgClip); c.dispatchWorkgroups(ceil(GN / 8), ceil(GN / 8), nClip); }
  if (nPop) { c.setPipeline(pPop); c.setBindGroup(0, bgPop); c.dispatchWorkgroups(ceil(PER / 64), nPop); }
  c.setPipeline(pCull); c.setBindGroup(0, bgCull); c.dispatchWorkgroups(NTILE);
  c.end();
  const readCnt = hud && !cntBusy && (frameNo % 15 === 0);
  if (readCnt) e.copyBufferToBuffer(cntBuf, 0, cntRead, 0, NLIST * 4);
  passPost.timestampWrites = slot ? tsEnd : undefined;
  // animated water texture + mips
  let r = e.beginRenderPass(waterPass[0]); r.setPipeline(pWater); r.setBindGroup(0, bgWater); r.draw(3); r.end();
  for (let i = 1; i < 5; i++) { r = e.beginRenderPass(waterPass[i]); r.setPipeline(pMip16); r.setBindGroup(0, waterBG[i - 1]); r.draw(3); r.end(); }
  // shadow map (sun's view of the box around SHC)
  if (shadowNow) {
    r = e.beginRenderPass(passShadow);
    r.setBindGroup(0, bg0s); r.setBindGroup(1, bg1);
    r.setPipeline(pTerrSh); r.setIndexBuffer(ibGrid, 'uint32'); drawLevels(r, SHR * 1.5);
    if (nLM) { r.setPipeline(pSolidSh); r.setVertexBuffer(0, vbMesh); r.setVertexBuffer(1, lmBuf); r.setIndexBuffer(ibMesh, 'uint32'); drawLandmarks(r); }
    r.setPipeline(pKSh); r.drawIndirect(argBuf, 4 * 32);
    if (nCI) drawCustom(r, pCustSh, pCustShS);
    r.end();
  }
  // scene
  r = e.beginRenderPass(passScene);
  r.setBindGroup(0, bg0); r.setBindGroup(1, bg1);
  r.setPipeline(pTerr); r.setIndexBuffer(ibGrid, 'uint32'); drawLevels(r, TQ.fogFar);
  r.setPipeline(pSolid); r.setVertexBuffer(0, vbMesh); r.setIndexBuffer(ibMesh, 'uint32');
  if (nLM) { r.setVertexBuffer(1, lmBuf); drawLandmarks(r); }
  for (let k = 0; k < NK; k++) { r.setVertexBuffer(1, svBuf, k * SCAP * 64, SCAP * 64); r.drawIndexedIndirect(argBuf, (6 + k) * 32); }
  r.setPipeline(pManta); r.setVertexBuffer(1, ibManta); r.drawIndexed(MANTA.ib.length, nManta, MANTA.i0, MANTA.v0, 0);
  r.setPipeline(pFish); r.setVertexBuffer(1, ibFish); r.drawIndexed(FISH.ib.length, nFish, FISH.i0, FISH.v0, 0);
  if (nCI) { drawCustom(r, pCust, pCustS); r.setIndexBuffer(ibMesh, 'uint32'); r.setVertexBuffer(0, vbMesh); }
  if (nTurtle) { r.setPipeline(pTurtle); r.setVertexBuffer(1, ibTurtle); r.drawIndexed(TURTLE.ib.length, nTurtle, TURTLE.i0, TURTLE.v0, 0); }
  if (nLev) { r.setPipeline(pLev); r.setVertexBuffer(1, ibLev); r.drawIndexed(LEVI.ib.length, nLev, LEVI.i0, LEVI.v0, 0); }
  if (nSquid) { r.setPipeline(pSquid); r.setVertexBuffer(1, ibSquid); r.drawIndexed(SQUID.ib.length, nSquid, SQUID.i0, SQUID.v0, 0); }
  // kelp: 9-row blades up close, 5 rows mid-range, every 2nd blade (wider) with 3 rows far away; then ground cover
  r.setPipeline(pKN); r.drawIndirect(argBuf, 0);
  r.setPipeline(pKM); r.drawIndirect(argBuf, 32);
  r.setPipeline(pKF); r.drawIndirect(argBuf, 64);
  r.setPipeline(pTu); r.drawIndirect(argBuf, 5 * 32);
  r.setPipeline(pSurf); r.draw(4);
  r.setPipeline(pBack); r.draw(4);
  r.setPipeline(pBub); r.setVertexBuffer(0, ibBubbles); r.draw(4, nBub);
  if (nJelly) { r.setPipeline(pJelly); r.setVertexBuffer(0, vbMesh); r.setVertexBuffer(1, ibJelly); r.setIndexBuffer(ibMesh, 'uint32'); r.drawIndexed(JELLY.ib.length, nJelly, JELLY.i0, JELLY.v0, 0); }
  r.setPipeline(pGl); r.drawIndirect(argBuf, 3 * 32);
  r.setPipeline(pSnow); r.setVertexBuffer(0, ibSnowB); r.draw(4, nSnow);
  r.end();
  // light shafts
  r = e.beginRenderPass(passRays); r.setPipeline(pRays); r.setBindGroup(0, bgRays); r.draw(3); r.end();
  r = e.beginRenderPass(passBlur); r.setPipeline(pRB); r.setBindGroup(0, bgBlur); r.draw(3); r.end();
  // bloom
  for (let i = 0; i < bloomPass.length; i++) {
    r = e.beginRenderPass(bloomPass[i]); r.setPipeline(i === 0 ? pDown0 : i < NB ? pDown : pUp); r.setBindGroup(0, bloomBG[i]); r.draw(3); r.end();
  }
  // composite
  const swap = ctx.getCurrentTexture().createView();
  passPost.colorAttachments[0].view = PRES ? vLdr : swap;
  if (PRES) { passRcas.timestampWrites = passPost.timestampWrites; passPost.timestampWrites = undefined; }
  r = e.beginRenderPass(passPost); r.setPipeline(pPost); r.setBindGroup(0, bgPost); r.draw(3); r.end();
  if (PRES) present(e, 0, swap);
  // pose of this frame, for the generated frame after it
  LP[0] = F[RX]; LP[1] = 0; LP[2] = F[RZ]; LP[3] = F[UX]; LP[4] = F[UY]; LP[5] = F[UZ]; LP[6] = F[FX]; LP[7] = F[FY]; LP[8] = F[FZ];
  LP[9] = F[CX]; LP[10] = F[CY]; LP[11] = F[CZ]; genOK = FG && PRES;
  if (slot) { e.resolveQuerySet(qs, 0, 2, qResolve, 0); e.copyBufferToBuffer(qResolve, 0, slot.b, 0, 16); }
  submitList[0] = e.finish();
  Q.submit(submitList);
  if (slot) { slot.busy = true; slot.b.mapAsync(GPUMapMode.READ).then(slot.done); }
  if (readCnt) { cntBusy = true; cntRead.mapAsync(GPUMapMode.READ).then(() => { CNTR.set(new Uint32Array(cntRead.getMappedRange(), 0, NLIST)); cntRead.unmap(); cntBusy = false; }); }
  frameNo++;
}

// FSR: EASU (when upscaling) then RCAS into the swap chain, from the rendered (0) or the generated (1) frame
function present(e, k, swap) {
  let r;
  if (UPON) { r = e.beginRenderPass(passEasu); r.setPipeline(pEasu); r.setBindGroup(0, bgEasu[k]); r.draw(3); r.end(); }
  passRcas.colorAttachments[0].view = swap;
  r = e.beginRenderPass(passRcas); r.setPipeline(pRcas); r.setBindGroup(0, bgRcas[k]); r.draw(3); r.end();
  passRcas.timestampWrites = undefined;
}
// a generated frame: the last rendered one seen from the current camera
function genFrame() {
  const cp = cos(F[PIT]), fy = sin(F[PIT]), rx = cos(F[YAW]), rz = sin(F[YAW]), fx = cp * rz, fz = -cp * rx;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy, G = GENU;
  for (let i = 0; i < 3; i++) { G[i] = LP[i]; G[4 + i] = LP[3 + i]; G[8 + i] = LP[6 + i]; }
  G[3] = TANH * W / H; G[7] = TANH; G[11] = NEAR;
  G[12] = rx; G[13] = 0; G[14] = rz; G[15] = W; G[16] = ux; G[17] = uy; G[18] = uz; G[19] = H; G[20] = fx; G[21] = fy; G[22] = fz;
  G[24] = F[CX] - LP[9]; G[25] = F[CY] - LP[10]; G[26] = F[CZ] - LP[11];
  Q.writeBuffer(genBuf, 0, G);
  const e = device.createCommandEncoder();
  const r = e.beginRenderPass(passGen); r.setPipeline(pGen); r.setBindGroup(0, bgGen); r.draw(3); r.end();
  present(e, 1, ctx.getCurrentTexture().createView());
  Q.submit([e.finish()]);
}

// Moves the camera by F[MX..MZ] in steps shorter than its radius (so it can't pass through thin rock), pushing it
// back out along the scene SDF's gradient after each step and dropping the velocity into the rock, so it slides.
function collide() {
  const n = floor(sqrt(F[MX] * F[MX] + F[MY] * F[MY] + F[MZ] * F[MZ]) / 0.4) + 1;
  for (let i = 0; i < n; i++) {
    F[CX] += F[MX] / n; F[CY] += F[MY] / n; F[CZ] += F[MZ] / n;
    for (let k = 0; k < 3; k++) {
      const s = CR - sdScene(F[CX], F[CY], F[CZ]);
      if (s <= 0) break;
      const gx = GR[0], gy = GR[1], gz = GR[2];
      F[CX] += gx * s; F[CY] += gy * s; F[CZ] += gz * s;
      const vn = F[VX] * gx + F[VY] * gy + F[VZ] * gz;
      if (vn < 0) { F[VX] -= gx * vn; F[VY] -= gy * vn; F[VZ] -= gz * vn; }
    }
  }
}
const CR = 0.5;

// frame-time target: phones and tablets hold 60 fps with headroom (thermals); desktops follow the display, up to 165 Hz
const target = () => (TFPS ? 850 / TFPS : TQ.tbdr ? 11.7 : clamp(period * 0.8, 4.6, 13.6)) * (FG ? 1.8 : 1);
function frame(now) {
  requestAnimationFrame(frame);
  // frame cap: skip display refreshes until the next frame is due (2 ms early is close enough)
  if (TFPS) { const iv = 1000 / TFPS; if (now < nextT - 2) return; nextT = now - nextT > iv ? now + iv : nextT + iv; }
  const dtr = now - F[LAST]; F[LAST] = now;
  let dt = dtr / 1000; if (dt > 0.1) dt = 0.1;
  if (dtr > 2 && dtr < dynMin) dynMin = dtr;
  // closed-loop tuner: every second (0.4 s behind the menu) scale the load by k
  if (dtr < 1e3 && (dynT += dtr) > 0 && (dynN++, dynT > (menu ? 400 : 1000))) {
    period = clamp(dynMin, 5.9, 16.8); dynMin = 1e9;
    const a = dynT / dynN, g = dynGN ? dynG / dynGN : 0, tg = target(), fp = TFPS ? 1000 / TFPS : TQ.tbdr ? 16.7 : period; let k = 1;
    // with GPU timing: keep GPU time within 16 % of the target
    if (g) { if (g > tg * 1.16 || g < tg * 0.84) k = tg / g; }
    // without: slow for two periods in a row means fewer pixels, and twice as long before trying to go back up
    else if (a > fp * 1.06) { dynOk = 0; if (++dynBad > 1) { k = fp * 0.9 / a; dynBad = 0; dynWait = min(dynWait * 2, 60); } }
    else { dynBad = 0; if (++dynOk > dynWait) { k = 1.12; dynOk = 0; } }
    k = k < 0.5 ? 0.5 : k > 1.7 ? 1.7 : k; const mid = max(PIXTOP * 0.6, PIXBOT), was = pix + det;
    // too slow: pixels down to `mid` first, then draw distance, then the remaining pixels; faster goes back the same way
    if (k < 1 ? pix > mid || det <= DETMIN : pix < mid || det >= 1) {
      const end = k < 1 ? (det > DETMIN ? mid : PIXBOT) : det < 1 ? mid : PIXTOP;
      pix *= k; if (k < 1 ? pix < end : pix > end) pix = end;
    } else { det *= sqrt(k); det = det < DETMIN ? DETMIN : det > 1 ? 1 : det; }
    if (was !== pix + det) save({ pix: pix < PIXTOP ? pix | 0 : 0, det });
    dynN = dynT = dynG = dynGN = 0; resize();
  }
  F[TIME] += dt;
  if (!menu || tId >= 0) {
    // touch: holding the finger away from where it went down keeps turning, like a joystick
    if (tId >= 0) {
      const tr = 4 / (innerWidth < innerHeight ? innerWidth : innerHeight); let jx = (tx - tx0) * tr, jy = (ty - ty0) * tr;
      jx = jx > 1 ? 1 : jx < -1 ? -1 : jx; jy = jy > 1 ? 1 : jy < -1 ? -1 : jy;
      lkx += jx * 1.5 * dt; lky += jy * dt;
    }
  }
  {
    // mouse look through two cascaded low-pass stages
    const kq = 1 - exp(-dt * 30); lkx += mdx * 0.0022; lky += mdy * 0.0022; mdx = 0; mdy = 0;
    const ax = lkx * kq, ay = lky * kq; lkx -= ax; lky -= ay; l2x += ax; l2y += ay;
    const dyw = l2x * kq, dpt = l2y * kq; l2x -= dyw; l2y -= dpt;
    const yaw = F[YAW] + dyw; let pitch = F[PIT] - dpt; pitch = pitch < -1.55 ? -1.55 : pitch > 1.55 ? 1.55 : pitch;
    if (SUBM.mode !== 'out') { F[YAW] = yaw; F[PIT] = pitch; subStep(dt); updateLandmarks(); } else { // aboard a submarine: sub.js moves you
    const sp = kt ? 90 : ks || tN > 1 ? 26 : 7, k = 1 - exp(-dt * 4.5), mf = tId >= 0 ? 0.7 : kf - kb, mr = kr - kl, mu = ku - kd, cp = cos(pitch), sy = sin(yaw), cw = cos(yaw);
    const vx = F[VX] + ((sy * cp * mf + cw * mr) * sp - F[VX]) * k, vy = F[VY] + ((sin(pitch) * mf + mu) * sp - F[VY]) * k, vz = F[VZ] + ((-cw * cp * mf + sy * mr) * sp - F[VZ]) * k;
    let x = F[CX] + vx * dt, y = F[CY] + vy * dt, z = F[CZ] + vz * dt;
    x = clamp(x, -WORLD_MAX, WORLD_MAX); z = clamp(z, -WORLD_MAX, WORLD_MAX); y = y < -490 ? -490 : y > -1.2 ? -1.2 : y;
    F[YAW] = yaw; F[PIT] = pitch; F[VX] = vx; F[VY] = vy; F[VZ] = vz;
    updateLandmarks(); // before collide(): it brings the nearby landmark SDFs
    F[MX] = x - F[CX]; F[MY] = y - F[CY]; F[MZ] = z - F[CZ];
    nDyn = nDynMov; levColliders(); netColliders(); // creatures, leviathans and other divers block the way too
    collide();
    }
  }
  // biome under the camera (smoothed): fog / light colour and the soundscape follow it
  bioAt(F[CX], F[CZ]);
  const kz = 1 - exp(-dt * 0.8);
  for (let i = 0; i < 7; i++) BIO[i] += (TB[i + 1] - BIO[i]) * kz;
  F[ZONE] = BIO[1] * BIO[1] * (3 - 2 * BIO[1]);
  FDT = dt;
  // third person: the scene renders from behind and above the diver (F[C*] is the eye until thirdOut)
  const tp = THIRD && PLAYER >= 0 && SUBM.mode === 'out';
  if (tp) thirdIn(dt);
  // frame generation: rendered and generated frames alternate
  // (a jump of more than 20 m renders twice in a row: there is nothing to reproject)
  if (FG && genOK && genNext && (F[CX] - LP[9]) ** 2 + (F[CZ] - LP[11]) ** 2 < 400) { genFrame(); genNext = false; fgN++; }
  else { updateLife(dt); netAfterLife(); stream(); render(); genNext = FG; }
  netTags();
  if (tp) thirdOut();
  playerAnim(dt); subAfter(dt);
  netTick(now, dt);
  // small counter: frames per second over half-second windows, the slowest frame, GPU time when timestamps exist
  fpN++; fpT += dtr; if (dtr > fpW) fpW = dtr;
  if (fpT >= 500) {
    const fps = fpN * 1000 / fpT;
    if (fpsMode === 1) { fpEl.textContent = `${fps.toFixed(0)} FPS${FG ? ` (${((fpN - fgN) * 1000 / fpT).toFixed(0)} rendered)` : ''} · ${(fpT / fpN).toFixed(1)} ms${hasTS && F[GPU] > 0 ? ' · GPU ' + F[GPU].toFixed(1) : ''}`; fpEl.className = fps >= 55 ? '' : fps >= 30 ? 'mid' : 'low'; }
    fpN = 0; fpT = 0; fpW = 0; fgN = 0;
  }
  if (hud) {
    hN++; if (dtr > hMax) hMax = dtr; if (dtr < hMin) hMin = dtr; if (dtr > hPer * 1.5) { hLate++; hTot++; }
    F[HUDT] += dtr / 1000;
    if (F[HUDT] > 0.5) { hudText(); F[HUDT] = 0; hPer = hMin; hN = 0; hMax = 0; hMin = 1e9; hLate = 0; clipCount = 0; }
  }
}
// water in-scatter colour (rgb) and murk (fog density scale) per biome: kelp green-teal, grotto lavender, trench deep
// navy, plain classic blue, reef turquoise and clear, crystal emerald, vents murky ember
const WATER_C = new Float32Array([0.17, 0.62, 0.58, 1.1, 0.58, 0.66, 0.98, 1.0, 0.06, 0.3, 0.86, 1.15, 0.16, 0.58, 0.9, 1.0, 0.2, 0.82, 0.86, 0.72, 0.1, 0.7, 0.5, 0.95, 0.38, 0.22, 0.15, 1.75]);
const BNAMES = ['kelp forest', 'purple grotto', 'trench canyons', 'silt plain', 'coral reef shallows', 'crystal fields', 'volcanic vents'];
let jumpName = '';
function hudText() {
  let b = 0; for (let i = 1; i < 7; i++) if (BIO[i] > BIO[b]) b = i;
  let sol = 0; for (let k = 0; k < NK; k++) sol += min(CNTR[6 + k], SCAP);
  const kn = min(CNTR[0], KCAP[0]), km = min(CNTR[1], KCAP[1]), kfa = min(CNTR[2], KCAP[2]), tu = min(CNTR[5], TQ.tcap);
  const blades = (kn + km) * TQ.B + kfa * TQ.B / 2 + tu * TQ.K;
  info.textContent = `${(hN / F[HUDT]).toFixed(0)} fps · worst ${hMax.toFixed(1)} ms · late ${hLate} (total ${hTot}) · GPU ${hasTS ? F[GPU].toFixed(2) + ' ms' : 'n/a'}
${jumpName ? 'jumped to: ' + jumpName + '\n' : ''}render ${W}×${H} of ${DW}×${DH} (${(W * 100 / DW).toFixed(0)} %)${UPON ? ` → FSR 1 to ${OW}×${OH} (${UPS})` : ''}${TFPS ? ` · cap ${TFPS} fps` : ''}${FG ? ' · frame generation' : ''} · detail ${det.toFixed(2)} · ${TQ.label} · ${AA}x MSAA · rays 1/${RAYDIV}
world X ${F[CX].toFixed(3)}  Y ${F[CY].toFixed(3)}  Z ${F[CZ].toFixed(3)} (f64) · ${BNAMES[b]} · seed ${WSEED}
clipmap ${CML} rings × ${GN}² (${(clipCount * 2).toFixed(0)} level updates/s) · tiles ${tilesOK}/${NTILE} · landmarks + features ${nLM} · ${NTUR} turtles · ${nJelly} jellyfish · ${nSquid} squid · ${nLev} leviathan${nLev > 1 ? 's' : ''}${nStalk ? ' (circling you)' : ''}${nHunt ? ' · leviathan hunting' : ''}${nFlee ? ` · ${nFlee} fleeing` : ''}${nFollow ? ` · ${nFollow} manta${nFollow > 1 ? 's' : ''} with turtles` : ''}${nCI ? ` · ${nCI} model instances` : ''}
visible: kelp ${kn}+${km}+${kfa} cols · ${tu} clumps · ${(blades / 1000).toFixed(0)}k blades · ${sol} solids · ${min(CNTR[3], KCAP[3]) * TQ.G} glints
${GPUNAME}`;
}

// ---------------------------------------------------------------- teleport: keys 1-7 biomes; 8 cycles through the set pieces
// (wreck, whale tail, arch, ruins, skeleton), 9 through the smaller structures (bridge, mushrooms, arch, crystals, chimneys, bommie)
const JUMP_BIG = [1, 2, 3, 10, 11], JUMP_MINOR = [4, 5, 6, 7, 8, 9].concat(STRUCTS.length ? [13] : []);
let jumpBig = 0, jumpMinor = 0;
function place(x, z, lookX, lookZ, lift = 7) {
  F[CX] = x; F[CZ] = z; F[CY] = min(hAt(x, z) + lift, -4);
  F[VX] = F[VY] = F[VZ] = 0;
  if (lookX !== undefined) { F[YAW] = atan2(lookX - x, -(lookZ - z)); F[PIT] = -0.12; }
  lkx = lky = l2x = l2y = 0;
  bioAt(x, z); for (let i = 0; i < 7; i++) BIO[i] = TB[i + 1];
  initLife(); updateLandmarks();
}
// key 0: just ahead of the nearest leviathan on its swim path and a little to the side, looking back at its head,
// so it swims past you (its path is known exactly: same formula as vsLev)
let levTurn = 0;
function toLeviathan() {
  // each press goes to the next one: every imported leviathan in turn, then the nearest built-in one
  const imp = []; for (let s = 0; s < LIFEN[6]; s++) if (CSK[s] === 1) imp.push(s);
  const pick = levTurn++ % (imp.length + (NLEV ? 1 : 0));
  if (pick < imp.length) {
    const s = imp[pick];
    cslot(s);
    const keep = [CUS[s * 4], CUS[s * 4 + 1], CUS[s * 4 + 2], CUS[s * 4 + 3]], a = F[TIME] * CSP[1] + CSP[2];
    const x = keep[0] + CSP[0] * cos(a), y = keep[1], z = keep[2] + CSP[0] * 0.85 * sin(a);
    place(x + 28, z + 28, x, z, 0);
    for (let k = 0; k < 4; k++) CUS[s * 4 + k] = keep[k];
    CUS[s * 4 + 3] = max(CUS[s * 4 + 3], 3);
    F[CY] = clamp(max(y + 4, hAt(F[CX], F[CZ]) + 4), -490, -4); F[PIT] = atan2(y - F[CY], 40);
    jumpName = CUSTOM[CSM[s]].name + ' (leviathan)'; return;
  }
  if (!NLEV) return;
  let best = 0, bd = 1e18;
  for (let i = 0; i < NLEV; i++) { const d = hypot(LEV[i * 4] - F[CX], LEV[i * 4 + 2] - F[CZ]); if (d < bd) { bd = d; best = i; } }
  const cx = LEV[best * 4], cy = LEV[best * 4 + 1], cz = LEV[best * 4 + 2], o = best * 8;
  const R = LB.lev[o + 3], ph = LB.lev[o + 4], w = LB.lev[o + 5], bw = LB.lev[o + 7], sg = w < 0 ? -1 : 1;
  const pos = (a, r) => [cx + r * cos(a), cy + 5 * sin(0.45 * a + bw), cz + r * 0.85 * sin(a)];
  const head = pos(F[TIME] * w + ph, R), cam = pos(F[TIME] * w + ph + sg * 0.6, R + 14);
  place(cam[0], cam[2], head[0], head[2], 0);
  F[CY] = clamp(max(cam[1], hAt(cam[0], cam[2]) + 4), -490, -4); F[PIT] = atan2(head[1] - F[CY], hypot(head[0] - cam[0], head[2] - cam[2]));
  // place() re-seeds the wildlife around the new spot: put this leviathan back on its path
  LEV[best * 4] = cx; LEV[best * 4 + 1] = cy; LEV[best * 4 + 2] = cz; LEV[best * 4 + 3] = 3;
  jumpName = 'leviathan';
}
function jump(n) {
  if (n < 7) { const p = findBiome(n, F[CX], F[CZ]); if (p) place(p[0], p[1]); jumpName = BNAMES[n]; return; }
  const kind = n === 7 ? JUMP_BIG[jumpBig++ % 5] : JUMP_MINOR[jumpMinor++ % JUMP_MINOR.length];
  const L = n === 7 ? findLandmark(kind, F[CX], F[CZ]) : findMinor(kind, F[CX], F[CZ]);
  if (!L) return;
  jumpName = LM_NAMES[kind];
  // stand off at a distance and height that suit the piece; try 16 bearings and keep the first whose sight line
  // clears the seabed (canyon and grotto walls hide a lot)
  let d = L.rad * 1.3 + 10, ty = L.y + (L.k === 1 ? 1 : L.rad * 0.35), lift = 2;
  if (L.k === 4) { d = 34 * L.sc; ty = L.y - 4 * L.sc; lift = 6; } else if (L.k === 5 || L.k === 7 || L.k === 8) { d = 22 + L.rad; ty = L.y + 1.4 * L.sc; lift = 1.8 * L.sc; }
  else if (L.k === 9) { d = 16 + L.rad * 2; ty = L.y; lift = 5; } else if (L.k === 13) { d = L.rad * 1.6 + 6; ty = L.y + L.sc * 0.4; lift = 3; } else if (L.k === 10 || L.k === 11) { d = L.rad * 1.4 + 8; ty = L.y + 2; lift = 9; }
  let bx = 0, bz = 0, by = 0, best = -1e9;
  const a0 = rnd() * TAU;
  for (let k = 0; k < 16; k++) {
    const a = L.k === 4 ? -L.yaw + (k & 1 ? PI / 2 : -PI / 2) + (k >> 1) * 0.12 * (k & 2 ? 1 : -1) : a0 + k / 16 * TAU;
    const x = L.x + cos(a) * d, z = L.z + sin(a) * d, y = min(max(hAt(x, z) + 3, ty + lift), -4);
    let clear = 1e9;
    for (let s = 1; s < 16; s++) { const f = s / 16; clear = min(clear, y + (ty - y) * f - hAt(x + (L.x - x) * f, z + (L.z - z) * f)); }
    if (clear > best) { best = clear; bx = x; bz = z; by = y; }
    if (clear > 2) break;
  }
  place(bx, bz, L.x, L.z, 0);
  F[CY] = by; F[PIT] = atan2(ty - by, d);
}

// ---------------------------------------------------------------- first / third person (V, or the ◐ button)
let THIRD = SAVE.view === 3, tpDist = 3.4;
const TPP = new Float64Array(3); // the diver's position while the camera is elsewhere
function toggleView() { THIRD = !THIRD; save({ view: THIRD ? 3 : 1 }); }
function thirdIn(dt) {
  TPP[0] = F[CX]; TPP[1] = F[CY]; TPP[2] = F[CZ];
  const cp = cos(F[PIT]), fx = cp * sin(F[YAW]), fy = sin(F[PIT]), fz = -cp * cos(F[YAW]);
  // back off along the view until rock is in the way, easing the distance so the camera does not jump
  let d = 0.6; const want = 3.4;
  for (let k = 1; k <= 12; k++) { const t = want * k / 12; if (sdScene(TPP[0] - fx * t, TPP[1] - fy * t + 0.08 * t, TPP[2] - fz * t) < 0.35) break; d = t; }
  tpDist += (d - tpDist) * (d < tpDist ? 1 : 1 - Math.exp(-dt * 3));
  F[CX] = TPP[0] - fx * tpDist; F[CY] = min(TPP[1] - fy * tpDist + 0.08 * tpDist, -0.6); F[CZ] = TPP[2] - fz * tpDist;
  updateLandmarks(); // camera-relative instance positions for the new eye
}
function thirdOut() { F[CX] = TPP[0]; F[CY] = TPP[1]; F[CZ] = TPP[2]; }
// the local diver's swim state: idle when still, swim, fast above 12 m/s; the clip clock runs with the speed
const ME = { t: 0, spd: 0 };
function playerAnim(dt) { ME.spd = hypot(F[VX], F[VY], F[VZ]); ME.t += dt * (ME.spd < 0.8 ? 1 : 0.7 + ME.spd / 14); }
// a diver avatar into the model instance list: body centre just behind and below the eye, head along the view
function avatarPut(x, y, z, yaw, pit, spd, t, hue) {
  if (PLAYER < 0) return;
  const S = CUSTOM[PLAYER].skin, an = S ? S.anims : [], find = (re) => max(0, an.findIndex((a) => re.test(a.name)));
  const clip = spd < 0.8 ? find(/idle/i) : spd < 12 ? find(/swim/i) : find(/fast/i);
  const cp = cos(pit), fx = cp * sin(yaw), fy = sin(pit), fz = -cp * cos(yaw);
  const q = qMul(qAxis(0, 1, 0, PI - yaw), qAxis(1, 0, 0, -pit * 0.8));
  const tint = [0, 1, 2].map((k) => 1 + (0.5 + 0.5 * cos(TAU * (hue + k * 0.33)) - 0.5) * 0.9);
  const pose = S && ciPass === 1 ? poseAlloc(PLAYER, clip, t) : -2;
  ciPut(PLAYER, x - fx * 0.75, y - 0.15 - fy * 0.75, z - fz * 0.75, 1.8, q[0], q[1], q[2], q[3], 0, hue, 0, 0, pose, tint);
}
// ---------------------------------------------------------------- input
const key = (e, v) => {
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': kf = v; break; case 'KeyS': case 'ArrowDown': kb = v; break; case 'KeyA': case 'ArrowLeft': kl = v; break; case 'KeyD': case 'ArrowRight': kr = v; break;
    case 'KeyE': case 'Space': ku = v; break; case 'KeyQ': case 'KeyC': kd = v; break; case 'ShiftLeft': case 'ShiftRight': ks = v; break;
    case 'ControlLeft': case 'ControlRight': kt = v; break;
    case 'KeyV': if (v && !e.repeat) toggleView(); break;
    case 'KeyF': if (!e.repeat) subUse(!!v); break;
    case 'KeyL': if (v && !e.repeat && SUBM.mode !== 'out') subLights(); break;
    case 'KeyR': if (v && !e.repeat && SUBM.mode !== 'out') subPing(); break;
    default: if (v && !e.repeat) {
      if ((e.code === 'KeyT' || e.code === 'Slash') && CREATIVE) { e.preventDefault(); conShow(true); }
      else if (e.code === 'KeyH') setFps(hud ? 1 : 2);
      else if (e.code === 'KeyM') mute();
      else if (e.code === 'F11') { e.preventDefault(); toggleFull(); }
      else if (e.code === 'Escape') ui(true);
      else if (e.code >= 'Digit1' && e.code <= 'Digit9') jump(e.code.charCodeAt(5) - 49);
      else if (e.code === 'Digit0') toLeviathan();
    }
  }
};
// behind the menu only the stats, mute and fullscreen keys work
addEventListener('keydown', (e) => { if (menu && e.code !== 'KeyH' && e.code !== 'KeyM' && e.code !== 'F11') return; if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault(); sound(); key(e, 1); });
addEventListener('keyup', (e) => key(e, 0));
const release = () => { kf = kb = kl = kr = ku = kd = ks = kt = 0; tId = -1; tN = 0; };
const capture = () => {
  sound();
  if (mob || document.pointerLockElement === canvas) return;
  const p = canvas.requestPointerLock({ unadjustedMovement: true });
  if (p && p.catch) p.catch(() => canvas.requestPointerLock()).catch(() => 0);
};
canvas.addEventListener('click', () => { if (!menu) capture(); });
addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { mdx += e.movementX; mdy += e.movementY; } });
addEventListener('blur', release);
const touch = (e) => {
  e.preventDefault(); sound(); tN = e.touches.length;
  if (menu) { tN = 0; tId = -1; return; }
  let f = null, first = false; for (let i = 0; i < tN; i++) if (e.touches[i].identifier === tId) f = e.touches[i];
  if (!f) { tId = -1; if (tN) { f = e.touches[0]; tId = f.identifier; first = true; } }
  if (f) {
    // the touch axes turn with the page when it lies on its side
    const x = rot.matches ? f.clientY : f.clientX, y = rot.matches ? -f.clientX : f.clientY, s = 1100 / min(innerWidth, innerHeight);
    if (first) { tx0 = x; ty0 = y; } else { mdx += (x - tx) * s; mdy += (y - ty) * s; } // the view follows the finger at once
    tx = x; ty = y;
  }
};
for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(n, touch, { passive: false });
const toggleFull = () => { if (document.fullscreenElement) document.exitFullscreen?.().catch(() => 0); else document.documentElement.requestFullscreen?.().catch(() => 0); };

// ---------------------------------------------------------------- screen wake lock (phones / tablets must not dim mid-dive)
let wakeLock = null;
const wake = async () => {
  if (menu || document.hidden || !navigator.wakeLock) return;
  try { if (!wakeLock || wakeLock.released) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
};
const unwake = () => { if (wakeLock) { wakeLock.release().catch(() => 0); wakeLock = null; } };
// the system drops the lock whenever the app is hidden; take it again on return while diving
document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); else release(); });

// ---------------------------------------------------------------- menu
// The scene keeps rendering (blurred by CSS) behind the menu. Esc, losing the mouse or the corner button open it.
let menu = true;
const bDive = $('d');
const ui = (m) => {
  if (dead) return;
  menu = m; body.className = m ? 'm' : document.pointerLockElement ? 'g p' : 'g';
  if (m) { release(); unwake(); if (document.pointerLockElement) document.exitPointerLock(); setTimeout(() => menu && bDive.focus(), 100); }
  else { document.activeElement && document.activeElement.blur(); wake(); }
};
const go = () => {
  sound(); ui(false); bDive.textContent = 'Resume';
  if (AC && AC.state !== 'running') AC.resume().catch(() => 0);
  // phones / tablets: fullscreen + landscape (the TWA is already fullscreen); desktop: capture the mouse
  if (mob) { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.()?.then(() => screen.orientation?.lock?.('landscape')).catch(() => 0); }
  else capture();
};
bDive.onclick = go; $('o').onclick = (e) => { e.currentTarget.blur(); ui(true); };
// the view button only switches the camera: it never keeps keyboard focus (Space / Enter would press it again)
$('cv').onclick = (e) => { e.currentTarget.blur(); toggleView(); };
for (const id of ['o', 'cv']) { $(id).tabIndex = -1; $(id).addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); }); }
// Go to (World tab): the jump keys as buttons, for touch screens; jumps, then dives in
let bioTurn = 0;
$('gt').querySelectorAll('button').forEach((b) => { b.onclick = () => { const j = b.dataset.j; if (j === 'lev') toLeviathan(); else if (j === 'sub') { if (SUBM.m < 0) return; const p = subW(SUBM, mark('hatch')); place(p[0] + 3, p[2] + 3, SUBM.x, SUBM.z, 0); F[CY] = clamp(p[1] + 2, hAt(F[CX], F[CZ]) + 2, -1.2); jumpName = 'your submarine'; } else if (j === 'big') jump(7); else if (j === 'minor') jump(8); else jump(bioTurn++ % 7); go(); }; });
// game mode (World tab): survival, or creative where creatures do not notice you; applied at once
function setMode(m) { CREATIVE = m === 'creative'; document.documentElement.classList.toggle('cr', CREATIVE); if (!CREATIVE && conOpen) conShow(false); save({ mode: m }); $('gm').querySelectorAll('button').forEach((b) => { b.className = b.dataset.m === m ? 'on' : ''; }); $('gmn').textContent = CREATIVE ? 'Creative: you are invisible to the creatures (nothing stalks, flees from or comes to look at you).' : 'Survival: creatures notice you: leviathans stalk and lunge, shy creatures flee, curious ones come closer.'; }
$('gm').querySelectorAll('button').forEach((b) => { b.onclick = () => setMode(b.dataset.m); });
setMode(CREATIVE ? 'creative' : 'survival');
conInit(); // creative console (console.js)
subInit2(); // submarine buttons (sub.js)
// pointer lock lost (Esc, Alt+Tab, the window losing focus inside the Tauri / WebView2 frame): open the menu
document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement && !menu && !conOpen) ui(true); else if (!menu) body.className = document.pointerLockElement ? 'g p' : 'g'; });
document.addEventListener('pointerlockerror', () => { if (!menu) body.className = 'g'; });
// detail: Auto / Low / Medium / High; the current choice is lit, the others save and reload
$('q').querySelectorAll('button').forEach((b) => { const q = b.dataset.q; if (q === SAVE.q) b.className = 'on'; else b.onclick = () => { save({ q, pix: 0, det: 0 }); location.reload(); }; });
$('t').textContent = `${TQ.label} · ${GPUNAME}`;
// FPS counter: On / Off / Full stats in the menu (saved), H on a keyboard, a tap on the counter on touch screens
function setFps(m) {
  fpsMode = m; hud = m === 2; hTot = 0; hPer = 1e9; info.textContent = ''; fpEl.textContent = '';
  fpEl.className = m === 1 ? '' : m === 2 ? 'hud' : 'off';
  save({ fps: m });
  $('v').querySelectorAll('button').forEach((b) => { b.className = +b.dataset.f === m ? 'on' : ''; });
}
$('v').querySelectorAll('button').forEach((b) => { b.onclick = () => setFps(+b.dataset.f); });
// option rows: lights the button whose data value is v
const lit = (id, k, v) => $(id).querySelectorAll('button').forEach((b) => { b.className = b.dataset[k] === String(v) ? 'on' : ''; });
// menu tabs: Graphics / World / Models / Controls (the last one opened comes back)
function setTab(t) {
  document.querySelectorAll('.pg').forEach((p) => { p.hidden = p.dataset.t !== t; });
  lit('tb', 't', t); save({ tab: t });
}
$('tb').querySelectorAll('button').forEach((b) => { b.onclick = () => setTab(b.dataset.t); });
setTab(['gfx', 'world', 'models', 'net', 'keys'].includes(SAVE.tab) ? SAVE.tab : 'gfx');
// what the current upscaler / frame-rate settings do, in one line under them
function gfxNote() {
  const sc = UPR[UPS] ? `renders at ${(100 / UPR[UPS]).toFixed(0)} % per axis, FSR 1 scales it up` : UPS === 'native' ? 'renders at full resolution' : 'FSR 1 with the render scale following the frame rate';
  $('gn').textContent = `${sc} · ${TFPS ? `capped at ${TFPS} fps` : TQ.tbdr ? 'aims for 60 fps' : 'follows the display rate'}${FG ? ' · every other frame generated' : ''} · textures and detail apply on reload`;
}
// upscaler mode and sharpening, applied at once (no reload)
function setUps(m) { UPS = m; save({ ups: m }); resize(true); lit('u', 'u', m); gfxNote(); }
$('u').querySelectorAll('button').forEach((b) => { b.onclick = () => setUps(b.dataset.u); });
setUps(UPS);
function setShp(v) { SHP = v; save({ shp: v }); resize(true); lit('sh', 's', v); }
$('sh').querySelectorAll('button').forEach((b) => { b.onclick = () => setShp(+b.dataset.s); });
setShp(SHP);
// target frame rate: applied at once; the tuner starts measuring again
function setTfps(v) { TFPS = v; nextT = 0; save({ tfps: v }); dynN = dynT = dynG = dynGN = 0; lit('tf', 'f', v); gfxNote(); }
$('tf').querySelectorAll('button').forEach((b) => { b.onclick = () => setTfps(+b.dataset.f); });
setTfps(TFPS);
// texture quality: reloads (textures are baked at load)
lit('tx', 'x', SAVE.tex);
$('tx').querySelectorAll('button').forEach((b) => { b.onclick = () => { if (b.dataset.x === SAVE.tex) return; save({ tex: b.dataset.x }); location.reload(); }; });
// frame generation: Off / On, applied at once
function setFg(on) { FG = on; save({ fg: on ? 1 : 0 }); resize(true); lit('fg', 'g', on ? 1 : 0); gfxNote(); }
$('fg').querySelectorAll('button').forEach((b) => { b.onclick = () => setFg(!!+b.dataset.g); });
setFg(FG);
netInit(); // Online tab: LAN multiplayer and updates (net.js)
fpEl.addEventListener('pointerdown', (e) => { e.stopPropagation(); setFps(2); });
info.addEventListener('pointerdown', () => { if (hud) setFps(1); });
setFps(fpsMode);
// world seed: shown, editable, randomisable; applying it reloads the same tier with a new world
// Seed parity: the seed alone defines the world, identically on every device; the fingerprint shows it. A share code
// "seed@x,z" (Share copies the current one) opens the same world at the same spot on another device.
const seedIn = $('sd');
seedIn.value = WSEED;
const applySeed = (v) => {
  const m = String(v).trim().match(/^(\d+)(?:@(-?[\d.]+),(-?[\d.]+))?$/);
  if (!m) { seedIn.value = WSEED; return; }
  save({ seed: (+m[1] >>> 0) || 1, at: m[2] !== undefined ? [+m[2], +m[3]] : 0 }); location.reload();
};
$('sr').onclick = () => applySeed((Math.random() * 4294967295) >>> 0);
$('sa').onclick = () => applySeed(seedIn.value);
$('ss').onclick = () => {
  const code = `${WSEED}@${F[CX].toFixed(1)},${F[CZ].toFixed(1)}`;
  seedIn.value = code; seedIn.select();
  navigator.clipboard?.writeText(code).then(() => { $('ss').textContent = 'Copied'; setTimeout(() => { $('ss').textContent = 'Share'; }, 1500); }).catch(() => 0);
};
$('wf').textContent = `World fingerprint ${fingerprint()} — the same seed shows the same fingerprint (and world) on PC and Android`;
// custom models: Add (.zip / .glb / .fbx / .obj, up to 8, kept on this device) and Clear; both reload so the meshes are rebuilt
$('mc').textContent = ACTIVE_IDS.length ? `${ACTIVE_IDS.length} loaded: ${CUSTOM.slice(0, ACTIVE_IDS.length).map((c) => `${c.name} (${MODEL_CLASSES[c.cls]})`).join(', ')}` : 'none — add a .zip (as downloaded, with textures), .glb, .fbx or .obj';
// one row per loaded model with a Remove button (your own models; a host's copies are not listed here)
CUSTOM.slice(0, ACTIVE_IDS.length).forEach((c) => {
  const row = document.createElement('p'), lab = document.createElement('span'), b = document.createElement('button');
  row.className = 'o'; lab.textContent = `${c.name} · ${MODEL_CLASSES[c.cls]}${c.skin ? ' · animated' : ''}`; b.textContent = 'Remove';
  b.onclick = async () => { try { await idbDo('readwrite', (st) => st.delete(c.name)); } catch {} location.reload(); };
  row.append(lab, b); $('ml').appendChild(row);
});
// Add: pick the file, check it parses, then choose its class; it is saved on this device and the world reloads with it
let pending = []; // models read from the picked files, waiting for their class
// Android's picker filters by MIME type and knows no type for .glb, so there it shows every file
if (mob) $('mf').removeAttribute('accept');
$('ma').onclick = () => $('mf').click();
// one picked file into a model record, identified by its content (a .glb starts with "glTF"), not its name or MIME
// type: Android pickers often report .glb as application/octet-stream or drop the extension
async function fileToRec(f) {
  const bytes = await f.arrayBuffer(), dv = new DataView(bytes), name = f.name.replace(/\.(glb|fbx|obj|zip)$/i, '').slice(0, 40);
  const zip = bytes.byteLength >= 4 && dv.getUint32(0, true) === 0x04034b50, glb = bytes.byteLength >= 4 && dv.getUint32(0, true) === 0x46546c67;
  const fbx = bytes.byteLength >= 18 && new TextDecoder().decode(new Uint8Array(bytes, 0, 18)) === 'Kaydara FBX Binary';
  if (zip) {
    // a zip (e.g. a Sketchfab download): the model inside, with its .bin / .mtl and colour textures (zips inside zips too)
    $('mc').textContent = `Unpacking ${f.name}…`;
    const b = await bundleFromZip(bytes);
    return { name, type: 'bundle', main: b.main, files: b.files };
  }
  const type = glb ? 'glb' : fbx ? 'fbx' : /\.fbx$/i.test(f.name) ? 'fbx' : 'obj';
  return { name, type, data: type === 'obj' ? new TextDecoder().decode(bytes) : bytes };
}
// Auto class: from the animation clips and the name (animated models made for this game use these clip names)
function guessClass(it) {
  const a = it.anims.join(' ').toLowerCase(), n = it.rec.name.toLowerCase();
  if (/interior/.test(n)) return 'i'; // "<submarine>_interior": the inside of that submarine
  if (/attack|roar/.test(a) || /leviathan|reaper|serpent|dragon/.test(n)) return 'l';
  if (/cruise/.test(a) || /sub(marine)?\b|hydra|cyclops|seamoth|rov/.test(n)) return 'm';
  if (/boat|ship|yacht|raft|kayak/.test(n)) return 'b';
  if (/swim|fly/.test(a) || /fish|shark|whale|creature|jelly|ray|eel|squid/.test(n)) return 'c';
  if (/plant|kelp|coral|grass|weed|flower/.test(n)) return 'p';
  return 's';
}
// pick one or several files: each is read and checked, then one class for all of them, or Auto (per model)
$('mf').onchange = async () => {
  const files = [...$('mf').files]; $('mf').value = ''; if (!files.length) return;
  pending = [];
  const errs = [];
  for (const f of files) {
    $('mc').textContent = `Reading ${f.name}${files.length > 1 ? ` (${pending.length + errs.length + 1} of ${files.length})` : ''}…`;
    try {
      const rec = await fileToRec(f), m = await parseModelRecord(rec, 64, false);
      if (rec.type === 'bundle') await loadTextures(m, bundleResolver(new Map(rec.files.map(([n, x]) => [n, new Uint8Array(x)]))), 64, false);
      pending.push({ rec, anims: m.skin ? m.skin.anims.map((x) => x.name) : [], verts: m.P.length / 3, found: m.groups.filter((g) => g.src).length, mats: m.groups.length });
    } catch (err) { errs.push(`${f.name}: ${err.message}`); }
  }
  if (!pending.length) { $('mc').textContent = 'Could not use ' + (errs.length > 1 ? 'those files: ' : 'that file: ') + errs.join(' · '); return; }
  const room = 8 - ACTIVE_IDS.length;
  if (pending.length > room) { errs.push(`only ${max(room, 0)} more fit (8 models at most)`); pending = pending.slice(0, max(room, 0)); if (!pending.length) { $('mc').textContent = errs.join(' · '); return; } }
  const one = pending[0];
  $('mn').textContent = pending.length === 1
    ? `Add “${one.rec.name}” (${(one.verts / 1000).toFixed(0)}k vertices${one.anims.length ? `, animated: ${one.anims.join(', ')}` : ''}) as`
    : `Add ${pending.length} models (${pending.filter((x) => x.anims.length).length} animated) as`;
  $('mk').hidden = false;
  $('mc').textContent = (errs.length ? errs.join(' · ') + ' · ' : '') + 'Auto: picks per model from its animations and name (' + pending.map((x) => `${x.rec.name} → ${MODEL_CLASSES[guessClass(x)]}`).join(', ') + ') · Structure: across the world, solid · Plant: swaying clusters · Creature: swims, flees or comes to look · Leviathan: circles, hunts, lunges · Submarine: cruises underwater · Boat: floats on the surface';
};
$('mk').querySelectorAll('button').forEach((b) => b.onclick = async () => {
  if (!pending.length || !b.dataset.c) { pending = []; $('mk').hidden = true; return; }
  try {
    for (const it of pending) { const cls = b.dataset.c === 'auto' ? guessClass(it) : b.dataset.c; await idbDo('readwrite', (st) => st.put({ ...it.rec, cls })); }
    save({ showModel: pending.length === 1 && (b.dataset.c === 's' || (b.dataset.c === 'auto' && guessClass(pending[0]) === 's')) ? 1 : 0 }); location.reload();
  } catch (err) { $('mc').textContent = 'Could not save: ' + err.message; }
});
// Library: the models repository (github.com/Nessuno6/abyssal-garden-models). Lists manifest.json; Add downloads the
// .glb from GitHub and saves it with the class the manifest gives. Credits and licences are shown with each model.
const LIB = 'https://raw.githubusercontent.com/Nessuno6/abyssal-garden-models/main/';
const LIBCLS = { s: 'Structure', p: 'Plant', c: 'Creature', l: 'Leviathan', m: 'Submarine', b: 'Boat', i: 'Sub interior' };
$('libb').onclick = async () => {
  const box = $('libl'); box.textContent = ''; $('mc').textContent = 'Reading the model library…';
  try {
    const j = await (await fetch(LIB + 'manifest.json', { cache: 'no-store' })).json();
    const have = new Set(CUSTOM.slice(0, ACTIVE_IDS.length).map((c) => c.name));
    const list = (j.models || []).filter((x) => LIBCLS[x.class]);
    $('mc').textContent = `${list.length} models in the library. Each keeps its own licence: credit the author when you share them.`;
    for (const x of list) {
      const row = document.createElement('p'), lab = document.createElement('span'), b = document.createElement('button');
      row.className = 'o'; lab.textContent = `${x.title} · ${LIBCLS[x.class]} · ${x.author} · ${x.license}${x.clips ? ' · ' + x.clips.join(', ') : ''}`;
      b.textContent = have.has(x.name) ? 'Added' : 'Add'; b.disabled = have.has(x.name);
      b.onclick = async () => {
        if (ACTIVE_IDS.length >= 8) { $('mc').textContent = 'Already 8 models: remove one first'; return; }
        b.disabled = true;
        try {
          $('mc').textContent = `Downloading ${x.title}…`;
          const r = await fetch(LIB + x.file); if (!r.ok) throw new Error('HTTP ' + r.status);
          const rec = await fileToRec(new File([await r.arrayBuffer()], x.name + '.glb'));
          await idbDo('readwrite', (st) => st.put({ ...rec, cls: x.class, credit: `${x.title} by ${x.author} (${x.license}), ${x.source}` }));
          location.reload();
        } catch (err) { b.disabled = false; $('mc').textContent = `Could not add ${x.title}: ${err.message}`; }
      };
      row.append(lab, b); box.appendChild(row);
    }
  } catch (err) { $('mc').textContent = 'Could not read the library: ' + err.message; }
};
$('mx').onclick = async () => { try { await idbDo('readwrite', (s) => s.clear()); } catch {} location.reload(); };
seedIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') applySeed(seedIn.value); });
// Save & quit (the apps, and an installed PWA on a computer): saves where you are, then closes the app. The spot is
// also saved every 20 s and whenever the page goes to the background (the system may close a backgrounded app), so
// the next dive in the same world starts there.
function savePos() { subSave(); save({ resume: [+F[CX].toFixed(2), +F[CY].toFixed(2), +F[CZ].toFixed(2), +F[YAW].toFixed(3), +F[PIT].toFixed(3), WSEED] }); }
setInterval(() => { if (!menu) savePos(); }, 20000);
document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); });
const bQuit = $('x');
if (APP || (STANDALONE && !mob)) {
  bQuit.hidden = false; bQuit.textContent = 'Save & quit';
  bQuit.onclick = async () => {
    savePos(); netClose();
    try { if (APP) { await invokeApp('app_exit'); return; } } catch (err) { console.error(err); }
    window.close();
  };
}
if (STANDALONE) $('f').hidden = true; // no web links inside the app

// ---------------------------------------------------------------- start: spawn in a kelp forest near the origin, populate, reveal
save({ loading: 1 }); // a crash before this is cleared drops the next visit a tier (quality.js)
addEventListener('pagehide', () => save({ loading: 0 }));
await say('Seeding the open sea…', 0.7, 800);
{
  // ?at=x,z starts the dive near any world position (e.g. ?at=5000000,-3000000 to see the floating origin at work)
  const at = SAVE.at ? SAVE.at : (new URLSearchParams(location.search).get('at') || '').split(',').map(Number), ax = clamp(at[0] || 0, -WORLD_MAX, WORLD_MAX), az = clamp(at[1] || 0, -WORLD_MAX, WORLD_MAX);
  if (SAVE.at) save({ at: 0 });
  // an explicit position starts exactly there; otherwise the dive starts in the nearest kelp forest
  // a saved spot in this world (Save & quit, or the last dive) comes back unless a position was asked for
  const rs = SAVE.resume, resume = !(at[0] || at[1]) && !SAVE.join && Array.isArray(rs) && (rs[5] >>> 0) === WSEED;
  const p = resume ? [rs[0], rs[2]] : at[0] || at[1] ? [ax, az] : findBiome(0, ax, az, 0) || [ax, az];
  F[CX] = p[0]; F[CZ] = p[1]; F[CY] = min(hAt(p[0], p[1]) + 9, -4); F[YAW] = hash2(0, 0, 7) * TAU; F[PIT] = -0.1;
  if (resume) { F[CY] = clamp(max(rs[1], hAt(p[0], p[1]) + 1.5), -490, -2); F[YAW] = rs[3]; F[PIT] = rs[4]; }
  bioAt(p[0], p[1]); for (let i = 0; i < 7; i++) BIO[i] = TB[i + 1];
  initLife(); updateLandmarks(); updateLife(0);
  subInit(); // your submarine (sub.js), parked in front of you the first time
}
// populate every tile and every clipmap level before the first reveal (64 tiles per submit)
popMax = 64;
for (let i = 0; i < 12; i++) { stream(); render(); await Q.onSubmittedWorkDone(); if (!nPop) break; }
popMax = TQ.popMax;
// a model was just added: start in front of the nearest copy of it
if (SAVE.showModel) { save({ showModel: 0 }); if (STRUCTS.length) { jumpMinor = JUMP_MINOR.length - 1; jump(8); for (let i = 0; i < 12; i++) { stream(); render(); await Q.onSubmittedWorkDone(); if (!nPop) break; } } }
stream(); shadowNow = true; render(); await Q.onSubmittedWorkDone();
await say('Letting the light in…', 1, 400);
setTimeout(() => save({ loading: 0 }), 15e3); // the load counts as survived after 15 s of frames
ui(true);
requestAnimationFrame((t) => { F[LAST] = t; requestAnimationFrame(frame); });
