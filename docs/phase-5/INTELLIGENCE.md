# FRAME — Phase 5 Intelligence Evaluation

Real-footage and synthetic results are reported separately. Every number comes from a command run on the
stated host (Linux x64 container, 4 vCPU, Node v22.23.5, FFmpeg 6.1.1, Python 3.13, MediaPipe 1.2.3 CPU).

## 1. Real footage used

**YouTube UGC dataset** (Google; public bucket `storage.googleapis.com/ugc-dataset`): 20 s audio-removed
excerpts, licensed **CC BY 4.0** per clip. 33 clips at 360p (H.264 crf 10): 15 *dev* clips and 18 *held-out*
clips across Gaming, HowTo, Lecture, NewsClip, Sports, TelevisionClip, VerticalVideo and Vlog. Per-clip
attribution and every label are in [`bench/phase5/ugc-labels.json`](../../bench/phase5/ugc-labels.json) and
[`bench/phase5/ugc-scene-labels.json`](../../bench/phase5/ugc-scene-labels.json). No media is committed;
`bench/phase5/transitions-eval.ts --download` fetches the clips. The same harnesses accept user-supplied
recordings with a labels file.

Limitations of this data, stated up front:
- **No audio** in any clip: audio moments, silences, loudness, speech and ASR are **not evaluated on real
  footage**. ASR models are also unavailable here (model hosts blocked by the network policy).
- **Single annotator** (the agent), from 2 fps contact sheets refined with 10 fps strips at every boundary
  and every disagreement. Label resolution 0.1–0.5 s; scoring tolerance ±0.5 s.
- Small samples: 36 hard cuts, 6 gradual transitions, 23 scene-type spans.

## 2. Shot boundaries (`bench/phase5/transitions-eval.ts` → `evidence/transitions-eval.json`)

| Detector | Set | TP | FP | FN | Precision | Recall |
|---|---|---|---|---|---|---|
| Phase 4 rules (unchanged) | dev 15 | 13 | 1 | 0 | 0.93 | 1.00 |
| Phase 4 rules (unchanged) | **held-out 18 (clean test)** | 17 | 2 | 6 | **0.89** | **0.74** |
| Phase 5 cuts | dev | 13 | 2 | 0 | 0.87 | 1.00 |
| Phase 5 cuts | held-out* | 21 | 0 | 2 | 1.00 | 0.91 |
| Phase 5 cuts | all 33* | 34 | 2 | 2 | 0.94 | 0.94 |
| Phase 5 gradual transitions | all 33* | 5 | 0 | 1 | 1.00 | 0.83 |

\*The Phase 5 thresholds were revised after inspecting held-out errors, so **no untouched test set remains for
the Phase 5 detector**; the clean held-out figure is the Phase 4 row. Mean localization error 0.11 s.

What changed and why (from inspected failures): Phase 4 missed cuts between shots of similar tone (sheep /
people / snow scenes; histogram change 0.16–0.29 < 0.3) and fired on auto-exposure jumps (histogram change
0.30–0.39 with unchanged structure). Phase 5 adds a level-normalized 32×18 structural step (with a
shift-compensation test so camera pans do not count) and vetoes single-step changes whose thumbnails stay
correlated (r > 0.9). Gradual transitions require a large change across ±0.5 s, stable sides, a tonal change,
and a change that neither shifting (camera motion) nor re-levelling (exposure) explains — this rejected all
four karting/boxing pans and the drawing zoom that the first version reported.

Remaining errors: 1 glitch-band flash in a game menu and 1 handheld swing are reported as cuts; a cut inside a
whip pan is placed 0.4 s early; a dissolve with heavy motion and a cut immediately followed by a noise
transition are missed. Not handled: boundaries of animated-graphics segments and partial-frame graphic
transitions (1 of 8 detected), UI state changes inside a screen recording (reported as cuts 2 of 5 times).

Synthetic regression (`evidence/footage-eval-synthetic.json`): cuts P/R 1.00/1.00, 0 dissolve/flash false cuts,
and the synthetic 1 s dissolve is now reported as a gradual transition at its exact midpoint (7.5 s).

## 3. Semantic layer on real footage (`bench/phase5/semantic-eval.ts` → `evidence/semantic-eval*.json`)

### Scene types (18 held-out clips, 23 spans labelled before any prediction was viewed)

