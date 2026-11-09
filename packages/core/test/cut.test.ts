/**
 * Timeline `cut` correctness with reused footage (audit P1-1).
 *
 * A timeline cut must remove only what is under [from, to) on the timeline: other placed
 * clips that reuse the same source range stay untouched. Word-based `delete` / `tighten`
 * keep their source-wide semantics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTimeline, newClip, layout, duration, type Timeline, type Clip, type Word } from '../src/timeline.ts';
import { applyOps } from '../src/ops.ts';
import { sampleKeys, type FxTransform } from '../src/effects.ts';

const ctx = (transcripts: Record<string, Word[]> = {}) => ({ transcripts, assets: { v1: { dur: 10, kind: 'video' }, v2: { dur: 10, kind: 'video' } } });
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const shape = (tl: Timeline) => tl.clips.map((c) => `${c.src}[${r6(c.in)}-${r6(c.out)}]${c.speed !== 1 ? `x${c.speed}` : ''}`);
const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} != ${b}`);

/** Source time shown at timeline time t (frame-accurate model of the render). */
function srcAt(tl: Timeline, t: number): { src: string; t: number } | undefined {
  const p = layout(tl).find((p) => t >= p.start - 1e-9 && t < p.start + p.dur - 1e-9);
  return p && { src: p.clip.src, t: p.clip.in + (t - p.start) * p.clip.speed };
}

function twoCopies(): Timeline {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0, 4), newClip(tl, 'v1', 0, 4));
  return tl;
}

test('audit repro: cut 5 6 on two copies of a 4 s source removes 1 s from the second copy only', () => {
  const tl = twoCopies();
  const first = structuredClone(tl.clips[0]!);
  assert.equal(duration(tl), 8);
  const r = applyOps(tl, ['cut 5 6'], ctx());
  assert.equal(duration(r.tl), 7);
  assert.deepEqual(r.tl.clips[0], first, 'first occurrence unchanged');
  assert.deepEqual(shape(r.tl), ['v1[0-4]', 'v1[0-1]', 'v1[2-4]']);
  assert.deepEqual(r.notes, ['cut 1s']);
  // content: timeline 5.0 now shows source 2.0 of the second copy; 0..4 still shows the first copy
  assert.deepEqual(srcAt(r.tl, 5), { src: 'v1', t: 2 });
  near(srcAt(r.tl, 1.5)!.t, 1.5);
});

test('overlapping uses of one source: only the clip under the cut changes', () => {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0, 6), newClip(tl, 'v1', 2, 5), newClip(tl, 'v1', 3, 4));
  // timeline: c1 0-6, c2 6-9 (src 2-5), c3 9-10 (src 3-4); cut 7-8 = src 3-4 of c2 only
  const r = applyOps(tl, ['cut 7 8'], ctx());
  assert.deepEqual(shape(r.tl), ['v1[0-6]', 'v1[2-3]', 'v1[4-5]', 'v1[3-4]']);
  assert.equal(duration(r.tl), 9);
  assert.deepEqual(r.notes, ['cut 1s']);
});

test('a cut crossing a clip boundary trims both neighbours and nothing else', () => {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0, 4), newClip(tl, 'v1', 0, 4), newClip(tl, 'v1', 0, 4));
  const r = applyOps(tl, ['cut 3 5'], ctx());
  assert.deepEqual(shape(r.tl), ['v1[0-3]', 'v1[1-4]', 'v1[0-4]']);
  assert.equal(duration(r.tl), 10);
  assert.deepEqual(r.notes, ['cut 2s']);
  assert.deepEqual(srcAt(r.tl, 3), { src: 'v1', t: 1 });
});

test('speed-adjusted clips: cut maps timeline time through speed; note reports timeline seconds', () => {
  const tl = twoCopies();
  tl.clips[1]!.speed = 2; // second copy lasts 2 s on the timeline (4..6)
  const r = applyOps(tl, ['cut 4.5 5'], ctx());
  // 0.5 s of timeline at 2x = source 1..2 of the second copy
  assert.deepEqual(shape(r.tl), ['v1[0-4]', 'v1[0-1]x2', 'v1[2-4]x2']);
  near(duration(r.tl), 5.5);
  assert.deepEqual(r.notes, ['cut 0.5s'], 'timeline seconds, not source seconds');
});

