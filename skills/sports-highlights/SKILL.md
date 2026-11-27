---
name: sports-highlights
description: Edit fast-paced sports highlights and action sequences in FRAME.
---

# Sports Highlights

## When & Why
Use when assembling sports clips, action montages, or high-energy highlight reels.

## How (Supported Operations)
- `video_import` raw clips, `video_reference` for target pacing, `cut`/`trim`/`move`/`speed` for tight action assembly.
- `music` + `sfx` (`whoosh`, `riser`, `swoosh`) + `transition` (`xfade`) for energy and momentum.

## Limitations & Future Capabilities
- **No automated sports event detection yet** (goals, wickets, boundaries): multimodal video intelligence is planned for Phase 4.
- **No speed ramps or stabilization yet** (planned for Phase 3); `speed` is constant per clip.
- Non-transcribed footage in `planTimeline` does not yet perform visual action detection—inspect timestamps manually before cutting.

## Common Mistakes & Prohibitions
- **No fabricated events** or blind `0s`-start slicing of raw sports clips without inspecting where the action occurs.
- Overusing transitions that obscure the key action moment.

## Required Validation
Verify action peaks are intact in rendered frames and audio/music mix does not clip.
