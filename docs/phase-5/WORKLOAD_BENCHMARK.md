# FRAME — Phase 5 Workload Benchmark

**Provider usage: not measured.** No model API was called (no key, no authorization for paid calls), so
provider-reported input/output/reasoning tokens, model calls and end-to-end agent time are unavailable.
Token figures use the repository heuristic (`bench/tokens.ts`, ±20 %) on **exact** payloads produced by real
commands. They estimate payload size, not model usage or cost.

## Semantic understanding on real footage

Question: *who is the subject, what kinds of shots are these, where are the event candidates, and how should
a 9:16 crop follow the subject?* Script: `bench/phase5/workload.ts <video> --task <t>`; evidence:
`evidence/workload-*.json`. Real clips (YouTube UGC, CC BY 4.0), 20 s, 640×360.

- **Conventional**: the agent writes a MediaPipe script (counted as FRAME's own minimal worker, 1,842 tokens of
  code), runs it, and reads its per-frame output.
- **Lean conventional**: the same with embeddings and keypoints dropped from what is read.
- Neither conventional variant includes the tracking, subject, scene, reframe and event logic that the FRAME
  brief already contains. An agent would still have to write that code (≈ 600 lines in `semantic.ts`) or
  reason it out over the raw output.

| Clip / task | Path | Tool calls | Agent-written (tok) | Agent-read (tok) | Local time |
|---|---|---|---|---|---|
| Sports_360P-11b7 / `sports` | conventional | 2 | 1,842 | 229,174 | 3.1 s |
| | conventional, lean | 2 | 1,902 | 2,785 | — |
| | **FRAME brief** | **1** | **51** | **788** | 4.3 s (cached 41 ms) |
| Vlog_360P-2e9d / `podcast` | conventional | 2 | 1,842 | 248,646 | 4.3 s |
| | conventional, lean | 2 | 1,902 | 6,908 | — |
| | **FRAME brief** | **1** | **52** | **398** | 5.5 s (cached 47 ms) |

The FRAME time includes the base pass (shots, motion, transitions) as well as the semantic pass. Memory for
both paths is dominated by the MediaPipe worker: 256–292 MB peak (INTELLIGENCE.md §4). The FRAME cache costs
10–14 KB per analysed clip.

How to read these numbers:
- Compared with the **lean** conventional path, FRAME reads 3.5–17× fewer tokens and writes ≈ 37× fewer, in one
  call instead of two. It also returns conclusions (subjects, reframe centre, candidates with evidence) rather
  than detections. Compared with reading the raw output, the reduction is ≈ 290–625×.
- A repeated question costs ≈ 45 ms because the record is content-addressed. A conventional agent re-runs its
  script or keeps its own cache.
- These are payload sizes for one decision type on two 20 s clips. They are not an end-to-end editing
  benchmark and say nothing about output quality on their own (scene types are 0.39 accurate; see
  INTELLIGENCE.md).

## Earlier phases (unchanged, for context)

| Benchmark | FRAME | Conventional | Source |
|---|---|---|---|
| Footage cuts/silences/moments, 10 min 1080p (Phase 4) | 1 call, 318 read tok | 3 calls, 281,251 read tok (lean) | `docs/phase-4/WORKLOAD_BENCHMARK.md` |
| Talking-head reel with grade/audio/QA (Phase 3) | 316 output tok, 6 calls, 0 code lines | 2,795 tok, 153 code lines | `docs/phase-3/WORKLOAD_BENCHMARK.md` |

## Needed for a real workload evaluation

1. A provider key and authorization for paid calls, to record per-call usage fields.
2. The same task, footage, model and acceptance criteria run twice: once by an agent with FRAME's MCP tools,
   once by an agent with only a shell. Both scored by the Inspector and a blind human review.
3. Real footage with audio (interviews, matches, product recordings) and labels.
