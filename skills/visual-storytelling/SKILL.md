---
name: visual-storytelling
description: Structure scripts, storyboards, and B-roll/graphic pacing to clarify ideas visually.
---

# Visual Storytelling

## When & Why
Use when turning a script, narration, or raw clips into a coherent visual narrative (`video_script`, `video_storyboard`, `broll`, `scene`).

## How (Supported Operations)
- `video_script` / `video_storyboard` for `process`, `explanation`, `comparison`, or `custom` `VisualScene` layouts.
- `broll` with explicit `z` ordering and `fx` (`kf`/`mask`) to layer supporting footage over the main track.
- `scene` op in `video_edit` for declarative `VisualScene` compositions.

## Limitations & Future Capabilities
- `planScript` is English-only and estimates timing at `wpm` (default 150) without forced alignment.
- Generalized `CanvasRun` cards/charts/diagrams are planned for Phase 2; current `VectorRun` supports `path` layers.

## Common Mistakes & Prohibitions
- **No fabricated visual evidence**: Never present conceptual illustrations as real product demos or events.
- **No sparse/empty frames** or overcrowded scenes; ensure graphics directly reinforce the spoken point.

## Required Validation
Verify that every scene transitions cleanly without double-exposed text and fits inside `QUALITY_STANDARDS.md` safe zones.
