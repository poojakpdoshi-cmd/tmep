---
name: typography-and-captions
description: Configure legible captions, safe-zone placement, and accurate transcript timing in FRAME.
---

# Typography and Captions

## When & Why
Use whenever speech captions or on-screen typography are enabled (`video_plan` / `video_edit` `captions` op).

## How (Supported Operations)
- Styles: `kinetic`, `karaoke`, `clean`, `boxed`, `none`.
- Positions: `upper`, `middle`, `lower` (`captions` op).
- Font staging via `packages/motion/src/fonts.ts` (OpenType `.ttf`/`.otf`/`.ttc`).

## Limitations & Future Capabilities
- Current `captions.ts` uses character-count wrapping (`maxChars`) and inline `\fscx114` scaling in `kinetic` mode (can cause horizontal word reflow jitter).
- **Planned (Phase 2)**: Pixel-measured wrapping (`ctx.measureText`), clause-aware breaks, non-jittering highlights, and global safe-zone/collision validation.

## Common Mistakes & Prohibitions
- **No inaccurate captions**: Never invent or proportionally fabricate word timestamps; flag `approx: true` on SRT/VTT imports.
- **No safe-zone violations**: Keep 9:16 captions clear of bottom `360px` and top `150px` platform UI zones, and never overlap `stat`/`lower_third` graphics.

## Required Validation
Inspect rendered caption frames from the encoded MP4 for line count (`<= 2`), contrast, safe-zone clearance, and graphic separation.
