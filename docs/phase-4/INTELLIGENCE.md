# FRAME — Phase 4B Local Footage Intelligence (first architecture)

FRAME Intelligence lets an agent work from raw footage without describing it: FRAME measures the
footage locally and hands the agent a compact, task-specific brief. CPU-only, no paid API, no model
download for the core analyzers. Code: `packages/media/src/footage.ts` (analysis),
`packages/story/src/brief.ts` (briefs), `packages/render/src/footage-qa.ts` (Inspector checks),
`packages/engine/src/api.ts` (`footageAnalysis`, inspect targets, compile integration).

## 1. Record: `frame.footage/1`

| Section | Contents | Kind |
|---|---|---|
| `asset` | duration, size, fps, audio, analyzed seconds, truncation | observed |
| `provenance[]` | analyzer, version (`4b.1`), method, parameters, milliseconds | — |
| `capabilities` | `shots, motion, quality, audio, speech, faces, text` → `ok` + tool, or `unavailable` + reason | — |
| `observed.shots[]` | `s1…` stable ids, `t0/t1`, cut score, keyframe, luma, motion, detail, 16-bin tone signature | observed (algorithmic) |
| `observed.motion[]`, `observed.audio[]` | mean frame difference and RMS dBFS per 0.5 s | observed |
| `observed.silences[]` | adaptive-floor silences ≥ 0.6 s | observed |
| `observed.speech[]` | segments from the transcript only (never from audio level) | observed (transcript) |
| `observed.faces[]`, `observed.text[]` | face boxes / OCR words on shot keyframes when the local tool exists | observed (adapter) |
| `observed.quality[]` | per-shot flags: dark, overexposed, low-detail, static | observed |
| `observed.gridActivity` | 3×3 motion + detail map | observed |
| `inferred.scenes[]` | consecutive similar shots, split at long pauses; confidence + basis | inferred |
| `inferred.moments[]` | candidate moments: peaks of audio level, motion and cut density; **evidence strings + confidence** | inferred |
| `inferred.quietRegions[]` | least active screen cells — candidate graphic placement | inferred |
| `inferred.presenter` | persistent face box expanded to head and shoulders; confidence + basis | inferred |
| `inferred.pacing` | cuts per minute, mean shot length, label | inferred |

## 2. Analyzers

- **One video decode**: 160×90 gray at an adaptive rate (10 fps ≤ 10 min, 5 fps ≤ 30 min, else 2 fps),
  streamed (constant memory). Per frame: tone histogram, luma, clipping, Laplacian detail, frame
  difference, 3×3 activity.
- **Hard cuts**: histogram change above an absolute floor and 3× the local median, **or** a structural
  frame-difference spike (catches cuts between shots with the same tones). Flashes are rejected by their
  shape — a jump away and a jump back — on both the flash frame and the frame after it.
- **One audio decode**: mono 16 kHz RMS per 0.5 s; silences relative to an adaptive noise floor.
- **Moments**: smoothed sum of motion above median, audio above median (6 dB units) and cut density,
  non-maximum suppression at 2 s, at most 12; each lists the evidence that produced it.
- **Faces** (optional): OpenCV Haar frontal-face cascade on shot keyframes — location only, no identity.
  OpenCV 5 removed the bundled cascades; the adapter detects this and asks for `opencv-python-headless<5`.
- **Visible text** (optional): tesseract (`--psm 11`) on shot keyframes; words ≥ 70 % confidence,
  single alphanumeric characters ≥ 80 % (scores, digits).
- Not implemented (reported, never guessed): object detection, gesture regions, action recognition,
  speech recognition without an installed engine.

## 3. Caching and invalidation

Content-addressed in `.tmep/cache/footage/`:
`base = hash(analyzer version, media content hash, maxSeconds, transcript hash)`; adapters layer on
top: `hash(base, faces, ocr)` and re-use the base record's decode passes (incremental). Re-encoding the
media, changing the transcript or bumping the analyzer version produces a new key. QA reads only cached
analyses; it never starts one.

## 4. Agent surface

- MCP `video_inspect {what:"footage", asset}` — compact summary (minimal/standard) or the full record
  (`detail:"debug"`); `faces`, `ocr`, `force`, `maxSeconds`.
