# FRAME — Phase 2 Workload Benchmark

## Controlled Task: 9:16 Sports/Telemetry Card + Chart + Safe-Zone-Checked Render

Executed via `node bench/workload-bench.ts`.

| Metric | FRAME (`compile` + `render`) | Conventional Agent (Custom Script Lower Bound) | Delta / Notes |
|---|---|---|---|
| **Tool Calls** | **4** (`import`, `edit`, `compile`, `render`) | 6 (probe, write Canvas/FFmpeg script, run, mux, probe) | -33% tool calls |
| **Agent-Generated Code** | **0 lines** | 126 lines (representative lower bound) | **100% offloaded** |
| **Editing Revisions** | **2** | n/a (manual script edits) | Deterministic revisioned state |
| **Simulated Output Tokens** | **218** (heuristic ±20%) | **2,233** (heuristic ±20%) | **10.2x** reduction (~90.2%) |
| **Measured Wall Time** | **3,535 ms** | n/a | Includes synthetic clip gen + Canvas + FFmpeg |
| **Peak Process RSS** | **120.1 MB** | n/a | Node + `@napi-rs/canvas` |
| **Output File Size** | **189,750 B** | n/a | Verified MP4 (`h264`/`aac`) |
| **Automatic Corrections** | **1** (`caption-avoidance`) | Manual trial-and-error | Handled locally without extra agent turn |

### Methodology & Caveats
- **Simulated vs Provider-Reported**: All token counts above are **simulated heuristic estimates** (`bench/tokens.ts`, ±20% absolute), **not** provider-reported API billing tokens.
- **TMEP Protocol Benchmark (`npm run bench`)**: Remains **217** output tokens vs **18,187** baseline (**83.8x** reduction).
- **80–95% Total Token Reduction**: Treated as a target across multi-step workflows; single-turn reductions depend on how much raw layout/rendering code the agent would otherwise write.
