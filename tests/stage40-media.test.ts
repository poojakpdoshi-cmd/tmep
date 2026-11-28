/**
 * Phase 4 Stage 4.0 media regressions, each measured on decoded output of a public-API render:
 *  - speed ramps kept audio and video on one time map (the video ramp collapsed to one segment);
 *  - BT.2020 / PQ / HLG sources convert to BT.709 (the colorspace fast path skipped primaries and
 *    applied no HDR tone mapping);
 *  - a source whose audio track is digital silence renders (loudnorm produced NaN and the AAC
 *    encoder aborted the whole render).
 * Full measurement scripts: bench/phase4/av-sync.ts and bench/phase4/color-reference.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as api from '../packages/engine/src/api.ts';
import { ffmpegInfo, probe } from '../packages/media/src/ffmpeg.ts';

let dir: string;
let skip: string | undefined;
let zscale = false;

before(async () => {
  try {
    const info = await ffmpegInfo();
    if (!info.encoders.has('libx264')) skip = 'ffmpeg lacks libx264';
    zscale = info.filters.has('zscale');
  } catch {
    skip = 'ffmpeg not installed';
  }
  if (!skip) dir = mkdtempSync(path.join(os.tmpdir(), 'frame-s40m-'));
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const ff = (a: string[]) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a], { maxBuffer: 128 << 20 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout as Buffer;
};

async function project(name: string, files: string[]) {
  const proj = path.join(dir, name);
  mkdirSync(proj, { recursive: true });
  const ctx = { project: proj, detail: 'standard' as const };
  await api.importMedia(ctx, { paths: files });
  return ctx;
}

test('a speed ramp keeps picture and sound in sync', { timeout: 240_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const FPS = 30;
  const events = [0.5, 1.3, 2.1, 2.9, 3.7];
  const flash = events.map((e) => `between(n,${Math.round(e * FPS)},${Math.round(e * FPS) + 2})`).join('+');
  const beep = events.map((e) => `between(t,${e},${(e + 0.04).toFixed(2)})`).join('+');
  const src = path.join(dir, 'events.mov');
  ff(['-f', 'lavfi', '-i', `color=c=0x202020:s=160x90:r=${FPS}:d=4.5,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${flash}'`,
    '-f', 'lavfi', '-i', `sine=f=1000:d=4.5:sample_rate=48000,volume=0.6,volume=0:enable='not(${beep})'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '1', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', src]);
  const ctx = await project('ramp', [src]);
  await api.edit(ctx, { ratio: '16:9', ops: [{ op: 'add', src: 'v1', in: 0.2, out: 4.2 }, { op: 'ramp', clip: 'c1', keys: '0:speed=1;1.2:speed=2;2.4:speed=0.6' }] });
  const out = path.join(ctx.project, 'renders', 'ramp.mp4');
  const r = await api.render(ctx, { out, preview: true, wait: 200 });
  assert.equal(r.state, 'done', JSON.stringify(r));
  const px = ff(['-i', out, '-vf', 'scale=16:9,format=gray', '-f', 'rawvideo', '-']);
  const flashes: number[] = [];
  for (let f = 0, prev = false; f * 144 < px.length; f++) {
    let s = 0; for (let i = 0; i < 144; i++) s += px[f * 144 + i]!;
    const on = s / 144 > 128;
    if (on && !prev) flashes.push(f / FPS);
    prev = on;
  }
  const b = ff(['-i', out, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
  const a = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
  const beeps: number[] = [];
  for (let i = 0, prev = false, last = -1; i + 48 <= a.length; i += 48) {
    let p = 0; for (let k = 0; k < 48; k++) p = Math.max(p, Math.abs(a[i + k]!));
    const on = p > 3000;
    if (on && !prev && i / 48000 - last > 0.1) beeps.push(i / 48000);
    if (on) last = i / 48000;
    prev = on;
  }
  assert.ok(flashes.length >= 4, `flashes detected: ${flashes}`);
  for (const fl of flashes) {
    const near = beeps.reduce((m, x) => (Math.abs(x - fl) < Math.abs(m - fl) ? x : m), Infinity);
    assert.ok(Math.abs(near - fl) <= 0.045, `flash at ${fl.toFixed(3)}s has nearest beep at ${near.toFixed(3)}s (flashes ${flashes.map((x) => x.toFixed(3))}; beeps ${beeps.map((x) => x.toFixed(3))})`);
  }
});

test('BT.2020 SDR, PQ and HLG sources convert to BT.709 (zscale)', { timeout: 240_000 }, async (t) => {
  if (skip) return t.skip(skip);
  if (!zscale) return t.skip('ffmpeg lacks zscale (zimg); HDR tone mapping is unavailable on this build');
  const bars: [number, number, number][] = [[128, 128, 128], [40, 200, 40], [200, 40, 40]];
  const src = bars.map(([r, g, b], i) => `color=c=0x${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}:s=64x90:r=30:d=1.5[c${i}]`).join(';') + ';[c0][c1][c2]hstack=inputs=3,format=gbrp';
  for (const [name, trc, tag] of [['bt2020', 'bt709', 'bt709'], ['pq', 'smpte2084', 'smpte2084'], ['hlg', 'arib-std-b67', 'arib-std-b67']] as const) {
    const file = path.join(dir, `${name}.mp4`);
    ff(['-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', 'sine=f=300:d=1.5:sample_rate=48000', '-t', '1.5',
      '-vf', `zscale=tin=bt709:t=${trc}:pin=bt709:p=2020:min=gbr:m=2020_ncl:rin=full:r=tv:npl=203,format=yuv420p10le`,
      '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', tag, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', file]);
    const ctx = await project(`cs-${name}`, [file]);
    await api.edit(ctx, { ratio: '16:9', ops: [{ op: 'add', src: 'v1', in: 0, out: 1.4 }] });
    const out = path.join(ctx.project, 'renders', 'out.mp4');
    const r = await api.render(ctx, { out, preview: true, wait: 200 });
    assert.equal(r.state, 'done', JSON.stringify(r));
    const px = ff(['-ss', '0.7', '-i', out, '-frames:v', '1', '-vf', 'scale=192:90:in_color_matrix=bt709:in_range=tv,format=rgb24', '-f', 'rawvideo', '-']);
    bars.forEach((exp, i) => {
      const o = (45 * 192 + i * 64 + 32) * 3;
      const got = [px[o]!, px[o + 1]!, px[o + 2]!];
      const err = Math.max(...got.map((v, k) => Math.abs(v - exp[k]!)));
      assert.ok(err <= 10, `${name} bar ${i}: expected ${exp}, got ${got} (error ${err})`);
    });
  }
});

test('a source with a digitally silent audio track renders', { timeout: 120_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const file = path.join(dir, 'silent.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1.5', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1.5',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  const ctx = await project('silent', [file]);
  await api.edit(ctx, { ratio: '16:9', ops: [{ op: 'add', src: 'v1', in: 0, out: 1.4 }] });
  const out = path.join(ctx.project, 'renders', 'out.mp4');
  const r = await api.render(ctx, { out, preview: true, wait: 100 });
  assert.equal(r.state, 'done', JSON.stringify(r));
  const pr = await probe(out);
  assert.equal(pr.audio, true);
});
