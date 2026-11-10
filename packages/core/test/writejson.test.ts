/**
 * Atomic JSON writes under Windows-style sharing violations (Stabilization A3).
 * Rename/read failures are injected deterministically by patching fs.promises, so these run on
 * every OS. Contract: transient EPERM/EACCES/EBUSY are retried a bounded number of times; a write
 * that still fails throws and leaves no temporary file behind; other errors are not retried.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeJson, readJson } from '../src/util.ts';

const realRename = fsp.rename;
const realRead = fsp.readFile;
afterEach(() => {
  fsp.rename = realRename;
  fsp.readFile = realRead;
});

/** Make the next `n` renames fail with `code`; returns a counter of attempts. */
function failRenames(n: number, code: string): { attempts: number } {
  const c = { attempts: 0 };
  fsp.rename = (async (a: string, b: string) => {
    c.attempts++;
    if (n-- > 0) throw Object.assign(new Error(`${code}: injected rename failure`), { code, syscall: 'rename' });
    return realRename(a, b);
  }) as typeof fsp.rename;
  return c;
}
const dir = () => mkdtempSync(path.join(os.tmpdir(), 'tmep-wj-'));
const tmpLeft = (d: string) => readdirSync(d).filter((f) => f.includes('.tmp'));

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`transient ${code} on rename is retried and the write lands`, async () => {
    const d = dir();
    const f = path.join(d, 'j.json');
    writeFileSync(f, '{"v":1}');
    const c = failRenames(3, code);
    await writeJson(f, { v: 2 });
    assert.equal(c.attempts, 4);
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { v: 2 });
    assert.deepEqual(tmpLeft(d), []);
  });
}

test('a rename that keeps failing throws after bounded retries, keeps the old file and removes the temp file', async () => {
  const d = dir();
  const f = path.join(d, 'j.json');
  writeFileSync(f, '{"v":1}');
  const c = failRenames(Infinity, 'EPERM');
  const t0 = Date.now();
  await assert.rejects(writeJson(f, { v: 2 }), (e: NodeJS.ErrnoException) => e.code === 'EPERM');
  assert.ok(c.attempts > 1 && c.attempts <= 10, `bounded attempts: ${c.attempts}`);
  assert.ok(Date.now() - t0 < 5000, 'bounded time');
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { v: 1 }, 'previous record intact');
  assert.deepEqual(tmpLeft(d), [], 'no orphaned temp file');
});

test('non-transient rename errors are not retried and leave no temp file', async () => {
  const d = dir();
  const f = path.join(d, 'j.json');
  const c = failRenames(Infinity, 'EXDEV');
  await assert.rejects(writeJson(f, { v: 1 }), (e: NodeJS.ErrnoException) => e.code === 'EXDEV');
  assert.equal(c.attempts, 1);
  assert.deepEqual(tmpLeft(d), []);
});

test('callers can ask for a longer retry budget (terminal job states)', async () => {
  const d = dir();
  const f = path.join(d, 'j.json');
  const c = failRenames(12, 'EBUSY');
  await writeJson(f, { v: 3 }, true, { attempts: 16 });
  assert.equal(c.attempts, 13);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { v: 3 });
});

test('readJson retries a transient sharing violation', async () => {
  const d = dir();
  const f = path.join(d, 'j.json');
  writeFileSync(f, '{"ok":true}');
  let n = 2;
  fsp.readFile = (async (...a: Parameters<typeof fsp.readFile>) => {
    if (n-- > 0) throw Object.assign(new Error('EBUSY: injected read failure'), { code: 'EBUSY' });
    return realRead(...a);
  }) as typeof fsp.readFile;
  assert.deepEqual(await readJson(f), { ok: true });
});
