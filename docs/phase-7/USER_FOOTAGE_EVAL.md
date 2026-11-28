# FRAME Phase 7 — Evaluating on your own footage

No licensed talking-head reels, informative videos or product demos with usable rights were reachable from
the evaluation environment (only *Tears of Steel* dialogue, CC BY 3.0). This workflow lets anyone repeat the
Phase 6 → Phase 7 comparison on footage they own, with the same frozen rubric and a blind rating step.
Nothing is uploaded anywhere; everything runs locally.

## 1. Prepare
1. Two checkouts: Phase 6 (`git worktree add ../frame-p6 66663ca`) and Phase 7 (this branch).
2. Optional models (shown with sizes and licences before download): `tmep models` then
   `tmep models install --confirm` (adds the 3.7 MB face-landmarker for active-speaker framing).
3. A folder of clips, ideally 30–120 s each, one category per clip:
   talking-head reel, informative video, product demo (genuine recording of the product), dialogue.
   For each clip, optionally a same-name `.srt` (otherwise the version's default local ASR is used), and a
   `requests.json` with the instructions you would give an editor:
   ```json
   { "demo.mp4": { "genre": "product", "constraints": { "target": 45, "min": 30, "ratio": "9:16", "captions": true } },
     "talk.mp4": { "genre": "informative", "constraints": { "target": 40, "ratio": "9:16" } } }
   ```
   Do not commit the footage (keep it outside the repository).

## 2. Run both versions (same machine, one after the other)
```bash
FRAME_MODELS=~/.cache/frame/models node bench/phase7/production-eval.ts --root ../frame-p6 --label p6 --segments ./clips --out ./eval
```
```bash
FRAME_MODELS=~/.cache/frame/models node bench/phase7/production-eval.ts --root . --label p7 --segments ./clips --out ./eval
```
Each writes `eval/production-eval-<label>.json` (wall time, peak RSS, calls, agent-written tokens, duration,
loudness, true peak, dead air, Inspector findings by class, timeline summary) and a contact sheet per clip.

## 3. Rate blind
```bash
node bench/phase7/blind-sheets.ts --dir ./eval --a p6 --b p7 --to ./rater --key ./key.json
```
Give `./rater` (renders and sheets named X / Y) and `docs/phase-6/RUBRIC.md` to one or more raters who did
not run the edits. Each scores X and Y per criterion (1–5): editorial relevance, visual quality, captions,
pacing, audio, effects. Only then open `key.json`. Report per-clip and total scores, the number of raters and
their agreement; label any score given by the agent as **agent-only**.

## 4. What counts as an improvement
Phase 7 must score **higher**, not equal with more features. Report clips where it scores lower, and keep the
technical measurements (Inspector, loudness, timing) separate from the rubric: zero objective findings is not
evidence of creative quality.
