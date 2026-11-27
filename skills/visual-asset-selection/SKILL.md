---
name: visual-asset-selection
description: Select, import, and frame authentic screenshots, recordings, diagrams, and B-roll in FRAME.
---

# Visual Asset Selection

## When & Why
Use when sourcing supporting visuals (`video_import`, `broll`, `scene`) to illustrate spoken concepts without misleading the viewer.

## How (Supported Operations)
- `video_import` local video, image, and audio assets from approved workspace/media roots.
- `broll` with explicit `fit` (`cover`, `contain`, `blur`) and `z` order.
- `scene` (`VisualScene`) for conceptual diagrams and vector paths (`VectorRun`).

## Limitations & Future Capabilities
- **Planned (Phase 3)**: Automated semantic asset search, stock metadata integration, and product-screenshot/screen-recording framing templates.
- Non-transcribed video clips are sampled carefully; inspect duration and content before placing.

## Common Mistakes & Prohibitions
- **No fabricated visual evidence**: Never label synthetic illustrations or mockups as genuine product recordings or real events.
- **No aspect distortion**: Never stretch images; use `contain`/`cover`/`blur` properly.

## Required Validation
Inspect rendered B-roll/asset frames to verify aspect ratio, sharpness, and factual alignment with narration.
