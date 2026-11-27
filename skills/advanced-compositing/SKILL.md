---
name: advanced-compositing
description: Layer B-roll, graphics, masks, keyframed transforms, and z-ordered overlays in FRAME.
---

# Advanced Compositing

## When & Why
Use when combining multiple visual layers—B-roll cutaways, `VisualScene` overlays, masks, and animated reveals.

## How (Supported Operations)
- `broll` & `gfx` with explicit integer `z` (`set <id> z=<int>`) to control layer stacking (`broll` defaults to `0`, isolated `gfx` to `10`, plain `gfx.ass` burns last).
- `fx` `kf` (`s`, `x`, `y`, `r`, `o`) and `mask` (`rect`, `ellipse`, convex `poly`, `feather`, `invert`, `reveal=center|left|right|top|bottom`).
- Alpha-only export (`render` to `.mov` ProRes 4444 or `.webm` VP9 when no scenes/isolated layers).

## Limitations & Future Capabilities
- `poly` masks support **convex polygons only** (concave polygons clip incorrectly).
- **Planned (Phase 3)**: Concave/bezier masks, motion/object tracking, rotoscoping, blur/glow/drop-shadow, chroma-key, and layer blend modes.

## Common Mistakes & Prohibitions
- Supplying concave polygon points to `mask poly`.
- Forgetting `z` order when placing `gfx` behind `broll`.

## Required Validation
Render preview frames covering mask reveals and z-order transitions and inspect for alpha edge artifacts or unintended clipping.
