# Phase 1: feasibility and repository research

Research date: 2026-11-08. Versions and terms change; re-check before relying on them.

## What exists and what it costs an agent

| Project | Approach | License (verified) | Limitation for agent workflows |
|---|---|---|---|
| **Remotion** | React components rendered frame-by-frame in headless Chrome, encoded by FFmpeg | Custom *Remotion License* (source-available). Free for individuals, non-profits and for-profit orgs with up to 3 people; a paid Company License is required for 4+ people, with headcount aggregated across collaborating companies. ([LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md), [License FAQ](https://www.remotion.dev/docs/license/faq)) | The agent writes TSX animation code per video (thousands of output tokens), plus a bundler step and a headless browser per render. The license is unsuitable as a hard dependency of an MIT project used by companies. |
| **HyperFrames** (HeyGen) | HTML + CSS + GSAP compositions with `data-*` timing attributes, captured by a seekable headless-Chrome engine (Puppeteer) and encoded with FFmpeg; agents are taught via "skills" | Apache 2.0 ([repo](https://github.com/heygen-com/hyperframes)) | Agents still author full HTML/GSAP compositions; every change means regenerating or diffing markup in context. Chrome capture is CPU/RAM heavy. |
| **whisper.cpp** | C/C++ Whisper inference, GGML models, `whisper-cli` | MIT. Latest release at research time v1.9.5 ([releases](https://github.com/ggml-org/whisper.cpp/releases)) | Native binary + model file, no Python: lowest install friction, CPU-friendly, Windows binaries published. Word timing comes from token offsets in `-ojf` output. |
| **faster-whisper** | CTranslate2 re-implementation of Whisper | MIT. 1.2.1 (2025-10-31) ([PyPI](https://pypi.org/project/faster-whisper/)) | Best throughput on NVIDIA GPUs (needs CUDA 12 + cuDNN 9), built-in `word_timestamps=True` and Silero VAD; requires Python + pip. |
| **FFmpeg** | De/encoding, filtering, compositing; libass subtitle renderer | LGPL/GPL depending on build | FFmpeg 8.0 (Aug 2025) added a `whisper` filter, but only in builds compiled with `--enable-whisper` ([Phoronix](https://www.phoronix.com/news/FFmpeg-8.0-Released)), so it cannot be assumed. |

## Decisions that follow

1. **No Remotion runtime dependency.** Its license conflicts with an MIT core meant for companies of any size. A Remotion bridge is listed as *planned, optional* (see README status table); users who qualify for or buy a license can plug overlays in as alpha video assets today (`broll`/overlay of `.mov`/`.webm`).
2. **No headless browser in the render path.** Motion graphics compile to ASS (Advanced SubStation Alpha) and render through libass *inside the same FFmpeg pass* that encodes video. Measured in this repo: a 19 s 1080x1920 reel with captions, icons, stat count-up, title wipe and progress bar renders in about 19 s on a 2-vCPU VM at `veryfast`, with no extra render pass.
3. **Speech is adapter-based.** whisper.cpp is the default recommendation (single binary, Windows-friendly); faster-whisper is optional for GPU users; `import` accepts SRT/VTT/JSON from any tool. Nothing is mandatory or cloud-based.
4. **MCP implemented without the SDK.** The protocol over stdio is small. A dependency-free server lets users run it straight from a clone with `node`.

## MCP and client constraints (verified)

- **Spec versions.** `2025-11-25` is the last handshake-based revision. `2026-07-28` makes MCP stateless: no `initialize`, every request carries `_meta["io.modelcontextprotocol/protocolVersion"]` and client capabilities, servers MUST implement `server/discover`, results carry `resultType`, and list results carry `ttlMs`/`cacheScope` ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)). The spec defines "dual-era" servers that answer both; TMEP is one.
- **Tool names.** The spec allows `A-Za-z0-9_-.`, but Claude Desktop/Code and Antigravity reject anything outside `^[a-zA-Z0-9_-]{1,64}$`, and OpenAI function names disallow dots ([Drupal MCP issue quoting the Claude error](https://git.drupalcode.org/project/mcp_server/-/work_items/3585896), [ai-devkit PR on Antigravity](https://github.com/codeaholicguy/ai-devkit/pull/59)). Claude Code exposes tools as `mcp__<server>__<tool>`. Cursor limits *server name + tool name* to 60 characters ([Cursor forum](https://forum.cursor.com/t/google-gws-cli-tool-names-too-long/153918)). TMEP therefore uses `video_*` names (max 16 chars) and recommends the server key `tmep`.
- **Tool-definition cost.** Every tool's name, description and schema is re-sent on each agent turn, so TMEP exposes 8 tools with terse descriptions and serves detailed references on demand (`video_help`).
- **Timeouts.** Antigravity waits up to 3 minutes per tool call by default ([docs](https://antigravity.google/docs/mcp)); Codex has per-server `startup_timeout_sec`/`tool_timeout_sec`. Long work (transcription, rendering) therefore runs as background jobs: tools wait up to `wait` seconds (default 50) and otherwise return a job id for `video_status`.

## Client configuration locations (from each vendor's docs)

| Client | Config | Notes |
|---|---|---|
| Claude Code | `claude mcp add --transport stdio <name> -- <cmd> [args]`; project scope writes `.mcp.json` | scopes: local (default), project, user |
| Claude Desktop | `claude_desktop_config.json` (`mcpServers` object) | Windows: `%APPDATA%\Claude\`, macOS: `~/Library/Application Support/Claude/` |
| OpenAI Codex | `~/.codex/config.toml`, `[mcp_servers.<name>]` with `command`, `args`, `env`, `startup_timeout_sec`, `tool_timeout_sec` | TOML, snake_case |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` (`mcpServers`) | 60-char combined name limit |
| Antigravity | `~/.gemini/config/mcp_config.json` (global) or `<workspace>/.agents/mcp_config.json`; older IDE builds: `~/.gemini/antigravity/mcp_config.json` | `mcpServers` with `command`/`args`/`env` |

These were **not** exercised against the live clients from this environment (no client binaries available). The server is verified against the protocol with a conformance test that drives the real stdio process through both eras (`packages/mcp/test/mcp.test.ts`).

## Toolchain versions

- Node.js: 24 is Maintenance LTS, 26 entered Active LTS on 2026-10-28; 22 is supported until April 2027 ([endoflife.date](https://endoflife.date/nodejs)). TMEP needs **>= 22.18** because it runs TypeScript directly via Node's built-in type stripping.
- TypeScript 7.0 (Go-native compiler) shipped in July 2026 ([InfoWorld](https://www.infoworld.com/article/4196378/go-based-typescript-7-0-arrives.html)); the repo type-checks with `tsc` 7.0.2 and uses only erasable syntax (`erasableSyntaxOnly`).

## Measured facts about the FFmpeg/libass approach (this environment, FFmpeg 6.1.1)

- `perspective` with `eval=frame` gives sub-pixel smooth zooms (no `zoompan` integer jitter); 90 frames at 1080x1920 rendered + encoded in about 2.2 s.
- libass fills vector drawings with the non-zero winding rule: overlapping contours fill, reversed contours cut holes.
- libass aligns `\p` drawings against a box anchored at the drawing origin, so shapes are translated to a positive bounding box before use (`normalizeShape`).
- `subtitles=...:alpha=1` over a transparent `rgba` canvas produces correct alpha (verified ProRes 4444 output).
- Running FFmpeg with the job directory as `cwd` and passing `subtitles=filename=gfx.ass:fontsdir=fonts` avoids Windows drive-letter escaping in filtergraphs.
