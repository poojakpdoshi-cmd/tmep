import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    ['Sort the records', 'Group matching keys', 'Count each group']);
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
test('explicit comparisons retain both claims and animate them in the same scene', () => {
  const script = 'A paper map works offline, while a live map updates traffic.';
  const planned = api.planScript(script);
  assert.deepEqual(planned.storyboard.scenes, [{
    frames: 132, transition: 'cut', template: 'comparison',
    first: 'A paper map works offline', second: 'A live map updates traffic',
  }]);
  const [scene] = compileStoryboard(planned.storyboard).scenes;
  const claims = scene!.spec.layers.filter((layer) => layer.kind === 'text');
  assert.deepEqual(claims.map(({ text }) => text.replaceAll('\n', ' ')),
    ['A paper map works offline', 'A live map updates traffic']);
  assert.ok(claims[1]!.start > claims[0]!.start);
  assert.ok(claims.every(({ keys }) => keys?.length === 2));
});

const lessonFixture = 'examples/creator-quality/solar-lesson.txt';

test('planner labels keep whole phrases and never repeat a process step as its title', async () => {
  const script = await readFile(lessonFixture, 'utf8');
  const [process, explanation, comparison] = api.planScript(script).storyboard.scenes;
  // A question line before a step run titles the process instead of becoming a fragment scene.
  assert.deepEqual(process, {
    frames: 324, transition: 'cut', template: 'process', title: 'How does a solar panel make electricity?',
    steps: ['Sunlight strikes silicon cells', 'The light knocks electrons loose', 'Wires carry that current'],
    cues: [84, 156, 228],
  });
  // Explanations split at a clause boundary, not after the third word.
  assert.deepEqual(explanation, { frames: 144, transition: 'fade', template: 'explanation',
    title: 'An inverter converts direct current', point: 'Into alternating current your outlets use' });
  assert.deepEqual(comparison, { frames: 180, transition: 'fade', template: 'comparison',
    first: 'Direct current flows in one steady direction', second: 'Alternating current reverses many times' });
  const labels = api.planScript(script).storyboard.scenes.flatMap((scene) => Object.values(scene).filter((v) => typeof v === 'string' || Array.isArray(v)).flat());
  assert.ok(labels.every((value) => typeof value !== 'string' || !/(?:…|\b(?:a|an|the|of|to|into|your)\s*)$/iu.test(value)));
  // Without a heading the title names the run rather than duplicating step one.
  const plain = api.planScript('First, sort the records. Next, group matching keys. Finally, count each group.');
  assert.equal(plain.storyboard.scenes[0]!.template === 'process' && plain.storyboard.scenes[0]!.title, '3 steps');
  // A clause that cannot be shortened at a boundary still falls back to a marked word cut.
  const long = api.planScript('Engineers measure the extraordinarily complicated interconnected thermodynamic behaviour carefully, whereas students guess quickly.');
  const first = long.storyboard.scenes[0]!.template === 'comparison' ? long.storyboard.scenes[0]!.first : '';
  assert.ok(first.endsWith('…') && first.length <= 44, first);
});

test('process steps enter on narration cues and the connector follows them', () => {
  const base = { v: 1 as const, script: 'Steps.', scenes: [{ template: 'process' as const, title: 'Flow', steps: ['Input', 'Check', 'Output'], frames: 300 }] };
  const starts = (board: unknown) => {
    const layers = compileStoryboard(board).scenes[0]!.spec.layers;
    return { steps: layers.filter((l) => l.id.startsWith('step')).map((l) => l.start),
      draw: (layers.find((l) => l.id === 'connector') as { draw: { t: number; to: number }[] }).draw };
  };
  // Legacy storyboards without cues spread the steps across the scene instead of the first 1.2 s.
  assert.deepEqual(starts(base).steps, [.4, 100 / 30, 200 / 30]);
  const cued = starts({ ...base, scenes: [{ ...base.scenes[0]!, cues: [60, 90, 240] }] });
  assert.deepEqual(cued.steps, [2, 3, 8]);
  for (let n = 1; n < cued.draw.length; n++) {
    assert.ok(cued.draw[n]!.t > cued.draw[n - 1]!.t && cued.draw[n]!.to >= cued.draw[n - 1]!.to);
  }
  assert.ok(cued.draw.some(({ t, to }) => t === 8 && to < .6), 'connector holds until the last step enters');
  assert.ok(cued.steps.every((t) => Number.isInteger(Math.round(t * 30 * 1e6) / 1e6)), 'starts sit on the 30 fps grid');
  // Very short scenes still keep every entrance inside the scene.
  const tiny = starts({ ...base, scenes: [{ ...base.scenes[0]!, frames: 12, cues: [0, 5, 11] }] });
  assert.ok(tiny.steps.every((t) => t < 12 / 30) && tiny.draw.every(({ t }) => t < 12 / 30));
  for (const cues of [[0, 90], [90, 60, 120], [0, 60, 300]]) {
    assert.throws(() => compileStoryboard({ ...base, scenes: [{ ...base.scenes[0]!, cues }] }), /cues/);
  }
});

test('longest planner labels fit their boxes without clipping or collisions', { timeout: 60_000 }, async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'tmep-labels-'));
  t.after(() => rm(project, { recursive: true, force: true, maxRetries: 5 }));
  const ctx = { project, detail: 'standard' } as const;
  // Wide-glyph labels at each planner limit: title 40, step 32, point 44, claim 44 characters.
  const title = 'Why does warm moist air make wet storms?';
  const step = 'Workers move heavy metal frames!';
  const claim = 'Moving water makes power when meeting mills!';
  const board = { v: 1, script: 'Fit check.', scenes: [
    { template: 'process', title, steps: [step, step, step], frames: 90 },
    { template: 'explanation', title, point: 'Mammals migrate when warm weather wanes now!', frames: 60, transition: 'fade' },
    { template: 'comparison', first: claim, second: claim, frames: 60, transition: 'fade' },
  ] };
  assert.deepEqual([title.length, step.length, claim.length], [40, 32, 44]);
  const { rev } = await api.storyboard(ctx, board);
  const report = await api.inspect(ctx, { what: 'scenes', rev });
  assert.deepEqual(report.issues, []);
  const solar = await api.storyboard(ctx, api.planScript(await readFile(lessonFixture, 'utf8')).storyboard);
  assert.deepEqual((await api.inspect(ctx, { what: 'scenes', rev: solar.rev })).issues, []);
});
