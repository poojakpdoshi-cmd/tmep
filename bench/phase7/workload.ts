/**
 * Phase 7.7 external-agent workload: the same planted defects (a cut through a word, an unauthorized
 * colour look) on a real segment, fixed (a) by an agent that inspects, writes fix ops, previews and
 * re-inspects itself — the Phase 6 division of labour — and (b) by FRAME's verified correction stage.
 * Counts tool calls, agent-written and agent-read payload (estimated tokens, bench/tokens.ts), wall time.
 * Provider-reported tokens: none (no authorized model integration; no paid calls).
 *
 *   node bench/phase7/workload.ts --segment tos-15-75.mp4 --srt tos-15-75.srt --out <dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import * as api from '../../packages/engine/src/api.ts';
import { produce } from '../../packages/engine/src/production.ts';
import { estimateTokens } from '../tokens.ts';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1]! : ''; };
const seg = path.resolve(arg('--segment')), srt = path.resolve(arg('--srt')), out = path.resolve(arg('--out'));
const words: { s: number; e: number }[] = [];
for (const m of fs.readFileSync(srt, 'utf8').matchAll(/(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)/g)) words.push({ s: +m[1]! * 3600 + +m[2]! * 60 + +m[3]! + +m[4]! / 1000, e: +m[5]! * 3600 + +m[6]! * 60 + +m[7]! + +m[8]! / 1000 });
const cut = words[1]!.s + 0.6; // inside the second subtitle line: lands inside a word with high probability
const constraints = { target: 40, ratio: '9:16' as const, captions: true };
const plant = { roughcut: { ops: [{ op: 'format', ratio: '9:16' }, { op: 'keep', src: 'v1', ranges: [[Math.max(0, words[0]!.s - 0.2), words[0]!.e + 0.2], [cut, words.at(-1)!.e + 0.2]] }] }, finish: { ops: [{ op: 'color', saturation: 1.35 }] } };

async function workflow(name: string, body: (ctx: api.Ctx, log: (n: string, a: unknown, r: unknown) => void) => Promise<void>) {
  const dir = path.join(out, `wl-${name}`); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const ctx: api.Ctx = { project: dir, detail: 'standard', mediaRoots: [path.dirname(seg), dir], outRoots: [dir] };
  const calls: { name: string; wrote: number; read: number }[] = [];
  const log = (n: string, a: unknown, r: unknown) => calls.push({ name: n, wrote: estimateTokens(JSON.stringify(a)), read: estimateTokens(JSON.stringify(r ?? null)) });
  const t0 = performance.now();
  log('video_import', { paths: [seg] }, await api.importMedia(ctx, { paths: [seg] }));
  log('video_transcribe', { asset: 'v1', file: srt }, await api.transcribe(ctx, { asset: 'v1', file: srt }));
  await body(ctx, log);
  const qa = await api.inspect(ctx, { what: 'qa', constraints }) as { editorial: { objective: number } };
  return { workflow: name, calls: calls.length, agentWrittenTok: calls.reduce((s, c) => s + c.wrote, 0), agentReadTok: calls.reduce((s, c) => s + c.read, 0), ms: Math.round(performance.now() - t0), objectiveAfter: qa.editorial.objective, perCall: calls };
}

const rows = [];
// (a) Agent-driven correction (Phase 6 division of labour): FRAME produces, the agent verifies and fixes.
rows.push(await workflow('agent-corrects', async (ctx, log) => {
  const args = { action: 'start', id: 'reel', asset: 'v1', genre: 'cinematic', constraints, overrides: { ...plant, correct: { skip: true } }, until: 'correct' } as const;
  log('video_plan', { mode: 'produce', ...args }, await produce(ctx, args as never));
  const qa1 = await api.inspect(ctx, { what: 'qa', constraints }) as { findings: { class?: string; fixOps?: unknown[]; at?: [number, number] }[] };
  log('video_inspect', { what: 'qa' }, qa1);
  const fixes = qa1.findings.filter((f) => f.class === 'objective' && f.fixOps?.length);
  const ops = fixes.flatMap((f) => f.fixOps!);
  log('video_edit', { ops }, await api.edit(ctx, { ops: ops as never, note: 'agent fixes' }));
  const at = fixes.find((f) => f.at)?.at;
  if (at) { const o = path.join(ctx.project, 'renders', 'check.mp4'); log('video_render', { out: o, preview: true, range: [Math.max(0, at[0] - 0.5), at[1] + 0.5] }, await api.render(ctx, { out: o, preview: true, range: [Math.max(0, at[0] - 0.5), at[1] + 0.5], wait: 600 })); }
  log('video_inspect', { what: 'qa' }, await api.inspect(ctx, { what: 'qa', constraints }));
}));
// (b) FRAME's verified correction stage.
rows.push(await workflow('frame-corrects', async (ctx, log) => {
  const args = { action: 'start', id: 'reel', asset: 'v1', genre: 'cinematic', constraints, overrides: plant, until: 'correct' } as const;
  log('video_plan', { mode: 'produce', ...args }, await produce(ctx, args as never));
}));
fs.writeFileSync(path.join(out, 'workload.json'), JSON.stringify(rows, null, 1));
console.log(JSON.stringify(rows.map(({ perCall, ...r }) => r), null, 1));
