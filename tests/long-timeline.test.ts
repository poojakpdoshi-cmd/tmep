/**
 * Long timelines (Stabilization A5).
 *
 * A render of a few hundred clips must not depend on how many clips fit on one command line.
 * Windows starts no process whose command line exceeds 32,767 characters; the renders below run
 * in child processes with that limit enforced (`TMEP_CMDLINE_LIMIT`), so a command that grows
 * with the timeline fails on Linux and macOS too, not only on Windows.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ffmpegInfo } from '../packages/media/src/ffmpeg.ts';
import { WINDOWS_CMDLINE_MAX } from '../packages/media/src/exec.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'reliability-child.ts');
// Footage rarely lives at a short path. The directory name (with spaces, as user folders have)
// makes each `-i <path>` cost about what it does for a real project, on every OS.
const FIX = path.join(os.tmpdir(), 'tmep-long-timeline', 'raw footage 2026-11 (camera A, take 3, selects)');
/** On Windows the operating system enforces the limit itself; elsewhere the engine is told to. */
const LIMIT: Record<string, string> = process.platform === 'win32' ? {} : { TMEP_CMDLINE_LIMIT: String(WINDOWS_CMDLINE_MAX) };
let skip: string | undefined;

before(async () => {
  try {
    const info = await ffmpegInfo();
    if (!info.encoders.has('libx264')) skip = 'ffmpeg lacks libx264';
  } catch {
    skip = 'ffmpeg not installed';
  }
  if (skip) return;
  mkdirSync(FIX, { recursive: true });
  if (!existsSync(path.join(FIX, 'clip.mp4'))) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3:sample_rate=48000', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(FIX, 'clip.mp4')]);
    assert.equal(r.status, 0);
  }
});

interface Run {
  code: number | null;
  stderr: string;
  result?: Record<string, unknown>;
}

function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      resolve({ code, stderr: err, result: line ? JSON.parse(line.slice(7)) : undefined });
    });
  });
}

test('a 400-clip timeline renders: no FFmpeg command line grows with the number of clips', { timeout: 900_000 }, async (t) => {
  if (skip) return t.skip(skip);
  // 400 hard cuts of one source: on 949e6c5 the audio mix passed one `-ss/-t/-i <path>` per clip
  // on a single command line (over 40,000 characters here) and the render failed with
  // "spawn ENAMETOOLONG" on Windows
  const r = await run(['render-long', FIX, '400', '0', 'preview'], LIMIT);
  assert.equal(r.code, 0, r.stderr.slice(-1500));
  const view = r.result!.view as Record<string, unknown>;
  assert.equal(view.state, 'done', `the render failed: ${JSON.stringify(view.err ?? view)}`);
  assert.equal(view.units, 400);
  assert.ok(Math.abs((view.dur as number) - 160) < 0.1, `400 clips of 0.4 s: ${view.dur} s`);
  assert.deepEqual(r.result!.ffmpeg, [], 'no FFmpeg process left');
  assert.deepEqual(r.result!.leftovers, [], 'no temporary files');
});

/** Names of the audio stems in a project's cache. */
const stemNames = (project: string): string[] => {
  const d = path.join(project, '.tmep', 'cache', 'audio', 'stems');
  return existsSync(d) ? readdirSync(d).sort() : [];
};

test('an edit to a long timeline reuses the audio stems around it', { timeout: 900_000 }, async (t) => {
  if (skip) return t.skip(skip);
  // 120 clips, rendered, then one clip's speed changed: the stems of the untouched parts of the
  // timeline must be reused, not mixed again
  const r = await run(['render-edit-render', FIX, '120'], LIMIT);
  assert.equal(r.code, 0, r.stderr.slice(-1500));
  const { project, first, second, stemsAfterFirst, stemsAfterSecond } = r.result as {
    project: string; first: Record<string, unknown>; second: Record<string, unknown>; stemsAfterFirst: number; stemsAfterSecond: number;
  };
  assert.equal(first.state, 'done', JSON.stringify(first));
  assert.equal(second.state, 'done', JSON.stringify(second));
  const result = second.result as Record<string, unknown>;
  const total = result.audioStems as number;
  const cached = result.audioStemsCached as number;
  assert.ok(total >= 4, `the timeline is split into stems: ${total}`); // 120 clips, at most 32 per stem
  // a stem's key is its own content, not its position, so changing one clip's speed (which
  // shifts everything after it) only invalidates the stem that clip is in
  assert.ok(cached >= total - 1, `the edit re-mixed one stem of ${total} (reused ${cached})`);
  assert.ok(stemsAfterSecond - stemsAfterFirst <= 2, `cache grew by ${stemsAfterSecond - stemsAfterFirst} stems`);
  assert.deepEqual(jobLeftovers(project), [], 'no temporary files left in the cache');
});

/** Temporary files anywhere under the project. */
const jobLeftovers = (project: string): string[] => {
  const walk = (d: string): string[] => {
    if (!existsSync(d)) return [];
    return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.includes('.tmp') ? [e.name] : []));
  };
  return walk(path.join(project, '.tmep'));
};

test('cancelling a 400-clip render stops it and leaves no partial stem behind', { timeout: 900_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const r = await run(['render-cancel', FIX, '400', '2500'], LIMIT);
  assert.equal(r.code, 0, r.stderr.slice(-1500));
  const { project, view } = r.result as { project: string; view: Record<string, unknown> };
  assert.equal(view.state, 'cancelled', `expected a cancelled render: ${JSON.stringify(view)}`);
  assert.equal((view.err as { code: string }).code, 'E_CANCELLED');
  assert.deepEqual(r.result!.ffmpeg, [], 'no FFmpeg process left behind');
  assert.deepEqual(jobLeftovers(project), [], 'no half-written stem or temporary file left');
});

test('the mix keeps working with few file descriptors (300 clips, ulimit -n 96)', { timeout: 900_000 }, async (t) => {
  if (skip) return t.skip(skip);
  if (process.platform === 'win32') return t.skip('no ulimit on Windows');
  // On 949e6c5 one process opened every clip at once: 300 clips needed 304 descriptors and
  // failed under the macOS default soft limit of 256.
  const r = await new Promise<Run>((resolve) => {
    const proc = spawn('/bin/sh', ['-c', `ulimit -n 96 && exec "$0" "$@"`, process.execPath, CHILD, 'render-long', FIX, '300', '0', 'preview'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...LIMIT } });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      resolve({ code, stderr: err, result: line ? JSON.parse(line.slice(7)) : undefined });
    });
  });
  assert.equal(r.code, 0, r.stderr.slice(-1500));
  const view = r.result!.view as Record<string, unknown>;
  assert.equal(view.state, 'done', `the render failed: ${JSON.stringify(view.err ?? view)}`);
  assert.equal(view.units, 300);
});
