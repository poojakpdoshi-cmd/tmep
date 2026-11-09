import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTimeline, newClip } from '../src/timeline.ts';
import { applyOps } from '../src/ops.ts';

const ctx = {
  transcripts: {},
  assets: { v1: { kind: 'video', dur: 10 }, v2: { kind: 'video', dur: 10 } },
  presets: ['title'],
};

test('overlay z-order is optional, integer, and editable through set', () => {
  const tl = emptyTimeline('1:1', 10);
  tl.clips.push(newClip(tl, 'v1', 0, 4));
  const a = applyOps(tl, [
    'broll v2 0 3 z=20',
    'gfx title 0 3 z=-10',
  ], ctx).tl;
  assert.equal(a.broll[0]!.z, 20);
  assert.equal(a.gfx[0]!.z, -10);
  const b = applyOps(a, [
    'set ' + a.broll[0]!.id + ' z=-5',
    'set ' + a.gfx[0]!.id + ' z=7',
  ], ctx).tl;
  assert.equal(b.broll[0]!.z, -5);
  assert.equal(b.gfx[0]!.z, 7);
  assert.equal(a.broll[0]!.z, 20, 'immutable revision');
  assert.equal(a.gfx[0]!.z, -10);
});

test('old b-roll and graphics have no z value until explicitly set', () => {
  const tl = emptyTimeline('1:1', 10);
  tl.clips.push(newClip(tl, 'v1', 0, 4));
  const a = applyOps(tl, ['broll v2 0 3', 'gfx title 0 3'], ctx).tl;
  assert.equal(a.broll[0]!.z, undefined);
  assert.equal(a.gfx[0]!.z, undefined);
});

test('invalid z values or targeting an sfx are rejected atomically', () => {
  const tl = emptyTimeline('1:1', 10);
  tl.clips.push(newClip(tl, 'v1', 0, 4));
  const a = applyOps(tl, ['broll v2 0 3'], ctx).tl;
  const b = a.broll[0]!;
  assert.throws(() => applyOps(a, ['set ' + b.id + ' z=1.5'], ctx));
  assert.throws(() => applyOps(a, ['set ' + b.id + ' z=101'], ctx));
  assert.equal(a.broll[0]!.z, undefined);
});
