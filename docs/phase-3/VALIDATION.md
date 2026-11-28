# FRAME — Phase 3 Validation Log

## 1. Stage 3.0 Closure Verification
- **Git Ancestry**: `git merge-base --is-ancestor feat/phase-1-professional-foundation feat/phase-2-canvas-compiler` = `True` (`feat/phase-2-canvas-compiler` `8a652b1` includes all Phase 1 commits through `16c7575`).
- **CI Matrix Verification**: Run `46065732973` on `feat/phase-2-canvas-compiler` passed **6 / 6** matrix jobs (`ubuntu-latest`, `windows-latest`, `macos-latest` × Node `22.x`, `24.x`).
- **Windows Node 24 Job-Persistence Fix**: Replaced wall-clock-dependent loop termination in `tests/job-persistence.test.ts` + `tests/json-reader-child.ts` with deterministic `stopFile` synchronization and `minWrites` guarantees. Verified locally on Windows Node `v24.19.0`: **7 / 7 PASS** (including tight-loop reader contention with `writeFailures=1`, `readErrors=0`, `leftovers=[]`).
- **Independent Phase 0 Repro (`docs/audit/repro/verify-findings.mjs`)**: Updated so every critical Phase 0 finding runs in its own isolated `check()` block rather than terminating at the first expected rejection. All 9 checks (`1_concurrentEdits`, `2a_nonIntegerRevision`, `2b_jobPathTraversal`, `2c_renderOutTraversal`, `2d_importOutsideRoot`, `3_reusedFootageAnchor`, `4_frameRoundingTail`, `5_readOnlyInspect`, `6_tokens`) returned `remediated: true`.
- **Phase 2 E2E Suite (`npm run test:e2e`)**: **70 PASS, 0 FAIL, 3 SKIP** (Windows `ulimit` and 430-input win32 handle limit).

## 2. Phase 3 Test Suite Results
| Check | Result | Notes |
|---|---|---|
| **TypeScript (`npm run typecheck`)** | **PASS (0 errors)** | Covers all 9 packages + new `color.ts`, `inspector.ts`, `phase3-ops.test.ts`, `phase3-render.test.ts` |
| **Unit Tests (`npm test`)** | **176 / 176 PASS** (final count at `d1e6f9c`, re-verified in Phase 4 Stage 4.0; this row originally read 175 before the last Phase 3 commit) | +7 new Phase 3 unit & FFmpeg render tests (`phase3-ops.test.ts`, `phase3-render.test.ts`) |
| **Phase 3 Demos (`node examples/phase-3-demos/run.ts`)** | **5 / 5 PASS** | 30s talking-head, 31.5s cinematic montage, 28.5s sports highlights, 30s product demo, 60s educational explainer |
| **FRAME Inspector (`api.inspect({ what: 'qa' })`)** | **0 defects** across all 5 demos | Verified A/V duration sync, frame counts, true peak, LUFS, silence, black segments |

## 3. Unresolved Limitations & Platform Notes
- **Speech recognition**: `whisper.cpp` and `faster-whisper` are not installed on this host; live ASR transcription accuracy is not claimed.
- **Stabilization backend**: Uses FFmpeg's built-in `deshake` (with `rx`/`ry` quantized to multiples of 16) rather than two-pass `libvidstab`, which is not required on all FFmpeg builds.
- **Speed ramp audio**: Uses piecewise effective `atempo` matching total ramped duration; continuous pitch-locked time-stretching per frame is not implemented.
- **Source media in demos**: Generated locally (`testsrc2`, `mandelbrot`, Canvas UI, synthesized audio) rather than live-action camera footage to avoid external network/licensing dependencies.
