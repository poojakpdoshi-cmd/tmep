/** Phase 7.0: explicit FFmpeg/ffprobe preflight through the CLI (exit 2 + remedy when unusable). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const bin = path.join(import.meta.dirname, '..', 'bin', 'tmep.js');
test('doctor --require fails closed without ffmpeg and passes with it', () => {
  const bad = spawnSync(process.execPath, [bin, 'doctor', '--require'], { env: { ...process.env, FRAME_FFMPEG: path.join(import.meta.dirname, 'no-such-dir', 'ffmpeg'), FRAME_FFPROBE: '' }, encoding: 'utf8' });
  assert.equal(bad.status, 2, bad.stderr);
  const j = JSON.parse(bad.stdout);
  assert.equal(j.ok, false); assert.ok(j.problems.length && j.remedy);
  const good = spawnSync(process.execPath, [bin, 'doctor', '--require'], { encoding: 'utf8' });
  if (spawnSync('ffprobe', ['-version']).status === 0) assert.equal(good.status, 0, good.stdout);
});
