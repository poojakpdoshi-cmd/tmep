# FRAME — Phase 4 Workload Benchmark

**Provider usage: not measured.** No model API was called (no key in this environment, and no paid
calls were authorized). Input/output/reasoning tokens reported by a provider, model calls and real
completion time are therefore unavailable. Token figures below use the repository's heuristic tokenizer
(`bench/tokens.ts`, ±20 %) over **exact** payloads produced by real commands; they are estimates of size,
not of model usage or cost.

## Footage understanding: "where are the cuts, silences, loud moments and free regions?"

Script: `bench/phase4/workload.ts <video> --task <t>`; evidence: `evidence/workload-*.json`.
The conventional path runs the standard FFmpeg analyses an agent would use (scene-change `showinfo`,
`silencedetect`, per-second `astats`) and must read their output; the lean variant has the agent write
`grep` filters to read only the relevant lines. Neither conventional variant includes the reasoning
still needed to turn logs into moments, scenes, quality flags and screen regions — FRAME's brief already
contains them.

| Media | Path | Tool calls | Agent-written (tok) | Agent-read (tok) | Local time |
|---|---|---|---|---|---|
| 16 s montage, task `sports` | conventional | 3 | 256 | 58,796 | 0.8 s |
| | conventional, lean | 3 | 324 | 7,557 | — |
| | **FRAME brief** | **1** | **44** | **647** | 0.75 s (cached: 3 ms) |
| 10 min 1080p, task `generic` | conventional | 3 | 247 | 1,863,003 | 27.4 s |
| | conventional, lean | 3 | 315 | 281,251 | — |
| | **FRAME brief** | **1** | **45** | **318** | 19.6 s (cached: 2 ms) |

Reading these honestly:
- Against the **lean** conventional path, FRAME reduces agent-read tokens by ≈ 12× (16 s) and ≈ 880× (10 min),
  and agent-written tokens by ≈ 7×, with one call instead of three. The long-form ratio is dominated by
  per-second loudness, which a conventional agent would have to summarize with more code — the work FRAME
  does locally.
- These are **estimates of payload size** for one decision type. They are not an end-to-end editing
  benchmark and say nothing about output quality on their own.

## Earlier phases (unchanged, for context)

| Benchmark | FRAME | Conventional | Source |
|---|---|---|---|
| 20 s reel + revision (Phase 0) | 217 output tok, 6 calls | 18,187 (scripted lower bound) | `bench/token-bench.ts`, re-measured in Phase 0 |
| Talking-head reel with grade/audio/QA (Phase 3) | 316 output tok, 6 calls, 0 code lines | 2,795 tok, 153 code lines | `docs/phase-3/WORKLOAD_BENCHMARK.md` |

## What is needed for a real workload evaluation

1. A provider key (and authorization for paid calls) to record input, output and reasoning tokens per
   model call through the provider's usage fields.
2. The same task, footage, model and acceptance criteria run twice — an agent with FRAME's MCP tools and
   one with only a shell — scored by the Inspector plus a blind human review.
3. Licensed real footage (informative, sports, cinematic, product) — blocked in this environment.
The harnesses above are the local half of that design; the 80–95 % reduction target remains a research
target, not a result.
