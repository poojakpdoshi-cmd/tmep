/**
 * Cross-process cancellation (Stabilization A4, audit P2-6).
 *
 * The owner of a render job and the process that cancels it are separate Node processes, as with
 * an MCP server and `tmep status <job> --cancel`. Interleavings are made deterministic with
 * `tests/fault-rename.ts`: the owner's cancel poll is made blind for its first rounds
 * (`TMEP_FAULT_BLIND`), or the canceller's write is held at a gate (`TMEP_FAULT_HOLD`), so the race
 * window is always hit. Checks: a cancel request is never lost,
 * the owner's FFmpeg processes stop, and the final job state is accurate and the same from
 * every process.
 *
 * Failures while the cancel marker itself is being written are injected with `TMEP_FAULT_CANCEL`.
 * Every injection is checked against the child's fault log (`TMEP_FAULT_LOG`): a test whose
 * injection never fired would pass without testing anything.
 */
import { test, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ffmpegInfo } from '../packages/media/src/ffmpeg.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'reliability-child.ts');
const FAULT = path.join(here, 'fault-rename.ts');
const READER = path.join(here, 'json-reader-child.ts');
const CLI = path.join(here, '..', 'bin', 'tmep.js');
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

/** Fault log of one child process: which injected faults really fired ("<kind> <code> <file>"). */
function faultLog(): { env: Record<string, string>; hits: () => string[] } {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'tmep-faults-')), 'faults.log');
  return { env: { TMEP_FAULT_LOG: file }, hits: () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []) };
}

/** `tmep status <job> -p <project> --cancel` as a real CLI process: exit code and the JSON it printed. */
function cliCancel(project: string, job: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: Record<string, unknown>; raw: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--import', pathToFileURL(FAULT).href, CLI, 'status', job, '-p', project, '--cancel'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    proc.stdout!.on('data', (d) => (out += d));
    proc.stderr!.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(out);
      } catch {
        // not JSON: reported through `raw`
      }
      resolve({ code, out: parsed, raw: `${out}\n${err}`.slice(-1500) });
    });
  });
}

/**
 * Start a long render in its own process and wait until it has announced its job. The process is
 * killed when the test ends, so a failed assertion never leaves a long render running.
 */
async function startOwner(t: TestContext, clips: number, env: Record<string, string> = {}): Promise<{ owner: ReturnType<typeof start>; project: string; job: string }> {
  const owner = start(CHILD, ['render-long', FIX, String(clips)], env);
  t.after(() => void owner.proc.kill());
  const { project, job } = (await Promise.race([owner.started, owner.done.then((r) => assert.fail(`owner exited early: ${r.stderr.slice(-800)}`))])) as { project: string; job: string };
  return { owner, project, job };
}

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
  // Owner: a render that stays alive after it finishes. Canceller: reads the job while it is
  // running, then its write is held at a gate until the job HAS finished, so the request always
  // lands late, on every machine (a fixed delay tested the runner's speed against the render's).
  const owner = start(CHILD, ['render-long', FIX, '36', '10000']);
  const { project, job } = (await Promise.race([owner.started, owner.done.then((r) => assert.fail(`owner exited early: ${r.stderr.slice(-800)}`))])) as { project: string; job: string };
  const gate = path.join(mkdtempSync(path.join(os.tmpdir(), 'tmep-gate-')), 'open');
  // whatever happens below, the canceller is released and the owner stopped when the test ends
  t.after(() => {
    writeFileSync(gate, '');
    owner.proc.kill();
  });
  const log = faultLog();
  const cancelling = run(CHILD, ['cancel', FIX, project, job], { TMEP_FAULT_HOLD: `cancel-write:${gate}`, ...log.env });
  // the canceller is parked at its write: it found the job running and is about to ask
  let early: Run | undefined;
  void cancelling.then((r) => (early = r));
  while (log.hits().length === 0) {
    assert.equal(early, undefined, `the canceller finished without attempting its write (job no longer running?): ${early?.stderr.slice(-500)}`);
    await sleep(50);
  }
  assert.deepEqual(log.hits(), [`hold cancel-write ${job}.cancel`], 'the held call is the cancel marker write');
  // the job finishes on its own; only then is the request let through
  const rec = path.join(project, '.tmep', 'jobs', `${job}.json`);
  const stateOnDisk = () => {
    try {
      return (JSON.parse(readFileSync(rec, 'utf8')) as { state: string }).state;
    } catch {
      return 'unreadable'; // a read that collided with a write: look again
    }
  };
  for (let st = stateOnDisk(); st !== 'done'; st = stateOnDisk()) {
    assert.ok(st === 'running' || st === 'unreadable', `the job must finish on its own, nothing has asked for cancellation yet: ${st}`);
    assert.equal(owner.proc.exitCode, null, 'owner alive while the job runs');
    await sleep(250);
  }
  writeFileSync(gate, '');
  const c = await cancelling;
  assert.equal(c.code, 0, c.stderr.slice(-800));
  // owner still alive (keep-alive), job finished: everyone must agree on the terminal state
  const s1 = await statusElsewhere(project, job);
  assert.equal(s1.state, 'done', `final state overwritten: ${JSON.stringify(s1)}`);
  const o = await owner.done;
  assert.equal(o.code, 0, o.stderr.slice(-1500));
  const view = o.result!.view as Record<string, unknown>;
  assert.equal(view.state, 'done', 'the owner agrees');
  // after the owner exits, the record must still be the real outcome (not E_INTERRUPTED)
  const s2 = await statusElsewhere(project, job);
  assert.equal(s2.state, 'done', JSON.stringify(s2));
  assert.deepEqual(jobFiles(project).filter((f) => !f.endsWith('.json')), [], `stale cancel/heartbeat files cleaned: ${jobFiles(project).join(',')}`);
});

