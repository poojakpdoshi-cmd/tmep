/**
 * Extract per-frame scene features for labelled clips with the production MediaPipe worker
 * (embeddings + faces + objects + pose) at the labelled times (2.5, 7.5, 12.5, 17.5 s).
 *
 *   FRAME_MODELS=<dir> [FRAME_PYTHONPATH=<site>] node bench/phase6/scene-features.ts <labels.json> <mediaDir...> --out f.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { runWorker, type SemFrame } from '../../packages/media/src/semantic.ts';
import { semanticRuntime } from '../../packages/media/src/models.ts';
import { probe } from '../../packages/media/src/ffmpeg.ts';

const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1]!;
const [labelsFile, ...dirs] = args.filter((a, i) => a !== '--out' && args[i - 1] !== '--out');
const labels = JSON.parse(fs.readFileSync(labelsFile!, 'utf8')) as { clips: { id: string; file: string; labels: (string | null)[] }[] };
const rt = await semanticRuntime();
if (!rt.python) throw new Error(rt.reason);
const find = (f: string) => dirs.map((d) => path.join(d, path.basename(f))).find((p) => fs.existsSync(p));
const rows: { id: string; t: number; label: string | null; frame: SemFrame }[] = [];
for (const c of labels.clips) {
  const file = find(c.file);
  if (!file) { console.error('missing', c.id); continue; }
  const pr = await probe(file);
  const w = Math.min(640, pr.w!) & ~1, h = Math.round((w * pr.h!) / pr.w! / 2) * 2;
  // start 2.5 s, one frame every 2.5 s; keep 2.5, 7.5, 12.5, 17.5 (the fps filter can drop a last 5 s step)
  const { frames } = await runWorker(rt.python, rt.env, 'ffmpeg', file, { fps: 0.4, w, h, maxSeconds: 17.5, tasks: ['objects', 'faces', 'pose', 'embed', 'scene', 'gestures'], start: 2.5 });
  [2.5, 7.5, 12.5, 17.5].forEach((t, i) => { const f = frames.find((x) => Math.abs(x.t - t) < 0.3); if (f) rows.push({ id: c.id, t, label: c.labels[i] ?? null, frame: f }); });
  process.stderr.write('.');
}
fs.writeFileSync(out, JSON.stringify(rows));
console.error(`\n${rows.length} frames → ${out}`);
