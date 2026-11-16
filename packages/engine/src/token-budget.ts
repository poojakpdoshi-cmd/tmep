/** PRE-HACKATHON infrastructure. No provider, planner, tokenizer, or network calls. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TmepError, writeJson } from '../../core/src/index.ts';

type Stage = 'plan' | 'revision';
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  /** Required when reasoning is reported; avoids double-counting provider output totals. */
  outputIncludesReasoning?: boolean;
  totalTokens?: number;
}
interface Attempt {
  id: string; stage: Stage; input: number; outputLimit: number;
  basis: 'estimated' | 'provider-counted'; reserved: number;
  charged: number; state: 'pending' | 'unknown' | 'settled'; usage?: ProviderUsage;
}
interface Ledger { v: 1; attempts: Attempt[] }
const LIMIT = { plan: 5000, revision: 3000 } as const;
const INPUT = { plan: 3500, revision: 2000 } as const;
function integer(n: number) { return Number.isSafeInteger(n) && n >= 0; }
function usageTotal(u: ProviderUsage) {
  if (![u.inputTokens, u.outputTokens, u.reasoningTokens ?? 0, u.totalTokens ?? 0].every(integer)) throw new TmepError('E_INPUT', 'usage must contain nonnegative integer token counts');
  if (u.reasoningTokens !== undefined && typeof u.outputIncludesReasoning !== 'boolean') throw new TmepError('E_INPUT', 'declare whether output includes reasoning tokens');
  if (u.outputIncludesReasoning && (u.reasoningTokens ?? 0) > u.outputTokens) throw new TmepError('E_INPUT', 'reasoning cannot exceed inclusive output');
  const total = u.inputTokens + u.outputTokens + (u.outputIncludesReasoning ? 0 : u.reasoningTokens ?? 0);
  if (!Number.isSafeInteger(total) || (u.totalTokens !== undefined && u.totalTokens < total)) throw new TmepError('E_INPUT', 'inconsistent usage total');
  return u.totalTokens ?? total; // Include any additional provider-reported billed categories.
}

