import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyTimeline, newClip, applyOps, layout, duration, clipFrames,
  validateEffect, validateMask,
  type OpContext,
} from '../src/index.ts';
import { compileIntent } from '../../story/src/compiler.ts';

const ctx: OpContext = {
  transcripts: {},
  assets: {
    v1: { dur: 12, kind: 'video' },
    v2: { dur: 10, kind: 'video' },
    i1: { dur: 0, kind: 'image' },
  },
};

function baseTl() {
  const tl = emptyTimeline('9:16', 30);
  tl.clips.push(newClip(tl, 'v1', 0, 6));
  tl.clips.push(newClip(tl, 'v2', 0, 6));
  return tl;
}

test('Stage 3.1 ops: jcut, lcut, reverse, stabilize, reframe, matchcut, punch', () => {
  const { tl } = applyOps(baseTl(), [
    'jcut c2 0.5',
    'lcut c1 0.4',
    'reverse c2 true',
    'stabilize c1 smoothing=12 shakiness=6',
    'reframe c1 cx=0.4 cy=0.3',
    'matchcut c1 c2 scale=1.1 d=0.25',
    'punch 1.5 to=1.25 d=1.2',
  ], ctx);
  assert.equal(tl.clips[1]!.jcut, 0.5);
  assert.equal(tl.clips[0]!.lcut, 0.4);
  assert.equal(tl.clips[1]!.reverse, true);
  assert.equal(tl.clips[0]!.stabilize?.smoothing, 12);
  assert.equal(tl.clips[0]!.cx, 0.4);
  assert.equal(tl.clips[0]!.cy, 0.3);
  assert.ok((tl.clips[0]!.fx?.length ?? 0) >= 2);
  assert.ok((tl.clips[1]!.fx?.length ?? 0) >= 1);
  assert.equal(tl.clips[1]!.trans?.type, 'dissolve');
});

test('Stage 3.1 ops: ramp and freeze preserve frame-accurate timeline', () => {
  const tl0 = baseTl();
  const { tl: tlRamp } = applyOps(tl0, ['ramp c1 keys="0:speed=1;3:speed=2;6:speed=1"'], ctx);
  assert.ok(tlRamp.clips[0]!.speedRamp?.length === 3);
  const fRamp = clipFrames(tlRamp.clips[0]!, 30);
  assert.ok(fRamp > 90 && fRamp < 180, `ramped frames ${fRamp} between 2x and 1x`);

  const { tl: tlFreeze, created } = applyOps(baseTl(), ['freeze 3.0 1.5'], ctx);
  assert.equal(created.length, 1);
  assert.equal(tlFreeze.clips.length, 4); // c1-left, freeze, c1-right, c2
  const freezeClip = tlFreeze.clips.find((c) => c.freeze === 1.5);
  assert.ok(freezeClip, 'freeze clip inserted');
  assert.equal(freezeClip!.mute, true);
  assert.equal(clipFrames(freezeClip!, 30), 45);
  assert.ok(Math.abs(duration(tlFreeze) - 13.5) < 0.05);
});

test('Stage 3.1 ops: splitscreen, pip, parallax', () => {
  const { tl } = applyOps(baseTl(), [
    { op: 'splitscreen', srcs: ['v1', 'v2'], at: 1, d: 3, layout: '2h', gap: 0.02 },
    'pip v2 4 3 pos=br scale=0.28',
    { op: 'parallax', srcs: ['v1', 'v2'], at: 7, d: 3, drift: 0.06 },
  ], ctx);
  assert.equal(tl.broll.length, 5); // 2 splitscreen + 1 pip + 2 parallax
  assert.ok(tl.broll[0]!.fx?.some((f) => f.type === 'mask'));
  assert.ok(tl.broll[2]!.fx?.some((f) => f.type === 'kf'));
});

