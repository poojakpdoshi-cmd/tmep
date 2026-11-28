import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../src/project.ts';
import { emptyTimeline } from '../src/timeline.ts';

test('a lock left by a killed process is reclaimed at once; an empty orphan after 2 s', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'frame-lock-'));
  try {
    const p = await Project.open(dir, { create: true });
    // A child takes the project lock and is killed while holding it.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { Project } from ${JSON.stringify(new URL('../src/project.ts', import.meta.url).href)};
      const p = await Project.open(${JSON.stringify(dir)}, { create: false });
      await p.withLock(async () => { console.log('locked'); await new Promise(() => {}); });`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((res) => child.stdout.on('data', (d) => String(d).includes('locked') && res()));
    const lockFile = path.join(p.dir, 'lock');
    assert.ok(existsSync(lockFile));
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
    let t0 = Date.now();
    await p.commit(emptyTimeline(), []);
    assert.ok(Date.now() - t0 < 2000, `reclaimed after ${Date.now() - t0} ms`);
    // An empty lock (owner died between create and write) is stale after 2 s.
    writeFileSync(lockFile, '');
    const old = new Date(Date.now() - 3000);
    utimesSync(lockFile, old, old);
    t0 = Date.now();
    await p.commit(emptyTimeline(), []);
    assert.ok(Date.now() - t0 < 2000, `empty orphan reclaimed after ${Date.now() - t0} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
