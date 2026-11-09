# TMEP: Token-Minimal Editing Protocol (v1)

TMEP is the contract between an AI agent and the editing engine. Its goal: the agent
spends tokens on *decisions*, never on *data* (media metadata, transcripts, timelines)
or on *code* (FFmpeg graphs, animation code).

## Principles

1. **Reference, don't transfer.** Media are addressed by short persistent ids (`v1`, `a1`,
   `i1`). Transcripts, analyses, revisions and renders live on disk in the project.
2. **Decide with intent, not coordinates.** Times accept *anchors* (`@phrase`, `w:42`,
   `c:c7^end`) resolved locally against the transcript, so the agent never needs to read
   timestamps to place an effect.
3. **Change incrementally.** Edits are small ops applied as an atomic batch that creates a
   new immutable revision (undo/redo/checkout).
4. **Return little, store much.** Responses carry status, ids and a few numbers. Detail is
   adaptive (`minimal` | `standard` | `debug`); large artifacts are written to files.
5. **Read selectively.** `video_inspect` returns slices (time ranges, search hits, word refs)
   bounded by a character budget.
6. **Fail actionably.** Errors carry a stable code, a one-line message and a hint
   ("did you mean ...?").

## Identifiers

| Kind | Form | Lifetime |
|---|---|---|
| asset | `v1` video, `a1` audio, `i1` image | stable for identical content (content hash); moving the file keeps the id |
| clip | `c12` | per timeline lineage |
| graphic / sfx / b-roll | `g5` / `s7` / `b3` | per timeline lineage |
| revision | integer `rev` | immutable |
| job | `j1a2b3c4d` | persisted in `.tmep/jobs/` |

## Anchors

| Anchor | Meaning |
|---|---|
| `12.5`, `"12.5s"` | timeline seconds |
| `"@generative ai"` | start of the first occurrence of the phrase in the *edited* transcript (prefix match on the last word) |
| `"@phrase#2"` | second occurrence |
| `"@phrase^end"` | end of the phrase |
| `"w:42"` | timeline word 42 (see `video_inspect {what:"transcript", words:true}`) |
| `"c:c7"`, `"c:c7^end"` | start/end of clip `c7` |
| `"end"` | end of timeline |

Anchors are resolved once, then stored as **source anchors** `{src, t}`. Later cuts or
reordering move graphics, zooms, SFX and cutaways together with their words; items whose
words were cut are skipped at render time.

## Ops

An op is an object (`{"op":"zoom","at":"@faster","to":1.2}`) or a compact string
(`"zoom @faster to=1.2"`): positional args, then `key=value`; quote values containing
spaces; `props.<k>=v` sets preset props; multi-word `@phrase` anchors need no quotes.

| Op | Args (positional first) | Effect |
|---|---|---|
| `cut` | from, to? | remove a timeline range (`to` optional for phrase/word/clip anchors) |
| `delete` | text \| fillers=true, pad | transcript-based removal of every occurrence |
| `tighten` | max=0.35, pad=0.08 | shorten pauses longer than `max` |
| `keep` | src, ranges, append | rebuild clips from source ranges |
| `add` / `trim` / `move` / `remove` | ... | clip-level edits; `remove` also deletes gfx/sfx/b-roll by id |
| `speed` | x, clip? | 0.25x to 4x (pitch-preserving audio via `atempo`) |
| `frame` | clip?, fit, cx, cy, base, push | framing: cover/contain/blur, crop centre, static scale, push-in |
| `zoom` | at, to=1.15, d=0.9, mode=punch\|smooth | anchored zoom envelope |
| `transition` | type, d, clip\|at\|all | xfade between clips; silence handles are added automatically and transitions that would overlap speech are refused |
| `broll` | src, at, d, in, fit | cutaway over the main video; main audio continues |
| `gfx` | preset, at, d, props | motion-graphics preset (see `video_help presets`) |
| `set` | id, at, d, props, vol | modify a gfx/sfx/b-roll item |
| `captions` | style, pos, maxWords, upper, color, accent, size, font, emphasis, script | caption styling |
| `fix` | find, replace | correct a transcript word in captions |
| `music` | src, vol=-18, duck=true, fade / off=true | music bed with speech ducking |
| `sfx` | kind, at, vol=-12 | synthesized sound effect |
| `format` | ratio, fps | 9:16, 16:9, 1:1, 4:5 |
| `loudness` | lufs | integrated loudness target (0 = off) |
| `fx` | kind, clip?, ... | clip effects (below); omitting `clip` applies to every clip |

### Effects (`fx`)

