---
name: motion-graphics
description: Author animated presets, vector paths, and keyframed motion graphics in FRAME.
---

# Motion Graphics

## When & Why
Use when adding titles, lower-thirds, stats, progress indicators, or animated vector paths (`gfx`, `scene`, `fx`).

## How (Supported Operations)
- **Prefer presets** (`video_plan` / `api.compile` intent) — FRAME places, sizes and times them:
  `kinetic_title {title, subtitle}`, `lower_third {title: name, subtitle: role, avoid:[face box]}`,
  `callout {target:{x,y}, label}`, `ui_demo {asset, clicks:[{x,y,t,label}]}`,
  `animated_diagram {nodes, edges?}`, `dynamic_chart {title, chart:{chartType, data, highlight}}`,
  plus `profile` (`editorial|bold|minimal|documentary|sports|tech`), `platform`, `avoid`. Read the
  returned `corrections`: they say what FRAME moved or shrank and why.
- **Scenes (`scene`)** when a preset does not fit: text `anim` (char/word/line), path `morph`,
  `motionPath`, `reveal`, `depth` + camera keys (parallax), scene `mblur`/`focus`, charts, gradients.
- **Keyframes (`fx`)**: `kf` (`s`,`x`,`y`,`r`,`o`); eases `linear, in, out, io, back, spring, hold,
  expo, expoio, circ, smooth, elastic, bounce, snap`; presets `zoomin…pandown`.
- **ASS presets (`gfx`)**: legacy `title`, `lower_third`, `stat`, … — linear motion, prefer Canvas presets.

## Limitations
- Collision checks cover rect/text pairs only; check motion paths crossing shapes by eye.
- Motion blur multiplies Canvas raster time by its sample count.

## Common Mistakes & Prohibitions
- **No meaningless animations** or bouncy overshoots on serious content.
- **No graphic/caption collisions**: Center-band ASS presets (`stat`, `icons`, `bars`) overlap `middle` captions.

## Required Validation
Render preview frames (`frames: true`) and inspect start, peak-motion, and exit frames for clipping or collisions.
