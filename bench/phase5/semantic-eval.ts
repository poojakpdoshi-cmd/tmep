/**
 * Phase 5 semantic-layer evaluation on real footage: scene types against span labels, plus runtime,
 * worker memory, record size and per-clip observations (tracks, subjects, events) for inspection.
 *
 *   FRAME_MODELS=<dir> [FRAME_PYTHONPATH=<site>] node bench/phase5/semantic-eval.ts --media <dir> [--labels f] [--out f] [--no-ocr]
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeFootage } from '../../packages/media/src/footage.ts';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const media = arg('--media')!;
const labels = JSON.parse(fs.readFileSync(arg('--labels', new URL('./ugc-scene-labels.json', import.meta.url).pathname)!, 'utf8')) as { spans: { id: string; t0: number; t1: number; label: string }[] };
const ids = [...new Set(labels.spans.map((s) => s.id))];
const rows: Record<string, unknown>[] = [];
const confusion: Record<string, Record<string, number>> = {};
let hit = 0, total = 0, secHit = 0, secTotal = 0;
for (const id of ids) {
  const file = fs.readdirSync(media).find((f) => f.startsWith(id));
  if (!file) { console.error('missing', id); continue; }
  const t = performance.now();
  const a = await analyzeFootage(path.join(media, file), { semantic: true, temporalText: !process.argv.includes('--no-ocr') });
  const ms = Math.round(performance.now() - t);
  if (a.capabilities.semantic?.status !== 'ok') throw new Error(`semantic unavailable: ${JSON.stringify(a.capabilities.semantic)}`);
  const sem = a.provenance.find((p) => p.analyzer === 'frame.semantic')!;
  const shotLabel = (tm: number) => { const s = a.observed.shots.find((x) => tm >= x.t0 && tm < x.t1) ?? a.observed.shots.at(-1)!; return a.inferred.sceneTypes!.find((x) => x.shot === s.id)!.label; };
  for (const sp of labels.spans.filter((s) => s.id === id)) {
    // Score every 0.5 s inside the span (shot boundaries may differ from label boundaries).
    const votes: Record<string, number> = {};
    for (let tm = sp.t0 + 0.25; tm < sp.t1; tm += 0.5) { const l = shotLabel(tm); votes[l] = (votes[l] ?? 0) + 1; secTotal += 0.5; if (l === sp.label) secHit += 0.5; }
    const pred = Object.entries(votes).sort((x, y) => y[1] - x[1])[0]![0];
    (confusion[sp.label] ??= {})[pred] = (confusion[sp.label]![pred] ?? 0) + 1;
    total++; if (pred === sp.label) hit++;
  }
  rows.push({ id, ms, semanticMs: sem.ms, ...sem.params, recordKB: +(JSON.stringify(a).length / 1024).toFixed(1),
    shots: a.observed.shots.map((s) => [s.t0, s.t1, a.inferred.sceneTypes!.find((x) => x.shot === s.id)!.label]),
    tracks: (a.observed.tracks ?? []).filter((x) => x.n >= 3).map((x) => `${x.id} ${x.t0}-${x.t1} n${x.n} v${x.speed}`),
    subjects: a.inferred.subjects, activities: a.inferred.activities?.map((x) => `${x.track}:${x.label}`), duplicates: a.inferred.duplicates, events: a.inferred.events?.map((e) => ({ t: e.t, signals: e.signals })), textChanges: a.inferred.textChanges });
  console.error(id, ms, 'ms');
}
const out = { spans: total, spanAccuracy: +(hit / total).toFixed(2), timeWeightedAccuracy: +(secHit / secTotal).toFixed(2), confusion, rows };
if (arg('--out')) fs.writeFileSync(arg('--out')!, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ spans: total, spanAccuracy: out.spanAccuracy, timeWeightedAccuracy: out.timeWeightedAccuracy, confusion }, null, 1));
