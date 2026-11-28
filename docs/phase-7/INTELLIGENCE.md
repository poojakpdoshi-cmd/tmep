# FRAME Phase 7 — Intelligence accuracy (7.1) and active-speaker intelligence (7.2)

All numbers are measured in this repository's harnesses on CPU (no GPU, no paid API). Evidence files are in
`docs/phase-7/evidence/`. Labels marked *agent* were made by the agent, not by independent humans.

## 7.1 Speech recognition

| Test set | Model (sherpa-onnx, int8 unless noted) | WER | CER | RTF | Peak RSS | Target |
|---|---|---|---|---|---|---|
| FLEURS en, 150 utt / 3 276 words (clean **read** speech) | Parakeet-TDT 0.6B v2 | **9.6 %** | 6.1 % | 0.06 | 1.05 GB | ≤ 15 %: **met** |
| same | NeMo CTC conformer small (Phase 6 default) | 16.7 % | — | — | — | missed |
| same | Whisper base | 20.8 % | 14.2 % | 0.07 | 0.55 GB | missed |
| FLEURS hi, 40 utt / 1 016 words | Whisper turbo (multilingual) | **34.6 %** | 16.5 % | 0.65 | 1.97 GB | ≤ 15 %: **missed** |
| FLEURS hi, 100 utt | Whisper base | 103 % | 104 % | 0.12 | 0.57 GB | unusable |
| *Tears of Steel* film dialogue (music, effects) vs condensed official subtitles | Parakeet-TDT 0.6B v2 | 57.9 % overall, **33.4 %** in dialogue regions (Phase 6 best 52.7 %) | — | 0.05 | — | noisy: reported separately |

- FLEURS is read speech, not conversational speech; no licensed, untouched **conversational** English test set
  was reachable from this environment (HF, OpenSLR and archive hosts are blocked). The ≤ 15 % target is met
  on clean read speech only; conversational WER is **not measured**.
- Hindi misses the target by a wide margin. Hinglish uses the existing Devanagari → Roman transliteration
  over the Hindi transcript; its accuracy is **not measurable** here (no Hinglish labelled audio).
- Moonshine base segfaults in sherpa-onnx 2.0.3 (not evaluable).
- Product effect: only Parakeet-class transcripts are treated as caption-grade (`CAPTION_GRADE_MODELS`);
  other local models still require review before captions are burned (Inspector `unverified-captions`).
- Worker fixes found by these runs: Whisper token cap (6 tokens/s truncated Devanagari), whole-utterance
  windows for Whisper, partial UTF-8 BPE tokens.

## 7.1 Scene classification

Untouched test: 30 new clips / 92 labelled frames (`bench/phase7/scene-test-labels.json`, committed before
any Phase 7 classifier run). Phase 7 model **0.696** (64/92); the Phase 6 model on the same frames 0.663
(61/92). Target 0.85: **missed**. Per class (Phase 7): talking-head 6/7, screen 29/31, performance 16/20,
scenery 7/12, sports 3/5, close-up 2/6, animation 1/5, **group 0/6**. Hand/object/people features did not
improve cross-validation; no stronger image model is reachable (the MediaPipe bucket offers only the two
embedders/classifiers already used). The Director therefore keeps treating scene types as hints
(`SCENE_NOTE` in `packages/story/src/brief.ts`).

## 7.2 Active-speaker detection and speaker-aware framing

**Method** (`packages/media/src/speaker.ts`, worker task `mouth`): MediaPipe FaceLandmarker (Apache-2.0,
3.7 MB, pinned SHA-256) gives per face the `jawOpen` blendshape and the inner-lip gap; faces too small for
its detector are found again on upscaled head crops placed from the pose landmarks. Faces are linked into
tracks that never cross a cut. Per 0.25 s: speech presence (transcript words with < 0.6 s pauses bridged, or
audio level), mouth-opening variability over ±1 s per face, then hysteresis (1.2 s minimum dwell, a
challenger must lead for 0.5 s, a still mouth through 0.75 s of speech releases the speaker → off-screen
voice). Framing: faces that fit in one crop share it; otherwise the active speaker is framed, speaker changes
ease over 0.5 s, the crop holds a ±30 % dead zone and steps (never pans) at cuts; three changes within 6 s
between faces that cannot share a crop produce a split-screen **recommendation** (never applied
automatically). The pass runs at 8 fps (≤ 3 min) or 5 fps (≤ 15 min), up to 1 280 px wide.

