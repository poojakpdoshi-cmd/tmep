# ARCHITECTURE.md — FRAME System Architecture

**FRAME** (*Footage Reasoning and Agent-driven Media Editing*, formerly TMEP) is a local-first, workspace-based TypeScript/Node.js media-production engine using the **Token-Minimal Editing Protocol (TMEP)**.

## AI Workload Offloading Responsibilities

FRAME reduces external agent work by delegating deterministic computation locally across six architectural responsibilities:

- **FRAME Intelligence**: Local footage analysis (transcripts, silence, shot-cut pacing; footage understanding is Phase 4B).
- **FRAME Director**: Context-aware creative direction, restraint profiles, and pacing selection.
- **FRAME Compiler**: Declarative intent-to-edit compilation (layout, measured text wrapping, alignment, keyframes, easing, safe zones, dry-run validation).
- **FRAME Engine**: Deterministic timeline ops, revisions, and FFmpeg/Canvas/libass rendering.
- **FRAME Inspector**: Automated quality checks and safe deterministic layout corrections (overflow, collisions, safe zones, timing, blank frames).
- **FRAME Optimizer**: Content-addressed caching, decision reuse, compact DSL, and minimal tool calls.

## Package Dependency Graph

```
packages/mcp (stdio JSON-RPC) ─┐
packages/cli (CLI commands)   ─┼─▶ packages/engine (orchestration API)
                               │       ├──▶ packages/core (timeline, ops, project, effects, scene, schema)
                               │       ├──▶ packages/speech (whisper.cpp, faster-whisper, analyze, hinglish)
                               │       ├──▶ packages/story (planner, templates, rules, storyboard, script, reference)
                               │       └──▶ packages/render (render, graph, effects, audio, sfx, stage, jobs, recovery)
                               │               ├──▶ packages/motion (ass, captions, presets, scene, vector, fonts, icons)
                               │               └──▶ packages/media (ffmpeg, exec, chrome, reference)
```

## Core Subsystems

- **Timeline & Revisions (`packages/core`)**: Frame-quantized clip layout (`fps`-aligned), deterministic `TimeRef` anchoring, 23 atomic TMEP ops, and immutable JSON revisions (`revs/rNNNN.json`) with file locking.
- **Engine (`packages/engine`)**: Unified `api.ts` entrypoint shared by MCP and CLI, enforcing workspace boundaries, project locking, and job orchestration.
- **Rendering (`packages/render`)**:
  - **Video**: Unit-based FFmpeg filtergraph compilation (`graph.ts`) splitting at hard cuts, joining transitions with `xfade`, compositing z-ordered `broll` + `gfxOverlays` (`overlay`), and burning top-level `gfx.ass` (`subtitles`).
  - **Audio**: 3-stage bounded pipeline (`audio.ts`) producing sample-exact speech chunks, windowed synthesized SFX (`sfx.ts`), sidechain-ducked music, and conditional `loudnorm`.
  - **Staging & Recovery**: Worker pool (`stage.ts`), atomic `publish()`, filter-script fallback (`-/filter_complex` / `-filter_complex_script`), PID-scoped crash recovery (`recovery.ts`), and `.cancel` marker polling (`jobs.ts`).
- **Motion (`packages/motion`)**: Dual path—`libass` (`ass.ts`, `captions.ts`, `presets.ts`, `icons.ts`) and `@napi-rs/canvas` Skia rasterization (`vector.ts`, `scene.ts`, `paths.ts`) with SAT collision & safe-area validation. Phase 4A adds kinetic text, path morphing, motion paths, reveals, 2.5D depth/parallax, shutter motion blur and depth of field to the Canvas path (see `docs/phase-4/MOTION_ENGINE.md`).
- **Composition (`packages/story/src/presets.ts`)**: constraint placement (safe zones, caption band, reserved regions), frame-relative adaptive typography with balanced line breaks, style profiles and motion presets compiled to validated scenes.
- **Media (`packages/media`)**: Safe `spawn(..., { shell: false })` runner (`exec.ts`), FFmpeg/ffprobe wrappers (`ffmpeg.ts`), shot-cut reference analyzer (`reference.ts`), and headless Chrome CDP driver (`chrome.ts`).
- **Speech & Story (`packages/speech`, `packages/story`)**: Local `whisper.cpp` / `faster-whisper` adapters, transcript normalization, Hinglish transliteration, BM25 search, and deterministic rule/template planners.