Effects attach to main clips (`cN`) or b-roll overlays (`bN`), use **clip-local seconds**
(0 = the element's first frame) and compose in
order: transforms (scales/opacities multiply, offsets/rotations add) → opacity → masks (intersected).

| Form | Meaning |
|---|---|
| `fx kf c1 keys="0:s=1,o=0;0.6:s=1.1,o=1,e=out"` | keyframes: `s` scale, `x`/`y` offset (fraction of frame, +right/+down), `r` degrees clockwise, `o` opacity 0..1, `e` easing into the key: linear\|in\|out\|io (default)\|back\|hold. JSON arrays are accepted too. |
| `fx zoomin c1 d=1.2 amt=0.15` / `zoomout` | eased zoom (default io, amt 0.15) starting at `at` (default 0) |
| `fx push c1` / `pull` | slow linear dolly-style scale over the whole clip (amt 0.08) |
| `fx panleft c1 amt=0.12` / `panright` / `panup` / `pandown` | pan; scale is raised by `amt` so the frame edge is never exposed |
| `fx mask c1 shape=ellipse x=.5 y=.4 w=.6 h=.4 feather=.04` | rect\|ellipse\|poly mask (centre/size as frame fractions); outside shows the timeline background |
| `fx mask c1 shape=poly pts="0.1,0.9 0.5,0.1 0.9,0.9" invert=true` | convex polygon, 3–16 points; `invert` flips the mask |
| `fx mask c1 shape=rect reveal=0.6 from=left at=0.2 e=out` | animated reveal: grow from `center` or wipe from left/right/top/bottom |
| `fx mask b2 shape=ellipse w=.5 feather=.03` | mask a b-roll video/image, revealing the main video underneath |
| `fx zoomin b2 d=1` / `fx kf b2 keys="0:o=0;1:o=1"` | keyframe b-roll zoom or opacity; transparent pixels stay transparent |
| `fx clear c1` / `fx clear b2` | remove effects from the target |

Limitations: masks are rendered at half resolution then upscaled (fine for feathered edges,
≈1 px soft for hard edges); polygons must be convex; push/pull are 2D scale moves, not parallax;
effects apply to main clips and explicit b-roll ids (graphics `gN` are not yet supported).
B-roll effect time stays continuous if the overlay spans cached render units; transparency
is preserved rather than flattened onto a solid colour. Untargeted `fx` continues to
affect only main clips. When `cut`/`delete` splits a main clip, each
part gets its own copy of the effects, re-timed so they continue from the original clip's state at
the cut point (speed-aware); a removed range is skipped in effect time, like source-anchored zooms.

A batch is atomic: if any op fails, nothing is committed.

## Tool surface (MCP and CLI)

| MCP tool | CLI | Purpose |
|---|---|---|
| `video_import` | `tmep import` | register media |
| `video_transcribe` | `tmep transcribe` | local STT with word timing (cached) |
| `video_plan` | `tmep plan` | full edit from transcript + template |
| `video_edit` | `tmep edit` / `undo` / `redo` / `checkout` | ops batch -> revision |
| `video_inspect` | `tmep inspect` | selective reads |
| `video_render` | `tmep render` | background render job |
| `video_status` | `tmep status` / `jobs` | job progress, cancellation |
| `video_help` | `tmep help <topic>` | references on demand |

Every MCP tool accepts optional `project` (path); edit/inspect/render accept `detail`.

## Responses

Compact JSON in a single text content block. Examples (`detail=standard`):

```json
{"ok":1,"assets":[{"id":"v1","dur":94.2,"kind":"video","res":"1920x1080","fps":30,"audio":true}]}
{"ok":1,"rev":1,"dur":19.07,"clips":5,"gfx":{"icons":1,"stat":1,"badge":1,"cta":1,"title":1,"progress":1},"zooms":0,"sfx":9,"trans":2,"cap":"kinetic","ratio":"9:16"}
{"job":"jd3a5f55d","state":"done","out":"renders/r1.mp4","dur":19.067,"size":"1080x1920","units":3,"cached":0,"s":18.6}
{"ok":0,"err":{"code":"E_ANCHOR","msg":"op #2: phrase \"most important\" not found in timeline transcript","hint":"use video_inspect {what:\"transcript\",find:\"...\"} to locate it"}}
```

## Error codes

`E_INPUT`, `E_STATE`, `E_NOT_FOUND`, `E_ANCHOR`, `E_RANGE`, `E_NO_TRANSCRIPT`,
`E_FFMPEG_MISSING`, `E_FFMPEG_FAILED`, `E_ENGINE_MISSING`, `E_ENGINE_FAILED`, `E_MEDIA`,
`E_CANCELLED`, `E_IO`, `E_INTERNAL` (`packages/core/src/errors.ts`). Over MCP, input and
business errors are returned as tool results with `isError: true` (so the model can
self-correct); unknown tools and malformed requests are JSON-RPC errors.

## Caching and determinism

| Cache | Key |
|---|---|
| transcript | asset content hash + engine + model + language + prompt (+ imported file hash) |
| speech WAV / silence analysis | asset content hash |
| video render unit | settings, encoder params, clip specs, source hashes, overlapping b-roll, the ASS events overlapping the unit window, font files, renderer version |
| audio mix | clip audio specs, music, SFX placements, loudness target, range |
| final output | all unit hashes + audio hash (marker file next to the output) |
| SFX | effect name + synth version |

Same inputs give the same plan and the same render commands; renders are reused instead of repeated.

## Versioning

`PROTOCOL = "tmep/1"`. Additive changes (new ops, presets, fields) keep `tmep/1`; renaming or
removing anything bumps the major version.
