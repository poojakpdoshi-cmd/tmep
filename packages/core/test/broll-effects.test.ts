import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTimeline, newClip } from '../src/timeline.ts';
import { applyOps } from '../src/ops.ts';
import { type FxTransform, type FxMask } from '../src/effects.ts';

const ctx = { transcripts: {}, assets: { v1: { dur: 5, kind: 'video' }, i1: { dur: 5, kind: 'image' } } };

test('fx targets explicit b-roll ids while legacy untargeted fx remains main-track only', () => {
  const initial = emptyTimeline('1:1', 10);
  initial.clips.push(newClip(initial, 'v1', 0, 2));
  const withB = applyOps(initial, ['broll i1 0.2 1.5'], ctx).tl;
  const id = withB.broll[0]!.id;
  const result = applyOps(withB, [
    `fx zoomin ${id} amt=0.2`,
    `fx mask ${id} shape=ellipse w=0.7 feather=0.03 reveal=0.5`,
    `fx kf ${id} keys="0:o=0;0.5:o=1,e=linear"`,
  ], ctx).tl;
  assert.equal(result.broll[0]!.fx!.length, 3);
  assert.equal((result.broll[0]!.fx![0] as FxTransform).keys[1]!.t, 1.5, 'preset defaults to b-roll duration');
  assert.equal((result.broll[0]!.fx![1] as FxMask).reveal!.d, 0.5);
  assert.equal(result.clips[0]!.fx, undefined);
  assert.equal(withB.broll[0]!.fx, undefined, 'operations are immutable');

  const defaulted = applyOps(result, ['fx panleft'], ctx).tl;
  assert.equal(defaulted.clips[0]!.fx!.length, 1);
  assert.equal(defaulted.broll[0]!.fx!.length, 3);
  const cleared = applyOps(defaulted, [`fx clear ${id}`], ctx).tl;
  assert.equal(cleared.broll[0]!.fx, undefined);
  assert.equal(cleared.clips[0]!.fx!.length, 1);
});

test('unknown fx target errors without modifying the input timeline', () => {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0, 2));
  assert.throws(() => applyOps(tl, ['fx zoomin b999'], ctx), /no clip or b-roll/);
  assert.equal(tl.clips[0]!.fx, undefined);
});
