# FRAME (formerly TMEP) — Phase 0 Master Forensic Audit (`AUDIT.md`)

- **Project**: FRAME (*Footage Reasoning and Agent-driven Media Editing*, formerly TMEP)
- **Repository**: `https://github.com/poojakpdoshi-cmd/tmep`
- **Verified Commit**: `bf16ae30463b87f4e9c9c210b134064d89e7604a` (`main`)
- **Audit Branch**: `audit/phase-0-forensic`
- **Production Code Modified**: **None** (Phase 0 audit-only deliverables)

---

## 1. Evidence Recovery Summary

- **Remote `claude/peaceful-feynman-n8jr63`**: Not present on `origin` (`git ls-remote` verified).
- **Claude cloud scratchpad**: Inaccessible locally.
- **Recovery Outcome**: Zero Claude audit documents existed in the repository. All findings were independently audited across all 166 tracked files, verified with `npm run typecheck`, `npm test` (150/150), `npm run test:e2e` (70/70 non-skipped, 3 Windows skips), `npm run bench`, `node bin/tmep.js doctor`, `examples/readiness/smoke.mjs`, and `docs/audit/repro/verify-findings.mjs`.

---

## 2. Severity-Ranked Defect Register (Verified)

### Critical / High
1. **Unlocked Read-Modify-Write Lost Updates (`packages/engine/src/api.ts:345-461`)**: `edit`, `plan`, and `storyboard` read timeline/assets outside `Project.withLock()`. Reproduced: 3 concurrent `api.edit()` calls resulted in only 1 surviving edit (`Edit C`).
2. **Arbitrary File Overwrite via Render `out` (`packages/mcp/src/server.ts:155`, `packages/engine/src/api.ts:628`, `packages/render/src/render.ts:430-439`)**: No project-root containment or extension check; overwrites arbitrary writable files and creates parent directories.
3. **Reused-Footage Anchor & Zoom Misbinding (`packages/core/src/timeline.ts:71-75, 263-269, 375-378`, `packages/core/src/ops.ts:422-431`)**: `TimeRef` lacks `clipId`, so `resolveRef` / `srcToTl` and `zoom` snap to the first clip using the asset. Reproduced: `@6s` in `c2` resolved to `2s` in `c1` and attached `zoom` to `c1`.
4. **Premature `.tmep` Cache Marker Bypasses Verification (`packages/render/src/render.ts:343-346, 437-450`)**: Writes `${outPath}.tmep` before `probe(outPath)` runs; failed verification leaves a broken file that subsequent renders accept as `cacheHit: true`.
5. **Job ID Path Traversal (`packages/core/src/project.ts:101-103`, `packages/engine/src/api.ts:648`)**: `jobPath('../tmep')` resolves outside `.tmep/jobs/` (reproduced).

