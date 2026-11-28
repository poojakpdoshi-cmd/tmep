# FRAME — Phase 7 Progress

- **Branch**: `feat/phase-7-quality` from Phase 6 head `66663ca` (PR #33). Stacked draft PR #34; no merge without approval.
- Evidence: `docs/phase-7/evidence/`. Details: [INTELLIGENCE](INTELLIGENCE.md) · [ARCHITECTURE](ARCHITECTURE.md) · [PRODUCTION_EVAL](PRODUCTION_EVAL.md) · [WORKLOAD](WORKLOAD.md) · [VALIDATION](VALIDATION.md) · [USER_FOOTAGE_EVAL](USER_FOOTAGE_EVAL.md)

| Stage | Status | Result |
|---|---|---|
| 7.0 closure | done | Root cause: on a Windows runner `choco install ffmpeg` left no ffmpeg/ffprobe on PATH; FFmpeg tests skipped and 3 unguarded tests failed. Retried + verified install with a GitHub-hosted fallback, FFmpeg preflight before tests, `tmep doctor --require` (exit 2 + remedy), guarded tests. 6/6 CI on every Phase 7 push |
| 7.1 accuracy | done, targets partly missed | ASR clean read English 9.6 % WER (Parakeet; target met); Hindi 34.6 % (missed); film dialogue 33.4 % (was 52.7 %). Scene types 0.696 on untouched frames (Phase 6 model 0.663; target 0.85 missed; group shots 0/6) |
| 7.2 active speaker | done | Two-shot speaker 0.92 when decided (coverage 0.71); speaking face in the 9:16 crop 0.44 → 0.93; no reaction shot called speaker. Worker timestamp drift fixed (2 fps on 25 fps footage drifted 4 %) |
| 7.3 Inspector | done | Editorial checks classed objective / advisory / preference with evidence, time range and fix ops |
| 7.4 corrections | done | Verified: revision → affected-range preview → re-inspect → keep only if fixed without new objective findings; refusal on instruction conflicts; best revision kept; bounded |
| 7.5 Director | done | Active-speaker framing decision, split screen as open decision, SFX only on graphic entrances, `min` length from motivated beats, motivated jump-cut punches, looks/backgrounds still need authorization |
| 7.6 comparison | see PRODUCTION_EVAL | Phase 6 vs Phase 7 on the same segments, requirements and frozen rubric (agent-only rating) |
| 7.7 workload | see WORKLOAD | |