| Run | Span accuracy | Time-weighted |
|---|---|---|
| First pass | 0.35 | 0.29 |
| Revision 1 (rule order; conversation from large people; "empty" requires no text) | 0.26 | 0.30 |
| **Final** (revision 1 without the "no text" condition) | **0.39** (9/23) | **0.37** |

Revisions were again informed by held-out errors (not independent). The classifier is **not reliable**:
screen recordings, games and writing boards are not recognized (no OCR words, no people → "other"/"empty"),
handheld talking heads at 360p become "action" (BlazeFace short-range misses small faces), and "object
close-up" works only for COCO objects. An ImageNet classifier was tested and rejected (top labels such as
"slot", "cannon", "flute" for game, FPS and lecture frames). Briefs therefore present scene types as hints
with this accuracy stated.

### Other semantic outputs (inspected, not label-scored)

| Output | Observation on the 18 held-out clips |
|---|---|
| Tracks | 0–15 person/object tracks per clip; people inside game graphics and in an inset photo are detected as persons (correct as detections, wrong as "subjects") |
| Presenter | found in 2 clips (a close-up interviewee in Sports_1d5c, a seated speaker in Vlog_2e9d); none falsely in screen/game clips |
| Activity | Vlog_2e9d speaker "gesturing" and boxers "moving across frame" match the footage; the Sports_1d5c interviewee labelled "moving across frame" is wrong (handheld camera) |
| Similar shots | HowTo_127f: the return to the studio set (s1 ↔ s3, cosine 0.91) — correct |
| Event candidates | 4 candidates in 3 clips, none labelled events; no event recognition is claimed |
| Text over time | number-change detection is unit-tested; no scoreboard in the held-out set changed on screen, so it is **not evaluated on real footage** |

Event candidates for sports (goals, wickets, boundaries) need labelled real matches with commentary audio;
none were available, so **no event-recognition accuracy is claimed**.

### Plan → compile → Inspector on a real clip (Sports_360P-1d5c, 9:16 output)

`tmep editplan build --asset v1 --task cinematic --semantic` proposed `keep [0,20]` and a reframe to the
interviewee (`cx 0.336`, kept in 47 % of samples — the other samples are the tower shots without a person);
`compile` applied it; `inspect qa` then reported **0** subject-crop advisories. The rendered frames keep the
face in the 9:16 crop: [`evidence/real-reframe-9x16-sheet.jpg`](evidence/real-reframe-9x16-sheet.jpg)
(frames from *'Savvaļas putnu rehabilitācijas stacija Madonas novadā uzsākusi darbu'* by MADONARPTV,
CC BY 4.0, via the YouTube UGC dataset). This run exposed two defects that synthetic tests had not: subject
coverage and the Inspector's crop check required a close-up wider than the crop to fit entirely (0 % / 39 %
reported for a correctly framed face), and the Inspector's suggested fix used a non-existent `follow=`
parameter. Both now measure against what the crop can hold and emit a valid `reframe cx= cy=` op.
A static centre is a compromise for subjects that travel; keyframed follow is computed (`inferred.reframe`)
but not yet compiled into `reframe keys`.

## 4. Runtime, memory, storage (semantic layer, 20 s 640×360 clips, 2 fps = 40 frames)

| Metric | Min | Median | Max |
|---|---|---|---|
| Semantic adapter wall time | 3.6 s | 4.1 s | 5.0 s |
| Inference per frame (objects + faces + pose + embedding) | 45 ms | 58 ms | 78 ms |
| Model load (warm file cache; first cold load 3.7 s) | 122 ms | 145 ms | 167 ms |
| Worker peak RSS | 256 MB | 283 MB | 292 MB |
| Record size (JSON) | 4.1 KB | 8.4 KB | 11.2 KB |
| Temporal OCR (tesseract, 1 frame/s) | 6.6 s | — | 8.4 s |
| Full analysis incl. base pass + temporal OCR + semantic | 10.3 s | 12.8 s | 15.1 s |

Base pass alone: 0.26–0.58 s per clip. Storage: models 23.1 MB; mediapipe + dependencies ≈ 580 MB.
Long-form sampling drops to 1 fps (≤ 30 min) and 0.5 fps beyond, so a 10-minute video costs ≈ 1,200 frames ≈
70 s of semantic inference at the measured median.

## 5. ASR / Whisper

Not evaluated: openaipublic.azureedge.net, huggingface.co and alphacephei.com are blocked by this
environment's network policy, so no Whisper or Vosk model could be installed. The existing speech adapters are
unchanged; speech-to-visual alignment is tested with provided transcripts only.
