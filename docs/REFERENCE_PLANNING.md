# Reference-aware planning

`plan --reference <video-asset>` / `video_plan {"reference":"v2"}` connects the existing FFmpeg pacing analyzer to the deterministic timeline planner. Import the reference with the normal import command. An explicit source is recommended; automatic source selection excludes the reference.

The planner uses the reference's median detected shot duration, clamped to 0.75–30 seconds. It searches for a sentence-ending word or a pause of at least 350 ms, rounds the gap midpoint to a timeline frame, and rejects any rounded boundary inside a word. A greedy nearest-boundary rule avoids tiny shots/tails and leaves speech intact if no nearby safe boundary exists. Ties resolve to the earlier boundary. Source time is preserved in contiguous clips, captions and existing content-derived graphics retain their anchors. Cuts alternate a restrained 1.00/1.06 crop; this is a generic reframing rule, not a copy of reference camera work.

Reference mode requires word-level timestamps for every source. Missing, approximate subtitle timings, overlapping or out-of-bounds times are rejected. Imported JSON is trusted as measured unless marked `approx: true`; the engine cannot independently establish timing accuracy. Images without transcripts are not supported in this mode. The normal planner remains unchanged when `reference` is omitted.

## Limits

- Reference mode preserves all narration and silence: `target` is ignored, with a warning. It does not speed up audio, remove fillers, or choose alternate takes. Each source is processed separately.
- Crossfade transitions are disabled in this mode to avoid overlapping narration. Existing caption/graphics/zoom/SFX rules and feature switches still apply.
- Median pacing is advisory, not an exact cut count or ordered shot pattern. Continuous speech can produce substantially fewer cuts than the reference. Sentence detection uses punctuation; punctuation quality and measured timing matter.
- The analyzer uses its existing defaults (15 fps, 320 px wide, threshold 0.3, first 120 seconds). Custom scans do not override plan defaults. Flashes can be false cuts; dissolves and rapid cuts can be missed. Only the scanned portion influences the median.
- No typography, motion, color, music-beat, semantic scene matching or full style replication. Audio/video retain the existing renderer's frame rounding and clip-edge audio processing; source ends can round by half a frame.

## Reproduction and validation

```bash
npm run typecheck
npm test
npm run test:e2e
node --test packages/story/test/reference.test.ts tests/reference.test.ts
```

Unit tests cover deterministic pace changes, preservation of word intervals, continuous speech, pause-based cuts, unsafe frame rounding and invalid inputs. The end-to-end test generates actual encoded MP4 fixtures locally with FFmpeg: moving source footage with audio and slow/fast alternating hard-cut references. It runs import, timestamp import, analysis/cache, planning, caption compilation, rendering, probing and the CLI. Missing FFmpeg fails this test rather than silently skipping it. These controlled tone/timestamp fixtures test synchronization and media integration, not natural speech recognition or subjective editing quality. No fixture is a promotional reel or evidence of full reference-style replication.
