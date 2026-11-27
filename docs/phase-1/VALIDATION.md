# FRAME — Phase 1 Validation Log

## Comparison: Phase 0 vs Phase 1

| Check | Phase 0 (`bf16ae3`) | Phase 1 (`feat/phase-1-professional-foundation`) | Notes |
|---|---|---|---|
| **TypeScript (`npm run typecheck`)** | PASS (0 errors) | **PASS (0 errors)** | Includes new `security.ts` and all test suites |
| **Unit Tests (`npm test`)** | 150 / 150 PASS (31.3s) | **163 / 163 PASS** (38.5s) | +13 new Phase 1 tests (`security`, `correctness`, `cache-integrity`, `parity`) |
| **E2E Tests (`npm run test:e2e`)** | 70 PASS, 0 FAIL, 3 SKIP (263.0s) | **70 PASS, 0 FAIL, 3 SKIP** | Initial run had 1 failure in `cli-status.test.ts` (Windows 8.3 temp path mismatch); fixed in `api.ts` and `cli-status.test.ts` passed 2/2 |
| **Readiness Smoke (`examples/readiness/smoke.mjs`)** | PASS (204 script, 45 raw frames) | **PASS** (204 script, 45 raw frames) | Matches Phase 0 |
| **Canvas Explainer + QA (`render.mjs` + `qa.mjs ../trial-final`)** | Not pre-rendered | **PASS** (1,200 frames, `minMeanLuma: 15.28`, 0 blank frames) | Rendered via `examples/explainer/render.mjs` then verified with `qa.mjs` |
| **Doctor (`node bin/frame.js doctor`)** | FFmpeg 9.0 ready; Whisper absent | **PASS** (FFmpeg 9.0 ready; Whisper absent) | Verified via new `frame` CLI entrypoint |
| **Token Bench (`npm run bench`)** | 217 out / 19,154 in (`standard`) | **217 out / 20,260 in (`standard`)** | `static/turn` 2,534 (+158 tok for `video_doctor` + parity params); output reduction remains **83.8x** vs 18,187 baseline |

## Platform Notes & Remaining Limitations
- **Windows-skipped E2E tests (3)**: `ulimit -n 96` test (no `ulimit` on Windows) and two 430-input single-pass FFmpeg reference comparisons (`win32` handle limit). Linux/macOS CI verification is pending GitHub Actions run on the pushed PR.
- **Speech recognition**: `whisper.cpp` and `faster-whisper` remain absent on this host; live ASR accuracy is not claimed.
