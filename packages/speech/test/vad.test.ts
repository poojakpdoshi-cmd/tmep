import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRegions, pcmData, pcmWav, joinChunks, compareVad, validateVad } from '../src/vad.ts';
import { makeTranscript } from '../src/transcript.ts';
import { speechIdentity, speechCacheKey, assertSource } from '../src/cache.ts';
import { mediaHash } from '../../core/src/index.ts';

test('speech boundaries retain original offsets and word probabilities across pauses', () => {
  const tr = makeTranscript('whisper.cpp', 'en', [{ w: 'Hello', s: .1, e: .4, p: .99 }]);
  const result = joinChunks([tr, tr], [{ start: 2, duration: 1 }, { start: 8, duration: 1 }]);
  assert.deepEqual(result.words, [{ w: 'Hello', s: 2.1, e: 2.4, p: .99 }, { w: 'Hello', s: 8.1, e: 8.4, p: .99 }]);
  assert.equal(compareVad(result, result), true);
  assert.equal(compareVad(result, tr), false);
  assert.throws(() => joinChunks([tr], [{ start: 2, duration: .1 }]), /uncertain/);
  assert.throws(() => joinChunks([{ ...tr, words: [] }], [{ start: 2, duration: 1 }]), /uncertain/);
  assert.throws(() => joinChunks([{ ...tr, words: [{ ...tr.words[0]!, p: .1 }] }], [{ start: 2, duration: 1 }]), /uncertain/);
});
test('VAD parsing merges overlaps and rejects corrupt output; WAV chunks preserve sample bytes', () => {
  assert.deepEqual(parseRegions('Detected 2 speech segments:\nSpeech segment 0: start = 100.00, end = 250.00\nSpeech segment 1: start = 200.00, end = 350.00', 3), [[1, 3]]);
  assert.throws(() => parseRegions('Detected 2 speech segments:', 10), /invalid/);
  const data = Buffer.from([0, 0, 1, 2, 3, 4]);
  assert.deepEqual(pcmData(pcmWav(data)), data);
  assert.throws(() => pcmData(pcmWav(data).subarray(0, 45)), /truncated/);
  assert.throws(() => validateVad({ vad: 'on', vadPadMs: 0 }), /vadPadMs/);
  assert.throws(() => validateVad({ vad: 'on', vadThreshold: NaN }), /vadThreshold/);
  assert.throws(() => validateVad({ vadThreshold: .5 }), /require/);
});
test('cache fingerprints model bytes and VAD configuration; modified sources require reimport', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tmep model paths '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const model = path.join(root, 'model name.bin'), media = path.join(root, 'source.wav');
  await writeFile(model, 'model A'); await writeFile(media, 'audio A');
  const a = { path: media, hash: mediaHash(media) }; assertSource(a);
  const opts = { model, vad: 'verify' as const, vadModel: path.join(root, 'vad.bin') };
  const before = await speechIdentity('whisper.cpp', opts);
  const key = speechCacheKey(a.hash, 'whisper.cpp', opts, before);
  assert.equal(speechCacheKey(a.hash, 'whisper.cpp', opts, await speechIdentity('whisper.cpp', opts)), key);
  await writeFile(model, 'model B');
  assert.notEqual(speechCacheKey(a.hash, 'whisper.cpp', opts, await speechIdentity('whisper.cpp', opts)), key);
  assert.notDeepEqual(await speechIdentity('whisper.cpp', { ...opts, vadPadMs: 800 }), before);
  await writeFile(media, 'audio B'); assert.throws(() => assertSource(a), /source changed/);
});

test('missing native VAD components fail explicitly, without fabricating speech', async () => {
  const { detectChunks } = await import('../src/vad.ts');
  await assert.rejects(detectChunks('unused.wav', 'unused', path.join(os.tmpdir(), 'not a whisper binary'), { vad: 'on', vadModel: '/missing/model.bin' }), /VAD executable or model missing/);
});
