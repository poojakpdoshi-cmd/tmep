import type { Word } from '../../core/src/index.ts';
import { TmepError } from '../../core/src/index.ts';

/** Reference pace is a target, never permission to cut a word or discard narration. */
export function referenceRanges(words: Word[], duration: number, shot: number, fps: number): [number, number][] {
  if (!Number.isFinite(shot) || shot <= 0 || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new TmepError('E_INPUT', 'invalid reference pacing or source duration');
  }
  if (!words.length || words.some((w, i) => !Number.isFinite(w.s) || !Number.isFinite(w.e) || w.s < 0 || w.e <= w.s || w.e > duration || (i > 0 && w.s < words[i - 1]!.e))) {
    throw new TmepError('E_INPUT', 'reference planning requires valid non-overlapping measured word times');
  }
  const target = Math.max(0.75, Math.min(30, shot));
  const candidates: number[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const word = words[i]!, next = words[i + 1]!;
    if (!/[.!?]["')]*$/.test(word.w) && next.s - word.e < 0.35) continue;
    const cut = Math.round((word.e + next.s) / 2 * fps) / fps;
    // Even rounding to the nearest frame must stay outside spoken words.
    if (cut >= word.e && cut <= next.s && cut > 0 && cut < duration) candidates.push(cut);
  }
  const cuts = [0];
  while (true) {
    const start = cuts.at(-1)!;
    const options = candidates.filter(c => c - start >= target * 0.6 && duration - c >= Math.min(0.5, target * 0.4));
    if (!options.length || duration - start < target * 1.4) break;
    options.sort((a, b) => Math.abs(a - start - target) - Math.abs(b - start - target) || a - b);
    const chosen = options[0]!;
    // Leave long speech intact when there is no nearby safe boundary.
    if (chosen - start > target * 2) break;
    cuts.push(chosen);
  }
  return cuts.map((s, i) => [s, cuts[i + 1] ?? duration]);
}
