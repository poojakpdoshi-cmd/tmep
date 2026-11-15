# Visual Scene V1

A scene is a structured overlay on an existing TMEP timeline. The planning agent supplies the composition, source assets and timing. TMEP checks the plan, then uses its existing FFmpeg graph and ASS/libass compositor for rendering and caching.

## Apply a structured plan

1. Use `tmep help scene` or `video_help {"topic":"scene"}` to obtain the current schema.
2. The adapter accepts `{ "op": "scene", "spec": … }` from any agent. For a TMEP Editorial Director plan, use the approved range or narration cue to fill `at`, `offset` and `duration`, then supply explicit layer geometry and keyframes. The existing editorial `action` prose needs this authoring step. Import any stills or video first and use the returned asset IDs.
3. Pass the following shape inside the `video_edit` ops array or with `tmep edit --json`. Inspect the revision and use a short range preview. Use the returned scene ID with `remove` to replace it or use revision history to undo.

```json
{
  "op": "scene",
  "spec": {
    "v": 1,
    "at": "@system map",
    "duration": 2,
    "ratio": "9:16",
    "safe": { "left": 0.05, "right": 0.10, "top": 0.08, "bottom": 0.15 },
    "styles": [{ "id": "accent", "color": "#92E7CE", "size": 48, "font": "bold" }],
    "groups": [{ "id": "labels", "stagger": 0.14 }],
    "camera": [{ "t": 0, "s": 1 }, { "t": 1.5, "s": 1.04, "e": "io" }],
    "layers": [
      { "id": "front", "kind": "text", "text": "Frontend", "style": "accent", "group": "labels", "x": 0.3, "y": 0.25, "w": 0.4, "h": 0.07 },
      { "id": "route", "kind": "rect", "style": "accent", "group": "labels", "x": 0.42, "y": 0.35, "w": 0.2, "h": 0.012,
        "keys": [{ "t": 0, "o": 0 }, { "t": 0.35, "o": 1, "e": "out" }] }
    ]
  }
}
```

## Timing and geometry

- `at` is timeline seconds or a TMEP anchor such as `@phrase#2`, `@phrase^end` or `w:42`. `offset` is a signed correction in seconds. Narration cues resolve against the current edited transcript, so a cut that removes an anchor requires updating or removing the scene. Check approximate transcript times by ear.
- Layer `start` and optional `end` are scene-local seconds. Layer keys use active-layer time after stagger. Camera keys use scene time. Keys use `x`, `y` offsets, uniform scale `s`, rotation `r` in degrees, and layer opacity `o`. A key's easing controls arrival. Values hold outside each property's key range. A group's translation and opacity inherit through its parent chain. Stagger offsets direct layers in their listed order.
- Layer center and size are fractions of frame width and height. Camera offsets also use frame fractions. Camera rotation and zoom pivot around the frame center. Draw order follows the layer list within the scene. Scene `z` orders the scene relative to other overlays. Existing captions and shared ASS presets retain their top-layer behavior.
- Text uses reusable color, font role and font size in reference pixels. Shapes include rectangles, ellipses and polygons with points expressed as fractions of their box. Image and video layers require imported assets and fit inside their box. Video `in` selects source seconds. Overlay audio is excluded.

## Path layers

A `path` layer draws SVG path data with a stroke reveal. It uses the same box, timing, groups, stagger, keys and camera as the other layers. A deterministic frame rasterizer paints it with the existing in-process Skia canvas (`@napi-rs/canvas`). No browser is used.

```json
{ "id": "wire", "kind": "path", "style": "accent", "x": 0.5, "y": 0.5, "w": 0.4, "h": 0.13,
  "view": { "w": 432, "h": 250 }, "d": "M27 6 C27 140 405 110 405 244", "stroke": 6, "glow": 0,
  "draw": [{ "t": 0, "to": 0 }, { "t": 0.6, "to": 1, "e": "out" }] }
```

- `d` is SVG path data in `view` units. It starts with a moveto and accepts all SVG commands, including minified arc flags. `view` defaults to 100 × 100. Like `preserveAspectRatio="xMidYMid meet"`, the view is scaled uniformly and centred in the layer box. A path whose bounds leave its view is reported as `clipping`.
- The stroke color is the style color. `stroke` is the width in reference pixels (0 = none). `cap` is `round` (default), `butt` or `square`. Joins are round. `fill` is an optional fill color painted under the stroke, unaffected by `draw`. `glow` is a stroke-colored blur radius in reference pixels. Stroke width scales with layer and camera scale, but glow radius does not.
- `draw` keys trim the stroke to the interval `from`–`to` of total path length, across subpaths in order. Defaults: `from` 0, `to` 1 (fully drawn). Keys use active-layer time, the shared easings and hold rules. Animate `to` for a draw-on, `from` for a draw-off, or both for a segment that travels along the path.
- To fade a fill in after a draw-on, add a second path layer with `stroke: 0` and opacity keys.

