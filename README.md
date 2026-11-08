# TMEP: video editing engine for AI agents

## New: focused text-to-image explainer

[Download the 1080×1920, 60 fps silent preview](preview/trial-visual-only.mp4) · [View the contact sheet](preview/contact-sheet.png)

The preview has no narration. Voiceover synchronization and real presenter footage still need validation; see the quality report for verified results and limitations.

The rescued 60 fps workflow and its limitations are documented in [RENDER_GUIDE.md](RENDER_GUIDE.md), [AUDIT.md](AUDIT.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [QUALITY_REPORT.md](QUALITY_REPORT.md). Start with `node examples/explainer/render.mjs examples/explainer/preview.json`. Without narration, this produces a clearly labeled silent design preview. The existing editing engine described below remains available.

**Turn raw footage into a finished reel with a handful of tool calls, not thousands of tokens of code.**

TMEP is a local-first video editing engine built for AI coding agents (Claude Code,
Claude Desktop, OpenAI Codex, Cursor, Google Antigravity, any MCP client, or any agent
that can run a shell command). The agent makes editorial decisions; TMEP does the heavy
lifting locally and deterministically: transcription, rough cut, captions, motion
graphics, zooms, sound design, mixing and rendering.

Its core idea is the **Token-Minimal Editing Protocol (TMEP)**: media, transcripts,
timelines and renders stay on disk behind short ids; the agent sends small intent-level
operations (`"zoom @the key phrase to=1.2"`) and receives compact answers.

```text
video_import {paths:["raw.mp4"]}                       -> {"assets":[{"id":"v1","dur":94.2}]}
video_transcribe {asset:"v1"}                          -> {"words":243,"lang":"en","fillers":9}
video_plan {template:"reel", target:30, title:"..."}   -> {"rev":1,"dur":29.8,"gfx":{"icons":1,"stat":1,"cta":1}}
video_render {preview:true}                            -> {"state":"done","out":"renders/r1-preview.mp4"}
video_edit {ops:["captions boxed","zoom @faster to=1.2"]} -> {"rev":2}
video_render {}                                        -> {"state":"done","out":"renders/r2.mp4","size":"1080x1920"}
```

On a measured benchmark task (raw clip -> 20 s captioned, animated reel + one revision),
the model wrote **217 tokens with TMEP vs 17,937** for a conventional shell-and-files
workflow, and cumulative context was **~6x lower** ([details and caveats](docs/BENCHMARKS.md)).

## Status

| Area | Status |
|---|---|
| Import + content-hash asset ids, probing, dedupe | Done, tested |
| Transcript import (SRT, VTT, JSON, whisper.cpp JSON) | Done, tested |
| whisper.cpp and faster-whisper adapters (word timestamps, VAD in faster-whisper, Hinglish prompt) | Implemented; output parsers unit-tested; **not run in this repo** (no engine available here) |
| Hinglish captions (Devanagari -> romanized, schwa deletion) | Done, unit-tested; recognition accuracy not measured |
| Silence/filler detection, rough cut to target length, transcript search | Done, tested |
| Declarative timeline: cuts, trims, speed, multi-clip, b-roll cutaways, transitions, undo/redo, diffs | Done, tested |
| Anchors (`@phrase`, `w:N`, `c:ID`) that keep effects synced through later edits | Done, tested |
| Captions: kinetic, karaoke, clean, boxed; corrections; safe-zone layout | Done, tested |
| Motion presets: title, lower third, icon cards, stat count-up, badge, bar chart, progress bar, CTA, keyword, icon, flash | Done, tested |
| 30 original vector icons + concept dictionary | Done |
| Storytelling engine (lists -> icons, numbers -> stats, steps, CTA, emphasis zooms) with density limits | Done, tested |
| Templates: reel, short, talking_head, tutorial, product_demo, cinematic_explainer, youtube | Done, tested |
| Audio: crossfades, edge de-clicking, ducked music bed, synthesized SFX, loudness normalization | Done, tested |
| Rendering: content-hashed segments, previews, segment previews, alpha overlays, background jobs, progress, cancellation, verification | Done, tested |
| MCP server (8 tools, dual-era: 2024-11-05 .. 2025-11-25 handshake + 2026-07-28 stateless) | Done, protocol-tested over stdio; client configs documented, **not tested inside each client** |
| CLI | Done, used by tests and examples |
| Token benchmark | Done; heuristic tokenizer offline, exact counts via `--anthropic` (not run here) |
| GitHub Actions (Linux/Windows/macOS x Node 22/24) | Workflow written; **not yet run** |
| Smart reframing (face/motion-aware crop), motion tracking | Planned |
| Remotion bridge for React overlays (optional; license review needed) | Planned |
| Embedding-based semantic search (current search is BM25 + concept expansion) | Planned |
| Hardware encoders (NVENC/QSV/VideoToolbox) | Encoder args present, opt-in, untested |

## Quick start

Requirements: **Node.js >= 22.18** (runs the TypeScript sources directly) and **FFmpeg**
with libass and libx264 (the default builds from gyan.dev/BtbN on Windows, Homebrew on
macOS and most Linux distros qualify).

```bash
git clone https://github.com/<you>/tmep && cd tmep
node bin/tmep.js doctor            # checks FFmpeg filters/encoders and speech engines
node examples/demo/demo.ts         # no footage needed: synthesizes a clip and renders a reel
```

Windows:

```powershell
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg
git clone https://github.com/<you>/tmep; cd tmep
node bin\tmep.js doctor
node examples\demo\demo.ts
```

No `npm install` is needed to run TMEP (zero runtime dependencies). `npm install` only adds
the TypeScript compiler and Node types for development.

### Speech-to-text (optional, local)

- **whisper.cpp** (recommended, no Python): download a release from
  [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases), put `whisper-cli`
  on PATH (or set `TMEP_WHISPER_CPP`), and place a model such as `ggml-base.bin` in
  `~/.cache/tmep/models` (or set `TMEP_WHISPER_MODEL`).
- **faster-whisper** (NVIDIA GPU users): `pip install faster-whisper`.
- **Bring your own**: `tmep transcribe v1 --file subs.srt` (SRT, VTT or JSON).

## Use it from an agent

Add the MCP server (paths absolute). Claude Code:

```bash
claude mcp add --transport stdio tmep --env TMEP_PROJECT=/path/to/my-reel -- node /path/to/tmep/bin/tmep-mcp.js
```

Then ask: *"Edit raw.mp4 into a professional 30-second Instagram reel with animated
subtitles, smooth transitions, motion graphics, dynamic zooms and sound effects."*

Configs for Claude Desktop, Codex, Cursor and Antigravity: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)
and [examples/mcp-configs](examples/mcp-configs).

