# FRAME — Phase 3 Quality Report (Stage 3.6 & Stage 3.7)

All 5 demonstrations were created through FRAME public interfaces (`api.importMedia`, `api.edit`, `api.compile`, `api.colormatch`, `api.render`, `api.inspect({ what: 'qa' })`), rendered to MP4 with 6-frame contact sheets, and audited by FRAME Inspector.

## 1. Demonstration Metrics & Inspector Results

| Demo | Resolution & Dur | Expected vs Video vs Audio Dur | Integrated LUFS / True Peak | Defects | Advisories |
|---|---|---|---|---|---|
| `01-talking-head-reel` | `1080x1920`, 30.0s | `30.000s` / `30.000s` / `30.000s` | `-13.05 LUFS` / `-11.69 dBTP` | **0** | 1 (`colour-clipping` on `testsrc2` 0..255 bars) |
| `02-cinematic-montage` | `1920x1080`, 31.5s | `31.467s` / `31.467s` / `31.500s` | `-13.95 LUFS` / `-6.95 dBTP` | **0** | 1 (`colour-clipping` on `testsrc2` 0..255 bars) |
| `03-sports-highlights` | `1080x1920`, 28.5s | `28.500s` / `28.500s` / `28.500s` | `-14.01 LUFS` / `-10.07 dBTP` | **0** | 1 (`colour-clipping` on `testsrc2` 0..255 bars) |
| `04-product-demo` | `1920x1080`, 30.0s | `30.000s` / `30.000s` / `30.000s` | `-13.05 LUFS` / `-7.71 dBTP` | **0** | 1 (`colour-clipping` on `testsrc2` 0..255 bars) |
| `05-educational-explainer` | `1920x1080`, 60.0s | `60.000s` / `60.000s` / `60.000s` | `-13.06 LUFS` / `-11.58 dBTP` | **0** | **0** (`YMIN=5, YMAX=248`) |

## 2. Before vs After Comparison (Phase 2 vs Phase 3)
- **Duration & Scope**: Phase 2 validated 4-second synthetic clips; Phase 3 validates 28.5s–60.0s multi-clip, multi-layer timelines with transitions, audio beds, and chaptered workflows.
- **Editing & VFX**: Phase 3 adds `jcut`/`lcut`, `freeze`, `reverse`, `ramp`, `stabilize`, `punch`, `matchcut`, `splitscreen`, `pip`, `parallax`, `blur`, `glow`, `shadow`, `blend`, `chromakey`, `mblur`, `persp`, and Canvas-rasterized `concave`/`bezier` masks.
- **Colour & Audio**: Phase 3 adds BT.709 conversion/tagging, deterministic `colormatch`, dialogue EQ, compression, limiting, and two-pass `loudnorm` (bringing integrated loudness within ±1.0 LU of `-14 LUFS` with true peaks well below `-1.0 dBTP`).
- **Automated QA**: Phase 3 introduces `runInspector()` (`what: 'qa'`), catching A/V drift, frame count mismatches, audio clipping, black/silent segments, and safe-zone/collision defects automatically.

## 3. Honest Visual Shortcomings
1. **Representative source media**: Source clips use FFmpeg `testsrc2`/`mandelbrot` and Canvas UI mockups rather than live-action camera footage; therefore, real-world skin-tone grading, motion-blur aesthetics, and live speech intelligibility are not evaluated.
2. **Full-range test patterns**: `testsrc2` emits `0..255` luma bars, which triggers an `advisory` (`colour-clipping`) in demos 1–4; demo 5's subtle `glow` softens the extremes (`YMIN=5, YMAX=248`).
3. **Contact-sheet inspection**: `01-talking-head-reel-sheet.jpg` and `05-educational-explainer-sheet.jpg` were visually inspected via `read_file`, confirming clean safe-zone placement, PiP framing, and multi-chapter card/chart legibility without collisions.
