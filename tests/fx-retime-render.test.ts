/**
 * Decoded-frame checks for effect retiming (audit P2-1), robust to FFmpeg build differences:
 * every comparison is between two renders made by the same pipeline.
 *
 *  C  effects added first, then `speed 2` on c1 and `trim in=1` on c2 (the edit under test)
 *  B  the same edits made first, then effects added with the retimed keys written explicitly
 *  A  C plus a timeline cut inside the sped-up clip
 *
 * Expect C ~= B frame by frame (retiming), and A ~= C on the frames that survive the cut
 * (effects stay attached to content across speed + cut). Comparison: mean absolute difference
 * of a downscaled grey frame, to absorb lossy-encoding noise between different unit layouts.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as api from '../packages/engine/src/api.ts';
import { ffmpegInfo } from '../packages/media/src/ffmpeg.ts';

let skip: string | undefined;
let SRC = '';
const W = 54;
const H = 96;

before(async () => {
  try {
    const info = await ffmpegInfo();
    if (!info.encoders.has('libx264') || !info.filters.has('geq')) skip = 'ffmpeg lacks libx264/geq';
  } catch {
    skip = 'ffmpeg not installed';
  }
  if (skip) return;
  SRC = path.join(mkdtempSync(path.join(os.tmpdir(), 'tmep-retime-src-')), 'src.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4:sample_rate=48000', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC]);
  assert.equal(r.status, 0, r.stderr.toString());
});

async function render(ops: unknown[]): Promise<Buffer[]> {
  const ctx: api.Ctx = { project: mkdtempSync(path.join(os.tmpdir(), 'tmep-retime-')), detail: 'standard' };
  await api.importMedia(ctx, { paths: [SRC] });
  await api.edit(ctx, { ops: [{ op: 'format', ratio: '9:16' }, { op: 'keep', src: 'v1', ranges: [[0, 4], [0, 4]] }, ...ops] });
  const r = (await api.render(ctx, { preview: true, wait: 300 })) as Record<string, unknown>;
  assert.equal(r.state, 'done', JSON.stringify(r.err));
  const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', path.resolve(ctx.project, r.out as string), '-vf', `scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 }).stdout;
  const n = raw.length / (W * H);
  return Array.from({ length: n }, (_, i) => raw.subarray(i * W * H, (i + 1) * W * H));
}

const mad = (a: Buffer, b: Buffer) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
};

// c1: opacity ramp over the source 0-4 s + an ellipse reveal from source 0.5 s to 2.5 s
// c2: linear 1.0 -> 1.4 zoom over source 0-4 s
const FX = [
  { op: 'fx', kind: 'kf', clip: 'c1', keys: '0:o=0;4:o=1,e=linear' },
  { op: 'fx', kind: 'mask', clip: 'c1', shape: 'ellipse', w: 0.7, h: 0.5, reveal: 2, at: 0.5, e: 'linear' },
  { op: 'fx', kind: 'kf', clip: 'c2', keys: '0:s=1;4:s=1.4,e=linear' },
];
const EDITS = [
  { op: 'speed', x: 2, clip: 'c1' },
  { op: 'trim', clip: 'c2', in: 1 },
];
// what the effects must look like after EDITS: c1 runs at 2x (times halved); c2 starts at source 1 s
const RETIMED = [
  { op: 'fx', kind: 'kf', clip: 'c1', keys: '0:o=0;2:o=1,e=linear' },
  { op: 'fx', kind: 'mask', clip: 'c1', shape: 'ellipse', w: 0.7, h: 0.5, reveal: 1, at: 0.25, e: 'linear' },
  { op: 'fx', kind: 'kf', clip: 'c2', keys: '0:s=1.1;3:s=1.4,e=linear' },
];

test('speed and trim-in retime clip effects: decoded frames match explicitly retimed effects', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const C = await render([...FX, ...EDITS]);
  const B = await render([...EDITS, ...RETIMED]);
  assert.equal(C.length, 150, 'c1 2 s at 2x + c2 3 s = 5 s');
  assert.equal(B.length, C.length);
  const diffs = C.map((f, i) => mad(f, B[i]!));
  const bad = diffs.map((d, i) => (d > 2 ? `${i}:${d.toFixed(1)}` : '')).filter(Boolean);
  assert.deepEqual(bad.slice(0, 8), [], `${bad.length} frames differ from the explicitly retimed render (mean abs diff > 2)`);
  // sanity: the effects are visible (opacity ramp darkens early frames of c1 vs late ones)
  assert.ok(mad(C[0]!, C[55]!) > 10, 'fixture/effects produce visible change');
});

test('speed + cut + fx: frames that survive the cut are unchanged (effects stay on their content)', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const C = await render([...FX, ...EDITS]);
  // c1 is 2 s on the timeline; cut 1.0-1.2 s = output frames 30-35 (source 2.0-2.4 s)
  const A = await render([...FX, ...EDITS, { op: 'cut', from: 1, to: 1.2 }]);
  assert.equal(A.length, C.length - 6);
  const map = (i: number) => (i < 30 ? i : i + 6);
  const diffs = A.map((f, i) => mad(f, C[map(i)]!));
  const bad = diffs.map((d, i) => (d > 2 ? `${i}:${d.toFixed(1)}` : '')).filter(Boolean);
  assert.deepEqual(bad.slice(0, 8), [], `${bad.length} frames differ after the cut`);
});
