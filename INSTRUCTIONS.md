# INSTRUCTIONS.md — Operating FRAME via MCP & CLI

FRAME exposes its editing engine through **MCP** (`bin/tmep-mcp.js` / `frame-mcp`) and **CLI** (`bin/tmep.js` / `frame`), backed by the internal **Token-Minimal Editing Protocol (`tmep/1`)**.

## 1. Standard Agent Workflow

1. **Environment Check**: Use `video_doctor` (MCP) or `tmep doctor` (CLI) to verify FFmpeg, encoders, and speech engines (`whisper.cpp` / `faster-whisper`).
2. **Import Media**: `video_import` with explicit paths inside approved workspace/media roots.
3. **Transcribe**: `video_transcribe` (single) or `video_transcribe_batch` (multiple files, reuses `faster-whisper` model load) or import `.json`/`.srt`/`.vtt`.
4. **Plan**: `video_plan` (from transcript/media) or `video_script` / `video_storyboard` (structured scenes).
5. **Edit**: `video_edit` with compact TMEP op strings (e.g. `cut`, `delete`, `tighten`, `broll`, `gfx`, `scene`, `fx`, `transition`, `zoom`, `music`, `sfx`, `set`, `captions`, `format`, `loudness`). Pass `expectedRev` for optimistic concurrency when multiple agents may edit.
6. **Inspect**: `video_inspect` (`what: project|assets|timeline|transcript|silence|diff|log|jobs`). Read-only; does not create missing projects.
7. **Render & Poll**: `video_render` (use `quality: "preview"` while iterating, `quality: "final"` for export; `frames: true` for contact sheet). Poll `video_status` or cancel via `notifications/cancelled` / `video_status({ job, cancel: true })`.

## 2. Implemented vs Future Capabilities

- **Implemented now**: Local import & content hashing, Whisper adapters & JSON/SRT/VTT import, deterministic timeline & revision history, 23 TMEP ops, `kf` (`s,x,y,r,o`) & `mask` (`rect`, `ellipse`, convex `poly`), 11 ASS presets, `VisualScene` + `@napi-rs/canvas` `VectorRun`, FFmpeg `xfade`, 3-stage audio mixer + `sidechaincompress` ducking + 6 SFX + conditional `loudnorm`, crash-safe jobs.
- **Planned (Phase 2+)**: Generalized `CanvasRun` cards/charts/text, pixel-measured caption wrapping & global collision/safe-zone engine, J/L-cuts, speed ramps, stabilization, blur/glow/LUTs/colour grading, two-pass audio mastering, multimodal video intelligence. Do **not** invoke or promise planned capabilities as if they exist today.

## 3. Token Optimization Rules

- Use `detail: "minimal"` on `video_inspect` / `video_edit` when only confirming success or reading IDs.
- Use `video_help` with specific topics (`ops`, `anchors`, `presets`, `templates`, `sfx`, `icons`, `captions`, `storyboard`, `scene`). Request `schema: true` only when full JSON Schema is strictly needed.
- Batch related timeline edits into a single atomic `video_edit` `ops` array.
