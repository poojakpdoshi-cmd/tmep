---
name: token-optimization
description: Minimize token and compute overhead when operating FRAME via MCP or CLI.
---

# Token Optimization

## When & Why
Use on every multi-step agent session to preserve the ~83.8x TMEP output-token advantage and avoid context bloat.

## How (Supported Operations)
- Pass `detail: "minimal"` on `video_inspect` and `video_edit` unless full payloads are needed.
- Batch related timeline changes into a single `video_edit` `ops` array instead of one tool call per op.
- Use `video_help` with a specific topic (`ops`, `anchors`, `presets`, etc.) and avoid `schema: true` unless you need the raw JSON Schema.
- Iterate with `video_render({ quality: "preview" })` before `quality: "final"`.

## Limitations & Future Capabilities
- Phase 1 replaces oversized `help('storyboard')` (~7k tokens) and `help('scene')` (~6k tokens) raw schema dumps with compact summaries.

## Common Mistakes & Prohibitions
- Writing raw FFmpeg filtergraphs or ASS scripts in agent output instead of using TMEP ops.
- Polling `video_status` in tight loops (use `wait` on `video_render` or `notifications/cancelled`).

## Required Validation
Keep `video_edit` calls batched and confirm final state via a single `video_inspect` summary.
