# FRAME — Phase 6.6 Real Production Evaluation

Rubric and requirements: [RUBRIC.md](RUBRIC.md) (committed `6f7e883`, before any evaluation edit).
Harness: `bench/phase6/production-eval.ts`. Evidence: `evidence/production-eval.json`,
`evidence/production-eval-frame2.json`, contact sheets `evidence/tos-*-sheet.jpg`.

**Footage**: *Tears of Steel* (© Blender Foundation | mango.blender.org, **CC BY 3.0**), 360p, English
dialogue; two segments: A = 15–75 s (breakup dialogue, two-shots), B = 185–250 s (mission briefing,
close-ups). Transcript: the film's official English subtitles imported as SRT (accurate words,
cue-level timing). Same requirements for both workflows: 30–45 s, 9:16, accurate captions, motivated
effects only, −14 LUFS, no looks/background changes (`genre: cinematic`, `target: 40`, `captions: true`).
No talking-head recording with speech was available under a usable licence in this environment; these are
film dialogue scenes, which are harder to frame vertically than a single presenter.

## Results (original run — scored before any fix)

| | A previous | A FRAME | B previous | B FRAME |
|---|---|---|---|---|
| Tool calls | 8 | **3** | 8 | **3** |
| Agent-written payload (est. tokens) | 508 | **274** | 508 | **274** |
| Wall time | 70.2 s | 70.2 s | 94.6 s | 100.0 s |
| Peak Node RSS | 183 MB | 228 MB | 223 MB | 248 MB |
| Output duration | 26.8 s | 28.3 s | 36.4 s | 38.6 s |
| Loudness / true peak | −13.9 LUFS / −1.3 dBTP | −13.8 / −1.3 | −14.3 / −1.3 | −14.0 / −1.2 |
| Dead air > 1 s | 0 | 0 | 0 | 0 |
| Zooms / graphics / transitions | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 |
| Caption band | lower | upper | lower | upper |
| Inspector at evaluation time | 0 defects | 1 defect* | 1 defect* | 1 defect* |

\*All `av-sync` defects were false: the Inspector compared AAC container durations (inflated by encoder
priming/padding: "28.300 s" for 28.245 s of decoded audio). Fixed in `2fbe69e` (drift is now confirmed on
decoded audio; a real 0.5 s drift is still reported). Re-inspected outputs: 0 defects.

### Rubric scores (1–5, single rater = the agent, from decoded contact sheets; not a professional review)

| Criterion | A previous | A FRAME | B previous | B FRAME |
|---|---|---|---|---|
| Editorial relevance | 4 | 4 | 4 | 4 |
| Visual quality (framing) | 3 | 3 | 4 | 4 |
| Captions | 5 | 3 | 5 | **2** |
| Pacing (30–45 s, dead air, cuts) | 3 (26.8 s) | 3 (28.3 s) | 5 | 5 |
| Audio | 5 | 5 | 5 | 5 |
| Effects (restraint) | 5 | 5 | 5 | 5 |
| **Total / 30** | **25** | **23** | **28** | **25** |

What the frames show:
- **Captions** (decisive difference): FRAME's Director put captions in the upper band because people's
  body boxes reached the lower band; in segment B the upper captions cross faces in ≥ 3 of 8 sampled
  frames. The Phase 5 workflow used the conventional lower band, which sat on torsos. This is a real
  regression of the original Phase 6 rule.
- **Framing**: both workflows crop two-shots to 9:16 the same way (static crop centre); in A one speaker is
  cut at the frame edge in about a third of the samples. Neither follows the active speaker.
- **Length**: segment A holds only ~28 s of speech; neither workflow reaches the 30 s minimum. Both keep
  only speech (by design nothing is padded), so the requirement was not met by either.
- **Restraint**: both used no zooms, graphics or transitions — appropriate for cinematic dialogue.
- **Captions from local ASR** (FRAME only, same segments, NeMo CTC small): the caption-accuracy gate
  refused to burn captions and reported the open decision (measured WER 0.53 on this film).

## Post-evaluation fix and rerun (not independent of the evaluation)

`cae5bc0`: captions go in the band covering the fewest **heads** (faces, pose heads, tops of person
boxes) instead of avoiding body boxes. FRAME was re-run on both segments with otherwise identical inputs;
results in `evidence/production-eval-frame2.json` and the `-frame2-sheet.jpg` contact sheets. See below.

RERUN_RESULTS

## Conclusions
- FRAME reduced the agent's work to one production call (3 calls instead of 8, ~46 % less agent-written
  payload) with comparable runtime and memory, and it reports its decisions, refusals and unresolved items.
- It did **not** produce better edits than the Phase 5 workflow on these scenes at evaluation time; its
  caption placement was worse. Technical QA was clean (after fixing a false av-sync defect) — which, as the
  rubric warns, said nothing about the caption problem a viewer sees immediately.
- Provider-reported model tokens: unavailable (no authorized model integration). No result here was
  produced by a model call.
