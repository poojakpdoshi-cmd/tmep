# Benchmarks

All numbers on this page were measured in this repository's development environment
(Linux VM, 2 vCPU, 7.8 GB RAM, Node 22.23, FFmpeg 6.1.1) on 2026-11-08. Re-run them on
your machine; results are written to `bench/results/latest.json`.

## 1. Token usage: TMEP vs a conventional agent workflow

```bash
node bench/token-bench.ts               # offline heuristic token estimates
ANTHROPIC_API_KEY=... node bench/token-bench.ts --anthropic   # exact counts via count_tokens
```

**Task (identical for both):** turn a 30 s raw talking-head clip (50 spoken words) into a
20 s 9:16 reel with word-by-word animated captions, a title, motion graphics for key
points, punch zooms and SFX; then make the captions boxed and zoom on "faster".

**TMEP workflow (real):** the actual MCP server handles 6 real tool calls (import,
transcribe, plan, preview render, edit, final render). Payloads are the exact JSON-RPC
arguments and results; both renders complete and are ffprobe-verified.

**Conventional workflow (scripted lower bound):** an agent with a shell tool and a
file-write tool. Every payload is a real artifact for the same input and the same edit:
the actual `ffprobe -show_format -show_streams` JSON, the word-level transcript (compact
faster-whisper-style JSON), the ASS subtitle/graphics file and the FFmpeg commands that
TMEP itself rendered successfully, and real FFmpeg log tails. The model is assumed to write
each artifact once, perfectly, with no retries, no exploration and partial (not full) file
rewrites on the iteration. Real agents do worse, so this is a lower bound for the baseline.

**Accounting:** *output tokens* = everything the model writes (tool-call arguments, final
answer). *Cumulative input* = the model is re-invoked for every call with system prompt +
tool definitions + user request + all prior messages, summed over the loop, with no prompt
caching (caching lowers the price of repeated prefixes on both sides but not the volume).

Tokenizer: heuristic estimate (`bench/tokens.ts`, BPE-like splitting). Absolute values are
roughly +-20%; the same estimator is applied to both workflows. Use `--anthropic` for exact
Claude counts (not run here: no API key in this environment).

| Workflow | Tool calls | Output tokens | Tool-result tokens | Static context per turn | Cumulative input | Largest single message |
|---|---|---|---|---|---|---|
| TMEP, `detail=standard` | 6 | **217** | 482 | 1,968 | **16,301** | `video_plan` result (107) |
| TMEP, `detail=minimal` | 6 | **217** | 180 | 1,968 | **15,173** | `video_plan` call (45) |
| Conventional (scripted lower bound) | 7 | 17,937 | 5,145 | 330 | 99,750 | writing the ASS file (10,449) |

What this shows, for this task:

- The model **writes ~83x fewer tokens** with TMEP (217 vs 17,937). Output tokens are the
  slow and expensive part of agent loops.
- **Cumulative input is ~6.1x lower** (16.3k vs 99.8k) even though TMEP's tool definitions
  (~2k tokens) are re-sent every turn; that fixed cost is now TMEP's largest component.
- The conventional workflow's cost scales with *content length* (transcript size, caption
  events, graphics); TMEP's scales with the *number of decisions*.

What it does not show:

- It is one task on one synthetic clip. Longer footage widens the gap (transcript and ASS
  grow linearly; TMEP calls do not); a trivial cut-only task would narrow it.
- No live LLM was run. Model quality, retries and planning tokens are not measured on
  either side. The baseline's correctness is not evaluated (its artifacts are known-good
  because TMEP rendered them).
- Wall time of the conventional workflow is not reported: it would be dominated by LLM
  generation speed, which was not measured.

## 2. Render performance

19.67 s, 1080x1920 @ 30 fps reel (5 clips, kinetic/boxed captions, title, icon cards, stat
count-up, step badge, CTA, progress bar, punch zoom, 9 SFX, loudness normalization):

| Render | Settings | Wall time | Peak RSS (process tree) |
|---|---|---|---|
| Preview | 540x960, x264 `ultrafast` CRF 28 | 7.9 s | not measured |
| Final, cold cache | 1080x1920, x264 `veryfast` CRF 19 | 20.4 s | 669 MB |
| Final, unchanged revision | whole-output cache hit | < 1 s | n/a |
| Segment preview (3 s range) | 1 unit | ~1 s | n/a |

Output: H.264 High, AAC-LC 48 kHz stereo, 468 kb/s for this low-detail synthetic footage,
integrated loudness -14.2 LUFS, true peak -3.9 dBFS (target -14 LUFS / -1.5 dBTP).
Real camera footage has more detail, so bitrates will be higher.

## 3. What the automated tests verify

| Suite | Checks |
|---|---|
| `packages/*/test` (33 tests) | schema validation and suggestions; frame-exact layout; anchor resolution; anchored items surviving cuts; transcript-based deletes; atomic op batches; transition handles; revisions/undo/redo; whisper.cpp JSON parsing; SRT/VTT/JSON import; Hinglish transliteration; rough cut and search; icon geometry and winding; caption pagination, corrections and line breaks; every preset in portrait and landscape; storytelling rule detection and density limits; all templates; MCP tool-name constraints; MCP protocol in both eras over real stdio |
| `tests/e2e.test.ts` (3 tests, real FFmpeg) | import dedupe; cached transcript; plan with expected graphics; every kept word on screen at its midpoint; preview and final render geometry/duration/audio; caption pixels present in the burned-in frame; loudness within +-3 LU of target; whole-output cache hit; partial unit reuse after an edit; segment preview span; alpha overlay export with captions in the alpha channel; undo; job cancellation; b-roll cutaway, still image, ducked music, SFX, lower third on 16:9 |

## 4. Not yet measured

- **Transcription accuracy and word-timing error** of whisper.cpp / faster-whisper,
  including Hinglish. No speech engine or model was available in this environment, and the
  test footage uses known synthetic timings. The engine adapters' parsers are unit-tested
  on format fixtures; the adapters themselves have not been run here.
- GPU encoders (NVENC/QSV/VideoToolbox) and Windows/macOS render timings (CI runs the e2e
  suite on those OSes once the workflow runs on GitHub).
