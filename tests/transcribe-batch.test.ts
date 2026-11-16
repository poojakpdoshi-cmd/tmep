import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hashOf, Project, writeJson } from '../packages/core/src/index.ts';
import { makeTranscript, parseWhisperCppJson } from '../packages/speech/src/transcript.ts';

test('Whisper.cpp preserves usable token starts and flags reconstructed timing', () => {
  const parsed = parseWhisperCppJson({ result: { language: 'en' }, transcription: [
    { text: 'Green notebook.', offsets: { from: 0, to: 500 }, tokens: [
      { text: ' Green', offsets: { from: 20, to: 20 } },
      { text: ' notebook.', offsets: { from: 240, to: 500 } },
    ] },
    { text: 'Check it.', offsets: { from: 1200, to: 1800 }, tokens: [
      { text: ' Check', offsets: { from: 0, to: 0 } },
      { text: ' it.', offsets: { from: 0, to: 0 } },
    ] },
  ] });
  const transcript = makeTranscript('whisper.cpp', parsed.lang, parsed.words, { approx: parsed.approx });
  assert.equal(transcript.approx, true);
  assert.deepEqual(transcript.words.slice(0, 2), [
    { w: 'Green', s: .02, e: .03 }, { w: 'notebook.', s: .24, e: .5 },
  ]);
  assert.equal(transcript.words[2]!.s, 1.2);
});

test('batch preserves precise cached words, reports partial failures, and invalidates incompatible caches', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tmep speech batch '));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const project = await Project.open(root, { create: true });
  const model = path.join(root, 'missing model.bin');
  const binary = path.join(root, 'missing whisper.exe');
  const inputs = [];
  for (let i = 0; i < 2; i++) {
    const media = path.join(root, `clip ${i}.wav`);
    await writeFile(media, '');
    const { asset } = await project.addAsset({ kind: 'audio', audio: true, path: media, dur: 2, hash: 'data' + i, name: media, size: 0 });
    const key = hashOf({ a: asset.hash, engine: 'whisper.cpp', lang: 'en', model: null, prompt: null, f: null });
    const cache = project.cachePath('tr', key + '.json');
    const tr = makeTranscript('whisper.cpp', 'en', [
      { w: 'Green', s: .123, e: .501 },
      { w: 'notebook.', s: .51, e: .994 },
    ]);
    await writeJson(cache, tr);
    inputs.push({ key, cache, tr });
  }
  const cli = (args: string[], exit: number, bin = binary) => {
    const result = spawnSync(process.execPath, ['bin/tmep.js', ...args, '-p', root,
      '--engine', 'whisper.cpp', '--lang', 'en'], { encoding: 'utf8',
      env: { ...process.env, TMEP_WHISPER_CPP: bin, TMEP_WHISPER_MODEL: model } });
    assert.ifError(result.error);
    assert.equal(result.status, exit, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  const partial = cli(['transcribe-batch', 'a1', 'a99', 'a2', 'a1'], 1);
  assert.deepEqual(partial.assets.map((a: { status: string }) => a.status), ['cached', 'cached']);
  assert.equal(partial.failures[0].err.code, 'E_NOT_FOUND');
  assert.deepEqual(partial.assets[0].segments, [[.123, .994]]);
  assert.equal(partial.assets[0].tr, `.tmep/cache/tr/${inputs[0]!.key}.json`);
  assert.ok(Buffer.byteLength(JSON.stringify(partial)) < 750);
  for (const { cache, tr } of inputs) assert.deepEqual(JSON.parse(await readFile(cache, 'utf8')), JSON.parse(JSON.stringify(tr)));
  assert.equal(cli(['transcribe', 'a1'], 0).cached, true);

  const missingModel = cli(['transcribe-batch', 'a1', '--model', model], 1, process.execPath);
  assert.match(missingModel.failures[0].err.msg, /model not found/);
  assert.equal(missingModel.failures[0].err.code, 'E_ENGINE_MISSING');
  const forced = cli(['transcribe-batch', 'a1', '--force'], 1);
  assert.match(forced.failures[0].err.msg, /whisper-cli not found/);
  await writeFile(inputs[1]!.cache, '{truncated');
  const corrupt = cli(['transcribe-batch', 'a1', 'a2'], 1);
  assert.equal(corrupt.assets[0].id, 'a1');
  assert.equal(corrupt.failures[0].id, 'a2');
  assert.equal((await project.asset('a1')).tr, inputs[0]!.key);
});
