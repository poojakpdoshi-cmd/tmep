/**
 * Phase 4A motion engine: easing parity, path geometry, morphing, motion paths, kinetic text,
 * reveals, 2.5D depth and motion blur — verified on rasterized pixels, not just on data.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOps, emptyTimeline, newClip, ease, EASES } from '../../core/src/index.ts';
import { easeExpr } from '../../render/src/effects.ts';
import { compileScenes } from '../src/scene.ts';
import { canvasModule, drawVectorFrame, type VectorRun } from '../src/vector.ts';
import { flattenPath, prepareMorph, pointAt, resample, motionPolyline } from '../src/paths.ts';

const assets = { v1: { kind: 'video', dur: 5 } };
const media = new Map(Object.entries(assets));
function compile(layers: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const tl = emptyTimeline();
  tl.clips = [newClip(tl, 'v1', 0, 5)];
  const spec = { v: 1, at: 0, duration: 2, layers, ...extra };
  return compileScenes(applyOps(tl, [{ op: 'scene', spec }], { assets, transcripts: {} }).tl, [], media);
}

const W = 270, H = 480; // quarter of 1080 × 1920
function frame(run: VectorRun, f: number) {
  const { createCanvas, Path2D } = canvasModule();
  const c = createCanvas(W, H).getContext('2d');
  drawVectorFrame(c, run, f, W / run.w, run.layers.map((l) => (l.d ? new Path2D(l.d) : undefined)));
  return c.getImageData(0, 0, W, H).data;
}
/** Centroid and coverage of pixels whose alpha exceeds `thr`. */
function ink(px: Uint8ClampedArray, thr = 128) {
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3]! > thr) { n++; sx += x; sy += y; }
  return { n, x: n ? sx / n : NaN, y: n ? sy / n : NaN };
}
const partial = (px: Uint8ClampedArray) => { let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i]! > 20 && px[i]! < 235) n++; return n; };

test('every easing curve has identical JS and FFmpeg-expression forms', () => {
  const fns = { pow: Math.pow, exp: Math.exp, sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt,
    iff: (c: number, a: number, b: number) => (c ? a : b), lt: (a: number, b: number) => +(a < b), lte: (a: number, b: number) => +(a <= b), gte: (a: number, b: number) => +(a >= b) };
  for (const e of EASES) {
    if (e === 'hold') continue;
    const src = easeExpr(e, 'P').replace(/\bif\(/g, 'iff(').replace(/\bPI\b/g, 'Math.PI');
    const f = new Function(...Object.keys(fns), 'P', `return ${src};`) as (...a: unknown[]) => number;
    for (let i = 0; i <= 20; i++) {
      const p = i / 20;
      assert.ok(Math.abs(f(...Object.values(fns), p) - ease(e, p)) < 1e-9, `${e} at ${p}: expr ${f(...Object.values(fns), p)} vs js ${ease(e, p)}`);
    }
    assert.ok(Math.abs(ease(e, 0)) < 1e-9 && Math.abs(ease(e, 1) - 1) < 1e-9, `${e} must start at 0 and end at 1`);
  }
});

test('SVG paths flatten (lines, curves, arcs, relative commands) and resample by arc length', () => {
  const sq = flattenPath('M0 0 H10 V10 H0 Z');
  assert.equal(sq.length, 1);
  assert.ok(sq[0]!.closed);
  const circle = flattenPath('M50 0 A50 50 0 1 1 50 100 A50 50 0 1 1 50 0 Z')[0]!;
  for (const p of circle.pts) assert.ok(Math.abs(Math.hypot(p[0] - 50, p[1] - 50) - 50) < 0.5, `arc point off the circle: ${p}`);
  const rel = flattenPath('m10 10 l10 0 c0 5 0 5 -10 10 z')[0]!;
  assert.deepEqual(rel.pts[1], [20, 10]);
  const r = resample(sq[0]!, 8);
  assert.deepEqual(r.map((p) => p.map((v) => Math.round(v * 100) / 100)), [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]]);
  const line = motionPolyline('M0 0 L100 0');
  assert.deepEqual(pointAt(line, 0.25).pt, [25, 0]);
  assert.throws(() => flattenPath('M0 0 X5 5'), /unsupported|number/);
});

