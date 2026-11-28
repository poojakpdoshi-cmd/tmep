# FRAME — Phase 5 Architecture: Semantic Intelligence and Visual Assets

Phase 5 extends the Phase 4 `frame.footage/1` record; there is no second analysis pipeline.

```
                    ┌──────────── frame.footage/1 (one record per media hash + settings) ───────────┐
media ─► base pass (Node, FFmpeg 160×90 gray @ ≤10 fps + 16 kHz audio)                            │
         shots: histogram + level-normalized structural cuts (5.0) · gradual transitions (5.0)    │
         motion · quality · audio · silences · moments · quiet regions · event candidates         │
      ─► adapters (layered on the cached base; each one reported ok | unavailable + remedy)       │
         faces (OpenCV Haar) · ocr (tesseract: shot keyframes | every N s = temporal OCR)          │
         semantic (MediaPipe worker, CPU) ─► objects · faces · poses · embeddings · [gestures]     │
                                         ─► deterministic TS: IoU tracks, subjects, reframe keys,  │
                                            pose activity, scene types, similar shots / replays,   │
                                            text over time + number changes, speech↔visual         │
                                            alignment, event candidates                            │
                    └────────────────────────────────────────────────────────────────────────────┘
          │ briefs (frame.brief/1, 7 domains)   │ Inspector (footage-qa)    │ structured plan (frame.plan/1)
          ▼                                     ▼                           ▼
     agent reads ~0.5–1 k tokens         advisories with evidence     proposed items → overrides → ops → edit
                                                                            ▲
                                  asset library (frame.assets/1) ───────────┘ recommendations / asset requests
```

## Components

| Module | Role |
|---|---|
| `packages/media/src/footage.ts` | Base pass; `detectCuts` (now with a level-normalized 32×18 structural step and an exposure-jump veto), `detectGradual`, adapter orchestration, record schema (`FOOTAGE_VERSION 5a.1`) |
| `packages/media/py/semantic.py` | MediaPipe Tasks worker: reads raw RGB frames from an FFmpeg pipe, prints JSON lines. Location only — no identity |
| `packages/media/src/semantic.ts` | Pure TS over worker output: `trackObjects`, `findSubjects`, `reframeKeys`, `poseActivities`, `sceneTypes`, `similarShots`, `textOverTime`, `alignSpeech`, `eventCandidates` |
| `packages/media/src/models.ts` | Model manager: pinned URLs, sizes, SHA-256, licences; `modelStatus`, `installModels` (plan only unless `confirm`), runtime check |
| `packages/media/src/library.ts` | Asset engine: describe (SHA-256, dHash, SVG text), duplicates, BM25 search, licence gate, recommendations, structured asset requests |
| `packages/story/src/brief.ts` | Briefs: informative, sports, cinematic, product, **podcast**, **educational**, generic |
| `packages/story/src/plan.ts` | Structured plan: build, refresh (dependency-aware), overrides, deterministic compile |
| `packages/render/src/footage-qa.ts` | Inspector: Phase 4 checks + graphics-over-subject, crop-cuts-subject, overlay-over-subject |
| `packages/motion/src/scene.ts` | Collision check now covers rrect/ellipse/polygon/path (shapes, morphs, motion paths) |

## Observed vs inferred

- **Observed**: shots, transitions, motion, audio, silences, faces, OCR text, `tracks` (detections linked by
  IoU — a measurement with a stated method), `gestures`, `textTracks`.
- **Inferred** (each with confidence + evidence): scenes, moments, quiet regions, presenter, `subjects`,
  `reframe`, `activities`, `sceneTypes`, `duplicates`, `textChanges`, `alignment`, `events`.
- `events` are **candidates**: coinciding signals (moment, on-screen number change, possible replay, fast
  subject, cut after). Every candidate carries `note: "candidate only…"`. No goal, wicket or boundary is
  recognized.

## Caching, invalidation and failure handling

- Base key: media hash + `FOOTAGE_VERSION` + `maxSeconds` + transcript hash (Phase 4, unchanged).
- Layered key: base + enabled adapters + **the files of verified models** — replacing a model invalidates
  semantic results. Phase 4 `faces`/`ocr` keys are unchanged, so existing caches stay valid.
- An adapter that cannot run (models missing, Python/mediapipe missing, EGL libraries missing) is recorded as
  `unavailable` with a remedy and the layered record is **not cached**, so installing it later takes effect.
- Worker failures surface `E_ANALYSIS_FAILED` with the stderr tail; MediaPipe's interpreter-exit destructor
  noise is ignored because the worker's final `done` line is authoritative. Cancellation kills the worker.
- Downloads: `E_DOWNLOAD` on HTTP failure or checksum mismatch; the file is never moved into place.

## Public surface (TMEP-compatible; nothing renamed)

| Capability | MCP | CLI |
|---|---|---|
| Semantic analysis | `video_inspect {what:"footage"|"brief", semantic, gestures, temporalText}` | `tmep inspect footage --semantic --temporalText` |
| Domain briefs | `video_inspect {what:"brief", task:"podcast"|"educational"|…}` | `tmep inspect brief --task …` |
| Models | `video_doctor {models}` · `{install:[…]}` (plan) · `{install, confirm:true}` | `tmep models` · `tmep models install [--yes]` |
| Asset library | `video_import {paths, library:{…}}` · `video_inspect {what:"library", action}` | `tmep library add|search|dups|recommend|licence` |
| Structured plan | `video_plan {mode:"structured", action, asset, task, overrides, dryRun, rebase}` | `tmep editplan build|show|refresh|override|compile` |

The MCP tool count is unchanged (10). New error codes: `E_ANALYSIS_FAILED`, `E_DOWNLOAD`.

## Installation requirements (reported before any download)

| Item | Size | Licence | Needed for |
|---|---|---|---|
| `mediapipe` Python package + dependencies | ≈ 580 MB on disk | Apache-2.0 | semantic layer |
| EGL/GLES client libraries (Linux: `libegl1 libgles2`) | small | system | MediaPipe loads them even on CPU |
| 5 models (EfficientDet-Lite0 int8 4.6 MB, BlazeFace 0.2 MB, BlazePose lite 5.8 MB, MobileNetV3-small embedder 4.1 MB, gesture recognizer 8.4 MB optional) | 23.1 MB | Apache-2.0 | objects, faces, pose, similarity, gestures |
| tesseract (temporal OCR) | system package | Apache-2.0 | text over time |

No GPU is needed. Models install to `$FRAME_MODELS` (alias `$TMEP_MODELS`, default `~/.cache/frame/models`),
never into the repository.
