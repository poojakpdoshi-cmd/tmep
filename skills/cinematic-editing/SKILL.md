---
name: cinematic-editing
description: Craft deliberate, atmospheric pacing and restrained motion in FRAME.
---

# Cinematic Editing

## When & Why
Use for documentaries, brand films, trailers, and narrative pieces prioritizing mood, breathing room, and visual continuity.

## How (Supported Operations)
- `video_plan` with `template: "cinematic_explainer"` or custom `video_edit` timelines (`transition`, `kf` slow `push`/`pull` with `io` easing, `music` bed, `loudness: -14`).
- `frame` (`cover` or letterboxed `contain`) with consistent `settings.bg`.

## Limitations & Future Capabilities
- **Planned (Phase 3)**: `.cube` LUTs, shot-to-shot color matching, J-cuts/L-cuts, film-grain/glow, and two-pass audio mastering.
- Phase 1 outputs BT.709 metadata tags without HDR/log-to-Rec.709 tone mapping.

## Common Mistakes & Prohibitions
- **No excessive zooms** or jittery kinetic captions on cinematic cuts.
- **No abrupt cuts** across unmotivated background shifts.

## Required Validation
Inspect transition frames, verify smooth easing endpoints, and check audio ducking smoothness.
