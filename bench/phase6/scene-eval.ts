/**
 * One-time evaluation of the shipped scene classifier on the untouched test set
 * (bench/phase6/scene-test-labels.json, labels committed before any classifier run).
 *
 *   node bench/phase6/scene-eval.ts <feat-test.json>   (features from bench/phase6/scene-features.ts)
 */
import fs from 'node:fs';
import { classifyFrames, sceneModel, SCENE_CLASSES } from '../../packages/media/src/scenes.ts';
import type { SemFrame } from '../../packages/media/src/semantic.ts';

const rows = (JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as { id: string; t: number; label: string | null; frame: SemFrame }[]).filter((r) => r.label);
const m = sceneModel()!;
const K = SCENE_CLASSES.length, M = Array.from({ length: K }, () => new Array(K).fill(0));
let ok = 0, n = 0;
const byClip = new Map<string, { ok: number; n: number }>();
for (const r of rows) {
  const c = classifyFrames([r.frame], m);
  if (!c) continue;
  const y = SCENE_CLASSES.indexOf(r.label as never), p = SCENE_CLASSES.indexOf(c.label);
  M[y]![p]++; n++; if (y === p) ok++;
  const cat = r.id.split('_')[0]!; const b = byClip.get(cat) ?? { ok: 0, n: 0 }; b.n++; if (y === p) b.ok++; byClip.set(cat, b);
}
const recall = SCENE_CLASSES.map((c, i) => [c, M[i]!.reduce((s, v) => s + v, 0) ? +(M[i]![i]! / M[i]!.reduce((s, v) => s + v, 0)).toFixed(2) : null]);
console.log(JSON.stringify({ frames: n, accuracy: +(ok / n).toFixed(3), perClassRecall: Object.fromEntries(recall), byCategory: Object.fromEntries([...byClip].map(([k, v]) => [k, `${v.ok}/${v.n}`])), confusion: { rows: 'truth', cols: SCENE_CLASSES, M }, model: m.meta }, null, 1));
