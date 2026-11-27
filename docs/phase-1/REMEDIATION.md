# FRAME — Phase 1 Remediation Checklist

Derived from `docs/audit/AUDIT.md` and supporting Phase 0 audit documents.

## Security Hardening (Stage 1.2)
- [ ] **S1**: Prevent arbitrary file overwrite via `render` `out` path (`mcp/server.ts`, `engine/api.ts`, `cli/main.ts`, `render/render.ts`).
- [ ] **S2**: Prevent arbitrary directory & project file creation (`mcp/server.ts:118`, `core/project.ts:76-88`).
- [ ] **S2b**: Ensure read-only `inspect` (`video_inspect`, `readOnlyHint: true`) does not create directories or files when project is missing.
- [ ] **S3**: Prevent unauthorized file reads / existence oracles in `importMedia`, `transcribe`, `script`, `storyboard` while preserving authorized external media imports via explicit allowed roots.
- [ ] **S4**: Validate `jobPath(id)` against path traversal (`core/project.ts:101-103`, `engine/api.ts:648`).
- [ ] **S5**: Canonical path containment handling symlinks, junctions, Windows UNC/device paths, and case-insensitivity.

## Core Correctness (Stage 1.3)
- [ ] **C1**: Fix unlocked read-modify-write races in `edit`, `plan`, `storyboard`, and `Project.open` (`engine/api.ts`, `core/project.ts`); fix `withLock` stale-lock unlink race and add optimistic concurrency (`expectedRev`) / transactional locking.
- [ ] **C2**: Fix reused-footage anchor resolution & `zoom` op using stable `clipId` in `TimeRef` (`core/timeline.ts`, `core/ops.ts`), preserving backward compatibility with legacy `{ src, t }` refs.
- [ ] **C3**: Fix frame-rounded clip tails, 1ms `anchorAt` rounding mismatch (`timeline.ts:377`), and `splitClip` 40ms sliver drops (`timeline.ts:386-402`).
- [ ] **C4**: Enforce `Number.isInteger` on `revision()` and `checkout()` (`core/project.ts:194-261`).
- [ ] **C5**: Fix `zooms: false` leaving `push` and `jumpZoom` active (`story/planner.ts:105-110`).
- [ ] **C6**: Fix multi-source duration allocation & non-transcribed clip selection (`story/planner.ts:72-95`).

## Cache & Rendering Integrity (Stage 1.4)
- [ ] **R1**: Write `${outPath}.tmep` cache marker **only after** `probe(outPath)` verification succeeds (`render/render.ts:437-450`).
- [ ] **R2**: Apply equivalent output validation to cached and fresh outputs (`render/render.ts:343-346`).
- [ ] **R3**: Revalidate disk media (`size`/`mtime`/hash) in `mediaMap()` (`render/render.ts:94-103`) and strengthen `mediaHash` (`core/util.ts:37-61`) without unnecessary repeated hashing.
- [ ] **R4**: Validate cached unit `.mp4`, `audioFile`, and vector PNG sequences instead of trusting `exists()` alone.
- [ ] **R5**: Harden `chrome.ts` (`send()` timeout, `ws.onclose`/`onerror`, `launch()` process/profile cleanup, `AbortSignal`).
- [ ] **R6**: Commit `package-lock.json` for reproducible dependency installation.

## Agent Integration (Stage 1.5)
- [ ] **A1**: Expose missing MCP capabilities (`doctor`, `transcribe-batch`, `script`, `storyboard`, `edit.ratio`, `render` `rev`/`parallel`/`encoder`) without bloating tool count/context.
- [ ] **A2**: Implement `notifications/cancelled` handling in `mcp/server.ts` with per-request `AbortController`.
- [ ] **A3**: Reduce oversized `help('storyboard')` (~7,096 tok) and `help('scene')` (~6,164 tok) with compact summaries and on-demand detailed schema.

## FRAME Identity Migration (Stage 1.6)
- [ ] **M1**: Public identity = FRAME (*Footage Reasoning and Agent-driven Media Editing*); retain TMEP as internal protocol.
- [ ] **M2**: Preserve existing `tmep` commands, `.tmep/` directories, `tmep.json`, and package compatibility while adding safe `frame` aliases.
- [ ] **M3**: Update `README.md` and canonical docs without blind global search-and-replace or renaming the GitHub repo.
