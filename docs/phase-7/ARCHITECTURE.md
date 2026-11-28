# FRAME Phase 7 — Architecture changes

Phase 7 extends existing modules; it adds no MCP tool (the surface stays at 10, test-enforced) and keeps every
TMEP alias (`tmep/1`, MCP key `tmep`, `.tmep/`, `tmep` bins, `TMEP_*`).

```
footage ──► analyzeFootage (FOOTAGE_VERSION 7a.1)
             └─ semantic pass (2 fps; true FFmpeg timestamps)
             └─ mouth pass (5–8 fps, faceMesh)  ──► speaker.ts: faceTracks → activeSpeakers → speakerFraming
                                                    inferred.speakers + inferred.reframe (subject "active speaker")
Director (direct) ── framing / sfx / min decisions, split screen → open decisions
plan.ts ── speaker reframe with cut-safe smoothFollow, motivated jump-cut punches
production.ts ── roughcut: fitRanges (+ extendWithBeats for `min`)
               ── motion: gfx (+ SFX on graphic entrances when allowed)
               ── inspect: inspector.ts + footage-qa.ts + editorial-qa.ts (objective / advisory / preference)
               ── correct: verified corrections (below)
```

## Verified correction loop (`production.ts › correct`)
1. Candidates: objective findings with `fixOps` (Inspector) plus the Phase 6 placement fixes.
2. Refuse any op that contradicts an explicit instruction (`conflicts()`), e.g. captions on when declined,
   a colour look without `allowLook`, a different ratio.
3. Apply on a new revision; render only the finding's range (+0.5 s) as a preview; re-inspect.
4. Keep when the finding is gone, no new objective finding appears and the objective count drops; otherwise
   check out the previous revision.
5. Each finding is tried once, at most `MAX_CORRECTION_CYCLES` (2) cycles; the best verified revision stays
   current. The stage output lists every attempt, its verdict and reason, and states that no objective
   findings is not proof of creative quality.

Dependency-aware invalidation is the Phase 6 stage-hash chain: a correction changes the `correct` revision,
so only `final` re-renders; a constraint change recomputes the stages whose strategy section changed.

## New and changed files
| File | Purpose |
|---|---|
| `packages/media/src/speaker.ts` | face tracks, speech mask, active speakers, speaker-aware framing |
| `packages/media/py/semantic.py` | `mouth` task (FaceLandmarker blendshapes, head crops from pose); true frame timestamps |
| `packages/media/src/models.ts` | `faceMesh` model (Apache-2.0, 3.7 MB, pinned SHA-256; download only with confirmation) |
| `packages/render/src/editorial-qa.ts` | editorial Inspector checks |
| `packages/engine/src/production.ts` | verified corrections, `extendWithBeats`, SFX on graphic entrances |
| `packages/story/src/director.ts` | `framing`, `sfx`, `min`; split-screen open decisions |
| `packages/story/src/plan.ts` | speaker reframe reasons, cut-safe follow smoothing, motivated jump-cut punches |
| `packages/speech/py/sherpa_asr.py`, `packages/speech/src/engines.ts` | Parakeet / multilingual Whisper / per-language models |
| `.github/workflows/ci.yml`, `packages/cli/src/main.ts` | Windows FFmpeg install, preflight, `doctor --require` |

## Resource bounds
The mouth pass is skipped above 15 minutes and when the model, audio or people are absent; it is ≈ 69 ms per
frame at 1 280 px with ≈ 310 MB worker RSS. The per-production lock, cancellation and resume are unchanged.
