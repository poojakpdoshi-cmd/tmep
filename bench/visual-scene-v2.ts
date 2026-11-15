// Synthetic path-reveal scene (examples/path-reveal/scene.json) over a generated backdrop cut into two clips,
// so the animation crosses a cached video-unit boundary at t = 2 s. No recorded media.
// Usage: node bench/visual-scene-v2.ts setup|cold|cached|verify <scratch-dir> [preview|full]
// setup accepts TMEP_BENCH_SPEC=<scene.json> to measure another spec (verify expects the example).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sampleKeys } from '../packages/core/src/index.ts';
import * as api from '../packages/engine/src/api.ts';

const [mode, root, quality = 'preview'] = process.argv.slice(2);
assert.ok(root && ['preview', 'full'].includes(quality), 'usage: setup|cold|cached|verify <scratch-dir> [preview|full]');
const project = path.resolve(root, 'path-reveal');
const ctx = { project, detail: 'debug' } as const;
const run = (command: string, args: string[]) => execFileSync(command, args, { windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
const ff = (args: string[]) => run('ffmpeg', ['-nostdin', '-v', 'error', ...args]);
const [W, H] = quality === 'preview' ? [540, 960] : [1080, 1920];
const FRAMES = 120;

if (mode === 'setup') {
  mkdirSync(project, { recursive: true });
  // A quiet vertical navy gradient, generated deterministically.
  const file = path.join(project, 'backdrop.mp4');
  ff(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30:d=4',
    '-vf', "format=rgb24,geq=r='10+8*Y/H':g='14+8*Y/H':b='30+26*Y/H'", '-c:v', 'libx264', '-crf', '12', '-threads', '2', file]);
  await api.importMedia(ctx, { paths: [file] });
  const spec = JSON.parse(readFileSync(process.env.TMEP_BENCH_SPEC ?? new URL('../examples/path-reveal/scene.json', import.meta.url), 'utf8'));
  const result = await api.edit(ctx, { ops: [
    { op: 'add', src: 'v1', out: 2 }, { op: 'add', src: 'v1', in: 2 }, { op: 'loudness', lufs: 0 }, { op: 'captions', style: 'none' },
    { op: 'scene', spec },
  ] });
  console.log(JSON.stringify({ setup: true, rev: result.rev }));
} else if (mode === 'cold' || mode === 'cached') {
  const start = performance.now();
  const result = await api.render(ctx, { preview: quality === 'preview', parallel: 1, out: `${mode}-${quality}.mp4`, wait: 600 });
  assert.equal(result.state, 'done', JSON.stringify(result));
  const detail = result.result as Record<string, unknown>;
  assert.equal(detail.units, 2);
  assert.equal(detail.unitsCached, mode === 'cold' ? 0 : 2, 'use a fresh benchmark directory');
  console.log(JSON.stringify({ quality, mode, wallMs: Math.round(performance.now() - start), renderMs: detail.ms,
    units: detail.units, cached: detail.unitsCached }));
} else if (mode === 'verify') {
  const file = (m: string) => path.join(project, `${m}-${quality}.mp4`);
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_type,width,height,nb_read_frames', '-of', 'json', file('cold')]).toString());
  assert.deepEqual([probe.streams[0].width, probe.streams[0].height, Number(probe.streams[0].nb_read_frames)], [W, H, FRAMES]);
  const frameHash = (m: string) => ff(['-i', file(m), '-map', '0:v:0', '-f', 'framemd5', '-']);
  const decoded = frameHash('cold');
  assert.deepEqual(decoded, frameHash('cached'), 'cached export decodes to different frames');
  // Continuity: mean absolute luma change between consecutive frames. A seam or pop at the
  // unit boundary (frame 59 -> 60) would stand out from its neighbours.
  const gray = ff(['-i', file('cold'), '-an', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
  const px = W * H;
  assert.equal(gray.length, px * FRAMES);
  const mad = Array.from({ length: FRAMES - 1 }, (_, f) => {
    let sum = 0;
    for (let i = 0; i < px; i++) sum += Math.abs(gray[(f + 1) * px + i]! - gray[f * px + i]!);
    return sum / px;
  });
  const near = [57, 58, 60, 61].map((f) => mad[f]!);
  const boundary = mad[59]!;
  assert.ok(boundary <= Math.max(...near) * 1.5 + .05, `unit boundary jump ${boundary} vs ${near}`);
  // Pixel probes: the client outline's left edge is absent at frame 0 (draw starts at 0),
  // fully drawn by frame 45 and still present at the last frame.
  const rgb = ff(['-i', file('cold'), '-vf', "select='eq(n,0)+eq(n,45)+eq(n,119)'", '-fps_mode', 'passthrough',
    '-an', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  // The outline's left stroke sits at view x = 8; the view is fitted uniformly and centred in the box.
  const spec = JSON.parse(readFileSync(new URL('../examples/path-reveal/scene.json', import.meta.url), 'utf8'));
  const c = spec.layers.find((l: { id: string }) => l.id === 'client');
  const k = Math.min(c.w * 1080 / c.view.w, c.h * 1920 / c.view.h);
  const edge = [(c.x * 1080 - c.view.w * k / 2 + 8 * k) / 1080, c.y] as const;
  // Brightest-green pixel within ±3 output px of the edge after the camera zoom at that frame.
  const at = (index: number, frame: number) => {
    const s = sampleKeys(spec.camera, 's', frame / 30);
    const x = Math.round((.5 + (edge[0] - .5) * s) * W), y = Math.round((.5 + (edge[1] - .5) * s) * H);
    let best: [number, number, number] = [0, 0, 0];
    for (let dx = -3; dx <= 3; dx++) {
      const o = 3 * (index * px + y * W + x + dx);
      if (rgb[o + 1]! > best[1]!) best = [rgb[o]!, rgb[o + 1]!, rgb[o + 2]!];
    }
    return best;
  };
  const [r0, g0] = at(0, 0), [r1, g1, b1] = at(1, 45), [r2, g2] = at(2, 119);
  assert.ok(g0 < 60 && r0 < 40, `outline visible before its reveal: ${r0},${g0}`);
  assert.ok(g1 > 150 && g1 > r1 + 60 && b1 > 120, `outline missing after reveal: ${r1},${g1},${b1}`);
  assert.ok(g2 > 150 && r2 < g2, `outline missing at the end: ${r2},${g2}`);
  console.log(JSON.stringify({ quality, frames: FRAMES, cachedFramesMatch: true, boundaryMad: +boundary.toFixed(3),
    neighbourMad: near.map((v) => +v.toFixed(3)), maxMad: +Math.max(...mad).toFixed(3),
    videoHash: createHash('sha256').update(decoded).digest('hex') }));
} else {
  throw new Error('usage: node bench/visual-scene-v2.ts setup|cold|cached|verify <scratch-dir> [preview|full]');
}
