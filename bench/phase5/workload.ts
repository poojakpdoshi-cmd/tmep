/**
 * Phase 5 workload benchmark: "who is the subject, what kind of shots are these, where are the event
 * candidates, and how should a 9:16 crop follow the subject?" on one real clip.
 *
 *   FRAME_MODELS=<dir> [FRAME_PYTHONPATH=<site>] node bench/phase5/workload.ts <video> [--task sports] [--out f.json]
 *
 * Conventional path: the agent writes a MediaPipe script itself (the minimal one is FRAME's own
 * worker, counted as agent-written code), runs it, and must read its per-frame output; the "lean"
 * variant drops embeddings and keypoints. Neither includes the tracking/scene/event reasoning the
 * FRAME brief already contains. Token figures use the repository heuristic (bench/tokens.ts, ±20 %)
 * on exact payloads; they are size estimates, not provider-reported usage (no model API is called).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as api from '../../packages/engine/src/api.ts';
import { modelDir, semanticRuntime } from '../../packages/media/src/models.ts';
import { probe } from '../../packages/media/src/ffmpeg.ts';
import { estimateTokens } from '../tokens.ts';

const file = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: workload.ts <video> [--task t] [--out f]');
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const task = arg('--task', 'sports')!;
const rt = await semanticRuntime();
if (!rt.python) throw new Error(rt.reason);
const pr = await probe(file);
const w = Math.min(640, pr.w!), h = Math.round((w * pr.h!) / pr.w! / 2) * 2;
const worker = new URL('../../packages/media/py/semantic.py', import.meta.url).pathname;

// Conventional: write + run the script, read everything it prints.
const t0 = performance.now();
const r = spawnSync(rt.python, [worker, modelDir(), 'ffmpeg', file, '2', String(w), String(h), '1800', 'objects,faces,pose,embed'], { env: rt.env, maxBuffer: 1 << 30 });
const convMs = performance.now() - t0;
const raw = String(r.stdout);
const lean = raw.split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); delete j.emb; if (j.poses) j.poses = j.poses.map((p: { box: unknown }) => ({ box: p.box })); return JSON.stringify(j); }).join('\n');
const script = readFileSync(worker, 'utf8');

// FRAME: one call (cold), then the same call cached.
const work = path.join(os.tmpdir(), `frame-p5-workload-${process.pid}`);
rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
const ctx = { project: work, detail: 'standard' as const };
await api.importMedia(ctx, { paths: [file] });
const call = { what: 'brief', asset: 'v1', task, semantic: true };
const t1 = performance.now();
const brief = await api.inspect(ctx, call);
const frameMs = performance.now() - t1;
const t2 = performance.now();
await api.inspect(ctx, call);
const cachedMs = performance.now() - t2;
const cacheDir = path.join(work, '.tmep', 'cache', 'footage');
const cacheBytes = spawnSync('du', ['-sb', cacheDir]).stdout.toString().split('\t')[0];
const payload = JSON.stringify(brief);
const request = JSON.stringify({ name: 'video_inspect', arguments: call });
rmSync(work, { recursive: true, force: true });

const out = {
  media: { file: path.basename(file), dur: pr.dur, size: `${pr.w}x${pr.h}` },
  conventional: { toolCalls: 2, agentWrittenTok: estimateTokens(script), agentReadTok: estimateTokens(raw), runtimeMs: Math.round(convMs), note: 'write script + run; output still needs tracking, scene, event and reframe reasoning' },
  conventionalLean: { toolCalls: 2, agentWrittenTok: estimateTokens(script) + 60, agentReadTok: estimateTokens(lean) },
  frame: { toolCalls: 1, agentWrittenTok: estimateTokens(request), agentReadTok: estimateTokens(payload), runtimeMs: Math.round(frameMs), cachedMs: Math.round(cachedMs), cacheBytes: Number(cacheBytes) },
  briefKeys: Object.keys(brief),
};
if (arg('--out')) writeFileSync(arg('--out')!, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
