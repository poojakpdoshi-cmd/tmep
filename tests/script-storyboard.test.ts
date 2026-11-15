import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as api from '../packages/engine/src/api.ts';
import { compileStoryboard } from '../packages/story/src/storyboard.ts';

const short = 'First, sort the records. Next, group matching keys. Finally, count each group. Totals show the key counts.';
const lesson = short + ' A key is the value used to identify a group. ' +
  'When two records share the same key, they go into the same group. ' +
  'Each group gets its own count, even if another group has the same number of records. ' +
  'You can compare the counts to see which keys appear most often.';

test('educational script creates ordered animated scenes with cumulative frame timing', () => {
  const script = '  ' + lesson + '\r\n';
  const plan = api.planScript(script);
  assert.equal(plan.storyboard.script, script);
  assert.ok(plan.frames / 30 >= 20 && plan.frames / 30 <= 30);
  const first = plan.storyboard.scenes[0]!;
  assert.equal(first.template, 'process');
  assert.ok(plan.storyboard.scenes.slice(1).every((scene) => scene.template === 'explanation'));
  assert.deepEqual(first.steps,
    ['sort the records', 'group matching keys', 'count each group']);
  const compiled = compileStoryboard(plan.storyboard);
  let expected = 0;
  for (const { frames, spec } of compiled.scenes) {
    assert.equal(spec.at, expected / 30);
    assert.equal(spec.duration, frames / 30);
    expected += frames;
  }
  assert.equal(expected, plan.frames);
  assert.ok(api.planScript(script, { wpm: 120 }).frames > plan.frames);
  assert.equal(api.planScript(short, { wpm: 137 }).frames, Math.round(short.split(/\s+/).length * 1800 / 137));
  assert.equal(api.planScript('First, sort the records, then count each group.').storyboard.scenes.length, 1);
  assert.deepEqual(api.planScript(script), plan);
});

test('rejects empty, ambiguous, invalid and over-limit plans', () => {
  for (const script of ['', '  ', null, '…?!', 'Do this. Then that.']) {
    assert.throws(() => api.planScript(script), /plain text|clear subject/);
  }
  assert.throws(() => api.planScript('x'.repeat(20001)), /20,000/);
  assert.throws(() => api.planScript('Sort the records. '.repeat(17)), /16 scenes/);
  assert.throws(() => api.planScript('Sort '.repeat(61) + 'records.', { wpm: 60 }), /60 seconds/);
  assert.throws(() => api.planScript(short, { wpm: 0 }), /wpm/);
  assert.throws(() => api.planScript(short, { narration: 'v1' }), /narration/);
});

test('CLI exports editable JSON and renders a new revision without replacing an earlier one', { timeout: 120_000 }, async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'tmep-script-'));
  t.after(() => rm(project, { recursive: true, force: true, maxRetries: 5 }));
  const ctx = { project, detail: 'standard' } as const;
  const file = path.join(project, 'script.txt');
  await writeFile(file, short);
  const wav = path.join(project, 'voice.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.5', wav]);
  await api.importMedia(ctx, { paths: [wav] });
  const p = await api.openProject(project);
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath,
    ['bin/tmep.js', 'script', file, '-p', project, '--narration', 'a1', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const exported = cli();
  assert.equal(exported.narration, 'a1');
  assert.equal(exported.script, short);
  assert.equal((await p.manifest()).head, 0);
  const saved = cli('--compile-only');
  const original = await p.revision(saved.rev);

  const first = cli('--preview', '--out', 'first.mp4');
  assert.equal(first.state, 'done');
  assert.ok(first.rev > original.rev);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,width,height,nb_frames', '-of', 'json', path.join(project, 'first.mp4')], { encoding: 'utf8' }));
  assert.deepEqual(probe.streams.map((s: { codec_type: string }) => s.codec_type), ['video', 'audio']);
  assert.equal(probe.streams[0].width, 540);
  assert.equal(probe.streams[0].height, 960);
  assert.equal(Number(probe.streams[0].nb_frames), saved.frames);
  const vectors = await readdir(p.cachePath('vectors'));
  assert.equal(vectors.length, 1);
  const cached = await api.render(ctx, { rev: original.rev, preview: true, out: 'cached.mp4', wait: 60 });
  assert.equal(cached.state, 'done');
  assert.equal(cached.cached, original.tl.clips.length);
  assert.deepEqual(await readdir(p.cachePath('vectors')), vectors);
  assert.deepEqual(await p.revision(original.rev), original);
  exported.scenes[1].title = 'Approved title';
  const edited = await api.storyboard(ctx, exported);
  assert.equal((await p.timeline(edited.rev)).scenes?.[1]?.spec.layers.find((layer) => layer.kind === 'text')?.text,
    'Approved title');
  assert.deepEqual(await p.revision(original.rev), original);
});
