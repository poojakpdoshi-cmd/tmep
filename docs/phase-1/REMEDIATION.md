# FRAME — Phase 1 Remediation Checklist

Derived from `docs/audit/AUDIT.md` and supporting Phase 0 audit documents.

## Security Hardening (Stage 1.2)
- [x] **S1**: Prevent arbitrary file overwrite via `render` `out` path (`mcp/server.ts`, `engine/api.ts`, `cli/main.ts`).
- [x] **S2**: Prevent arbitrary directory & project file creation (`mcp/server.ts`, `engine/api.ts`).
- [x] **S2b**: Ensure read-only `inspect` (`video_inspect`, `readOnlyHint: true`) does not create directories or files when project is missing.
- [x] **S3**: Prevent unauthorized file reads / existence oracles in `importMedia` and `transcribe` while preserving authorized external media imports via `mediaRoots` / `FRAME_MEDIA_ROOTS` / `TMEP_MEDIA_ROOTS`.
- [x] **S4**: Validate `jobPath(id)` and `status(job)` against path traversal (`core/project.ts`, `core/security.ts`, `engine/api.ts`).
- [x] **S5**: Canonical path containment handling symlinks, junctions, Windows UNC/device paths, and case-insensitivity (`core/security.ts`).

## Core Correctness (Stage 1.3)
- [x] **C1**: Fix unlocked read-modify-write races in `edit`, `plan`, and `storyboard` (`engine/api.ts`); add reentrant `withLock` + token-verified stale lock cleanup (`core/project.ts`) and `expectedRev` optimistic concurrency (`E_CONFLICT`).
- [x] **C2**: Fix reused-footage anchor resolution & `zoom` op using `TimeRef.clip` (`core/timeline.ts`, `core/ops.ts`), preserving backward compatibility with legacy `{ src, t }` refs.
- [x] **C3**: Fix frame-rounded clip tails, `anchorAt` precision/clamping, and `splitClip` right-anchor preservation (`core/timeline.ts`).
- [x] **C4**: Enforce `Number.isInteger` on `revision()` and `checkout()` (`core/project.ts`).
- [x] **C5**: Fix `zooms: false` leaving `push` and `jumpZoom` active (`story/planner.ts`).
- [x] **C6**: Fix multi-source duration allocation & representative mid-clip sampling for non-transcribed clips (`story/planner.ts`).

## Cache & Rendering Integrity (Stage 1.4)
- [x] **R1**: Write `${outPath}.tmep` cache marker **only after** `probe(outPath)` verification succeeds (`render/render.ts`).
- [x] **R2**: Apply equivalent output validation to cached and fresh outputs (`render/render.ts`).
- [x] **R3**: Revalidate disk media (`size`/`mtime` → `mediaHash`) in `mediaMap()` (`render/render.ts`).
- [x] **R4**: Validate cached unit `.mp4` (`validVideo`) and `audioFile` (`validAudio`) instead of trusting `exists()` alone (`render/render.ts`).
- [x] **R5**: Harden `chrome.ts` (`send()` timeout, `ws.onclose`/`onerror`, `launch()` process/profile cleanup, `AbortSignal`, bounded `events`).
- [x] **R6**: Commit `package-lock.json` for reproducible dependency installation.

## Agent Integration (Stage 1.5)
- [x] **A1**: Expose missing MCP capabilities (`video_doctor`, `video_transcribe` `assets[]` batch, `video_plan` `script`/`storyboard`, `video_edit` `ratio`/`expectedRev`, `video_render` `rev`/`parallel`/`encoder`) within `<= 10` tools.
- [x] **A2**: Implement `notifications/cancelled` handling in `mcp/server.ts` with per-request `AbortController` + job cancellation.
- [x] **A3**: Reduce oversized `help('storyboard')` (~7,096 tok) and `help('scene')` (~6,164 tok) with compact summaries (<400 tok) and `schema: true` on-demand option.

## FRAME Identity Migration (Stage 1.6)
- [x] **M1**: Public identity = FRAME (*Footage Reasoning and Agent-driven Media Editing*); retain TMEP as internal protocol.
- [x] **M2**: Preserve existing `tmep` commands, `.tmep/` directories, `tmep.json`, and package compatibility while adding `bin/frame.js` and `bin/frame-mcp.js`.
- [x] **M3**: Update `README.md` and canonical docs without blind global search-and-replace or renaming the GitHub repo.
