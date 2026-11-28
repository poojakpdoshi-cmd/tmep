# FRAME — Phase 5 Progress

- **Branch**: `feat/phase-5-semantic-assets` (from Phase 4 head `f489393`, PR #31)
- **Rule**: real-footage results are reported separately from synthetic ones; nothing is merged without approval.

| Stage | Scope | Status |
|---|---|---|
| 5.0 | Stability: transition undo, timeline rounding, validation, phrase editing, stale locks, gain staging; real-footage evaluation of Phase 4 analysis and effects | **Complete** (`ad13a8f`, `61250f5`) — audio/ASR on real footage blocked (clips are audio-removed; ASR hosts blocked) |
| 5.1 | Semantic footage intelligence in `frame.footage/1` | **Complete** (`ddfc554`) — scene types evaluated and found unreliable (0.39); event recognition not claimed |
| 5.2 | Domain briefs (informative, sports, cinematic, product, podcast, educational) | **Complete** (`ddfc554`) — sports event accuracy not evaluated (no labelled matches) |
| 5.3 | Visual asset engine | **Complete** (`ddfc554`) — retrieval quality on a large real library not measured |
| 5.4 | Structured editing plan → deterministic compile | **Complete** (`ddfc554`) |
| 5.5 | Inspector: moving subjects, shapes, subject-aware crops, overlay placement | **Complete** (`ddfc554`) |
| 5.6 | Workload benchmark | **Complete** (local payload measurements; provider tokens not measured) |

See VALIDATION.md for the gate table and INTELLIGENCE.md for the evaluation.
