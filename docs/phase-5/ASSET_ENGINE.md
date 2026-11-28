# FRAME — Phase 5 Visual Asset Engine (`frame.assets/1`)

A project-local library (`.tmep/library.json`) of visual assets with licence records. Separate from the
editing timeline's media list: a library asset is imported into the project only when a compiled plan
actually places it.

## Kinds and metadata

`image · video · svg · screen-recording · chart · diagram · composition · stock`

Each entry: id (`L1`…), file, kind, title, description, tags, size/duration, SHA-256, 64-bit dHash
(representative frame; not for SVG), visible text (SVG `<title>/<desc>/<text>`), licence
`{id, source, attribution, url, verified}`, provenance (`user | stock | generated | screen-capture`) and
`genuine` (a real recording of the product it shows).

## Rules

| Rule | Behaviour |
|---|---|
| Licence | `verified` only when a licence id is stated (`owned`, `CC-BY-4.0`, `CC0-1.0`…). Unknown/unverified assets are found by search but **never recommended**; the skip reason says so |
| Product demonstrations | A segment that describes using an interface (click, tap, settings, dashboard, app, …) or names the product only gets a `screen-recording`/`video` asset marked `genuine: true`. Otherwise FRAME emits a **request** with `mustBeGenuine: true` — it never generates or simulates a demo |
| Duplicates | exact (SHA-256) and near (dHash Hamming ≤ 6); reported when assets are added and on demand |
| Search | BM25 over tags (×2), title (×2), description, visible text and file name, light stemming; score normalized to the query's three most specific terms that exist in the library, so thresholds mean the same for any library size |
| Recommendations | per transcript segment (≤ 8 s or a sentence): best usable asset with score ≥ 0.35, preferring variety; returned with time span, matched terms and score |
| Requests | when nothing qualifies and the segment carries a visual idea: `chart` (figures → source data, FRAME can animate it), `diagram` (steps/process), `screen-recording` (UI, genuine), `image` otherwise — with span, duration, aspect and the reason |

## Interfaces

```
video_import {paths:[...], library:{kind, title, tags, licence:{id, source, attribution, url}, genuine}}
video_inspect {what:"library", action:"list"|"search"|"dups"|"recommend", find:"query", kind, asset:"v1"}
tmep library add rocket.svg --tags launch --licence CC0-1.0 --source "…"
tmep library search revenue growth chart
tmep library licence L3 --licence CC-BY-4.0 --attribution "Name"
tmep library recommend --asset v1
```

## Evidence

`tests/phase5.test.ts` (public API, real FFmpeg): licences recorded and gated; a near-duplicate PNG found
(dHash); an SVG found by its `<title>`; a licence update makes it recommendable; a figure becomes a chart
recommendation; "open the settings screen and click save" becomes a genuine screen-recording request; plan
compile imports a library asset only when placed. Not measured: retrieval quality on a large real library
(none available) — the scorer is lexical, not semantic; embedding search over images is future work
(the MobileNetV3 embedder is installed for footage similarity and can be reused).
