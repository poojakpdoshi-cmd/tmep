import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ease, EASES, sampleKeys, parseKeys, parsePoints, presetKeys, fxSummary, shiftFx, type FxMask, type FxTransform, type Effect } from '../src/effects.ts';
import { emptyTimeline, newClip, type Clip } from '../src/timeline.ts';
import { applyOps } from '../src/ops.ts';
import { TmepError } from '../src/errors.ts';

const ctx = () => ({ transcripts: {}, assets: { v1: { dur: 10, kind: 'video' } } });
const isInput = (e: unknown) => e instanceof TmepError && e.code === 'E_INPUT';

test('easings hit their endpoints and stay monotone where expected', () => {
  for (const e of EASES) {
    assert.ok(Math.abs(ease(e, 0)) < 1e-9, e);
    assert.ok(Math.abs(ease(e, 1) - 1) < 1e-9, e);
  }
  assert.equal(ease('io', 0.5), 0.5);
  assert.ok(ease('in', 0.3) < 0.3 && ease('out', 0.3) > 0.3);
  assert.ok(Math.max(...[0.6, 0.7, 0.8, 0.9].map((p) => ease('back', p))) > 1, 'back overshoots');
  assert.equal(ease('hold', 0.99), 0);
});

test('keyframes: compact parsing, sorting, interpolation and clamping', () => {
  const keys = parseKeys('1:s=1.2,o=1,e=linear; 0:s=1,o=0');
  assert.deepEqual(keys.map((k) => k.t), [0, 1]);
  assert.equal(sampleKeys(keys, 's', -1), 1);
  assert.ok(Math.abs(sampleKeys(keys, 's', 0.5) - 1.1) < 1e-9);
  assert.equal(sampleKeys(keys, 'o', 5), 1);
  assert.equal(sampleKeys(keys, 'r', 0.5), 0, 'unset prop uses default');
  // properties are interpolated independently between the keys that set them
  const k2 = parseKeys([{ t: 0, x: 0 }, { t: 1, s: 2 }, { t: 2, x: 1, e: 'linear' }]);
  assert.ok(Math.abs(sampleKeys(k2, 'x', 1) - 0.5) < 1e-9);
  assert.equal(sampleKeys(k2, 's', 0), 2);
  assert.throws(() => parseKeys('0:s=1;0:s=2'), isInput);
  assert.throws(() => parseKeys('0:q=1'), isInput);
  assert.throws(() => parseKeys('0:o=2'), isInput);
  assert.throws(() => parseKeys('0:s=1,e=wobble'), isInput);
});

test('poly masks must be convex', () => {
  assert.equal(parsePoints('0.2,0.2 0.8,0.2 0.5,0.8').length, 3);
  assert.throws(() => parsePoints('0,0 1,0 0.5,0.2 1,1 0,1'), isInput);
  assert.throws(() => parsePoints('0,0 0.5,0.5 1,1'), isInput);
});

test('motion presets compile to keyframes; pans never expose the frame edge', () => {
  const zi = presetKeys('zoomin', 0, 2, undefined, undefined);
  assert.equal(sampleKeys(zi, 's', 0), 1);
  assert.equal(sampleKeys(zi, 's', 2), 1.15);
  assert.equal(sampleKeys(presetKeys('pull', 0, 2, 0.1, undefined), 's', 2), 1);
  for (const k of ['panleft', 'panright', 'panup', 'pandown'] as const) {
    const keys = presetKeys(k, 0, 3, 0.2, undefined);
    for (let t = 0; t <= 3; t += 0.25) {
      const s = sampleKeys(keys, 's', t);
      assert.ok(Math.abs(sampleKeys(keys, 'x', t)) <= (s - 1) / 2 + 1e-9 && Math.abs(sampleKeys(keys, 'y', t)) <= (s - 1) / 2 + 1e-9, `${k}@${t}`);
    }
  }
  assert.ok(sampleKeys(presetKeys('panleft', 0, 1, 0.2, undefined), 'x', 1) < 0, 'panleft moves image left');
});

