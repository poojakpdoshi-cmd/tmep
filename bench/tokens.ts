/**
 * Token counting for the benchmark.
 *
 *  - `estimate` (default, offline): a BPE-like heuristic. It splits text the way
 *    byte-pair tokenizers typically do (words, 1-3 digit groups, punctuation) and
 *    counts long words as several tokens. It is an ESTIMATE; treat absolute numbers
 *    as roughly +-20% and rely on the ratio between workflows, which uses the same
 *    estimator on both sides.
 *  - `anthropic`: exact counts from the Anthropic token-counting endpoint
 *    (POST /v1/messages/count_tokens). Needs ANTHROPIC_API_KEY and network access.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/[A-Za-z]+|\d{1,3}|[ \t]{2,}|\n+|[^\sA-Za-z\d]/g)) {
    const s = m[0];
    if (/^[A-Za-z]/.test(s)) n += Math.max(1, Math.ceil(s.length / 6));
    else n += 1;
  }
  return n;
}

export type Counter = (text: string) => Promise<number>;

export function anthropicCounter(model = process.env.TMEP_BENCH_MODEL ?? 'claude-sonnet-5-5'): Counter {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  let overhead: number | undefined;
  const raw = async (text: string): Promise<number> => {
    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text || '.' }] }),
    });
    if (!res.ok) throw new Error(`count_tokens ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { input_tokens: number }).input_tokens;
  };
  return async (text) => {
    overhead ??= await raw('.');
    return Math.max(0, (await raw(text)) - overhead + 1);
  };
}

export const estimateCounter: Counter = async (t) => estimateTokens(t);
