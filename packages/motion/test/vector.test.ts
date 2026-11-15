import assert from 'node:assert/strict';
import { readdir, readFile, rm, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyOps, emptyTimeline, newClip, sampleKeys } from '../../core/src/index.ts';
import { compileScenes, diagnoseScenes } from '../src/scene.ts';
import { canvasModule, drawRange, drawVectorFrame, rasterizeVectorRun } from '../src/vector.ts';

const assets = { v1: { kind: 'video', dur: 5 } };
const media = new Map(Object.entries(assets));
// A square box in reference pixels (216 × 216 on 1080 × 1920) that the path fills exactly.
const square = { kind: 'path', x: .3, y: .3, w: .2, h: .1125, d: 'M0 0 H100 V100 H0 Z', stroke: 0, fill: '#FF0000' };

function timeline(spec: Record<string, unknown>) {
  const tl = emptyTimeline();
  tl.clips = [newClip(tl, 'v1', 0, 5)];
  return applyOps(tl, [{ op: 'scene', spec }], { assets, transcripts: {} }).tl;
}
const compile = (layers: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  compileScenes(timeline({ v: 1, at: 1, duration: 2, layers, ...extra }), [], media);
const diagnose = (layers: Record<string, unknown>[]) =>
  diagnoseScenes(timeline({ v: 1, at: 1, duration: 2, layers }), [], media).issues.map((i) => `${i.code}:${i.layers.join()}`);

test('consecutive path layers share one raster run, ordered between ASS layers', () => {
  const out = compile([
    { ...square, id: 'a', start: .5 },
    { ...square, id: 'b', y: .6, end: 1.5 },
    { id: 'c', kind: 'rect', x: .7, y: .8, w: .1, h: .05 },
    { ...square, id: 'd', x: .7, y: .3 },
  ]);
  assert.equal(out.layers.length, 1);
  assert.deepEqual(out.vectors.map((v) => v.layers.map((l) => l.id)), [['a', 'b'], ['d']]);
  const [first, second] = out.vectors;
  // The run spans the union of its layers: b starts at 1 s, a ends at the scene end (3 s).
  assert.deepEqual([first!.at, first!.d, first!.frames, first!.sceneFrame], [1, 2, 60, 0]);
  assert.deepEqual(first!.layers.map((l) => [l.from, l.to]), [[15, 60], [0, 45]]);
  assert.ok(first!.z < out.layers[0]!.z && out.layers[0]!.z < second!.z);
  assert.deepEqual(first!.layers[0]!.box, [216, 216]);
  assert.equal(first!.layers[0]!.fill, '#FF0000');
});

test('path data, view bounds and draw keys are validated', () => {
  assert.throws(() => compile([{ ...square, id: 'p', d: 'M0 0 Q 1' }]), /invalid SVG path data/);
  assert.throws(() => compile([{ ...square, id: 'p', d: 'L 1 1' }]), /must match/);
  assert.throws(() => compile([{ ...square, id: 'p', dash: 4 }]), /dash/);
  assert.throws(() => compile([{ ...square, id: 'p', draw: [{ t: 0 }] }]), /neither from nor to/);
  assert.throws(() => compile([{ ...square, id: 'p', draw: [{ t: 3, to: 1 }] }]), /inside the active interval/);
  assert.deepEqual(diagnose([{ ...square, id: 'p', d: 'M0 0 H120 V100 H0 Z' }]), ['clipping:p']);
  assert.deepEqual(diagnose([{ ...square, id: 'p', draw: [{ t: 0, to: 0 }, { t: 1, to: 1, e: 'hold' }] }]), ['discontinuity:p']);
  // Minified SVG arc flags and a custom view are accepted.
  assert.equal(compile([{ ...square, id: 'p', view: { w: 24, h: 24 }, d: 'M10 10a2 2 0 01-2 2' }]).vectors.length, 1);
});

test('draw keys default to fully drawn and reuse the shared easing', () => {
  assert.deepEqual(drawRange([], 3), [0, 1]);
  const keys = [{ t: 0, to: 0 }, { t: 1, to: 1, e: 'linear' as const }];
  assert.deepEqual(drawRange(keys, .25), [0, .25]);
  assert.deepEqual(drawRange([{ t: 0, from: 0, to: .2 }, { t: 1, from: .8, to: 1 }], 2), [.8, 1]);
});

test('raster geometry matches the validator transform at every sampled frame', () => {
  const out = compile([{ ...square, id: 'p', rotation: 10,
    keys: [{ t: 0, x: 0, s: .8, r: 0 }, { t: 1.5, x: .1, s: 1.2, r: 30, e: 'io' }] }],
  { camera: [{ t: 0, s: 1 }, { t: 1.9, s: 1.1, x: -.05, r: 5 }] });
  const run = out.vectors[0]!;
  const W = 540, H = 960, scale = W / run.w;
  const { createCanvas, Path2D } = canvasModule();
  const ctx = createCanvas(W, H).getContext('2d');
  const shapes = [new Path2D(run.layers[0]!.d)];
  const keys = run.layers[0]!.keys;
  for (const f of [0, 20, 45, 59]) {
    drawVectorFrame(ctx, run, f, scale, shapes);
    const { data } = ctx.getImageData(0, 0, W, H);
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (data[4 * (y * W + x) + 3]! < 128) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    // Independent statement of the validator's composition: layer about its centre, then camera about the frame centre.
    const t = f / 30;
    const at = (k: typeof keys, p: 'x' | 'y' | 's' | 'r') => sampleKeys(k, p, t);
    const rot = (x: number, y: number, deg: number, s: number) => {
      const a = deg * Math.PI / 180;
      return [(x * Math.cos(a) - y * Math.sin(a)) * s, (x * Math.sin(a) + y * Math.cos(a)) * s];
    };
    const pts = [[-108, -108], [108, -108], [108, 108], [-108, 108]].map(([x, y]) => {
      const [lx, ly] = rot(x!, y!, at(keys, 'r'), at(keys, 's'));
      const [cx, cy] = rot(lx! + at(keys, 'x') * 1080, ly! + at(keys, 'y') * 1920, at(run.camera, 'r'), at(run.camera, 's'));
      return [(cx! + at(run.camera, 'x') * 1080 + 540) * scale, (cy! + at(run.camera, 'y') * 1920 + 960) * scale];
    });
    const ex = [Math.min(...pts.map((p) => p[0]!)), Math.max(...pts.map((p) => p[0]!)),
      Math.min(...pts.map((p) => p[1]!)), Math.max(...pts.map((p) => p[1]!))];
    [x0, x1 + 1, y0, y1 + 1].forEach((v, i) => assert.ok(Math.abs(v - ex[i]!) <= 1.5, `frame ${f}: bbox ${[x0, x1 + 1, y0, y1 + 1]} vs ${ex.map((e) => e.toFixed(1))}`));
  }
});

test('rasterizing is deterministic and reuses bytes for held frames', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmep-vector-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = compile([{ ...square, id: 'p', stroke: 6, glow: 8, fill: undefined, d: 'M10 10 C 40 90 60 10 90 90',
    draw: [{ t: 0, to: 0 }, { t: .5, to: 1, e: 'out' }] }]).vectors[0]!;
  const a = await rasterizeVectorRun(run, 270, 480, path.join(dir, 'a'));
  const b = await rasterizeVectorRun(run, 270, 480, path.join(dir, 'b'));
  const files = await readdir(path.join(dir, 'a'));
  assert.equal(files.length, 60);
  assert.ok(a.encoded < 20 && a.encoded === b.encoded, `held frames reuse encoded bytes: ${a.encoded}`);
  for (const file of files) assert.deepEqual(await readFile(path.join(dir, 'a', file)), await readFile(path.join(dir, 'b', file)), file);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(rasterizeVectorRun(run, 270, 480, path.join(dir, 'c'), ac.signal), /cancelled/);
});

