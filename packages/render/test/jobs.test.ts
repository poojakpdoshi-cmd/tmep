/**
 * In-process job finalization when the terminal record cannot be written (Stabilization A3).
 * Renames of finished job records are failed deterministically by patching fs.promises.rename.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { Project, TmepError } from '../../core/src/index.ts';
import { startJob, waitJob, readJob, cancelJob, jobView } from '../src/jobs.ts';

const realRename = fsp.rename;
const realWriteFile = fsp.writeFile;
afterEach(() => {
  fsp.rename = realRename;
  fsp.writeFile = realWriteFile;
});

/** Fail every rename that would publish a job record in a terminal state. */
function failTerminalWrites(): void {
  fsp.rename = (async (from: string, to: string) => {
    if (/[\\/]jobs[\\/]j[0-9a-z]+\.json$/.test(String(to)) && /"state": "(done|error|cancelled)"/.test(readFileSync(String(from), 'utf8'))) {
      throw Object.assign(new Error('EPERM: operation not permitted, rename (injected)'), { code: 'EPERM', syscall: 'rename' });
    }
    return realRename(from, to);
  }) as typeof fsp.rename;
}

const heartbeat = (p: Project, id: string) => p.jobPath(id).replace(/\.json$/, '.alive');

test('normal jobs: terminal state on disk before the job resolves; no persistErr in the view', async () => {
  const p = await Project.open(mkdtempSync(path.join(os.tmpdir(), 'tmep-jobs-')), { create: true });
  const j = await startJob(p, 'test', 1, {}, async () => ({ out: 'x.mp4' }));
  const done = await waitJob(p, j.id, 30);
  assert.equal(done.state, 'done');
  // resolved => already finalized on disk (no window where another reader sees "running")
  assert.equal(JSON.parse(readFileSync(p.jobPath(j.id), 'utf8')).state, 'done');
  assert.equal(existsSync(heartbeat(p, j.id)), false);
  assert.equal('persistErr' in jobView(done, 'standard'), false);
});

test('terminal write keeps failing: reported in-process, never "interrupted" here, self-heals once writes work', async () => {
  const p = await Project.open(mkdtempSync(path.join(os.tmpdir(), 'tmep-jobs-')), { create: true });
  failTerminalWrites();
  const warnings: string[] = [];
  const onWarn = (w: Error) => warnings.push(w.message);
  process.on('warning', onWarn);
  const j = await startJob(p, 'test', 1, {}, async () => ({ out: 'x.mp4' }));
  const done = await waitJob(p, j.id, 30);
  await new Promise((r) => setImmediate(r));
  process.off('warning', onWarn);
  assert.equal(done.state, 'done');
  assert.equal((done.persistError as { code: string }).code, 'E_IO');
  assert.deepEqual(jobView(done, 'standard').persistErr, { code: 'E_IO', msg: done.persistError!.msg });
  assert.ok(warnings.some((w) => w.includes(j.id)), 'a process warning was emitted');
  // disk still has the last progress record; this process answers from memory instead of E_INTERRUPTED
  assert.equal(JSON.parse(readFileSync(p.jobPath(j.id), 'utf8')).state, 'running');
  const again = await readJob(p, j.id);
  assert.equal(again.state, 'done');
  assert.ok(again.persistError, 'still unsaved while writes fail');
  assert.ok(existsSync(heartbeat(p, j.id)), 'stale heartbeat kept so other processes can detect interruption');
  assert.deepEqual(readdirSync(path.dirname(p.jobPath(j.id))).filter((f) => f.includes('.tmp')), []);
  // the sharing violation clears: the next read persists the record and cleans up
  fsp.rename = realRename;
  const healed = await readJob(p, j.id);
  assert.equal(healed.state, 'done');
  assert.equal(healed.persistError, undefined);
  const disk = JSON.parse(readFileSync(p.jobPath(j.id), 'utf8'));
  assert.equal(disk.state, 'done');
  assert.equal('persistError' in disk, false);
  assert.equal(existsSync(heartbeat(p, j.id)), false);
});

const cancelMarker = (p: Project, id: string) => p.jobPath(id).replace(/\.json$/, '.cancel');

