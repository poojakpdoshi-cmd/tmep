# FRAME — Professional Editing & Creative Quality Gaps

## 1. Verified Visual & Creative Quality Deficiencies

1. **Sparse, Under-Utilized Storyboard Framing**:
   - `storyboard.ts` and `presets.ts` use fixed, small text/icon geometries with hardcoded colors (`#F2F6FF`, `#214B4B`, `#293C69`, `#70DAC4`), leaving large empty frame areas (Claude Phase 0 reported 27–40% content height and 0.7% ink coverage at sampled timestamps; `QUALITY_REPORT.md` also documents minimal mean luminance `15.284–42.489` in `trial-visual-only.mp4`).
2. **Social Safe-Zone Violations**:
   - `explainer-canvas.mjs:87-92` places captions at `y=1527..1695`, footer at `y=1780`, progress at `y=1820`.
   - `launch-reel.mjs:77-78` places captions at `y=1454..1726`, footer at `y=1785`, progress at `y=1824`.
   - Both intrude into the bottom ~350–400px UI overlay zone of Instagram Reels, TikTok, and YouTube Shorts.
   - `captions.ts` and `compile.ts` perform zero safe-zone validation.
3. **Caption Typography & Readability Defects (`captions.ts`)**:
   - **Fixed positions**: Only 3 rigid `y` ratios (`upper`, `middle`, `lower`), no per-scene avoidance.
   - **Character-based wrapping**: `maxChars` ignores font metrics, `c.size`, and `c.upper`.
   - **Inline kinetic jitter**: `\fscx114\fscy114` (`captions.ts:141`) reflows neighboring words horizontally on the same line, and only `i === 0` gets `\fad(70,0)`.
   - **No clause-boundary breaking**: `paginate` splits on punctuation/pauses/char-count, stranding function words or breaking mid-phrase.
4. **Graphic vs Caption Collisions (`presets.ts` + `compile.ts`)**:
   - Center-band presets (`stat`, `icons`, `bars`, `keyword`, `icon`, `cta`, `lower_third`) directly overlap `middle` captions (`0.5*H`); `bars` in landscape (`0.7*H` base + label padding) crowds `lower` captions (`0.84*H`).
5. **Planner & Template Rigidity (`planner.ts`, `templates.ts`)**:
   - Non-transcribed footage is blindly sliced from `0s` (`planner.ts:86-91`), discarding later highlights, and multi-source duration allocation is skewed by internal silences and uncounted images/non-transcribed clips (`planner.ts:72,83,92,95`).
   - `zooms: false` disables emphasis zooms (`rules.ts`) but leaves `tpl.push` (`0.03`) and `jumpZoom` (`1.08`) active (`planner.ts:105-110`).
   - 6/7 templates share identical `captions.pos: 'lower'`, `fit: 'cover'`, `gfx.lists: true`, `gfx.stats: true`.

---

## 2. Missing Professional Capabilities by Domain

| Domain | Currently Present | Missing Professional Capabilities |
|---|---|---|
| **Editing Fundamentals** | Cut, trim, move, remove, speed, fit (`cover`/`contain`/`blur`), basic `xfade` | J-cuts & L-cuts (audio/video split offsets), match cuts, speed ramps (bezier time-remapping), freeze frames, video stabilization (`vidstab`), intelligent subject/face reframing, multicamera sync/switching. |
| **Visual Effects (VFX)** | `kf` (`s,x,y,r,o`), `mask` (`rect`, `ellipse`, convex `poly`, `feather`, `invert`, `reveal`) | Concave/bezier masks, animated rotoscoping, object/motion tracking, Gaussian/directional motion blur, drop shadows & glow, chroma/luma keying, blend modes (`screen`, `multiply`, `overlay`) for layers, depth/parallax, reusable effect chains. |
| **Motion Graphics** | 11 ASS presets, 32 `\p1` icons, `VisualScene` + `VectorRun` (`path` only), hardcoded Canvas scripts | Generalized declarative Canvas components (cards, callouts, lower-thirds, animated charts/infographics, code blocks, UI mockups), SVG import/animation, shape morphing, 2.5D camera moves, spring physics easing. |
| **Colour** | BT.709 metadata tagging only (`graph.ts:274-282`) | Input color-space conversion (BT.601/HLG/PQ → BT.709), exposure/contrast/saturation/temperature/tint controls, `.cube` LUT application, selective HSL/color wheels, shot-to-shot matching, skin-tone preservation. |
| **Audio** | 3-stage mixer, 6 synthesized SFX, `sidechaincompress` ducking, conditional single-pass `loudnorm` | Dialogue enhancement (HPF, de-esser, EQ, compressor, noise reduction/RNNoise), two-pass `loudnorm` mastering, beat detection & music-cut synchronization, audio fades/crossfade curves (`qsin`/`exp`/`log`), loudness/clipping QA report. |
| **Visual Asset Intelligence** | Local `importMedia`, manual `broll` | Contextual asset search/matching, authentic screen-recording/product-screenshot framing, SVG/diagram library, licensed stock metadata integration, provenance tracking (never misrepresenting synthetic visuals as real footage). |
| **Reference & Video Intelligence** | Hard-cut timestamps via `select=gt(scene,...)` (`reference.ts`) | Shot-type/framing analysis, visual style/palette/typography extraction, audio energy/beat extraction, multimodal scene/action/emotion understanding (future Phase 4+). |
| **Quality Control (QC)** | `probe()` duration/dims/audio check (`render.ts:446-450`), `scene.ts` SAT checks | Automated frame-level QC (ink/contrast/luminance checks, safe-zone overlay audit, caption-graphic collision check across all routes, audio LUFS/true-peak/clipping verification). |
