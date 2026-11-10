/**
 * Cross-process cancellation (Stabilization A4, audit P2-6).
 *
 * The owner of a render job and the process that cancels it are separate Node processes, as with
 * an MCP server and `tmep status <job> --cancel`. Interleavings are made deterministic with
 * `tests/fault-rename.ts`: the owner's cancel poll is made blind for its first rounds
 * (`TMEP_FAULT_BLIND`), or the canceller's write is delayed (`TMEP_FAULT_DELAY`), so the race
 * window is always hit. Checks: a cancel request is never lost,
 * the owner's FFmpeg processes stop, and the final job state is accurate and the same from
 * every process.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ffmpegInfo } from '../packages/media/src/ffmpeg.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'reliability-child.ts');
const FAULT = path.join(here, 'fault-rename.ts');
const READER = path.join(here, 'json-reader-child.ts');
const FIX = path.join(os.tmpdir(), 'tmep-reliability-fixture');
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

function start(script: string, args: string[], env: Record<string, string> = {}): { proc: ChildProcess; started: Promise<Record<string, unknown>>; done: Promise<Run> } {
  const proc = spawn(process.execPath, ['--import', pathToFileURL(FAULT).href, script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let out = '';
  let err = '';
  let onStart!: (v: Record<string, unknown>) => void;
  const started = new Promise<Record<string, unknown>>((r) => (onStart = r));
  proc.stdout!.on('data', (d) => {
    out += d;
    const line = out.split('\n').find((l) => l.startsWith('STARTED '));
    if (line) onStart(JSON.parse(line.slice(8)));
  });
  proc.stderr!.on('data', (d) => (err += d));
  const done = new Promise<Run>((resolve) =>
    proc.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      resolve({ code, stderr: err, result: line ? JSON.parse(line.slice(7)) : undefined });
    }),
  );
  return { proc, started, done };
}
const run = (script: string, args: string[], env: Record<string, string> = {}) => start(script, args, env).done;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jobFiles = (project: string) => {
  const d = path.join(project, '.tmep', 'jobs');
  return existsSync(d) ? readdirSync(d) : [];
};

/** Status of a job as seen by a separate, fault-free process. */
async function statusElsewhere(project: string, job: string): Promise<Record<string, unknown>> {
  const r = await run(CHILD, ['status', FIX, project, job]);
  assert.equal(r.code, 0, r.stderr.slice(-800));
  return r.result!;
}

test('a cancel from another process is not lost to the owner’s progress writes', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  // Owner: long render whose cancel poll is blind for 3.5 s from its first round, while progress
  // writes (every 500 ms) continue: exactly the window in which a request kept inside the job
  // record gets overwritten. The request must still be honoured once the poll can see again.
  // 150 segments: long enough on every runner that the job is still running when the blind
  // window ends (a 36-segment render finished in 5.1 s on a Windows runner, before the poll could
  // see again, which tested runner speed rather than the race)
  const owner = start(CHILD, ['render-long', FIX, '150'], { TMEP_FAULT_BLIND: '1:3500:EBUSY' });
  const { project, job } = (await Promise.race([owner.started, owner.done.then((r) => assert.fail(`owner exited early: ${r.stderr.slice(-800)}`))])) as { project: string; job: string };
  await sleep(1500); // inside the blind window (first poll ~1 s after start), progress being persisted
  const c = await run(CHILD, ['cancel', FIX, project, job]);
  assert.equal(c.code, 0, c.stderr.slice(-800));
  const o = await owner.done;
  assert.equal(o.code, 0, o.stderr.slice(-1500));
  const view = o.result!.view as Record<string, unknown>;
  assert.equal(view.state, 'cancelled', `cancel request was lost: owner finished as ${JSON.stringify(view)}`);
  assert.equal((view.err as { code: string }).code, 'E_CANCELLED');
  assert.deepEqual(o.result!.ffmpeg, [], 'owner has no FFmpeg processes left');
  assert.deepEqual(o.result!.leftovers, [], 'no temporary files');
  const s = await statusElsewhere(project, job);
  assert.equal(s.state, 'cancelled', 'other processes see the same final state');
  assert.deepEqual(jobFiles(project).filter((f) => !f.endsWith('.json')), [], `only the job record remains: ${jobFiles(project).join(',')}`);
});

test('a late cancel write cannot overwrite the job’s final state', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  // Owner: short render, stays alive afterwards. Canceller: reads the job while it is running, but
  // its write lands only after the job has finished (cancel-write delayed by 9 s).
  const owner = start(CHILD, ['render-long', FIX, '6', '14000']);
  const { project, job } = (await owner.started) as { project: string; job: string };
  const c = await run(CHILD, ['cancel', FIX, project, job], { TMEP_FAULT_DELAY: 'cancel-write:9000' });
  assert.equal(c.code, 0, c.stderr.slice(-800));
  // owner still alive (keep-alive), job finished: everyone must agree on the terminal state
  const s1 = await statusElsewhere(project, job);
  assert.ok(['done', 'cancelled'].includes(s1.state as string), `final state overwritten: ${JSON.stringify(s1)}`);
  const o = await owner.done;
  assert.equal(o.code, 0, o.stderr.slice(-1500));
  const view = o.result!.view as Record<string, unknown>;
  assert.equal(s1.state, view.state, 'other processes agree with the owner');
  // after the owner exits, the record must still be the real outcome (not E_INTERRUPTED)
  const s2 = await statusElsewhere(project, job);
  assert.equal(s2.state, view.state, JSON.stringify(s2));
  assert.deepEqual(jobFiles(project).filter((f) => !f.endsWith('.json')), [], `stale cancel/heartbeat files cleaned: ${jobFiles(project).join(',')}`);
});

test('cancel during concurrent status reads, progress writes and sharing violations', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  // Owner's job-record writes hit injected transient EPERM; three other processes poll the job
  // record every 10 ms (real sharing violations on Windows); then a cancel arrives.
  const owner = start(CHILD, ['render-long', FIX, '150'], { TMEP_FAULT_RENAME: 'running:8:EPERM' });
  const { project, job } = (await owner.started) as { project: string; job: string };
  const rec = path.join(project, '.tmep', 'jobs', `${job}.json`);
  const until = Date.now() + 6000;
  const readers = Array.from({ length: 3 }, () => run(READER, [rec, String(until), '10']));
  await sleep(1200);
  const c = await run(CHILD, ['cancel', FIX, project, job], { TMEP_FAULT_RENAME: 'any:3:EBUSY' });
  assert.equal(c.code, 0, c.stderr.slice(-800));
  const o = await owner.done;
  assert.equal(o.code, 0, o.stderr.slice(-1500));
  const view = o.result!.view as Record<string, unknown>;
  assert.equal(view.state, 'cancelled', JSON.stringify(view));
  assert.deepEqual(o.result!.ffmpeg, []);
  assert.deepEqual(o.result!.leftovers, []);
  for (const r of await Promise.all(readers)) {
    assert.equal(r.code, 0, r.stderr.slice(-500));
    // readers may see "running" then "cancelled"; never an error or a torn record
    const errs = ((r.result!.errors as string[]) ?? []).filter((e) => e !== 'torn or unexpected record');
    assert.deepEqual(errs, []);
  }
  assert.equal((await statusElsewhere(project, job)).state, 'cancelled');
});
