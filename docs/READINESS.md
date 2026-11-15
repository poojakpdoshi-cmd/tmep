# TMEP pre-hackathon readiness

**PRE-HACKATHON DEVELOPMENT · November 15, 2026.** The verified starting point is [main at 1de61045](https://github.com/poojakpdoshi-cmd/tmep/commit/1de61045cf1205afa7592bbb6525b70935f565f8), which includes PR #22. The November 21 workflows below use the existing renderer and deterministic planner.

## Install and check

1. Clone the repository and open a terminal at its root.
2. Use Node.js 22.18 or newer with npm. Install a full FFmpeg build with FFmpeg and FFprobe on PATH, including libass, libx264 and AAC encoding. On Windows, verify both executables in a fresh PowerShell session.
3. Run these commands from the repository root.

```powershell
npm install --no-audit --no-fund
node bin/tmep.js doctor
node examples/readiness/smoke.mjs --keep
```

The smoke command uses two fresh temporary projects with spaces in their paths. It generates two one-second original synthetic clips with solid colors and tone audio. It checks edit history, error handling, scene validation, preview cache reuse, decoded-frame equality, and MP4 codecs, dimensions and frame counts. `--keep` prints the folder containing the inputs and outputs. Omit it to clean up automatically.

## Script to video

```powershell
node bin/tmep.js script examples/readiness/lesson.txt --pretty | Set-Content -Encoding utf8 lesson-storyboard.json
node bin/tmep.js storyboard lesson-storyboard.json -p ./lesson-project --compile-only
node bin/tmep.js inspect scenes -p ./lesson-project
node bin/tmep.js render -p ./lesson-project --preview --out preview.mp4
node bin/tmep.js render -p ./lesson-project --out export.mp4
```

Edit the JSON before compiling to customize the storyboard. Compiling adds a revision. Render paths are relative to the project. To add existing narration, import an audio file into that project, then use its ID in the JSON's `narration` field. [Storyboard documentation](STORYBOARD.md)

## Synthetic raw clips

Use a fresh project for the commands below. Copy both synthetic inputs from the smoke test's `raw project` folder, substituting the printed folder path.

```powershell
New-Item -ItemType Directory ./raw-demo
Copy-Item -Path '<smoke-folder>/raw project/red.mp4', '<smoke-folder>/raw project/blue.mp4' -Destination ./raw-demo
node bin/tmep.js import red.mp4 blue.mp4 -p ./raw-demo
node bin/tmep.js edit "add v1" "add v2" -p ./raw-demo
node bin/tmep.js edit "cut 0.5 1" -p ./raw-demo
node bin/tmep.js inspect timeline -p ./raw-demo
node bin/tmep.js render -p ./raw-demo --preview --out edited.mp4
```

Basic raw editing uses existing clip operations without a speech model. Word-level captions and speech-driven edits require imported transcript timestamps or a separately installed supported transcription engine.

## Limits

The script planner uses stock templates, English sequence cues, and estimated narration timing. Bespoke visuals may require editing storyboard JSON. Model-based creative planning, research, TTS, and automatic speech alignment are outside this baseline. The smoke test verifies files and workflow behavior. It provides no performance or visual-quality measurement.

## Verification on November 15

Windows x64, Node v24.19.0, FFmpeg 9.0. The script workflow exported 204 frames at 30 fps in both preview and full resolution. The second preview reused 2 of 2 video units and decoded to the same frames. The raw edit exported 45 frames after undo and redo checks. Both outputs contained H.264 video and AAC audio. The local smoke test used an existing dependency installation. A separate fresh npm install on this host stopped with EPERM while creating a dependency directory. The Windows Node 24 CI job also runs the smoke test after dependency installation.
