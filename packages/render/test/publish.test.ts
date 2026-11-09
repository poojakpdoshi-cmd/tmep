/**
 * Deterministic tests for cache publication (render.ts publish()): every branch is forced
 * explicitly, independent of OS rename semantics and of process timing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { publish } from '../src/render.ts';

const dir = () => mkdtempSync(path.join(os.tmpdir(), 'tmep-publish-'));
const isValid = async (f: string) => readFileSync(f, 'utf8').startsWith('VALID');
const never = async () => {
  throw new Error('validate must not be called');
};

test('publish moves a complete temp file into place', async () => {
  const d = dir();
  const tmp = path.join(d, 'e.mp4.1.ab.tmp.mp4');
  const dest = path.join(d, 'e.mp4');
  writeFileSync(tmp, 'VALID new');
  await publish(tmp, dest, never);
  assert.equal(readFileSync(dest, 'utf8'), 'VALID new');
  assert.equal(existsSync(tmp), false);
});

test('publishing over an existing entry leaves one complete entry and no temp file (any OS)', async () => {
  const d = dir();
  const dest = path.join(d, 'e.mp4');
  writeFileSync(dest, 'VALID old');
  const tmp = path.join(d, 'e.mp4.2.cd.tmp.mp4');
  writeFileSync(tmp, 'VALID new');
  // POSIX: atomic replace (validate not needed); Windows: rename may fail -> existing entry validated
  await publish(tmp, dest, isValid);
  assert.ok(['VALID old', 'VALID new'].includes(readFileSync(dest, 'utf8')));
  assert.equal(existsSync(tmp), false);
});

test('a failed rename is accepted only when the existing entry validates', async () => {
  const d = dir();
  const dest = path.join(d, 'e.mp4');
  writeFileSync(dest, 'VALID published by another process');
  // the temp file is gone -> rename fails (the pre-fix ENOENT race); existing valid entry is kept
  let calls = 0;
  await publish(path.join(d, 'missing.tmp.mp4'), dest, async (f) => (calls++, isValid(f)));
  assert.equal(calls, 1, 'existing entry was validated');
  assert.equal(readFileSync(dest, 'utf8'), 'VALID published by another process');
});

test('a failed rename with an invalid or missing entry throws the original error', async () => {
  const d = dir();
  const bad = path.join(d, 'bad.mp4');
  writeFileSync(bad, 'TRUNCATED');
  await assert.rejects(publish(path.join(d, 'missing.tmp.mp4'), bad, isValid), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
  await assert.rejects(publish(path.join(d, 'missing.tmp.mp4'), path.join(d, 'absent.mp4'), isValid), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
  // rename onto a non-empty directory fails on every OS; it must not be accepted
  const dirDest = path.join(d, 'adir');
  mkdirSync(dirDest);
  writeFileSync(path.join(dirDest, 'x'), '');
  const tmp = path.join(d, 'z.tmp.mp4');
  writeFileSync(tmp, 'VALID');
  await assert.rejects(publish(tmp, dirDest, async () => false));
  assert.equal(existsSync(tmp), true, 'temp kept for the caller to clean up');
});
