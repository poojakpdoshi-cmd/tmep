/**
 * In-process job finalization when the terminal record cannot be written (Stabilization A3).
 * Renames of finished job records are failed deterministically by patching fs.promises.rename.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Project, TmepError } from '../../core/src/index.ts';
import { startJob, waitJob, readJob, jobView } from '../src/jobs.ts';

const realRename = fsp.rename;
afterEach(() => {
  fsp.rename = realRename;
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
