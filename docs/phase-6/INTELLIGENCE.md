# FRAME — Phase 6 Intelligence Evaluation (6.0)

Host: Linux x64, 4 vCPU, Node 22.23.5, FFmpeg 6.1.1, Python 3.13, MediaPipe 1.2.3, sherpa-onnx 2.0.3 (CPU).
All media is real and licensed; nothing synthetic is reported here except where marked.

## 1. Scene classification — target 0.85, achieved **0.738**

| Item | Value |
|---|---|
| Test set | 39 UGC clips never used before (3 per category × 13 categories, seed 6006), 156 frames, 149 labelled; labels committed (`ead5f66`, pushed 12:52 UTC) before any classifier ran |
| Train set | 76 clips (33 Phase 5 + 43 new), 292 labelled frames; one train clip excluded for showing the same performer/setting as a test clip |
| Model | multinomial logistic regression over MobileNetV3-large embeddings (1280), EfficientNet-Lite2 class probabilities (1001, √p) and 6 detection counts; L2 chosen by grouped 8-fold CV on train only |
| CV accuracy (train) | 0.64 |
| **Test accuracy (single run)** | **0.738 (110/149)** — `evidence/scene-eval.json` |
| Per-class recall (test) | talking-head 1.00, screen 0.90, performance 0.77, scenery 0.76, sports 0.67, animation 0.38, close-up 0.14, group 0.11 |
| Phase 5 rules | 0.39 on a different (Phase 5 held-out) set — not directly comparable |

Honest notes:
- The first test run reported 0.081: every frame was "talking-head" because standard deviations of
  constant features were stored as 0 (NaN in TypeScript). Fixed storage only (model unchanged), re-run
  once. Both runs are disclosed.
- A worker defect found here also affected production analysis: FFmpeg's `fps` filter keeps the **last**
  frame of each slot, so semantic frames were up to 0.25 s late at 2 fps. Sampling now uses exact
  `select`. (Base-pass statistics at 10 fps keep ≤ 0.05 s offset.)
- Exploring feature sets (MobileNetV3-small 0.56, -large 0.61, +classes 0.65 CV) shows the limit is the
  amount of labelled data and inherently ambiguous classes (group vs talking-head/performance, close-up vs
  screen); the 0.85 target needs a stronger image model or substantially more labels.
- Briefs state the measured accuracy with every scene-type field.

## 2. Speech / ASR on real dialogue

Source: *Tears of Steel* (Blender Foundation, CC BY 3.0), 734 s, English dialogue with music and effects;
reference = official English subtitles (311 words; subtitles condense speech, so WER is an upper bound).

| Engine (local, CPU) | WER (all) | WER in dialogue regions | Correct words with start inside their cue (±0.5 s) | RTF | Peak RSS |
|---|---|---|---|---|---|
| NeMo Conformer-CTC small (sherpa-onnx, int8, 76 MB) | 0.611 | **0.527** | **0.974** | 0.014 | 301 MB |
| Whisper tiny.en (sherpa-onnx, int8, 118 MB) | 0.701 | **0.527** | 0.836 (segment-spread timing) | 0.038 | 521 MB |

Evidence: `evidence/asr-eval.json`. Whisper emitted non-speech tags ("[Music]", "(upbeat music)") until they
were filtered (standard post-processing). Conclusion: the small local models give **usable word timing**
(CTC) but **not caption-grade text** on film audio; the Director therefore does not burn captions from
these engines without confirmation. Larger Whisper models (HuggingFace) are unreachable here.

## 3. Camera motion, presenter and activity

- Base pass now measures global camera motion (32×18 shift matching every 0.5 s; zero across cuts);
  track speeds and pose activity are relative to the camera; a pose facing the camera counts as face
  evidence when BlazeFace misses small faces.
- Synthetic unit test: a 0.19 widths/s pan is measured as 0.188; a subject moving with the pan reads
  speed < 0.02 (marked synthetic).
- Real clips (Phase 5 errors re-checked): the handheld Sports_1d5c interviewee changes from
  "moving across frame" to **stationary**; boxers in Sports_2725 remain "moving across frame". No labelled
  activity set exists, so no accuracy is claimed.

## 4. Subject-follow reframing
`reframe follow=[{t,cx,cy}]` renders a per-frame crop expression. Decoded test render: a subject crossing
a 16:9 frame stays within ±0.12 of the 9:16 centre at 1, 2 and 3 s (`tests/phase6-follow.test.ts`).
Found and fixed: reframe keys are window *centres*, while `cx/cy` are crop *offsets*; Phase 5 passed centres
as offsets (~0.05 framing error on the Phase 5 real clip).

## 5. Semantic asset retrieval
Library = 149 labelled real test frames; queries = 292 training frames; relevant = same scene class.
`library.similar` (MobileNetV3-large cosine): **P@1 0.52, P@5 0.50, P@10 0.46, mAP 0.40** vs 0.18 random
(`evidence/retrieval-eval.json`). Library entries also get ImageNet model tags (EfficientNet-Lite2,
p ≥ 0.15) for text search, marked as model-derived.

## 6. Licence verification audit
Phase 5 called any stated licence "verified". Phase 6 separates `declared` (user-stated), `verified`
(independent evidence: an attribution record line naming the file and the licence, or embedded
metadata naming it) and `unknown`. Changing the licence id drops the old verification. Tested with a
dataset-style ATTRIBUTION file and an MP4 `copyright` tag (`tests/phase6-library.test.ts`).
