# Explainer rendering architecture

The existing TMEP 0.1.0 engine, CLI/MCP, timeline, storage, legacy renderer and presets remain available. The new focused workflow lives inside the same repository and is invoked with `npm run explainer -- config.json`. It is not yet exposed as a separate MCP tool.

## Pipeline

1. `examples/explainer/render.mjs` reads JSON configuration and probes narration with the existing FFmpeg adapter.
2. Import a measured words JSON transcript, or use the existing local whisper.cpp/faster-whisper adapters. Segment-only/approximate words are rejected in this route. A supplied script is compared to transcript content; a mismatch stops rendering. It is not silently treated as forced alignment.
3. `explainer-plan.ts` validates words, derives sentence/phrase and pause boundaries, and creates five scene boundaries from spoken cues or explicit source-second anchors. Duration is rounded UP to a 60 fps frame boundary, preserving the entire narration. Speech and pauses are not automatically cut.
4. `explainer-canvas.mjs` draws at integer frame indices with Skia Canvas. Smootherstep easing has zero endpoint velocity and acceleration. Typography uses measured font widths; caption groups have at most two lines, no page overlap, and no scale animation. Word emphasis changes color only. No artificial frame interpolation is used.
5. FFmpeg receives RGBA frames through a backpressured pipe, encodes H.264/yuv420p, and muxes one continuous AAC narration track. Both caption-free and captioned versions are generated when audio exists. Without audio, a visible preview label is mandatory and no subtitles or audio are fabricated.
6. Optional presenter composition uses a reserved lower-right area above captions. Visual content is reduced to the top band first. The facecam's audio is ignored. Alpha is accepted only when the input declares a compatible pixel format or alpha metadata; no background removal is implied.
7. `qa.mjs` decodes the exported MP4, checks dimensions/rate/frame count, measures adjacent downsampled frame differences, and extracts scene, first/last and transition frames for visual inspection.

## Why Canvas plus FFmpeg

ASS remains well suited to legacy captions, but its centisecond events, preset transforms and approximate text sizing are awkward for a persistent image-generation illustration. Canvas adds one pinned runtime dependency, `@napi-rs/canvas@0.1.100`, and retains FFmpeg. The final 1200-frame export demonstrates native 60 fps at 1080×1920; a browser/React migration is unnecessary for this composition. Font rendering may vary across platforms; use the same font, Canvas and FFmpeg versions for reproducible pixels. Rendering is deterministic for those fixed inputs, not guaranteed byte-identical across different encoders/platforms.

## Boundaries and remaining work

This is one text-to-image explainer, not a general autonomous scene designer. The artwork is an original procedural vector landscape, explicitly labeled as an illustration; no AI image-generation inference runs. Automatic cue matching is intentionally narrow and requests explicit sceneStarts when it cannot find cues. Arbitrary subjects need a new storyboard/composition.

Forced alignment is not installed. Imported timestamps carry provenance only as provided by the user/recognizer; frame precision does not prove ASR accuracy. Caption quantization is under one 60 fps frame (16.67 ms) relative to valid input timestamps, while real speech alignment remains to be measured. Local Whisper adapters are retained but could not be exercised because their binaries/models are absent.

Transparent presenter videos may need codec-specific decoder support (notably VP9 alpha); real user assets require validation. The renderer does not do masking, face tracking or audio offset detection. Presenter inputs must already align to narration time zero and cover its full duration.
