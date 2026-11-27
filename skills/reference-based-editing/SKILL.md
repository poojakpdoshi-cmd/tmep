---
name: reference-based-editing
description: Analyze reference reel shot pacing and apply pacing targets safely in FRAME.
---

# Reference-Based Editing

## When & Why
Use when the user supplies a reference video to match its cutting cadence (`video_reference` + `video_plan({ ref })`).

## How (Supported Operations)
- `video_reference` measures shot cuts (`cutCount`, `cuts[]`, `meanShotSec`, `medianShotSec`, `cutsPerMinute`, `pacing`).
- `video_plan` / `referenceRanges` uses `shot` duration (`[0.75, 30]s`) while cutting **only** at sentence boundaries or pauses `>= 0.35s`.

## Limitations & Future Capabilities
- `reference.ts` currently detects hard-cut timestamps via FFmpeg `select=gt(scene,...)` only. It does **not** analyze visual composition, typography, color palette, or music beats.
- **Planned (Phase 4)**: Multimodal style, framing, and audio-energy reference extraction.

## Common Mistakes & Prohibitions
- Claiming full style replication from `video_reference` when only shot-cut pacing is measured.
- Forcing cuts mid-word when speech has no pause boundary.

## Required Validation
Verify `video_inspect({ what: "timeline" })` shot durations and confirm no clipped words in the rendered output.
