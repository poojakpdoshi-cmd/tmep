# TMEP handoff

## Architecture (voiceover-first path)
Voiceover + word timings → `examples/voiceover-reel/render.ts`, which does the following:
- builds the scene plan: one scene per sentence, with cut times taken from word starts
- extracts PCM peaks
- injects `window.DATA` into `scene.html` (deterministic `TMEP.seek(t)`)
- drives headless Chrome over a CDP pipe (`packages/media/src/chrome.ts`)
- sends JPEG frames to FFmpeg (libx264, loudnorm −14 LUFS)

Codex's canvas renderers (`explainer-canvas.mjs`, `launch-reel.mjs`) need `@napi-rs/canvas`, which isn't installed here. They were left untouched.

## Latest changes (uncommitted Codex work preserved)
- Ported from the Codex zip: `examples/launch-reel/`, `packages/motion/src/launch-reel.mjs`. Not modified; the launch reel MP4 isn't in the zip.
- Added:
  - `packages/media/src/chrome.ts`
  - `examples/voiceover-reel/{render.ts,scene.html,VERIFICATION.md}`
  - outputs: v1 (kept) and v2, plus a caption-free export

## Verified
- v2: 1080×1920, 60 fps, 14.00 s, AAC, −13.9 LUFS. Caption timing was spot-checked on frames. See `examples/voiceover-reel/VERIFICATION.md`.

## Not verified / blockers
- The voiceover is synthetic (flite). No real voice has been tested.
- Whisper isn't installed, so `--words` must be supplied externally.
- `@napi-rs/canvas` is missing, so Codex's launch-reel and explainer renderers can't run here.
- Nothing has been pushed.

## Next action
1. Render with the user's real voiceover plus Whisper word JSON.
2. Replace the gradient plates with real footage or screen captures.
3. Fix the label crowding.
