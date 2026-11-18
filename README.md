# Abyssal Garden: Open Sea

An endless, seeded, procedural underwater world built from code alone: pure JavaScript, WebGPU, WGSL and the Web
Audio API. There are no libraries; the world, its creatures and even the app icons are generated in code, and the one
bundled asset is the player's animated diver (see Credits). It is an open-world
refactor of [Noniv/abyssal-garden](https://github.com/Noniv/abyssal-garden) (MIT). It keeps the kelp forests, light
shafts, caustics, manta rays, fish schools, sunken ships, stone whale tails, rock arches and purple grottos, and
packages the result for **Windows** (Tauri v2 / WebView2) and **Android** (Trusted Web Activity / Chrome).

## Layout

```
README.md                    this file
LICENSE                      MIT (original author)
source/
  package.json               npm scripts: build, build:readable, serve, tauri
  build.mjs                  bundles src/*.js into dist/index.html, writes manifest, sw.js and procedural icons
  serve.mjs                  zero-dependency static server for dist/ (http://localhost:8080)
  template.html              page shell: menu, seed selector, Quit button, service-worker registration
  manifest.json              PWA / TWA manifest (fullscreen, landscape)
  sw.js                      cache-first offline service worker (cache name stamped per build)
  src/
    quality.js               adapter request, GPU tier detection, budgets, saved settings
    math.js                  load-time mesh helpers + the world noise (JS mirror of W_WORLD)
    shaders.js               all WGSL: world noise, clipmap / population / cull compute, scene, post
    world.js                 meshes, landmarks, collision SDFs, wildlife recycling, biome search
    audio.js                 procedural soundscape (biome-aware)
    main.js                  device, streaming, render loop, tuner, input, menu, wake lock, lifecycle
  src-tauri/                 Tauri v2 shell (Cargo.toml, tauri.conf.json, capabilities, icons)
dist/                        build output: a self-contained static bundle
```

## Build and run

Requirements: Node.js 18+. Chrome or Edge 121+ (WebGPU).

```bash
cd source
npm install
npm run build          # -> ../dist (minified, ~106 kB HTML / ~43 kB gzipped)
npm run serve          # -> http://localhost:8080
```

`npm run build:readable` writes an unminified `dist/index.html` for debugging. `?at=x,z` in the URL starts the dive
near any world position, for example `http://localhost:8080/?at=5000000,-3000000`.

### Windows desktop (Tauri v2, WebView2)

Requirements: Rust (stable, MSVC toolchain) and the Visual Studio C++ build tools. The WebView2 runtime ships with
Windows 10/11, and the installer embeds its bootstrapper for older machines.

```bash
cd source
npx tauri icon ../dist/icons/icon-1024.png   # once: generates src-tauri/icons from the procedural icon
npx tauri build                              # runs `npm run build`, then bundles dist/
```

With the MSVC toolchain (Visual Studio Build Tools, "Desktop development with C++"), the plain command works.
With the GNU toolchain, `windres` fails when Cargo's target directory contains a space. If the project path has
one, point Cargo elsewhere:

```bash
CARGO_TARGET_DIR=C:/abyssal-target npx tauri build
```

The bundles then land in `C:/abyssal-target/release/bundle/` instead of the path below.

The output goes to `source/src-tauri/target/release/bundle/nsis/*.exe` and `.../msi/*.msi`, with the bare executable at
`source/src-tauri/target/release/abyssal-garden.exe`. The window opens maximized. **F11** toggles fullscreen,
**Esc** frees the mouse and opens the menu, **Resume** recaptures the mouse and resumes audio, and **Quit** closes
the window. `npx tauri dev` runs the shell against the current `dist/`.

### Android app (Tauri v2, fully offline APK)

This bundles `dist/` inside the APK and runs it in Android System WebView (Chromium, WebGPU), so it needs no
hosting and no network. The activity is locked to landscape, runs immersive fullscreen and keeps the screen on.

Requirements: Android SDK + NDK and a JDK. Android Studio provides all three; its JDK is in
`C:/Program Files/Android/Android Studio/jbr`.

```bash
cd source
export JAVA_HOME="C:/Program Files/Android/Android Studio/jbr" ANDROID_HOME="$LOCALAPPDATA/Android/Sdk" NDK_HOME="$LOCALAPPDATA/Android/Sdk/ndk/<version>"
npx tauri android build --debug --apk --target aarch64    # debug-signed, installs straight away
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

For the Play Store, run `npx tauri android build --aab` and sign the bundle with your own key. The Android project
lives in `source/src-tauri/gen/android`. `MainActivity.kt` sets fullscreen and keep-screen-on, and
`AndroidManifest.xml` sets the orientation.

### Android (Trusted Web Activity, Bubblewrap)

A TWA is Chrome showing your own HTTPS origin full-screen, so `dist/` has to be hosted once:

1. Upload the contents of `dist/` to any static HTTPS host, for example `https://example.com/abyssal/`.
2. Install Bubblewrap; it can fetch JDK 17 and the Android SDK on first run:
   ```bash
   npm i -g @bubblewrap/cli
   ```
3. Create and build the Android project:
   ```bash
   mkdir abyssal-twa && cd abyssal-twa
   bubblewrap init --manifest https://example.com/abyssal/manifest.json
   bubblewrap build
   ```
   When prompted, keep `fullscreen` display and `landscape` orientation from the manifest. The build produces
   `app-release-signed.apk` (sideload) and `app-release-bundle.aab` (Play Store).
4. Prove you own the site so Chrome hides its URL bar:
   ```bash
   bubblewrap fingerprint generateAssetLinks
   ```
   Then upload the generated `assetlinks.json` to `https://example.com/.well-known/assetlinks.json`.

Offline behaviour: the first launch loads from the host, and the service worker then precaches the whole app (one
HTML file, the manifest and the icons). Every later launch is served cache-first with no network needed. The screen
wake lock keeps phones and tablets from dimming while you dive, and it is taken again whenever the app returns to the
foreground.

## Controls

| | Keyboard and mouse | Touch |
|---|---|---|
| Look | mouse (pointer lock) | slide a finger |
| Swim | `W` `A` `S` `D` / arrows | hold a finger |
| Up / down | `E` or `Space` / `Q` or `C` | — |
| Faster / cruise | hold `Shift` / hold `Ctrl` | second finger |
| Jump to the nearest kelp forest, grotto, trench, silt plain, coral reef, crystal field, volcanic vents | `1` … `7` | — |
| Jump to the next set piece (wreck, whale tail, arch, ruins, skeleton) / smaller structure (bridge, mushrooms, arch, crystal spires, chimneys, coral bommie) | `8` / `9` | — |
| Meet the nearest leviathan (it swims past you) | `0` | — |
| FPS counter / full stats | menu, `H` | tap the counter |
| Share this world and spot (`seed@x,z`), open a share code | menu: Share / type the code + Apply | same |
| Add your own models (`.zip` as downloaded, `.glb`, `.fbx`, `.obj`; as structure, plant, creature, leviathan, submarine or boat) | menu: Models → Add model | same |
| First / third person | `V` | `◐` button |
| Game mode: Survival / Creative (creatures do not notice you) | menu: World | same |
| Play together on the local network (host, find games, join by address) | menu: Online | same |
| Save & quit (Windows and Android apps) | menu | menu |
| Menu, mute, stats, fullscreen | `Esc`, `M`, `H`, `F11` | `≡` button |

The menu has four tabs, and remembers the last one opened. Everything is saved in `localStorage`.

* **Graphics**:
  * **Detail**: Auto / Low / Medium / High. Applies on reload.
  * **Target FPS**: Auto / 30 / 60 / 90 / 120. Auto aims for 60 on phones and tablets and follows the display rate on
    desktops. A number caps the frame rate and sets the tuner's target.
  * **Upscaler (FSR 1)**: Auto / Native / Quality / Balanced / Perf. (see Upscaling below).
  * **Sharpening**: Soft / Medium / Sharp.
  * **Frame generation**: Off / On.
  * **Textures**: Auto / Low / Medium / High. Applies on reload.
  * **FPS counter**: On / Off / Full stats.

  A line under the options says what the current combination does.
* **World**: the seed (type a number, **Random**, **Share**, **Apply**) and the world fingerprint.
* **Models**: add or clear imported models.
* **Controls**: the key list (or the touch hint).

The `H` overlay shows fps, worst frame and GPU time
(timestamp queries), internal vs. native resolution, the f64 world position, the biome, clipmap rings and level
updates, populated tiles, landmarks, and the visible kelp columns, clumps, blades, solids and glints read back from
the GPU counters.

## Engine architecture

### Coordinate spaces and the floating-origin transform

| Space | Where | Definition |
|---|---|---|
| World | CPU only | `Float64Array F`: `F[CX], F[CY], F[CZ]` in metres; sea surface at y = 0 |
| Render | every GPU buffer | `(x − camX, y, z − camZ)`: the camera sits at `(0, camY, 0)` |
| Wrapped | texture lookups | render + `(camX mod 1024, 0, camZ mod 1024)`; every repeating frequency is `k/1024` per metre with `k` an integer, so it stays continuous across wraps |
| Anchored | world noise | integer 1024 m cell `A` (i32) + local `l` (f32 metres) |

Each frame the CPU subtracts the Float64 camera from every streamed thing (clipmap level corners, tile origins,
landmarks, fish and manta slots, bubble vents, the shadow-box centre) and only then converts to f32. The view matrix
has no x/z translation. y stays absolute because the dive is bounded (−200…0 m), where f32 resolves well under a
millimetre. The world is clamped to ±8,000,000 m, where the anchored lattice coordinates still fit in i32.

### World noise (identical in JS and WGSL)

`whu/hu` is a u32 lattice hash (`Math.imul` reproduces WGSL `u32 *`). `wvn/vn` is value noise and `wfbm/fbm` is
fractal Brownian motion. `wwor/wor` gives Worley F1/F2. `wheight/height` returns `h(x,z)` plus the biome weights.
A lattice frequency is `n` cells per 1024 m, so a lattice coordinate is `A·n + floor(l·n/1024)`, an exact integer at
any distance. The sea floor is divided into warped Voronoi regions of about 500 m. Each region is one of seven
biomes, picked by its cell hash, and borders blend over about 110 m:

* **Kelp forest**: ridged fBm outcrops; dense columns of swaying kelp; golden and green glints.
* **Purple grotto**: Worley-edge walls terraced into ledges around deep basins; magenta ground cover, sponges and
  coral; purple haze (`PCOL`) and dimmer light.
* **Trench and arch canyons**: a Worley-edge canyon network with terraced cliffs and mesas; floating boulders; most
  of the rock arches.
* **Silt plain**: gentle dunes, sparse seagrass, rippled sand; preferred by fish schools and mantas.
* **Coral reef shallows**: a plateau at about −20 m of coral knolls cut by white-sand channels, ending in a drop-off at
  its border; covered in corals, anemones and fronds, with coral bommies; turquoise water.
* **Crystal fields**: sharp-ridged dark blue-grey rock with glowing cyan, amber and violet crystal clusters and spires;
  deep teal water.
* **Volcanic vents**: a deep basin of cones and craters in black basalt with glowing lava veins, hydrothermal chimneys
  (incandescent throats, bubble columns) and crimson kelp; murky ember-brown water.

**Terrain variety.** Patches of rock pinnacles (32 m Worley cells) rise from the plains and kelp floors.

**Depth.** A large-scale layer on top of the biomes makes the seabed range from about −6 m to −460 m:

* **Shelves and abyssal plains.** A regional field on 6 km, 2 km and 1 km cells, warped by ±160 m, lifts shallow
  shelves up to 26 m and sinks abyssal plains up to 210 m. Big cells use `wvnL/vnL`, which splits the tile index into
  a big cell plus an offset in integers, so it stays exact far from the origin.
* **Drop-offs.** In about half of the world the depth changes in 38 m steps with steep cliff walls instead of a slope.
* **Seamounts.** 40 % of the 1 km cells in the deeper regions hold a rounded cone. The tallest reach 12 m under the
  surface. The tallest cone at a point wins, so overlapping cones stay continuous.
* **Chasms.** Winding cracks 80–170 m deep with near-vertical walls cut across any biome, in stretches of the world.

Reefs follow only 40 % of the regional depth, so they stay closer to the light. Kelp thins out below about −110 m.

Light keeps fading below 60 m, but at 35 % of the rate, so the deep is a dim blue twilight rather than black. The
exposure rises up to 1.9× between 60 m and 260 m (the eye adapting). Below 70 m a **diver's lamp** fades in: a soft
cone along the view that also reaches the occluded floors of chasms. You can swim down to −490 m.

Of a 120 km × 120 km sample of seed 20261110:

| Depth | Share of the sea floor |
|---|---|
| −6 to −40 m | 28 % |
| −40 to −70 m | 33 % |
| −70 to −200 m | 26 % |
| below −200 m | 12 % |

A link with `?at=x,z` starts exactly at that point, for example `?at=805,-2294` (a chasm in the default world) or
`?at=6810,-6780` (a seamount summit). Without one the dive starts in the nearest kelp forest.

**Minor features.** Three 128 m cells in four hold one of these (all equally likely, in any biome), collidable like the landmarks:
* a natural bridge spanning a canyon (trench only), with its deck just above the higher footing and pillars reaching 30 m down;
* a smaller rock arch (canyons, kelp, plains, crystals);
* a ring of 1-4 giant bioluminescent mushrooms (grottos);
* 1-5 crystal spires (crystal fields);
* 1-4 hydrothermal chimneys (volcanic vents);
* a coral bommie, a huge brain coral ringed by table corals (reefs).

**Population.** Each tile also grows table and brain corals, branching corals, sea fans and sponges, plus small
glowing mushrooms in the grottos. Kelp sits on a 7 × 7 grid per tile.

**Wildlife.** Fish schools, manta rays, sea turtles (paddle-stroking flippers) and translucent jellyfish swarms (pulsing
bells, trailing tentacles, glowing brighter in grottos and deep water) live in slots that are re-seeded ahead of the
swimmer. Jellyfish prefer grottos and canyons; turtles prefer kelp and plains. Squid swarms pulse along mantle-first.
Living leviathans, 40-60 m serpents with bioluminescent flank spots and amber eyes, patrol wide circles in deep
open water; each cross-section of the body is laid on the swim path behind the head, so the whole body follows the curve.

**Water.** Each biome has its own water colour and murk, blended as you cross borders: green-teal kelp, lavender
grotto, deep navy trench, blue plain, clear turquoise reef, emerald crystal fields, murky ember vents.

**Landmarks.** Structures do not depend on the biome: any kind can appear anywhere. Each 384 m macro cell holds a set piece five times out of six: a sunken ship, a stone whale
tail, a monumental arch, sunken temple ruins (stepped platform, columns, lintels, a fallen column) or a leviathan
skeleton (spine, ribcage, skull). All kinds are equally likely. The piece sits inside the middle 60 % of its cell, so
neighbours are always at least 150 m apart. It is anchored to `h(x,z)`: the ship rests on its keel line, and arch legs sink into
the lower footing.

### GPU buffers and WGSL structs

Every uniform struct uses only `vec4`, `mat4x4` and arrays of `vec4`, so offsets meet WebGPU's 16-byte uniform
alignment on every backend, including Android Vulkan validation.

| Binding | Type / size | Layout |
|---|---|---|
| `G` (group 0, b0) | uniform, 272 B | `vp mat4 · sm mat4 · cam (0,camY,0,time) · right (xyz,tanX) · up (xyz,tanY) · fwd (xyz,near) · sun (dir, grotto zone) · res (W,H,1/W,1/H; W = 0 marks the shadow pass) · mis (exposure, ray gain, detail, –) · wrap (camX mod 1024, camZ mod 1024, camX mod 44, camZ mod 44) · fog (far, distance scale, –, –)` |
| group 0, b1–b6 | samplers + textures | repeat, clamp, comparison sampler; shadow depth; water (caustics + slopes, mipped); rock detail (mipped) |
| `tCH` (group 1, b0) | `rgba32float` 2D array, L layers of (M+1)² | per clipmap texel: `h, normal.x, normal.z, occlusion` |
| `tCB` (group 1, b1) | `rgba8unorm` 2D array | `magenta cover, sand, grotto, trench` |
| `LVU` (group 1, b2) | uniform, 128 B | `o[8]`: level corner x, z (render space), spacing, layer |
| `KV` / `TV` (group 1, b3/b4) | read-only storage | visible kelp columns / ground-cover clumps, 2 × vec4 each |
| `WT` (group 1, b5) | uniform, 896 B | `sch[16] · man[8] · vent[16] · jel[8] · tur[8]`: render-space centre + fade / bubble-column height |
| records | storage, `NT² × PER × 64 B` | per tile slot, 4 × vec4: `a` (tile-local x, y, tile-local z, size) · `b` (params / quaternion) · `c` (material, seed, texture scale, bob) · `d` (kind, alive, grotto, fade distance) |
| `SV` | storage + vertex | visible solids, `NK` segments × `scap` × 64 B; the same 4 × vec4 is the instance vertex layout (locations 2–5) |
| `ARG` | storage + indirect | 8 u32 per list: `draw` (vertexCount, instanceCount, …) or `drawIndexed` (indexCount, instanceCount, firstIndex, baseVertex, 0) |
| `CNT` | storage + copy-src | one atomic u32 per list; read back for the stats overlay |
| `CL`, `PU`, `CU` | uniforms, 272 / 1056 / 160 B | clipmap jobs, population jobs, frustum planes + distances + shadow box |

### Frame pipeline (one command buffer)

1. **Clipmap compute** (`W_CLIP`): runs only for levels whose snapped origin moved. Level `l` has spacing 2^l m and
   (M+1)² vertices, snapped to 2·spacing. It writes height, normal, occlusion and cover.
2. **Population compute** (`W_POP`): the NT×NT ring of 32 m tiles is a toroidal buffer of slots. Tiles entering the
   ring are rebuilt, nearest first, up to `popMax` per frame. Each fills 49 kelp columns, `capT` ground-cover clumps,
   64 rocks, 80 sponges, corals and mushrooms, and 16 floating boulders. Records are deterministic in (seed, tile, index).
3. **Cull compute** (`W_CULL`): one workgroup per tile. A tile outside the frustum or the draw distance exits at
   once. Otherwise each live record is tested against the frustum and its distance and appended to its list:
   - kelp near / mid / far, glints and shadow casters;
   - ground cover;
   - one list per solid mesh kind, with near/far rock and coral LODs.

   Each append bumps `instanceCount` in `ARG` atomically.
4. **Render**:
   - water texture;
   - the shadow map, only when the camera leaves the middle of the shadow box or population settles;
   - the scene: clipmap rings (4 hole variants with geomorphing at each edge, so there are no cracks and no
     popping), landmarks, `drawIndexedIndirect` per solid kind, mantas and fish, `drawIndirect` for kelp and
     ground cover (blades are expanded in the vertex shader from a per-column hash, so millions of blades cost a
     few bytes each), surface, background, bubbles, glints and drifting particles;
   - light shafts at 1/2 or 1/4 resolution with a depth-aware blur and bilateral upsample;
   - bloom;
   - tone-mapped composite.

### Collision

`sdScene` combines the analytic seabed, taken as the vertical distance to `h(x,z)` scaled by the slope, with the exact
SDFs of the landmarks near the camera: the arch's noisy torus, the whale tail's capsule chain and the ship's hull shell.
The camera is a 0.5 m sphere. It moves in sub-steps shorter than its radius, is pushed out along the SDF gradient,
and its velocity into the surface is removed, so it slides along rock and through the arches.

Things that move collide too. Every frame `sdScene` also includes capsules for:

* imported creatures, leviathans, submarines and boats near the camera, one along each body, sized from the model's
  extents;
* the built-in leviathans: eight capsules along the swim path behind the head, thinning toward the tail;
* the other divers in a LAN game.

Imported structures collide as boxes. Small built-in animals (fish, mantas, turtles, jellyfish, squid) are animated on
the GPU and do not block you.

### The player: first and third person

`V` (or the `◐` button) switches between first and third person. In third person the camera sits 3.4 m behind and
a little above your diver, moving in when rock is in the way. You see the animated diver, which other players also
see in LAN games, each tinted in their own colour (from the name).

The diver is `source/assets/diver_swim.glb`. It was rigged in Blender from **'Diver' by nolanfa** (Sketchfab, CC-BY 4.0)
and has three looping clips: `idle` (still), `swim` (up to 12 m/s) and `fast`. Each clip's speed follows how fast
the diver moves. The build script bundles it into the page.

### Skeletal animation

Imported glTF / GLB models with a skin and animations play them. This covers the player's diver and the many
animated models on Sketchfab.

* The parser keeps skinned vertices in bind space and reads `JOINTS_0` / `WEIGHTS_0`, the skin's joints and inverse
  bind matrices, every node's rest transform and parent, and each animation's translation, rotation and scale channels.
  Linear, step and cubic-spline (values only) interpolation are supported.
* Each frame the CPU samples the clip, walks the node hierarchy, and uploads joint matrices to a storage buffer.
  Each matrix is wrapped in the model's normalisation (centre, scale, turn), so the vertex buffer layout is unchanged.
* A skinned variant of the textured model pipeline blends the four weighted joints per vertex, in both the scene
  and the shadow pass.
* Every skinned model gets four poses at different phases, which its instances share by seed. Each diver avatar gets
  its own pose. Imported models play a clip named like swim, fly, move, walk or idle, else the first one.

### Upscaling: AMD FSR 1 (Windows and Android)

The scene renders at an internal resolution, and **AMD FidelityFX Super Resolution 1.0** brings it to the display. It
is ported to WGSL from AMD's MIT-licensed source and runs on any GPU:

1. **EASU** (edge-adaptive spatial upsampling): 12 taps around each output pixel. It estimates an edge direction and
   length from the luma gradients of the 4 nearest pixels, applies a Lanczos-2-like kernel stretched along the edge,
   and clamps the result to the 2×2 neighbourhood so it cannot ring.
2. **RCAS** (robust contrast-adaptive sharpening): 5 taps at output resolution, with the sharpening lobe limited so
   it never clips.

The output is capped at 4.5 MP on tile-based GPUs, so a 2960×1848 Mali tablet outputs at about 2690×1680.

| Mode | Render scale per axis |
|---|---|
| **Auto** | Chosen by the frame-time tuner. Always upscaled on tile-based GPUs, and on desktops only when the scale drops below native |
| **Native** | 100 % (no upscaling) |
| **Quality** | 67 % (1.5×) |
| **Balanced** | 59 % (1.7×) |
| **Perf.** | 50 % (2×) |

In a fixed mode the tuner only moves the draw distance. **Sharpening** sets the RCAS strength (Soft 0.4, Medium 0.75,
Sharp 1). Both apply at once.

**DLSS is not available.** It needs NVIDIA's native SDK on Direct3D 12 or Vulkan with access to the tensor cores.
The app renders through WebGPU inside WebView2 (Windows) or Android System WebView, which expose none of that. FSR 1
covers both platforms instead, on any GPU.

### Frame generation

With **Frame generation** on, every other displayed frame is generated instead of rendered:

1. The last rendered frame (the composite before upscaling) and its depth buffer are kept.
2. For each pixel, the generated frame searches for the point of the last frame that lands on that pixel from the
   current camera. It reads the depth, moves the point into the current view, and steps its guess by the error
   (4 iterations).
3. The result goes through FSR like a rendered frame.

What to expect:

* The camera moves and turns smoothly at the display rate.
* Animated things (fish, kelp sway) update only on rendered frames.
* Edges that were hidden in the last frame are filled by stretching their neighbours.
* A jump of more than 20 m renders two frames in a row.
* The tuner gives rendered frames 1.8× the frame-time budget.
* The FPS counter shows displayed frames and, in brackets, rendered ones.

Like any frame generation, it smooths motion but does not lower input latency. It works best when the device renders
just under the target rate. In a browser, frame pacing is up to `requestAnimationFrame`.

### Textures

**Textures** sets four things. Auto keeps the tier's own values.

| | Rock detail texture | Animated water texture | Anisotropic filtering | Imported model textures |
|---|---|---|---|---|
| Low | 512² | 128² | off | 512 px |
| Medium | 1024² | 256² | 4× | 1024 px |
| High | 2048² | 512² | 16× | 2048 px (4096 px on desktop) |

### Seed parity

Heights, biomes, structures and collision are evaluated in Float64 JavaScript, so the same seed builds the same world
on Windows, Android and in the browser. The GPU mirrors the same integer-hashed noise for the terrain and its
population. The menu shows a **world fingerprint**, a hash of seabed heights and set pieces at fixed points:
the same seed gives the same fingerprint on every device. **Share** copies a code `seed@x,z`; type it on another
device and press **Apply** to dive into the same world at the same spot.

Kelp, ground cover and other plants are tier-dependent: a lower tier shows a subset of the same placements.

### Imported models

**Models → Add model** takes the **`.zip` exactly as downloaded** (from Sketchfab, for example), or a single **binary
glTF (`.glb`)**, **binary FBX (`.fbx`, 7.x)** or **Wavefront `.obj`**. Files are recognised by their content, so
Android's picker (which knows no MIME type for `.glb`) shows every file.

**From a zip** the app picks the model (`.glb` > `.gltf` > `.fbx` > `.obj`, including an `.obj` with no extension)
and opens zips inside the zip. It keeps only what the model needs: `.bin`, `.mtl` and the colour textures. Normal,
roughness, metal, specular, AO, opacity and emissive maps are left out to save space. Textures are matched in order:

1. the exact file the model names;
2. the same name with another image extension (models often name `.tif` / `.tga` files that were shipped as `.png` / `.jpg`);
3. another UDIM tile of the same texture;
4. a colour texture whose name contains the material's name;
5. for a single-material model, the most likely base-colour image.

**UDIM** textures (`*.1001.png`, `*.1002.png`, or a `<UDIM>` placeholder) are split per UV tile.

Textures are shrunk to the **Textures** setting's limit (Auto: 1024 px on mobile, 2048 px on desktop). Not supported: USDZ, text (ASCII) FBX, and
Draco- or meshopt-compressed glTF (export them again without mesh compression).

* **glTF (`.glb` or `.gltf` + `.bin`):** reads the node hierarchy (all transforms applied) and every triangle
  primitive's positions, normals and UVs. Each material's base colour and base-colour texture come from either
  metallic-roughness or the older specular-glossiness materials (common on Sketchfab). Textures can be embedded,
  data: URIs or files in the zip. WebP and quantized meshes are read; KTX2 textures fall back to the material colour.
* **FBX:** reads the binary node tree (compressed arrays inflated with the browser's `DecompressionStream`) and every
  mesh geometry with normals, the first UV set and per-polygon materials. It applies the model hierarchy's local
  translation, rotation (all six rotation orders, pre-rotation), scaling and geometric offsets, and turns Z-up files
  Y-up. Each material gets its diffuse colour and diffuse texture: an embedded PNG / JPEG / WebP, or the file it names,
  looked up in the zip.
* **OBJ:** positions, UVs, normals and `usemtl` materials from the `.mtl` (`Kd`, `d`, `map_Kd`).
* Skins and animations are ignored; movers get procedural motion instead.
* Up to 8 models, each up to 1.5 M vertices, stored on the device (IndexedDB). Respect each model's licence (for
  example, CC-BY requires attribution).

After choosing a file you pick its **class**:

| Class | What it does |
|---|---|
| Structure | One more structure kind across the world, 8–18 m, solid (box collision); **9** cycles to it |
| Plant | Swaying clusters of 3–10, 0.5–3 m, in about half of the 36 m cells around you |
| Creature | Pairs that circle a wandering centre with a body wave, shy of the diver, flee from leviathans |
| Leviathan | A 30–55 m giant on a wide circle with the leviathan behaviours: circles you, hunts fish schools, scares prey |
| Submarine | 14–30 m, cruises underwater in long gentle turns |
| Boat | 8–20 m, floats at the surface (you see the hull from below), drifting and rolling gently |

Creatures, leviathans and vehicles are turned so their longest side faces forward (+z, the glTF convention).

### Your submarine

Imported **submarine** models no longer cruise the world: the first one becomes **your own sub** (one per player). It
is parked in front of you the first time; its position, hull, power, boost and lights are saved. **Go to → My sub**
takes you to it, and `/sub` in the creative console parks it in front of you.

A model named `<submarine name>_interior` (class **Sub interior**, which Auto picks from the name) is the inside of
that submarine. It is modelled in the hull's own frame, so it sits inside the hull. Named empties in it are the
stations: `pilot_seat`, `hatch` (outside), `hatch_inside`, `sonar`, `lights_panel`, `power_panel`, `repair_panel`,
`passenger_1..3` and `floor_min` / `floor_max` (the walkable floor). The Hydra's cockpit and command centre were built
in Blender this way. Without an interior the sub still works: boarding goes straight to the pilot's seat.

| | Keyboard | Touch |
|---|---|---|
| Board at the hatch, sit, use a panel, stand up, leave | `F` | the Use button |
| Drive (arcade: the sub turns toward where you look) | `W` `A` `S` `D`, `E` / `Q` up / down | hold to move, slide to steer |
| Boost (charges back like stamina) | hold `Shift` | Boost button |
| Lights, sonar ping | `L`, `R` | Lights, Sonar buttons |
| Fire a missile | `X` | Fire button |
| Pilot view / chase camera | `V` | `◐` |

* **Power** drives everything. Thrust, boost, the lights (1.2 % a second), the sonar (2 % a second) and repairs use it. It recharges slowly,
  faster near the surface (above −30 m). At 0 the lights go out and the sub crawls.
* **Hull:**
  * a hit above 6 m/s on rock or a structure damages it, as does a leviathan's bite (22 %);
  * below **crush depth (280 m)** it fails steadily, with a warning on the dashboard;
  * at 0 the sub is crippled until you repair it: hold Use at the **repair panel** (it costs power).
* **Sonar** (`R`, the Sonar button or the sonar table) is on until you switch it off, and uses power while on:
  * the round screen shows a topographic map of the seabed around you (depth shading, 15 m contour lines), turned so
    your heading is up, with a north marker;
  * a sweep turns every 4 s, and each turn starts with a ping (sound, with its echo);
  * what is within 300 m lights up as the sweep passes its bearing, with a faint echo, and then fades over about 40 s:
    leviathans red, creatures yellow, fish schools green, other subs cyan, structures grey;
  * in the 3D view, each ping sends a pulse out from the sub at 110 m/s. It outlines rock, creatures and structures in
    cyan as it passes, and the outlines fade over a few seconds, so you can make out shapes in the dark.
    The pulse passes through kelp, grass and algae: it shows the rock and creatures behind them.
* **Lights:** the sub's lights work at any depth. The cabin is lit while power lasts.
* **Creative:** no damage and no power use.
* **LAN games:** every player has a sub (from the host's models), and you collide with the others' subs. Swim to
  another player's hatch and press `F` to ride as a passenger. Passengers sit in a seat, can stand and walk the
  command centre, ping the sonar and ask the pilot's sub to switch its lights.

### Characters

**World → Character** picks who you are: the **diver** or a **custom** character (`source/assets/player_custom.glb`,
kept out of the repository; the option is greyed out without it). Both have the same clips, made in Blender: idle,
tread (treading water), swim, fast, walk, jump and drive. Near the seabed you walk and stand on it, and `Space` there
pushes off in a jump; at the surface you tread water; at your sub's controls you sit and drive. Other players see the
character each of them chose.

### Views

Swimming, `V` cycles first person → behind you → in front of you (to see your face) → first person.

### Driving the sub: two views and the HUD

`V` switches between third person (behind and above the hull, pulled in when rock is in the way) and first person: you
sit at the controls (the seat reclined) with your hands on a stick that tilts as you steer; looking slightly down at it
counts as level. Leave the controls and the sub slowly levels itself. Leviathans that catch you in the sub grab it in their
jaws (their `grab` clip): the sub shakes and the hull gives until they let go. The HUD keeps the sonar map in the top-left corner and the gauges in the top right: three arcs, hull
(blue, shield), power (yellow, bolt) and boost (grey, rocket), around your depth and speed.

### Missiles

Piloting, press `X` (or **Fire**) to launch a missile from the sub's nose: 6 in the rack, one reloads every 5 s and
takes 3 % power (free in creative). It homes on the leviathan or creature nearest your line of fire, trails amber
sparks and lights the water as it goes, and explodes on rock, near its target or after 7 s: a flash, a shock ring, a
boom and a shake. A leviathan hit flees; three hits drive it off. Too close and your own hull takes damage. In LAN
games the others see your missiles.

### Game modes

The **World** tab has **Survival** and **Creative**. The only difference: in creative you are invisible to the
creatures. Leviathans do not stalk, roar at or lunge at you, imported creatures neither flee from you nor come to
look, squid do not dart away and fish schools do not swerve around you. The mode applies at once and is saved.

### Creative console

In creative mode, `T` or `/` (or the `⌨` button on touch screens) opens a console for testing behaviours:

* `/spawn <model | leviathan | school | manta | turtle | jelly | squid> [count]` puts imported models or built-in
  animals in front of you.
* `/kill` removes what `/spawn` added.
* `/attack` makes the nearest imported leviathan lunge at you, even in creative.
* `/roar` and `/hunt` trigger the leviathan's roar or start it hunting.
* `/anim <clip>` makes the nearest animated model play a clip.
* `/tp <x> <z> [y]`, or `/tp leviathan | landmark | structure | biome <1-7>`, moves you.
* `/mode survival | creative`, `/list` (models and clips), `/clear` and `/help`.

The World tab also has **Go to** buttons (leviathan, landmark, structure, next biome) for touch screens.

### Developer mode (test without rebuilding the app)

The installed app can load the game from a dev server instead of its built-in copy, so code changes need no new APK
or installer. Only changes to the Rust or Android code (`src-tauri`) still need one.

1. On the PC: `npm run serve` (in `source/`), and after each change `npm run build:readable`.
2. Android: `adb reverse tcp:8080 tcp:8080`, so the tablet's `localhost:8080` is the PC. WebGPU needs a secure page, and
   `localhost` counts as one.
3. In the app, **Online → Developer**: `http://localhost:8080` → **Use**. The app now starts from the dev server; restart
   it (or reload) to get the latest build. **Off** goes back to the built-in game.

The dev page has its own settings and models (separate browser storage). Add models there with the console's
`/import <url> [class]`, for example `/import /test/reaper_leviathan_anim.glb leviathan` for a file in `dist/test`.
Each model in the Models tab also has its own **Remove** button.

### Animated creatures: clips follow behaviour

Imported models that use these clip names (as the Blender-animated ones in this project do) switch clips with what
they are doing. A model without a clip keeps its default.

* **Leviathan:** `swim`, and `fast` while hunting. In survival, when its head comes within 25 m of you while it
  stalks you, it plays `attack`: the head draws back, then lunges up to 18 m toward you, mandibles snapping, and its
  collision capsule shoves you. It also `roar`s every 18 s or so while near you. When hunting it now chases imported
  creatures as well as fish schools, and lunges to bite when within 20 m. One-shot clips play to the end, with a
  12 s cooldown between attacks.
* **Creature:** `swim`. When fleeing a leviathan or the diver it plays `turn` once, then `fast`. Half of the
  imported creatures are curious: they come over to look at you and hover close by with `idle`; the other half
  stay shy.
* **Submarine:** `cruise` while moving (propellers spinning faster with speed), `turn` while turning, `idle` when
  slow. No creature behaviour.

`0` alternates between the built-in leviathans and an imported one.

### Mass import

**Add models** takes several files at once (`.zip`, `.glb`, `.fbx`, `.obj`). Pick one class for all of them, or
**Auto**, which picks per model from its clips and name:

* `attack` / `roar` or a name like leviathan / reaper → leviathan;
* `cruise` or a name like submarine / hydra → submarine;
* boat / ship → boat;
* `swim` or a fish-like name → creature;
* plant-like names → plant;
* anything else → structure.

The menu lists the guesses before you choose. At most 8 models fit.

### LAN multiplayer

Play together with other devices on the same network: the **Online** tab of the menu. Hosting needs the Windows or
Android app. Any version, including the web page served over `http`, can join by address.

* **Host** starts a small WebSocket relay in the app (`src-tauri/src/lan.rs`, TCP 47820) and announces the game with a
  UDP beacon (port 47821) every second. The relay forwards every message to the other players.
* While the Online tab is open the app looks for games every 6 seconds and lists them, or you can type the host's
  address and **Join**.
* **The host owns the shared world.** Ten times a second it sends its seed, world clock, position, leviathans and
  the list of its imported models. A joining player:
  1. downloads any of the host's models it lacks, sent in 192 KB pieces through the relay;
  2. reloads into the host's world (same seed, the host's model set, next to the host);
  3. rejoins by itself.

  Its clock follows the host's, so water, kelp, creature animation and the leviathans' paths match. It takes the
  host's leviathans, and every device renders the scene itself.
* Your own models are not replaced: copies of a host's models are kept apart and only loaded while you play in that
  host's world.
* Other players appear as the animated diver in their colour, with a name tag and their distance.

Notes:

* Android 17 and later treat the local network as a permission; the app asks for it once.
* Android cuts the network of apps in the background, so a host on Android must keep the game on screen.
* Windows asks once whether the app may use the network (firewall).

### Updates

The apps check the latest release of [Nessuno6/abyssal-garden](https://github.com/Nessuno6/abyssal-garden/releases)
when they start (at most every 6 hours) and on **Check now** in the Online tab. A newer version offers its APK
(Android) or installer (Windows), opened in the system browser. **Auto / Manual** turns the start-up check on or off. The
web version is always the latest deployed one.

### Save & quit

**Save & quit** (Windows and Android apps) saves where you are and closes the app. The spot is also saved every
20 s and whenever the app goes to the background. The next dive in the same world starts there, unless you join a
game or open a position link.

### Creature interactions

* Fish schools, turtles, squid and imported creatures flee from any leviathan's head within 55 m, built-in or
  imported.
* An idle leviathan hunts: for about 30 s it steers its swim circle over the nearest fish school, which flees.
* An idle manta drifts along with the nearest turtle.

The stats overlay shows "leviathan hunting", the number fleeing and the mantas with turtles.

### Creature behaviours

The centre of each school or individual moves on its own: a slowly wandering heading, eased velocity, and a height
that keeps its lift above the seabed.
* **Mantas** are curious: within 70 m they glide over to you for about 20 s, then lose interest for about 45 s.
* **Leviathans** patrol. Within 160 m one starts circling you for about 40 s, then moves away (the overlay shows
  "circling you").
* **Squid swarms** dart away inside 18 m.
* **Jellyfish** drift on a slow shared current.
* **Turtles** graze low over the seabed.
* **Individual fish and squid** swerve away from the diver in the vertex shader.

### Hardware tiers (`quality.js`)

| Tier | Detected as | Render scale / cap | Draw radius | Clipmap | Flora budget | MSAA / shafts / shadow |
|---|---|---|---|---|---|---|
| **High**: Desktop IMR | discrete NVIDIA / AMD / Intel Arc (e.g. RTX 3060) | 1.0×, ≤ 2560×1440 | 850 m | 5 × 129² | ≈ 2.5–6 M blades | 4× / ½ res / 4096² |
| Mobile TBDR, flagship phone | Adreno 7xx/8xx, Immortalis / Mali-G7xx+, Xclipse, or ≥ 8 GB | 0.70–0.75× native, ≤ 2.0 MP | 320 m | 5 × 65² | ≈ 270 k | 1× / ¼ res / 2048² |
| Mobile TBDR, high-DPI tablet | tiler + short side ≥ 600 CSS px and ≥ 1500 px | 0.60–0.65×, ≤ 2.31 MP | 320 m | 5 × 65² | ≈ 320 k | 1× / ¼ res / 2048² |
| **Medium**: desktop integrated | other desktop GPUs | 0.75–1.0×, ≤ 1080p | 450 m | 5 × 65² | ≈ 1.1 M | 1× / ½ res / 2048² |
| **Low** | weak / unknown devices | 0.5–0.6×, ≤ 1 MP | 240 m | 4 × 65² | ≈ 120 k | 1× / ¼ res / 1024² |

A closed-loop tuner adjusts the load once a second. With GPU timestamps it holds GPU time within ±16 % of the target;
without them it uses frame time. The target is 11.7 ms (a sustained 60 fps with thermal headroom) on tilers, and
80 % of the display's refresh period (up to 165 Hz) on desktops. Too slow lowers pixels first, then the draw-distance
scale, then the remaining pixels; extra headroom restores them in reverse order. The settled values are saved for the
next visit. If loading crashes the tab or the GPU device is lost, the next launch starts one tier lower.

### Caves

About half of the 640 m world cells hold a cave system (`cave.js`): two mouths, each opening in the side of a rocky
knoll, a winding tunnel 26-36 m wide (a submarine fits) 30-50 m under the rock, a chamber halfway and often a side
passage to a dead-end grotto. A system is a skeleton of capsules plus 3D noise, meshed on the CPU with surface nets a
few milliseconds per frame when you come within about 900 m; the GPU cuts the seabed open at the mouths and keeps
plants out of them. Daylight only reaches near the mouths. Each cave has a theme, inspired by Subnautica's caves:
**glowing fungus** (giant violet mushrooms, crystals overhead), **crystal** (cyan clusters everywhere) or **lava** (in
the deep: vent chimneys, glowing veins and pools). The brightest growths are real lights (the 8 nearest). Caves
collide like rock. **Go to → Cave** or `/tp cave` takes you to the nearest entrance.

### Above the surface

Swim up and your head comes out of the water (in creative you can fly up to 160 m): a sky with sun and clouds, and the
open sea to the horizon. Your submarine can surface too. `/tp surface` takes you there.

### Day, night and weather

The sun crosses the sky once every 24 minutes (`sky.js`), or stays at dawn, noon, dusk or night (**World → Time of
day**, `/time`). Above the surface: a blue sky with clouds by day, orange and violet at dawn and dusk, stars and the
moon at night. Under water the light follows the refracted sun; at night only the moon, your lamp (it switches on by
itself) and the glowing life are left. The weather (**World → Weather**, `/weather`) changes every few minutes: clear,
cloudy, overcast, rain (sunny showers with a rainbow when the sun is out), storm (wind, heavy rain, big waves) and
thunderstorm (lightning bolts every few seconds, thunder rolling in after them). Clouds dim the light and soften the
caustics; bad weather raises the waves and the murk; above the surface rain falls in layers, drops ring the water and
you hear it, muffled under water. Both follow
the world clock, so everyone in a LAN game sees the same sky.

### The leviathans

The built-in leviathans are the lantern leviathan (`assets/leviathan.glb`, made in Blender for this project): a 42 m
plated serpent with a four-petal jaw, a glowing lure, frills and whisker-tentacles, 55 bones and 8 clips. On patrol it
swims and now and then curls through a tight turn; when it starts stalking you it flares its frills and roars, then
circles fast and lunges when its head passes close; hunting fish, it swings its lure in front of its mouth.

## Model library

[Nessuno6/abyssal-garden-models](https://github.com/Nessuno6/abyssal-garden-models) holds animated models for the game.
Each keeps its own licence, listed there with credits. **Models → Library → Browse models** lists them and adds one
in one tap (it downloads the `.glb` from GitHub). Add a submarine and then its interior.

## Credits

* Original Abyssal Garden by [Noniv](https://github.com/Noniv/abyssal-garden) (MIT).
* Player diver: ['Diver' by nolanfa](https://sketchfab.com/3d-models/diver-9ee9b8b722ed457da424869cd8d08b1a),
  CC-BY 4.0, rigged and animated in Blender for this project.
* AMD FidelityFX Super Resolution 1.0 (EASU, RCAS), MIT, ported to WGSL.
