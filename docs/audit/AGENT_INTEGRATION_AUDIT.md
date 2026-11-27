# FRAME — Agent Integration & Security Audit

## 1. MCP vs CLI Parity Matrix

- **MCP Server (`packages/mcp/src/tools.ts`, `server.ts`)**: Exposes **9 tools**:
  `video_import`, `video_reference`, `video_transcribe`, `video_plan`, `video_edit`, `video_inspect`, `video_render`, `video_status`, `video_help`.
- **CLI (`packages/cli/src/main.ts`)**: Exposes **20 commands** (+3 aliases `help`/`--help`/`-h`, `--version`):
  `help`, `version`, `init`, `import`, `reference`, `transcribe-batch`, `transcribe`, `plan`, `script`, `storyboard`, `edit`, `undo`, `redo`, `checkout`, `inspect`, `render`, `status`, `jobs`, `doctor`, `mcp`.

### Key Parity Gaps
| Capability | Engine (`api.ts`) | CLI (`main.ts`) | MCP (`tools.ts`) | Impact |
|---|---|---|---|---|
| `doctor` | `api.doctor()` | `doctor` | **Missing** | Agents cannot diagnose missing FFmpeg/Whisper despite error messages suggesting `doctor`. |
| `transcribeBatch` | `api.transcribeBatch()` | `transcribe-batch` | **Missing** | Agents must loop `video_transcribe` one file at a time (loses `faster-whisper` single-load batching). |
| `planScript` | `api.planScript()` | `script` | **Missing** | Text-to-storyboard workflow inaccessible via MCP. |
| `storyboard` | `api.storyboard()` | `storyboard` | **Missing** | Structured storyboard compilation inaccessible via MCP. |
| `edit.ratio` | `api.edit({ ratio })` | `edit` | **Missing** in `video_edit` schema | Agents cannot change aspect ratio in `video_edit`. |
| `render` options (`rev`, `parallel`, `encoder`) | `api.render()` | **Missing** | **Missing** | Neither CLI nor MCP exposes `rev`, `parallel`, or `encoder` (e.g. NVENC). |
| `help('storyboard')` | `api.help('storyboard')` | Listed in help | **Omitted** from `video_help` enum description | Undiscoverable via MCP tool schema. |

---

## 2. Security Vulnerabilities (Verified)

### S1. Arbitrary File Overwrite via Render Output Path (High)
- **Locations**: `packages/mcp/src/server.ts:155`, `packages/engine/src/api.ts:628`, `packages/cli/src/main.ts:197`, `packages/render/src/render.ts:229, 341-342, 430, 437-439`.
- **Mechanism**: `inp.out` is resolved with `path.resolve(ctx.project, inp.out)` with no project-root containment check and no extension restriction in `video_render` or CLI `render`. `render.ts` runs `mkdir(..., { recursive: true })`, renames `tmpOut` over `outPath`, writes `<outPath>.tmep`, and `api.ts:634-635` writes `<out>-sheet.jpg` if `frames` is set.
- **Impact**: An untrusted/prompt-injected MCP client can overwrite arbitrary files writable by the user process.

### S2. Arbitrary Directory & Project File Creation (Medium)
- **Locations**: `packages/mcp/src/server.ts:118`, `packages/core/src/project.ts:76-88`, `packages/mcp/src/tools.ts:55`.
- **Mechanism**: `ctx.project = path.resolve(this.cwd, args.project ?? '.')` has no containment check against `this.cwd`. Almost every `api.*` method calls `openProject(ctx.project)` with `create = true`, creating `revs/`, `renders/`, `tmep.json`, `.tmep/assets.json`, and `.tmep/.gitignore`.
- **Impact**: Even `video_inspect` (declared `readOnlyHint: true` at `tools.ts:55`) mutates the filesystem when pointed at a non-existent directory.

### S3. File Existence & Content Read Oracle (Medium)
- **Locations**: `packages/engine/src/api.ts:74-76, 89` (`importMedia`), `api.ts:193, 202` (`transcribe`), `packages/media/src/ffmpeg.ts:78`, `packages/cli/src/main.ts:147`.
- **Mechanism**: `importMedia` and `transcribe` resolve arbitrary paths outside the project root. `importMedia` distinguishes `E_NOT_FOUND` vs `E_MEDIA` (probing arbitrary files with `ffprobe` and returning stderr tail in `debug` mode). `transcribe` reads arbitrary `.srt`/`.vtt`/`.json` files and persists parsed text into `<project>/transcripts/<id>.txt`, readable via `video_inspect({ what: 'transcript' })`.

### S4. Job ID Path Traversal (Medium)
- **Locations**: `packages/core/src/project.ts:101-103` (`Project.jobPath`), `packages/engine/src/api.ts:648` (`status`).
- **Mechanism**: `path.join(this.dir, 'jobs', `${id}.json`)` interpolates `id` directly without validating against `..` or path separators.

---

## 3. MCP Protocol & Token Efficiency Findings

### Ignored Cancellation Notifications
- **Location**: `packages/mcp/src/server.ts:60-61`
- **Finding**: `if (isNotification) return undefined;` silently drops `notifications/cancelled`. In-flight `video_render` or `video_transcribe` calls have no `AbortController` map keyed by JSON-RPC `req.id`. Agents must poll or issue `video_status({ job, cancel: true })`.

### Token Consumption Measurements (`bench/tokens.ts:estimateTokens`)
- `toolList()` (all 9 MCP tool definitions): **4,881 bytes / 2,206 est. tokens**.
- `api.help('storyboard')`: **12,396 bytes / 7,096 est. tokens** (embeds full `storyboardSchema.json`, >3× the entire MCP tool list).
- `api.help('scene')`: **10,700 bytes / 6,164 est. tokens** (embeds full `visualSceneSchema.json`).
- All 8 other help topics combined (`workflow`, `ops`, `anchors`, `presets`, `templates`, `sfx`, `icons`, `captions`): **4,201 bytes / 1,787 est. tokens**.
- **Recommendation**: Replace raw JSON Schema dumps in `help('storyboard')` and `help('scene')` with compact DSL/example summaries and an optional `schema` flag/topic, and keep `toolList()` static overhead minimal.

---

## 4. Planned Canonical Agent Instruction Architecture (Phase 1+)

Currently, the repository has **no** `AGENTS.md`, `CLAUDE.md`, `INSTRUCTIONS.md`, or modular editing skills. Phase 1 must introduce a non-duplicative canonical hierarchy:
1. **Root Canonical Docs**: `AGENTS.md` (agent contract & workflow), `CLAUDE.md` (thin pointer to `AGENTS.md`), `INSTRUCTIONS.md` (tool/protocol usage), `QUALITY_STANDARDS.md` (creative/technical acceptance gates), `ARCHITECTURE.md`, `ROADMAP.md`.
2. **Modular On-Demand Skills** (loaded only when task-relevant, explaining *when, why, and how* rather than listing CLI flags):
   - Creative direction, Professional editing, Visual storytelling, Motion graphics, Typography & captions, Informative videos, Sports editing, Cinematic editing, Audio post-production, Colour grading, Compositing, Visual asset selection, Reference analysis, Quality control, Token optimization.
