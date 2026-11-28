/**
 * Phase 5 real-footage evaluation of shot-boundary detection (hard cuts + gradual transitions).
 *
 *   node bench/phase5/transitions-eval.ts --media <dir> [--labels bench/phase5/ugc-labels.json] [--download] [--out file.json]
 *
 * Labels follow `frame.labels/1` (see ugc-labels.json). `--download` fetches the labelled clips from
 * the public UGC dataset bucket into <dir> (≈ 33 × 2–17 MB; nothing is written into the repository).
 * Your own recordings work the same way: write a labels file with `file` names relative to <dir>.
 * The "phase4" row runs the unchanged Phase 4 rule set (no level-normalized thumbnails).
 */
import fs from 'node:fs';
import path from 'node:path';
import { videoStats, detectCuts, detectGradual } from '../../packages/media/src/footage.ts';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const media = arg('--media'); if (!media) { console.error('usage: --media <dir> [--labels f] [--download] [--out f]'); process.exit(2); }
const labels = JSON.parse(fs.readFileSync(arg('--labels', new URL('./ugc-labels.json', import.meta.url).pathname)!, 'utf8'));
const tol: number = labels.tolerance ?? 0.5;

type Clip = { id: string; set: string; file: string; cuts: number[]; gradual: number[]; partialGraphics?: number[]; screenUi?: number[]; ambiguous?: [number, string][] };
const local = (c: Clip) => path.join(media, path.basename(c.file));
if (process.argv.includes('--download')) {
  fs.mkdirSync(media, { recursive: true });
  for (const c of labels.clips as Clip[]) {
    if (fs.existsSync(local(c))) continue;
    const r = await fetch(new URL(c.file, labels.source));
    if (!r.ok) throw new Error(`${c.file}: HTTP ${r.status}`);
    fs.writeFileSync(local(c), Buffer.from(await r.arrayBuffer()));
    console.error('downloaded', c.id);
  }
}

const score = (det: number[], truth: number[], others: number[], amb: number[]) => {
  const used = new Set<number>(); let tp = 0; const fp: number[] = [], loc: number[] = [];
  for (const t of det) {
    const j = truth.findIndex((x, k) => !used.has(k) && Math.abs(x - t) <= tol);
    if (j >= 0) { used.add(j); tp++; loc.push(Math.abs(truth[j]! - t)); continue; }
    if (others.some((x) => Math.abs(x - t) <= tol) || amb.some((x) => Math.abs(x - t) <= tol)) continue;
    fp.push(t);
  }
  return { tp, fp, fn: truth.filter((_, k) => !used.has(k)), loc };
};

const rows: Record<string, unknown>[] = [];
const agg: Record<string, { tp: number; fp: number; fn: number; loc: number[] }> = {};
const add = (k: string, s: { tp: number; fp: number[]; fn: number[]; loc: number[] }) => {
  const a = (agg[k] ??= { tp: 0, fp: 0, fn: 0, loc: [] }); a.tp += s.tp; a.fp += s.fp.length; a.fn += s.fn.length; a.loc.push(...s.loc);
};
for (const c of labels.clips as Clip[]) {
  const f = local(c);
  if (!fs.existsSync(f)) { console.error('missing', f, '(use --download)'); continue; }
  const t0 = performance.now();
  const stats = await videoStats(process.env.FRAME_FFMPEG ?? 'ffmpeg', f, 10, 1800);
  const ms = performance.now() - t0;
  const cuts = detectCuts(stats, 10);
  const grad = detectGradual(stats, 10, cuts);
  const p4 = detectCuts(stats.map((s) => ({ ...s, t32: undefined })) as never, 10);
  const amb = (c.ambiguous ?? []).map((a) => a[0]);
  const all = [...c.cuts, ...c.gradual];
  const other = [...(c.partialGraphics ?? []), ...(c.screenUi ?? [])];
  const sCut = score(cuts.map((x) => x.t), c.cuts, [...other, ...c.gradual], amb);
  const sP4 = score(p4.map((x) => x.t), c.cuts, [...other, ...c.gradual], amb);
  const sGrad = score(grad.map((x) => x.t), c.gradual, [...other, ...c.cuts], amb);
  const sAny = score([...cuts.map((x) => x.t), ...grad.map((x) => x.t)].sort((a, b) => a - b), all, other, amb);
  for (const set of [c.set, 'all']) { add(`${set}/cuts`, sCut); add(`${set}/cuts-phase4`, sP4); add(`${set}/gradual`, sGrad); add(`${set}/any-boundary`, sAny); }
  rows.push({ id: c.id, set: c.set, ms: Math.round(ms), cuts: cuts.map((x) => x.t), gradual: grad.map((x) => x.t), phase4Cuts: p4.map((x) => x.t), fpCuts: sCut.fp, fnCuts: sCut.fn, fpGradual: sGrad.fp, fnGradual: sGrad.fn });
}
const r2 = (x: number) => Math.round(x * 100) / 100;
const summary = Object.fromEntries(Object.entries(agg).map(([k, a]) => [k, {
  tp: a.tp, fp: a.fp, fn: a.fn, precision: a.tp + a.fp ? r2(a.tp / (a.tp + a.fp)) : null, recall: a.tp + a.fn ? r2(a.tp / (a.tp + a.fn)) : null,
  meanLocErr: a.loc.length ? r2(a.loc.reduce((x, y) => x + y, 0) / a.loc.length) : null,
}]));
const out = { tolerance: tol, clips: rows.length, summary, rows };
if (arg('--out')) fs.writeFileSync(arg('--out')!, JSON.stringify(out, null, 1));
console.log(JSON.stringify(summary, null, 1));
