# Changelog

## Unreleased — Phase 2.4A b-roll overlay effects

- The existing `fx` op now accepts explicit b-roll ids (`bN`) for keyframes, zoom/pan, opacity, and shape masks. Untargeted operations still affect only main clips.
- B-roll effects preserve transparency from source images, geometric transforms, opacity and animated masks, revealing the underlying video instead of flattening to a solid background.
- Overlay effect timing continues correctly across separate render units; tiny FFmpeg pixel tests cover alpha and masked compositing. Graphics-layer effects remain out of scope.


## Unreleased — Phase 2.3 effects engine

- Clip effects (`Clip.fx`, optional, backward compatible): keyframed scale/position/rotation/opacity
  with six easings; zoom in/out, push/pull and pan presets that compile to editable keyframes;
  rect/ellipse/convex-polygon masks with feathering, inversion, intersection and animated reveals.
- New `fx` op (compact strings over CLI `tmep edit` and MCP `video_edit`); timeline summaries show `fx[...]`.
- Renderer: one per-frame `perspective` for transforms (background-filled), `blend`+`sendcmd` for
  opacity, `geq` signed-distance masks at half resolution.

## 0.1.0 (2026-11-08)

First working milestone.

- Core: zero-dependency schema validation with JSON Schema output and "did you mean" errors;
  frame-exact timeline; source-anchored items; TMEP ops (object and compact string forms);
  atomic batches; immutable revisions with undo/redo/checkout; structural diffs; error codes.
- Speech: whisper.cpp and faster-whisper adapters; SRT/VTT/JSON import; transcript caching
  by content hash; sentence/keyword analysis; rough cut to target length; BM25 search with
  concept expansion; Hinglish transliteration.
- Motion: ASS/libass compiler; kinetic, karaoke, clean and boxed captions; 11 presets;
  30 original icons; OS font discovery with per-job font staging.
- Story: 7 templates; deterministic storytelling rules with density limiting; transitions
  with silence handles; synthesized sound design.
- Render: content-hashed segment rendering, previews, segment previews, alpha overlays,
  continuous audio mix with ducking and loudness normalization, background jobs with
  progress and cross-process cancellation, ffprobe verification.
- Interfaces: dual-era MCP stdio server (8 tools) and `tmep` CLI.
- Tests: unit, MCP protocol and end-to-end render suites; token benchmark.
