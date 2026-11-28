# FRAME — Phase 6 Progress

- **Branch**: `feat/phase-6-production` from Phase 5 head `8ed6833` (PR #32). Stacked draft PR; no merge without approval.
- **Gate 6.0 entry**: Phase 5 CI — `c4cb121` all suites passed; `8ed6833` recorded in VALIDATION.md.

## Real data available in this environment
| Source | Licence | Use |
|---|---|---|
| YouTube UGC dataset (`storage.googleapis.com/ugc-dataset`), 20 s audio-removed clips | CC BY 3.0/4.0 per clip | scene classification (train/test split below), retrieval, effects |
| *Tears of Steel* (Blender Foundation, `storage.googleapis.com/shaka-demo-assets/tos-ttml`), 12:14 live action with English dialogue + TTML subtitles | CC BY 3.0 | speech/ASR evaluation, 30–60 s production edits |
| sherpa-onnx ASR models (GitHub releases): NeMo Conformer-CTC small (76 MB, CC-BY-4.0), Whisper tiny.en (118 MB, MIT); `sherpa-onnx` wheel 4.6 MB (Apache-2.0) | as stated | local ASR with timestamps |
All other media/model hosts (HuggingFace, Wikimedia, archive.org, Pexels, Pixabay, OpenSLR) are blocked by the network policy.

## Scene taxonomy (frozen before labelling the test set)
| Class | Definition |
|---|---|
| `talking-head` | one person is the main subject and faces/addresses the camera (presenter, vlogger, anchor, interviewee), close or medium shot |
| `group` | two or more people together are the main subject (conversation, panel, interview two-shot, band members posing) |
| `performance` | people singing, playing instruments or dancing as a performance (stage, concert, music video performance) |
| `screen` | screen content dominates: screen recording, video game, slides, lyric/title cards, graphics, written board |
| `animation` | animated/cartoon/CG scene that is not a UI or text card |
| `sports` | sport being played or a sports venue/field/track |
| `close-up` | hands, objects, products, food or tools are the subject |
| `scenery` | places without a main human subject: landscape, buildings, streets, rooms, crowds/audience as background |

Labels are per frame at t = 2.5, 7.5, 12.5, 17.5 s (one frame per 5 s quarter). Test split: 3 clips per UGC category
(13 categories, 39 clips, 156 frames), drawn with seed 6006 from clips never used before; labels are written and
committed **before** any classifier is run on them. Train split: the next 2 clips per category plus the 33 Phase 5 clips.

## Stages
| Stage | Status |
|---|---|
| 6.0 closure + intelligence (scene classifier, dynamic reframe, camera motion, presenter, screen recognition, semantic retrieval, licence audit, speech eval) | in progress |
| ↳ speech eval (Tears of Steel vs subtitles) | done: WER 0.53 in dialogue regions for both NeMo-CTC-small and Whisper-tiny; CTC timing agreement 0.97 (`evidence/asr-eval.json`); `sherpa-onnx` engine added |
| ↳ scene classifier | done: **0.738** on the untouched test set (149 frames; target 0.85 missed); CV on train 0.64 (`evidence/scene-eval.json`). First test run read 0.081 because of a NaN bug (zero sd in stored model); fixed without changing the model, then re-run once |
| ↳ worker frame timing | fixed: fps filter kept the last frame of each slot (2 fps frames were up to 0.25 s late); now exact `select` sampling |
| ↳ dynamic reframe | done: `reframe follow=[{t,cx,cy}]` renders a per-frame crop; plans emit speed-limited follow keys; centre↔offset convention bug fixed (Phase 5 static reframe was ~0.05 off); decoded-render test |
| ↳ camera motion / presenter | done: base-pass camera motion (`observed.camera`), track speed and pose activity relative to camera; pose-facing evidence for presenters; real clip: Sports_1d5c interviewee now `stationary` |
| ↳ screen recognition | via the scene classifier: screen recall 0.90 on the test set |
| ↳ semantic retrieval | done: library embeddings + ImageNet model tags, `similar`; P@5 0.50 vs 0.18 random on real frames (`evidence/retrieval-eval.json`) |
| ↳ licence audit | done: `declared` vs `verified` (attribution record / embedded metadata), `verify`, `audit`; changing a claim drops its verification |
| 6.1 production orchestrator | done (`10936fe`): `frame.production/1`, 13 stages, per-stage hashes/revisions, overrides, cancel/resume/recovery |
| 6.2 director | done: `frame.strategy/1`, 6 genres, budgets, constraints win, caption-accuracy gate |
| 6.3 MCP/CLI production interface | done: `video_plan {mode:"produce"}` (10-tool contract kept), `tmep produce` |
| 6.4 reference-aware editing | done: `frame.style/1` (pacing, motion/camera, colour, audio rhythm, typography, composition), clamped adaptation |
| 6.5 preview + bounded correction | done: preview render, prioritized QA, ≤ 2 correction cycles, refusals and unresolved items reported |
| 6.6 real production evaluation | pending |
