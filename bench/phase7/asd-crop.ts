/**
 * Phase 7.6 objective framing check on production outputs: for each labelled speaking step
 * (bench/phase7/asd-labels.json) inside a produced reel, is the speaking face inside the reel's 9:16 crop?
 * Face positions come from the cached ASD frames (source time); the crop from the reel's timeline.
 *
 *   node bench/phase7/asd-crop.ts --frames frames720.json --eval <dir> --labels p6,p7 --segment 15-75
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { faceTracks } from '../../packages/media/src/speaker.ts';
import { cropCentre } from '../../packages/render/src/footage-qa.ts';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1]! : ''; };
const L = JSON.parse(readFileSync(new URL('./asd-labels.json', import.meta.url), 'utf8'));
const frames = JSON.parse(readFileSync(arg('--frames'), 'utf8'));
const [s0] = arg('--segment').split('-').map(Number) as [number, number];
const cuts: number[] = JSON.parse(process.env.CUTS ?? '[25,40.3]');
const tracks = faceTracks(frames.A, cuts, 10);
const cw = (266 * 9) / 16 / 640;
const out: Record<string, unknown> = {};
for (const label of arg('--labels').split(',')) {
  const rows = JSON.parse(readFileSync(path.join(arg('--eval'), `production-eval-${label}.json`), 'utf8')) as { segment: string; timeline: { clips: { in: number; out: number; cx: number }[] }; follow: { t: number; cx: number; cy: number }[][] }[];
  const row = rows.find((r) => r.segment === `tos-${arg('--segment')}`)!;
  let n = 0, inside = 0, inEdit = 0, steps = 0;
  for (const two of L.twoShots) for (const sp of two.speaking) for (let t = sp.t0; t < sp.t1; t += 0.25) {
    steps++;
    const ts = t - s0, k = row.timeline.clips.findIndex((c) => ts >= c.in && ts < c.out);
    if (k < 0) continue;
    inEdit++;
    const vis = tracks.filter((tr) => tr.t0 <= t && t < tr.t1).map((tr) => ({ tr, s: tr.samples.reduce((b, x) => (Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b)) })).sort((a, b) => a.s.box[0] - b.s.box[0]);
    if (!vis.length || (vis.length < 2 && sp.side === 'right')) continue;
    const gt = sp.side === 'left' ? vis[0]! : vis.at(-1)!;
    const clip = { ...row.timeline.clips[k]!, cy: 0.5, follow: row.follow[k]?.length ? row.follow[k] : undefined } as never;
    const [ox] = cropCentre(clip, ts), centre = cw / 2 + ox * (1 - cw), fx = gt.s.box[0] + gt.s.box[2] / 2;
    n++; if (Math.abs(fx - centre) <= cw / 2) inside++;
  }
  out[label] = { labelledSteps: steps, inEdit, measured: n, speakerInCrop: n ? Math.round((inside / n) * 1000) / 1000 : null };
}
console.log(JSON.stringify(out));
