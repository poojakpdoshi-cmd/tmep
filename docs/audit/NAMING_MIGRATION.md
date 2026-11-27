# FRAME (formerly TMEP) — Naming Migration Inventory

> **Phase 0 Restriction**: No files were renamed, moved, or modified in production code during Phase 0. This document inventories all `tmep`/`TMEP` occurrences at commit `bf16ae30463b87f4e9c9c210b134064d89e7604a` and defines the safe Phase 1+ migration strategy.

## 1. Summary Metrics

Excluding `node_modules`, `.git`, and `dist`:
- **Total Occurrences**: **742**
- **Matching Lines**: **660**
- **Affected Files**: **110** (out of 166 tracked files)

### Breakdown by Case
| Variant | Count | Typical Symbols / Contexts |
|---|---|---|
| `tmep` (lowercase) | 278 | Package names, CLI binary (`bin/tmep.js`), `.tmep/` project dir, `.tmep` cache markers, JSON keys |
| `Tmep` (TitleCase) | 233 | `TmepError`, `asTmepError`, internal TypeScript symbols |
| `TMEP` (UPPERCASE) | 231 | Env vars (`TMEP_CHROME`, `TMEP_CMDLINE_LIMIT`, `TMEP_JOB_PERSIST`), `window.TMEP`, docs/titles |

### Breakdown by Directory
| Directory / Group | Occurrences | Lines | Files |
|---|---|---|---|
| `packages/*/src` | 299 | 270 | 32 |
| `docs/` | 111 | 87 | 8 |
| `tests/` | 105 | 99 | 17 |
| `examples/` | 80 | 70 | 19 |
| Root files (`package.json`, `README.md`, `CHANGELOG.md`, `TMEP_HANDOFF.md`, `LICENSE`, `.gitignore`, `.github/workflows/ci.yml`, etc.) | 66 | 54 | 12 |
| `packages/*/test` | 47 | 47 | 13 |
| `bench/` | 18 | 18 | 5 |
| `packages/*/package.json` | 11 | 11 | 9 |
| `bin/` (`tmep.js`, `tmep-mcp.js`) | 4 | 3 | 2 |
| `packages/*/py` (`fw_transcribe.py`) | 1 | 1 | 1 |

### Breakdown by File Extension
`.ts` (463), `.md` (165), `.json` (45), `.mjs` (34), `.sh` (9), `.html` (6), `.ps1` (4), `.toml` (4), `.txt` (4), `.js` (4), `.py` (1), `LICENSE` (1), `.yml` (1), `.gitignore` (1).

---

## 2. Classification for Migration

1. **Brand & User-Facing Surface (Rename to FRAME)**:
   - Docs, README, MCP server info (`SERVER_INFO`), CLI help text, `frame` / `frame-mcp` binary aliases, `frame.json` / `.frame/` (with backward-compatible read fallback).
2. **Protocol Identifier (Preserve as Internal Protocol)**:
   - **Token-Minimal Editing Protocol (`TMEP`)** remains the internal protocol name (`protocol: "tmep/1"`). Do not break wire compatibility unnecessarily.
3. **Compatibility Shims (Deprecate Gradually)**:
   - **Project directories**: Support reading existing `tmep.json` and `.tmep/` alongside `frame.json` and `.frame/`.
   - **Cache markers**: `.tmep` markers and `tmep-chrome-*` temp prefixes can transition cleanly.
   - **Environment variables**: Accept both `FRAME_*` and legacy `TMEP_*` (`TMEP_CHROME`, `TMEP_CMDLINE_LIMIT`, `TMEP_JOB_PERSIST`, etc.).
   - **Error classes**: Alias `TmepError` -> `FrameError` (keep `TmepError` export alias until major version).
   - **Browser global**: Support `window.FRAME` and `window.TMEP` in `chrome.ts`.
4. **Package & Repo Rename**:
   - Defer npm workspace package rename (`@frame/*` or `frame-*`) and GitHub repo rename until after Phase 1 core reliability/security fixes land, to avoid merge/CI churn.
