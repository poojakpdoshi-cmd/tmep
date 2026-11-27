# QUALITY_STANDARDS.md — FRAME Technical & Creative Gates

Every exported video must satisfy these measurable standards before being reported as complete.

## 1. Technical Standards

- **Container & Video**: MP4 (`+faststart`), H.264 (`yuv420p`) or ProRes/WebM (alpha export), exact target resolution (`1080x1920` for 9:16, `1920x1080` for 16:9, `1080x1080` for 1:1) and constant target FPS (`30` or `60`).
- **Colour**: BT.709 tagged (`-colorspace bt709 -color_primaries bt709 -color_trc bt709`). Note: Phase 1 does not yet perform input LUT/colorspace conversion on HDR/BT.601 sources; verify source color space during inspection.
- **Audio**: 48 kHz stereo AAC (`192k` default), no clipping (`<= -1.0 dBTP` target; current single-pass `loudnorm` targets `TP=-1.5` when `loudness < 0`), integrated loudness near target (e.g., `-14 LUFS` ±1.5 LU for social/web). No audible clicks at speech cuts (12ms/15ms `afade` preserved).
- **Duration & Sync**: Rendered duration matches `duration(tl)` within 1 frame. Speech captions use verified word timestamps (never fabricated; flag `approx: true` if imported from SRT/VTT).

## 2. Visual & Creative Standards

- **Safe Zones (9:16 Vertical)**: Keep essential captions, titles, and primary graphics clear of top `150px` and bottom `360px` (Reels/TikTok/Shorts UI overlays) and right `120px` action-icon rail.
- **No Overlaps**: Captions must never collide with stat graphics, lower-thirds, or presenter/facecam regions.
- **Legibility & Density**: Adequate contrast between text and background; avoid sparse sub-1% ink frames on explainer/storyboard cards unless intentionally minimalist; keep lines balanced (`<= 2` lines per caption page).
- **Motion Restraint**: Ease all intentional motion (`io`/`out`); avoid unmotivated punch-zooms, oscillating scale jitter, or abrupt double-exposed dissolves over headlines.

## 3. Verification Checklist

1. Run `video_render` with `frames: true` (or `ffprobe` + frame extraction) on the actual output file.
2. Visually inspect start, middle, transition, and end frames from the encoded MP4.
3. Confirm audio stream presence, duration, and loudness/peak when audio is expected; explicitly label silent exports as visual-only.
