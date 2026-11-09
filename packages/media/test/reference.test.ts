import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneTimes, shotPacing, analyzeReferenceReel } from '../src/reference.ts';
import { ffmpeg } from '../src/ffmpeg.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const showinfo = (t: string) => '[Parsed_showinfo_3 @ 000] n: 0 pts: 15 pts_time:' + t + ' fmt:yuv420p';

test('reference parser accepts only showinfo PTS, ignores close duplicates and invalid bounds', () => {
  const log = [
    'frame= 123 fps=30 time=00:00:02',
    '[Parsed_select_2 @ 1] pts_time:0.6',
    showinfo('0'), showinfo('1.050'), showinfo('1.11'),
    showinfo('2.40'), showinfo('3.00'), showinfo('bad'), showinfo('999'),
  ].join('\n');
  assert.deepEqual(parseSceneTimes(log, 3, 0.2), [1.05, 2.4]);
});

test('shot pacing includes first/last shots and calculates rate and median', () => {
  assert.deepEqual(shotPacing([1, 3, 6], 10), {
    cutCount: 3, meanShotSec: 2.5, medianShotSec: 2.5, cutsPerMinute: 18, pacing: 'medium',
  });
  assert.equal(shotPacing([], 8).meanShotSec, 8);
  assert.equal(shotPacing([0.2, 0.4, 0.6, 0.8], 1).pacing, 'high');
  assert.throws(() => shotPacing([3, 2], 4));
  assert.throws(() => parseSceneTimes('', -1));
});

test('reference analysis validates options before launching FFmpeg', async () => {
  await assert.rejects(analyzeReferenceReel('/file/does/not/matter.mp4', { sampleFps: 0 }));
  await assert.rejects(analyzeReferenceReel('/file/does/not/matter.mp4', { threshold: Infinity }));
});

test('reference analyzer finds hard cut in generated two-color video', { timeout: 90000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tmep-ref-'));
  try {
    const out = path.join(dir, 'two-colors.mp4');
    try {
      await ffmpeg({ args: [
        '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=15:d=1',
        '-f', 'lavfi', '-i', 'color=c=white:s=160x90:r=15:d=1',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[outv]',
        '-map', '[outv]', '-c:v', 'mpeg4', '-q:v', '3', out,
      ] });
    } catch {
      return t.skip('FFmpeg synthetic fixture unavailable');
    }
    const result = await analyzeReferenceReel(out, { sampleFps: 15, threshold: 0.1 });
    assert.equal(result.method, 'ffmpeg-scene-sampled-v1');
    assert.ok(result.cuts.some((at) => Math.abs(at - 1) <= 0.15), 'expected cut near 1.0s; got ' + JSON.stringify(result.cuts));
    assert.equal(result.truncated, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
