# Changelog

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
