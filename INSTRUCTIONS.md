# INSTRUCTIONS.md — Operating FRAME via MCP & CLI

FRAME exposes its editing engine through **MCP** (`bin/tmep-mcp.js` / `frame-mcp`) and **CLI** (`bin/tmep.js` / `frame`), backed by the internal **Token-Minimal Editing Protocol (`tmep/1`)**.

## 1. Standard Agent Workflow

1. **Environment Check**: Use `video_doctor` (MCP) or `tmep doctor` (CLI) to verify FFmpeg, encoders, and speech engines (`whisper.cpp` / `faster-whisper`).
2. **Import Media**: `video_import` with explicit paths inside approved workspace/media roots.
3. **Transcribe**: `video_transcribe` (single) or `video_transcribe_batch` (multiple files, reuses `faster-whisper` model load) or import `.json`/`.srt`/`.vtt`.
4. **Plan**: `video_plan` (from transcript/media) or `video_script` / `video_storyboard` (structured scenes).
5. **Edit**: `video_edit` with compact TMEP op strings (e.g. `cut`, `delete`, `tighten`, `broll`, `gfx`, `scene`, `fx`, `transition`, `zoom`, `music`, `sfx`, `set`, `captions`, `format`, `loudness`). Pass `expectedRev` for optimistic concurrency when multiple agents may edit.
6. **Inspect**: `video_inspect` (`what: project|assets|timeline|transcript|silence|diff|log|jobs|scenes|qa|footage|brief`). Read-only; does not create missing projects.
7. **Render & Poll**: `video_render` (use `quality: "preview"` while iterating, `quality: "final"` for export; `frames: true` for contact sheet). Poll `video_status` or cancel via `notifications/cancelled` / `video_status({ job, cancel: true })`.

## 2. Implemented vs Future Capabilities

- **Editing**: import & content hashing, Whisper adapters & JSON/SRT/VTT import, revisions with `expectedRev`, clip-instance anchors, TMEP ops incl. `jcut`/`lcut` (notes report the handle actually available), `ramp` (one shared video/audio time map), `freeze`, `reverse`, `punch`, `matchcut`, `reframe`, `stabilize` (FFmpeg `deshake`), `splitscreen`, `pip`, `parallax`.
- **Effects & colour**: `kf` (s,x,y,r,o), masks (rect/ellipse/poly/concave/bezier; concave/bezier keys and reveals are frame-accurate), blur (gaussian, true directional), glow, shadow, blend modes, chroma key, motion blur, perspective, effect chains, 22 transitions + presets; automatic BT.601/BT.2020/PQ/HLG → BT.709 (zscale; HDR tone-mapped at 203-nit reference white), grade ops, `.cube` LUTs.
- **Audio**: dialogue EQ, denoise, static de-ess notch, compression (absolute thresholds: quiet sources may not compress), limiter, fades, two-pass loudness, platform targets.
- **Motion (Canvas scenes)**: measured text, gradients, shadows, charts, kinetic text (`anim` by char/word/line), path `morph`, `motionPath`, `reveal`, `depth` parallax, scene `mblur` and `focus`; 14 easing curves.
- **Compiler presets** (`video_plan`/`api.compile` intent): `kinetic_title`, `lower_third`, `callout`, `ui_demo`, `animated_diagram`, `dynamic_chart` with style profiles (`editorial`, `bold`, `minimal`, `documentary`, `sports`, `tech`); placement avoids captions, safe zones and `avoid` regions and reports every correction.
- **QA**: `video_inspect {what:"qa"}` (A/V sync, loudness, clipping, black/silence, safe zones, collisions).
- **Footage intelligence** (`video_inspect {what:"footage"|"brief", asset, task}`): shots, scenes, motion, quality, audio activity, silences, quiet regions, candidate moments with evidence; faces (OpenCV < 5) and visible text (tesseract) only when installed — otherwise reported `unavailable`. Briefs: `informative|sports|cinematic|product|generic`. Compile presets with `footage: "v1"` to keep graphics off the presenter.
- **Not implemented yet** (do not promise): event recognition (goals, wickets…), object detection, gesture regions, ASR without an installed engine, automatic creative direction, pitch-preserving variable-speed audio beyond piecewise `atempo`.

## 3. Token Optimization Rules

- Use `detail: "minimal"` on `video_inspect` / `video_edit` when only confirming success or reading IDs.
- Use `video_help` with specific topics (`ops`, `anchors`, `presets`, `templates`, `sfx`, `icons`, `captions`, `storyboard`, `scene`). Request `schema: true` only when full JSON Schema is strictly needed.
- Batch related timeline edits into a single atomic `video_edit` `ops` array.
