/**
 * Job persistence under Windows-style sharing violations (Stabilization A3).
 *
 * Renders run in child processes started with `--import tests/fault-rename.ts`, which makes
 * job-record renames (or reads) fail deterministically. After the child exits, the job is
 * inspected from THIS process, as an MCP server or CLI would. Checks: the child survives, the
 * terminal state reaches disk (or the failure is reported, never silently dropped), and no
 * temporary job files are left behind.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, mkdtempSync, readdirSync, writeFileSync, rmSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as api from '../packages/engine/src/api.ts';
import { ffmpegInfo } from '../packages/media/src/ffmpeg.ts';
import { writeJson } from '../packages/core/src/util.ts';

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

function run(script: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stderr: string; result?: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', pathToFileURL(FAULT).href, script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      resolve({ code, stderr: err, result: line ? JSON.parse(line.slice(7)) : undefined });
    });
  });
}

const jobTmp = (project: string) => {
  const d = path.join(project, '.tmep', 'jobs');
  return existsSync(d) ? readdirSync(d).filter((f) => f.includes('.tmp')) : [];
};

async function statusFromHere(project: string, job: string): Promise<Record<string, unknown>> {
  return (await api.status({ project, detail: 'standard' }, { job })) as Record<string, unknown>;
}

test('transient rename failures on the terminal write: the job is recorded as done, not interrupted', { timeout: 300_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const r = await run(CHILD, ['render-once', FIX], { TMEP_FAULT_RENAME: 'done:3:EPERM' });
  assert.equal(r.code, 0, r.stderr.slice(-1500));
  const { project, view } = r.result as { project: string; view: Record<string, unknown> };
  assert.equal(view.state, 'done');
  assert.equal(view.persistErr, undefined, 'retries absorbed the failures');
  // the child has exited: what the record on disk says is all another process can know
  const s = await statusFromHere(project, view.job as string);
  assert.equal(s.state, 'done', JSON.stringify(s));
  assert.deepEqual(jobTmp(project), [], 'no orphaned temp job files');
});

test('transient failures on progress writes are retried; nothing is left behind', { timeout: 300_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const r = await run(CHILD, ['render-once', FIX], { TMEP_FAULT_RENAME: 'running:4:EBUSY' });
  assert.equal(r.code, 0, r.stderr.slice(-1500));
  const { project, view } = r.result as { project: string; view: Record<string, unknown> };
  assert.equal(view.state, 'done');
  assert.equal((await statusFromHere(project, view.job as string)).state, 'done');
  assert.deepEqual(jobTmp(project), []);
});

test('a terminal write that keeps failing is reported, not silently accepted, and never leaves the job "running" forever', { timeout: 300_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const r = await run(CHILD, ['render-once', FIX], { TMEP_FAULT_RENAME: 'done:all:EPERM' });
  assert.equal(r.code, 0, `child survives: ${r.stderr.slice(-1500)}`);
  const { project, view } = r.result as { project: string; view: Record<string, unknown> };
  assert.equal(view.state, 'done', 'the render itself succeeded');
  const pe = view.persistErr as { code: string; msg: string } | undefined;
  assert.equal(pe?.code, 'E_IO', `persistence failure surfaced to the caller: ${JSON.stringify(view)}`);
  assert.match(pe!.msg, /EPERM/);
  assert.deepEqual(jobTmp(project), [], 'failed attempts leave no temp files');
  // the owning process is gone and the record could not be finalised: another process must not see "running"
  const s = await statusFromHere(project, view.job as string);
  assert.equal(s.state, 'error', JSON.stringify(s));
  assert.equal((s.err as { code: string }).code, 'E_INTERRUPTED');
});

test('a failing read in the cross-process cancel poll does not crash the job process', { timeout: 300_000 }, async (t) => {
  if (skip) return t.skip(skip);
  // first reads of the job record fail (the poll runs every second); keep the process alive past several polls
  const r = await run(CHILD, ['render-once', FIX, '2500'], { TMEP_FAULT_READ: '50:EBUSY' });
  assert.equal(r.code, 0, `child crashed: ${r.stderr.slice(-1500)}`);
  const { project, view } = r.result as { project: string; view: Record<string, unknown> };
  assert.equal(view.state, 'done');
  assert.equal((await statusFromHere(project, view.job as string)).state, 'done');
});

/**
 * Writer vs reader processes on one job record. Returns counts for writeJson (with the given retry
 * budget) and for a raw tmp+rename / readFile WITHOUT retries (the pre-A3 behaviour), which shows
 * whether this OS really raises sharing violations under concurrent reads.
 */
