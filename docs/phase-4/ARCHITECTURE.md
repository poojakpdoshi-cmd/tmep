# FRAME — Phase 4 Architecture

Phase 4 extends existing packages; no new package, renderer or runtime dependency.

## Responsibilities → code

| Responsibility | Phase 4 additions | Where |
|---|---|---|
| **Intelligence** — local footage understanding | `frame.footage/1` analysis: shots, scenes, motion, quality, audio activity, silences, quiet regions, moments; optional faces (OpenCV) and visible text (tesseract) | `media/src/footage.ts` |
| **Director** — creative decision support | task briefs (`informative`, `sports`, `cinematic`, `product`, `generic`) with evidence and observed/inferred separation; style profiles fix rhythm and restraint | `story/src/brief.ts`, `story/src/presets.ts` |
| **Compiler** — intent → edit | motion presets with constraint placement and adaptive type; `footage:` intents avoid the analysed presenter | `story/src/presets.ts`, `engine/src/api.ts#compile` |
| **Engine** — execution | animated mask sequences, shared speed-ramp time map, zscale colour, Canvas motion engine (kinetic text, morph, motion paths, reveals, depth, motion blur) | `render/src/{render,effects,graph,audio,color}.ts`, `motion/src/{vector,paths,scene}.ts` |
| **Inspector** — quality | footage-aware advisories (graphics/captions over presenter, crop cutting presenter, repetitive zoom, missing moments); validator measures bold text correctly | `render/src/footage-qa.ts`, `motion/src/scene.ts` |
| **Optimizer** — workload & resources | content-addressed footage cache with layered adapters; final-mix cache key fixed; renderer/vector/workflow cache versions bumped where outputs changed | `engine/src/api.ts`, `render/src/render.ts` |

## Data flow (Phase 4B)

```
video asset ──► analyzeFootage (1 low-res video decode + 1 audio decode, streamed)
                   ├─ observed: shots, motion, audio, silences, quality, grid activity
                   ├─ inferred: scenes, moments, quiet regions, pacing
                   └─ adapters on shot keyframes (if installed): faces → presenter, OCR → text
              ──► .tmep/cache/footage/<hash(version, media, settings, transcript)>.json
                   └─ <hash(base, faces, ocr)>.json  (layered, reuses base passes)
agent ──video_inspect{what:"brief",task}──► editingBrief (≈ 0.3–1 k tokens)
agent ──video_plan/compile {kind:preset, footage}──► presenter → avoid → placeBox → scene op
render ──► video_inspect{what:"qa"} ──► runInspector + footageFindings (cached analyses only)
```

## Compatibility

- All schema additions are optional; existing projects, scenes and caches keep their meaning.
  Cache versions changed where outputs change: `RENDERER_VERSION r2`, `VECTOR_VERSION v3`, mask key v2,
  workflow cache `4a.1`, footage `4b.1`.
- Public identity is FRAME; the MCP key `tmep`, `.tmep/`, `tmep/1`, `tmep` binaries and `TMEP_*`
  variables keep working (`FRAME_*` aliases take precedence).
- MCP surface grows only by `video_inspect` targets/fields (no new tool).
