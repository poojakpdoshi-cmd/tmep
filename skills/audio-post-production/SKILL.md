---
name: audio-post-production
description: Mix speech, synthesized SFX, sidechain-ducked music, and loudness normalization in FRAME.
---

# Audio Post-Production

## When & Why
Use to balance dialogue, add subtle transition/emphasis SFX, duck background music, and meet loudness targets.

## How (Supported Operations)
- `music` op: attach music bed with automatic `sidechaincompress` ducking under speech.
- `sfx` op: 6 synthesized SFX (`pop`, `click`, `ding`, `whoosh`, `riser`, `swoosh`) at timeline anchors.
- `loudness` op: target integrated LUFS (e.g. `-14`); triggers single-pass `loudnorm` when `< 0`.
- `set` op: adjust clip `vol` (`0` to mute).

## Limitations & Future Capabilities
- Audio transitions use `acrossfade` with triangular (`tri`) curve.
- **Planned (Phase 3)**: Dialogue HPF/EQ/de-essing/noise reduction, two-pass `loudnorm` mastering, and beat-synchronized cuts.

## Common Mistakes & Prohibitions
- Leaving `sfx` too loud relative to dialogue or overusing `pop`/`whoosh` on every cut.
- Claiming audio quality without verifying stream presence, duration, and loudness.

## Required Validation
Check `ffprobe` audio stream presence/duration and verify loudness/true-peak (`<= -1.0 dBTP` target, `~ -14 LUFS` for web) via `measureLoudness` or `ffmpeg loudnorm` stats.
