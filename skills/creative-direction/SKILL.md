---
name: creative-direction
description: Choose format, pacing, restraint level, and visual hierarchy before editing in FRAME.
---

# Creative Direction

## When & Why
Use at the start of any edit—before calling `video_plan`, `video_storyboard`, or `video_edit`—to define aspect ratio, pacing, typography style, and graphic density.

## How (Supported Operations)
- Select aspect ratio (`format 9:16|16:9|1:1`) and template (`reel`, `short`, `youtube`, `talking_head`, `podcast`, `explainer`, `cinematic_explainer`) via `video_plan` or `video_edit`.
- Explicitly disable unwanted motion (`zooms: false` in `video_plan`) when restrained framing is required.
- Use `video_storyboard` / `video_script` for structured educational or narrative sequences.

## Limitations & Future Capabilities
- Current templates (`templates.ts`) have repetitive defaults (`fit: cover`, `captions.pos: lower`). Override explicitly via `video_edit` (`captions`, `set`, `format`).
- Automated multimodal creative briefs are planned for Phase 4, not yet implemented.

## Common Mistakes & Prohibitions
- **No excessive zooms** or meaningless animations; do not leave punch-zooms active on calm educational explainers.
- **No unnecessary background changes** across continuous explanations.
- **No irrelevant graphics** auto-inserted where they distract from the speaker.

## Required Validation
Confirm aspect ratio, safe zones, and visual restraint on rendered preview frames (`video_render` with `frames: true`) against `QUALITY_STANDARDS.md`.
