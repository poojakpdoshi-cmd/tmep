import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as api from '../packages/engine/src/api.ts';
import { compileStoryboard } from '../packages/story/src/storyboard.ts';

const board = {
  v: 1, script: 'A request goes in. A result comes out.',
  scenes: [
    { template: 'process', title: 'Request flow', steps: ['Input', 'Output'], frames: 19 },
    { template: 'explanation', title: 'The result', point: 'Less waiting', frames: 23, transition: 'fade' },
  ],
};

test('storyboard compiles ordered frame timing and validates the strict plan', () => {
  const { scenes, frames } = compileStoryboard(board);
  assert.equal(frames, 42);
  assert.deepEqual(scenes.map(({ spec }) => [spec.at, spec.duration]), [[0, 19 / 30], [19 / 30, 23 / 30]]);
  // The connector draws down step by step, reaching the second step centre (half the path).
  assert.ok(scenes[0]!.spec.layers.some((layer) => layer.kind === 'path' && (layer.draw?.length ?? 0) > 2
    && Math.abs(layer.draw!.at(-1)!.to! - .5) < .01));
  assert.ok(scenes[1]!.spec.layers.some((layer) => layer.kind === 'text' && layer.keys?.length === 2));
  assert.throws(() => compileStoryboard({ ...board, typo: true }), /typo/);
  assert.throws(() => compileStoryboard({ ...board, script: '  ' }), /script/);
  assert.throws(() => compileStoryboard({ ...board, scenes: [{ ...board.scenes[0], frames: 8.5 }] }), /integer/);
  const custom = { template: 'custom', frames: 7, visual: { layers: [{ id: 'r', kind: 'ellipse', w: .2, h: .2 }] } };
  assert.equal(compileStoryboard({ ...board, scenes: [custom] }).scenes[0]!.spec.layers[0]!.kind, 'ellipse');
});

test('CLI renders animated storyboard with optional narration and reuses its caches', { timeout: 120_000 }, async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'tmep-storyboard-'));
  t.after(() => rm(project, { recursive: true, force: true, maxRetries: 5 }));
  const ctx = { project, detail: 'standard' } as const;
  const file = path.join(project, 'plan.json');
  const audio = path.join(project, 'voice.wav');
  function run(bin: string, args: string[], maxBuffer?: number) {
    const result = spawnSync(bin, args, { maxBuffer, windowsHide: true });
    assert.equal(result.status, 0, String(result.stderr) + String(result.stdout) + (result.error ?? ''));
    return result.stdout;
  }

  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.8:sample_rate=48000', audio]);
  await api.importMedia(ctx, { paths: [audio] });
  await writeFile(file, JSON.stringify({ ...board, narration: 'a1' }));
  const first = JSON.parse(String(run(process.execPath, ['bin/tmep.js', 'storyboard', file, '-p', project, '--out', 'first.mp4'])));
  assert.equal(first.state, 'done');
  const p = await api.openProject(project);
  const tl = await p.timeline(first.rev);
  assert.equal(tl.settings.ratio, '9:16');
  assert.deepEqual(tl.meta.storyboard, { v: 1, script: board.script });
  const invalid = { ...board, scenes: [{ template: 'custom', frames: 12, visual: { layers: [{ id: 'bad', kind: 'image', asset: 'missing', w: .5, h: .5 }] } }] };
  await assert.rejects(api.storyboard(ctx, invalid), /missing/);
  assert.equal((await p.manifest()).head, first.rev);
  const probe = JSON.parse(String(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,nb_frames', '-of', 'json', path.join(project, 'first.mp4')])));
  assert.deepEqual(probe.streams.map((s: { codec_type: string }) => s.codec_type), ['video', 'audio']);
  assert.equal(probe.streams[0].width, 1080);
  assert.equal(probe.streams[0].height, 1920);
  assert.equal(Number(probe.streams[0].nb_frames), 42);

  const digest = (name: string) => String(run('ffmpeg', ['-v', 'error', '-i', path.join(project, name), '-map', '0:v', '-f', 'framemd5', '-']));
  const hashes = digest('first.mp4');
  const frames = hashes.split(/\r?\n/).filter((line) => /^0,/.test(line)).map((line) => line.split(',').at(-1));
  assert.notEqual(frames[0], frames[16]);
  assert.notEqual(frames[19], frames[38]);
  const rasterDir = p.cachePath('vectors');
  const rasters = await readdir(rasterDir);
  assert.equal(rasters.length, 1);
  const second = await api.storyboard(ctx, { ...board, script: 'Revised notes.', narration: 'a1' });
  const rendered = await api.render(ctx, { rev: second.rev, out: 'cached.mp4', parallel: 1, wait: 60 });
  assert.equal(rendered.state, 'done');
  assert.equal(rendered.cached, tl.clips.length);
  assert.deepEqual(await readdir(rasterDir), rasters);
  assert.equal(digest('cached.mp4'), hashes);
  const samples = run('ffmpeg', ['-v', 'error', '-i', path.join(project, 'first.mp4'), '-map', '0:a', '-ac', '1', '-f', 's16le', '-']);
  assert.ok(samples.subarray(0, 9600).some((v) => v !== 0));
  assert.ok(samples.subarray(48000 * 2).every((v) => v === 0));
});
