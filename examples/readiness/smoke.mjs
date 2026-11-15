import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../bin/tmep.js', import.meta.url));
const lesson = fileURLToPath(new URL('./lesson.txt', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'tmep smoke '));

function run(bin, args, expected = 0) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, expected, result.stderr + result.stdout);
  return result.stdout;
}

function tmep(project, args, expected) {
  return JSON.parse(run(process.execPath, [cli, '-p', project, ...args], expected));
}

function verify(project, file, width, height, frames) {
  const { streams } = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,nb_frames,r_frame_rate', '-of', 'json', path.join(project, file)]));
  const video = streams.find((stream) => stream.codec_type === 'video');
  assert.ok(video, `${file}: missing video stream`);
  assert.deepEqual([video.codec_name, video.width, video.height, video.r_frame_rate, Number(video.nb_frames)],
    ['h264', width, height, '30/1', frames]);
  assert.ok(streams.some((stream) => stream.codec_name === 'aac'));
}

function render(project, name, preview = false) {
  const result = tmep(project, ['render', ...(preview ? ['--preview'] : []), '--out', name]);
  assert.equal(result.state, 'done', JSON.stringify(result));
  return result;
}

try {
  const storyboard = path.join(root, 'story project');
  mkdirSync(storyboard);
  const plan = tmep(storyboard, ['script', lesson]);
  assert.equal(plan.script, readFileSync(lesson, 'utf8'));
  assert.deepEqual(plan.scenes.map(({ template }) => template), ['process', 'explanation']);
  const frames = plan.scenes.reduce((sum, scene) => sum + scene.frames, 0);
  const planFile = path.join(storyboard, 'storyboard.json');
  writeFileSync(planFile, JSON.stringify(plan, null, 2));
  const revision = tmep(storyboard, ['storyboard', planFile, '--compile-only']);
  assert.equal(revision.frames, frames);
  assert.equal(tmep(storyboard, ['inspect', 'scenes']).ok, true);

  const invalidFile = path.join(storyboard, 'invalid.json');
  writeFileSync(invalidFile, JSON.stringify({ ...plan, scenes: [] }));
  assert.equal(tmep(storyboard, ['storyboard', invalidFile, '--compile-only'], 1).err.code, 'E_INPUT');
  assert.equal(tmep(storyboard, ['inspect', 'project']).rev, revision.rev);
  const preview = render(storyboard, 'preview.mp4', true);
  verify(storyboard, 'preview.mp4', 540, 960, frames);
  const cached = render(storyboard, 'cached.mp4', true);
  assert.equal(cached.cached, preview.units);
  const digest = (file) => run('ffmpeg', ['-v', 'error', '-i', path.join(storyboard, file), '-map', '0:v', '-f', 'framemd5', '-']);
  assert.equal(digest('preview.mp4'), digest('cached.mp4'));
  render(storyboard, 'export.mp4');
  verify(storyboard, 'export.mp4', 1080, 1920, frames);
  console.log(`Script workflow passed: ${frames} frames, ${cached.cached}/${preview.units} cached preview units.`);

  const raw = path.join(root, 'raw project');
  mkdirSync(raw);
  for (const [name, color, frequency] of [['red', 'red', 440], ['blue', 'blue', 660]]) {
    run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=180x320:r=30:d=1`,
      '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=1`, '-c:v', 'libx264', '-c:a', 'aac',
      '-shortest', path.join(raw, `${name}.mp4`)]);
  }
  assert.deepEqual(tmep(raw, ['import', 'red.mp4', 'blue.mp4']).assets.map(({ id }) => id), ['v1', 'v2']);
  const original = tmep(raw, ['edit', 'add v1', 'add v2']);
  const before = tmep(raw, ['inspect', 'timeline', '--rev', String(original.rev)]);
  const edited = tmep(raw, ['edit', 'cut 0.5 1']);
  assert.equal(edited.dur, 1.5);
  assert.deepEqual(tmep(raw, ['inspect', 'timeline', '--rev', String(original.rev)]), before);
  assert.equal(tmep(raw, ['undo']).rev, original.rev);
  assert.equal(tmep(raw, ['redo']).rev, edited.rev);
  render(raw, 'edited.mp4', true);
  verify(raw, 'edited.mp4', 540, 960, 45);
  console.log('Raw clips workflow passed: two inputs, undo/redo, 45 output frames.');
} finally {
  if (process.argv.includes('--keep')) console.log(`Smoke-test files: ${root}`);
  else rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
