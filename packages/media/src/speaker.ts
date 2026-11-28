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
/** `t0`/`t1`: when the track counts as on screen (samples ± 0.15 s, never across a cut). */
export interface FaceTrack { id: string; samples: MouthSample[]; x: number; area: number; t0: number; t1: number }
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
    for (const o of [...open]) if (f.t - o.last > Math.max(3 / fps, 1.0) || cuts.some((c) => c > o.last && c <= f.t)) { done.push(o); open.splice(open.indexOf(o), 1); }
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
    t0: r3(cuts.find((c) => c <= o.s[0]!.t && c > o.s[0]!.t - 0.15) ?? o.s[0]!.t - 0.15),
    t1: r3(cuts.find((c) => c > o.s.at(-1)!.t && c < o.s.at(-1)!.t + 0.15) ?? o.s.at(-1)!.t + 0.15),
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
  let m: boolean[];
  if (words?.length) {
    m = new Array(env.length).fill(false);
    for (const w of words) for (let i = Math.max(0, Math.floor((w.s - 0.2) / hop)); i <= Math.min(env.length - 1, Math.ceil((w.e + 0.2) / hop)); i++) m[i] = true;
  } else {
    const sorted = [...env].sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.15)] ?? -60;
    m = env.map((v) => v > Math.max(floor + 10, -50));
  }
  // Pauses shorter than 0.6 s inside a sentence still belong to the speaker's turn.
  const gap = Math.round(0.6 / hop);
  for (let i = 0; i < m.length; i++) if (!m[i] && i > 0 && m[i - 1]) { let j = i; while (j < m.length && !m[j]) j++; if (j < m.length && j - i <= gap) for (let k = i; k < j; k++) m[k] = true; i = j; }
  return m;
}

export interface SpeakerOptions { hop?: number; window?: number; minDwell?: number; switchAfter?: number; threshold?: number; release?: number }

