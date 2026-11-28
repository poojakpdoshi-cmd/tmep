# FRAME — Phase 6 Validation Log

Every result below was produced by a command run on the stated host; nothing is estimated.
Host: Linux x64 container, 4 vCPU, Node v22.23.5, FFmpeg 6.1.1, Python 3.13.18, MediaPipe 1.2.3,
sherpa-onnx 2.0.3, tesseract 5.3.4.

## Entry gate
| Check | Result |
|---|---|
| Phase 5 CI | **6/6 success** at `c4cb121` and head `8ed6833` (run 46145333591) |
| Ancestry | main ⊂ P3 ⊂ P4 ⊂ P5 (`8ed6833`) ⊂ P6 (`feat/phase-6-production`) |
| Existing branches/PRs | untouched; nothing merged |

## Gates
| Gate | Evidence | Result |
|---|---|---|
| All tests pass | typecheck; `npm test`; `npm run test:e2e` | typecheck pass; unit **UNIT_RESULT**; e2e **E2E_RESULT** |
| CI 6/6 | draft PR #33 (ubuntu/windows/macos × Node 22/24) | CI_RESULT |
| Public interfaces | API tests (`tests/phase6-*.test.ts`), MCP `video_plan {mode:"produce"}` (`packages/mcp/test/produce.test.ts`), CLI `tmep produce` | pass |
| Backward compatibility | Phase 0–5 suites unchanged and passing; MCP tool count 10; `tmep/1`, `.tmep/`, `TMEP_*` aliases; library `verified` field kept for old readers; Phase 4 footage cache keys for faces/ocr unchanged (base key bumped by `FOOTAGE_VERSION 6a.1`, which re-analyses) | pass |
| Security | production ids `[a-z0-9-]{1,40}`; evidence/library files resolved inside media roots; `inspect` refuses write actions; downloads pinned by SHA-256 | pass |
| Concurrency | one runner per production (in-process claim + pid lock, dead owner reclaimed) — concurrent `resume` refused (test); project edits keep the Phase 5 lock | pass |
| Bounded resources | correction ≤ 2 cycles; follow keys ≤ 400; library similarity over stored vectors only; semantic sampling 2/1/0.5 fps by length; ASR chunks ≤ 20 s; worker RSS 256–521 MB measured | pass |
| Real-footage results separate | INTELLIGENCE.md / PRODUCTION_EVAL.md (real) vs unit tests (synthetic, marked) | pass |
| No fabricated results | provider tokens reported unavailable; scene target miss, ASR WER, evaluation losses reported as measured | pass |

## Defects found and fixed in Phase 6
| Defect | Found by | Fix |
|---|---|---|
| Semantic worker frames up to 0.25 s late (`fps` filter keeps the last frame of each slot) | train/test feature mismatch (cosine 0.74 between "identical" frames) | exact `select` sampling, output-side seek (`cf1338f`) |
| Scene model NaN (constant-feature sd stored as 0) | first test-set run read 0.081 | `.6g` storage + guard; model unchanged, re-run once (`cf1338f`) |
| Reframe keys (window centres) passed as crop offsets | decoded follow render placed the subject at 0.29 instead of 0.5 | `centreToOffset` in plans and Inspector fixes (`2bfe0ab`) |
| Camera-motion sign error | unit test | content-motion convention (`6568d66`) |
| Close-up activity used invisible hip keypoints | real clip Sports_1d5c | shoulder fallback (`6568d66`) |
| Captions placed beside faces (rule avoided body boxes) | 6.6 evaluation frames | head-aware band (`cae5bc0`) |
| False `av-sync` defects from AAC container padding | 6.6 evaluation (3 of 4 outputs) | decoded-length confirmation (`2fbe69e`) |
| Plan items mapped through an identity range after the rough cut | production e2e test | explicit ranges in `compilePlan` |

## New tests
`packages/media/test/semantic.test.ts` (+camera motion), `packages/media/test/footage.test.ts` (crop offset),
`packages/story/test/director.test.ts` (4), `packages/mcp/test/produce.test.ts`, `tests/phase6-follow.test.ts`,
`tests/phase6-library.test.ts`, `tests/phase6-produce.test.ts`, `tests/phase6-avsync.test.ts`.