**Labels** (*agent*): `bench/phase7/asd-labels.json`, committed before any run — *Tears of Steel*
(CC BY 3.0) windows 22–40 s (two-shot dialogue), 316–364 s (singles, reactions, over-the-shoulder) and
381–394 s (rapid single-shot alternation), from 0.5 s contact sheets and the official subtitle timing.
Parameters were tuned on windows A+B; window C was scored once after detection parameters were frozen
(the framing dead-zone/cut-hold change was made after looking at C's crop keys, so C's *framing* numbers are
not held out). Speech presence from the Parakeet transcript unless noted.

| | Dev A+B | Held-out C | All | All, 360p source | All, audio level only | All, 5 fps |
|---|---|---|---|---|---|---|
| Two-shot: correct speaker when one is named | **0.92** (52 steps) | — | 0.92 | 0.96 | 0.95 | 0.88 |
| Two-shot: steps with a decision (coverage) | 0.71 | — | 0.71 | 0.64 | 0.42 | 0.65 |
| Visible speaker detected (single shots) | 0.87 (23) | **0.75** (20) | 0.81 (43) | 0.81 | 0.83 | 0.81 |
| Reaction shot wrongly called speaker | 0 / 8 | — | 0 / 8 | 0 / 8 | 2 / 12 | 0 / 8 |
| Off-screen line attributed to a visible face | 0 | — | 0 | 0 | 0 | 0 |
| **Speaking face inside the 9:16 crop** — Phase 6 reframe | 0.41 | 0.60 | **0.44** | 0.48 | 0.50 | 0.44 |
| **Speaking face inside the 9:16 crop** — Phase 7 | 0.91 | 1.00 | **0.93** (106 steps) | 0.96 | 0.95 | 0.93 |
| In-shot crop travel (frame widths/min) P6 → P7 | 0 → 0.72 | 0 → 0 | 0 → 0.60 | 0.19 → 0.49 | 0 → 0.59 | 0 → 0.62 |
| Speaker switches inside continuous speech (labelled) | 2 (3) | 0 (0) | 2 (3) | 0 (3) | 1 (3) | 1 (3) |

Evidence: `evidence/asd-f720-*.json`, `asd-f360-ABC.json`. Cost: ≈ 69 ms per frame at 1 280 px, worker peak
RSS ≈ 310 MB (790 frames in 54 s).

**Limits.** Profile and very small faces (≈ 50 px) are often missed by the landmarker, so in two-shots the
system abstains (keeps the previous framing) for ~30 % of the speech; when it decides, it is right 92 % of the
time. Frame-rate mouth/audio correlation was evaluated and was uninformative at 10 fps (AUC ≈ 0.5); it is
not used. The test set is small (106 crop steps, 79 s of dialogue), single-film and agent-labelled — not an
independent benchmark.

## Defect found and fixed: semantic worker timestamps

The Phase 5/6 worker selected frames with `t − prev_selected_t ≥ 1/fps` and stamped them `start + n/fps`.
When the sampling rate does not divide the source frame rate the stamps drift: 10 fps on 24 fps footage
ran at 8 fps (25 % drift); **2 fps on 25 fps (PAL) footage drifts 4 %** (2.4 s after one minute). Frames now
carry FFmpeg's own timestamps (`showinfo`) and are sampled on a fixed grid. `FOOTAGE_VERSION` is `7a.1`,
so cached analyses are recomputed. Phase 6 results on *Tears of Steel* (24 fps, 2 fps / 0.4 fps sampling)
were unaffected.
