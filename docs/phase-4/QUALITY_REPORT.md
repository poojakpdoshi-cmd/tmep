# FRAME — Phase 4 Quality Report

Every visual statement here comes from frames extracted from encoded MP4s and viewed; every audio
statement from decoded PCM or FFmpeg measurement. No video was watched in motion and no audio was
listened to. All media is synthetic or public-domain imagery; **no real camera footage was available**
(see INTELLIGENCE.md §6).

## 1. Defects that technical tests had missed (Stage 4.0)

Phase 3 reported zero Inspector defects on five demos, yet complete public-API renders showed:
animated masks frozen at t=0, speed-ramp video playing at 1× while its audio ramped (up to 583 ms
desync), audio-only edits silently reusing a stale mix, BT.2020/HDR sources rendered with wrong colours,
a silent audio track aborting the whole render, and a "directional" blur that was neither directional
nor applied to chroma. All are fixed with regression tests that fail on the old code
(VALIDATION.md §4.0.4–4.0.6). Lesson recorded for future phases: every advertised capability is gated on
a complete render that is decoded and measured (`bench/phase4/effect-matrix.ts` — 88/88).

## 2. Motion (Phase 4A) — what the frames show

`evidence/motion-demo-sheet.png` (1080×1920, 30 fps, 4-sample motion blur):
- Kicker enters character by character, title word by word; settled word animation is pixel-identical to
  static text (tested), so animation never shifts the final layout.
- Rule reveals left to right; square morphs to circle to triangle without criss-crossing outlines.
- A dot travels its curve and orients along it; the body line enters and exits on cue.
- Shortcoming: the motion path crosses the morphing shape — the collision checker covers only rect/text
  pairs, so this composition error was not reported.

## 3. Presets (Phase 4A) — what frame inspection changed

Inspection of `evidence/presets-*-sheet.png` (editorial and bold profiles) drove four fixes before
commit: widowed last words in titles (balanced breaking), a lower third that the solver pushed to
mid-frame (now constrained to the lower band, narrowing then stepping type down), a tap label covering
the very button being clicked, and 22–24 px chart labels in a 1080×1920 frame (now box-relative, scene
font, grouped numbers, accent on the stated point). Final frames: titles at ≥ 80 px, lower thirds
legible beside the presenter in both profiles, charts readable at phone size. Inspector: 0 defects; the
only advisory is the intentionally silent plate.

Remaining limitations: all presets sit in the upper ~60 % of 9:16 when lower captions are assumed, which
leaves the lower band empty if the edit has no captions; diagram connectors are straight lines; the
bold profile's lower third must step type down to 52 % to fit beside a wide presenter.

## 4. Colour and audio

- Colour references (VALIDATION.md §4.0.6): BT.709, BT.601, BT.2020 SDR, PQ and HLG all within 3–5/255 of
  ground truth after conversion; HDR uses mobius tone mapping at the 203-nit reference white.
- A/V sync through hard cuts, J/L-cuts, constant speed and ramps: worst 42.7 ms (1→0.5 ramp, ≈ 1.3
  frames); 12–18 ms elsewhere.
- Measured limitation: compression thresholds are absolute, so a source peaking at −24 dBFS is not
  compressed; `shadows` lifts are mild (matrix diff 1.6 at `shadows=1`).

## 5. Footage intelligence (Phase 4B)

- Labelled synthetic footage: hard-cut precision/recall 1.00/1.00, no dissolve/flash/pan false cuts,
  silence IoU 0.83, loud-event recall 5/5 (INTELLIGENCE.md §5).
- Real image content: the face region on a public-domain portrait is placed correctly
  (`evidence/face-region-real-photo.png`); OCR read a scoreboard overlay 5/5 tokens.
- The footage-aware Inspector caught a lower third over the presenter in a control render and cleared
  once the preset was compiled with `footage:`.
- Not evaluated: anything on real camera footage (blocked), transcript accuracy (no ASR installed).
