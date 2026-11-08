# Render and replace narration

## Delivered preview

`../trial-final/trial-visual-only.mp4`: 20 seconds, 1080×1920, 60 fps, silent. This is a design preview, not a completed voiceover-synchronized reel. `../trial-final/contact-sheet.png` and `frames/` are extracted from the actual MP4. Earlier iterations are retained in `../trial-v1/` and `../trial/`.

## Reproduce

Run in this repository using Node 22.18+ and FFmpeg with libx264. This machine already has the pinned Canvas dependency copied from the desktop application's local dependency bundle. On another machine install dependencies with `npm install`. No voice synthesis is used.

```powershell
node examples/explainer/render.mjs examples/explainer/preview.json
node examples/explainer/qa.mjs ../trial-final
node --test --test-concurrency=1 "packages/*/test/*.test.ts"
npm run typecheck
```

The renderer refuses to overwrite its existing main MP4. To reproduce, copy preview.json to another JSON in the same directory and change `output` to a new directory such as `../../../trial-rerender`, then pass that JSON to the command. Do not delete the delivered preview.

## Use a voiceover

Create a folder for your audio, optionally a script, and a measured word transcript. Put `voiceover.json` there:

```json
{
  "audio": "narration.wav",
  "transcript": "narration.words.json",
  "output": "render-01",
  "font": "Segoe UI",
  "captions": {"fontSize": 48, "highlight": true, "accent": "#5a9dff"}
}
```

Run `node examples/explainer/render.mjs "C:/path/to/voiceover.json"`. Every path in JSON resolves relative to that JSON. Outputs include `trial-captioned.mp4`, `trial-caption-free.mp4`, `timeline.json` and `captions.json`. Source narration is preserved and its final partial video frame is padded upward, not trimmed. Intermediate video masters are also retained.

Measured transcript shape:

```json
{"approx": false, "words": [{"w": "Imagine", "s": 0.21, "e": 0.63}]}
```

That single word is a format example, NOT timing for the supplied narration. Use actual timestamps for every word. SRT/segment-proportional word timing is intentionally rejected by this strict route. Do not set `approx:false` to disguise estimated timestamps.

If no transcript is supplied, install/configure an existing supported local recognizer. For whisper.cpp set `TMEP_WHISPER_CPP` and `TMEP_WHISPER_MODEL` to its executable and model file; for faster-whisper set `TMEP_PYTHON` to an interpreter with faster-whisper and add `"engine":"faster-whisper"`. These tools/models are not installed on this machine. The smallest immediate path is to supply narration plus its measured words JSON.

Optional `"script":"script.txt"` checks recognized text against the script. A mismatch stops rather than guessing timestamps; forced alignment must be done externally. Do not use the script as Whisper prompt/ground truth without checking recognition.

The default cue matcher targets the provisional generative-AI narration. For differently phrased narration, add `"sceneStarts":[0, ...four actual source-second boundaries...]`. Use real times for instruction, prompt/patterns, result and closing; each scene must be at least 0.6 seconds. Inspect `timeline.json` and adjust to the delivery. This version does not generate new visuals for unrelated topics.

## Add an optional presenter

Add one of these objects to the same configuration:

```json
"presenter": {"mode":"facecam", "path":"facecam.mp4"}
```

```json
"presenter": {"mode":"transparent", "path":"presenter.mov"}
```

A transparent PNG is also accepted. A normal MP4 does not imply transparency. Genuine compatible alpha is required in transparent mode; background removal is not provided. Use a video aligned to narration at time zero and long enough to cover it. Extra `*-presenter.mp4` exports retain the narration and keep the presenter above the caption band. Real presenter footage has not been supplied or visually verified.

## Review

Run QA against the desired export: `node examples/explainer/qa.mjs "C:/path/to/render-01" trial-captioned.mp4`. Inspect all extracted scene frames and transitions, then listen to the exported MP4 against the supplied narration. Input-to-frame caption rounding is less than 16.67 ms; aim to verify speech alignment within 100 ms, correcting word timestamps where needed. That real-speech tolerance has not yet been measured on the delivered silent preview.
