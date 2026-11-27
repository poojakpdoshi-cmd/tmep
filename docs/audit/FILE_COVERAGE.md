# FRAME (formerly TMEP) — Phase 0 File Coverage Manifest

- **Repository**: `https://github.com/poojakpdoshi-cmd/tmep`
- **Verified Commit**: `bf16ae30463b87f4e9c9c210b134064d89e7604a` (`main`)
- **Audit Branch**: `audit/phase-0-forensic`
- **Total Tracked Files**: 166 (`git ls-files`)
- **Coverage Status**: 166 / 166 tracked files accounted for; all 9 `packages/*/src` (plus `packages/speech/py`) source modules forensically inspected.

---

## 1. Root & Configuration (15 files)

| File | Role | Audit Method | Key Notes |
|---|---|---|---|
| `.editorconfig` | Editor formatting rules | Inventory | Standard indentation/charset config |
| `.gitattributes` | Git line-ending rules | Inventory | Cross-platform LF/CRLF rules |
| `.github/workflows/ci.yml` | Cross-platform CI | Inventory | Contains `tmep` naming (1 occurrence) |
| `.gitignore` | Git ignore rules | Inventory | Ignores `node_modules`, temp/cache |
| `ARCHITECTURE.md` | High-level architecture doc | Inventory | Historical TMEP naming; superseded by Phase 0 + Phase 1 canonical docs |
| `AUDIT.md` | Nov 8 2026 rescue audit | Inspected | Documents prior 31/33 baseline & Skia Canvas rationale |
| `CHANGELOG.md` | Release history | Inventory | Historical TMEP changelog |
| `CONTRIBUTING.md` | Contribution guide | Inventory | Historical TMEP naming |
| `LICENSE` | MIT license | Inventory | 1 `TMEP` reference |
| `QUALITY_REPORT.md` | Nov 8 2026 quality report | Inspected | Documents `trial-visual-only.mp4` & 37/37 unit baseline |
| `README.md` | Project overview | Inventory | Historical TMEP docs; outdated statements |
| `RENDER_GUIDE.md` | Rendering guide | Inventory | Historical rendering notes |
| `TMEP_HANDOFF.md` | Prior handoff document | Inventory | Historical handoff |
| `package.json` | Workspace root manifest | Inspected | Node `>=22.18.0`, `@napi-rs/canvas` `0.1.100`, no `package-lock.json` |
| `tsconfig.json` | TypeScript project config | Verified | `npm run typecheck` passes |

## 2. Binaries (`bin/`, 2 files)

| File | Role | Audit Method | Key Notes |
|---|---|---|---|
| `bin/tmep.js` | CLI entrypoint | Executed | Runs `packages/cli/src/main.ts` |
| `bin/tmep-mcp.js` | MCP stdio entrypoint | Inventory | Runs `packages/mcp/src/server.ts` |

## 3. Core Package (`packages/core/`, 17 files)

| File | Role | Audit Method | Key Notes |
|---|---|---|---|
| `packages/core/package.json` | Package manifest | Inventory | Workspace package |
| `packages/core/src/index.ts` | Public exports | Inspected | Re-exports core modules |
| `packages/core/src/schema.ts` | Custom schema validator & JSON Schema | Inspected | `obj()` treats `null` as `undefined` (`:166`); non-strict missing `__proto__` guard (`:181`) |
| `packages/core/src/errors.ts` | `TmepError` & error codes | Inspected | `asTmepError` regex `/^E[A-Z]+$/` misses digits/underscores (`:50`) |
| `packages/core/src/util.ts` | Hashing, FS helpers, retry | Inspected | `mediaHash` samples 3×4MiB windows for `>32MiB` files (`:37-61`) |
| `packages/core/src/effects.ts` | `kf`, `mask`, 8 presets, easing | Inspected | `parsePoints` turns empty coords to `0` (`:145`); `validateKeys` rejects `<1ms` disjoint props (`:117`) |
| `packages/core/src/scene.ts` | `VisualScene` schema & types | Inspected | `visualSceneSchema` does not enforce `end > start` at schema level (`:22`) |
| `packages/core/src/timeline.ts` | Timeline model, `layout`, anchors | Inspected | `srcToTl` returns first reused clip (`:263-269`); `anchorAt` 1ms rounding (`:377`); `splitClip` 40ms drop (`:386-402`) |
| `packages/core/src/ops.ts` | 23 timeline operations & parser | Inspected | `zoom` targets first reused clip (`:422-431`); `parseOpString` stops `@phrase` at digits (`:161-168`); `set` ignores invalid prop combos |
| `packages/core/src/project.ts` | Project storage, locks, revisions | Inspected | `revPath`/`revision`/`checkout` allow non-integer inputs (`:194-204,252-261`); `jobPath` lacks traversal guard (`:101-103`); `withLock` stale unlink race (`:113-139`) |
| `packages/core/test/*.test.ts` (7 files) | Unit tests (`broll-effects`, `core`, `cut`, `effects`, `fx-retime`, `overlay-order`, `writejson`) | Executed | All pass under `npm test` |

