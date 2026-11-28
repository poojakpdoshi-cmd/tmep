/**
 * Frame-level regression tests for animated concave/bezier masks in complete public-API renders.
 * Before Phase 4A the renderer rasterized these masks once at t=0, so keyed motion never appeared
 * in the video and a reveal stayed fully hidden. Each test decodes the encoded MP4 and measures
 * where the masked (bright) content actually is, frame by frame.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as api from '../../engine/src/api.ts';
import { ffmpegInfo } from '../../media/src/ffmpeg.ts';

const W = 320, H = 180;
let dir: string;
let white: string;
let skip: string | undefined;

before(async () => {
  try {
    const info = await ffmpegInfo();
    if (!info.encoders.has('libx264')) skip = 'ffmpeg lacks libx264';
  } catch {
    skip = 'ffmpeg not installed';
  }
  if (skip) return;
  dir = mkdtempSync(path.join(os.tmpdir(), 'frame-amask-'));
  white = path.join(dir, 'white.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=white:s=${W}x${H}:r=30:d=4`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '4', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', white]);
  assert.equal(r.status, 0, String(r.stderr));
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Mean luma of the left, middle and right thirds of the frame at time t (output resolution). */
function thirds(file: string, t: number, w: number, h: number): [number, number, number] {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, String(r.stderr));
  const px = r.stdout as Buffer;
  assert.equal(px.length, w * h);
  const sums = [0, 0, 0], counts = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = Math.min(2, Math.floor((x * 3) / w));
      sums[b]! += px[y * w + x]!;
      counts[b]!++;
    }
  }
  return sums.map((s, i) => s / counts[i]!) as [number, number, number];
}

// A concave chevron centred on (0.5, 0.5), about 0.24 of the frame wide.
const chevron: [number, number][] = [[0.38, 0.3], [0.62, 0.3], [0.55, 0.5], [0.62, 0.7], [0.38, 0.7], [0.45, 0.5]];

async function project(name: string) {
  const proj = path.join(dir, name);
  mkdirSync(proj, { recursive: true });
  const ctx = { project: proj, detail: 'standard' as const };
  await api.importMedia(ctx, { paths: [white] });
  return ctx;
}

test('animated concave mask keys move the mask in the rendered video', { timeout: 180_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ctx = await project('keys');
  await api.edit(ctx, {
    ratio: '16:9',
    ops: [
      { op: 'add', src: 'v1', in: 0, out: 3 },
      { op: 'fx', kind: 'mask', clip: 'c1', shape: 'concave', pts: chevron, feather: 0,
        keys: [{ t: 0, x: 0.2 }, { t: 2, x: 0.8, e: 'linear' }] },
    ],
  });
  const out = path.join(ctx.project, 'renders', 'keys.mp4');
  const ren = await api.render(ctx, { out, quality: 'draft', wait: 170 });
  assert.equal(ren.state, 'done', JSON.stringify(ren));
  const [w, h] = (ren.size as string).split('x').map(Number) as [number, number];
  const early = thirds(out, 0.1, w, h);
  const mid = thirds(out, 1.0, w, h);
  const late = thirds(out, 2.5, w, h);
  // The bright chevron starts on the left, crosses the middle and ends on the right.
  assert.ok(early[0] > early[2] + 20, `t=0.1 left should be brighter: ${early.map(Math.round)}`);
  assert.ok(mid[1] > mid[0] + 10 && mid[1] > mid[2] + 10, `t=1.0 middle should be brightest: ${mid.map(Math.round)}`);
  assert.ok(late[2] > late[0] + 20, `t=2.5 right should be brighter: ${late.map(Math.round)}`);
  // The sequence is cached per mask: one directory of frames, not a single static PNG.
  const masks = readdirSync(path.join(ctx.project, '.tmep', 'cache', 'masks'));
  assert.ok(masks.some((m) => !m.endsWith('.png')), `expected a frame-sequence directory, got ${masks}`);
});

test('a concave mask reveal is hidden before it starts and fully visible after', { timeout: 180_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ctx = await project('reveal');
  await api.edit(ctx, {
    ratio: '16:9',
    ops: [
      { op: 'add', src: 'v1', in: 0, out: 3 },
      { op: 'fx', kind: 'mask', clip: 'c1', shape: 'concave', pts: chevron, feather: 0, at: 1, reveal: 0.5, from: 'left' },
    ],
  });
  const out = path.join(ctx.project, 'renders', 'reveal.mp4');
  const ren = await api.render(ctx, { out, quality: 'draft', wait: 170 });
  assert.equal(ren.state, 'done', JSON.stringify(ren));
  const [w, h] = (ren.size as string).split('x').map(Number) as [number, number];
  const before = thirds(out, 0.5, w, h);
  const after = thirds(out, 2.5, w, h);
  assert.ok(before[1] < 30, `before the reveal the mask must be hidden: ${before.map(Math.round)}`);
  assert.ok(after[1] > before[1] + 40, `after the reveal the chevron must be visible: ${after.map(Math.round)}`);
});

test('an animated b-roll mask continues across render units instead of restarting', { timeout: 180_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ctx = await project('units');
  // Two main clips with a hard cut at 2 s make two render units; the b-roll spans the cut.
  await api.edit(ctx, {
    ratio: '16:9',
    ops: [
      { op: 'add', src: 'v1', in: 0, out: 2 },
      { op: 'add', src: 'v1', in: 0, out: 2 },
    ],
  });
  // Black main track: dim it to near-black with a full-frame inverted mask so only the b-roll is bright.
  const added = await api.edit(ctx, { ops: [
    { op: 'fx', kind: 'mask', clip: 'c1', shape: 'rect', x: 0.5, y: 0.5, w: 1, h: 1, invert: true, feather: 0 },
    { op: 'fx', kind: 'mask', clip: 'c2', shape: 'rect', x: 0.5, y: 0.5, w: 1, h: 1, invert: true, feather: 0 },
    { op: 'broll', src: 'v1', at: 0.5, d: 3, in: 0 },
  ] });
  const brollId = (added.ids as string[]).find((id) => id.startsWith('b'));
  assert.ok(brollId, `b-roll id: ${JSON.stringify(added)}`);
  await api.edit(ctx, { ops: [
    { op: 'fx', kind: 'mask', clip: brollId, shape: 'concave', pts: chevron, feather: 0,
      keys: [{ t: 0, x: 0.2 }, { t: 3, x: 0.8, e: 'linear' }] },
  ] });
  const out = path.join(ctx.project, 'renders', 'units.mp4');
  const ren = await api.render(ctx, { out, quality: 'draft', wait: 170 });
  assert.equal(ren.state, 'done', JSON.stringify(ren));
  assert.ok((ren.units as number) >= 2, `expected at least two render units: ${JSON.stringify(ren)}`);
  const [w, h] = (ren.size as string).split('x').map(Number) as [number, number];
  // b-roll time 1.4 s (timeline 1.9 s, first unit) and 1.6 s (timeline 2.1 s, second unit): the
  // chevron is near the middle in both. A restart at the unit boundary would jump back left.
  const a = thirds(out, 1.9, w, h);
  const b = thirds(out, 2.1, w, h);
  assert.ok(a[1] > a[0] && a[1] > a[2], `t=1.9 middle brightest: ${a.map(Math.round)}`);
  assert.ok(b[1] > b[0] && b[1] > b[2], `t=2.1 middle brightest (no restart): ${b.map(Math.round)}`);
  assert.ok(Math.abs(a[0] - b[0]) < 25, `left third must not jump across the unit boundary: ${a.map(Math.round)} vs ${b.map(Math.round)}`);
});
