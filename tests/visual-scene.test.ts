import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as api from '../packages/engine/src/api.ts';

test('scene edits render over synthetic media and reuse the video cache', { timeout: 120_000 }, async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'tmep-scene-'));
  t.after(() => rm(project, { recursive: true, force: true, maxRetries: 5 }));
  const ctx = { project, detail: 'standard' } as const;
  function ff(args: string[]) {
    const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', ...args]);
    assert.equal(result.status, 0, String(result.stderr ?? result.error));
    return result.stdout;
  }
  const colors = ['black', 'gray', 'blue'];
  const files = colors.map((color) => {
    const file = path.join(project, color + '.mp4');
    ff(['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:r=30:d=1`, '-c:v', 'libx264', file]);
    return file;
  });
  await api.importMedia(ctx, { paths: files });
  const transcript = path.join(project, 'synthetic-transcript.json');
  await writeFile(transcript, JSON.stringify({ words: [{ w: 'cue', s: .5, e: .6 }] }));
  await api.transcribe(ctx, { asset: 'v1', file: transcript });
  const spec = {
    v: 1, at: '@cue', duration: 1, camera: [{ t: 0, x: 0 }, { t: .8, x: .05 }],
    styles: [{ id: 'red', color: '#FF0000' }],
    layers: [
      { id: 'footage', kind: 'video', asset: 'v3', x: .75, y: .3, w: .15, h: .1 },
      { id: 'label', kind: 'text', text: 'Scene', y: .5, w: .3, h: .1 },
      { id: 'mark', kind: 'rect', style: 'red', x: .25, y: .3, w: .18, h: .12,
        keys: [{ t: 0, o: 1 }, { t: .8, o: .7 }] },
    ],
  };
  await assert.rejects(api.edit(ctx, { ops: [
    { op: 'add', src: 'v1' }, { op: 'scene', spec: { ...spec, at: 1 } },
  ] }), /outside the timeline/);
  assert.equal((await (await api.openProject(project, false)).manifest()).head, 0);
  const edit = await api.edit(ctx, { ops: ['add v1', 'add v2', { op: 'loudness', lufs: 0 }, { op: 'scene', spec }] });
  assert.equal(edit.rev, 1);
  const scene = (edit.ids as string[]).at(-1)!;
  assert.deepEqual(await api.inspect(ctx, { what: 'scenes', scene }), { ok: true, issues: [], truncated: false });
  const draft = await api.inspect(ctx, { what: 'scenes', spec: { ...spec, duration: 5 } });
  assert.equal(draft.ok, false);
  assert.equal((await (await api.openProject(project, false)).manifest()).head, 1);
  await assert.rejects(api.render(ctx, { scene, range: [0, 1.2] }), /scene preview range/);
  const first = await api.render(ctx, { preview: true, parallel: 1, wait: 60 });
  if (first.state !== 'done') assert.fail(JSON.stringify(await api.status({ ...ctx, detail: 'debug' }, { job: first.job as string })));
  const out = path.join(project, first.out as string);
  function rgb(at: string, x: number, y: number) {
    return ff(['-ss', at, '-i', out, '-vf', `crop=2:2:${x}:${y}`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  }
  // Red shape and blue overlay remain visible on both sides of the video unit boundary.
  for (const at of ['0.8', '1.2']) {
    const [r, , b] = rgb(at, 143, 288);
    assert.ok(r! > b! + 60, `red ASS layer at ${at}: ${r},${b}`);
    const [red, , blue] = rgb(at, 411, 288);
    assert.ok(blue! > red! + 60, `blue video overlay at ${at}: ${red},${blue}`);
  }
  const text = ff(['-ss', '0.8', '-i', out, '-vf', 'crop=160:96:190:432',
    '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
  assert.ok(text.some((v) => v > 200), 'white text is composited onto the dark clip');
  const cached = await api.render(ctx, { preview: true, out: 'alternate.mp4', parallel: 1, wait: 60 });
  assert.equal(cached.state, 'done', JSON.stringify(cached));
  assert.equal(cached.cached, 2);
  const preview = await api.render(ctx, { scene, range: [.18, .78], out: 'scene-preview.mp4', parallel: 1, wait: 60 });
  assert.equal(preview.state, 'done', JSON.stringify(preview));
  assert.deepEqual(preview.span, [0, 2]);
  assert.equal(preview.size, '540x960');
  assert.equal(preview.cached, 2);
});

test('path layers render frame-exact across video units and reuse their cached raster', { timeout: 120_000 }, async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'tmep-path-'));
  t.after(() => rm(project, { recursive: true, force: true, maxRetries: 5 }));
  const ctx = { project, detail: 'debug' } as const;
  function ff(args: string[]) {
    const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', ...args]);
    assert.equal(result.status, 0, String(result.stderr ?? result.error));
    return result.stdout;
  }
  const files = ['black', '0x101010'].map((color, i) => {
    const file = path.join(project, `clip-${i}.mp4`);
    ff(['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:r=30:d=1`, '-c:v', 'libx264', file]);
    return file;
  });
  await api.importMedia(ctx, { paths: files });
  // A 216 px red square moving 0.3 frame widths in 0.8 s (6.75 output px per preview frame), plus a
  // stroke drawn on along a curve. The scene crosses the unit boundary at 1 s.
  const square = { id: 'square', kind: 'path', x: .3, y: .3, w: .2, h: .1125, stroke: 0, fill: '#FF0000',
    d: 'M0 0 H100 V100 H0 Z', keys: [{ t: 0, x: 0 }, { t: .8, x: .3, e: 'linear' }] };
  const curve = { id: 'curve', kind: 'path', x: .5, y: .7, w: .6, h: .1, view: { w: 600, h: 100 }, stroke: 8,
    d: 'M10 90 C 200 0 400 0 590 90', draw: [{ t: 0, to: 0 }, { t: .6, to: 1, e: 'out' }] };
  const label = { id: 'label', kind: 'text', text: 'Path', x: .5, y: .5, w: .3, h: .06 };
  const spec = { v: 1, at: .5, duration: 1, layers: [square, curve, label] };
  const edit = await api.edit(ctx, { ops: ['add v1', 'add v2', { op: 'loudness', lufs: 0 }, { op: 'captions', style: 'none' }, { op: 'scene', spec }] });
  const scene = (edit.ids as string[]).at(-1)!;
  assert.deepEqual(await api.inspect(ctx, { what: 'scenes', scene }), { ok: true, issues: [], truncated: false });
  const first = await api.render(ctx, { preview: true, parallel: 1, wait: 60 });
  assert.equal(first.state, 'done', JSON.stringify(first));
  const out = path.join(project, first.out as string);
  const rows = ff(['-i', out, '-vf', `select='eq(n,29)+eq(n,30)',crop=540:2:0:288`, '-fps_mode', 'passthrough',
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  for (const [i, frame] of [29, 30].entries()) {
    // Scene-local time of this output frame, then the expected left edge of the square.
    const local = (frame - 15) / 30;
    const expected = (.3 + .3 * Math.min(1, local / .8) - .1) * 540;
    const row = rows.subarray(i * 540 * 6, i * 540 * 6 + 540 * 3);
    let left = -1;
    for (let x = 0; x < 540 && left < 0; x++) if (row[3 * x]! > 150 && row[3 * x + 1]! < 80) left = x;
    assert.ok(Math.abs(left - expected) <= 2, `frame ${frame}: square left edge ${left}, expected ${expected.toFixed(1)}`);
  }
  const vectors = path.join(project, '.tmep', 'cache', 'vectors');
  const rasters = await readdir(vectors);
  assert.equal(rasters.length, 1);
  assert.equal((await readdir(path.join(vectors, rasters[0]!))).length, 30);
  // A text-only revision re-renders its units but keeps the content-addressed raster.
  await api.edit(ctx, { ops: [{ op: 'remove', id: scene }, { op: 'scene', spec: { ...spec, layers: [square, curve, { ...label, text: 'Paths' }] } }] });
  const second = await api.render(ctx, { preview: true, parallel: 1, out: 'second.mp4', wait: 60 });
  assert.equal(second.state, 'done', JSON.stringify(second));
  assert.deepEqual(await readdir(vectors), rasters);
  const cached = await api.render(ctx, { preview: true, parallel: 1, out: 'cached.mp4', wait: 60 });
  assert.equal(cached.cached, 2);
});