## 4. Engine Package (`packages/engine/`, 2 files)

| File | Role | Audit Method | Key Notes |
|---|---|---|---|
| `packages/engine/package.json` | Package manifest | Inventory | Workspace package |
| `packages/engine/src/api.ts` | Public engine API (`openProject`, `importMedia`, `reference`, `transcribe`, `transcribeBatch`, `plan`, `planScript`, `storyboard`, `edit`, `inspect`, `render`, `status`, `doctor`, `help`) | Inspected | Unlocked RMW in `edit` (`:447-461`), `plan` (`:345-365`), `storyboard` (`:377-427`); no path containment on `importMedia`/`transcribe`/`render` `out`; `help('storyboard')` ~7,096 est. tokens |

## 5. MCP & CLI Packages (`packages/mcp/`, 4 files; `packages/cli/`, 2 files)

| File | Role | Audit Method | Key Notes |
|---|---|---|---|
| `packages/mcp/package.json` | Package manifest | Inventory | Workspace package |
| `packages/mcp/src/tools.ts` | 9 MCP tool schemas | Inspected | Missing `transcribe-batch`, `doctor`, `script`, `storyboard`, `ratio`/`rev`/`parallel`/`encoder`; `video_inspect` marked `readOnlyHint: true` |
| `packages/mcp/src/server.ts` | JSON-RPC stdio MCP server | Inspected | Drops all notifications incl. `notifications/cancelled` (`:60-61`); no path containment on `project` (`:118`) or `out` (`:155`) |
| `packages/mcp/test/mcp.test.ts` | MCP protocol & naming tests | Executed | Passes under `npm test` |
| `packages/cli/package.json` | Package manifest | Inventory | Workspace package |
| `packages/cli/src/main.ts` | 20 CLI commands + 3 flag aliases | Inspected | `render` lacks `.mp4`/containment check (`:197`); `script`/`storyboard` read arbitrary paths (`:147`) |

## 6. Render Package (`packages/render/`, 15 files)

| File | Role | Audit Method | Key Notes |
|---|---|---|---|
| `packages/render/package.json` | Package manifest | Inventory | Workspace package |
| `packages/render/src/render.ts` | Render orchestration & caching | Inspected | `.tmep` marker written before `probe()` (`:437-450`); cache hit skips verification (`:343-346`); `mediaMap` trusts `a.hash` without disk re-check (`:94-103`) |
| `packages/render/src/graph.ts` | FFmpeg unit filtergraph builder | Inspected | Composites base → `xfade` → z-sorted `broll`/`gfxOverlays` → `gfx.ass` (`:121-272`); tags BT.709 without color conversion (`:274-282`) |
| `packages/render/src/effects.ts` | FFmpeg `perspective`/`geq`/`blend` | Inspected | Only `kf` + `mask` (convex poly only); 6 eases |
| `packages/render/src/audio.ts` | 3-stage chunked audio mixer | Inspected | Speech + SFX + ducked music (`sidechaincompress`) + conditional `loudnorm` (`:374`) |
| `packages/render/src/sfx.ts` | 6 synthesized SFX (`aevalsrc`) | Inspected | `pop`, `click`, `ding`, `whoosh`, `riser`, `swoosh` |
| `packages/render/src/stage.ts` | Worker pool, atomic `publish`, filter scripts | Inspected | Uses `-/filter_complex` on FFmpeg >=8 or `-filter_complex_script` (`:67-86`) |
| `packages/render/src/jobs.ts` | Background job state & heartbeat | Inspected | Heartbeat 2s, stale 60s, `.cancel` marker polling 1s |
| `packages/render/src/recovery.ts` | Stale staging file cleanup | Inspected | Reclaims `ownerTag(pid)` staging files when owner PID is dead |
| `packages/render/test/*.test.ts` (7 files) | Unit tests (`audio`, `broll-effects`, `effects`, `gfx-effects`, `jobs`, `overlay-order`, `publish`) | Executed | All pass under `npm test` |

