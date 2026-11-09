# Changelog

## Unreleased — Stabilization B1: timeline cut correctness

- Fix (audit P1-1): `cut` removes the timeline range only from the placed clips under it. Other
  clips that reuse the same source footage are no longer cut. The `cut Ns` note now reports
  timeline seconds (it reported source seconds, e.g. double on 2x clips).
- `delete` / `tighten` keep their documented source-wide behaviour.

## Unreleased — Stabilization A: render reliability

- Fix: concurrent renders of one project (e.g. preview + final) no longer collide on temporary
  files or crash the process; same-project renders are queued in-process, cache entries are
  published atomically (a failed publish is accepted only if the existing entry validates).
- Fix: a failing audio mix (or any unit failure) during rendering is returned as a job error;
  sibling FFmpeg processes are aborted and temporary files removed. No unhandled rejections.
- Fix: jobs whose process died are reported as `error` / `E_INTERRUPTED` instead of `running` forever
  (pid liveness + heartbeat; backward compatible with existing job records).
- Tests: subprocess-isolated regression tests in `tests/render-reliability.test.ts`.

## Unreleased — Phase 2.5A deterministic overlay stacking

- Optional integer z (-100..100) on b-roll and graphics, editable by `set <id> z=N` or at creation.
- Stable compositing order across both media and graphics overlay types; higher z renders in front.
- Legacy default ordering retained (b-roll before independently effected graphics; captions/plain graphics on top).
- Graphics with explicit z are isolated into transparent ASS overlays even when no effects are attached.
- Core validation, graph ordering and 64x64 FFmpeg pixel regression tests.


## Unreleased — Phase 2.4B graphics-layer effects

- `fx` accepts graphics preset ids (`gN`), reusing keyframes, pan/zoom, opacity and mask reveals on a whole graphic group.
- Effected presets compile into separate local-time ASS documents, which are alpha-composited above b-roll without altering legacy graphics or captions.
- Supports graphics spanning multiple render units with continuous animation timing and effect-aware cache keys.
- Alpha-only graphics export with effected presets currently produces an explicit unsupported-operation error (not a silently incomplete render).


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
