# Transcription and editing budgets

PRE-HACKATHON DEVELOPMENT — November 16, 2026. Base: merged PR #26 (`bf16ae3`). No creative AI planner, provider client, new transcription engine, or TTS is included. Whisper inference and deterministic editing/rendering are local and consume zero Claude/Codex API tokens. Agent conversations around them are separate.

## One transcription request

```powershell
node bin/tmep.js transcribe-batch v1 v2 -p "./my project" --engine whisper.cpp --lang en
node bin/tmep.js transcribe-batch v1 v2 -p "./my project" --engine whisper.cpp --lang en --vad on
node bin/tmep.js transcribe-batch v1 v2 -p "./my project" --engine whisper.cpp --lang en --vad verify
```

Default behavior remains unchanged: whisper.cpp uses full audio; Faster-Whisper retains its existing VAD default. Explicit `--vad off` disables VAD for either backend. `on` selects speech, and reports `unverified` until compared to full audio. It is experimental: quiet or short speech can be missed even with high word probabilities. `verify` compares every clip with a full-audio pass and **always retains full-audio word data**, including probabilities and original timestamps. It costs extra inference; agreement is not ground-truth alignment. Neither mode guarantees correct recognition.

Native setup: use whisper.cpp **v1.8.3**, `whisper-cli`, its companion `whisper-vad-speech-segments` executable, GGML transcription model and the existing Silero v6.2.0 GGML VAD model. Set `TMEP_WHISPER_CPP`, `TMEP_WHISPER_MODEL`, `TMEP_WHISPER_VAD_MODEL`. The detector defaults to the same directory as whisper-cli; override with `TMEP_WHISPER_VAD`. No runtime downloads. Optional flags: `--vadModel "path with spaces/model.bin"`, `--vadThreshold 0.5`, `--vadPadMs 400` (100–2000 ms).

Why a separate detection pass: v1.8.3's integrated `--vad` remaps segment timestamps but returns token timestamps on compressed audio. TMEP instead reads padded speech regions, merges overlaps, writes temporary PCM chunks, and adds each chunk's original sample offset to every word. The detector prints **centiseconds**, which TMEP explicitly converts; do not substitute an untested detector with different output units. Native source: `src/whisper.cpp` token/segment getter functions and `examples/vad-speech-segments/speech.cpp` at tag v1.8.3.

Empty detection, malformed regions, missing detector/model, empty words, very low confidence or out-of-chunk times trigger full-audio fallback. Cancellation still cancels. A fallback does not make Whisper's baseline recognition or interpolated timestamps accurate. `approx` remains visible. Fast mode cannot detect all omitted speech; use verification where omissions matter.

Whisper models load once per command-line-sized chunk group, with an additional pass when fallback/verification is needed. The native detector loads its small VAD model per clip. Faster-Whisper uses its existing single Python worker per pass, with configurable built-in VAD; its internal timestamp mapping is retained. Live Faster-Whisper validation is pending.

## Cache and context

Transcript keys fingerprint local model contents (including environment-selected GGML files), native binaries, VAD model/detector, threshold, padding, mode, language, prompt and imported source identity. Model fingerprints are computed once per engine per batch. Named Faster-Whisper model snapshots/Python package upgrades require `--force` or a local model directory. Imported media identity uses the existing `mediaHash` algorithm (sampled on large media); it is not a new full-file integrity guarantee. Changed source identities require reimport before reusing WAVs. Old transcript keys miss once; original caches are not deleted.

Batch output contains up to eight text cues of 120 characters each, corresponding timestamps, keywords and local transcript references. It never returns full words by default. Missing clips remain separate failures; successes are saved. For details, use `inspect transcript --asset v1 --words` or `--detail debug`. Existing single-asset CLI/MCP remains compatible. VAD options are exposed by CLI/API; no new MCP tool is added.

```js
import { transcribeBatch, editingContext, TokenBudget } from './packages/engine/src/api.ts';
const batch = await transcribeBatch({ project: './my project', detail: 'minimal' },
  { assets: ['v1', 'v2'], engine: 'whisper.cpp', vad: 'verify' });
const context = editingContext(batch); // <=5 clips, <=3000 UTF-8 bytes; extractive, marked truncated
const budget = new TokenBudget('./my project/.tmep/budgets/reel-001.json');
console.log(await budget.status());
```

Use the **same ledger for the entire job**, including revisions and retries. Compact context is untrusted source text, not instructions. It deliberately omits detail; retrieve full local words only when necessary. For scenes, include only the relevant editable scene fields in the final bounded request input.

## Budget contract for future integrations

| Stage | Input limit | Generation limit, including reasoning | Stage total |
|---|---:|---:|---:|
| Initial plan | 3500 | 1500 | 5000 |
| Optional revision | 2000 | 1000 | 3000 |

