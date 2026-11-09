/**
 * Render reliability regressions (audit P0-1, P0-2, P2-2).
 *
 * Every scenario runs in an isolated Node subprocess (tests/reliability-child.ts) with no
 * unhandledRejection handler, so a leaked rejection kills that process and fails the test.
 * For each case we check process exit, job state, error propagation, temporary-file
 * cleanup and output integrity (decoded frame count + audio stream).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as api from '../packages/engine/src/api.ts';
import { ffmpegInfo } from '../packages/media/src/ffmpeg.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'reliability-child.ts');
const FIX = path.join(os.tmpdir(), 'tmep-reliability-fixture');
let skip: string | undefined;

before(async () => {
  try {
    const info = await ffmpegInfo();
    if (!info.encoders.has('libx264') || !info.filters.has('subtitles')) skip = 'ffmpeg lacks libx264/libass';
  } catch {
    skip = 'ffmpeg not installed';
  }
  if (skip) return;
  mkdirSync(FIX, { recursive: true });
  const ff = (args: string[]) => assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]).status, 0);
  if (!existsSync(path.join(FIX, 'clip.mp4'))) {
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3:sample_rate=48000', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(FIX, 'clip.mp4')]);
  }
  if (!existsSync(path.join(FIX, 'music.m4a'))) ff(['-f', 'lavfi', '-i', 'sine=f=220:d=6', '-c:a', 'aac', path.join(FIX, 'music.m4a')]);
});

interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  result?: Record<string, unknown>;
}

function child(args: string[], timeoutMs = 300_000): Promise<ChildRun> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code, signal) => {
      clearTimeout(t);
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      resolve({ code, signal, stderr: err, result: line ? JSON.parse(line.slice(7)) : undefined });
    });
  });
}

/** Decoded video frame count + audio presence of an MP4. */
function inspect(file: string): { frames: number; audio: boolean } {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames', '-of', 'json', file], { encoding: 'utf8' });
  const s = (JSON.parse(r.stdout || '{}').streams ?? []) as { codec_type: string; nb_read_frames?: string }[];
  return { frames: Number(s.find((x) => x.codec_type === 'video')?.nb_read_frames ?? 0), audio: s.some((x) => x.codec_type === 'audio') };
}

// 6 clips x 0.4 s at 30 fps
const FRAMES = 72;

function assertSurvived(r: ChildRun): Record<string, unknown> {
  assert.equal(r.signal, null, `child killed by ${r.signal}\n${r.stderr.slice(-1500)}`);
  assert.equal(r.code, 0, `child process crashed (exit ${r.code}):\n${r.stderr.slice(-1500)}`);
  assert.ok(r.result, `child produced no result:\n${r.stderr.slice(-1500)}`);
  return r.result!;
}

type JobView = { state: string; err?: { code: string; msg: string }; out?: string };

function assertGoodRender(j: JobView, frames: number): void {
  assert.equal(j.state, 'done', `job failed: ${JSON.stringify(j.err)}`);
  const m = inspect(j.out!);
  assert.equal(m.frames, frames, `${j.out} frames`);
  assert.ok(m.audio, `${j.out} has audio`);
}

test('two simultaneous final renders of the same project both succeed', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const res = assertSurvived(await child(['concurrent', FIX, 'final']));
  const [a, b] = res.jobs as JobView[];
  assertGoodRender(a!, FRAMES);
  assertGoodRender(b!, FRAMES);
  assert.deepEqual(res.leftovers, [], 'temporary files cleaned up');
});

test('simultaneous preview and final render both succeed', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const res = assertSurvived(await child(['concurrent', FIX, 'preview']));
  const [a, b] = res.jobs as JobView[];
  assertGoodRender(a!, FRAMES);
  assertGoodRender(b!, FRAMES);
  assert.deepEqual(res.leftovers, []);
});

test('audio mix failure during video rendering is a job error, not a process crash', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const res = assertSurvived(await child(['audio-fail', FIX]));
  const j = res.job as JobView;
  assert.equal(j.state, 'error');
  assert.equal(j.err?.code, 'E_FFMPEG_FAILED');
  assert.ok(j.err?.msg, 'error message propagated');
  assert.deepEqual(res.leftovers, [], 'partial temporary outputs removed');
  assert.deepEqual(res.ffmpeg, [], 'no sibling ffmpeg left running');
  // whatever made it into the unit cache must be a complete, decodable segment
  for (const u of res.units as string[]) assert.ok(inspect(u).frames > 0, `cache entry ${u} is valid`);
});

test('a job whose process died is reported as interrupted, not running', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const died = await child(['start-and-die', FIX]);
  // POSIX reports the signal; Windows reports a non-zero exit code for a self-kill
  assert.ok(died.signal === 'SIGKILL' || (process.platform === 'win32' && died.code !== 0), `child did not die abruptly: ${died.code}/${died.signal}`);
  const { project, job } = died.result as { project: string; job: string };
  // from this (different) process, and again from a fresh process
  const s1 = (await api.status({ project, detail: 'standard' }, { job })) as Record<string, unknown>;
  assert.equal(s1.state, 'error', JSON.stringify(s1));
  assert.equal((s1.err as { code: string }).code, 'E_INTERRUPTED');
  const s2 = assertSurvived(await child(['status', FIX, project, job]));
  assert.equal(s2.state, 'error');
  assert.equal((s2.err as { code: string }).code, 'E_INTERRUPTED');
});

test('an active job seen from another process is still running', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ctx: api.Ctx = { project: (await import('node:fs')).mkdtempSync(path.join(os.tmpdir(), 'tmep-rel-live-')), detail: 'standard' };
  await api.importMedia(ctx, { paths: [path.join(FIX, 'clip.mp4')] });
  await api.edit(ctx, { ops: [{ op: 'format', ratio: '9:16' }, { op: 'keep', src: 'v1', ranges: Array.from({ length: 6 }, (_, i) => [i * 0.5, i * 0.5 + 0.4]) }] });
  const started = (await api.render(ctx, { wait: 0 })) as Record<string, unknown>;
  const other = assertSurvived(await child(['status', FIX, ctx.project, started.job as string]));
  const final = (await api.status(ctx, { job: started.job as string, wait: 600 })) as Record<string, unknown>;
  // if the render finished before the other process looked, it must say done; never "interrupted"
  assert.ok(other.state === 'running' || other.state === 'done', JSON.stringify(other));
  assert.equal(final.state, 'done');
});

test('normal single render is unchanged (output, audio, cache hit)', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const res = assertSurvived(await child(['single', FIX]));
  const [a, b] = res.jobs as JobView[];
  assertGoodRender(a!, FRAMES);
  assert.equal(b!.state, 'done');
  assert.deepEqual(res.leftovers, []);
});

test('independent projects render safely in parallel', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const res = assertSurvived(await child(['two-projects', FIX]));
  for (const j of res.jobs as JobView[]) assertGoodRender(j, FRAMES);
  assert.deepEqual(res.leftovers, []);
});