test('fx op: compact strings add, compose and clear effects; older clips have no fx', () => {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0, 4), newClip(tl, 'v1', 5, 7));
  assert.equal(tl.clips[0]!.fx, undefined);
  const r = applyOps(tl, ['fx zoomin c1 d=1.5 amt=0.2', 'fx kf c1 keys="0:o=0;0.4:o=1,e=out"', 'fx mask c1 shape=ellipse w=0.6 h=0.4 feather=0.05 reveal=0.6', 'fx push'], ctx());
  const c1 = r.tl.clips[0]!;
  assert.equal(c1.fx!.length, 4);
  assert.equal(fxSummary(c1.fx), 'kf2 kf2 mask:ellipse+rv kf2');
  const m = c1.fx![2] as FxMask;
  assert.deepEqual(m.reveal, { at: 0, d: 0.6, e: 'out', from: 'center' });
  // push over the whole clip by default
  assert.equal(r.tl.clips[1]!.fx![0]!.type === 'kf' && r.tl.clips[1]!.fx![0]!.keys[1]!.t, 2);
  const poly = applyOps(r.tl, ['fx mask c2 shape=poly pts="0.1,0.1 0.9,0.1 0.5,0.9" invert=true'], ctx());
  assert.equal((poly.tl.clips[1]!.fx![1] as FxMask).pts!.length, 3);
  const cleared = applyOps(poly.tl, ['fx clear c1'], ctx());
  assert.equal(cleared.tl.clips[0]!.fx, undefined);
  assert.throws(() => applyOps(tl, ['fx kf c1'], ctx()));
  assert.throws(() => applyOps(tl, ['fx mask c1 shape=poly pts="0,0 1,0 0.5,0.2 1,1 0,1"'], ctx()));
});

test('split continuity: cuts re-time effects per part (speed-aware) without shared references', () => {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0, 8));
  tl.clips[0]!.speed = 2; // 4 s on the timeline
  const r = applyOps(tl, ['fx kf c1 keys="0:s=1,o=0;3:s=1.4,o=1,e=io"', 'fx mask c1 shape=ellipse reveal=2 at=0.5 e=out'], ctx());
  const orig = r.tl.clips[0]!;
  // remove source 3..4 (timeline 1.5..2.0): right part starts at source 4 = original clip time 2.0
  const cut = applyOps(r.tl, ['cut 1.5 2'], ctx()).tl;
  assert.equal(cut.clips.length, 2);
  const [L, R] = cut.clips as [Clip, Clip];
  const kf = (c: Clip) => (c.fx![0] as FxTransform).keys;
  const dt = 2;
  for (const t of [0, 0.3, 0.75, 1.2, 1.49]) for (const p of ['s', 'o'] as const) assert.equal(sampleKeys(kf(L), p, t), sampleKeys(kf(orig), p, t), `left ${p}@${t}`);
  for (const t of [0, 0.2, 0.5, 0.99, 1.5, 3]) for (const p of ['s', 'o'] as const) assert.ok(Math.abs(sampleKeys(kf(R), p, t) - sampleKeys(kf(orig), p, t + dt)) < 1e-9, `right ${p}@${t}`);
  // an in-progress eased segment continues mid-curve (not restarted, not jumped to the end)
  const s0 = sampleKeys(kf(R), 's', 0);
  assert.ok(s0 > 1 && s0 < 1.4);
  assert.equal((R.fx![1] as FxMask).reveal!.at, -1.5);
  assert.equal((L.fx![1] as FxMask).reveal!.at, 0.5);
  // independent copies
  assert.notEqual(L.fx, R.fx);
  assert.notEqual(L.fx![0], orig.fx![0]);
  kf(L)[0]!.s = 9;
  assert.equal(kf(R)[0]!.s, 1);
  assert.equal(kf(orig)[0]!.s, 1);
});

test('split continuity: pure re-timing via shiftFx and trimming the head', () => {
  const fx: Effect[] = [{ type: 'kf', keys: presetKeys('zoomin', 0, 2, 0.2, 'linear') }];
  const sh = shiftFx(fx, 0.5)!;
  assert.ok(Math.abs(sampleKeys((sh[0] as FxTransform).keys, 's', 0) - 1.05) < 1e-9);
  assert.equal((fx[0] as FxTransform).keys[0]!.t, 0, 'input untouched');
  assert.equal(shiftFx(undefined, 1), undefined);
  // cutting the start of a clip keeps the remaining part's effect state
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0, 4));
  const r = applyOps(tl, ['fx zoomin c1 d=4 amt=0.4 e=linear', 'cut 0 1'], ctx()).tl;
  assert.equal(r.clips.length, 1);
  assert.ok(Math.abs(sampleKeys((r.clips[0]!.fx![0] as FxTransform).keys, 's', 0) - 1.1) < 1e-9);
  // clips without fx stay without fx
  const plain = applyOps(tl, ['cut 1 2'], ctx()).tl;
  assert.ok(plain.clips.every((c) => c.fx === undefined));
});
