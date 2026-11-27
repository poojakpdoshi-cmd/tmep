# FRAME — Phase 2 Validation Log

## 1. Automated Test Results

| Check | Result | Notes |
|---|---|---|
| **TypeScript (`npm run typecheck`)** | **PASS (0 errors)** | Covers all packages and new Phase 2 test suites |
| **Unit Tests (`npm test`)** | **168 / 168 PASS** (34.8s) | Includes Phase 1 tests + `canvas-primitives.test.ts`, `compiler.test.ts`, `captions-autocorrect.test.ts` |
| **Phase 2 Demonstrations (`node examples/phase-2-demos/run.ts`)** | **5 / 5 PASS** | `01-tech-explainer`, `02-product-demo`, `03-sports-stats`, `04-educational-diagram`, `05-talking-head-captions` (with `-sheet.jpg` contact sheets & `qa-report.json`) |

## 2. Before vs After Comparison (Phase 0 `libass`/Storyboard vs Phase 2 Generalized Canvas + Compiler)

| Dimension | Phase 0 (`libass` / `storyboard.ts`) | Phase 2 (`VisualScene` Canvas + `compileIntent`) |
|---|---|---|
| **Primitives** | Flat `text`, `rect`, `polygon`, `ellipse`, `path` | Added `rrect`, `gradient` (linear/radial), `shadow`, `clip`, `chart` (`bar`/`hbar`/`line`/`ring`), Canvas `image` with radius/shadow, `spring` easing |
| **Typography & Wrapping** | Character-count `maxChars` estimation | `@napi-rs/canvas` `ctx.measureText` pixel-width wrapping + `fitFontSize` auto-shrink |
| **Kinetic Captions** | Inline `\fscx114` scaling (horizontal word reflow jitter) | Zero-reflow accent/border emphasis + clean fade-out |
| **Safe Zones & Collisions** | None in `captions.ts`/`compile.ts`; hardcoded Canvas demos violated bottom ~360px | Platform-aware safe zones (`reels`, `shorts`, `tiktok`, `youtube`, `square`), `caption-avoidance`, `presenter-avoidance`, and `autoCorrectScenes` |
| **Agent Interface** | Hardcoded `explainer-canvas.mjs` (unexposed via MCP) | Exposed via `video_plan({ intent, dryRun })`, `video_edit({ dryRun })`, and `tmep compile` |

## 3. Documented Limitations
- All 5 Phase 2 demonstrations use **synthetic media and telemetry** for deterministic verification; live spoken narration accuracy remains unverified without local Whisper.
- Automatic face/gesture detection for `reservePresenter` is **not** implemented (reserved for future Phase 4 multimodal intelligence); presenter regions are supplied explicitly.
- Phase 1 `windows-latest / node 24.x` CI had 1 pre-existing timing flake in `tests/job-persistence.test.ts:171` (5/6 other OS/Node matrix jobs passed 100%).
