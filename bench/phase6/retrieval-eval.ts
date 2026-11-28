/**
 * Phase 6 semantic retrieval quality (query by example) on real frames.
 * Library: the 156 test-set frames (embeddings from the production worker); queries: the training
 * frames; a hit is a library frame with the same scene label (8 classes). Reports precision@k and mean
 * average precision for library.similar (MobileNetV3-large cosine) against the class-prior baseline.
 *
 *   node bench/phase6/retrieval-eval.ts <feat-test.json> <feat-train.json>
 */
import fs from 'node:fs';
import { similar, type LibraryEntry } from '../../packages/media/src/library.ts';
type Row = { id: string; t: number; label: string | null; frame: { embL?: number[] } };
const load = (f: string) => (JSON.parse(fs.readFileSync(f, 'utf8')) as Row[]).filter((r) => r.label && r.frame.embL);
const lib = load(process.argv[2]!), q = load(process.argv[3]!);
const entries = lib.map((r, i) => ({ id: `L${i}`, file: `${r.id}_${r.t}`, kind: 'image', tags: [], bytes: 0, sha256: '', licence: { id: 'CC-BY-4.0', status: 'verified', verified: true }, provenance: 'stock', added: '', emb: r.frame.embL }) as unknown as LibraryEntry);
const label = new Map(lib.map((r, i) => [`L${i}`, r.label]));
const K = [1, 5, 10];
const prec = Object.fromEntries(K.map((k) => [k, 0])) as Record<number, number>;
let ap = 0;
for (const r of q) {
  const res = similar(entries, r.frame.embL!, { k: entries.length });
  const rel = res.map((x) => label.get(x.id) === r.label);
  for (const k of K) prec[k] += rel.slice(0, k).filter(Boolean).length / k;
  let hits = 0, s = 0; rel.forEach((h, i) => { if (h) { hits++; s += hits / (i + 1); } });
  ap += hits ? s / hits : 0;
}
const prior = q.reduce((s, r) => s + lib.filter((l) => l.label === r.label).length / lib.length, 0) / q.length;
console.log(JSON.stringify({ library: entries.length, queries: q.length, precisionAt: Object.fromEntries(K.map((k) => [k, +(prec[k]! / q.length).toFixed(3)])), mAP: +(ap / q.length).toFixed(3), randomBaselinePrecision: +prior.toFixed(3) }, null, 1));