test('cross-process cancel writes only a marker: the job record is never modified by the canceller', async () => {
  const { spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); // a live "other process"
  try {
    const p = await Project.open(mkdtempSync(path.join(os.tmpdir(), 'tmep-jobs-')), { create: true });
    const id = 'jxproc01';
    const rec = { id, kind: 'render', state: 'running', progress: 0.5, phase: 'video', rev: 1, opts: {}, started: new Date().toISOString(), pid: owner.pid, host: os.hostname() };
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(p.jobPath(id)), { recursive: true });
    writeFileSync(p.jobPath(id), JSON.stringify(rec));
    writeFileSync(heartbeat(p, id), String(Date.now())); // fresh heartbeat: genuinely running
    const before = readFileSync(p.jobPath(id), 'utf8');
    const { cancelJob } = await import('../src/jobs.ts');
    const r = await cancelJob(p, id);
    assert.equal(r.state, 'running');
    assert.equal(r.cancel, true, 'caller is told the request was made');
    assert.ok(existsSync(cancelMarker(p, id)), 'marker created');
    assert.equal(readFileSync(p.jobPath(id), 'utf8'), before, 'job record untouched');
    // the owner finishes before honouring it: the stale request is discarded on the next read
    writeFileSync(p.jobPath(id), JSON.stringify({ ...rec, state: 'done', progress: 1, ended: new Date().toISOString() }));
    assert.equal((await readJob(p, id)).state, 'done');
    assert.equal(existsSync(cancelMarker(p, id)), false, 'late request discarded');
    // cancelling a finished job creates nothing
    assert.equal((await cancelJob(p, id)).state, 'done');
    assert.equal(existsSync(cancelMarker(p, id)), false);
  } finally {
    owner.kill();
  }
});

test('the owner honours a marker and a legacy `cancel: true` record; markers are removed when the job ends', async () => {
  const { writeFileSync } = await import('node:fs');
  for (const legacy of [false, true]) {
    const p = await Project.open(mkdtempSync(path.join(os.tmpdir(), 'tmep-jobs-')), { create: true });
    let id = '';
    const j = await startJob(p, 'test', 1, {}, (signal) => new Promise((_, reject) => {
      // a long job without progress writes; only the poll can stop it
      const t = setTimeout(() => reject(new Error('not cancelled within 10 s')), 10_000);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new TmepError('E_CANCELLED', 'cancelled'));
      });
    }));
    id = j.id;
    if (legacy) {
      const disk = JSON.parse(readFileSync(p.jobPath(id), 'utf8'));
      writeFileSync(p.jobPath(id), JSON.stringify({ ...disk, cancel: true })); // what older versions wrote
    } else {
      writeFileSync(cancelMarker(p, id), '{}'); // what another process now writes
    }
    const done = await waitJob(p, id, 30);
    assert.equal(done.state, 'cancelled', `legacy=${legacy}`);
    assert.equal(JSON.parse(readFileSync(p.jobPath(id), 'utf8')).state, 'cancelled');
    assert.equal(existsSync(cancelMarker(p, id)), false, 'marker removed at finalization');
  }
});

// ---- failures while the cancel marker itself is being written -------------------------------
// The injections below match by PATH, not by syscall: "publishing" is whatever call makes
// `<id>.cancel` visible (a rename onto it, or a writeFile straight to it), so they keep firing if
// the way the marker is written changes. Every test asserts that its injection really fired.

const MARKER = /[\\/]jobs[\\/]j[0-9a-z]+\.cancel$/;
const MARKER_OR_TEMP = /[\\/]jobs[\\/]j[0-9a-z]+\.cancel(\.[^\\/]+\.tmp)?$/;
const injected = (code: string, syscall: string) => Object.assign(new Error(`${code}: injected ${syscall} failure`), { code, syscall });

/** Make the next `n` attempts to publish a cancel marker fail with `code` before touching the disk. */
function failMarkerPublish(n: number, code: string): { attempts: number } {
  const c = { attempts: 0 };
  const hit = (target: unknown) => {
    if (!MARKER.test(String(target))) return;
    c.attempts++;
    if (n-- > 0) throw injected(code, 'rename');
  };
  fsp.rename = (async (from: string, to: string) => {
    hit(to);
    return realRename(from, to);
  }) as typeof fsp.rename;
  fsp.writeFile = (async (file: unknown, ...rest: unknown[]) => {
    hit(file);
    return (realWriteFile as (...a: unknown[]) => Promise<void>)(file, ...rest);
  }) as typeof fsp.writeFile;
  return c;
}

/** Every write of the marker's content (to the marker or its temp file) is cut short, then fails. */
function tearMarkerWrites(code: string): { attempts: number } {
  const c = { attempts: 0 };
  fsp.writeFile = (async (file: unknown, ...rest: unknown[]) => {
    if (MARKER_OR_TEMP.test(String(file))) {
      c.attempts++;
      writeFileSync(String(file), '{"at":"20');
      throw injected(code, 'write');
    }
    return (realWriteFile as (...a: unknown[]) => Promise<void>)(file, ...rest);
  }) as typeof fsp.writeFile;
  return c;
}

/** A job record that says `running`, owned by another live process (fresh heartbeat). */
async function foreignRunningJob(): Promise<{ p: Project; id: string; record: string; stop: () => void }> {
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const p = await Project.open(mkdtempSync(path.join(os.tmpdir(), 'tmep-jobs-')), { create: true });
  const id = 'jxproc02';
  mkdirSync(path.dirname(p.jobPath(id)), { recursive: true });
  const record = JSON.stringify({ id, kind: 'render', state: 'running', progress: 0.5, phase: 'video', rev: 1, opts: {}, started: new Date().toISOString(), pid: owner.pid, host: os.hostname() });
  writeFileSync(p.jobPath(id), record);
  writeFileSync(heartbeat(p, id), String(Date.now()));
  return { p, id, record, stop: () => owner.kill() };
}

