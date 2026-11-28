# FRAME — Phase 6 Architecture: Professional Production Orchestration

Phase 6 adds an orchestration layer on top of the existing engine. Analysis, plans, edits, renders and
the Inspector are reused unchanged; the new layer decides *which* of them to run, with what policy, and
remembers every decision.

```
intent + constraints (+ reference asset)
        │
        ▼
 ┌──────────────────────── frame.production/1  (.tmep/productions/<id>.json) ───────────────────────┐
 │ ingest → intelligence → brief → strategy → roughcut → assets → motion → fine → finish            │
 │        → preview → inspect → correct → final                                                    │
 │ each stage: status, input hash, ms, outputs, project revision (editing stages)                   │
 └──────────────────────────────────────────────────────────────────────────────────────────────────┘
   intelligence: frame.footage/1 (+ semantic, camera motion, scene classifier)      [Phase 4–6]
   strategy:     Director → frame.strategy/1 (genre policy, budgets, constraints, reference style)
   roughcut…finish: frame.plan/1 items filtered by the strategy, compiled to ops, one revision per stage
   preview/inspect/correct: preview render → prioritized Inspector findings → ≤ 2 bounded correction cycles
   final: full-quality render
```

## Dependency-aware recomputation
Each stage hashes only what it depends on:
- `ingest`/`intelligence`/`brief`/`strategy` chain on the source and on the intent fields they read.
- Editing stages chain on each other **plus their own section of the strategy** (rough cut ← pacing,
  ratio, target; motion ← graphics; fine ← zooms, jump cuts, captions, effect budget; finish ← colour,
  audio). A caption change therefore re-runs `strategy → fine → finish → preview → inspect → correct`,
  not the rough cut (tested).
- Before re-running an editing stage, the project is checked out at the revision the previous editing
  stage produced — history is appended, never rewritten; each stage remains individually undoable.

## Control
| Feature | Mechanism |
|---|---|
| Explicit constraints | `constraints` (target, ratio, captions, zooms, graphics, transitions, music, keep, avoid, allowLook, allowBackgroundChange, maxEffectsPerMinute) always win over policy and corrections |
| Stage overrides | `overrides[stage] = { skip | ops | drop:[planItemIds] }` |
| Cancellation | AbortSignal checked between stages (MCP cancel); state saved as `cancelled`; `resume` continues |
| Recovery | a stage left `running` by a dead process is re-run on resume |
| Revision | `revise` merges new constraints/overrides; only affected stages recompute |
| Open decisions | music, wording beyond spoken figures, colour looks, unreviewed captions → `report.openDecisions` |

## Director (frame.strategy/1)
Genre policy table (informative, educational, podcast, product, cinematic, sports): pause threshold,
zooms/minute and their trigger (strong moments vs. event candidates), graphics kinds, caption default,
transitions, effect budget/minute. Rules that hold for every genre:
- no background change and no colour look unless explicitly allowed; corrective colour only;
- captions burned only from trustworthy timing: approximate (segment-level) transcripts and engines with
  measured low accuracy (sherpa-onnx small models, WER 0.53 on film dialogue) need explicit confirmation;
- graphics only for spoken figures/lists (stat, icons) or product callouts; nothing invented;
- reference style adapts within genre bounds (e.g. pacing clamped to the genre range) and never copies.

## Reference style (frame.style/1)
Measured: cut rate, median shot, gradual-transition share; mean motion, camera-moving share and speed;
colour (signalstats luma, saturation, contrast, warmth); audio onsets/min and dynamic range; text share,
vertical position and word height (tesseract boxes); primary-subject position and size. Each field carries
its method; unmeasurable aspects (typeface, motion design intent) are not claimed.

## Correction (6.5)
Findings are prioritized (defects first; subject/legibility before taste). Deterministic fixes only: a
valid `reframe cx/cy` from subject keys, caption band flip. A fix that contradicts an explicit instruction
is refused and reported; the loop stops after two cycles or when the same findings persist.

## Interfaces (TMEP-compatible)
- MCP: `video_plan {mode:"produce", action:start|resume|revise|status|report, …}` — the 10-tool surface is kept.
- CLI: `tmep produce start --asset v1 --genre informative --target 45 --ratio 9:16 [--until final]`.
- New engine: `sherpa-onnx` speech engine (`FRAME_SHERPA_MODEL`), model registry entries `sceneEmbed`,
  `sceneClasses` (Apache-2.0, 10.9 + 24.3 MB), `reframe follow=[…]` op parameter, library `similar`,
  `verify`, `audit`.
