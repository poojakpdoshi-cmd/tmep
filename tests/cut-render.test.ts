/**
 * Decoded-output check for timeline `cut` on reused footage (audit P1-1).
 * The source encodes its frame index (luma = 20 + 6*(n mod 32), Cb = 48 + 40*floor(n/32)), so
 * every decoded output frame can be mapped back to the exact source frame it shows.
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

before(async () => {
  try {
    const info = await ffmpegInfo();
    if (!info.encoders.has('libx264')) skip = 'ffmpeg lacks libx264';
  } catch {
    skip = 'ffmpeg not installed';
  }
  if (skip) return;
  SRC = path.join(mkdtempSync(path.join(os.tmpdir(), 'tmep-cutsrc-')), 'coded.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', "color=c=black:s=160x160:r=30:d=4,format=yuv420p,geq=lum='20+6*mod(N,32)':cb='48+40*floor(N/32)':cr=128",
    '-f', 'lavfi', '-i', 'sine=f=440:d=4:sample_rate=48000', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC]);
  assert.equal(r.status, 0, r.stderr.toString());
});

test('cut on the second copy of reused footage: decoded frames show the first copy intact', { timeout: 300_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const project = async (ops: unknown[]) => {
    const ctx: api.Ctx = { project: mkdtempSync(path.join(os.tmpdir(), 'tmep-cut-')), detail: 'standard' };
    await api.importMedia(ctx, { paths: [SRC] });
    const ed = await api.edit(ctx, { ops: [{ op: 'format', ratio: '1:1' }, ...ops] });
    const r = (await api.render(ctx, { preview: true, wait: 300 })) as Record<string, unknown>;
    assert.equal(r.state, 'done', JSON.stringify(r.err));
    return { ed: JSON.stringify(ed), out: path.resolve(ctx.project, r.out as string) };
  };
  // A: two copies of the same 4 s source, then a timeline cut inside the second copy
  const A = await project([{ op: 'keep', src: 'v1', ranges: [[0, 4], [0, 4]] }, { op: 'cut', from: 5, to: 6 }]);
  // B: the expected result, built explicitly (first copy intact, second copy minus source 1-2)
  const B = await project([{ op: 'keep', src: 'v1', ranges: [[0, 4], [0, 1], [2, 4]] }]);
  assert.ok(A.ed.includes('cut 1s'), A.ed);
  const frames = (f: string) =>
    spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-f', 'framemd5', '-'], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(',').pop()!.trim());
  const fa = frames(A.out);
  const fb = frames(B.out);
  assert.equal(fa.length, 210, '7 s at 30 fps (6 s would mean the first copy was cut too)');
  assert.equal(fb.length, 210);
  // the source changes every frame, so equal hashes mean the same source frame is shown
  assert.notEqual(fa[0], fa[60], 'fixture frames differ');
  const wrong = fa.map((h, i) => (h === fb[i] ? -1 : i)).filter((i) => i >= 0);
  assert.deepEqual(wrong.slice(0, 10), [], `${wrong.length} decoded frames differ from the explicit expected timeline`);
  const a = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=duration', '-of', 'csv=p=0', A.out], { encoding: 'utf8' });
  assert.ok(Math.abs(Number(a.stdout) - 7) < 0.05, `audio duration ${a.stdout}`);
});
