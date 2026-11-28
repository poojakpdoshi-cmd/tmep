import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Project, emptyTimeline, newClip, mediaHash } from '../../core/src/index.ts';
import { renderTimeline } from '../src/render.ts';
import { ffmpeg, probe } from '../../media/src/ffmpeg.ts';
import { spawnSync } from 'node:child_process';

// Same convention as the other render tests: skip (visibly) without FFmpeg; CI's preflight step makes
// FFmpeg mandatory there, so these never skip in CI.
const noFFmpeg = spawnSync('ffprobe', ['-version']).status !== 0 ? 'ffmpeg/ffprobe not installed' : false;

async function makeSampleMp4(file: string, color = 'blue', dur = 1.5) {
  await ffmpeg({
    args: [
      '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=30:d=${dur}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${dur}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
    ],
  });
}

test('cache-integrity: corrupt cached output with matching .tmep marker is rejected and re-rendered', { skip: noFFmpeg }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-cache-int-'));
  try {
    const src = path.join(dir, 'src.mp4');
    await makeSampleMp4(src, 'navy', 1.2);
    const pr = await probe(src);
    const p = await Project.open(dir, { create: true });
    const { asset } = await p.addAsset({
      kind: 'video',
      path: src,
      name: 'src.mp4',
      hash: mediaHash(src),
      dur: pr.dur,
      w: pr.w,
      h: pr.h,
      fps: pr.fps,
      audio: pr.audio,
      size: (await fsp.stat(src)).size,
    });
    const tl = emptyTimeline('16:9', 30);
    tl.settings.w = 320;
    tl.settings.h = 180;
    tl.clips.push(newClip(tl, asset.id, 0, 1.0));
    const out = path.join(dir, 'renders', 'out.mp4');

    const r1 = await renderTimeline(p, tl, {}, { out });
    assert.equal(r1.cacheHit, false);

    // Corrupt output while preserving matching .tmep marker
    await fsp.writeFile(out, 'corrupt-mp4-bytes');
    const r2 = await renderTimeline(p, tl, {}, { out });
    assert.equal(r2.cacheHit, false);
    const verified = await probe(out);
    assert.equal(verified.w, 320);
    assert.equal(verified.h, 180);
    assert.equal(verified.audio, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('cache-integrity: modified source media on disk invalidates cache', { skip: noFFmpeg }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-cache-media-'));
  try {
    const src = path.join(dir, 'src.mp4');
    await makeSampleMp4(src, 'green', 1.2);
    const pr = await probe(src);
    const p = await Project.open(dir, { create: true });
    const { asset } = await p.addAsset({
      kind: 'video',
      path: src,
      name: 'src.mp4',
      hash: mediaHash(src),
      dur: pr.dur,
      w: pr.w,
      h: pr.h,
      fps: pr.fps,
      audio: pr.audio,
      size: (await fsp.stat(src)).size,
    });
    const tl = emptyTimeline('16:9', 30);
    tl.settings.w = 320;
    tl.settings.h = 180;
    tl.clips.push(newClip(tl, asset.id, 0, 1.0));
    const out = path.join(dir, 'renders', 'out.mp4');

    const r1 = await renderTimeline(p, tl, {}, { out });
    assert.equal(r1.cacheHit, false);

    // Replace source media in place with different content & bumped mtime
    const alt = path.join(dir, 'alt.mp4');
    await makeSampleMp4(alt, 'red', 1.4);
    await fsp.rename(alt, src);
    const future = new Date(Date.now() + 5000);
    await fsp.utimes(src, future, future);

    const r2 = await renderTimeline(p, tl, {}, { out });
    assert.equal(r2.cacheHit, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
