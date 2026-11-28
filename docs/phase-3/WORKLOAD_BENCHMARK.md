# FRAME — Phase 3 Workload Evaluation Benchmark (Stage 3.8)

Benchmark script: `bench/phase3-workload-bench.ts`
Task: Build a 9:16 talking-head reel with 2 clips, `cinematic-dissolve` transition, smooth `punch` zoom, deterministic `colormatch`, dialogue EQ + compression + two-pass `-14 LUFS` loudness mastering, safe-zone-clamped `talking_head_reel` scene card, final MP4 render, and automated QA inspection.

## 1. Measured Results (Local Deterministic Run)

| Metric | FRAME (`api.*`) | Conventional Scripting Baseline | Notes |
|---|---|---|---|
| **Tool Calls** | **6** | 8 | `import`, `edit`, `colormatch`, `compile`, `render`, `inspect(qa)` vs probe/stats/canvas/ffmpeg/qa |
| **Editing Revisions** | **3** | 1 (monolithic script) | Undoable, diffable revisions in FRAME |
| **Agent-Generated Code** | **0 lines (0 B)** | 153 lines (9,306 B) | FRAME offloads filtergraphs, Canvas, and QA |
| **Estimated Output Tokens** | **316 tok** | 2,795 tok | Heuristic (`bench/tokens.ts`, ±20%); **8.8× reduction** |
| **Local Wall Time** | 20,976 ms | 1,239 ms | FRAME includes two-pass loudnorm, Canvas raster, colormatch, and full Inspector QA pass |
| **Peak Memory (RSS)** | 101.5 MB | 101.5 MB | Measured via `process.memoryUsage().rss` |
| **Output Size** | 12,734,757 B | 6,501,677 B | Both valid H.264/AAC MP4s |
| **Inspector QA** | **0 defects** (1 advisory) | Not included unless scripted | `qaOk: true` |
| **Task Completion Rate** | **100%** | 100% | Both completed |

## 2. Provider Usage Disclosure
- **Actual Input Tokens**: `unavailable` (`null`) — local deterministic benchmark; no live LLM provider API calls were executed.
- **Actual Output Tokens**: `unavailable` (`null`)
- **Reasoning Tokens**: `unavailable` (`null`)
- No provider billing telemetry was manufactured; token savings (`8.8×`) are explicitly heuristic estimates over serialized tool payloads vs equivalent conventional script code.
