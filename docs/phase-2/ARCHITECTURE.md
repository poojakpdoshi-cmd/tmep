# FRAME — Phase 2 Architecture: AI Workload Offloading & Generalized Canvas

## 1. AI Workload Offloading Model

Rather than relying solely on prompt compression, FRAME offloads deterministic media-production work from external AI agents onto local, reproducible computation:

| Responsibility | Role | Phase 2 Status |
|---|---|---|
| **FRAME Intelligence** | Local footage understanding (transcripts, silence, shot cuts, energy) | Transcript/silence/shot-cut active; multimodal understanding is Phase 4 |
| **FRAME Director** | Context-aware creative direction (template/pacing/restraint selection) | Deterministic planner & director profiles |
| **FRAME Compiler** | Declarative intent-to-edit compilation (layout, measured text wrapping, alignment, keyframes, easing, z-order, safe zones, dry-run) | **Implemented in Phase 2** (`packages/motion` + `packages/story` + `packages/engine`) |
| **FRAME Engine** | Frame-exact timeline execution & FFmpeg/Canvas/libass rendering | Active (`core`, `render`, `motion`, `media`) |
| **FRAME Inspector** | Quality validation & deterministic auto-correction (overflow, collisions, safe zones, timing, blank frames) | **Extended in Phase 2** (`motion/scene.ts`, `engine/api.ts`) |
| **FRAME Optimizer** | Context, resource & model-call optimization (content-addressed caching, dry-run, compact DSL, minimal tool calls) | Active (`render.ts`, `mcp/tools.ts`, `bench/`) |

---

## 2. Generalized Canvas Composition (`VisualScene` + `VectorRun`)

`packages/motion/src/scene.ts` and `packages/motion/src/vector.ts` are extended—preserving FFmpeg, `libass`, and Chrome—to support reusable declarative primitives:
- `text` (measured `@napi-rs/canvas` typography, wrapping, alignment, ellipsis/fit)
- `rect` / `rrect` (rounded rectangles, borders, fills)
- `circle` / `polygon` / `path` (SVG/vector paths, stroke/fill, `draw` progress)
- `image` / `video` (rounded/clipped media boxes)
- `gradient` (linear/radial fills) & `shadow` (drop shadows)
- `group` (nested layer hierarchies with inherited transforms/opacity)
- `chart` (bar/line/stat progress diagrams)
- `mask` / `clip` (clipping regions)
- Keyframed `fx` (`s`, `x`, `y`, `r`, `o`), custom easing (`linear`, `in`, `out`, `io`, `back`, `hold`, `spring`), `z` ordering, responsive layout, safe zones, and SAT collision detection.
