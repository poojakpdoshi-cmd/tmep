# FRAME — Phase 3 Effects, Colour, Audio & Editing Architecture

## 1. Advanced Editing Primitives (Stage 3.1)
Exposed via `packages/core/src/ops.ts`, `packages/core/src/timeline.ts`, `packages/render/src/graph.ts`, and `packages/render/src/audio.ts`:
- **J-cuts & L-cuts**: `jcut <clip> <d>` and `lcut <clip> <d>` attach audio lead/trail offsets to clips.
- **Variable Speed & Speed Ramps**: `ramp [clip] keys="0:speed=1;3:speed=2;6:speed=1"` integrates `1/speed(u)` over 256 deterministic steps for exact frame counts (`clipFrames`) and compiles piecewise `setpts` + synchronized `atempo` chains.
- **Freeze Frames**: `freeze <at> <d>` splits the clip at the resolved anchor and inserts a silent `freeze` clip holding the exact frame (`trim=end_frame=1,loop=loop=-1:size=1`).
- **Reverse Playback**: `reverse [clip] <true|false>` applies `reverse` (video) and `areverse` (audio).
- **Smooth Punch-In/Out**: `punch <at> to=1.2 d=1.2` compiles eased ramp-up, hold, and ramp-down keyframes.
- **Match-Cut**: `matchcut <fromClip> <toClip> [scale=1.08] [d=0.2]` aligns exit/entry scale and optional dissolve.
- **Dynamic Reframing**: `reframe [clip] cx=... cy=... keys=...`.
- **Stabilization**: `stabilize [clip] [smoothing=10] [shakiness=5]` compiles FFmpeg `deshake` (quantized to multiples of 16 for FFmpeg compatibility).
- **Split-Screen, PiP & Parallax**: `splitscreen`, `pip`, and `parallax` compile declaratively to `BRoll` layers with `kf` transforms, `mask` crops, and explicit `z` order.
- **Motion Blur & Perspective**: `fx mblur` (`tmix`) and `fx persp` (4-corner `perspective`).

## 2. Advanced Effects & Compositing (Stage 3.2)
- **Blur & Glow**: `fx blur mode=gaussian|directional sigma=...` (`gblur` / `boxblur`), `fx glow radius=... intensity=...` (`split` + `gblur` + `blend=all_mode=screen`).
- **Drop Shadow & Blend Modes**: `fx shadow` (alpha-extracted blurred offset shadow on overlays), `fx blend mode=multiply|screen|overlay|...`.
- **Concave & Bezier Masks + Animated Mask Keys**: `fx mask shape=concave|bezier` are pre-rasterized via `@napi-rs/canvas` into content-hashed PNGs in `.tmep/cache/masks/`; `rect`/`ellipse` masks also support animated `keys`.
- **Chroma Key**: `fx chromakey color=#00ff00 similarity=0.14 blend=0.08 despill=true`.
- **Reusable Chains & Transition Presets**: `EFFECT_CHAINS` (`cinematic-vignette`, `soft-glow-warm`, `crisp-callout`, `dreamy-blur`, `chroma-clean`) and `TRANSITION_PRESETS` (`cinematic-dissolve`, `whip-pan-left`, `whip-pan-right`, `luma-fade`, `flash-cut`, `iris-open`).

## 3. Colour Pipeline (Stage 3.3 — `packages/render/src/color.ts`)
- `detectColorSpace()` probes input `color_space`, `color_primaries`, `color_transfer`, and HDR flags.
- `colorFilterChain()` compiles input BT.601/BT.2020/HLG/PQ → BT.709 conversion, `eq` (exposure/contrast/saturation), `colortemperature`, `colorbalance` tint, `vibrance`, `curves` (highlights/shadows/RGB), `lut3d` (`.cube`), and `vignette`.
- `computeShotMatch()` (`api.colormatch`) uses FFmpeg `signalstats` to compute deterministic exposure, contrast, saturation, and white-balance deltas between reference and target clips.
- Final muxing applies `BT709_OUTPUT_TAGS` (`-colorspace bt709 -color_primaries bt709 -color_trc bt709`).

## 4. Audio Post-Production (Stage 3.4 — `packages/render/src/audio.ts`)
- Per-clip `AudioClipPost`: `highpass`, `lowpass`, `afftdn` noise reduction, `dialogue`/`warm`/`crisp` EQ, de-essing (`6.5 kHz` dynamic cut), `acompressor` (`light`/`medium`/`heavy`), and custom fade-in/out.
- Master bus (`AudioMaster`): platform targets (`reels`, `shorts`, `tiktok`, `youtube`, `podcast`, `broadcast`, `cinema`), `alimiter`, and **two-pass `loudnorm`** (Pass 1 `print_format=json` measurement → Pass 2 `linear=true` normalization).