## Use it from the CLI

```bash
T="node bin/tmep.js -p my-reel"
$T init
$T import raw.mp4 music.mp3                     # -> v1, a1
$T transcribe v1 --lang auto                    # or --file subs.srt
$T plan --template reel --target 30 --title "AI video in 30s" --music a1
$T render --preview --frames 6                  # half-res preview + contact sheet
$T inspect transcript --find "pricing"          # selective read
$T edit "delete fillers=true" "zoom @the secret to=1.2" "gfx stat @ninety props.value=90%"
$T render                                       # reuses unchanged segments
$T undo                                         # back to the previous revision
```

`tmep help ops|anchors|presets|templates|sfx|icons|captions` prints references.

## How it works

```
agent --(8 MCP tools / CLI)--> engine --> core (timeline, ops, anchors, revisions on disk)
                                     \--> speech (whisper.cpp | faster-whisper | import)
                                     \--> story (templates + deterministic storytelling rules)
                                     \--> render --> motion (captions/graphics compiled to ASS)
                                                 \-> FFmpeg (one pass per cached segment)
```

- **No LLM inside the engine.** Planning uses deterministic rules: sentence scoring for the
  rough cut, pattern detection for lists, numbers, steps and calls to action, and a density
  limiter so effects never pile up.
- **No headless browser.** Motion graphics compile to an ASS document that libass renders
  inside the same FFmpeg pass that encodes the video.
- **Edit-stable anchors.** Graphics, zooms, sound effects and cutaways attach to the words
  they illustrate, so later cuts never desynchronize them.
- **Incremental rendering.** The timeline renders as content-hashed segments; an edit
  re-encodes only the segments it touches. Audio is mixed in one pass and muxed with stream
  copy; every output is verified with ffprobe.

More: [Architecture](docs/ARCHITECTURE.md) · [Protocol](docs/PROTOCOL.md) ·
[Research and license review](docs/RESEARCH.md) · [Benchmarks](docs/BENCHMARKS.md)

## Tests

```bash
npm install          # dev tools only
npm run typecheck    # tsc 7, strict
npm test             # 33 unit + MCP protocol tests (no FFmpeg needed)
npm run test:e2e     # 3 end-to-end suites rendering real video with FFmpeg (~2 min)
npm run bench        # token benchmark -> bench/results/latest.json
```

## Limitations

- Speech recognition accuracy and timing precision depend on the engine/model you install
  and were not measured in this repository.
- Graphics are limited to what libass can animate (transforms, movement, fades, clips, vector
  shapes, text). No arbitrary CSS, WebGL or 3D.
- The planner's editorial choices are heuristics. Review the preview; adjust with ops.
- Reframing 16:9 to 9:16 uses a fixed crop centre per clip (`frame cx=...`); automatic
  subject tracking is planned.
- Fonts come from your system. For the intended look install Montserrat, Poppins or Inter
  (all OFL). TMEP falls back to Arial Black / Segoe UI / DejaVu.

## License

MIT for all code in this repository (see [LICENSE](LICENSE)). Icons and sound effects are
original (icons are vector paths in `packages/motion/src/icons.ts`; SFX are synthesized by
FFmpeg at runtime). FFmpeg, whisper.cpp and faster-whisper are external tools under their
own licenses and are not bundled.
