# FRAME — Phase 6 Frozen Production Rubric

Written and committed **before** any 6.6 evaluation edit was produced. Not changed afterwards.

## Requirements (identical for both workflows)
From a 60–65 s licensed dialogue segment, produce a **30–45 s vertical (9:16) reel** that:
1. keeps the spoken story (complete lines, no mid-word cuts), in source order;
2. frames the speaking subject inside 9:16 (no cut-off faces, no black bars);
3. burns **accurate** captions that do not cover faces, or no captions when accuracy cannot be ensured;
4. uses only motivated effects (no zoom/graphic without a reason; restraint over count);
5. delivers clean audio (programme loudness −14 ± 1.5 LUFS, true peak ≤ −1 dBTP, intelligible dialogue);
6. changes no backgrounds and applies no colour "look" (corrective changes only).

## Workflows
- **Previous (Phase 5 tools)**: transcribe → `inspect brief` → `editplan build` → `editplan compile` → caption/format edit → render — the calls an agent would make with the Phase 5 interface, executed as-is (no hand-tuning beyond what the interface offers).
- **FRAME Phase 6**: transcribe → one `video_plan {mode:"produce"}` call through to `final`.

## Scores (1–5, single rater = the agent, from decoded contact sheets and measurements; not a professional review)
| Criterion | 5 | 3 | 1 |
|---|---|---|---|
| Editorial relevance | every kept line carries the story; nothing essential lost | minor losses or filler kept | story unintelligible |
| Visual quality | speaking subject framed in every sampled frame | ≤ 1/3 of sampled frames mis-framed | most frames mis-framed / bars |
| Captions | accurate words, readable, never over a face | small errors or one overlap | wrong words or covering faces |
| Pacing | within 30–45 s, no dead air > 1 s, no jarring cut | one of these violated | several violated |
| Audio | loudness/peak within spec, no clicks at cuts | slightly off spec | clipped / inaudible |
| Effects | each effect motivated, ≤ budget | one unmotivated effect | effects distract |

Technical QA (Inspector findings, loudness, durations) is reported **separately** from these scores; a clean
Inspector report is not evidence of creative quality.

## Measured per run
Wall time, peak Node RSS, tool calls, agent-written payload (estimated tokens, `bench/tokens.ts`), output
duration, Inspector findings, loudness/true peak. Provider-reported model tokens: only if an authorized
model integration exists (none in this environment).
