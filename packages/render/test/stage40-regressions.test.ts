/**
 * Phase 4 Stage 4.0 regressions found by the full-render effect matrix (bench/phase4/effect-matrix.ts).
 *  - The final-mix cache key ignored J/L offsets, speed ramps, reverse, per-clip audio post and the
 *    master settings, so those edits on an already-rendered project silently reused stale audio.
 *  - jcut/lcut reported success when no handle audio existed.
 *  - "directional" blur was a 2-D luma-only box blur (and the vertical branch blurred only chroma).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as api from '../../engine/src/api.ts';
import { ffmpegInfo } from '../../media/src/ffmpeg.ts';
import { compileFx } from '../src/effects.ts';

let dir: string;
let skip: string | undefined;

before(async () => {
  try {
    const info = await ffmpegInfo();
    if (!info.encoders.has('libx264')) skip = 'ffmpeg lacks libx264';
  } catch {
    skip = 'ffmpeg not installed';
  }
  if (skip) return;
  dir = mkdtempSync(path.join(os.tmpdir(), 'frame-s40-'));
  for (const [name, f] of [['a', 440], ['b', 880]] as const) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4',
      '-f', 'lavfi', '-i', `sine=f=${f}:d=4:sample_rate=48000,volume=3,tremolo=f=3:d=0.8`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, `${name}.mp4`)]);
    assert.equal(r.status, 0, String(r.stderr));
  }
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const pcm = (file: string) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, String(r.stderr));
  const b = r.stdout as Buffer;
  return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
};
const rmsDiff = (a: Int16Array, b: Int16Array) => {
  const n = Math.min(a.length, b.length);
  let d = 0, r = 0;
  for (let i = 0; i < n; i++) { d += (a[i]! - b[i]!) ** 2; r += b[i]! ** 2; }
  return Math.sqrt(d / n) / Math.max(1, Math.sqrt(r / n));
};

test('audio-only edits on an already-rendered project re-mix the audio (no stale final-mix cache)', { timeout: 240_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const proj = path.join(dir, 'cache');
  mkdirSync(proj, { recursive: true });
  const ctx = { project: proj, detail: 'standard' as const };
  await api.importMedia(ctx, { paths: [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')] });
  await api.edit(ctx, { ratio: '16:9', ops: [{ op: 'add', src: 'v1', in: 0, out: 3 }, { op: 'add', src: 'v2', in: 1, out: 4 }] });
  const render = async (name: string) => {
    const out = path.join(proj, 'renders', `${name}.mp4`);
    const r = await api.render(ctx, { out, preview: true, wait: 200 });
    assert.equal(r.state, 'done', JSON.stringify(r));
    return pcm(out);
  };
  let prev = await render('base');
  for (const [name, ops] of [
    ['jcut', ['jcut c2 0.5']],
    ['lcut', ['lcut c1 0.5']],
    ['post', ['audio c1 eq=warm hp=300']],
    ['reverse', ['reverse c1 true']],
    ['master', ['audio lufs=-23 limiter=-3']],
  ] as const) {
    await api.edit(ctx, { ops: [...ops] });
    const cur = await render(name);
    assert.ok(rmsDiff(cur, prev) > 0.02, `${name}: audio must change after an audio-only edit (diff ${rmsDiff(cur, prev).toFixed(4)})`);
    prev = cur;
  }
});

test('jcut and lcut report when the handle audio they need does not exist', async (t) => {
  if (skip) return t.skip(skip);
  const proj = path.join(dir, 'notes');
  mkdirSync(proj, { recursive: true });
  const ctx = { project: proj, detail: 'standard' as const };
  await api.importMedia(ctx, { paths: [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')] });
  await api.edit(ctx, { ratio: '16:9', ops: [{ op: 'add', src: 'v1', in: 0, out: 4 }, { op: 'add', src: 'v2', in: 0.3, out: 4 }] });
  const j = await api.edit(ctx, { ops: ['jcut c2 0.8'] });
  assert.match((j.did as string[])[0]!, /requested 0\.8s; only 0\.3s of source audio before its in-point/);
  const l = await api.edit(ctx, { ops: ['lcut c1 0.5'] });
  assert.match((l.did as string[])[0]!, /requested 0\.5s; only 0s of source audio after its out-point/);
  const ok = await api.edit(ctx, { ops: ['jcut c2 0.2'] });
  assert.equal((ok.did as string[])[0], 'jcut c2 0.2s');
});

test('directional blur compiles to a true directional blur on all planes', () => {
  const clip = { id: 'c1', src: 'v1', in: 0, out: 2, speed: 1, fit: 'cover', cx: 0.5, cy: 0.5, base: 1, push: 0, zoom: [], vol: 1, mute: false,
    fx: [{ type: 'blur', mode: 'directional', sigma: 6, angle: 90 }] } as never;
  const f = compileFx(clip, 640, 360, 30, '#000000', 60, 't')!;
  assert.match(f, /dblur=angle=90:radius=12/);
  assert.doesNotMatch(f, /boxblur/);
});
