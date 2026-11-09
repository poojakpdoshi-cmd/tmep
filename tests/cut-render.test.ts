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
  const ctx: api.Ctx = { project: mkdtempSync(path.join(os.tmpdir(), 'tmep-cut-')), detail: 'standard' };
  await api.importMedia(ctx, { paths: [SRC] });
  const ed = (await api.edit(ctx, { ops: [{ op: 'format', ratio: '1:1' }, { op: 'keep', src: 'v1', ranges: [[0, 4], [0, 4]] }, { op: 'cut', from: 5, to: 6 }] })) as Record<string, unknown>;
  assert.ok(JSON.stringify(ed).includes('cut 1s'), JSON.stringify(ed));
  const r = (await api.render(ctx, { preview: true, wait: 300 })) as Record<string, unknown>;
  assert.equal(r.state, 'done', JSON.stringify(r.err));
  const out = path.resolve(ctx.project, r.out as string);
  // raw yuv420p planes (no range conversion): centre Y and Cb of every decoded frame
  const S = 32;
  const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', `scale=${S}:${S}:flags=area`, '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 }).stdout;
  const fsz = S * S * 1.5;
  const frames = raw.length / fsz;
  assert.equal(frames, 210, '7 s at 30 fps (6 s would mean the first copy was cut too)');
  const at = (f: number) => ({ y: raw[f * fsz + (S / 2) * S + S / 2]!, u: raw[f * fsz + S * S + (S / 4) * (S / 2) + S / 4]! });
  const code = (n: number) => ({ y: 20 + 6 * (n % 32), u: 48 + 40 * Math.floor(n / 32) });
  const expected = (f: number) => (f < 120 ? f : f < 150 ? f - 120 : f - 150 + 60);
  const wrong = Array.from({ length: frames }, (_, f) => ({ f, got: at(f), want: code(expected(f)) })).filter((x) => Math.abs(x.got.y - x.want.y) > 2 || Math.abs(x.got.u - x.want.u) > 4);
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} frames show the wrong source frame`);
  const a = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' });
  assert.ok(Math.abs(Number(a.stdout) - 7) < 0.05, `audio duration ${a.stdout}`);
});