test('layer opacity applies to the whole layer, including fill under stroke and glow', () => {
  const { createCanvas, Path2D } = canvasModule();
  const pixels = (opacity: number) => {
    const run = compile([{ ...square, id: 'p', style: 'green', stroke: 20, glow: 10, opacity }],
      { styles: [{ id: 'green', color: '#00FF00' }] }).vectors[0]!;
    const ctx = createCanvas(540, 960).getContext('2d');
    drawVectorFrame(ctx, run, 0, .5, [new Path2D(run.layers[0]!.d)]);
    const px = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
    // Box edge at x = 108 output px; stroke half-width 5 px; glow outside the stroke.
    return { strokeOverFill: px(110, 288), halo: px(101, 288) };
  };
  const full = pixels(1), half = pixels(.5);
  assert.deepEqual(full.strokeOverFill.slice(0, 3), [0, 255, 0]);
  // Group opacity: the stroke hides the fill below it, so no red shows through at 50 %.
  assert.ok(half.strokeOverFill[0]! < 8 && half.strokeOverFill[1]! > 247, `stroke over fill: ${half.strokeOverFill}`);
  assert.ok(Math.abs(half.strokeOverFill[3]! - 128) <= 2, `stroke alpha: ${half.strokeOverFill}`);
  assert.ok(full.halo[3]! > 10, `glow visible: ${full.halo}`);
  assert.ok(Math.abs(half.halo[3]! - full.halo[3]! / 2) <= 2, `glow fades with the layer: ${half.halo[3]} vs ${full.halo[3]}`);
});
