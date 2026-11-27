---
name: quality-control
description: Verify rendered outputs against FRAME technical, visual, and audio standards before delivery.
---

# Quality Control

## When & Why
Use after every `video_render` (preview or final) before reporting completion to the user.

## How (Supported Operations)
- `video_render({ quality: "preview", frames: true })` to generate output + `-sheet.jpg` contact sheet.
- `ffprobe` stream check (video codec, `yuv420p`, `bt709`, exact dimensions, FPS, duration, audio stream) and `measureLoudness` when audio is present.
- `video_inspect({ what: "timeline" | "diff" })` to confirm edits landed as intended.

## Limitations & Future Capabilities
- Automated frame-level ink/contrast/safe-zone/collision QC gates across all routes are planned for Phase 2–3 (`scene.ts` SAT checks currently cover `VisualScene` only).

## Common Mistakes & Prohibitions
- **No unverified quality claims**: Never declare an export "clean" or "synced" without probing the actual encoded MP4 and inspecting rendered frames.
- **No silent-as-voiced claims**: Explicitly label no-audio renders as visual-only.

## Required Validation
Complete the 3-step Verification Checklist in `QUALITY_STANDARDS.md` on the final encoded MP4.
