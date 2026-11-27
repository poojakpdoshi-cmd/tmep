# FRAME — Evidence-Based Development Roadmap

This roadmap sequences work strictly from verified Phase 0 findings. **Do not begin Phase 1 during Phase 0.**

---

## Phase 1: Reliability, Security, Concurrency & Agent Foundation

**Objective**: Make the existing engine concurrency-safe, security-hardened, cache-sound, and fully accessible to MCP agents with a canonical instruction system.

### Workstreams
1. **Concurrency & Core Correctness**
   - Move `edit`, `plan`, `storyboard`, and `Project.open` read-modify-write cycles inside `Project.withLock()` (`api.ts`, `project.ts`); fix `withLock` stale-lock unlink race (PID/token ownership) and support reentrancy.
   - Add `clipId` to `TimeRef` (`timeline.ts`) so `anchorAt` → `srcToTl` and `zoom` (`ops.ts`) bind to the exact clip instance on reused footage.
   - Unify `srcToTl` and `tlToSrc` against frame-quantized `p.dur`; remove 1ms `anchorAt` rounding mismatch (`timeline.ts:377`); preserve anchored items across `splitClip` sliver drops.
   - Enforce `Number.isInteger` on `revision()` and `checkout()` (`project.ts:194-261`); validate `jobPath(id)` against path traversal (`project.ts:101-103`).
2. **Security Hardening & MCP/CLI Parity**
   - Enforce project-root path containment across `mcp/server.ts`, `engine/api.ts`, `cli/main.ts`, and `render.ts` for `project`, `out`, `importMedia`, `transcribe`, and `script`/`storyboard` inputs.
   - Stop `video_inspect` (`readOnlyHint: true`) from mutating disk when project does not exist.
   - Implement `notifications/cancelled` handling in `mcp/server.ts` using per-request `AbortController`.
   - Expose `doctor`, `transcribe-batch`, `storyboard`/`script`, `edit.ratio`, and `render` (`rev`, `parallel`, `encoder`) via MCP; shrink `help('storyboard')` (~7,096 tok) and `help('scene')` (~6,164 tok) into compact DSL summaries.
3. **Render Cache & Reproducibility**
   - Write `${outPath}.tmep` **only after** `probe()` verification succeeds (`render.ts:439-450`).
   - Re-validate disk `mtime`/`size` (and full/head-tail hash) in `mediaMap()` (`render.ts:94-103`) and probe cached unit/audio artifacts.
   - Add `package-lock.json` for reproducible dependency installation.
4. **Canonical Agent Instruction System & Core Skills**
   - Author `AGENTS.md`, `CLAUDE.md`, `INSTRUCTIONS.md`, `QUALITY_STANDARDS.md`, `ARCHITECTURE.md`, `ROADMAP.md`.
   - Author modular on-demand skills: Creative direction, Professional editing, Visual storytelling, Typography & captions, Token optimization, Quality control.

### Phase 1 Acceptance Gates
- Concurrent multi-process `edit` test passes with 0 lost updates.
- Security regression suite blocks `../` traversal on `out`, `project`, `job`, `importMedia`, and `transcribe`.
- `notifications/cancelled` aborts in-flight MCP `video_render`/`video_transcribe`.
- Failed `probe()` never leaves a `.tmep` cache hit; `npm ci` works with committed lockfile.
- `AGENTS.md` + core skills active; `help('storyboard')` under 1,000 tokens.

---

## Phase 2: Generalized Canvas Composition, Typography & Creative Quality

**Objective**: Eliminate low-ink/overlapping `libass` layouts and generalize the demonstrated Skia Canvas quality into a reusable, MCP-accessible composition engine.

### Workstreams
1. **Generalized `CanvasRun` Engine (`motion/scene.ts`, `vector.ts`)**
   - Extend `VectorLayer` to declarative `rrect`, `gradient`, `text` (using `resolveFont` + `GlobalFonts` + `ctx.measureText`), `image`/`clip`, and `chart` primitives.
   - Refactor `explainer-canvas.mjs` and `launch-reel.mjs` patterns into reusable `VisualScene` templates/components accessible via `storyboard` and `video_edit`.