test('repeated cuts on reused footage stay local and deterministic', () => {
  const tl = twoCopies();
  const r = applyOps(tl, ['cut 5 6', 'cut 0.5 1', 'cut 5 5.5'], ctx());
  // after cut 1: [v1 0-4][v1 0-1][v1 2-4] (7 s); cut 2 trims copy 1 to 0-0.5,1-4 (6.5 s);
  // cut 3 at 5-5.5 falls on the third piece (starts 4.5) -> src 2.5-3
  assert.deepEqual(shape(r.tl), ['v1[0-0.5]', 'v1[1-4]', 'v1[0-1]', 'v1[2-2.5]', 'v1[3-4]']);
  near(duration(r.tl), 6);
  assert.deepEqual(r.notes, ['cut 1s', 'cut 0.5s', 'cut 0.5s']);
  assert.equal(new Set(r.tl.clips.map((c) => c.id)).size, r.tl.clips.length, 'unique clip ids');
  const again = applyOps(twoCopies(), ['cut 5 6', 'cut 0.5 1', 'cut 5 5.5'], ctx());
  assert.deepEqual(again.tl.clips, r.tl.clips);
});

test('clips with effects: only the cut clip is split and re-timed; the other copy keeps its fx untouched', () => {
  const tl = twoCopies();
  const r0 = applyOps(tl, ['fx zoomin d=4 amt=0.4 e=linear'], ctx()); // on both copies
  const firstBefore = structuredClone(r0.tl.clips[0]!);
  const r = applyOps(r0.tl, ['cut 5 6'], ctx());
  assert.deepEqual(r.tl.clips[0], firstBefore, 'untouched copy keeps identical clip + fx');
  const [, left, right] = r.tl.clips as [Clip, Clip, Clip];
  const k = (c: Clip) => (c.fx![0] as FxTransform).keys;
  near(sampleKeys(k(left), 's', 0.5), 1.05);
  near(sampleKeys(k(right), 's', 0), 1.2, 'right part continues from source 2 s');
  assert.notEqual(left.fx, right.fx);
  assert.notEqual(left.fx, firstBefore.fx);
});

test('transitions and other sources are preserved by a local cut', () => {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0, 4), newClip(tl, 'v2', 0, 4), newClip(tl, 'v1', 0, 4));
  tl.clips[1]!.trans = { type: 'fade', d: 0.5 };
  const r = applyOps(tl, ['cut 9 10'], ctx()); // inside the third clip only (starts at 7.5)
  assert.equal(r.tl.clips[1]!.trans?.type, 'fade', 'transition kept');
  assert.deepEqual(shape(r.tl), ['v1[0-4]', 'v2[0-4]', 'v1[0-1.5]', 'v1[2.5-4]']);
  near(duration(r.tl), 10.5);
});

test('delete and tighten keep their source-wide semantics on reused footage', () => {
  const words: Word[] = [
    { w: 'hello', s: 0.2, e: 0.6 },
    { w: 'um', s: 1.0, e: 1.3 },
    { w: 'world', s: 2.6, e: 3.0 },
  ];
  const del = applyOps(twoCopies(), ['delete um pad=0'], ctx({ v1: words }));
  assert.deepEqual(shape(del.tl), ['v1[0-1]', 'v1[1.3-4]', 'v1[0-1]', 'v1[1.3-4]'], 'word removed from every occurrence');
  const tig = applyOps(twoCopies(), ['tighten max=0.5 pad=0.1'], ctx({ v1: words }));
  // gaps 0.6-1.0 (0.4 s) kept; 1.3-2.6 (1.3 s) > max -> 1.4-2.5 removed in both copies
  assert.deepEqual(shape(tig.tl), ['v1[0-1.4]', 'v1[2.5-4]', 'v1[0-1.4]', 'v1[2.5-4]']);
});

test('a cut in the frame-rounded tail of a clip never extends the clip past its out point', () => {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 1.57, 2.14));
  tl.clips[0]!.speed = 2; // 0.285 s, placed as 9 frames = 0.3 s
  const r = applyOps(tl, ['cut 0.29 2.03'], ctx());
  assert.deepEqual(shape(r.tl), ['v1[1.57-2.14]x2'], 'tail beyond the source out point is not material to remove');
});
