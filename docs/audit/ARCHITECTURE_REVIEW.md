# FRAME — Architecture Review & Canvas Generalization Plan

## 1. Current Package Architecture

```
packages/mcp (stdio JSON-RPC) ─┐
packages/cli (20 commands)    ─┼─▶ packages/engine (api.ts)
                               │       ├──▶ packages/core (timeline, ops, project, effects, scene, schema)
                               │       ├──▶ packages/speech (whisper.cpp, faster-whisper, analyze, hinglish)
                               │       ├──▶ packages/story (planner, templates, rules, storyboard, script, reference)
                               │       └──▶ packages/render (render, graph, effects, audio, sfx, stage, jobs, recovery)
                               │               ├──▶ packages/motion (ass, captions, presets, scene, vector, fonts, icons)
                               │               └──▶ packages/media (ffmpeg, exec, chrome, reference)
```

### Architectural Strengths to Preserve
1. **Token-Minimal Editing Protocol (TMEP)**: Compact DSL ops (`217` output tokens vs `18,187` baseline, **83.8x** reduction) and deterministic timeline state with revision history.
2. **Bounded 3-Stage Audio Pipeline (`audio.ts`)**: Sample-exact, chunk-invariant speech/SFX/ducked-music mixing that scales to 400+ overlapping effects on Windows without hitting command-line or file-descriptor limits.
3. **Crash-Safe Job & Staging Architecture (`jobs.ts`, `recovery.ts`, `stage.ts`)**: Atomic `publish()`, PID-scoped staging reclamation, `.cancel` marker protocol, and filter-script fallback (`stage.ts`).
4. **VisualScene + SAT Validator (`scene.ts`)**: Unified coordinate space bridging FFmpeg `kf`, `AssDoc`, `BRoll`, and `@napi-rs/canvas` `VectorRun` with per-frame safe-area and collision checks.

### Architectural Weaknesses Identified
1. **Unlocked Read-Modify-Write (`engine/src/api.ts`)**: `edit`, `plan`, and `storyboard` read timeline/assets outside `Project.withLock()`, causing silent lost updates under concurrent agents.
2. **Split Motion Architecture**: High-quality Skia Canvas rendering exists only in hardcoded scripts (`explainer-canvas.mjs`, `launch-reel.mjs`), while agent-accessible `storyboard`/`gfx` routes produce sparse, overlapping `libass` layouts.
3. **Security Boundary Absence**: `mcp/server.ts`, `engine/api.ts`, and `render.ts` lack project-root containment checks for `project`, `out`, `importMedia`, `transcribe`, and `jobPath`.
4. **Anchor Identity Loss (`core/src/timeline.ts`)**: `TimeRef` stores `{ src, t }` without `clipId`, breaking anchor resolution when footage is reused, compounded by 1ms `anchorAt` rounding vs `1e-6` `srcToTl` tolerance.

---

## 2. Generalizing Canvas Composition (Without Prematurely Replacing Backends)

### Why Not Replace libass, FFmpeg, or Chrome?
- **FFmpeg** is irreplaceable for decoding, `xfade`, `sidechaincompress`, `loudnorm`, hardware encoding (`nvenc`/`prores`/`libx264`), and final muxing.
- **libass** remains fast and compact for standard subtitle/caption burning and legacy `.ass` presets.
- **Chrome (`chrome.ts`)** is valuable for complex HTML/CSS/SVG/data-viz templates once hardened (timeouts, crash recovery, MCP exposure).
- **@napi-rs/canvas (`vector.ts`)** already renders deterministic, anti-aliased 2D graphics directly in Node without browser startup overhead.

### Recommended Generalization Path (Extending `VisualScene` + `VectorRun`)
The bridge already exists in `packages/motion/src/scene.ts` and `vector.ts`:
1. **Promote `VectorRun` → `CanvasRun`**: Extend `VectorLayer` in `scene.ts`/`vector.ts` beyond `path` to support declarative `rrect` (cards/badges), `gradient` (linear/radial fills), `text` (measured via `resolveFont` + `GlobalFonts.registerFromPath` + `ctx.measureText`), `image`/`clip` (rounded thumbnails/screenshots), and `chart` primitives.
2. **Unify Safe-Zone & Collision Enforcement**: Route **all** `captions.ts` + `presets.ts` + `CanvasRun` bounding boxes through `validateFrames()` (`scene.ts:327-359`) with platform-aware safe zones (e.g., 9:16 Reels/Shorts bottom UI margin `>= 360px` at 1920h) so stat graphics and captions never collide.
3. **Preserve Frame-State Deduplication**: Keep `vector.ts:197-201` state-signature caching so static frames are rasterized once and referenced by FFmpeg, maintaining >1x real-time throughput.
4. **Expose via MCP**: Expose generalized `storyboard` / `scene` composition through `video_storyboard` / `video_edit` without requiring agents to write raw Canvas JS.
