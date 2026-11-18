# Prompt: rewrite Abyssal Garden's engine in Rust + wgpu

You are rewriting the engine of **Abyssal Garden**, an endless, fully procedural underwater world, from JavaScript +
WebGPU (in a Tauri v2 WebView) to **Rust + wgpu**. The goal is a native engine that runs on **Android (Vulkan)
first**, on **Windows (DX12/Vulkan)**, and in the **browser (WebGPU, wasm32)** from one codebase, with the same world
and the same features as today. The procedural world is the most important thing: it must stay endless,
deterministic from a seed, and generated on the fly.

The current game is in this repository (`source/`). Read it before you design anything; it is the specification.
Do not invent features or remove any. Where the old code has a known weakness, it is noted below.

## What exists today (the specification)

About 7,800 lines:

| File | Lines | What it does |
|---|---|---|
| `src/quality.js` | 89 | Hardware tiers (Low / Medium / High): counts, distances, resolutions; saved settings (`SAVE`) |
| `src/math.js` | 366 | Deterministic world noise (`whu`/`wvn`/`wfbm`/`wwor`…), biomes (soft Voronoi), seabed height `hAt`, the 1024 m anchored-cell scheme |
| `src/shaders.js` | 1,800 | All WGSL: clipmap terrain compute, plant population and culling compute, the solid / leaf / creature / custom-model / water-surface / sky / sprite / post (bloom, light shafts, sonar pulse, blast, rain) / FSR 1 EASU+RCAS / frame-generation shaders, and the shared `G` uniform struct |
| `src/world.js` | 1,562 | Meshes built in code, landmarks and minor features per cell, collision (`sdScene`), wildlife slots and behaviours, glTF / OBJ / FBX import, skinning (`skinPose`) |
| `src/cave.js` | 554 | Cave systems per 640 m cell: capsule skeletons, SDF field with noise, surface-nets meshing in time-sliced blocks, the volumetric entrance patches, decor, cave lights, cave collision |
| `src/sky.js` | 82 | Day/night cycle and weather on the shared world clock |
| `src/weapons.js` | 135 | The sub's homing missiles, blasts, damage, LAN sync |
| `src/sub.js` | 454 | The drivable submarine: modes (out / inside / pilot / passenger), interior with markers, arcade driving, power / hull / boost / crush depth, sonar (sweep, contacts, topo map, 3D pulse), cockpit first person, HUD |
| `src/net.js` | 336 | LAN multiplayer client/host logic, model sharing, update check |
| `src/console.js` | 146 | Creative-mode console (`/spawn`, `/tp`, `/time`, `/weather`, …) |
| `src/main.js` | 1,602 | WebGPU setup, pipelines, render loop, frame pacing and dynamic resolution, input, camera modes, menus, characters, imported models, leviathan rendering |
| `src/audio.js` | 77 | Procedural ambience (Web Audio), plus the sound effects in sub / sky / weapons |
| `template.html` | 305 | UI: menu tabs, HUD (sonar map, arc gauges), touch buttons, console |
| `src-tauri/src/lan.rs` | 201 | LAN WebSocket relay (TCP 47820) + UDP discovery beacon (47821) |
| `build.mjs` | 111 | Bundles everything; embeds the diver / custom character / leviathan GLBs and the baked world textures |

Assets: `source/assets/` (bundled GLBs and baked textures in `assets/tex/game`), and the public model library
(github.com/Nessuno6/abyssal-garden-models, read via its `manifest.json`).

## Non-negotiable invariants

1. **Determinism.** The same seed gives the same world on every device and platform. The seabed height, biomes,
   landmarks, minor features, caves and the `fingerprint()` must match the JavaScript version bit for bit where they
   are integer-hashed, and to the centimetre for heights. Port the noise **exactly**: integer lattice coordinates,
   the anchored 1024 m cell + local offset scheme, the same hash functions, the same constants. Write a test that
   compares `hAt` at a few thousand points and the fingerprint of several seeds against values dumped from the JS
   build. A LAN game between the old app and the new one must see the same world.
2. **Floating origin.** World positions are f64 on the CPU; the GPU only ever sees camera-relative positions (x, z
   relative to the camera, y absolute). Keep this everywhere, including caves, models and particles.
3. **CPU and GPU terrain agree.** The clipmap is computed on the GPU from the same noise; collision and placement use
   the CPU `hAt`. Keep the WGSL world noise and the Rust noise in lock step (same tests).
4. **Endless and streamed.** Nothing about the world is stored except the seed, the clock and the player's own
   changes. Generation must stay incremental (time-sliced) so it never causes a hitch.
5. **LAN compatibility.** Keep the JSON-over-WebSocket protocol so old and new clients can share a game: messages
   `w` (host: seed, clock, leviathans, model manifest, pose), `p` (client pose), `mreq` / `mc` (model transfer in
   192 KB base64 chunks), `subcmd`, `mis`, plus the `ch` (character) and `sub` fields. The UDP beacon format stays.
