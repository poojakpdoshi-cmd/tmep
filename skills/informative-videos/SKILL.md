---
name: informative-videos
description: Produce clear, restrained educational explainers, tutorials, and informative reels in FRAME.
---

# Informative Videos

## When & Why
Use for explainers, lessons, product walkthroughs, and commentary where comprehension and legibility come first.

## How (Supported Operations)
- **Start from the footage**: `video_inspect {what:"brief", asset, task:"informative"}` (after `video_transcribe`) gives the topic, top statements, candidate trims, stat/list/step cues and free graphic regions. Compile presets with `footage: "<asset>"` so lower thirds and callouts avoid the presenter.
- `video_script` / `video_storyboard` (`process`, `explanation`, `comparison` scenes) or `video_plan` with `template: "explainer"` / `"cinematic_explainer"` and `zooms: false` when static framing is preferred.
- `captions` (`clean` or `boxed`) positioned clear of visual diagrams.

## Limitations & Future Capabilities
- `planScript` is English-only and estimates duration at `wpm` (default 150).
- `storyboard.ts` uses fixed `9:16` / `30fps` defaults; generalized multi-ratio Canvas cards/diagrams arrive in Phase 2.

## Common Mistakes & Prohibitions
- **No excessive zooms** or distracting `flash`/`icon` spam.
- **No unnecessary background changes** between consecutive explanation steps.
- **No irrelevant graphics** or sparse sub-1% ink frames.

## Required Validation
Inspect every scene transition, verify text contrast and safe zones, and confirm captions never collide with diagrams.
