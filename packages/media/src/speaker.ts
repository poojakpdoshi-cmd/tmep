/**
 * FRAME active-speaker intelligence (Phase 7.2): audio-visual speaker detection and speaker-aware
 * reframing. Deterministic TypeScript over FaceLandmarker mouth measurements (jawOpen + lip gap at
 * ~10 fps) and the programme audio (RMS every 0.1 s, or transcript words when present).
 *
 * Per face track and 0.25 s hop: mouth activity (variation of mouth opening over ±0.4 s) and the
 * correlation of mouth movement with the audio envelope. A face becomes the active speaker when speech
 * is present and its score leads; switching needs the lead to persist (0.5 s) after a minimum dwell
 * (1.2 s), so brief reactions or noise do not flip the speaker.
 */
import { spawn } from 'node:child_process';

export interface MouthSample { t: number; box: [number, number, number, number]; jaw: number; gap: number }
export interface FaceTrack { id: string; samples: MouthSample[]; x: number; area: number }
export interface SpeakerWindow { t: number; speech: boolean; speaker?: string; scores: Record<string, number>; faces: number }
export interface SpeakerSegment { t0: number; t1: number; track?: string; confidence: number }
export interface Recommendation { at: [number, number]; kind: 'split-screen'; reason: string }

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const iou = (a: number[], b: number[]) => { const x0 = Math.max(a[0]!, b[0]!), y0 = Math.max(a[1]!, b[1]!), x1 = Math.min(a[0]! + a[2]!, b[0]! + b[2]!), y1 = Math.min(a[1]! + a[3]!, b[1]! + b[3]!); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / Math.max(1e-9, a[2]! * a[3]! + b[2]! * b[3]! - i); };

/** Link per-frame faces into tracks (IoU ≥ 0.3 or centre within one face width); cuts end tracks. */
export function faceTracks(frames: { t: number; mouths?: [number, number, number, number, number, number][] }[], cuts: number[] = [], fps = 10): FaceTrack[] {
  const open: { id: number; last: number; s: MouthSample[] }[] = [], done: typeof open = [];
  let next = 1;
  for (const f of frames) {
    for (const o of [...open]) if (f.t - o.last > 3 / fps || cuts.some((c) => c > o.last && c <= f.t)) { done.push(o); open.splice(open.indexOf(o), 1); }
    const used = new Set<number>();
    for (const m of f.mouths ?? []) {
      const box = [m[0], m[1], m[2], m[3]] as [number, number, number, number];
      let best: (typeof open)[number] | undefined, bs = 0;
      for (const o of open) {
        if (used.has(o.id)) continue;
        const pb = o.s.at(-1)!.box, ov = iou(pb, box), near = Math.hypot(pb[0] + pb[2] / 2 - box[0] - box[2] / 2, pb[1] + pb[3] / 2 - box[1] - box[3] / 2) < pb[2];
        const sc = ov + (near ? 0.2 : 0);
        if ((ov >= 0.3 || near) && sc > bs) { bs = sc; best = o; }
      }
      const s: MouthSample = { t: f.t, box, jaw: m[4], gap: m[5] };
      if (best) { best.s.push(s); best.last = f.t; used.add(best.id); } else open.push({ id: next++, last: f.t, s: [s] });
    }
  }
  done.push(...open);
  return done.filter((o) => o.s.length >= 3).sort((a, b) => a.s[0]!.t - b.s[0]!.t).map((o, i) => ({
    id: `face${i + 1}`, samples: o.s,
    x: r3(o.s.reduce((a, s) => a + s.box[0] + s.box[2] / 2, 0) / o.s.length),
    area: r3(o.s.reduce((a, s) => a + s.box[2] * s.box[3], 0) / o.s.length),
  }));
}

/** Audio RMS (dB) every `hop` seconds from a 16 kHz mono decode. */
export function audioEnvelope(ffmpeg: string, file: string, hop = 0.1, maxSeconds = 1800): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-t', String(maxSeconds), '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const per = Math.round(16000 * hop), out: number[] = [];
    let acc = 0, n = 0, carry: Buffer = Buffer.alloc(0);
    p.stdout.on('data', (b: Buffer) => {
      carry = carry.length ? Buffer.concat([carry, b]) : b;
      const len = carry.length - (carry.length % 2);
      for (let i = 0; i < len; i += 2) { const v = carry.readInt16LE(i) / 32768; acc += v * v; if (++n === per) { out.push(10 * Math.log10(Math.max(1e-10, acc / n))); acc = 0; n = 0; } }
      carry = carry.subarray(len);
    });
    p.on('error', reject);
    p.on('close', () => resolve(out));
  });
}

