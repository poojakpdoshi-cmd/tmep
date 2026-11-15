import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as api from '../packages/engine/src/api.ts';

const [mode, root, countArg, variant = 'animated', kind = 'rect'] = process.argv.slice(2);
assert.ok(root && countArg);
const count = Number(countArg);
assert.ok([0, 1, 8, 16].includes(count));
assert.ok(['static', 'translate', 'opacity', 'animated'].includes(variant));
assert.ok(['rect', 'path'].includes(kind));
const translation = variant === 'translate' || variant === 'animated';
const opacity = variant === 'opacity' || variant === 'animated';
// `path` draws the same tiles as filled Visual Scene path layers (one shared raster overlay).
const project = path.resolve(root, `${variant}-${count}${kind === 'path' ? '-path' : ''}`);
const ctx = { project, detail: 'debug' } as const;
const run = (command: string, args: string[]) => execFileSync(command, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
const ff = (args: string[]) => run('ffmpeg', ['-nostdin', '-v', 'error', ...args]);

if (mode === 'setup') {
  mkdirSync(project, { recursive: true });
  const paths = ['black', '0x101010'].map((c, i) => {
    const file = path.join(project, `fixture-${i}.mp4`);
    ff(['-y', '-f', 'lavfi', '-i', `color=${c}:s=540x960:r=30:d=2`, '-c:v', 'libx264', '-threads', '2', file]);
    return file;
  });
  await api.importMedia(ctx, { paths });
  const layers = Array.from({ length: count }, (_, i) => ({
    id: `tile${i}`, x: .15 + .23 * (i % 4), y: .16 + .21 * Math.floor(i / 4),
    w: .14, h: .12, style: 'red',
    ...(kind === 'path'
      ? { kind: 'path', view: { w: 151.2, h: 230.4 }, d: 'M0 0 H151.2 V230.4 H0 Z', stroke: 0, fill: '#F03838' }
      : { kind: 'rect' }),
    ...((translation || opacity) && { keys: [
      { t: 0, ...(translation && { x: 0 }), ...(opacity && { o: 1 }) },
      { t: 1.6, ...(translation && { x: .02 }), ...(opacity && { o: .75 }), e: 'io' },
    ] }),
  }));
  await api.edit(ctx, { ops: [
    { op: 'add', src: 'v1' }, { op: 'add', src: 'v2' }, { op: 'loudness', lufs: 0 }, { op: 'captions', style: 'none' },
    ...(count ? [{ op: 'scene', spec: { v: 1, at: 1, duration: 2, styles: [{ id: 'red', color: '#F03838' }], layers } }] : []),
  ] });
} else if (mode === 'cold' || mode === 'cached') {
  const p = await api.openProject(project, false);
  const scene = (await p.timeline()).scenes?.[0]?.id;
  const start = performance.now();
  const result = await api.render(ctx, {
    preview: true, ...(scene ? { scene } : { range: [1, 3] }),
    parallel: 1, out: `${mode}.mp4`, wait: 600,
  });
  assert.equal(result.state, 'done', JSON.stringify(result));
  const detail = result.result as Record<string, unknown>;
  assert.deepEqual(detail.span, [0, 4]);
  assert.equal(detail.units, 2);
  assert.equal(detail.unitsCached, mode === 'cold' ? 0 : 2, 'use a fresh benchmark directory');
  console.log(JSON.stringify({ variant, kind, count, mode, wallMs: Math.round(performance.now() - start),
    renderMs: detail.ms, units: detail.units, cached: detail.unitsCached }));
} else if (mode === 'verify') {
  function verify(file: string) {
    const out = path.join(project, file);
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
      'stream=codec_type,width,height,nb_read_frames,duration:format=duration', '-of', 'json', out]).toString());
    assert.equal(probe.streams[0].codec_type, 'video');
    assert.equal(probe.streams[1].codec_type, 'audio');
    assert.deepEqual([probe.streams[0].width, probe.streams[0].height, Number(probe.streams[0].nb_read_frames)], [540, 960, 120]);
    assert.equal(Number(probe.format.duration), 4);
    const pixels = ff(['-i', out, '-vf', "select='eq(n,29)+eq(n,59)+eq(n,60)+eq(n,89)+eq(n,90)'",
      '-an', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    assert.equal(pixels.length, 540 * 960 * 3 * 5);
    for (let i = 0; i < count; i++) {
      const x = Math.floor((.15 + .23 * (i % 4)) * 540), y = Math.floor((.16 + .21 * Math.floor(i / 4)) * 960);
      const reds = [0, 1, 2, 3, 4].map((f) => {
        const at = 3 * ((f * 960 + y) * 540 + x);
        return pixels[at]! - pixels[at + 1]!;
      });
      assert.ok(Math.abs(reds[0]!) < 20 && Math.abs(reds[4]!) < 20, `tile ${i} leaks outside scene`);
      assert.ok(reds.slice(1, 4).every((v) => v > 75), `tile ${i} missing at boundary: ${reds}`);
      assert.ok(Math.abs(reds[1]! - reds[2]!) < 18, `tile ${i} jumps across unit boundary: ${reds}`);
      if (opacity) assert.ok(reds[1]! > reds[3]! + 8, `tile ${i} opacity did not advance`);
      if (translation) {
        const edge = Math.floor((.15 + .23 * (i % 4) - .065) * 540);
        const at = 3 * ((3 * 960 + y) * 540 + edge);
        assert.ok(pixels[at]! - pixels[at + 1]! < 25, `tile ${i} did not translate`);
      }
    }
    return pixels;
  }
  assert.deepEqual(verify('cold.mp4'), verify('cached.mp4'));
  const frameHash = (file: string) => ff(['-i', path.join(project, file), '-map', '0:v:0', '-f', 'framemd5', '-']);
  const decoded = frameHash('cold.mp4');
  assert.deepEqual(decoded, frameHash('cached.mp4'));
  console.log(JSON.stringify({ variant, kind, count, frames: 120, boundaryFrame: 60, sampledPixelsMatch: true,
    videoHash: createHash('sha256').update(decoded).digest('hex') }));
} else {
  throw new Error('usage: node bench/visual-scenes.ts setup|cold|cached|verify <scratch-dir> <0|1|8|16> [animated|static|translate|opacity] [rect|path]');
}
