# FRAME — Phase 4 Validation Log

Every result below was produced by a command run on the stated host. Nothing is estimated.
Host for local runs: Linux x64 container, 4 vCPU, Node v22.23.5, FFmpeg 6.1.1 (libass, libx264, zscale).

## Stage 4.0 — Mandatory closure of Phases 1–3

### 4.0.1 Remote state and ancestry

| Check | Result |
|---|---|
| `origin/main` | `bf16ae3` (unchanged since the Phase 0 baseline) |
| Phase heads | Phase 0 `79258ae` → Phase 1 `16c7575` → Phase 2 `8a652b1` → Phase 3 `d1e6f9c` |
| Ancestry | `git merge-base --is-ancestor` true for main⊂P0⊂P1⊂P2⊂P3 (strictly linear) |
| PR #30 CI at `d1e6f9c` (run 46108189248) | **6/6 success** (ubuntu/windows/macos × Node 22/24) |
| Phase 4 branch | `feat/phase-4-motion-intelligence`, created from `d1e6f9c` |

### 4.0.2 Baseline at the Phase 3 head

| Suite | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | **176/176** (Phase 3 VALIDATION.md said 175; corrected) |

### 4.0.3 Independent re-verification of Phase 0 findings

Re-run with the **original Phase 0 repro scripts** (not Antigravity's `verify-findings.mjs`):

| Finding | Phase 0 result | Now |
|---|---|---|
| C1/D1 concurrent edits lose updates; duplicate ids | 3 processes `ok:1`, 1 edit survived, two `g2` | all edits survive, distinct ids — **remediated** |
| C2 `rev` path traversal reads any `.json` | secret read | `E_INPUT invalid revision` — **remediated** |
| C3 non-integer checkout bricks project | `head:1.5` | rejected — **remediated** |
| C4 read-only calls create projects | created | `created:false` — **remediated** |
| B1 reused-footage anchors bind to first copy | gfx→1, sfx→2 | gfx→5, sfx→6, zoom on `c2` — **remediated** |
| B2 frame-rounded tail drops anchors | dropped | resolved — **remediated** |
| S1 `video_render {out}` overwrites any file | `.txt` overwritten | extension + boundary rejected; victim intact — **remediated** |
| S2 `project` creates dirs anywhere | created | `E_SECURITY` — **remediated** |
| S3 `import`/`transcribe file` read anywhere | read | `E_SECURITY` — **remediated** |
| H3 job-id traversal | (hypothesis) | `E_SECURITY invalid job id` — **remediated** |

Still open (carried forward, not Stage 4.0 gates): B3 per-clip rounding drift, B4 transition
handles not idempotent, B5 phrase delete across reordered clips, B6 diff misses move/loudness,
B7 compact-string phrase swallows next anchor, B8 validation gaps (unbounded `set vol`, negative
anchors, NTSC fps), B12 clip vol/mute op, C5/C7 batch semantics, D2 orphaned lock waits 15 s.

### 4.0.4 Every advertised Phase 3 capability in complete public-API renders

`node bench/phase4/effect-matrix.ts` applies each op through `api.edit`, renders a full MP4,
decodes it and compares with the same timeline without the op (RGB frames at 160×90, 48 kHz PCM).
Evidence: [`evidence/effect-matrix.json`](evidence/effect-matrix.json).

| Run | Pass | Notes |
|---|---|---|
| First run at Phase 3 code | 48/88 | 30 harness issues (string transition syntax, luma-only metric, no-crop reframe); real failures below |
| After fixes | **88/88** | 25 fx/chain cases, 12 editing ops, 12 colour, 14 audio, 22 transitions + presets, reframe in 9:16 |

Defects confirmed by the matrix and fixed:

| # | Defect | Evidence | Fix |
|---|---|---|---|
| D-1 | **Audio-only edits reuse a stale mix.** The final-mix cache key (`render.ts`) omitted J/L offsets, ramps, reverse, per-clip audio post and master settings | 13/14 audio cases changed nothing on an already-rendered project; 11/13 changed once the audio cache was purged | key on `clipAudio().hash` + `tl.master`; regression test fails with the old key (diff 0.0000) |
| D-2 | **Animated concave/bezier masks frozen at t=0**; a reveal stayed fully hidden | thirds luma `52,0,0` at t=1 (expected middle), reveal `0,0,0` | per-item frame sequences (see MOTION_ENGINE.md §1) |
| D-3 | **Speed-ramp video not ramped** — `speedRampPtsExpr` overwrote its if-chain with the first segment | flashes at unramped times while audio ramped: 158 ms (1→2→1) and 583 ms (1→0.5) desync | always wrap; one shared `speedRampSegments()` map for duration, setpts and atempo |
| D-4 | **Ramp audio drifts ahead** — short `atempo` segments emit < in/speed | after D-3 fix: −161 ms | 80 ms input margin, exact output sample length per segment |
| D-5 | **"Directional" blur not directional** — `boxblur=r:1:0:1` (2-D, luma only); "vertical" branch blurred only chroma | code + filter semantics | `dblur=angle:radius` on all planes |
| D-6 | **jcut/lcut silent no-op** when no handle audio exists | `jcut c2 0.6s` reported, audio unchanged (c2 starts at source 0) | note states requested vs available handle |

Measured but not defects: `comp` on a −24 dBFS source is a no-op because thresholds are absolute
(gain staging limitation); `shadows=1` produces only a mild lift (diff 1.6).

### 4.0.5 A/V synchronization (J/L-cuts, speed, ramps)

`node bench/phase4/av-sync.ts` — 3-frame flash + 40 ms beep at the same source instants.
Evidence: [`evidence/av-sync.json`](evidence/av-sync.json). Tolerance 45 ms (1 frame @30 fps + detection).

| Case | Phase 3 code | After fixes |
|---|---|---|
| hard cut (control) | 12 ms | 12 ms |
| jcut c2 0.6 / lcut c1 0.6 | 12 ms | 12 ms |
| constant speed ×2 | — | 30.7 ms (one-frame quantization) |
| ramp 1→2→1 | **158 ms** | 18 ms |
| ramp 1→0.5 | **583 ms** | 42.7 ms |
| ramp + jcut | **158 ms** | 18 ms |

### 4.0.6 Colour-space conversion against reference media

`node bench/phase4/color-reference.ts` — bars of known SDR value encoded with zscale into each
colour space (HDR at the BT.2408 203-nit reference white), rendered with **no colour op**, decoded as
BT.709. Evidence: [`evidence/color-reference.json`](evidence/color-reference.json). Tolerance 8/255.

| Source | Phase 3 code | After fixes | If tags were ignored |
|---|---|---|---|
| BT.709 | 3 | 3 | 1 |
| BT.601 / SMPTE 170M | 4* | 3 | 40 |
| BT.2020 SDR | **86** | 4 | 85 |
| PQ (SMPTE 2084) | **108*** | 5 | 90 |
| HLG (ARIB STD-B67) | **92*** | 3 | 70 |

\*Phase 3 figures were measured with the first reference set (601 primaries not applied to the
source; HDR white at 100 nits). Root causes: `colorspace … fast=1` converts the matrix only (no
primaries); PQ/HLG had no linearization or tone mapping. Fix: zscale conversion (exact matrix,
primaries, transfer) with mobius tone mapping (knee 0.8), `colorspace fast=0` fallback when zscale is
absent; b-roll video is now converted too.

Also found while building reference media: **a source whose audio track is digital silence failed
the entire render** (`loudnorm` emits NaN on AAC-decoded silence; AAC encoder aborts). The loudnorm
line is unchanged since Phase 0, so this is pre-existing. Fixed by detecting a silent programme on
the PCM stems and skipping normalization.

### 4.0.7 Stage 4.0 test suites after fixes

See the table at the end of this file (updated after the final run).
