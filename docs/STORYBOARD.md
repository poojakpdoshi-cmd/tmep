# Storyboard-to-video foundation

Phase 1 was implemented on November 15, 2026, as pre-hackathon infrastructure before November 21, 2026.

A storyboard specifies a script and an ordered visual plan. TMEP compiles it to one editable project revision and renders it using the existing Visual Scene and FFmpeg pipeline.

```json
{
  "v": 1,
  "script": "A request goes in. A result comes out.",
  "scenes": [
    {"template":"process","title":"Request flow","steps":["Input","Output"],"frames":60},
    {"template":"explanation","title":"The result","point":"Less waiting","frames":75,"transition":"fade"}
  ]
}
```

```sh
node bin/tmep.js help storyboard
node bin/tmep.js storyboard plan.json -p ./project --out video.mp4
```

Use `--compile-only` to create the revision without rendering or `--preview` for 540×960 output. The default MP4 is 1080×1920 at 30 fps. The plan path is relative to the current working directory. The output path is relative to the project. Omit `--out` for the revision's default render path. Compiling creates a new timeline revision. Previous edits remain accessible via undo or checkout.

For API callers, `api.storyboard(ctx, plan)` validates and commits the revision, returning `rev`, `frames`, `dur`, and `scenes`. Then call `api.render(ctx, { rev, out: 'video.mp4', parallel: 1 })` to render that exact revision. Existing job status, cancellation, and recovery apply. The script is stored in revision metadata. A script-only edit can reuse the existing video and vector caches.

## Scene plan

- Supply 1–16 scenes, each with 6–1800 whole frames. At 30 fps, starts and the final duration are exact frame counts. Scenes play consecutively.
- `process` uses a path reveal and staggered animated labels for two or three steps.
- `explanation` animates a shape and brings in the title and point with coordinated motion and opacity.
- `custom` accepts `visual` with the `layers`, `styles`, `groups`, `camera`, and `safe` fields from [Visual Scene](VISUAL_SCENE.md). Frame count and placement come from the storyboard. Import referenced media into the same project first.
- `transition` defaults to `cut`. `fade` reveals the incoming scene from black over up to nine frames without overlapping scenes or changing duration. Fade reserves one layer and one style and requires a scene without camera keys. For custom fades, the reserved IDs are `storyboardFade` and `storyboardBlack`.
- For narration, import existing audio with `node bin/tmep.js import voice.wav -p ./project` and put the returned audio ID in the top-level `narration` field. Audio starts at frame zero, is trimmed to the timeline if longer, and is followed by silence if shorter. Timing is quantized to whole frames. The script and scene plan are authored separately from the recording.

Script-only generation still needs a planner to turn prose into timed scenes and select or create assets. Automatic narration and script-to-audio alignment are outside Phase 1. No performance comparison has been measured.
