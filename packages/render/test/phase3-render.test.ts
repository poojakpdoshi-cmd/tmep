import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as api from '../../engine/src/api.ts';
import { ffmpegInfo, probe } from '../../media/src/ffmpeg.ts';

let dir: string;
let clipA: string;
let clipB: string;
let skip: string | undefined;

before(async () => {
  try {
    const info = await ffmpegInfo();
    if (!info.encoders.has('libx264')) skip = 'ffmpeg lacks libx264';
  } catch {
    skip = 'ffmpeg not installed';
  }
  if (skip) return;
  dir = mkdtempSync(path.join(os.tmpdir(), 'frame-p3-render-'));
  clipA = path.join(dir, 'a.mp4');
  clipB = path.join(dir, 'b.mp4');
  const mk = (out: string, col: string, freq: number) => {
    const r = spawnSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${col}:s=640x360:r=30:d=3`,
      '-f', 'lavfi', '-i', `sine=f=${freq}:d=3:sample_rate=48000`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', out,
    ]);
    assert.equal(r.status, 0);
  };
  mk(clipA, '0x225588', 440);
  mk(clipB, '0x884422', 660);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('Phase 3 E2E public API: pro ops, concave/bezier masks, colour grade, two-pass audio, colormatch, workflow cache, and QA inspector', { timeout: 120_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const proj = path.join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  const ctx = { project: proj, detail: 'standard' as const };

  const imp = await api.importMedia(ctx, { paths: [clipA, clipB] });
  assert.equal((imp.assets as unknown[]).length, 2);

  await api.edit(ctx, {
    ratio: '16:9',
    ops: [
      { op: 'add', src: 'v1', in: 0, out: 3 },
      { op: 'add', src: 'v2', in: 0, out: 3 },
      'freeze 1.5 1.0',
      'reverse c2 true',
      'stabilize c1 smoothing=8',
      'punch 0.5 to=1.18 d=0.8',
      'pip v2 4.5 1.5 pos=br scale=0.28',
      {
        op: 'fx', kind: 'mask', clip: 'c1', shape: 'concave',
        pts: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.4], [0.9, 0.9], [0.1, 0.9]],
        feather: 0.02,
      },
      { op: 'fx', kind: 'blur', clip: 'c1', mode: 'gaussian', sigma: 2 },
      { op: 'fx', kind: 'glow', clip: 'c2', radius: 8, intensity: 0.3 },
      'color c1 exposure=0.08 contrast=1.06 temp=6200 saturation=1.08 vignette=0.15',
      'audio c1 eq=dialogue comp=medium hp=80',
      'audio target=youtube twoPass=true limiter=-1.0',
    ],
  });

  // Deterministic shot matching via public API
  const cm = await api.colormatch(ctx, { targetClip: 'c2', refClip: 'c1' });
  assert.equal(cm.ok, 1);

  // Workflow compiler + dependency-aware cache hit
  const intent = { kind: 'talking_head_reel', title: 'Phase 3 Test', subtitle: 'Pro pipeline', platform: 'youtube', duration: 2 };
  const c1 = await api.compile(ctx, intent);
  assert.equal(c1.cacheHit, false);
  const c2 = await api.compile(ctx, intent);
  assert.equal(c2.cacheHit, true);

  // Render final MP4
  const outMp4 = path.join(proj, 'renders', 'p3-out.mp4');
  const ren = await api.render(ctx, { out: outMp4, quality: 'draft', wait: 120 });
  assert.equal(ren.state, 'done', JSON.stringify(ren));

  const pr = await probe(outMp4);
  assert.ok(pr.dur >= 6.5 && pr.dur <= 7.5, `rendered dur=${pr.dur}`);
  assert.equal(pr.audio, true);

  // FRAME Inspector QA check on rendered output
  const qa = await api.inspect(ctx, { what: 'qa', file: outMp4 });
  assert.equal(qa.ok, 1, JSON.stringify(qa.findings));
  assert.equal(qa.defects, 0);

  // J-cut & L-cut audio + LUT path traversal rejection
  await api.edit(ctx, { ops: ['jcut c2 0.4', 'lcut c1 0.4'] });
  const outJL = path.join(proj, 'renders', 'p3-jl.mp4');
  const renJL = await api.render(ctx, { out: outJL, quality: 'draft', wait: 120 });
  assert.equal(renJL.state, 'done', JSON.stringify(renJL));
  const qaJL = await api.inspect(ctx, { what: 'qa', file: outJL });
  assert.equal(qaJL.ok, 1, JSON.stringify(qaJL.findings));

  await assert.rejects(
    () => api.edit(ctx, { ops: [{ op: 'color', clip: 'c1', lut: '../outside.cube' }] }),
    (e: { code?: string }) => e.code === 'E_SECURITY',
  );
});

test('Phase 3 animated concave mask keys rasterize distinct frames', async () => {
  const { rasterizeComplexMaskPng } = await import('../src/effects.ts');
  const mask = {
    type: 'mask' as const,
    shape: 'concave' as const,
    x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0, invert: false,
    pts: [[0.2, 0.2], [0.8, 0.2], [0.5, 0.5], [0.8, 0.8], [0.2, 0.8]] as [number, number][],
    keys: [{ t: 0, x: 0.2, y: 0.2 }, { t: 1, x: 0.8, y: 0.8 }],
  };
  const b0 = rasterizeComplexMaskPng(mask, 64, 64, 0);
  const b1 = rasterizeComplexMaskPng(mask, 64, 64, 1);
  assert.notEqual(Buffer.compare(b0, b1), 0, 'animated mask keys must produce distinct frames');
});