`TokenBudget.execute({stage, input, inputTokens?, maxOutputTokens}, invoke)` durably reserves before invoking the supplied callback exactly once. The callback receives the input and `{maxOutputTokens, attemptId}` and returns `{value, usage?}`. This is infrastructure for a future provider adapter, **not an implemented AI planner**. All system messages, history, tools and scene context must be included in the counted request. Supply `inputTokens` only from the provider's tokenizer/count endpoint; otherwise UTF-8 bytes are explicitly labeled an estimate. Request text is limited to 16,000 bytes as well.

Usage fields: `inputTokens`, `outputTokens`, optional `reasoningTokens`, `outputIncludesReasoning`, `totalTokens`. When reasoning is supplied, inclusion must be explicit to avoid double-counting. Provider totals may include additional billed categories and take precedence when at least the sum of reported components. All tokens count, including cached tokens and failed/retried requests when reported; no discounts are assumed.

Reservations, actual reported usage, uncertainty and attempt IDs persist to JSON under an exclusive file lock. Unknown usage/errors remain charged at the reservation and **block further requests** until explicitly reconciled via `settle(attemptId, usage)`. Crashes leave pending attempts; do not reset the ledger or blindly remove a lock. Explicit retries require new reservations. There are no automatic retries. Overrun records the actual amount and stops further processing; it cannot undo tokens already billed. Corrupt ledgers fail closed. Do not share one job across different ledger files.

Tests enforce admission rules with mock callbacks, including an exact 5000+3000 sequence. **The 8000-provider-token ceiling is not achieved or verified.** A future adapter must provide accurate complete request counts, enforce inclusive generation limits, normalize provider usage and checkpoint every attempt. External Claude/Codex sessions bypass this ledger. `billingCapVerified` therefore remains false, even when mock accounting totals 8000. No provider call or real token-savings measurement was made.

## Observed validation

Linux, Node 24.22.1, FFmpeg 7.1.5, whisper.cpp v1.8.3, GGML Base, Silero v6.2.0. Two original English Flite speech recordings in synthetic video, each with 2 s leading and 3 s trailing silence; decoded audio totals 18.240 s. All modes used the same assets, model and warm WAVs. One observed run per mode; native models start fresh per pass.

| Mode | Wall s | Child CPU s | Max child RSS KiB | Audio submitted to transcription s | JSON bytes |
|---|---:|---:|---:|---:|---:|
| Full audio | 4.386 | 13.571 | 291688 | 18.240 | 548 |
| VAD on | 6.133 | 20.923 | 290448 | 17.844 | 860 |
| VAD verify | 7.491 | 27.344 | 291840 | 27.380 | 847 |
| Cached VAD | 0.446 | 0.674 | 152892 | 0 | 864 |

**No Whisper compute savings demonstrated.** One fast-mode clip triggered fallback; verification kept both original results. Detection/model startup and fallback outweighed the small reduction in submitted audio. Max child RSS is not summed process-tree peak. JSON sizes exclude the trailing newline. These are single observations, not statistical benchmarks. No provider usage measured.

Accuracy was poor: normalized word-error counts against the exact 19-word synthesis input were 17/19 for full audio, 15/19 for VAD on, and 17/19 for verification. Word error rate can exceed 100% per clip due to insertions. Full-audio words incorrectly started at 0 s despite the 2 s leading silence; VAD's non-fallback clip started at 2.24 s. Unit tests verify offset arithmetic and sample preservation; this recording does not establish caption alignment accuracy. No Hindi/Hinglish recordings were available here, so those recognition comparisons are **unverified**. No claim of professional caption quality.

The same two clips were imported, transcribed, combined into an editable revision with clean captions, and rendered as an 18.167 s H.264/AAC 540x960 preview MP4. Original Windows execution disconnected; space-containing paths are exercised on Linux and in portable tests, but live Windows VAD execution is pending.

Reproduce on Linux with configured native binaries/models and Python stdlib:

```sh
python bench/speech-vad.py "/tmp/tmep speech proof"
```

Requires FFmpeg with Flite. Use a new empty output directory when model/configuration changes. The harness saves transcripts, manifests, measurements and MP4 locally and resumes existing measurements rather than repeating successful work. Machine-readable observations: [validation JSON](validation/transcription-budget-2026-11-16.json).

Test results in this environment:

- Type-check and Python syntax checks passed.
- Final focused budget/VAD/cache/CLI tests: 12/12 passed.
- Full unit suite run once: 157 passed, 1 failed (158 total; two additional focused cases were added afterward and passed).
- Full E2E suite run once: 72 passed, 1 failed (73 total).
- Failures: `ffmpeg: full unit graph with fit + zoom + fx renders the exact frame count` (FFmpeg xfade rejects rate 1/0) and `end-to-end reel: plan, render, verify, edit, cache` (FFmpeg conversion failure). Both reproduced in a detached checkout of unchanged `origin/main` with focused reruns. No renderer changes were made. GitHub CI/platform results remain pending.
- Portable tests cover paths containing spaces, partial batch failure, precise cached word preservation, model/config invalidation, missing components, original-offset arithmetic and ledger persistence/concurrency. Live Windows, Hindi/Hinglish recognition and Faster-Whisper VAD remain unverified.
