/**
 * In-process job finalization when the terminal record cannot be written (Stabilization A3).
 * Renames of finished job records are failed deterministically by patching fs.promises.rename.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Project } from '../../core/src/index.ts';
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
