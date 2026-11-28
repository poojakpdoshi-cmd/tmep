# FRAME — Phase 6 Workload Benchmark (6.3)

**Provider usage: not measured.** No model API was called (no authorized integration, no paid calls).
Token figures are the repository heuristic (`bench/tokens.ts`, ±20 %) over exact request payloads; they
estimate what an agent must write, not model usage or cost.

## Complete reels from real footage (identical requirements, frozen rubric)

Source: `evidence/production-eval.json` (two *Tears of Steel* dialogue segments, CC BY 3.0).

| Measure | Previous workflow (Phase 5 interface) | FRAME production (Phase 6) |
|---|---|---|
| Tool calls per reel | 8 (import, transcribe, brief, format, plan build, plan compile, captions/format, render) | **3** (import, transcribe, `video_plan {mode:"produce"}`) |
| Agent-written payload | 508 tok | **274 tok** (−46 %) |
| Agent-written code | 0 lines (both use structured calls) | 0 lines |
| Decisions the agent must make | pause threshold, which plan items to drop, caption band, format, render quality | genre + constraints only; everything else is decided locally and reported |
| Wall time (A / B) | 70.2 s / 94.6 s | 70.2 s / 100.0 s |
| Peak Node RSS (A / B) | 183 / 223 MB | 228 / 248 MB |
| Revision after a change (e.g. captions off) | redo plan + compile + edit + render (agent re-issues ≥ 4 calls) | 1 `revise` call; only strategy → fine → finish → preview → inspect → correct (→ final) recompute |
| Persistent state | plan file only | `frame.production/1`: stage hashes, revisions, decisions, open questions |

Quality is **not** implied by these numbers: on the frozen rubric FRAME scored 23 and 25 / 30 against
25 and 28 for the previous workflow at evaluation time (captions placement; see PRODUCTION_EVAL.md).

## Local work FRAME performs instead of the agent
Footage analysis (cuts, transitions, camera motion, subjects, scene types), transcript-driven retention and
target fitting, effect budgeting per genre, caption band choice, subject-aware reframing, licence-gated
asset selection, preview render, prioritized inspection, bounded corrections, final render — all
deterministic and cached (content-addressed footage records; per-stage hashes).

## Earlier phases (unchanged, for context)
| Benchmark | FRAME | Conventional | Source |
|---|---|---|---|
| Semantic footage brief, 20 s real clips (Phase 5) | 1 call, 398–788 read tok | 2 calls, 2,785–6,908 read tok (lean) | `docs/phase-5/WORKLOAD_BENCHMARK.md` |
| Footage cuts/silences/moments, 10 min 1080p (Phase 4) | 1 call, 318 read tok | 3 calls, 281,251 read tok (lean) | `docs/phase-4/WORKLOAD_BENCHMARK.md` |

## Needed for a real model-token evaluation
A provider key with authorization for paid calls, then the same reel task run by an agent with FRAME's
tools and by one with Phase 5 tools (and one with only a shell), recording per-call usage fields, scored by
the Inspector plus blind human review against RUBRIC.md.
