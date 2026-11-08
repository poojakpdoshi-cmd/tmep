# Quality report — 8 November 2026

## Implemented and verified

- Recovered and modified the original TMEP repository from commit `b8bd179`; retained its engine, tests and assets. No push or publication.
- Added a dedicated deterministic Canvas/FFmpeg explainer and JSON configuration. No cartoon presenter and no synthesized voice.
- Final `../trial-final/trial-visual-only.mp4`: H.264, 1080×1920, 60/1 fps, 1,200 frames, exactly 20.000 seconds, 1,179,588 bytes. No audio stream, intentionally. Full video decode completed without errors.
- New strict route rejects approximate, nonfinite, reversed, overlapping/simultaneous-start timing as appropriate; preserves imported `approx:true`; full audio is rounded up to a frame boundary. Phrase grouping uses real font widths and has at most two lines.
- Unit suite: 37/37 passed. Baseline was 31/33; the two pre-existing Windows MCP cleanup failures were corrected by waiting for child closure before directory cleanup.
- TypeScript check passed with locally available TypeScript 5.9.3 and bundled Node types 25.9.5. Initial check using unrelated home-directory Node 20.11 types failed with Buffer type incompatibilities; no unrelated source was changed to conceal that environment mismatch. The declared project dev dependencies were not installed from the network.
- Integration fixture: a 6-second non-speech test tone plus explicit test captions rendered both caption-free and captioned exports. ffprobe measured video AND audio as 6.000 seconds, with 360 video frames. Inspected an encoded caption frame: correct test text, stationary phrase, blue active-word emphasis, no visual overlap. This is a plumbing test, not a speech synchronization test, and is not presented as the trial reel.

## Visual inspection and revision

Inspected frames extracted from the encoded MP4, not just source drawings: all five scene samples, first and final frames, plus 32 consecutive frames around each of four transitions. Inspected the caption fixture separately. No claim of real-time audiovisual playback or listening is made.

First render weaknesses and fixes:
1. Landscape distortion: replaced stretching with aspect-preserving cover crops.
2. Unmotivated changes of image size/position: fixed the illustration viewport across refinement, reveal and closing.
3. Refinement disclosed the full picture too early: introduced a deterministic coarse visual field resolving toward the same landscape. It remains explicitly a conceptual illustration, not a live AI inference.

A subsequent transition review found double-exposed headlines in dissolves. Replaced them with a 0.48-second eased editorial wipe. Wipe masking intentionally clips transient portions of text as the boundary passes; there is no permanent clipping, overshoot or object jump in the reviewed frames. The final image remains stationary across the last two transitions.

Subjective assessment: the design is coherent, legible, restrained and materially cleaner than the audited default preset approach. It is still a simple vector explainer and requires the user's creative review. No comparison against the missing cartoon reel is claimed. Mobile app UI placement and device playback have not been validated on Instagram.

## Automated visual evidence

`../trial-final/qa.json` records the checks. All 1,200 decoded frames were analyzed at 64×114 grayscale. Mean luminance ranges from 15.284 to 42.489 (0–255); no near-empty frame was flagged. Largest adjacent-frame mean absolute difference is 2.745 at frame 453 (7.55 s), within the intended prompt-to-refinement wipe. The largest changes were reviewed in the transition sheets. These metrics detect suspicious changes; they are not proof of professional creative quality or absence of every possible clipping issue.

## Implemented but not fully verified

- Optional facecam and alpha presenter composition, duration checks, reserved layout and alpha-format validation exist. No real presenter asset was provided; actual facecam framing, transparency codecs and visual quality are unverified.
- Local speech adapters are reused, but `doctor` reports both whisper.cpp and faster-whisper absent. ASR accuracy and latency are unverified here.
- The narrow automatic scene-cue matcher and manual scene anchors operate on real transcript times. Different narration must be reviewed; this is not a general-purpose semantic storyboard generator.

## Incomplete / blocked

- Real narration is missing. Therefore complete narration, correct spoken caption content, perceived audio quality, speech/caption alignment and a voiceover-synchronized trial are NOT accepted as complete.
- Delivered preview has no fabricated subtitles. Captioned and caption-free narration exports were verified only with a test fixture, not delivered as real speech versions.
- Caption timestamp-to-video quantization is less than one frame (16.67 ms); the intended real-speech review tolerance is 100 ms, NOT yet measured. Recognition errors can be much larger.
- Forced alignment is unavailable. A script mismatch stops; no fallback timestamp invention is allowed in this route.
- Missing original 13.7-second trial and its specific generation code prevent a forensic before/after comparison. The nearby 18-second Hyperframes clip was probed, not assumed to be that trial or visually audited as a reference.
- Full legacy end-to-end suite was not run because its fixtures synthesize spoken words. Focused non-speech export testing was used instead, respecting the request not to synthesize a voice.

Next required input: the actual narration audio, preferably accompanied by measured word timestamps. Otherwise install/configure one existing speech recognizer and model. Then render, listen, correct timing, and review both caption versions before calling the voiceover trial complete.