/** Decide the active speaker every `hop` seconds over [t0, t1). */
export function activeSpeakers(tracks: FaceTrack[], env: number[], speech: boolean[], envHop: number, t0: number, t1: number, o: SpeakerOptions = {}): { windows: SpeakerWindow[]; segments: SpeakerSegment[] } {
  const hop = o.hop ?? 0.25, win = o.window ?? 1.0, minDwell = o.minDwell ?? 1.2, switchAfter = o.switchAfter ?? 0.5, thr = o.threshold ?? 0.055, release = o.release ?? 0.75;
  const windows: SpeakerWindow[] = [];
  let cur: string | undefined, curSince = t0, challenger: string | undefined, challengeSince = 0, quietSince: number | undefined;
  for (let t = t0; t < t1; t += hop) {
    const ei = Math.min(env.length - 1, Math.max(0, Math.round(t / envHop)));
    const isSpeech = !!speech[ei];
    const visible = tracks.filter((tr) => tr.t0 <= t && t < tr.t1);
    const scores: Record<string, number> = {};
    for (const tr of visible) {
      const s = tr.samples.filter((x) => Math.abs(x.t - t) <= win);
      if (s.length < 3) continue;
      const open = s.map((x) => x.jaw + 2 * x.gap);
      const mean = open.reduce((a, b) => a + b, 0) / open.length;
      const sd = Math.sqrt(open.reduce((a, b) => a + (b - mean) ** 2, 0) / open.length);
      // Mouth-opening variability over ±1 s (AUC 0.83 on the dev windows; frame-rate mouth/audio
      // correlation was uninformative at 10 fps, AUC ≈ 0.5, and is not used).
      scores[tr.id] = r3(sd);
    }
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    // A face leads when it clears the threshold, or (several faces) when it clearly out-moves the others.
    const top = ranked[0], second = ranked[1]?.[1] ?? 0;
    const lead = isSpeech && top && (top[1] >= thr || (ranked.length > 1 && top[1] >= thr * 0.6 && top[1] >= 1.5 * second)) ? top[0] : undefined;
    // Hysteresis: keep the current speaker unless another one leads for `switchAfter` after `minDwell`;
    // release it (off-screen speaker) when its mouth stays still through `release` seconds of speech.
    const curScore = cur ? scores[cur] ?? 0 : 0;
    if (!cur || !visible.some((v) => v.id === cur)) { cur = lead; curSince = t; challenger = undefined; quietSince = undefined; }
    else if (lead && lead !== cur) {
      if (challenger !== lead) { challenger = lead; challengeSince = t; }
      if (t - challengeSince >= switchAfter && t - curSince >= minDwell) { cur = lead; curSince = t; challenger = undefined; quietSince = undefined; }
    } else {
      challenger = undefined;
      if (isSpeech && curScore < thr) { quietSince ??= t; if (t - quietSince >= release) { cur = undefined; quietSince = undefined; } }
      else quietSince = undefined;
    }
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
  let prev: { cx: number; cy: number } | undefined, prevFocus: string | undefined, lastSpeaker: string | undefined, travel = 0;
  const switches: { t: number; split: boolean }[] = [];
  const push = (t: number, cx: number, cy: number) => keys.push({ t: r3(t), cx: r3(cx), cy: r3(cy) });
  for (const w of windows) {
    const vis = tracks.filter((tr) => tr.t0 <= w.t && w.t < tr.t1).map((tr) => ({ tr, s: at(tr, w.t) }));
    if (!vis.length) continue;
    const left = Math.min(...vis.map((v) => v.s.box[0])), right = Math.max(...vis.map((v) => v.s.box[0] + v.s.box[2]));
    const together = right - left <= crop.w * 0.85;
    const focus = w.speaker && byId.has(w.speaker) ? vis.find((v) => v.tr.id === w.speaker) : lastSpeaker ? vis.find((v) => v.tr.id === lastSpeaker) : undefined;
    let cx: number, cy: number;
    if (together || !focus) { cx = (left + right) / 2; cy = vis.reduce((a, v) => a + v.s.box[1] + v.s.box[3] * 0.6, 0) / vis.length; }
    else { cx = focus.s.box[0] + focus.s.box[2] / 2; cy = focus.s.box[1] + focus.s.box[3] * 0.6; }
    cx = Math.min(1 - crop.w / 2, Math.max(crop.w / 2, cx)); cy = Math.min(1 - crop.h / 2, Math.max(crop.h / 2, cy));
    if (w.speaker && w.speaker !== lastSpeaker && lastSpeaker) switches.push({ t: w.t, split: !together });
    if (w.speaker) lastSpeaker = w.speaker;
    const focusId = together || !focus ? 'group' : focus.tr.id;
    const cut = shots.find((sh) => sh.t0 > w.t - hop && sh.t0 <= w.t);
    if (!prev || cut) {
      // A new shot starts on its own subject: a hard step at the cut, never a pan across it.
      if (prev && cut) push(cut.t0 - 0.04, prev.cx, prev.cy);
      push(cut?.t0 ?? w.t, cx, cy); prev = { cx, cy }; prevFocus = focusId; continue;
    }
    if (focusId !== prevFocus) {
      // Speaker change: ease to the new speaker over 0.5 s unless they already sit near the crop centre.
      prevFocus = focusId;
      if (Math.abs(cx - prev.cx) > crop.w * 0.1 || Math.abs(cy - prev.cy) > crop.h * 0.1) { push(w.t, prev.cx, prev.cy); push(w.t + 0.5, cx, cy); travel += Math.abs(cx - prev.cx); prev = { cx, cy }; }
      continue;
    }
    // Same subject: a dead zone of ±30 % of the crop; beyond it the crop moves only by the excess.
    const ex = (d: number, lim: number) => (Math.abs(d) > lim ? d - Math.sign(d) * lim : 0);
    const dx = ex(cx - prev.cx, crop.w * 0.3), dy = ex(cy - prev.cy, crop.h * 0.3);
    if (!dx && !dy) continue;
    push(w.t, prev.cx + dx, prev.cy + dy); travel += Math.abs(dx); prev = { cx: prev.cx + dx, cy: prev.cy + dy };
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