- MCP `video_inspect {what:"brief", asset, task, max}` — `task`: `informative` (topic, top statements,
  candidate trims, stat/list/step/CTA visual cues, graphic regions, caption side), `sports` (moments with
  evidence, visible text, loudest windows, explicit "not recognized events" note), `cinematic`,
  `product` (steady shots for callouts, visible text), `generic`.
- CLI `frame inspect footage|brief --asset v1 [--task …] [--faces] [--ocr]`.
- Compiler: any preset intent may add `footage: "<asset>"`; FRAME maps that asset's presenter region
  through the clip's crop into the output frame and adds it to `avoid`, reporting the correction.
- Inspector (`video_inspect {what:"qa"}`), advisory: graphics over the presenter, captions over the
  presenter, crop cutting the presenter, repetitive zooms (> 8/min), confident moments missing from the edit.

## 5. Evaluation (measured)

### Labelled synthetic footage — `bench/phase4/footage-eval.ts`, `evidence/footage-eval.json`

Four cases: a 6-shot montage, hard cuts with a 1 s dissolve and a 3-frame flash, 8 fast cuts (0.7–1.3 s
shots), and a **held-out** fast pan with a lighting change added after tuning.

| Metric | Result |
|---|---|
| Hard-cut precision / recall | **1.00 / 1.00** (14/14 cuts, 0 false) |
| Cut timing error | 0 ms at the sampling grid (≤ 1 sample = 100 ms bound) |
| Dissolve or flash reported as a cut | 0 |
| Fast pan + lighting change (held out) | 0 false cuts |
| Silence IoU | 0.83 (both silences) |
| Moment recall (±1 s) | 5/5 loud events |
| Quiet region (static top-left graphic) | correct in 3/3 |
| Runtime | 0.3–0.6 s per 12–16 s clip |

Honesty notes: cut thresholds were tuned on these cases (the pan case was held out); synthetic footage
measures algorithm behaviour, not real-world accuracy. A unit test also caught a defect the evaluation
had missed — the frame after a flash was reported as a cut — because the original 1-frame flash fell
between 10 fps samples; both were fixed.

### Real image content (public domain)

- **Face region**: NASA astronaut portrait (public domain, via scikit-image) composited into a
  1280×720 clip with a slow zoom. OpenCV 4.14 Haar found the face; the inferred presenter box covers head
  and shoulders — visually verified, `evidence/face-region-real-photo.png`. OpenCV 5.1 and no OpenCV both
  reported `unavailable` with the correct remedy.
- **OCR**: scoreboard overlay ("HOME 2 - 1 AWAY", "67:12") on test footage: tesseract 5.3.4 read
  `HOME 2 1 AWAY 67:12` (5/5 tokens; hyphen dropped) at 0.96 confidence, 0.8 s. A first version dropped
  the single-digit scores; fixed.

### Long-form resources (10 min, 1920×1080, 30 fps)

| | |
|---|---|
| Analysis wall time | **20.0 s** (30× real time, 4 vCPU) |
| Peak RSS | Node 125 MB; video decoder 95 MB; audio decoder 56 MB |
| Record size | 18 KB |
| Models | none for core analyzers; optional: Haar cascade 930 KB (OpenCV 4 wheel + numpy 215 MB installed), tesseract + eng ≈ 21 MB |
| Cached repeat | 3 ms (brief from cache) |

## 6. Blockers and limitations

- **Real camera footage is unavailable in this environment**: no licensed footage is in the repository,
  and the network policy blocks media hosts (e.g. `upload.wikimedia.org` → 403). Scene-segmentation
  accuracy on real edits, presenter localization on real talking heads, OCR on real broadcasts, event
  timestamp precision on real sports and transcript accuracy (no ASR engine installed) are therefore
  **not measured**. The evaluation harness accepts any labelled file; run it on licensed footage.
- Gradual transitions (dissolves, fades, wipes) are not reported as boundaries — by design they are not
  hard cuts, but scene grouping may miss them.
- Moments are signal peaks. FRAME does not recognize goals, wickets, boundaries or other events.
- Haar face detection is frontal-only and misses profiles and small faces; the presenter region is a
  heuristic expansion of the most persistent box.
- Analysis is capped at 30 minutes by default (`maxSeconds` up to 2 h).
