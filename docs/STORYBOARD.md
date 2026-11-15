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

## Automatic planning from plain text

Phase 2 was implemented on November 15, 2026 as pre-hackathon infrastructure before November 21.

```sh
node bin/tmep.js script lesson.txt --wpm 150 --pretty > plan.json
node bin/tmep.js script lesson.txt -p ./project --compile-only
node bin/tmep.js script lesson.txt -p ./project --render --out video.mp4
node bin/tmep.js storyboard plan.json -p ./project --preview
```

The first command writes only Phase 1 JSON to stdout and never changes a project. Warnings go to stderr. Edit the generated JSON before passing it to `storyboard`. The compile and render commands explicitly append a new revision, keeping earlier revisions available through undo or checkout. Use `--preview` with direct rendering for a smaller MP4. Pass an imported audio ID with `--narration a1`. The planner leaves the source script and planned scene timing intact, regardless of the audio length. Audio follows the existing storyboard trim and silence rules.

The engine API exposes `planScript(text, { wpm, narration })`, returning `{ storyboard, frames, warnings }`. Pass the plan or an edited copy to `storyboard(ctx, plan)`, then use `render(ctx, { rev, preview, out })` with the returned revision.

The planner uses sentence and line boundaries, with explicit English sequence cues such as “First”, “Next”, and “Finally” for runs of up to three process steps. Other passages use the animated explanation template. Display labels are excerpts from the script. The original text remains in the JSON and project revision. Durations estimate speech at 60–240 WPM, defaulting to 150. The planner rounds cumulative timing onto the 30 fps grid. It does not align audio or infer pauses from recordings.

Inputs are limited to 20,000 characters, 16 scenes, and 60 seconds per scene. Passages without a clear label are rejected. The stock templates cannot infer specialized diagrams, illustrations, assets, or narrative intent. Use custom Visual Scenes or revise the generated JSON for those scripts. There is no TTS or model invocation.

For paired comparisons, use the `comparison` template with `first` and `second` labels. They enter in sequence and remain visible together. The script planner recognizes `whereas` and comma-delimited `while` between two clauses of at least three words. Review ambiguous uses of `while` and shortened labels in the generated JSON.