test('cancel during concurrent status reads, progress writes and sharing violations', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  // Owner's job-record writes hit injected transient EPERM; three other processes poll the job
  // record every 10 ms (real sharing violations on Windows); then a cancel arrives.
  // The canceller's own write (the cancel marker) hits three injected EBUSY as well.
  const ownerLog = faultLog();
  const owner = start(CHILD, ['render-long', FIX, '150'], { TMEP_FAULT_RENAME: 'running:8:EPERM', ...ownerLog.env });
  const { project, job } = (await owner.started) as { project: string; job: string };
  const rec = path.join(project, '.tmep', 'jobs', `${job}.json`);
  const until = Date.now() + 6000;
  const readers = Array.from({ length: 3 }, () => run(READER, [rec, String(until), '10']));
  await sleep(1200);
  // (TMEP_FAULT_RENAME on the canceller never fired: a canceller renames no job record)
  const cancelLog = faultLog();
  const c = await run(CHILD, ['cancel', FIX, project, job], { TMEP_FAULT_CANCEL: 'publish:3:EBUSY', ...cancelLog.env });
  assert.equal(c.code, 0, c.stderr.slice(-800));
  assert.deepEqual(cancelLog.hits(), Array(3).fill(`cancel-publish EBUSY ${job}.cancel`), 'the canceller retried through three injected failures');
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
  assert.deepEqual(ownerLog.hits(), Array(8).fill(`rename EPERM ${job}.json`), 'the owner wrote through eight injected failures');
});

const cancelFiles = (project: string) => jobFiles(project).filter((f) => f.includes('.cancel'));

test('transient failures writing the cancel marker are retried: the request is delivered', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  // The canceller is the real CLI. Its first five attempts to publish the marker fail with EPERM
  // (a Windows sharing violation); it must keep trying, report the request as made only once
  // the marker exists, and the owner must then stop.
  const { owner, project, job } = await startOwner(t, 150);
  const log = faultLog();
  const c = await cliCancel(project, job, { TMEP_FAULT_CANCEL: 'publish:5:EPERM', ...log.env });
  assert.deepEqual(log.hits(), Array(5).fill(`cancel-publish EPERM ${job}.cancel`), `injection did not exercise the marker write: ${c.raw}`);
  assert.equal(c.code, 0, c.raw);
  assert.equal(c.out.job, job, c.raw);
  assert.equal(c.out.err, undefined, c.raw);
  const o = await owner.done;
  assert.equal(o.code, 0, o.stderr.slice(-1500));
  const view = o.result!.view as Record<string, unknown>;
  assert.equal(view.state, 'cancelled', `the retried request was not delivered: ${JSON.stringify(view)}`);
  assert.deepEqual(o.result!.ffmpeg, []);
  assert.deepEqual(o.result!.leftovers, []);
  assert.equal((await statusElsewhere(project, job)).state, 'cancelled');
  assert.deepEqual(jobFiles(project).filter((f) => !f.endsWith('.json')), [], `only the job record remains: ${jobFiles(project).join(',')}`);
});

