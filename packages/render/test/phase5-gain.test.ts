/** Phase 5.0: compressed dialogue is gain-staged, so a quiet recording is actually compressed. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as api from '../../engine/src/api.ts';
import { ffmpegInfo } from '../../media/src/ffmpeg.ts';

let dir: string;
let skip: string | undefined;
before(async () => {
  try { const i = await ffmpegInfo(); if (!i.encoders.has('libx264')) skip = 'no libx264'; } catch { skip = 'ffmpeg not installed'; }
  if (!skip) dir = mkdtempSync(path.join(os.tmpdir(), 'frame-gain-'));
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const pcm = (f: string) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 64 << 20 });
  const b = r.stdout as Buffer;
  return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
};
const crest = (a: Int16Array) => { // peak-to-RMS over 50 ms windows: compression lowers its spread
  const w = 800, lv: number[] = [];
  for (let i = 0; i + w <= a.length; i += w) { let s = 0; for (let k = 0; k < w; k++) s += a[i + k]! ** 2; lv.push(10 * Math.log10(s / w + 1)); }
  const sorted = lv.filter((v) => v > 20).sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length * 0.95)]! - sorted[Math.floor(sorted.length * 0.1)]!;
};

test('a quiet recording (≈ −34 LUFS) is compressed after gain staging', { timeout: 180_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const src = path.join(dir, 'quiet.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=6', '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=pink:r=48000:a=0.17,tremolo=f=4:d=0.9',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  assert.equal(r.status, 0);
  const proj = path.join(dir, 'p'); mkdirSync(proj);
  const ctx = { project: proj, detail: 'standard' as const };
  await api.importMedia(ctx, { paths: [src] });
  await api.edit(ctx, { ratio: '16:9', ops: [{ op: 'add', src: 'v1', in: 0, out: 6 }] });
  const render = async (name: string) => { const out = path.join(proj, 'renders', `${name}.mp4`); const x = await api.render(ctx, { out, preview: true, wait: 150 }); assert.equal(x.state, 'done', JSON.stringify(x)); return pcm(out); };
  const plain = crest(await render('plain'));
  await api.edit(ctx, { ops: ['audio c1 comp=heavy'] });
  const comp = crest(await render('comp'));
  assert.ok(plain - comp > 1.5, `dynamic spread must shrink with compression (it measured 0.0 dB before gain staging): ${plain.toFixed(1)} → ${comp.toFixed(1)} dB`);
  assert.ok(readdirSync(path.join(proj, '.tmep', 'cache', 'gain')).length === 1, 'the clip loudness is measured once and cached');
});

test('a hot recording is not attenuated before the compressor, so compression still acts', { timeout: 180_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const src = path.join(dir, 'hot.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6:sample_rate=48000,volume=3.5,tremolo=f=2:d=0.9',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  assert.equal(r.status, 0);
  const proj = path.join(dir, 'hot'); mkdirSync(proj);
  const ctx = { project: proj, detail: 'standard' as const };
  await api.importMedia(ctx, { paths: [src] });
  await api.edit(ctx, { ratio: '16:9', ops: [{ op: 'add', src: 'v1', in: 0, out: 6 }] });
  const render = async (name: string) => { const out = path.join(proj, 'renders', `${name}.mp4`); const x = await api.render(ctx, { out, preview: true, wait: 150 }); assert.equal(x.state, 'done', JSON.stringify(x)); return pcm(out); };
  const plain = crest(await render('plain'));
  await api.edit(ctx, { ops: ['audio c1 comp=heavy'] });
  const comp = crest(await render('comp'));
  // With downward staging (first 5.0 version) this measured no change: the source was pulled below the threshold.
  assert.ok(plain - comp > 1.5, `hot source still compressed: ${plain.toFixed(1)} → ${comp.toFixed(1)} dB`);
});
