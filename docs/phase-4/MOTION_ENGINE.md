# FRAME — Phase 4A Motion Engine

Phase 4A extends the existing deterministic Skia Canvas rasterizer (`packages/motion/src/vector.ts`)
and the Visual Scene schema (`packages/core/src/scene.ts`). No new renderer, no new dependency.
Every new field is optional, so existing scenes and cached projects are unchanged in meaning
(`VECTOR_VERSION` v3 re-keys vector rasters).

## 1. Frame-accurate animated masks (render path)

| Before (Phase 3) | Now |
|---|---|
| `rasterizeComplexMaskPng(eff, MW, MH, 0)` — concave/bezier masks rasterized once at t=0 | Animated masks (reveal or >1 key) rasterized per item frame into `.tmep/cache/masks/<hash>/00000.png…` |
| reveal at t=0 → mask fully black for the whole clip | reveal follows the geq semantics: wipe within the shape's bounding box, centre growth, then inversion |
| a file mask replaced every other mask and the opacity of the item | all masks and opacity multiply (`blend=all_mode=multiply`) |
| b-roll spanning units restarted its mask | each unit enters the sequence at the overlay's frame offset |

- Memory is bounded by one canvas at half output resolution; consecutive identical mask states are
  encoded once. Static masks still use a single PNG.
- Cache key: `{v:2, mask, MW, MH, fps, frames}` — any change to the mask, output size or duration
  re-rasterizes; concurrent renders publish atomically (temp dir + rename).
- Keys support `x, y, w, h, feather` and now `r` (rotation, degrees) on the Canvas path.
- Verified: `packages/render/test/animated-mask.test.ts` (decoded frames: keyed motion, reveal
  hidden→visible, continuity across a unit boundary; a mutation that drops the unit offset fails),
  visual before/after `evidence/animated-mask-before-after.png`.

## 2. Easing vocabulary (shared by FFmpeg effects and Canvas scenes)

`linear, in, out, io, back, spring, hold` + **`expo, expoio, circ, smooth` (smootherstep),
`elastic, bounce, snap`** (critically damped). One list (`EASES`) is used by effect keys, scene keys,
camera keys and the FFmpeg expression compiler; a unit test evaluates every FFmpeg expression in JS
and requires agreement with `ease()` to 1e-9 at 21 points.

## 3. Scene layer additions

| Field | Layers | Behaviour |
|---|---|---|
| `anim: {by: char\|word\|line, at, stagger, d, e, from:{o,x,y,s,r}, out?:{at,stagger,d,e,to}}` | text | Kinetic typography. Units are positioned inside the measured line (kerning-aware), so a settled word animation is **pixel-identical** to static text; character units differ only by sub-pixel anti-aliasing (tested). Grapheme segmentation (`Intl.Segmenter`) keeps combining marks (e.g. Devanagari) intact. Offsets are in em. |
| `morph: [{t, d, e}]` | path | Shape morphing between paths with different structure: arc-length resampling (128 pts/subpath), subpath count equalization, winding match and start-point alignment to avoid criss-crossing. Supports M/L/H/V/C/S/Q/T/A/Z, absolute and relative. |
| `motionPath: {d, view?, keys:[{t,p,e}], orient}` | any Canvas layer | Follow a path; default coordinates are frame fractions; keys give arc-length progress; `orient` rotates along the tangent. The collision/safe-area validator checks the layer where it actually travels. |
| `reveal: {from: left\|right\|top\|bottom\|center, at, d, e}` | any Canvas layer | Mask wipe or iris reveal within the layer box. |
| `depth: 0–20` | any Canvas layer | 2.5D multiplane parallax: the camera's pan and zoom apply with factor 1/(1+depth). The validator uses the same factor. |
| scene `mblur: {samples 2–8, shutter}` | moving Canvas layers | Shutter motion blur by additive sub-frame accumulation; static frames stay sharp; moving shapes/text are routed to Canvas automatically when set. |
| scene `focus: {depth, blur}` | layers with `depth` | Depth of field: blur ∝ distance from the focus depth. |

Existing primitives that already covered parts of the brief and were reused rather than duplicated:
group parent/child hierarchies with stagger, camera keys, path draw-on (`draw`), charts with draw
progress, measured wrapping, gradients, shadows and clipping.

## 4. Verification

- `packages/motion/test/motion4a.test.ts` (9 tests, rasterized pixels): easing parity, path parsing
  and arcs, morph correspondence and rendered area, motion path positions, kinetic text equivalence,
  reveal coverage, parallax ratio (depth 3 moves 0.25× — measured within ±0.05), motion blur smear
  (≥3× partial-coverage pixels on the moving edge, static layer unchanged).
- Complete public-API render: `examples/phase-4/motion-demo.ts` — 5.5 s, 1080×1920, 30 fps with
  4-sample motion blur rendered in 19.9 s on 4 vCPU (0.28× real time). Frames inspected:
  `evidence/motion-demo-sheet.png`. The validator rejected two drafts of the demo spec for real
  safe-area violations (right action rail; camera push-in) before it rendered.

## 5. Known limitations

- Collision checks still cover only rect/text pairs; in the demo a motion-path dot crosses the morphing
  shape without a report.
- Motion blur multiplies Canvas raster cost by `samples` for moving frames.
- Morphing interpolates outlines linearly in point space; very different topologies (e.g. a ring to a
  disc) morph correctly in area but not with semantic intent.
- The geq (non-Canvas) mask path ignores mask key rotation `r`.
