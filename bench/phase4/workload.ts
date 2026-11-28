/**
 * Phase 4 workload benchmark: what an external agent must read and write to learn "where are the
 * cuts, silences, loud moments and free screen regions" in a clip — conventionally vs with FRAME.
 *
 * Conventional path (measured, not imagined): the agent runs the standard FFmpeg analyses and reads
 * their output — scene-change showinfo log, silencedetect log and per-second astats — then reasons
 * over them. FRAME path: one `video_inspect {what:"brief"}` call.
 *
 * Payload sizes are exact character counts of real outputs; token figures use the repository's
 * heuristic tokenizer (bench/tokens.ts, ±20%) and are NOT provider-reported usage. No model was
 * called. Agent-written code is counted as the shell commands the conventional path needs.
 *
 *   node bench/phase4/workload.ts <video> [--task sports]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as api from '../../packages/engine/src/api.ts';
import { estimateTokens } from '../tokens.ts';

const file = path.resolve(process.argv[2] ?? '');
const task = process.argv.includes('--task') ? process.argv[process.argv.indexOf('--task') + 1]! : 'generic';
if (!process.argv[2]) throw new Error('usage: workload.ts <video> [--task t]');

const conventional = [
  ['ffmpeg', '-hide_banner', '-i', file, '-vf', "select='gt(scene,0.3)',showinfo", '-an', '-f', 'null', '-'],
  ['ffmpeg', '-hide_banner', '-i', file, '-af', 'silencedetect=n=-40dB:d=0.6', '-vn', '-f', 'null', '-'],
  ['ffmpeg', '-hide_banner', '-i', file, '-af', 'astats=metadata=1:reset=48000,ametadata=print:key=lavfi.astats.Overall.RMS_level', '-vn', '-f', 'null', '-'],
];
let convChars = 0, convText = '';
const convCmdChars = conventional.map((c) => c.join(' ').length).reduce((a, b) => a + b, 0);
const t0 = Date.now();
for (const cmd of conventional) {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { maxBuffer: 1 << 30 });
  const text = String(r.stderr) + String(r.stdout);
  convChars += text.length; convText += text;
}
const convMs = Date.now() - t0;
// Lean conventional variant: the agent filters each log to the lines it needs (more code, less reading).
const filters = [/pts_time:[\d.]+/g, /silence_(start|end): [\d.]+/g, /RMS_level=-?[\d.inf]+/g];
let leanText = '';
for (let i = 0; i < conventional.length; i++) {
  const r = spawnSync(conventional[i]![0]!, conventional[i]!.slice(1), { maxBuffer: 1 << 30 });
  leanText += (String(r.stderr).match(filters[i]!) ?? []).join('\n') + '\n';
}
const leanCode = conventional.map((c, i) => `${c.join(' ')} 2>&1 | grep -oE '${filters[i]!.source}'`).join('\n');

const proj = path.join(os.tmpdir(), `frame-workload-${process.pid}`);
rmSync(proj, { recursive: true, force: true });
mkdirSync(proj, { recursive: true });
const ctx = { project: proj, detail: 'standard' as const };
// Media must sit inside the project workspace (Phase 1 containment): copy it in.
const { copyFileSync } = await import('node:fs');
copyFileSync(file, path.join(proj, 'media' + path.extname(file)));
await api.importMedia(ctx, { paths: ['media' + path.extname(file)] });
const t1 = Date.now();
const brief = await api.inspect(ctx, { what: 'brief', asset: 'v1', task });
const frameMs = Date.now() - t1;
const t2 = Date.now();
await api.inspect(ctx, { what: 'brief', asset: 'v1', task });
const cachedMs = Date.now() - t2;
const call = JSON.stringify({ name: 'video_inspect', arguments: { what: 'brief', asset: 'v1', task } });
const reply = JSON.stringify(brief);
rmSync(proj, { recursive: true, force: true });

const out = {
  date: new Date().toISOString(), media: path.basename(file), task,
  tokenizer: 'heuristic estimate (bench/tokens.ts, ±20%); no provider usage measured',
  conventional: { toolCalls: conventional.length, agentWrittenChars: convCmdChars, agentWrittenTokens: estimateTokens(conventional.map((c) => c.join(' ')).join('\n')), readChars: convChars, readTokens: estimateTokens(convText), localMs: convMs, note: 'raw logs still need the agent to reason out moments and regions; not included' },
  conventionalLean: { toolCalls: conventional.length, agentWrittenChars: leanCode.length, agentWrittenTokens: estimateTokens(leanCode), readChars: leanText.length, readTokens: estimateTokens(leanText), note: 'filtered logs; moments, scenes, quality and regions still left to the agent' },
  frame: { toolCalls: 1, agentWrittenChars: call.length, agentWrittenTokens: estimateTokens(call), readChars: reply.length, readTokens: estimateTokens(reply), localMs: frameMs, cachedMs },
};
console.log(JSON.stringify(out, null, 1));
const evid = path.resolve(import.meta.dirname, '../../docs/phase-4/evidence');
mkdirSync(evid, { recursive: true });
writeFileSync(path.join(evid, `workload-${path.basename(file, path.extname(file))}-${task}.json`), JSON.stringify(out, null, 1) + '\n');