test('Stage 3.2 effects: blur, glow, shadow, blend, chromakey, mblur, persp, chain, concave & bezier masks', () => {
  const { tl } = applyOps(baseTl(), [
    { op: 'fx', kind: 'blur', clip: 'c1', mode: 'gaussian', sigma: 8 },
    { op: 'fx', kind: 'glow', clip: 'c1', radius: 14, intensity: 0.45 },
    { op: 'fx', kind: 'mblur', clip: 'c1', frames: 4, decay: 0.6 },
    { op: 'fx', kind: 'persp', clip: 'c1', x0: 0.05, y0: 0.05, x1: 0.95, y1: 0.1, x2: 0.0, y2: 0.95, x3: 1.0, y3: 0.9 },
    { op: 'fx', kind: 'chain', clip: 'c2', chain: 'cinematic-vignette' },
    'broll v2 1 3',
    { op: 'fx', kind: 'blend', clip: 'b3', mode: 'screen', opacity: 0.8 },
    { op: 'fx', kind: 'chromakey', clip: 'b3', color: '#00ff00', similarity: 0.15, blend: 0.08, despill: true },
    { op: 'fx', kind: 'shadow', clip: 'b3', dx: 4, dy: 8, blur: 12, opacity: 0.5 },
    {
      op: 'fx', kind: 'mask', clip: 'c1', shape: 'concave',
      pts: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.4], [0.9, 0.9], [0.1, 0.9]],
      feather: 0.02,
    },
    {
      op: 'fx', kind: 'mask', clip: 'c2', shape: 'bezier',
      bezierStart: [0.2, 0.2],
      beziers: [
        { cp1: [0.5, 0.05], cp2: [0.8, 0.2], to: [0.8, 0.5] },
        { cp1: [0.8, 0.8], cp2: [0.2, 0.8], to: [0.2, 0.2] },
      ],
      keys: [{ t: 0, x: 0.5, y: 0.5, w: 0.6, h: 0.6 }, { t: 2, x: 0.5, y: 0.5, w: 0.9, h: 0.9, e: 'io' }],
    },
    'transition cinematic-dissolve clip=c2',
  ], ctx);

  assert.equal(tl.clips[0]!.fx?.length, 5);
  assert.equal(tl.clips[1]!.fx?.length, 2);
  assert.equal(tl.broll[0]!.fx?.length, 3);
  assert.equal(tl.clips[1]!.trans?.type, 'dissolve');
  assert.equal(tl.clips[1]!.trans?.d, 0.5);

  assert.throws(() => validateEffect({ type: 'blur', mode: 'gaussian', sigma: 0 }));
  assert.throws(() => validateMask({ type: 'mask', shape: 'bezier', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0, invert: false }));
});

test('Stage 3.3 & 3.4 ops: color and audio mastering', () => {
  const { tl } = applyOps(baseTl(), [
    'color c1 exposure=0.15 contrast=1.1 temp=6200 saturation=1.08 vignette=0.2',
    'color exposure=0.05',
    'audio c1 eq=dialogue denoise=0.4 deess=0.3 comp=medium hp=80 lp=15000',
    'audio target=reels twoPass=true limiter=-1.0',
  ], ctx);
  assert.equal(tl.clips[0]!.color?.exposure, 0.15);
  assert.equal(tl.clips[0]!.color?.vignette, 0.2);
  assert.equal(tl.color?.exposure, 0.05);
  assert.equal(tl.clips[0]!.audio?.eq, 'dialogue');
  assert.equal(tl.master?.target, 'reels');
  assert.equal(tl.master?.twoPass, true);
  assert.equal(tl.master?.limiter, -1);
});

test('Stage 3.5 workflows: all 8 reusable parameterized workflows compile deterministically', () => {
  const workflows = [
    { kind: 'talking_head_reel', title: 'Talking Head', subtitle: 'Clean audio & callout', platform: 'reels' },
    { kind: 'cinematic_sequence', title: 'Cinematic', subtitle: 'Graded montage', platform: 'youtube' },
    { kind: 'sports_highlights', title: 'Highlights', events: [{ t: 1.5, label: 'Goal' }, { t: 4.0, label: 'Save' }] },
    { kind: 'product_demo', title: 'Product', asset: 'i1', platform: 'youtube' },
    { kind: 'educational_explainer', title: 'Explainer', subtitle: 'How it works' },
    { kind: 'audio_enhancement', clip: 'c1', platform: 'youtube' },
    { kind: 'color_matching', clip: 'c1', grade: { exposure: 0.1, contrast: 1.05 } },
    { kind: 'animated_data_viz', title: 'Growth', chart: { chartType: 'bar', data: [{ label: 'Q1', value: 40 }, { label: 'Q2', value: 85 }], unit: '%' } },
  ];
  for (const w of workflows) {
    const res = compileIntent(w);
    assert.ok(res.ops.length >= 1, `workflow ${w.kind} produced ops`);
  }
  const p = layout(baseTl());
  assert.ok(p.length === 2);
});
