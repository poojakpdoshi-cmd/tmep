# QUALITY_STANDARDS.md — FRAME Technical & Creative Gates

Every exported video must satisfy these measurable standards before being reported as complete.

## 1. Technical Standards

- **Container & Video**: MP4 (`+faststart`), H.264 (`yuv420p`) or ProRes/WebM (alpha export), exact target resolution (`1080x1920` for 9:16, `1920x1080` for 16:9, `1080x1080` for 1:1) and constant target FPS (`30` or `60`).
- **Colour**: BT.709 tagged output. BT.601, BT.2020, PQ and HLG sources are converted automatically (zscale; HDR tone-mapped at the BT.2408 203-nit reference white). Without zscale, HDR is converted but not tone-mapped — check `doctor` and say so.
- **Audio**: 48 kHz stereo AAC (`192k` default), no clipping (`<= -1.0 dBTP` target; current single-pass `loudnorm` targets `TP=-1.5` when `loudness < 0`), integrated loudness near target (e.g., `-14 LUFS` ±1.5 LU for social/web). No audible clicks at speech cuts (12ms/15ms `afade` preserved).
- **Duration & Sync**: Rendered duration matches `duration(tl)` within 1 frame. Speech captions use verified word timestamps (never fabricated; flag `approx: true` if imported from SRT/VTT).

## 2. Visual & Creative Standards

- **Safe Zones (9:16 Vertical)**: Keep essential captions, titles, and primary graphics clear of top `150px` and bottom `360px` (Reels/TikTok/Shorts UI overlays) and right `120px` action-icon rail.
- **No Overlaps**: Captions must never collide with stat graphics, lower-thirds, or presenter/facecam regions.
- **Legibility & Density**: Adequate contrast between text and background; avoid sparse sub-1% ink frames on explainer/storyboard cards unless intentionally minimalist; keep lines balanced (`<= 2` lines per caption page).
- **Motion Restraint**: Ease all intentional motion (`io`/`out`); avoid unmotivated punch-zooms, oscillating scale jitter, or abrupt double-exposed dissolves over headlines.

- **Typography**: headlines on 9:16 at ≥ 4% of frame height (≈ 80 px at 1080×1920) unless deliberately understated; supporting text ≥ 1.3% (≈ 25 px). Multi-line headings are balanced (no stranded last word).
- **Composition**: every graphic has a reason to be where it is: inside the safe zone, clear of captions and of the presenter's face, and consistent in spacing and timing with the rest of the edit (one style profile per edit).

## 3. Verification Checklist

1. Run `video_render` with `frames: true` (or `ffprobe` + frame extraction) on the actual output file.
2. Visually inspect start, middle, transition, and end frames from the encoded MP4.
3. Confirm audio stream presence, duration, and loudness/peak when audio is expected; explicitly label silent exports as visual-only.
