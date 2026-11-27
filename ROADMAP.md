# ROADMAP.md — FRAME Development Roadmap

See [docs/audit/ROADMAP.md](./docs/audit/ROADMAP.md) for the full Phase 0 evidence-backed specification.

## Phase 0 — Forensic Audit (Complete)
- Full 166-file repository audit, baseline verification, security/concurrency reproduction, and 10 audit deliverables on `audit/phase-0-forensic` (`79258ae`).

## Phase 1 — Professional Foundation (Current)
- **1.1** Canonical agent instructions (`AGENTS.md`, `CLAUDE.md`, `INSTRUCTIONS.md`, `QUALITY_STANDARDS.md`, `ROADMAP.md`, `ARCHITECTURE.md`) and 15 modular skills.
- **1.2** Security hardening (canonical path containment, read-only `inspect`, revision/job ID validation, arbitrary overwrite prevention).
- **1.3** Core correctness (locked RMW & optimistic concurrency, `clipId` anchor identity, frame-rounding tail fixes, integer revisions, `zooms: false` fix, multi-source allocation).
- **1.4** Cache & rendering integrity (post-`probe()` `.tmep` markers, media revalidation, Chrome CDP timeouts/cleanup, `package-lock.json`).
- **1.5** Agent integration (MCP parity for `doctor`, `transcribe-batch`, `script`, `storyboard`, `ratio`, `rev`/`parallel`/`encoder`; `notifications/cancelled`; compact help).
- **1.6** Staged FRAME identity migration (public FRAME branding, internal TMEP protocol, backward-compatible aliases).

## Phase 2 — Generalized Canvas Composition & Creative Quality (Planned)
- Generalize `VisualScene` + `VectorRun` into `CanvasRun` (`rrect`, `gradient`, measured `text`, `image`, `chart`).
- Pixel-measured caption wrapping, clause-aware pagination, non-jittering highlights, and global safe-zone/collision validation.
- Harden Chrome CDP rendering integration and diversify story templates.

## Phase 3 — Professional Audio, Colour, VFX & Asset Intelligence (Planned)
- Colour pipeline (colorspace conversion, exposure/contrast/temperature, `.cube` LUTs, shot matching).
- Audio mastering (dialogue EQ/de-ess/denoise, two-pass `loudnorm`, beat sync).
- Editing & VFX (J/L-cuts, speed ramps, stabilization, concave masks, blur/glow/blend modes).
- Visual asset intelligence & automated frame/audio QC gates.

## Phase 4 — Brand Completion & Multimodal Video Intelligence (Planned)
- Complete `tmep` → `frame` package/repo migration.
- Multimodal video understanding generating grounded editing briefs (`observed` vs `inferred`) and upgraded reference analysis.
