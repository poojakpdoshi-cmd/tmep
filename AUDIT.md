# TMEP rescue audit — 8 November 2026

## Source and evidence
Recovered the existing repository (including `.git`) from `Downloads/MOTION GRAPHICS/tmep-0.1.0.zip`. Base commit: `b8bd179`, TMEP 0.1.0. Work is in this extracted repository; no unrelated application was created. Original ZIP is untouched. Three initial Git differences are executable-bit changes caused by ZIP extraction on Windows, not content changes.

The reported 13.7-second cartoon trial and its generation code were not located. The nearby `hyperframes-reel-all-clips.mp4` probes as 18 seconds, 1080×1920, 30 fps; it cannot be assumed to be the rejected trial. No task-specific narration, facecam or style-reference reel was supplied. Claims about that missing trial's appearance or audio sync are therefore unverified.

## Measured/code-confirmed defects
- `packages/story/src/templates.ts`: default is 30 fps; reel enables alternating zoom, emphasis zoom every 3.5 seconds, kinetic captions, SFX, and graphics spacing of only 0.4 seconds.
- `packages/motion/src/presets.ts`: `pop()` overshoots to 110%; preset movements use linear ASS movement; the stat counter is ten discrete updates. These are real discontinuities/style decisions, not evidence of dropped frames in a missing video.
- `packages/motion/src/captions.ts`: kinetic highlights scale text to 114%; line wrapping estimates character counts rather than measured font width. Caption placement is fixed, with no facecam collision model.
- `packages/speech/src/transcript.ts`: segment-only results proportionally invent word boundaries and mark them approximate; generic words JSON loses an incoming `approx:true` flag. `makeTranscript()` accepts non-finite timestamps and can leave simultaneous starts overlapping.
- Baseline tests: 31/33 passed. Both MCP tests failed while deleting the still-running child process's working directory on Windows (EBUSY). The test cleanup does not await process termination.

## Design judgments (not measured failures)
Keyword-to-icon/stat rules in `packages/story/src/rules.ts` cannot explain a text-to-image transformation. The default collection of pop effects is unsuitable for the requested restrained educational style. ASS remains useful for subtitles and legacy presets, but complex persistent scene geometry is clearer in a dedicated per-frame Canvas composition. Retain legacy behavior for existing projects; add one focused explainer route.

## Reuse and limitations
Retain project storage, hashing, timeline operations, undo, FFmpeg discovery/encoding, speech adapters, transcript analysis, CLI/MCP, fonts and original tests. Audio is already mixed in a continuous pass (`packages/render/src/graph.ts`), avoiding per-segment AAC joins. Existing transitions account for frame timing; none of this requires replacing the editing engine.

Use Skia Canvas for deterministic frame-indexed geometry and measured text, with FFmpeg for H.264/AAC export. This adds one small rendering dependency rather than React plus a browser. 1080×1920/60 fps must be demonstrated by the actual export. Do not infer audio accuracy from frame accuracy: speech sync remains unmeasured until real narration is available.

The new voiceover route must reject approximate/invalid word timing, preserve the full audio duration, keep captions out of a reserved presenter area, and label a no-audio output as visual-only. Forced alignment is not currently installed; a supplied script may be checked against a real transcript but must not be converted into invented timestamps.