async function contention(readers: number, everyMs: number, attempts: number | undefined, ms = 4000) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'tmep-share-'));
  const file = path.join(d, 'jobs', 'jshare.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"state":"running","n":0}');
  const until = Date.now() + ms;
  const procs = Array.from({ length: readers }, () => run(READER, [file, String(until), String(everyMs)]));
  let writes = 0;
  let rawWrites = 0;
  const failures: string[] = [];
  const rawFailures: string[] = [];
  while (Date.now() < until) {
    try {
      await writeJson(file, { state: 'running', n: ++writes, pad: 'x'.repeat(2000) }, true, attempts ? { attempts } : {});
    } catch (e) {
      failures.push((e as NodeJS.ErrnoException).code ?? String(e));
    }
    const tmp = `${file}.raw.tmp`;
    writeFileSync(tmp, JSON.stringify({ state: 'running', n: ++rawWrites, pad: 'y'.repeat(2000) }));
    try {
      await fsp.rename(tmp, file);
    } catch (e) {
      rawFailures.push((e as NodeJS.ErrnoException).code ?? String(e));
      rmSync(tmp, { force: true });
    }
  }
  const rs = await Promise.all(procs);
  for (const r of rs) assert.equal(r.code, 0, r.stderr.slice(-800));
  const sum = (k: string) => rs.reduce((a, r) => a + ((r.result![k] as number) ?? 0), 0);
  const all = (k: string) => rs.flatMap((r) => (r.result![k] as string[]) ?? []);
  const codes = (l: string[]) => [...new Set(l)].join('/') || '-';
  const res = {
    writes, failures, rawWrites, rawFailures, reads: sum('reads'), readErrors: all('errors'), rawReadErrors: sum('rawErrorCount'),
    leftovers: readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp')),
    line: `platform=${process.platform} readers=${readers}x${everyMs ? `${everyMs}ms` : 'tight'} budget=${attempts ?? 'default'} writes=${writes} writeFailures=${failures.length} rawRenames=${rawWrites} rawRenameFailures=${rawFailures.length} (${codes(rawFailures)}) reads=${sum('reads')} readErrors=${all('errors').length} rawReadErrors=${sum('rawErrorCount')} (${codes(all('rawErrors'))})`,
  };
  return res;
}

test('job-record writes succeed while other processes poll the record (status/cancel polling)', { timeout: 300_000 }, async (t) => {
  if (skip) return t.skip(skip);
  // 3 processes polling every 10 ms: far more aggressive than MCP/CLI status polling
  const r = await contention(3, 10, undefined);
  t.diagnostic(r.line);
  assert.ok(r.writes > 50 && r.reads > 50, r.line);
  assert.deepEqual(r.failures, [], `no write failed: ${r.line}`);
  assert.deepEqual(r.readErrors, [], 'no reader saw an error or a torn record');
  assert.deepEqual(r.leftovers, []);
});

test('under saturating tight-loop readers, failures are bounded, reported and leave no temp files', { timeout: 300_000 }, async (t) => {
  if (skip) return t.skip(skip);
  // Diagnostic stress: 3 processes re-reading the record back-to-back. A bounded retry budget can
  // be exhausted here (Windows refuses to replace a file while any reader has it open); the
  // contract is that every failure is thrown (never silently accepted) and leaves no temp file.
  for (const attempts of [undefined, 16]) {
    const r = await contention(3, 0, attempts, 3000);
    t.diagnostic(r.line);
    assert.ok(r.writes > 5, r.line);
    for (const f of r.failures) assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(f), `only transient codes surface: ${f}`);
    assert.deepEqual(r.readErrors, [], 'readers never see an error or a torn record');
    assert.deepEqual(r.leftovers, [], 'failed writes leave no temp file');
  }
});
