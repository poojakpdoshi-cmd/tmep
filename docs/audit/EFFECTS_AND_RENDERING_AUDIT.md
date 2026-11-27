# FRAME — Effects & Rendering Audit

## 1. Rendering Backends Comparison

| Backend | Primary Files | Strengths | Verified Limitations |
|---|---|---|---|
| **FFmpeg Filtergraph** | `packages/render/src/render.ts`, `graph.ts`, `effects.ts`, `stage.ts` | Deterministic frame-exact unit compilation, `xfade` transitions, z-ordered overlays, hardware encoder support (`nvenc`/`prores`/`libx264`), filter-script fallback for Windows cmdline limits (`stage.ts:67-86`). | Only `kf` (`perspective`/`blend`) and `mask` (`geq`) effects; no blur/glow/color grading/chroma-key; BT.709 metadata tagging only (`graph.ts:274-282`) without input color conversion; `geq` runs on CPU. |
| **libass (`subtitles`)** | `packages/motion/src/ass.ts`, `compile.ts`, `captions.ts`, `presets.ts`, `icons.ts` | Fast text/subtitle burning, alpha-only `.mov`/`.webm` export (`render.ts:222-248`), OpenType font staging (`fonts.ts`). | Fixed `y` ratios, char-based line wrapping, inline `\fscx`/`\fscy` kinetic scaling causes horizontal word reflow jitter, linear `\move` interpolation, 32 simple `\p1` icons, no safe-zone or caption/graphic collision avoidance. |
| **@napi-rs/canvas (Skia)** | `packages/motion/src/vector.ts`, `scene.ts`, `explainer-canvas.mjs`, `launch-reel.mjs` | High visual quality, exact `ctx.measureText` typography, full 2D vector/gradient/card/chart rendering, deterministic frame-state deduplication (`vector.ts:197-201`), SAT collision & safe-area validation (`scene.ts:327-359`). | `explainer-canvas.mjs` and `launch-reel.mjs` are hardcoded, unexposed through MCP/engine, and violate bottom social safe-zones (`y=1454..1824`). `vector.ts` is currently limited to `path` layers in `VisualScene`. |
| **Headless Chrome (CDP)** | `packages/media/src/chrome.ts` | Supports arbitrary HTML/CSS/SVG/WebGL scenes with transparent viewport (`rgba(0,0,0,0)`). | Completely unexposed in `render`/`engine`/`mcp`; `send()` has no timeout or `ws.onclose` handler (`chrome.ts:95-101`); `launch()` can leak browser processes on error (`chrome.ts:76,80`); unbounded `events` array. |

---

## 2. Effects, Keyframes, Masks & Transitions Audit

### Keyframed Transforms (`packages/core/src/effects.ts`, `packages/render/src/effects.ts`)
- **Properties**: `s` (scale), `x`, `y` (translation), `r` (rotation), `o` (opacity).
- **Easings (`EASES`)**: `linear`, `in` (cubic), `out` (cubic), `io` (cubic in-out, default), `back`, `hold` (`gte(p,1)`).
- **FFmpeg Implementation (`transformFilter`, `effects.ts:67-94`)**: Inverse affine transform mapped to a single `perspective` filter (`interpolation=cubic:eval=frame`) on a 2px-padded frame, then cropped.
- **Opacity**: Main-track uses per-frame JS `opacitySchedule()` + `sendcmd` + `blend` (`all_opacity` capped at `0.99999`, `effects.ts:191-198`). Overlays use `geq` + `blend=all_mode=multiply` + `alphamerge` (`effects.ts:226-250`).

### Masks (`maskExpr`, `effects.ts:113-176`)
- **Shapes**: `rect`, `ellipse`, `poly` (minimum signed edge half-plane distance — **convex polygons only**; concave polygons clip incorrectly).
- **Modifiers**: `feather`, `invert`, `reveal` (`center`, `left`, `right`, `top`, `bottom`).
- **Execution**: Computed at half resolution (`W/2 x H/2`) via `geq` (looped 1-frame when static, per-frame when animated) and `bicubic`-upscaled.