/** One durable ledger per editing job, shared across all attempts and processes. */
export class TokenBudget {
  readonly file: string;
  constructor(file: string) { this.file = path.resolve(file); }
  private async transaction<T>(fn: (l: Ledger) => T): Promise<T> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    let lock;
    try { lock = await fs.open(this.file + '.lock', 'wx'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new TmepError('E_STATE', 'budget ledger is locked', 'do not retry an AI request; recover a stale lock only after confirming its owner stopped');
      throw e;
    }
    try {
      let ledger: Ledger;
      try { ledger = JSON.parse(await fs.readFile(this.file, 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; ledger = { v: 1, attempts: [] }; }
      if (ledger.v !== 1 || !Array.isArray(ledger.attempts) || ledger.attempts.some(a =>
        !a || !['plan', 'revision'].includes(a.stage) || !['pending', 'unknown', 'settled'].includes(a.state) ||
        !['estimated', 'provider-counted'].includes(a.basis) || ![a.input, a.outputLimit, a.reserved, a.charged].every(integer) ||
        a.reserved !== a.input + a.outputLimit || a.input > INPUT[a.stage] || a.reserved > LIMIT[a.stage] ||
        (a.state === 'settled' ? !a.usage || usageTotal(a.usage) !== a.charged : a.charged !== a.reserved)) ||
        new Set(ledger.attempts.map(a => a.id)).size !== ledger.attempts.length) throw new TmepError('E_STATE', 'invalid budget ledger; refusing AI processing');
      const result = fn(ledger);
      await writeJson(this.file, ledger);
      return result;
    } finally { await lock.close(); await fs.unlink(this.file + '.lock'); }
  }
  async status() {
    return this.transaction(l => {
      const charged = l.attempts.reduce((n, a) => n + a.charged, 0);
      return { target: 8000, charged, remaining: Math.max(0, 8000 - charged),
        actual: l.attempts.filter(a => a.state === 'settled').reduce((n, a) => n + a.charged, 0),
        blocked: l.attempts.some(a => a.state !== 'settled' || a.charged > a.reserved) || charged >= 8000 || (['plan', 'revision'] as Stage[]).some(s => l.attempts.filter(a => a.stage === s).reduce((n, a) => n + a.charged, 0) > LIMIT[s]),
        billingCapVerified: false, attempts: structuredClone(l.attempts) };
    });
  }
  async settle(id: string, usage?: ProviderUsage) {
    return this.transaction(l => {
      const a = l.attempts.find(a => a.id === id);
      if (!a || a.state === 'settled') throw new TmepError('E_STATE', 'unknown or already settled attempt');
      if (!usage) { a.state = 'unknown'; return; }
      a.charged = usageTotal(usage); a.usage = structuredClone(usage); a.state = 'settled';
    });
  }
  /** Reserve durably before invocation. Errors/unknown usage block further calls. Never retries. */
  async execute<T>(request: { stage: Stage; input: string; maxOutputTokens: number; inputTokens?: number },
    invoke: (input: string, limits: { maxOutputTokens: number; attemptId: string }) => Promise<{ value: T; usage?: ProviderUsage }>) {
    if (!['plan', 'revision'].includes(request.stage) || typeof request.input !== 'string' || !request.input.trim() || !integer(request.maxOutputTokens) || !request.maxOutputTokens) throw new TmepError('E_INPUT', 'invalid budget request');
    // Byte count is a transparent estimate, not a provider tokenizer or a billing guarantee.
    const input = request.inputTokens ?? Buffer.byteLength(request.input, 'utf8');
    if (request.maxOutputTokens > (request.stage === 'plan' ? 1500 : 1000)) throw new TmepError('E_INPUT', 'output exceeds stage generation limit (including reasoning)');
    if (!integer(input) || input === 0 || input > INPUT[request.stage] || Buffer.byteLength(request.input) > 16000) throw new TmepError('E_INPUT', 'input exceeds stage context limit');
    const reserved = input + request.maxOutputTokens;
    const id = await this.transaction(l => {
      if (l.attempts.some(a => a.charged > a.reserved)) throw new TmepError('E_STATE', 'insufficient budget after provider overrun; AI processing stopped');
      if (l.attempts.some(a => a.state !== 'settled')) throw new TmepError('E_STATE', 'unresolved provider usage; AI processing stopped');
      const total = l.attempts.reduce((n, a) => n + a.charged, 0);
      const stage = l.attempts.filter(a => a.stage === request.stage).reduce((n, a) => n + a.charged, 0);
      if ((['plan', 'revision'] as Stage[]).some(s => l.attempts.filter(a => a.stage === s).reduce((n, a) => n + a.charged, 0) > LIMIT[s]) || total + reserved > 8000 || stage + reserved > LIMIT[request.stage]) throw new TmepError('E_STATE', 'insufficient token budget; AI processing stopped');
      const id = randomUUID();
      l.attempts.push({ id, stage: request.stage, input, outputLimit: request.maxOutputTokens, reserved, charged: reserved,
        basis: request.inputTokens === undefined ? 'estimated' : 'provider-counted', state: 'pending' });
      return id;
    });
    let result;
    try { result = await invoke(request.input, { maxOutputTokens: request.maxOutputTokens, attemptId: id }); }
    catch (e) { await this.settle(id); throw e; }
    await this.settle(id, result.usage);
    const status = await this.status();
    if (status.attempts.some(a => a.charged > a.reserved) || status.charged > 8000 || status.attempts.filter(a => a.stage === request.stage).reduce((n, a) => n + a.charged, 0) > LIMIT[request.stage]) throw new TmepError('E_STATE', 'provider exceeded reserved budget; further AI processing stopped');
    return { ...result, attemptId: id, accounting: status };
  }
}

/** Bounded extractive context; strings are untrusted source data, never instructions. */
export function editingContext(manifest: { assets: Record<string, unknown>[]; failures: unknown[] }) {
  if (!Array.isArray(manifest.assets) || !Array.isArray(manifest.failures) || manifest.assets.length + manifest.failures.length > 5) throw new TmepError('E_INPUT', 'standard Reel context supports up to five clips');
  const assets = manifest.assets.map(a => ({ id: String(a.id).slice(0, 12), dur: a.dur, lang: String(a.lang).slice(0, 16),
    status: a.status, tr: String(a.tr).slice(0, 120), approx: a.approx, vad: (a.vad as { status?: string } | undefined)?.status,
    cues: (Array.isArray(a.cues) ? a.cues : []).slice(0, 3).map(c => ({ s: c.s, e: c.e, text: String(c.text).slice(0, 64) })),
    truncated: true }));
  const text = JSON.stringify({ source: 'untrusted-extractive-context', assets, failedAssets: manifest.failures.length });
  if (Buffer.byteLength(text) > 3000) throw new TmepError('E_INPUT', 'compact context exceeds 3000 bytes; select fewer clips');
  return { text, bytes: Buffer.byteLength(text), estimateTokens: Buffer.byteLength(text), estimateMethod: 'UTF-8 bytes; not provider usage' };
}