test('morph preparation aligns shapes with different structure and winding', () => {
  const [a, b] = prepareMorph(['M0 0 H100 V100 H0 Z', 'M50 0 A50 50 0 1 0 50 100 A50 50 0 1 0 50 0 Z']);
  assert.equal(a!.subs[0]!.pts.length, b!.subs[0]!.pts.length);
  // after start alignment, corresponding points are near each other (no criss-crossing)
  const maxGap = Math.max(...a!.subs[0]!.pts.map((p, i) => Math.hypot(p[0] - b!.subs[0]!.pts[i]![0], p[1] - b!.subs[0]!.pts[i]![1])));
  assert.ok(maxGap < 40, `max correspondence distance ${maxGap.toFixed(1)}`);
  const [c, d] = prepareMorph(['M0 0 H10 V10 Z', 'M0 0 H10 V10 Z M20 20 H30 V30 Z']);
  assert.equal(c!.subs.length, d!.subs.length, 'subpath counts are equalized');
});

test('a morphing path renders the base shape at t=0 and the target shape at its key time', () => {
  const out = compile([{ id: 'm', kind: 'path', x: .5, y: .5, w: .5, h: .28125, stroke: 0, fill: '#FFFFFF',
    d: 'M10 10 H90 V90 H10 Z', morph: [{ t: 1, d: 'M50 10 L90 90 L10 90 Z', e: 'linear' }] }]);
  const run = out.vectors[0]!;
  const sq = ink(frame(run, 0)), tri = ink(frame(run, 30)), mid = ink(frame(run, 15));
  assert.ok(tri.n < sq.n * 0.62 && tri.n > sq.n * 0.38, `triangle ≈ half the square: ${tri.n} vs ${sq.n}`);
  assert.ok(mid.n < sq.n && mid.n > tri.n, `mid-morph area between: ${mid.n}`);
  assert.ok(tri.y > sq.y + 2, 'the triangle centroid sits lower than the square centroid');
});

test('a layer follows its motion path (frame-fraction coordinates) with eased progress', () => {
  const out = compile([{ id: 'dot', kind: 'rect', x: .5, y: .5, w: .04, h: .0225, fill: '#FFFFFF',
    motionPath: { d: 'M0.2 0.3 L0.8 0.3 L0.8 0.7', keys: [{ t: 0, p: 0 }, { t: 2, p: 1, e: 'linear' }] } }]);
  const run = out.vectors[0]!;
  const a = ink(frame(run, 0)), b = ink(frame(run, 30)), c = ink(frame(run, 59));
  assert.ok(Math.abs(a.x / W - 0.2) < 0.02 && Math.abs(a.y / H - 0.3) < 0.02, `start ${a.x / W},${a.y / H}`);
  // halfway along the arc length (0.6 + 0.4 long): at x=0.8 - 0.1, y=0.3 → actually (0.7, 0.3)
  assert.ok(Math.abs(b.x / W - 0.7) < 0.03 && Math.abs(b.y / H - 0.3) < 0.02, `middle ${b.x / W},${b.y / H}`);
  assert.ok(Math.abs(c.x / W - 0.8) < 0.02 && c.y / H > 0.66, `end ${c.x / W},${c.y / H}`);
});

test('kinetic text: units stagger in and the settled frame equals static text pixel for pixel', () => {
  const style = { styles: [{ id: 'h', size: 96, font: 'bold' }] };
  const base = { id: 't', kind: 'text', text: 'Frame by frame', style: 'h', x: .5, y: .5, w: .9, h: .1, render: 'canvas' };
  const anim = compile([{ ...base, anim: { by: 'char', stagger: 0.03, d: 0.4, e: 'expo', from: { o: 0, y: 0.6 } } }], style).vectors[0]!;
  const stat = compile([base], style).vectors[0]!;
  const start = ink(frame(anim, 0)), early = ink(frame(anim, 6)), still = frame(stat, 59);
  assert.equal(start.n, 0, 'nothing is visible before the first unit starts');
  assert.ok(early.n > 0 && early.x < W * 0.45, `early frame shows only the leading characters (x=${early.x})`);
  // Word units settle exactly on the static layout.
  const words = frame(compile([{ ...base, anim: { by: 'word', stagger: 0.1, d: 0.4, from: { o: 0, y: 1 } } }], style).vectors[0]!, 59);
  let diff = 0;
  for (let i = 0; i < words.length; i++) diff = Math.max(diff, Math.abs(words[i]! - still[i]!));
  assert.equal(diff, 0, `settled word animation must equal static text (max channel diff ${diff})`);
  // Character units keep kerning; only sub-pixel anti-aliasing may differ (no glyph displaced).
  const chars = frame(anim, 59);
  const a = ink(chars, 40), b = ink(still, 40);
  let differing = 0;
  for (let i = 3; i < chars.length; i += 4) if (Math.abs(chars[i]! - still[i]!) > 64) differing++;
  assert.ok(Math.abs(a.x - b.x) < 0.3 && Math.abs(a.n - b.n) / b.n < 0.02, `char layout matches: centroid ${a.x.toFixed(2)} vs ${b.x.toFixed(2)}, ink ${a.n} vs ${b.n}`);
  assert.ok(differing / b.n < 0.03, `char anti-aliasing differences ${differing}/${b.n}`);
});