6. **Feature parity.** Every feature in the table above, every console command and every menu option.

## Architecture to build

- **One Cargo workspace**:
  - `engine` crate: world, noise, caves, meshing, simulation, rendering.
  - `app` crate: Android (cargo-apk / xbuild + `android-activity`), Windows, and web (`wasm-bindgen`, WebGPU backend).
  - `relay` crate: the existing `lan.rs`, usable inside the app and as a headless dedicated server.
- **Windowing / input:** `winit` (touch, mouse, keyboard, gamepad via `gilrs`).
- **UI:** `egui` (or a small custom immediate-mode UI) for menus, HUD, console. The HUD layout stays: sonar map top
  left, arc gauges top right.
- **Audio:** `cpal` + a small synth/mixer (port the Web Audio graph), or `kira`.
- **Assets:** `gltf` crate for models with skins and animations; `image` for textures. Keep the IndexedDB-equivalent
  model store as files in the app data folder (OPFS / IndexedDB on the web).
- **Threads:** use a job system (`rayon` on native, single thread or web workers on wasm) for cave meshing, landmark
  generation and model decoding. Keep a time-sliced path for wasm without threads.
- **Shaders:** reuse the existing WGSL. Split `shaders.js` into `.wgsl` files with a small preprocessor for the values
  the JS currently interpolates (tier constants, `${CM}`, `${SHADOW}`, …). Keep the `G` uniform layout (60 vec4 today)
  or replace it with documented, versioned structs.
- **Renderer** (same passes as today): compute (clipmap levels, plant population, visibility culling into indirect
  draws) → shadow map → scene (terrain clipmap, solids, instanced creatures, leaves, custom skinned models, caves,
  water surface, sky, sprites) → light shafts → bloom → post (tonemap, sonar pulse, blast ring, rain) → FSR 1 (EASU +
  RCAS) → optional frame generation. Reversed-Z infinite depth. MSAA as the tier says.
- **Platform extras, behind features:** on Windows, optional native-only upgrades (for example hardware ray-traced
  shadows / reflections via wgpu's ray-query feature where available). These must never be required by the
  procedural world.

## Known weaknesses to fix while porting (do not copy them)

- `main.js` is one large file mixing GPU setup, game logic and UI: split it into modules (renderer, camera/input,
  player, sub, ui, assets).
- Global mutable state everywhere (`F[]`, `SUBM`, `CVR`…): use an ECS (`bevy_ecs` or `hecs`) or plain structs owned
  by a `World` / `Game`.
- Caves are meshed on the main thread in time slices: mesh them on worker threads natively.
- Cave decor and entrance boulders reuse a few meshes: keep the instancing, but make it easy to add variety.

## Milestones (each one runs on the Android tablet and in the browser before moving on)

1. **Workspace, window, wgpu device** on Android, Windows, web; a clear screen; the frame loop with pacing and FPS
   readout; touch and mouse look.
2. **Noise + `hAt` + biomes ported**, with the determinism tests passing against values dumped from the JS build.
3. **Clipmap terrain** (compute + render), sun, fog, water colour, caustics; free-swim camera with collision.
4. **Plants and population** (GPU population, culling, indirect draws), landmarks and minor features.
5. **Creatures** (fish schools, mantas, jellyfish, turtles, squid, leviathans with the Blender model and its clips,
   behaviours and interactions).
6. **Caves** (skeletons, SDF, surface nets on worker threads, entrance patches, decor, lights, collision).
7. **Water surface, sky, day/night, weather**, post-processing, FSR 1, dynamic resolution, quality tiers.
8. **Imported models** (glTF / OBJ / FBX, skinning, the model library, mass import) and the player characters
   (first / third / front views, clips).
9. **Submarine** (interior, stations, driving, systems, sonar, HUD, weapons, grabs).
10. **LAN** (relay, discovery, protocol compatible with the old app), save/resume, console, settings UI, audio.
11. **Packaging**: signed Android APK/AAB, Windows installer, the web build (and its service worker), update check.

## How to verify

- Keep the JS build runnable side by side. For each milestone, take screenshots from the same seed, position and
  view in both builds (the JS build has a `?dev=1` inspector) and compare.
- Determinism tests in CI (`cargo test`), plus a wasm test run.
- Performance targets on the tablet (Samsung Galaxy Tab, Android 17): at least the current numbers (60–120 FPS
  outside, 45+ in the largest caves) at the same settings; GPU time from timestamp queries.
- Test LAN between an old client and a new host, and the reverse.

## Working rules

- One milestone at a time; show screenshots from the tablet at the end of each.
- Do not change world generation behaviour without saying so: the world must stay the same world.
- Keep commits small and the README up to date.
