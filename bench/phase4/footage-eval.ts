/**
 * Phase 4B evaluation of local footage intelligence against labelled synthetic footage.
 *
 * Each case is generated with known ground truth (cut times, a gradual dissolve that must NOT be a
 * hard cut, a one-frame flash that must NOT be a cut, loud audio events, silences, a static region),
 * analyzed with analyzeFootage(), and scored: cut precision/recall and timing error, silence IoU,
 * moment recall within ±1 s, quiet-region correctness, runtime and peak RSS.
 * Synthetic footage measures algorithm behaviour, not real-world accuracy — that needs licensed
 * real footage (see docs/phase-4/INTELLIGENCE.md).
 *
 *   node bench/phase4/footage-eval.ts [workdir]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeFootage } from '../../packages/media/src/footage.ts';

const work = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'frame-footage-eval'));
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const ff = (a: string[]) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a]); if (r.status !== 0) throw new Error(String(r.stderr).slice(0, 600)); };

interface Truth { cuts: number[]; silences: [number, number][]; events: number[]; quietCell: number; notCuts: number[] }
interface Case { name: string; file: string; truth: Truth }

// Shots: distinct sources, each with motion; graphics drawn in the top-left cell are static (quiet).
const shotSrc = [
  'testsrc2=s=640x360:r=30', 'mandelbrot=s=640x360:r=30', 'smptehdbars=s=640x360:r=30,hue=h=t*40', 'cellauto=s=640x360:r=30:rule=110',
  'life=s=640x360:r=30:mold=10:ratio=0.2:death_color=#203040:life_color=#e0c060,scale=640:360', 'testsrc=s=640x360:r=30',
];
function makeCase(name: string, durations: number[], opts: { dissolveAt?: number; flashAt?: number; events: number[]; silences: [number, number][] }): Case {
  const parts = durations.map((d, i) => path.join(work, `${name}-p${i}.mp4`));
  durations.forEach((d, i) => ff(['-f', 'lavfi', '-i', `${shotSrc[i % shotSrc.length]},drawbox=x=0:y=0:w=213:h=120:color=0x101010:t=fill,format=yuv420p`, '-t', String(d), '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', parts[i]!]));
  const total = durations.reduce((a, b) => a + b, 0);
  // Video: concat hard cuts; optionally replace one boundary with a 1 s dissolve; optional 1-frame flash.
  let v = parts.map((_, i) => `[${i}:v]fps=30,settb=1/30,setpts=PTS-STARTPTS[v${i}]`).join(';');
  let last = 'v0', cuts: number[] = [], t = 0;
  const notCuts: number[] = [];
  for (let i = 1; i < parts.length; i++) {
    t += durations[i - 1]!;
    if (opts.dissolveAt === i) {
      v += `;[${last}][v${i}]xfade=transition=fade:duration=1:offset=${t - 1},settb=1/30[x${i}]`;
      notCuts.push(t - 0.5);
      t -= 1;
    } else {
      v += `;[${last}][v${i}]concat=n=2:v=1:a=0,settb=1/30[x${i}]`;
      cuts.push(t);
    }
    last = `x${i}`;
  }
  const realTotal = opts.dissolveAt ? total - 1 : total;
  if (opts.flashAt !== undefined) { v += `;[${last}]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(n,${Math.round(opts.flashAt * 30)},${Math.round(opts.flashAt * 30) + 2})'[vf]`; last = 'vf'; notCuts.push(opts.flashAt); }
  // Audio: room tone, loud bursts at events, true silence windows.
  const ev = opts.events.map((e) => `between(t,${e},${e + 0.6})`).join('+') || '0';
  const sil = opts.silences.map(([a, b]) => `between(t,${a},${b})`).join('+') || '0';
  const audio = `anoisesrc=d=${realTotal}:c=pink:r=48000:a=0.04,volume='if(${ev},12,if(${sil},0,1))':eval=frame`;
  const file = path.join(work, `${name}.mp4`);
  ff([...parts.flatMap((p) => ['-i', p]), '-f', 'lavfi', '-i', audio, '-filter_complex', v, '-map', `[${last}]`, '-map', `${parts.length}:a`, '-t', String(realTotal),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  if (opts.dissolveAt) cuts = cuts.map((c) => c); // cut times after the dissolve already shifted in the loop
  return { name, file, truth: { cuts, silences: opts.silences, events: opts.events, quietCell: 0, notCuts } };
}

// Held-out adversarial case (added after tuning): one continuous shot with fast panning and a
// lighting change — any detected cut is a false positive.
function panCase(): Case {
  const file = path.join(work, 'fast-pan.mp4');
  ff(['-f', 'lavfi', '-i', "testsrc2=s=1280x360:r=30,scroll=h=0.012,crop=640:360:0:0,eq=brightness='0.25*sin(2*PI*t/6)',format=yuv420p", '-f', 'lavfi', '-i', 'anoisesrc=d=12:c=pink:r=48000:a=0.04',
    '-t', '12', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', file]);
  return { name: 'fast-pan', file, truth: { cuts: [], silences: [], events: [], quietCell: 0, notCuts: [] } };
}

const cases: Case[] = [
  panCase(),
  makeCase('montage', [3, 2.5, 2, 3.5, 2, 3], { events: [4.2, 10.1], silences: [[12.4, 13.6]] }),
  makeCase('dissolve-flash', [4, 4, 4, 4], { dissolveAt: 2, flashAt: 10.5, events: [6.3], silences: [[1.0, 2.2]] }),
  makeCase('fast-cuts', [1, 0.8, 1.2, 0.9, 1.1, 1, 0.7, 1.3], { events: [3.1, 6.4], silences: [] }),
];

const within = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const rows: Record<string, unknown>[] = [];
let tp = 0, fp = 0, fn = 0, errSum = 0, momentHit = 0, momentTotal = 0, fpNotCut = 0;
for (const c of cases) {
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  const a = await analyzeFootage(c.file);
  const ms = Date.now() - t0;
  const det = a.observed.shots.slice(1).map((s) => s.t0);
  const matched = c.truth.cuts.map((g) => det.find((d) => within(d, g, 0.15)));
  const ctp = matched.filter((m) => m !== undefined).length;
  const cfp = det.filter((d) => !c.truth.cuts.some((g) => within(d, g, 0.15))).length;
  const notCutHits = det.filter((d) => !c.truth.cuts.some((g) => within(d, g, 0.15)) && c.truth.notCuts.some((n) => within(d, n, 0.6))).length;
  const timeErr = matched.map((m, i) => (m === undefined ? undefined : Math.abs(m - c.truth.cuts[i]!))).filter((x): x is number => x !== undefined);
  tp += ctp; fp += cfp; fn += c.truth.cuts.length - ctp; errSum += timeErr.reduce((s, x) => s + x, 0); fpNotCut += notCutHits;
  const iou = c.truth.silences.map(([g0, g1]) => {
    const best = Math.max(0, ...a.observed.silences.map((s) => Math.max(0, Math.min(s.t1, g1) - Math.max(s.t0, g0)) / (Math.max(s.t1, g1) - Math.min(s.t0, g0))));
    return +best.toFixed(2);
  });
  const hits = c.truth.events.filter((e) => a.inferred.moments.some((m) => within(m.t, e + 0.3, 1))).length;
  momentHit += hits; momentTotal += c.truth.events.length;
  const quietOk = c.name === 'fast-pan' ? null : a.inferred.quietRegions[0] !== undefined && a.inferred.quietRegions[0]!.x < 0.34 && a.inferred.quietRegions[0]!.y < 0.34;
  const row = { name: c.name, dur: a.asset.dur, ms, rssMB: +((process.memoryUsage().rss - rss0) / 1048576).toFixed(1), truthCuts: c.truth.cuts.map((x) => +x.toFixed(2)), detectedCuts: det,
    cutTP: ctp, cutFP: cfp, cutFN: c.truth.cuts.length - ctp, notCutFalseHits: notCutHits, meanCutErrMs: timeErr.length ? +(timeErr.reduce((s, x) => s + x, 0) / timeErr.length * 1000).toFixed(1) : null,
    silenceIoU: iou, events: c.truth.events, moments: a.inferred.moments.map((m) => ({ t: m.t, conf: m.confidence, evidence: m.evidence })), momentRecall: `${hits}/${c.truth.events.length}`,
    quietRegionTopLeft: quietOk, scenes: a.inferred.scenes.length, pacing: a.inferred.pacing };
  rows.push(row);
  console.log(`${c.name.padEnd(15)} cuts TP ${ctp}/${c.truth.cuts.length} FP ${cfp} (dissolve/flash false hits ${notCutHits}) err ${row.meanCutErrMs}ms | silence IoU ${iou.join(',') || '-'} | moments ${hits}/${c.truth.events.length} | quiet TL ${quietOk} | ${ms} ms`);
}
const precision = tp / Math.max(1, tp + fp), recall = tp / Math.max(1, tp + fn);
const summary = { cutPrecision: +precision.toFixed(3), cutRecall: +recall.toFixed(3), meanCutErrMs: +(errSum / Math.max(1, tp) * 1000).toFixed(1), dissolveFlashFalseCuts: fpNotCut, momentRecall: `${momentHit}/${momentTotal}` };
console.log(JSON.stringify(summary));
const outFile = path.resolve(import.meta.dirname, '../../docs/phase-4/evidence/footage-eval.json');
writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), host: `${os.platform()} ${os.arch()} ${os.cpus().length} cpu, node ${process.version}`, media: 'synthetic labelled footage (not real-world accuracy)', summary, rows }, null, 1) + '\n');
