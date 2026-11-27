---
name: colour-grading
description: Manage colour space tagging, exposure consistency, and planned grading workflows in FRAME.
---

# Colour Grading

## When & Why
Use to ensure consistent, broadcast/web-compliant colour output and avoid washed-out or clipped exports.

## How (Supported Operations)
- Current FFmpeg output (`graph.ts`) automatically tags exports with `-pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709`.
- Opacity/contrast composition via `kf` (`o` property) and timeline `settings.bg`.

## Limitations & Future Capabilities
- **Planned (Phase 3)**: Input colour-space conversion (`colorspace`/`zscale` for HDR/BT.601 → BT.709), exposure/contrast/saturation/temperature/tint controls, `.cube` LUTs, shot matching, and skin-tone preservation are **not yet implemented**.

## Common Mistakes & Prohibitions
- Assuming BT.709 metadata tagging converts HDR or BT.601 footage automatically (it does not in Phase 1).
- Over-saturating or clipping highlights without checking decoded frames.

## Required Validation
Verify `ffprobe` stream colour tags (`bt709`, `yuv420p`) and visually inspect decoded frames for exposure/contrast issues.