Consecutive path layers in a scene become one transparent PNG frame sequence and one FFmpeg overlay. Layer and camera transforms and opacity are painted into the frames. They use the same sampled keys and composition as the validator and the FFmpeg transform of other layers. Opacity applies to the whole layer, as it does for other layers. A translucent layer is painted opaque and composited once, so a fill does not show through its stroke and the glow fades with the layer. A frame is a pure function of the scene spec, the frame index and the output size. The sequence is cached in `.tmep/cache/vectors/` by content. IDs, timeline position and compositing order are excluded from the key, so moving or re-adding a scene reuses its frames. A preview rasterizes at preview size. Rasterization happens only when an uncached video unit needs the run, and it rasterizes the whole run. Each video unit selects its frames by index and places them with integer frame offsets. Animation stays frame-exact across unit boundaries at any start frame.

Example: [`examples/path-reveal/scene.json`](../examples/path-reveal/scene.json) is an original 4-second synthetic request/response animation. Render it with `node bench/visual-scene-v2.ts setup|cold|verify <new-dir> [preview|full]`.

Limits: Skia antialiasing can differ slightly between platforms or `@napi-rs/canvas` versions, and cached frames are reused only on the same key (`VECTOR_VERSION`). Glow, fill and stroke extend past the path's geometric bounds and are not covered by the view-box check. Path layers are excluded from rectangle collision checks, like ellipses and polygons. There are no gradients, dashes, masks, morphing or text-on-path. A browser rasterizer (for GSAP or Three.js) is not part of this change. The Windows benchmark can compare Skia with headless Chrome. V2 performance remains unverified. V1 ASS shapes and path layers can render the same style color slightly differently.

## Validation and limits

Input rejects unknown fields and effects, broken references, invalid timing, discontinuous hold keys and out-of-range assets. At each output frame, the checker tests transformed box bounds against the frame and explicit safe insets. It checks intersecting boxes for rectangle and text layers within a scene. Caption checks use a conservative full-width band while a caption page is active and check its vertical bounds against the requested safe area. Set `overlap: true` on an intentional background or overlap layer, and `bleed: true` on layers allowed to cross the frame or safe area.

Text fitting uses glyph metrics from the existing Canvas dependency. Libass shaping, fallback fonts, and apparent readability still need a preview. Collision checks do not trace arbitrary contours, transparent image pixels, or intersections across separate scenes or existing overlays. Validation detects discrete key jumps and frame-level geometry violations. It cannot judge editorial pacing or the quality of easing. Use opacity keyframes for deliberate soft entrances and exits.

V1 uses a 2D scene camera. Isometric views can be authored with polygons. It has no 3D lighting, mesh projection, or automatic layout. There are at most 16 scenes per timeline, 16 layers per scene, 16 scene layers per rendered video unit, 12 keys per track and 60 seconds per scene. Additional animated layers increase FFmpeg compositing cost. V1 uses normal composited export.

## Preview and diagnostics

`tmep render --scene scene3 --range 0.4,1.8` previews a scene-relative interval at half resolution. Omit the range to preview the whole scene. The corresponding MCP call is `video_render {"scene":"scene3","range":[0.4,1.8]}`. Both use normal project composition, with the existing unit cache. The returned `span` gives the actual timeline interval at standard or debug detail. It can be wider than the requested interval because cached video units are indivisible.

`tmep inspect scenes --scene scene3` reports findings for a saved scene. Omit the ID for all saved scenes, or use `tmep inspect scenes --spec '<scene JSON>'` to validate a draft against the current timeline before editing. MCP uses `video_inspect` with `what:"scenes"` and either `scene` or `spec`. Diagnostics are read-only.

```json
{"ok":false,"issues":[{"code":"collision","severity":"error","scene":"draft","layers":["panel","label"],"t":1.2,"msg":"label and panel: collision at 1.200s"}],"truncated":false}
```

Each finding gives its first timeline timestamp in seconds. `null` means the timing could not be established. An empty layer list identifies a scene-level issue. Reports keep up to 64 distinct findings. A malformed contract stops evaluation of that scene. Geometry checks use the same rules as edit and render validation.

Run the synthetic Windows benchmark from the checkout with `pwsh -File bench/visual-scenes-windows.ps1 -Scratch <new-directory>`. It runs three cold/cached pairs for each combination of 8 or 16 layers and static, translation, opacity, or combined animation. It measures a 540×960, 30 fps preview of a two-second scene spanning two video units. It verifies the four-second unit-aligned output, checks pixels on both sides of the boundary, and compares decoded frame hashes after a cached export. Process-tree working set and CPU are sampled estimates.