## 7. Media Package (`packages/media/`, 7 files)

| File | Role | Audit Method | Key Notes |
|---|---|---|---|
| `packages/media/package.json` | Package manifest | Inventory | Workspace package |
| `packages/media/src/exec.ts` | Safe subprocess runner (`shell: false`) | Inspected | `commandLineLimit()` returns `0` unless `TMEP_CMDLINE_LIMIT` set (`:65-68`); `runBinary` misses pre-spawn abort check (`:142-167`) |
| `packages/media/src/ffmpeg.ts` | FFmpeg/ffprobe discovery & helpers | Inspected | `measureLoudness` ignores non-zero exit (`:177-184`); no `signal`/`timeoutMs` on `detectSilence`/`measureLoudness` |
| `packages/media/src/chrome.ts` | Headless Chrome/Edge CDP driver | Inspected | `send()` has no timeout/ws-close handler (`:95-101`); `launch()` can leak browser process on error (`:76,80`) |
| `packages/media/src/reference.ts` | Reference reel shot-cut analyzer | Inspected | Only `select=gt(scene,...)` hard-cut pacing; no visual/style/audio analysis |
| `packages/media/test/*.test.ts` (2 files) | Unit tests (`exec`, `reference`) | Executed | Pass under `npm test` |

## 8. Motion Package (`packages/motion/`, 15 files)

| File | Role | Audit Method | Key Notes |
|---|---|---|---|
| `packages/motion/package.json` | Package manifest | Inventory | Workspace package |
| `packages/motion/src/ass.ts` | ASS v4+ document builder | Inspected | Generates `libass` script events/styles |
| `packages/motion/src/compile.ts` | Compiles captions + `gfx` to ASS/layers | Inspected | Isolates `fx`/`z` graphics; no safe-zone or caption collision checks |
| `packages/motion/src/captions.ts` | 4 caption styles (`kinetic`/`karaoke`/`clean`/`boxed`) | Inspected | Fixed `y` ratios, char-based wrapping, 114% inline scaling jitter, no clause awareness |
| `packages/motion/src/presets.ts` | 11 ASS presets | Inspected | Overlap with center/lower captions; linear ASS moves; char-based wrapping |
| `packages/motion/src/fonts.ts` | OpenType parser & font stager | Inspected | Parses `name`/`OS/2` tables; stages fonts for `libass` |
| `packages/motion/src/icons.ts` | 32 ASS `\p1` vector icons | Inspected | 100×100 coordinate icons |
| `packages/motion/src/scene.ts` | `VisualScene` compiler & SAT validator | Inspected | Bridges `AssDoc`, `BRoll`, and `VectorRun`; runs per-frame collision/safe-area checks |
| `packages/motion/src/vector.ts` | `@napi-rs/canvas` path rasterizer | Inspected | Renders `VectorRun` to transparent PNG sequences with frame-state dedup |
| `packages/motion/src/explainer-plan.ts` | 5-scene explainer cue planner | Inspected | Hardcoded `CONCEPTS` (`starts.length !== 5`); uses `ctx.measureText` |
| `packages/motion/src/explainer-canvas.mjs` | Standalone 1080×1920@60fps Canvas explainer | Inspected | High visual quality, but hardcoded story/palette/font/safe-zone violation (`y=1585..1820`) |
| `packages/motion/src/launch-reel.mjs` | Standalone 1080×1920@60fps Canvas launch reel | Inspected | 9 hardcoded `s.kind` branches; bottom UI overlap (`y=1454..1824`) |
| `packages/motion/test/*.test.ts` (4 files) | Unit tests (`explainer`, `motion`, `scene`, `vector`) | Executed | All pass under `npm test` |

