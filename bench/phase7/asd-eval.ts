/**
 * Phase 7.2 active-speaker evaluation on labelled dialogue (bench/phase7/asd-labels.json).
 * Compares the Phase 6 reframe (follow the primary person track) with the Phase 7 speaker-aware
 * framing on the same frames. Frames are cached (--cache) so parameter changes do not re-run the worker.
 *
 *   node bench/phase7/asd-eval.ts --video V --audio A [--words W.json] [--cache F] [--windows A,B] [--out F]
 * env: FRAME_MODELS, FRAME_PYTHONPATH
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { analyzeFootage } from '../../packages/media/src/footage.ts';
import { runWorker, trackObjects, findSubjects, reframeKeys, type SemFrame } from '../../packages/media/src/semantic.ts';
import { audioEnvelope, speechMask, faceTracks, activeSpeakers, speakerFraming, type FaceTrack } from '../../packages/media/src/speaker.ts';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const video = arg('video')!, audio = arg('audio') ?? video, cache = arg('cache'), only = arg('windows')?.split(',');
const L = JSON.parse(readFileSync(new URL('./asd-labels.json', import.meta.url), 'utf8'));
const words = arg('words') ? (JSON.parse(readFileSync(arg('words')!, 'utf8')).words as { s: number; e: number }[]) : undefined;
const FPS = 10, HOP = 0.25, ENV_HOP = 0.1;
const t0 = Date.now();
const fa = await analyzeFootage(video, { maxSeconds: 400 });
const W = Math.min(1280, fa.asset.w), H = Math.round((fa.asset.h * W) / fa.asset.w / 2) * 2;
const cw = (H * 9) / 16 / W; // 9:16 crop width as a share of the frame
const cuts: number[] = fa.observed.shots.slice(1).map((s) => s.t0);
let frames: Record<string, SemFrame[]> = cache && existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) : {};
const env = { ...process.env, PYTHONPATH: process.env.FRAME_PYTHONPATH };
let workerMs = 0, rss = 0;
for (const w of L.windows) {
  if (frames[w.id]) continue;
  const s = Date.now();
  const r = await runWorker('python3', env, 'ffmpeg', video, { fps: FPS, w: W, h: H, maxSeconds: w.t1 - w.t0, tasks: ['mouth', 'objects', 'faces', 'pose'], start: w.t0 });
  frames[w.id] = r.frames; workerMs += Date.now() - s; rss = Math.max(rss, r.maxRssMB ?? 0);
}
if (cache) writeFileSync(cache, JSON.stringify(frames));
const envDb = await audioEnvelope('ffmpeg', audio, ENV_HOP, 400);
const speech = speechMask(envDb, ENV_HOP, words);

type Span = { t0: number; t1: number };
const inSpan = (t: number, s: Span) => t >= s.t0 && t < s.t1;
const visibleAt = (tracks: FaceTrack[], t: number) => tracks.filter((tr) => tr.t0 <= t && t < tr.t1)
  .map((tr) => ({ tr, s: tr.samples.reduce((b, x) => (Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b)) }));
const centreAt = (keys: { t: number; cx: number }[], t: number) => {
  if (!keys.length) return 0.5;
  if (t <= keys[0]!.t) return keys[0]!.cx;
  for (let i = 1; i < keys.length; i++) if (t < keys[i]!.t) { const a = keys[i - 1]!, b = keys[i]!; return a.cx + ((b.cx - a.cx) * (t - a.t)) / (b.t - a.t); }
  return keys.at(-1)!.cx;
};
// In-shot crop travel (pans), in frame widths; repositioning at a cut is a hard step, not visible motion.
const travel = (keys: { t: number; cx: number }[], cuts: number[]) => keys.slice(1).reduce((a, k, i) => (cuts.some((c) => c > keys[i]!.t && c <= k.t + 1e-6) ? a : a + Math.abs(k.cx - keys[i]!.cx)), 0);

const res: Record<string, unknown>[] = [];
const agg = { two: { n: 0, ok: 0, covered: 0 }, react: { n: 0, falseSpeaker: 0 }, yes: { n: 0, hit: 0 }, inCrop: { n: 0, p6: 0, p7: 0 }, travel: { p6: 0, p7: 0, seconds: 0 }, switches: { p7: 0, labelled: 0 }, offscreen: { n: 0, attributed: 0 }, split: 0 };
for (const w of L.windows.filter((x: { id: string }) => !only || only.includes(x.id))) {
  const fr = frames[w.id]!;
  const wc = cuts.filter((c) => c > w.t0 && c < w.t1);
  const tracks = faceTracks(fr, wc, FPS);
  const sp = activeSpeakers(tracks, envDb, speech, ENV_HOP, w.t0, w.t1, { hop: HOP });
  const shots = [{ t0: w.t0 }, ...wc.map((t) => ({ t0: t }))];
  const p7 = speakerFraming(tracks, sp.windows, { w: cw, h: 1 }, shots, HOP);
  // Phase 6: follow the primary person (presenter or largest persistent person) for the whole window.
  const ot = trackObjects(fr, FPS, wc);
  const subj = findSubjects(ot, w.t1 - w.t0);
  const p6 = reframeKeys(ot.find((t) => t.id === (subj.presenter ?? subj.primary)), { w: W, h: H }, [9, 16], shots);
  const inside = (cx: number, face: { box: number[] }) => { const fx = face.box[0]! + face.box[2]! / 2; return fx >= cx - cw / 2 && fx <= cx + cw / 2; };
  let lastLabelSide: string | undefined;
  for (let t = w.t0; t < w.t1; t += HOP) {
    const win = sp.windows.find((x) => Math.abs(x.t - t) < 1e-6);
    const vis = visibleAt(tracks, t);
    const two = L.twoShots.find((s: Span) => inSpan(t, s));
    if (two) {
      const lab = two.speaking.find((s: Span) => inSpan(t, s));
      if (lab && vis.length) {
        const sorted = [...vis].sort((a, b) => a.s.box[0] - b.s.box[0]);
        const gt = lab.side === 'left' ? sorted[0]! : sorted.at(-1)!;
        if (vis.length >= 2 || lab.side === 'left') {
          agg.two.n++;
          if (win?.speaker) { agg.two.covered++; if (win.speaker === gt.tr.id) agg.two.ok++; }
        }
        agg.inCrop.n++; if (inside(centreAt(p6.keys, t), gt.s)) agg.inCrop.p6++; if (inside(centreAt(p7.keys, t), gt.s)) agg.inCrop.p7++;
        if (lastLabelSide && lab.side !== lastLabelSide) agg.switches.labelled++;
        lastLabelSide = lab.side;
      }
    }
    const one = L.singles.find((s: Span) => inSpan(t, s));
    if (one && vis.length === 1 && win?.speech) {
      if (one.speaking) { agg.yes.n++; if (win.speaker) agg.yes.hit++; agg.inCrop.n++; if (inside(centreAt(p6.keys, t), vis[0]!.s)) agg.inCrop.p6++; if (inside(centreAt(p7.keys, t), vis[0]!.s)) agg.inCrop.p7++; }
      else { agg.react.n++; if (win.speaker) agg.react.falseSpeaker++; }
    }
    const off = L.offscreen.find((s: Span) => inSpan(t, s));
    if (off && win?.speech) { agg.offscreen.n++; if (win.speaker) agg.offscreen.attributed++; }
  }
  const segs = sp.segments;
  agg.switches.p7 += segs.slice(1).filter((s, i) => s.track !== segs[i]!.track && s.t0 - segs[i]!.t1 < 0.6 && !wc.some((c) => c > segs[i]!.t1 - 0.3 && c <= s.t0 + 0.3)).length;
  agg.travel.p6 += travel(p6.keys, wc); agg.travel.p7 += travel(p7.keys, wc); agg.travel.seconds += w.t1 - w.t0;
  agg.split += p7.recommendations.length;
  res.push({ window: w.id, faceTracks: tracks.length, cuts: wc.length, segments: segs.map((s) => [s.t0, s.t1, s.track]), p6: { subject: p6.subject, keys: p6.keys.length }, p7: { keys: p7.keys.length, recommendations: p7.recommendations } });
}
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);
const summary = {
  frames: Object.values(frames).reduce((a, f) => a + f.length, 0), workerMs, maxRssMB: rss, totalMs: Date.now() - t0, speechSource: words ? 'transcript words' : 'audio level',
  twoShotSpeakerAccuracy: pct(agg.two.ok, agg.two.covered), twoShotCoverage: pct(agg.two.covered, agg.two.n), twoShotSteps: agg.two.n,
  visibleSpeakerRecall: pct(agg.yes.hit, agg.yes.n), visibleSpeakerSteps: agg.yes.n, reactionFalseSpeakerRate: pct(agg.react.falseSpeaker, agg.react.n), reactionSteps: agg.react.n, offscreenAttributed: pct(agg.offscreen.attributed, agg.offscreen.n),
  speakerInCrop: { phase6: pct(agg.inCrop.p6, agg.inCrop.n), phase7: pct(agg.inCrop.p7, agg.inCrop.n), steps: agg.inCrop.n },
  cropTravelPerMin: { phase6: Math.round((agg.travel.p6 / agg.travel.seconds) * 60 * 100) / 100, phase7: Math.round((agg.travel.p7 / agg.travel.seconds) * 60 * 100) / 100 },
  speakerSwitches: { phase7: agg.switches.p7, labelled: agg.switches.labelled }, splitScreenRecommendations: agg.split,
};
const out = { summary, windows: res };
if (arg('out')) writeFileSync(arg('out')!, JSON.stringify(out, null, 1));
console.log(JSON.stringify(summary, null, 1));