2. **Typography, Captions & Safe-Zone Engine (`motion/captions.ts`, `presets.ts`, `compile.ts`)**
   - Replace character-based wrapping with `ctx.measureText` pixel-width wrapping and clause-boundary breaking.
   - Fix `kinetic` active-word horizontal reflow jitter (fixed-advance or Canvas-rendered word highlights).
   - Enforce platform-specific safe zones (e.g., 9:16 bottom `>= 360px` clearance) and global collision checks between `captions` and all `gfx`/`CanvasRun` layers.
3. **Planner & Storyboard Improvements (`story/planner.ts`, `templates.ts`)**
   - Fix `zooms: false` to suppress `push` and `jumpZoom` (`planner.ts:105-110`).
   - Fix multi-source duration allocation and non-transcribed clip selection (energy/scene-aware sampling instead of blind `0s` start).
   - Diversify template presets beyond repetitive defaults.
4. **Chrome Driver Hardening (`media/chrome.ts`)**
   - Add CDP `send()` timeouts, `ws.onclose` rejection, process cleanup on `launch()` failure, and `AbortSignal` support.

### Phase 2 Acceptance Gates
- Generalized `CanvasRun` renders reusable cards/charts/diagrams at >=1x real time with 0 safe-zone violations.
- Automated collision & safe-zone QC suite passes on 9:16, 16:9, and 1:1 exports.
- `zooms: false` produces 0 zoom/push keyframes across all clips.

---

## Phase 3: Professional Audio, Colour, VFX & Asset Intelligence

**Objective**: Close the professional post-production gaps across colour, audio mastering, VFX, and authentic visual asset workflows.

### Workstreams
1. **Colour Pipeline**: Input color-space normalization (`colorspace`/`zscale` to BT.709), exposure/contrast/temperature/saturation ops, `.cube` LUT support, shot matching.
2. **Audio Post-Production**: Dialogue chain (HPF, EQ, de-esser, compressor, optional noise reduction), two-pass `loudnorm` mastering with true-peak/LUFS verification, beat detection & music-cut sync, configurable `acrossfade` curves.
3. **Editing & VFX Fundamentals**: J-cuts/L-cuts, speed ramps, freeze frames, stabilization (`vidstab`), concave/bezier masks, blur/glow/drop-shadow/chroma-key, layer blend modes.
4. **Visual Asset Intelligence & QC**: Structured asset selection/framing for screenshots, screen recordings, diagrams, and stock media with provenance metadata; automated frame-level & audio-level QC gate (`QUALITY_STANDARDS.md`).
5. **Specialized Modular Skills**: Motion graphics, Informative videos, Sports editing, Cinematic editing, Audio post-production, Colour grading, Compositing, Visual asset selection, Reference analysis.

### Phase 3 Acceptance Gates
- Colour-graded & LUT-processed exports verify BT.709 compliance without clipping.
- Audio mastering hits target LUFS (`±0.5 LU`) and `<= -1.0 dBTP` across speech + music + SFX mixes.
- J/L-cut, speed-ramp, blur, and blend-mode E2E tests pass.

---

## Phase 4: Naming Migration & Multimodal Video Intelligence

**Objective**: Complete the `TMEP` → `FRAME` brand migration and add automated multimodal footage understanding.

### Workstreams
1. **TMEP → FRAME Migration**: Execute `NAMING_MIGRATION.md` (CLI/MCP binaries, `frame.json`/`.frame/` with `tmep.json` compatibility shims, docs, repo rename) while retaining `TMEP` as the internal protocol identifier.
2. **Video Intelligence Engine (Future — Not Started)**: Automated visual + speech + event + sports/narrative understanding that emits a structured editing brief (explicitly separating observed facts with timestamps from inferred creative choices) and executable timeline plan.
3. **Enhanced Reference Analysis**: Upgrade `media/reference.ts` beyond `select=gt(scene,...)` to analyze pacing, shot scale, color palette, typography placement, and audio energy.

### Phase 4 Acceptance Gates
- Legacy `tmep.json` projects open cleanly under `frame` with zero data loss.
- Video intelligence brief schema distinguishes `observed` vs `inferred` fields and passes grounding/hallucination checks.