// A request that cannot be delivered. Two ways to fail: the marker can never be published (a
// sharing violation that does not clear), or its content cannot be written (disk full: the file is
// created, the bytes are cut short). Either way the canceller must say so, the job must go on as
// if nothing had been asked (the owner takes the marker's existence as the request, so nothing
// half-written may be left where it looks), and a repeated request must still work.
for (const failure of [
  { name: 'the marker cannot be published (persistent EPERM)', inject: 'publish:all:EPERM', kind: 'cancel-publish EPERM', retried: true },
  { name: 'the marker write dies half-way (ENOSPC)', inject: 'write:all:ENOSPC', kind: 'cancel-write ENOSPC', retried: false },
]) {
  test(`an undeliverable cancel is an error, cancels nothing and can be repeated: ${failure.name}`, { timeout: 600_000 }, async (t) => {
    if (skip) return t.skip(skip);
    // 200 segments: still rendering on every runner while the failed request is examined (~7 s;
    // the fastest CI runner needs ~20 s for 200), and it costs nothing when the test passes,
    // because the job is cancelled at the end. Not more: the audio mix passes one `-i <path>` per
    // segment on the command line, and 400 segments exceed the Windows limit (spawn ENAMETOOLONG).
    const { owner, project, job } = await startOwner(t, 200);
    const log = faultLog();
    const c = await cliCancel(project, job, { TMEP_FAULT_CANCEL: failure.inject, ...log.env });
    const hits = log.hits();
    assert.ok(hits.length >= 1 && hits.every((h) => h.startsWith(`${failure.kind} ${job}.cancel`)), `injection did not exercise the marker write: ${JSON.stringify(hits)} ${c.raw}`);
    if (failure.retried) assert.ok(hits.length > 1, `a transient error is retried before giving up (${hits.length} attempt(s))`);
    // 1. the failure is reported, not a success
    assert.equal(c.code, 1, c.raw);
    assert.equal(c.out.ok, 0, c.raw);
    assert.equal(c.out.state, undefined, 'no job view that could be read as "cancel requested"');
    const err = c.out.err as { code: string; msg: string; hint?: string };
    assert.equal(err.code, 'E_IO', c.raw);
    assert.match(err.msg, /not delivered/, c.raw);
    // 2. nothing is left that the owner could take for a request: no marker, torn marker or temp file
    assert.deepEqual(cancelFiles(project), [], 'no cancel files after a failed request');
    await sleep(2500); // two rounds of the owner's cancel poll
    assert.equal(owner.proc.exitCode, null, 'owner still running');
    const s = await statusElsewhere(project, job);
    assert.equal(s.state, 'running', `a failed cancel request must not cancel the job: ${JSON.stringify(s)}`);
    assert.deepEqual(cancelFiles(project), []);
    // 3. the same request, once it can be written, is honoured
    const again = await cliCancel(project, job);
    assert.equal(again.code, 0, again.raw);
    const o = await owner.done;
    assert.equal(o.code, 0, o.stderr.slice(-1500));
    const view = o.result!.view as Record<string, unknown>;
    assert.equal(view.state, 'cancelled', JSON.stringify(view));
    assert.deepEqual(o.result!.ffmpeg, []);
    assert.deepEqual(o.result!.leftovers, []);
    assert.equal((await statusElsewhere(project, job)).state, 'cancelled');
    assert.deepEqual(jobFiles(project).filter((f) => !f.endsWith('.json')), [], `only the job record remains: ${jobFiles(project).join(',')}`);
  });
}
