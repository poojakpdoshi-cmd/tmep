/**
 * Phase 5.0 regressions for defects documented in the Phase 0 audit and re-confirmed in Phase 4:
 * B3 rounding drift, B4 transition undo, B5/B7 phrase editing, B8 validation, B10/B11 honest notes,
 * B12 clip gain/mute.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyTimeline, newClip, duration } from '../src/timeline.ts';
import { applyOps, parseOpString } from '../src/ops.ts';

const ctx = (tr: Record<string, unknown> = {}) => ({ transcripts: tr as never, assets: { v1: { dur: 10, kind: 'video' }, v2: { dur: 10, kind: 'video' }, i0: { dur: 0, kind: 'image' } }, presets: ['title'], sfxKinds: ['whoosh'] });
const ranges = (tl: { clips: { in: number; out: number }[] }) => tl.clips.map((c) => [c.in, c.out]);

test('B3: many short clips lay out at their exact total length (error diffusion)', () => {
  const tl = emptyTimeline();
  for (let i = 0; i < 100; i++) tl.clips.push(newClip(tl, 'v1', i * 0.05, i * 0.05 + 0.05));
  assert.equal(Math.round(duration(tl) * 1000) / 1000, 5);
});

test('B4: transitions are idempotent, removable, never extend into a straddling word, and work on stills', () => {
  const ws = [{ w: 'one', s: 0, e: 0.5 }, { w: 'two', s: 0.55, e: 1.0 }, { w: 'three', s: 5.0, e: 5.5 }];
  const tl = emptyTimeline(); tl.clips.push(newClip(tl, 'v1', 0, 1.05), newClip(tl, 'v1', 4.95, 5.6));
  const c = ctx({ v1: ws });
  const once = applyOps(tl, ['transition fade 0.4 all=true'], c).tl;
  const twice = applyOps(once, ['transition fade 0.4 all=true'], c).tl;
  assert.deepEqual(ranges(twice), ranges(once), 're-applying does not extend handles again');
  const none = applyOps(twice, ['transition none all=true'], c).tl;
  assert.deepEqual(ranges(none), ranges(tl), '`none` gives back the handle footage');
  assert.equal(none.clips[1]!.trans, undefined);
  // the previous clip ends inside "beta": no out-handle may be taken
  const st = emptyTimeline(); st.clips.push(newClip(st, 'v1', 0, 1.5), newClip(st, 'v1', 4, 5.6));
  const s2 = applyOps(st, ['transition fade 0.4 all=true'], ctx({ v1: [{ w: 'beta', s: 1.0, e: 2.0 }] })).tl;
  assert.equal(s2.clips[0]!.out, 1.5);
  const img = emptyTimeline(); img.clips.push(newClip(img, 'i0', 0, 3), newClip(img, 'i0', 0, 3));
  assert.match(applyOps(img, ['transition fade 0.4 all=true'], ctx()).notes[0]!, /x1$/);
  assert.match(applyOps(img, [{ op: 'transition', type: 'fade', clip: 'c1' }], ctx()).notes[0]!, /first clip has no previous clip/);
});

test('B5/B7: phrases are parsed up to the next anchor and deleted as heard, across reordered clips', () => {
  assert.deepEqual(parseOpString('cut @hello world end'), { op: 'cut', from: '@hello world', to: 'end' });
  assert.deepEqual(parseOpString('cut @hello w:3'), { op: 'cut', from: '@hello', to: 'w:3' });
  const ws = [{ w: 'hello', s: 0.2, e: 0.8 }, { w: 'world', s: 2.2, e: 2.8 }];
  const tl = emptyTimeline(); tl.clips.push(newClip(tl, 'v1', 2, 3), newClip(tl, 'v1', 0, 1));
  const r = applyOps(tl, ['delete "world hello"'], ctx({ v1: ws }));
  assert.ok(duration(r.tl) < duration(tl) - 1, `removed ${duration(tl) - duration(r.tl)}s`);
  assert.match(r.notes[0]!, /^delete 2x 1\.\d+s$/);
  assert.match(applyOps(tl, ['delete fillers=true'], ctx({ v1: ws })).notes[0]!, /no fillers/);
});

test('B8: anchors, numbers, masks, pans and trims are validated', () => {
  const tl = emptyTimeline(); tl.clips.push(newClip(tl, 'v1', 0, 4));
  const c = ctx({ v1: [{ w: 'a', s: 0.5, e: 0.8 }] });
  for (const [op, re] of [
    ['gfx title -3', /before the timeline start/], ['gfx title 999', /past the timeline end/],
    ['zoom @a#0', /start at 1/], ['zoom w:1.5', /bad word anchor/], ['zoom c:c1^bogus', /modifier/],
    [{ op: 'zoom', at: 1, to: '0x2' }, /expected number/],
    ['fx panleft c1 amt=-0.5', /pan amount must be >= 0/],
    [{ op: 'fx', kind: 'mask', clip: 'c1', shape: 'rect', pts: [[0, 0], [1, 0], [1, 1]] }, /not pts/],
    [{ op: 'fx', kind: 'mask', clip: 'c1', shape: 'poly', pts: [[0.5, 0.1], [0.735, 0.824], [0.12, 0.376], [0.88, 0.376], [0.265, 0.824]] }, /crosses itself/],
  ] as const) assert.throws(() => applyOps(tl, [op as never], c), re as RegExp, JSON.stringify(op));
  const t2 = applyOps(tl, ['trim c1 out=100', 'fx zoomin c1'], c);
  assert.equal(t2.tl.clips[0]!.out, 10);
  assert.match(t2.notes[0]!, /clamped to media end/);
  const lastKey = (t2.tl.clips[0]!.fx![0] as { keys: { t: number }[] }).keys.at(-1)!.t;
  assert.ok(lastKey <= 10, `later ops see the clamped range (last key ${lastKey})`);
  const img = applyOps(emptyTimeline(), ['add i0 in=5'], c).tl;
  assert.deepEqual(ranges(img), [[5, 8]]);
});

test('B8b/B12: set validates per kind; clips take gain and mute', () => {
  const tl = emptyTimeline(); tl.clips.push(newClip(tl, 'v1', 0, 4));
  const r = applyOps(tl, ['sfx whoosh 1', 'broll v2 1 2'], ctx()).tl;
  const sfx = r.sfx[0]!.id, broll = r.broll[0]!.id;
  assert.throws(() => applyOps(r, [`set ${sfx} vol=100000`], ctx()), /<= 12/);
  assert.throws(() => applyOps(r, [`set ${sfx} d=2`], ctx()), /do not apply to sfx/);
  assert.throws(() => applyOps(r, [{ op: 'set', id: broll, props: { a: 1 } }], ctx()), /do not apply to broll/);
  const g = applyOps(r, ['set c1 gain=0.5 mute=true'], ctx());
  assert.equal(g.tl.clips[0]!.vol, 0.5);
  assert.equal(g.tl.clips[0]!.mute, true);
  assert.throws(() => applyOps(r, ['set c1 z=2'], ctx()), /do not apply to clips/);
});