### Medium
6. **Frame-Rounding Clip Tail & 1ms Rounding Discard (`packages/core/src/timeline.ts:230-280, 377, 386-402`)**: Quantized `p.dur` vs unrounded `[c.in, c.out)` and `anchorAt` 1ms rounding (`0.0005s` > `1e-6` tolerance) silently discard anchored items. Reproduced: `clipOut: 1.017`, `quantizedDur: 1.0333`, `refAtTail: 1.032` → `resolvedBack: null`.
7. **Non-Integer Revision Validation Gap (`packages/core/src/project.ts:194-204, 252-261`)**: `revision(1.5)` / `NaN` / non-numeric strings bypass `r < 0 || r > m.revs` (reproduced: `ENOENT` on `r01.5.json`; `checkout` corrupts `m.head`).
8. **Arbitrary Directory Creation & Read-Only `video_inspect` Mutation (`packages/mcp/src/server.ts:118`, `packages/core/src/project.ts:76-88`, `packages/mcp/src/tools.ts:55`)**: Reproduced: `api.inspect` on a non-existent directory created `.tmep/`, `renders/`, and `tmep.json`.
9. **File Existence / Content Read Oracle (`packages/engine/src/api.ts:74-89, 193-202`)**: `importMedia` and `transcribe` resolve arbitrary paths outside project root.
10. **MCP Cancellation Notifications Ignored (`packages/mcp/src/server.ts:60-61`)**: Drops all notifications including `notifications/cancelled`.
11. **Stale Media Hash Reuse & Unvalidated Cache Hits (`packages/render/src/render.ts:94-103, 313-315, 338, 385`, `packages/core/src/util.ts:37-61`)**: `mediaMap` trusts manifest hash without checking disk; `>32MiB` files only hash 3×4MiB windows.
12. **Stale Lock Unlink Race & Unlocked `Project.open` (`packages/core/src/project.ts:76-90, 113-139`)**: `withLock` can unlink a newly acquired lock; `Project.open` is unlocked.
13. **Planner Bugs (`packages/story/src/planner.ts:72-110`)**: Non-transcribed footage always sliced from `0s`; multi-source duration allocation skewed; `zooms: false` leaves `push` and `jumpZoom` active.
14. **Caption & Graphic Creative Defects (`packages/motion/src/captions.ts`, `presets.ts`, `explainer-canvas.mjs`, `launch-reel.mjs`)**: Char-based wrapping, fixed `y` ratios, 114% kinetic word-reflow jitter, center-band stat/caption collisions, and bottom social safe-zone violations (`y=1454..1824`).
15. **Chrome CDP Driver Reliability (`packages/media/src/chrome.ts:49-101`)**: Unexposed in engine/MCP; `send()` has no timeout/close handler; `launch()` can leak browser processes on error.
16. **Token Bloat in Help Topics**: `help('storyboard')` = **7,096 est. tokens**; `help('scene')` = **6,164 est. tokens** (vs **2,206** for all 9 MCP tools).

### Low / Governance
17. **MCP vs CLI Parity Gaps**: `doctor`, `transcribe-batch`, `script`, `storyboard`, `edit.ratio`, and `render` (`rev`, `parallel`, `encoder`) missing from MCP.
18. **No `package-lock.json`**: Dependency installation is not reproducibly locked.
19. **742 `tmep`/`TMEP` Naming Occurrences** across 110 files; no canonical `AGENTS.md`/`CLAUDE.md`/skills system yet.

---

## 3. Complete Deliverable Index

1. [AUDIT.md](file:///C:/Users/Poojak%20Doshi/tmep/docs/audit/AUDIT.md) — Master forensic audit summary & defect register
2. [FILE_COVERAGE.md](file:///C:/Users/Poojak%20Doshi/tmep/docs/audit/FILE_COVERAGE.md) — 166/166 tracked file coverage manifest
3. [CAPABILITY_MATRIX.md](file:///C:/Users/Poojak%20Doshi/tmep/docs/audit/CAPABILITY_MATRIX.md) — Capability & quality matrix
4. [ARCHITECTURE_REVIEW.md](file:///C:/Users/Poojak%20Doshi/tmep/docs/audit/ARCHITECTURE_REVIEW.md) — Architecture & Canvas generalization plan
5. [PROFESSIONAL_EDITING_GAPS.md](file:///C:/Users/Poojak%20Doshi/tmep/docs/audit/PROFESSIONAL_EDITING_GAPS.md) — Creative quality & pro editing gap analysis
6. [EFFECTS_AND_RENDERING_AUDIT.md](file:///C:/Users/Poojak%20Doshi/tmep/docs/audit/EFFECTS_AND_RENDERING_AUDIT.md) — Effects, compositing, audio, colour & backend audit
7. [AGENT_INTEGRATION_AUDIT.md](file:///C:/Users/Poojak%20Doshi/tmep/docs/audit/AGENT_INTEGRATION_AUDIT.md) — MCP/CLI parity, security, cancellation & token audit
8. [BASELINE_REPORT.md](file:///C:/Users/Poojak%20Doshi/tmep/docs/audit/BASELINE_REPORT.md) — Measured tests, doctor, benchmark & recovery status
9. [NAMING_MIGRATION.md](file:///C:/Users/Poojak%20Doshi/tmep/docs/audit/NAMING_MIGRATION.md) — TMEP → FRAME naming inventory (742 occurrences)
10. [ROADMAP.md](file:///C:/Users/Poojak%20Doshi/tmep/docs/audit/ROADMAP.md) — Phased development roadmap & acceptance gates
11. [verify-findings.mjs](file:///C:/Users/Poojak%20Doshi/tmep/docs/audit/repro/verify-findings.mjs) — Non-destructive reproduction script