/** Speech presence per envelope step: transcript words when available, else level above an adaptive floor. */
export function speechMask(env: number[], hop: number, words?: { s: number; e: number }[]): boolean[] {
  if (words?.length) return env.map((_, i) => words.some((w) => i * hop + hop / 2 >= w.s - 0.1 && i * hop + hop / 2 <= w.e + 0.1));
  const sorted = [...env].sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.15)] ?? -60;
  return env.map((v) => v > Math.max(floor + 10, -50));
}

const corr = (a: number[], b: number[]) => {
  const n = Math.min(a.length, b.length); if (n < 4) return 0;
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n, mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { const x = a[i]! - ma, y = b[i]! - mb; ab += x * y; aa += x * x; bb += y * y; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
};

export interface SpeakerOptions { hop?: number; window?: number; minDwell?: number; switchAfter?: number; threshold?: number }

/** Decide the active speaker every `hop` seconds over [t0, t1). */
export function activeSpeakers(tracks: FaceTrack[], env: number[], speech: boolean[], envHop: number, t0: number, t1: number, o: SpeakerOptions = {}): { windows: SpeakerWindow[]; segments: SpeakerSegment[] } {
  const hop = o.hop ?? 0.25, win = o.window ?? 0.4, minDwell = o.minDwell ?? 1.2, switchAfter = o.switchAfter ?? 0.5, thr = o.threshold ?? 0.012;
  const windows: SpeakerWindow[] = [];
  let cur: string | undefined, curSince = t0, challenger: string | undefined, challengeSince = 0;
  for (let t = t0; t < t1; t += hop) {
    const ei = Math.min(env.length - 1, Math.max(0, Math.round(t / envHop)));
    const isSpeech = !!speech[ei];
    const visible = tracks.filter((tr) => tr.samples[0]!.t <= t + win && tr.samples.at(-1)!.t >= t - win);
    const scores: Record<string, number> = {};
    for (const tr of visible) {
      const s = tr.samples.filter((x) => Math.abs(x.t - t) <= win);
      if (s.length < 3) continue;
      const open = s.map((x) => x.jaw + 2 * x.gap);
      const mean = open.reduce((a, b) => a + b, 0) / open.length;
      const sd = Math.sqrt(open.reduce((a, b) => a + (b - mean) ** 2, 0) / open.length);
      const motion = open.slice(1).reduce((a, b, i) => a + Math.abs(b - open[i]!), 0) / Math.max(1, open.length - 1);
      const audio = s.map((x) => env[Math.min(env.length - 1, Math.round(x.t / envHop))] ?? -60);
      const c = corr(open, audio);
      scores[tr.id] = r3(sd + motion + 0.02 * Math.max(0, c));
    }
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const lead = isSpeech && ranked[0] && ranked[0][1] >= thr ? ranked[0][0] : undefined;
    // Hysteresis: keep the current speaker unless another one leads for `switchAfter` after `minDwell`.
    if (!cur || !scores[cur] && !visible.some((v) => v.id === cur)) { cur = lead; curSince = t; challenger = undefined; }
    else if (lead && lead !== cur) {
      if (challenger !== lead) { challenger = lead; challengeSince = t; }
      if (t - challengeSince >= switchAfter && t - curSince >= minDwell) { cur = lead; curSince = t; challenger = undefined; }
    } else challenger = undefined;
    windows.push({ t: r3(t), speech: isSpeech, ...(isSpeech && cur && { speaker: cur }), scores, faces: visible.length });
  }
  const segments: SpeakerSegment[] = [];
  for (const w of windows) {
    const last = segments.at(-1);
    if (last && last.track === w.speaker) { last.t1 = r3(w.t + hop); last.confidence = Math.max(last.confidence, w.speaker ? w.scores[w.speaker] ?? 0 : 0); }
    else segments.push({ t0: w.t, t1: r3(w.t + hop), ...(w.speaker && { track: w.speaker }), confidence: w.speaker ? w.scores[w.speaker] ?? 0 : 0 });
  }
  return { windows, segments: segments.filter((s) => s.track) };
}

/**
 * Speaker-aware crop centres (window-centre convention, source time). Faces that fit together in the
 * crop are framed together (two-shot preserved); otherwise the active speaker is framed and a change of
 * speaker moves the crop with an eased 0.5 s move (or a cut at a shot boundary). Rapid alternation
 * between faces that cannot share a crop is reported as a split-screen recommendation.
 */
export function speakerFraming(tracks: FaceTrack[], windows: SpeakerWindow[], crop: { w: number; h: number }, shots: { t0: number }[] = [], hop = 0.25): { keys: { t: number; cx: number; cy: number }[]; travelPerMin: number; recommendations: Recommendation[] } {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const at = (tr: FaceTrack, t: number) => tr.samples.reduce((b, s) => (Math.abs(s.t - t) < Math.abs(b.t - t) ? s : b));
  const keys: { t: number; cx: number; cy: number }[] = [];
  let prev: { cx: number; cy: number } | undefined, lastSpeaker: string | undefined, travel = 0;
  const switches: { t: number; split: boolean }[] = [];
  for (const w of windows) {
    const vis = tracks.filter((tr) => tr.samples[0]!.t <= w.t + 0.4 && tr.samples.at(-1)!.t >= w.t - 0.4).map((tr) => ({ tr, s: at(tr, w.t) }));
    if (!vis.length) continue;
    const left = Math.min(...vis.map((v) => v.s.box[0])), right = Math.max(...vis.map((v) => v.s.box[0] + v.s.box[2]));
    const together = right - left <= crop.w * 0.85;
    const focus = w.speaker && byId.has(w.speaker) ? vis.find((v) => v.tr.id === w.speaker) : lastSpeaker ? vis.find((v) => v.tr.id === lastSpeaker) : undefined;
    let cx: number, cy: number;
    if (together || !focus) { cx = (left + right) / 2; cy = vis.reduce((a, v) => a + v.s.box[1] + v.s.box[3] * 0.6, 0) / vis.length; }
    else { cx = focus.s.box[0] + focus.s.box[2] / 2; cy = focus.s.box[1] + focus.s.box[3] * 0.6; }
    if (w.speaker && w.speaker !== lastSpeaker && lastSpeaker) switches.push({ t: w.t, split: !together });
    if (w.speaker) lastSpeaker = w.speaker;
    const shotStart = shots.some((s) => s.t0 > w.t - hop && s.t0 <= w.t);
    // Dead zone (no move for < 15 % of the crop width); speaker changes ease over 0.5 s; cuts jump.
    if (prev && !shotStart && Math.abs(cx - prev.cx) < crop.w * 0.15 && Math.abs(cy - prev.cy) < crop.h * 0.15) continue;
    if (prev && !shotStart) { keys.push({ t: r3(w.t), cx: r3(prev.cx), cy: r3(prev.cy) }); keys.push({ t: r3(w.t + 0.5), cx: r3(cx), cy: r3(cy) }); travel += Math.abs(cx - prev.cx); }
    else keys.push({ t: r3(w.t), cx: r3(cx), cy: r3(cy) });
    prev = { cx, cy };
  }
  const recommendations: Recommendation[] = [];
  for (let i = 0; i + 2 < switches.length; i++) {
    const a = switches[i]!, c = switches[i + 2]!;
    if (c.t - a.t <= 6 && a.split && switches[i + 1]!.split && c.split) { recommendations.push({ at: [a.t, c.t], kind: 'split-screen', reason: '3 speaker changes within 6 s between faces that cannot share one crop' }); i += 2; }
  }
  const dur = windows.length ? windows.at(-1)!.t - windows[0]!.t + hop : 1;
  // Keys must increase strictly (renderer contract): drop a key that lands on or before its predecessor.
  const clean = keys.filter((k, i) => i === 0 || k.t > keys[i - 1]!.t);
  return { keys: clean, travelPerMin: r3((travel / Math.max(1e-6, dur)) * 60), recommendations };
}