### Transitions & B-Roll Fades
- **Main Track Video (`graph.ts:150-156`)**: FFmpeg `xfade` (`p.clip.trans?.type ?? 'fade'`), only between consecutive clips in the same `Unit`.
- **Main Track Audio (`audio.ts:213`)**: Always `acrossfade=ns=${c.x}:c1=tri:c2=tri` (triangular curve regardless of video transition type).
- **B-Roll (`graph.ts:172-174`)**: Hardcoded `0.12s` alpha fade-in/out when `!b.scene`.

---

## 3. Compositing Order (`unitArgs`, `graph.ts:121-272`)

1. **Base track clips**: Decode → `setpts` → `fitChain` (`contain`, `blur`, `cover`) → `zoomExpr` + `perspective` → `compileFx` → pad/trim to `p.frames` → `xfade`.
2. **Z-ordered overlays**: `tl.broll` (default `z ?? 0`) and `gfxOverlays` (`gfx-fx-*.ass` + `VectorRun` PNG sequences, default `z ?? 10`) sorted by `(z, order)` and composited with `overlay=eof_action=pass:enable='between(t,...)'`.
3. **Top-level ASS (`gfx.ass`)**: Burned last on top of all b-roll and graphics via `subtitles=filename=...`.

---

## 4. Audio Pipeline (`packages/render/src/audio.ts`, `sfx.ts`)

- **3-stage bounded architecture**:
  1. **Speech stems**: Content-defined chunks (`minClips: 8, maxClips: 32, every: 8, maxInputChars: 8000`), `aresample=48000`, `fltp` stereo, chained `atempo` (`0.5..2.0`), `volume`, sample-exact `atrim`/`apad`, 12ms/15ms de-click `afade`, `acrossfade`/`concat` → `pcm_f32le` WAV.
  2. **SFX stems**: 6 synthesized WAVs (`pop`, `click`, `ding`, `whoosh`, `riser`, `swoosh`), windowed (`maxSfx: 32`), `adelay` + `volume` + `amix(normalize=0)`.
  3. **Final mix**: Speech + optional looped/faded `tl.music` with `sidechaincompress` (`threshold=0.02:ratio=8:attack=20:release=380:makeup=1`) + SFX + conditional single-pass `loudnorm=I=${tl.loudness}:TP=-1.5:LRA=11` (when `tl.loudness < 0`) → AAC `192k` 48kHz.
- **Verified Strength**: Sample-exact chunking invariance and dense SFX overlap (400 effects) verified by E2E audio parity tests.

---

## 5. Cache, Verification & Colour Defects

1. **Premature `.tmep` Cache Marker (`render.ts:437-450`)**: `outPath` and `${outPath}.tmep` are written **before** `probe(outPath)` verification. A failed verification leaves a broken file that subsequent renders accept as `cacheHit: true` (`render.ts:343-346`) without re-verifying.
2. **Unvalidated Disk Media (`render.ts:94-103`)**: `mediaMap()` checks `exists(a.path)` and trusts `a.hash` from manifest without re-hashing or checking `mtime`/`size`.
3. **Unvalidated Unit/Audio/Vector Cache Hits (`render.ts:313-315, 338, 385`)**: Cached units, audio, and vector PNG sequences are trusted on `exists()` alone.
4. **Default Timestamped `outPath` (`render.ts:219`)**: `render-${Date.now().toString(36)}` prevents `finalKey` cache hits when `opts.out` is omitted.
5. **Colour Tagging Without Conversion (`graph.ts:274-282`)**: Tags output `bt709` without converting BT.601 or HDR inputs.
6. **Verification Scope (`render.ts:445-465`)**: Only checks `probe` duration/dimensions/audio presence; does not check visual quality, clipping, safe zones, or ink coverage.