/** Everything in the jobs directory that belongs to a cancel request (marker, torn marker, temp file). */
const cancelFiles = (p: Project, id: string) => readdirSync(path.dirname(p.jobPath(id))).filter((f) => f.includes('.cancel'));

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`cancel marker: transient ${code} is retried and the request is delivered`, async () => {
    const { p, id, record, stop } = await foreignRunningJob();
    try {
      const c = failMarkerPublish(3, code);
      const r = await cancelJob(p, id);
      assert.equal(c.attempts, 4, 'three injected failures, then the attempt that lands');
      assert.equal(r.cancel, true, 'success is reported only now that the marker exists');
      assert.deepEqual(cancelFiles(p, id), [`${id}.cancel`], 'exactly the marker: no temp files');
      const marker = JSON.parse(readFileSync(cancelMarker(p, id), 'utf8')) as { at: string; pid: number };
      assert.equal(marker.pid, process.pid, 'the marker is complete');
      assert.equal(readFileSync(p.jobPath(id), 'utf8'), record, 'job record untouched');
    } finally {
      stop();
    }
  });
}

test('cancel marker: a failure that persists is an error after bounded retries, never a claimed success', async () => {
  const { p, id, record, stop } = await foreignRunningJob();
  try {
    const c = failMarkerPublish(Infinity, 'EBUSY');
    const t0 = Date.now();
    let returned: unknown;
    await assert.rejects(
      async () => (returned = await cancelJob(p, id)),
      (e: unknown) => e instanceof TmepError && e.code === 'E_IO' && /not delivered/.test(e.message) && e.message.includes('EBUSY') && !!e.hint,
    );
    assert.equal(returned, undefined, 'no job view (no `cancel: true`) is returned');
    assert.equal(c.attempts, 16, 'bounded retry budget');
    assert.ok(Date.now() - t0 < 10_000, 'bounded time');
    assert.deepEqual(cancelFiles(p, id), [], 'no marker and no temp file: nothing can cancel the job later');
    assert.equal(readFileSync(p.jobPath(id), 'utf8'), record, 'job record untouched');
    // the violation clears: the same request can simply be repeated
    fsp.rename = realRename;
    fsp.writeFile = realWriteFile;
    assert.equal((await cancelJob(p, id)).cancel, true);
    assert.deepEqual(cancelFiles(p, id), [`${id}.cancel`]);
  } finally {
    stop();
  }
});

test('cancel marker: non-transient errors are not retried', async () => {
  const { p, id, stop } = await foreignRunningJob();
  try {
    const c = failMarkerPublish(Infinity, 'ENOSPC');
    await assert.rejects(cancelJob(p, id), (e: unknown) => e instanceof TmepError && e.code === 'E_IO' && e.message.includes('ENOSPC'));
    assert.equal(c.attempts, 1);
    assert.deepEqual(cancelFiles(p, id), []);
  } finally {
    stop();
  }
});

test('cancel marker: a write that dies half-way leaves no marker behind (a failed request cannot cancel)', async () => {
  const { p, id, stop } = await foreignRunningJob();
  try {
    const c = tearMarkerWrites('ENOSPC');
    await assert.rejects(cancelJob(p, id), (e: unknown) => e instanceof TmepError && e.code === 'E_IO' && /not delivered/.test(e.message));
    assert.ok(c.attempts >= 1, 'the injection fired');
    // the owner takes the marker's existence as the request, so a torn one must not exist at all
    assert.deepEqual(cancelFiles(p, id), [], 'neither a truncated marker nor a temp file');
  } finally {
    stop();
  }
});

test('the owner reacts only to the marker itself: stray temp files of a cancel request are ignored', async () => {
  const p = await Project.open(mkdtempSync(path.join(os.tmpdir(), 'tmep-jobs-')), { create: true });
  let aborted = false;
  const j = await startJob(p, 'test', 1, {}, (signal) => new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('not cancelled within 15 s')), 15_000);
    signal.addEventListener('abort', () => {
      aborted = true;
      clearTimeout(t);
      reject(new TmepError('E_CANCELLED', 'cancelled'));
    });
  }));
  // what a canceller killed mid-write leaves behind: a (truncated) temp file, never the marker
  const stray = `${cancelMarker(p, j.id)}.4242.abcdef.tmp`;
  writeFileSync(stray, '{"at":"20');
  await new Promise((r) => setTimeout(r, 2300)); // two poll rounds (1 s each)
  assert.equal(aborted, false, 'a temp file is not a cancel request');
  assert.equal((await readJob(p, j.id)).state, 'running');
  writeFileSync(cancelMarker(p, j.id), '{}');
  assert.equal((await waitJob(p, j.id, 30)).state, 'cancelled');
  assert.equal(existsSync(cancelMarker(p, j.id)), false);
});
