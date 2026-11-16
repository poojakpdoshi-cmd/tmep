import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TokenBudget, editingContext } from '../src/token-budget.ts';

async function ledger(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tmep budget '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new TokenBudget(path.join(root, 'job.json'));
}
test('reserves 5000 + 3000; counts inclusive reasoning once; hard-stops before invocation', async t => {
  const b = await ledger(t); let calls = 0;
  await b.execute({ stage: 'plan', input: 'context', inputTokens: 3500, maxOutputTokens: 1500 }, async (_, limit) => {
    calls++; assert.equal(limit.maxOutputTokens, 1500);
    return { value: 'plan', usage: { inputTokens: 3500, outputTokens: 1500, reasoningTokens: 500, outputIncludesReasoning: true, totalTokens: 5000 } };
  });
  const restored = new TokenBudget(b.file);
  await restored.execute({ stage: 'revision', input: 'changes', inputTokens: 2000, maxOutputTokens: 1000 }, async () => {
    calls++; return { value: 'revision', usage: { inputTokens: 2000, outputTokens: 800, reasoningTokens: 200, outputIncludesReasoning: false } };
  });
  await assert.rejects(b.execute({ stage: 'revision', input: 'retry', maxOutputTokens: 100 }, async () => { calls++; return { value: 'bad' }; }), /insufficient/);
  assert.equal(calls, 2);
  assert.equal((await b.status()).actual, 8000);
  assert.equal((await b.status()).billingCapVerified, false);
});
test('unknown usage and failures stay charged across restarts; explicit reconciliation permits budgeted retry', async t => {
  const b = await ledger(t); let calls = 0;
  await assert.rejects(b.execute({ stage: 'plan', input: 'test', maxOutputTokens: 100 }, async () => { calls++; throw new Error('network'); }), /network/);
  const state = await b.status();
  assert.equal(state.charged, 104); assert.equal(state.actual, 0);
  await assert.rejects(new TokenBudget(b.file).execute({ stage: 'plan', input: 'retry', maxOutputTokens: 100 }, async () => { calls++; return { value: 'bad' }; }), /unresolved/);
  await b.settle(state.attempts[0]!.id, { inputTokens: 4, outputTokens: 3 });
  await b.execute({ stage: 'plan', input: 'retry', maxOutputTokens: 100 }, async () => { calls++; return { value: 'unknown' }; });
  assert.equal((await b.status()).blocked, true); assert.equal(calls, 2);
});
test('input/output bounds, bad usage, overspend, and corrupt ledgers fail closed', async t => {
  const b = await ledger(t); let calls = 0;
  const invoke = async () => { calls++; return { value: 1 }; };
  await assert.rejects(b.execute({ stage: 'plan', input: 'x'.repeat(3501), maxOutputTokens: 1 }, invoke), /context limit/);
  await assert.rejects(b.execute({ stage: 'plan', input: 'x', maxOutputTokens: 1501 }, invoke), /output exceeds/);
  assert.equal(calls, 0);
  await assert.rejects(b.execute({ stage: 'plan', input: 'x', maxOutputTokens: 10 }, async () => ({ value: 1, usage: { inputTokens: 1, outputTokens: 9, reasoningTokens: 3 } })), /declare whether/);
  const id = (await b.status()).attempts[0]!.id;
  await b.settle(id, { inputTokens: 1, outputTokens: 8000 });
  await assert.rejects(b.execute({ stage: 'revision', input: 'x', maxOutputTokens: 10 }, invoke), /insufficient/);
  await writeFile(b.file, '{}');
  await assert.rejects(b.status(), /invalid budget ledger/);
});
test('concurrent controllers cannot oversubscribe a pending request', async t => {
  const b = await ledger(t); let release!: () => void;
  const waiting = new Promise<void>(r => { release = r; });
  let started!: () => void; const start = new Promise<void>(r => { started = r; });
  const first = b.execute({ stage: 'plan', input: 'x', maxOutputTokens: 10 }, async () => { started(); await waiting; return { value: 1, usage: { inputTokens: 1, outputTokens: 2 } }; });
  await start;
  await assert.rejects(new TokenBudget(b.file).execute({ stage: 'plan', input: 'x', maxOutputTokens: 10 }, async () => { throw new Error('must not call'); }), /unresolved/);
  release(); await first;
});
test('editing context is bounded and extractive without reading full transcript files', () => {
  const m = { assets: Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, dur: 10, lang: 'en', status: 'cached', tr: 'cache.json', cues: [{ s: 1, e: 2, text: 'original '.repeat(60) }] })), failures: [] };
  const context = editingContext(m);
  assert.ok(context.bytes <= 3000);
  assert.equal(JSON.parse(context.text).assets[0].cues[0].text, m.assets[0]!.cues[0]!.text.slice(0, 64));
  assert.throws(() => editingContext({ assets: [...m.assets, m.assets[0]!], failures: [] }), /five clips/);
});

test('provider reservation overrun stops further requests even below 8000 total', async t => {
  const b = await ledger(t);
  await assert.rejects(b.execute({ stage: 'plan', input: 'x', maxOutputTokens: 10 }, async () => ({ value: 1, usage: { inputTokens: 1, outputTokens: 20 } })), /exceeded reserved/);
  assert.equal((await b.status()).blocked, true);
  await assert.rejects(b.execute({ stage: 'revision', input: 'x', maxOutputTokens: 10 }, async () => ({ value: 1 })), /provider overrun/);
});
