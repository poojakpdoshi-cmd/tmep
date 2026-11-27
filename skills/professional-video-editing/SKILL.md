---
name: professional-video-editing
description: Execute frame-exact cuts, trims, pacing, transitions, and timeline manipulation in FRAME.
---

# Professional Video Editing

## When & Why
Use during rough-cut and fine-cut stages to assemble, tighten, reorder, and transition clips cleanly.

## How (Supported Operations)
- `cut`, `delete`, `tighten`, `keep` for transcript-driven and time-driven trims.
- `add`, `trim`, `move`, `remove`, `speed`, `frame` (`cover`/`contain`/`blur`) for clip assembly.
- `transition` (`xfade` types) between adjacent clips; `zoom` for intentional punch-ins.
- `undo`, `redo`, `checkout`, and `expectedRev` for safe revisioned editing.

## Limitations & Future Capabilities
- **Planned (Phase 3)**: J-cuts, L-cuts (split audio/video offsets), bezier speed ramps, freeze frames, video stabilization, and multicamera sync are not yet implemented.
- `transition` requires sufficient silence/handle room and is refused inside continuous speech.

## Common Mistakes & Prohibitions
- Cutting mid-word or ignoring pause boundaries.
- Applying excessive zooms or transitions that break continuity.
- Running concurrent edits without `expectedRev`.

## Required Validation
Inspect `video_inspect({ what: "timeline" })`, verify duration and cut boundaries, and review transition frames from `video_render`.