test('a left reveal shows only the left part of the layer mid-way', () => {
  const run = compile([{ id: 'r', kind: 'rect', x: .5, y: .5, w: .8, h: .2, fill: '#FFFFFF', reveal: { from: 'left', at: 0, d: 1, e: 'linear' } }]).vectors[0]!;
  const half = ink(frame(run, 15)), full = ink(frame(run, 45));
  assert.ok(Math.abs(half.n / full.n - 0.5) < 0.06, `half revealed: ${half.n}/${full.n}`);
  assert.ok(half.x < full.x - W * 0.15, 'revealed part is on the left');
});

test('2.5D depth: under a camera pan a deep layer moves less (parallax)', () => {
  const layers = [
    { id: 'near', kind: 'rect', x: .3, y: .3, w: .1, h: .05625, fill: '#FFFFFF', render: 'canvas' },
    { id: 'far', kind: 'rect', x: .3, y: .7, w: .1, h: .05625, fill: '#FFFFFF', depth: 3 },
  ];
  const cam = { camera: [{ t: 0, x: 0 }, { t: 1.9, x: 0.2, e: 'linear' }] };
  const run = compile(layers, cam).vectors[0]!;
  const top = (px: Uint8ClampedArray) => { const c = px.slice(0, (H / 2) * W * 4); let n = 0, s = 0; for (let i = 0; i < c.length / 4; i++) if (c[i * 4 + 3]! > 128) { n++; s += i % W; } return s / n; };
  const bottom = (px: Uint8ClampedArray) => { const c = px.slice((H / 2) * W * 4); let n = 0, s = 0; for (let i = 0; i < c.length / 4; i++) if (c[i * 4 + 3]! > 128) { n++; s += i % W; } return s / n; };
  const f0 = frame(run, 0), f1 = frame(run, 59);
  const nearMove = top(f1) - top(f0), farMove = bottom(f1) - bottom(f0);
  assert.ok(nearMove > 0 && farMove > 0, 'both move with the camera');
  assert.ok(Math.abs(farMove / nearMove - 0.25) < 0.05, `depth 3 moves 1/(1+3) as far: ${farMove.toFixed(1)} vs ${nearMove.toFixed(1)}`);
});

test('motion blur smears a fast-moving layer and leaves a static frame sharp', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { rasterizeVectorRun } = await import('../src/vector.ts');
  const { loadImage, createCanvas } = canvasModule();
  const mover = { id: 'b', kind: 'rect', x: .5, y: .5, w: .05, h: .1, fill: '#FFFFFF', keys: [{ t: 0, x: -.3 }, { t: 1.9, x: .3, e: 'linear' }] };
  const still = { id: 's', kind: 'rect', x: .5, y: .2, w: .05, h: .05, fill: '#FFFFFF', render: 'canvas' };
  const blurred = compile([mover, still], { mblur: { samples: 6, shutter: 1 } }).vectors[0]!;
  const sharp = compile([{ ...mover, render: 'canvas' }, still]).vectors[0]!;
  assert.ok(blurred.mblur?.samples === 6 && blurred.layers.some((l) => l.id === 'b'), 'moving rect is routed to Canvas with motion blur');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'frame-mblur-'));
  try {
    const px = async (run: VectorRun, name: string) => {
      await rasterizeVectorRun(run, W, H, path.join(dir, name));
      const img = await loadImage(await readFile(path.join(dir, name, '00030.png')));
      const c = createCanvas(W, H).getContext('2d');
      c.drawImage(img, 0, 0);
      return c.getImageData(0, 0, W, H).data;
    };
    const a = await px(sharp, 'sharp'), b = await px(blurred, 'blur');
    const band = (d: Uint8ClampedArray, y0: number, y1: number) => partial(d.slice(y0 * W * 4, y1 * W * 4));
    assert.ok(band(b, 220, 260) > band(a, 220, 260) * 3, `moving rect is smeared: ${band(b, 220, 260)} vs ${band(a, 220, 260)} partial pixels`);
    assert.ok(band(b, 80, 110) <= band(a, 80, 110) + 2, 'the static rect stays sharp');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