## 9. Speech & Story Packages (`packages/speech/`, 7 files; `packages/story/`, 8 files)

| File | Role | Audit Method | Key Notes |
|---|---|---|---|
| `packages/speech/package.json` | Package manifest | Inventory | Workspace package |
| `packages/speech/py/fw_transcribe.py` | Python `faster-whisper` CLI | Inspected | Hardcoded `vad_filter=True`, `beam_size=5`; `local_files_only=True` only in `--batch` |
| `packages/speech/src/engines.ts` | `whisper.cpp` & `faster-whisper` adapters | Inspected | Uncached `hasFasterWhisper()` check; `threads` not forwarded to Python |
| `packages/speech/src/transcript.ts` | JSON/SRT/VTT parser & validator | Inspected | Rejects simultaneous starts (`<= prev.s`); SRT/VTT yields `approx: true` |
| `packages/speech/src/hinglish.ts` | Devanagari→Latin transliterator | Inspected | Deterministic schwa deletion; no acoustic/timing effect |
| `packages/speech/src/analyze.ts` | Sentences, `roughCut`, BM25 search | Inspected | English-only stopwords/stemmer; 9 hardcoded `CONCEPTS` |
| `packages/speech/test/speech.test.ts` | Speech unit tests | Executed | Passes under `npm test` |
| `packages/story/package.json` | Package manifest | Inventory | Workspace package |
| `packages/story/src/planner.ts` | `planTimeline` orchestration | Inspected | Non-transcribed clips taken from `0s`; duration allocation skew; `zooms=false` leaves `push`/`jumpZoom` active |
| `packages/story/src/templates.ts` | 7 editing templates | Inspected | Repetitive defaults (`fit: 'cover'`, `captions.pos: 'lower'`, `gfx.lists: true`) |
| `packages/story/src/rules.ts` | Deterministic storyboard rules | Inspected | List/stat/step/CTA/keyword/zoom rules + density limiter |
| `packages/story/src/storyboard.ts` | `storyboardSchema` & `compileStoryboard` | Inspected | Fixed 9:16 @ 30fps, max 16 scenes, 4 templates, hardcoded colors, char-based wrap |
| `packages/story/src/script.ts` | `planScript` text→storyboard | Inspected | English-only `Intl.Segmenter` + regex heuristics |
| `packages/story/src/reference.ts` | `referenceRanges` pacing cutter | Inspected | Cuts at punctuation/pauses `>= 0.35s` |
| `packages/story/test/*.test.ts` (2 files) | Story & reference unit tests | Executed | Pass under `npm test` |

## 10. Docs, Benchmarks, Examples, Previews, Tests (77 files)

| Group | Count | Files | Audit Method |
|---|---|---|---|
| `docs/` | 9 | `ARCHITECTURE.md`, `BENCHMARKS.md`, `INTEGRATIONS.md`, `PROTOCOL.md`, `READINESS.md`, `REFERENCE_PLANNING.md`, `RESEARCH.md`, `STORYBOARD.md`, `VISUAL_SCENE.md` | Cross-referenced for outdated claims & naming |
| `bench/` | 8 | `path-raster-backends.ts`, `results/latest.json`, `token-bench.ts`, `tokens.ts`, `visual-scene-v2-windows.ps1`, `visual-scene-v2.ts`, `visual-scenes-windows.ps1`, `visual-scenes.ts` | Executed `npm run bench`; inspected `tokens.ts` |
| `examples/` | 29 | `creator-quality/`, `demo/`, `explainer/`, `launch-reel/`, `mcp-configs/` (6 files), `ops/`, `path-reveal/`, `readiness/`, `reel-from-raw-footage/` (3 files), `voiceover-reel/` (7 files) | Executed `examples/readiness/smoke.mjs` & `examples/explainer/qa.mjs` |
| `preview/` | 3 | `contact-sheet.png`, `qa.json`, `trial-visual-only.mp4` | Referenced from `QUALITY_REPORT.md` |
| `tests/` | 20 | 16 `*.test.ts` E2E suites + 4 helpers (`fault-rename.ts`, `fixtures.ts`, `json-reader-child.ts`, `legacy-audio.ts`, `reliability-child.ts` — 15 test + 5 helper = 20) | Executed via `npm run test:e2e` |
