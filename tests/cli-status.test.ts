import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Project, writeJson } from '../packages/core/src/index.ts';
import type { Job } from '../packages/render/src/jobs.ts';

const cli = fileURLToPath(new URL('../bin/tmep.js', import.meta.url));

function fixture(t: TestContext): string {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tmep-cli-status-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function status(cwd: string, args: string[], exitCode: number) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, env: { ...process.env, TMEP_PROJECT: cwd }, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, exitCode, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

test('status cancels the job in the selected project across argument orders', async (t) => {
  const cwd = fixture(t);
  const dir = path.join(cwd, 'target project');
  const project = await Project.open(dir, { create: true });
  const orders = [
    ['status', 'j1', '--cancel', '-p', dir],
    ['status', 'j2', '-p', dir, '--cancel'],
    ['-p', dir, 'status', '--cancel', 'j3'],
  ];
  for (const [i, args] of orders.entries()) {
    const id = `j${i + 1}`;
    const job: Job = { id, kind: 'render', state: 'running', progress: 0, phase: 'start', rev: 1,
      opts: {}, started: new Date().toISOString(), pid: process.pid };
    await writeJson(project.jobPath(id), job);
    const out = status(cwd, args, 0);
    assert.equal(out.job, id);
    assert.equal(out.state, 'running');
    assert.ok(existsSync(project.jobPath(id).replace(/\.json$/, '.cancel')));
  }
  assert.deepEqual(readdirSync(cwd), ['target project']);
});

test('status rejects missing and uninitialized projects without creating anything', (t) => {
  const cwd = fixture(t);
  const missing = path.join(cwd, 'missing');
  const uninitialized = path.join(cwd, 'uninitialized');
  mkdirSync(uninitialized);

  const lookup = status(cwd, ['status', 'j1', '-p', missing], 1);
  assert.equal(lookup.err.code, 'E_STATE');
  assert.ok(lookup.err.msg.includes(missing));
  const cancel = status(cwd, ['status', 'j1', '--cancel', '-p', uninitialized], 1);
  assert.equal(cancel.err.code, 'E_STATE');
  assert.ok(cancel.err.msg.includes(uninitialized));
  assert.deepEqual(readdirSync(cwd), ['uninitialized']);
  assert.deepEqual(readdirSync(uninitialized), []);
});
