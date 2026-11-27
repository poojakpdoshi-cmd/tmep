---
name: motion-graphics
description: Author animated presets, vector paths, and keyframed motion graphics in FRAME.
---

# Motion Graphics

## When & Why
Use when adding titles, lower-thirds, stats, progress indicators, or animated vector paths (`gfx`, `scene`, `fx`).

## How (Supported Operations)
- **ASS Presets (`gfx`)**: `title`, `lower_third`, `icons`, `stat`, `badge`, `bars`, `progress`, `cta`, `keyword`, `icon`, `flash`.
- **Keyframes (`fx`)**: `kf` (`s`, `x`, `y`, `r`, `o`) with eases `linear`, `in`, `out`, `io`, `back`, `hold`, plus 8 presets (`zoomin`, `zoomout`, `push`, `pull`, `panleft`, `panright`, `panup`, `pandown`).
- **Vector Paths (`scene`)**: `@napi-rs/canvas` `VectorRun` (`path` layers) with state-signature frame deduplication.

## Limitations & Future Capabilities
- **Planned (Phase 2)**: Generalized `CanvasRun` (`rrect`, `gradient`, measured `text`, `chart`) and Chrome HTML/CSS integration.
- ASS preset movements use linear `\move` interpolation; `explainer-canvas.mjs` and `launch-reel.mjs` are standalone scripts, not yet generalized MCP templates.

## Common Mistakes & Prohibitions
- **No meaningless animations** or bouncy overshoots on serious content.
- **No graphic/caption collisions**: Center-band ASS presets (`stat`, `icons`, `bars`) overlap `middle` captions.

## Required Validation
Render preview frames (`frames: true`) and inspect start, peak-motion, and exit frames for clipping or collisions.
