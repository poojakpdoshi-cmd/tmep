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

## Codex recovery — 2026-11-08
- Verified origin/main 9a0e21f and fast-forwarded from 22b10f8. Local untracked launch files were copied to ../recovery-backup and preserved in stash; nothing deleted or force-reset.
- Read handoff and VERIFICATION. The previous statement 'Nothing has been pushed' is stale: GitHub contains the commit.
- Located Downloads/voiceover-reel.mp4: 14 seconds, 1080x1920, 60 fps, audio present. Extracted actual scene contact sheet to ../quality-prototype/claude-before.png. Downloads/voiceover.wav is 38.198 seconds and cannot be assumed to match. No word-timing JSON found. No listening/real speech sync verification performed.
- Retained ChromePage/CDP renderer. Chrome must run with sufficient process permissions here. Added design.html, design-render.mjs, design-check.mjs as a separate silent design study; does not replace the voiceover template. Reuses ChromePage for deterministic 900-frame exports.
- Added original AI-generated coast.png asset for the photo composition. Built-in image generation prompt: aerial oblique volcanic coastline, teal ocean, warm cove, morning side light, documentary photographic detail, diagonal composition, no text/people/logos. This is an AI-generated still, not live footage or a TMEP generation capability.
- Voiceover render.ts now requires explicit --synthetic when audio/words absent; validates timestamp ranges. Actual real-audio render path remains untested in this environment.
- Outputs: ../quality-prototype/TMEP-quality-prototype-v1.mp4 and v2.mp4, contact sheets/checks/reports. v2 is a manually directed silent design target. No invented speech alignment. User approval and real narration alignment remain gates.
- Commands from repository root: node examples/voiceover-reel/design-render.mjs v1 (or v2); node examples/voiceover-reel/design-check.mjs v1 (or v2). Existing files are not overwritten by the encoder; use a fresh output directory or new version argument when rerunning. Node 22+, Chrome, FFmpeg required, no additional packages.
- Nothing pushed by this continuation. Do not expand to a full reel until visual approval.
