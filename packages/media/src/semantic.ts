/**
 * FRAME semantic footage intelligence (Phase 5) — an adapter layer of `frame.footage/1`, not a second
 * pipeline. The MediaPipe worker (py/semantic.py) observes objects, faces, poses, hands and embeddings
 * on sampled frames; everything below is deterministic TypeScript over those observations and the
 * Phase 4 signals (shots, motion, audio, OCR).
 *
 * Observed: detections linked into tracks (IoU association), gestures, text over time.
 * Inferred (each with confidence + evidence): subjects (presenter / primary / moving), subject-aware
 * reframe keys, activity labels from pose, shot scene types, duplicate/similar shots and replay
 * candidates, speech-to-visual alignment and event candidates. No identity is ever inferred.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TmepError } from '../../core/src/index.ts';
import type { Box, FootageAnalysis, Shot } from './footage.ts';
import { modelDir, modelStatus, semanticRuntime } from './models.ts';
import { classifyFrames, sceneModel, type SceneClass } from './scenes.ts';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'py', 'semantic.py');
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ---------- worker observations ----------

export type Kp = Record<'nose' | 'ls' | 'rs' | 'le' | 're' | 'lw' | 'rw' | 'lh' | 'rh' | 'lk' | 'rk' | 'la' | 'ra', [number, number, number]>;
export interface SemFrame {
  t: number;
  objects?: [string, number, number, number, number, number][];
  faces?: [number, number, number, number, number][];
  poses?: { box: [number, number, number, number]; kp: Kp }[];
  hands?: [string, number, string, number, number, number, number][];
  emb?: number[];
  /** Phase 6 scene features: MobileNetV3-large embedding and top ImageNet classes [index, p]. */
  embL?: number[];
  cls?: [number, number][];
  ms?: number;
}

export interface Track {
  id: string; label: string; t0: number; t1: number; n: number; score: number;
  /** Share of samples within [t0, t1] where the track was seen. */
  coverage: number;
  /** Median centre speed in frame widths per second. */
  speed: number;
  /** Median box area (share of frame). */
  area: number;
  /** Samples where a face was inside the box (persons only). */
  faceSamples?: number;
  /** [t, x, y, w, h] top-left boxes, at most ~2 per second and 80 per track. */
  boxes: [number, number, number, number, number][];
}

export interface SemanticRecord {
  observed: {
    tracks: Track[];
    gestures: { t: number; label: string; score: number; hand: string; box: Box }[];
    textTracks?: { text: string; t0: number; t1: number; n: number }[];
    frames: number; fps: number;
  };
  inferred: {
    subjects: { presenter?: string; primary?: string; moving: string[]; basis: string[] };
    reframe: { aspect: string; subject?: string; /** Crop window centres (source fractions). */ keys: { t: number; cx: number; cy: number }[]; subjectInside: number; basis: string; crop?: { w: number; h: number } }[];
    activities: { track: string; t0: number; t1: number; label: 'gesturing' | 'moving across frame' | 'stationary'; confidence: number; evidence: string[] }[];
    sceneTypes: { shot: string; label: SceneType; confidence: number; evidence: string[] }[];
    duplicates: { a: string; b: string; similarity: number; kind: 'near-duplicate' | 'similar' | 'replay-candidate'; basis: string }[];
    textChanges: { t: number; before: string; after: string; kind: 'number-change' | 'text-change'; confidence: number }[];
    alignment: { word: string; t: number; target: 'text' | 'object'; ref: string; dt: number }[];
    events: EventCandidate[];
  };
}
/** Phase 6 taxonomy (docs/phase-6/PROGRESS.md); `other` when neither the classifier nor a rule applies. */
export type SceneType = SceneClass | 'other';
export interface EventCandidate { id: string; t: number; t0: number; t1: number; score: number; confidence: number; signals: Record<string, number>; evidence: string[]; note: string }

/** Run the worker. Rejects with E_CANCELLED on abort; worker failure surfaces its stderr tail. */
export async function runWorker(python: string, env: NodeJS.ProcessEnv, ffmpeg: string, file: string, o: { fps: number; w: number; h: number; maxSeconds: number; tasks: string[]; signal?: AbortSignal; start?: number }): Promise<{ frames: SemFrame[]; loadMs: number; maxRssMB?: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(python, [WORKER, modelDir(), ffmpeg, file, String(o.fps), String(o.w), String(o.h), String(o.maxSeconds), o.tasks.join(','), String(o.start ?? 0)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const frames: SemFrame[] = [];
    let loadMs = 0, buf = '', err = '', done = false, maxRssMB: number | undefined;
    const abort = () => p.kill('SIGKILL');
    o.signal?.addEventListener('abort', abort, { once: true });
    p.stdout.on('data', (d) => {
      buf += String(d);
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        if (j.ready) loadMs = j.loadMs; else if (j.done) { done = true; maxRssMB = j.maxRssMB; } else frames.push(j);
      }
    });
    p.stderr.on('data', (d) => { err = (err + String(d)).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => {
      o.signal?.removeEventListener('abort', abort);
      if (o.signal?.aborted) return reject(new TmepError('E_CANCELLED', 'analysis cancelled'));
      // MediaPipe can print harmless destructor errors at interpreter exit; the "done" line is authoritative.
      if (!done) return reject(new TmepError('E_ANALYSIS_FAILED', `semantic worker failed (exit ${code})`, undefined, { tail: err.split('\n').filter((l) => !/__del__|TypeError: 'NoneType'/.test(l)).slice(-6).join('\n') }));
      resolve({ frames, loadMs, maxRssMB });
    });
  });
}

// ---------- tracking ----------

const iou = (a: number[], b: number[]) => {
  const x0 = Math.max(a[0]!, b[0]!), y0 = Math.max(a[1]!, b[1]!), x1 = Math.min(a[0]! + a[2]!, b[0]! + b[2]!), y1 = Math.min(a[1]! + a[3]!, b[1]! + b[3]!);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / Math.max(1e-9, a[2]! * a[3]! + b[2]! * b[3]! - i);
};
const centre = (b: number[]) => [b[0]! + b[2]! / 2, b[1]! + b[3]! / 2] as const;
const inside = (inner: number[], outer: number[]) => { const [cx, cy] = centre(inner); return cx >= outer[0]! && cx <= outer[0]! + outer[2]! && cy >= outer[1]! && cy <= outer[1]! + outer[3]!; };

/**
 * Greedy IoU association per label with a one-sample gap tolerance; a fast mover is still matched when
 * its centre moved less than its own size. Shot boundaries end every track.
 */
/** A pose that faces the camera: nose and both shoulders visible, shoulders reasonably wide. */
const facing = (f: SemFrame, box: number[]) => (f.poses ?? []).some((p) => iou(p.box, box) > 0.3 && p.kp.nose[2] > 0.5 && p.kp.ls[2] > 0.5 && p.kp.rs[2] > 0.5 && Math.abs(p.kp.ls[0] - p.kp.rs[0]) > 0.06 && p.kp.nose[0] > Math.min(p.kp.ls[0], p.kp.rs[0]) && p.kp.nose[0] < Math.max(p.kp.ls[0], p.kp.rs[0]));

/** Camera velocity (frame widths/s) at time t from the base pass, zero when unknown. */
const camAt = (camera: { dx: number; dy: number }[] | undefined, t: number) => camera?.[Math.min(camera.length - 1, Math.max(0, Math.floor(t / 0.5)))] ?? { dx: 0, dy: 0 };

export function trackObjects(frames: SemFrame[], fps: number, cuts: number[] = [], camera?: { dx: number; dy: number }[]): Track[] {
  interface Open { id: number; label: string; last: number; samples: { t: number; box: number[]; score: number; face: boolean }[] }
  const open: Open[] = [], closed: Open[] = [];
  let next = 1;
  const gap = 2.5 / fps;
  for (const f of frames) {
    for (const o of [...open]) {
      if (f.t - o.last > gap || cuts.some((c) => c > o.last && c <= f.t)) { closed.push(o); open.splice(open.indexOf(o), 1); }
    }
    const dets = (f.objects ?? []).map(([label, score, x, y, w, h]) => ({ label, score, box: [x, y, w, h] }));
    const pairs: { o: Open; d: number; s: number }[] = [];
    dets.forEach((d, k) => {
      for (const o of open) {
        if (o.label !== d.label) continue;
        const prev = o.samples.at(-1)!.box;
        const ov = iou(prev, d.box);
        const [ax, ay] = centre(prev), [bx, by] = centre(d.box);
        const near = Math.hypot(ax - bx, ay - by) < Math.max(prev[2]!, prev[3]!) * 0.8;
        if (ov >= 0.25 || near) pairs.push({ o, d: k, s: ov + (near ? 0.1 : 0) });
      }
    });
    pairs.sort((a, b) => b.s - a.s);
    const usedO = new Set<Open>(), usedD = new Set<number>();
    for (const p of pairs) {
      if (usedO.has(p.o) || usedD.has(p.d)) continue;
      usedO.add(p.o); usedD.add(p.d);
      const d = dets[p.d]!;
      p.o.samples.push({ t: f.t, box: d.box, score: d.score, face: (f.faces ?? []).some((fc) => inside(fc.slice(1), d.box)) || (d.label === 'person' && facing(f, d.box)) });
      p.o.last = f.t;
    }
    dets.forEach((d, k) => {
      if (usedD.has(k)) return;
      open.push({ id: next++, label: d.label, last: f.t, samples: [{ t: f.t, box: d.box, score: d.score, face: (f.faces ?? []).some((fc) => inside(fc.slice(1), d.box)) || (d.label === 'person' && facing(f, d.box)) }] });
    });
  }
  closed.push(...open);
  const tracks: Track[] = [];
  for (const o of closed.sort((a, b) => a.samples[0]!.t - b.samples[0]!.t || a.id - b.id)) {
    const s = o.samples, sc = mean(s.map((x) => x.score));
    if (s.length < 2 && sc < 0.5) continue; // single weak detections are noise
    const t0 = s[0]!.t, t1 = s.at(-1)!.t;
    const speeds: number[] = [];
    // Speed relative to the scene: on-screen velocity minus the camera's (a panned-on subject is moving,
    // a handheld interviewee is not).
    for (let i = 1; i < s.length; i++) {
      const [ax, ay] = centre(s[i - 1]!.box), [bx, by] = centre(s[i]!.box), dt = Math.max(1e-6, s[i]!.t - s[i - 1]!.t);
      const cam = camAt(camera, (s[i]!.t + s[i - 1]!.t) / 2);
      speeds.push(Math.hypot((bx - ax) / dt - cam.dx, (by - ay) / dt - cam.dy));
    }
    const step = Math.max(1, Math.ceil(s.length / 80));
    tracks.push({
      id: `${o.label.replace(/\s+/g, '-')}${tracks.filter((t) => t.label === o.label).length + 1}`, label: o.label, t0: r3(t0), t1: r3(t1), n: s.length, score: r3(sc),
      coverage: r3(Math.min(1, s.length / (Math.round((t1 - t0) * fps) + 1))), speed: r3(median(speeds)), area: r3(median(s.map((x) => x.box[2]! * x.box[3]!))),
      ...(o.label === 'person' ? { faceSamples: s.filter((x) => x.face).length } : {}),
      boxes: s.filter((_, i) => i % step === 0 || i === s.length - 1).map((x) => [r3(x.t), ...x.box.map(r3)] as [number, number, number, number, number]),
    });
  }
  return tracks;
}

/** Box of a track at time t (nearest sample within `tol` seconds). */
export function boxAt(tr: Track, t: number, tol = 0.75): [number, number, number, number] | undefined {
  let best: Track['boxes'][number] | undefined, bd = Infinity;
  for (const b of tr.boxes) { const d = Math.abs(b[0] - t); if (d < bd) { bd = d; best = b; } }
  return best && bd <= tol ? [best[1], best[2], best[3], best[4]] : undefined;
}

// ---------- subjects, reframing, activity ----------

export function findSubjects(tracks: Track[], dur: number): SemanticRecord['inferred']['subjects'] {
  const persons = tracks.filter((t) => t.label === 'person');
  const basis: string[] = [];
  const span = (t: Track) => (t.t1 - t.t0) / Math.max(1e-6, dur);
  const presenter = persons
    .filter((t) => span(t) >= 0.4 && (t.faceSamples ?? 0) >= 0.3 * t.n && t.speed < 0.15)
    .sort((a, b) => b.n * b.area - a.n * a.area)[0];
  if (presenter) basis.push(`presenter ${presenter.id}: on screen ${Math.round(span(presenter) * 100)}% of the time, face in ${presenter.faceSamples}/${presenter.n} samples, speed ${presenter.speed} widths/s`);
  const primary = presenter ?? [...persons].sort((a, b) => b.n * b.area * b.score - a.n * a.area * a.score)[0];
  if (primary && !presenter) basis.push(`primary ${primary.id}: largest persistent person (${primary.n} samples, area ${primary.area})`);
  const moving = tracks.filter((t) => t.speed >= 0.25 && t.t1 - t.t0 >= 1).map((t) => t.id);
  if (moving.length) basis.push(`moving: tracks with median speed ≥ 0.25 frame widths/s for ≥ 1 s`);
  return { presenter: presenter?.id, primary: primary?.id, moving, basis };
}

/**
 * Crop centre keys that keep a subject in a narrower frame. A dead zone holds the crop still while the
 * subject stays inside its middle 60 %, and every shot starts from the subject's own position.
 */
/** Renderer crop offset (0..1, the `cx`/`cy`/`follow` convention) that puts a window of relative size `crop` centred on `centre`. */
export const centreToOffset = (centre: number, crop: number) => (crop >= 0.999 ? 0.5 : Math.round(Math.min(1, Math.max(0, (centre - crop / 2) / (1 - crop))) * 1000) / 1000);

export function reframeKeys(tr: Track | undefined, src: { w: number; h: number }, aspect: [number, number], shots: Pick<Shot, 't0'>[]): SemanticRecord['inferred']['reframe'][number] {
  const label = `${aspect[0]}:${aspect[1]}`;
  const cw = Math.min(1, (src.h * aspect[0]) / aspect[1] / src.w), ch = Math.min(1, (src.w * aspect[1]) / aspect[0] / src.h);
  if (!tr) return { aspect: label, keys: [], subjectInside: 0, basis: 'no subject track: centre crop' };
  const keys: { t: number; cx: number; cy: number }[] = [];
  let cx = 0.5, cy = 0.5, inside = 0, shotIdx = -1;
  for (const [t, x, y, w, h] of tr.boxes) {
    const si = shots.filter((s) => s.t0 <= t).length - 1;
    const sx = x + w / 2, sy = y + h * 0.4; // bias towards the head
    if (si !== shotIdx) { cx = sx; cy = sy; shotIdx = si; } else {
      if (Math.abs(sx - cx) > cw * 0.3) cx += (sx - cx) - Math.sign(sx - cx) * cw * 0.3;
      if (Math.abs(sy - cy) > ch * 0.3) cy += (sy - cy) - Math.sign(sy - cy) * ch * 0.3;
    }
    cx = Math.min(1 - cw / 2, Math.max(cw / 2, cx)); cy = Math.min(1 - ch / 2, Math.max(ch / 2, cy));
    // Kept = the crop holds as much of the subject as it can (a close-up wider than the crop counts when
    // its centre 90 % of the crop width is inside).
    const hw = Math.min(w, cw) * 0.45, hh = Math.min(h, ch) * 0.45, bx = x + w / 2, by = y + h / 2;
    if (bx - hw >= cx - cw / 2 - 0.01 && bx + hw <= cx + cw / 2 + 0.01 && by - hh >= cy - ch / 2 - 0.01 && by + hh <= cy + ch / 2 + 0.01) inside++;
    const last = keys.at(-1);
    if (!last || Math.abs(last.cx - cx) > 0.005 || Math.abs(last.cy - cy) > 0.005 || si !== shots.filter((s) => s.t0 <= last.t).length - 1) keys.push({ t: t, cx: r3(cx), cy: r3(cy) });
  }
  return { aspect: label, subject: tr.id, keys, crop: { w: r3(cw), h: r3(ch) }, subjectInside: r3(inside / Math.max(1, tr.boxes.length)), basis: `follows ${tr.id} with a dead zone of 60 % of the crop; crop ${r3(cw)}×${r3(ch)} of the frame; kept = the crop holds as much of the subject as it can` };
}

/** Activity from pose: wrist travel relative to shoulder width, and whole-body travel. */
export function poseActivities(frames: SemFrame[], tracks: Track[], camera?: { dx: number; dy: number }[]): SemanticRecord['inferred']['activities'] {
  const out: SemanticRecord['inferred']['activities'] = [];
  for (const tr of tracks.filter((t) => t.label === 'person' && t.n >= 3)) {
    const seq: { t: number; kp: Kp }[] = [];
    for (const [t, x, y, w, h] of tr.boxes) {
      const f = frames.find((fr) => Math.abs(fr.t - t) < 1e-3);
      const p = f?.poses?.map((q) => ({ q, o: iou(q.box, [x, y, w, h]) })).sort((a, b) => b.o - a.o)[0];
      if (p && p.o > 0.3) seq.push({ t, kp: p.q.kp });
    }
    if (seq.length < 3) continue;
    const wrist: number[] = [], body: number[] = [];
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1]!.kp, b = seq[i]!.kp, dt = Math.max(1e-6, seq[i]!.t - seq[i - 1]!.t);
      const sw = Math.max(0.02, Math.hypot(a.ls[0] - a.rs[0], a.ls[1] - a.rs[1]));
      const vis = (k: keyof Kp) => a[k][2] > 0.5 && b[k][2] > 0.5;
      const rel = (k: 'lw' | 'rw', s: 'ls' | 'rs') => (vis(k) && vis(s) ? Math.hypot((b[k][0] - b[s][0]) - (a[k][0] - a[s][0]), (b[k][1] - b[s][1]) - (a[k][1] - a[s][1])) / sw / dt : 0);
      wrist.push(Math.max(rel('lw', 'ls'), rel('rw', 'rs')));
      // Body position: hip centre when both hips are visible in both frames, else shoulder centre (close-ups).
      const hipsSeen = vis('lh') && vis('rh');
      const hip = (k: Kp) => (hipsSeen ? [(k.lh[0] + k.rh[0]) / 2, (k.lh[1] + k.rh[1]) / 2] : [(k.ls[0] + k.rs[0]) / 2, (k.ls[1] + k.rs[1]) / 2]);
      const [ha, hb] = [hip(a), hip(b)];
      const cam = camAt(camera, (seq[i]!.t + seq[i - 1]!.t) / 2);
      body.push(Math.hypot((hb[0]! - ha[0]!) / dt - cam.dx, (hb[1]! - ha[1]!) / dt - cam.dy));
    }
    const w = median(wrist), b = median(body);
    const label = b >= 0.15 ? 'moving across frame' : w >= 0.8 ? 'gesturing' : 'stationary';
    const confidence = label === 'moving across frame' ? Math.min(1, b / 0.3) : label === 'gesturing' ? Math.min(1, w / 1.6) : Math.min(1, 1 - Math.max(w / 0.8, b / 0.15) * 0.5);
    out.push({ track: tr.id, t0: tr.t0, t1: tr.t1, label, confidence: r3(Math.max(0.1, confidence)), evidence: [`${seq.length} pose samples`, `median wrist travel ${r3(w)} shoulder-widths/s`, `median hip travel ${r3(b)} frame widths/s${camera ? ' (camera motion removed)' : ''}`] });
  }
  return out;
}

// ---------- scene types ----------

export function sceneTypes(a: FootageAnalysis, frames: SemFrame[]): SemanticRecord['inferred']['sceneTypes'] {
  const medMotion = median(a.observed.shots.map((s) => s.motion)) || 1;
  return a.observed.shots.map((s) => {
    const fr = frames.filter((f) => f.t >= s.t0 && f.t < s.t1);
    if (!fr.length) return { shot: s.id, label: 'other' as SceneType, confidence: 0, evidence: ['no semantic samples in this shot'] };
    // Phase 6: the trained classifier when its features were computed; the Phase 5 rules otherwise.
    const c = classifyFrames(fr);
    if (c) return { shot: s.id, label: c.label, confidence: c.confidence, evidence: [`scene classifier over ${c.frames} frames (runner-up: ${c.runnerUp})`] };
    const share = (p: (f: SemFrame) => boolean) => fr.filter(p).length / fr.length;
    const persons = (f: SemFrame) => (f.objects ?? []).filter((o) => o[0] === 'person');
    const bigFaces = (f: SemFrame, min: number) => (f.faces ?? []).filter((x) => x[3] * x[4] >= min).length;
    const text = (a.observed.text ?? []).filter((x) => x.t >= s.t0 && x.t < s.t1);
    const words = text.reduce((n, x) => n + x.text.split(/\s+/).length, 0) / Math.max(1, text.length);
    const big = (f: SemFrame) => persons(f).filter((p) => p[4] * p[5] >= 0.04).length;
    // Rules are checked in order of specificity: people and faces first, motion last, so a handheld
    // talking head is not called action.
    const ordered: [SceneType, number, string][] = [
      ['group', s.motion < 6 ? share((f) => bigFaces(f, 0.006) >= 2 || (big(f) >= 2 && big(f) <= 4)) : 0, 'two to four large people or two prominent faces, low motion'],
      ['talking-head', share((f) => bigFaces(f, 0.012) === 1 && persons(f).length <= 2), 'one prominent face, at most two people'],
      ['sports', share((f) => persons(f).length >= 4 && median(persons(f).map((p) => p[4] * p[5])) < 0.05), 'four or more small people'],
      ['close-up', share((f) => (f.objects ?? []).some((o) => o[0] !== 'person' && o[4] * o[5] >= 0.12) && !(f.faces ?? []).length), 'a large non-person object, no face'],
      ['screen', text.length && words >= 4 ? share((f) => !persons(f).length) * Math.min(1, words / 8) : 0, `${Math.round(words)} OCR words per sample, no people`],
      ['sports', s.motion >= 6 || (s.motion >= 2 * medMotion && s.motion >= 3) ? share((f) => persons(f).length >= 1) : 0, `motion ${s.motion} (clip median ${r3(medMotion)}) with people`],
      ['scenery', share((f) => !(f.objects ?? []).length && !(f.faces ?? []).length), 'no detections'],
    ];
    const first = ordered.find((c) => c[1] >= 0.5);
    const [label, conf, why] = first ?? [...ordered].sort((x, y) => y[1] - x[1])[0]!;
    return conf >= 0.5 ? { shot: s.id, label, confidence: r3(conf), evidence: [why, `${fr.length} samples`] } : { shot: s.id, label: 'other' as SceneType, confidence: r3(1 - conf), evidence: [`no rule held in ≥ 50 % of ${fr.length} samples (best: ${label} ${r3(conf)})`] };
  });
}

// ---------- duplicates / similar shots ----------

const cosine = (a: number[], b: number[]) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / Math.sqrt(Math.max(1e-12, na * nb)); };

export function similarShots(shots: Shot[], frames: SemFrame[], momentsT: number[] = []): SemanticRecord['inferred']['duplicates'] {
  const vec = shots.map((s) => {
    const es = frames.filter((f) => f.emb && f.t >= s.t0 && f.t < s.t1).map((f) => f.emb!);
    if (!es.length) return undefined;
    const m = new Array(es[0]!.length).fill(0);
    for (const e of es) e.forEach((v, i) => (m[i] += v / es.length));
    return m as number[];
  });
  const out: SemanticRecord['inferred']['duplicates'] = [];
  for (let i = 0; i < shots.length; i++) for (let j = i + 2; j < shots.length; j++) {
    // adjacent shots are excluded: a cut inside one setup is not a duplicate
    const a = vec[i], b = vec[j];
    const sim = a && b ? cosine(a, b) : undefined;
    const basis = sim !== undefined ? 'mean MobileNetV3 embedding cosine' : 'histogram signature (no embeddings)';
    const s = sim ?? 1 - shots[i]!.signature.reduce((acc, v, k) => acc + Math.abs(v - shots[j]!.signature[k]!), 0) / 2;
    const near = sim !== undefined ? 0.93 : 0.97, similar = sim !== undefined ? 0.85 : 0.92;
    if (s < similar) continue;
    const short = shots[j]!.t1 - shots[j]!.t0 <= 8, afterMoment = momentsT.some((t) => t >= shots[i]!.t0 && t <= shots[i]!.t1);
    const kind = short && afterMoment && s >= similar ? 'replay-candidate' : s >= near ? 'near-duplicate' : 'similar';
    out.push({ a: shots[i]!.id, b: shots[j]!.id, similarity: r3(s), kind, basis });
  }
  return out;
}

// ---------- text over time ----------

/** Link OCR samples into text tracks and report changes where the layout stayed but a number changed. */
export function textOverTime(samples: { t: number; text: string; conf: number }[], step: number): { tracks: NonNullable<SemanticRecord['observed']['textTracks']>; changes: SemanticRecord['inferred']['textChanges'] } {
  const tok = (s: string) => s.split(/\s+/).filter(Boolean);
  const tracks: { text: string; t0: number; t1: number; n: number }[] = [];
  const open = new Map<string, { text: string; t0: number; t1: number; n: number }>();
  for (const s of samples) {
    for (const w of new Set(tok(s.text).filter((w) => w.length >= 2 || /\d/.test(w)))) {
      const o = open.get(w);
      if (o && s.t - o.t1 <= step * 1.5 + 1e-6) { o.t1 = s.t; o.n++; } else { if (o) tracks.push(o); open.set(w, { text: w, t0: s.t, t1: s.t, n: 1 }); }
    }
  }
  tracks.push(...open.values());
  const changes: SemanticRecord['inferred']['textChanges'] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = tok(samples[i - 1]!.text), b = tok(samples[i]!.text);
    if (samples[i]!.t - samples[i - 1]!.t > step * 1.5 + 1e-6) continue;
    const keepA = a.filter((w) => !/\d/.test(w)), keepB = b.filter((w) => !/\d/.test(w));
    const shared = keepA.filter((w) => keepB.includes(w)).length / Math.max(1, Math.max(keepA.length, keepB.length));
    const na = a.filter((w) => /\d/.test(w)).join(' '), nb = b.filter((w) => /\d/.test(w)).join(' ');
    if (na && nb && na !== nb && shared >= 0.6 && a.filter((w) => /\d/.test(w)).length === b.filter((w) => /\d/.test(w)).length) {
      changes.push({ t: samples[i]!.t, before: na, after: nb, kind: 'number-change', confidence: r3(Math.min(samples[i - 1]!.conf, samples[i]!.conf) * shared) });
    }
  }
  return { tracks: tracks.filter((t) => t.n >= 2).sort((x, y) => x.t0 - y.t0).slice(0, 200), changes };
}

// ---------- speech ↔ visual ----------

export function alignSpeech(words: { w: string; s: number; e: number }[], tracks: Track[], textTracks: { text: string; t0: number; t1: number }[], window = 3): SemanticRecord['inferred']['alignment'] {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const out: SemanticRecord['inferred']['alignment'] = [];
  for (const w of words) {
    const k = norm(w.w);
    if (k.length < 3) continue;
    for (const tt of textTracks) {
      if (norm(tt.text) !== k) continue;
      const dt = w.s < tt.t0 ? tt.t0 - w.s : w.s > tt.t1 ? w.s - tt.t1 : 0;
      if (dt <= window) out.push({ word: w.w, t: r3(w.s), target: 'text', ref: tt.text, dt: r3(dt) });
    }
    for (const tr of tracks) {
      if (norm(tr.label) !== k && norm(tr.label) + 's' !== k) continue;
      const dt = w.s < tr.t0 ? tr.t0 - w.s : w.s > tr.t1 ? w.s - tr.t1 : 0;
      if (dt <= window) out.push({ word: w.w, t: r3(w.s), target: 'object', ref: tr.id, dt: r3(dt) });
    }
  }
  return out.slice(0, 200);
}

// ---------- event candidates ----------

/**
 * Candidate moments for sports and other event-driven footage. These are NOT recognized events: a
 * candidate says that several independent signals peak together, and lists them.
 */
export function eventCandidates(a: FootageAnalysis, tracks: Track[], changes: SemanticRecord['inferred']['textChanges'], dups: SemanticRecord['inferred']['duplicates']): EventCandidate[] {
  const pts = new Map<number, { signals: Record<string, number>; evidence: string[] }>();
  const at = (t: number) => { const near = [...pts.keys()].find((k) => Math.abs(k - t) <= 1); const k = near ?? Math.round(t * 2) / 2; if (!pts.has(k)) pts.set(k, { signals: {}, evidence: [] }); return pts.get(k)!; };
  for (const m of a.inferred.moments) { const p = at(m.t); p.signals.moment = Math.max(p.signals.moment ?? 0, m.confidence); p.evidence.push(...m.evidence); }
  for (const c of changes) { const p = at(c.t); p.signals.scoreChange = c.confidence; p.evidence.push(`on-screen number changed ${c.before} → ${c.after}`); }
  const shotOf = (id: string) => a.observed.shots.find((s) => s.id === id)!;
  for (const d of dups.filter((x) => x.kind === 'replay-candidate')) { const s = shotOf(d.a); const p = at((s.t0 + s.t1) / 2); p.signals.replay = d.similarity; p.evidence.push(`shot ${d.b} resembles ${d.a} (${d.basis} ${d.similarity}): possible replay`); }
  for (const tr of tracks.filter((t) => t.speed >= 0.4 && t.t1 - t.t0 >= 0.5)) { const p = at((tr.t0 + tr.t1) / 2); p.signals.fastSubject = Math.min(1, tr.speed); p.evidence.push(`${tr.id} moving ${tr.speed} frame widths/s`); }
  const cuts = a.observed.shots.slice(1).map((s) => s.t0);
  const out: EventCandidate[] = [];
  for (const [t, p] of [...pts.entries()].sort((x, y) => x[0] - y[0])) {
    if (cuts.some((c) => c > t && c - t <= 2)) { p.signals.cutAfter = 1; p.evidence.push('a cut follows within 2 s'); }
    const n = Object.keys(p.signals).length;
    const score = Object.values(p.signals).reduce((x, y) => x + y, 0) / 4;
    if (n < 2 && !p.signals.scoreChange) continue;
    out.push({ id: '', t, t0: Math.max(0, t - 3), t1: t + 2, score: r3(Math.min(1, score)), confidence: r3(Math.min(0.8, 0.2 + 0.15 * n)), signals: p.signals, evidence: [...new Set(p.evidence)].slice(0, 6), note: 'candidate only: signals coincide; no event type is recognized' });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 20).sort((x, y) => x.t - y.t).map((e, i) => ({ ...e, id: `e${i + 1}` }));
}

// ---------- entry ----------

export interface SemanticOptions { fps?: number; gestures?: boolean; maxSeconds?: number; signal?: AbortSignal; words?: { w: string; s: number; e: number }[]; textStep?: number }

export function semanticFps(seconds: number): number { return seconds <= 600 ? 2 : seconds <= 1800 ? 1 : 0.5; }

/** Availability check without running anything heavy. */
export async function semanticAvailability(tasks: string[]): Promise<{ ok: boolean; python?: string; env: NodeJS.ProcessEnv; reason?: string }> {
  const st = await modelStatus(tasks);
  const missing = st.models.filter((m) => !m.verified);
  if (missing.length) return { ok: false, env: process.env, reason: `models not installed in ${st.dir}: ${missing.map((m) => m.file).join(', ')} (${(st.downloadBytes / 1e6).toFixed(1)} MB, Apache-2.0); run \`tmep models install --yes\`` };
  const rt = await semanticRuntime();
  return rt.python ? { ok: true, python: rt.python, env: rt.env } : { ok: false, env: rt.env, reason: rt.reason };
}

export async function analyzeSemantics(ffmpeg: string, a: FootageAnalysis, opts: SemanticOptions = {}): Promise<{ record?: SemanticRecord; reason?: string; ms: number; loadMs: number; perFrameMs: number; maxRssMB?: number }> {
  const base = ['objects', 'faces', 'pose', 'embed', ...(opts.gestures ? ['gestures'] : [])];
  const t0 = Date.now();
  const av = await semanticAvailability(base);
  // Scene features need two more models; without them scene types fall back to detection rules.
  const sceneOk = !!sceneModel() && (await modelStatus(['sceneEmbed', 'sceneClasses'])).models.every((m) => m.verified);
  const tasks = [...base, ...(sceneOk ? ['scene'] : [])];
  if (!av.ok) return { reason: av.reason, ms: Date.now() - t0, loadMs: 0, perFrameMs: 0 };
  const seconds = a.asset.analyzedSeconds;
  const fps = opts.fps ?? semanticFps(seconds);
  const w = Math.min(640, a.asset.w), h = Math.max(2, Math.round((w * a.asset.h) / a.asset.w / 2) * 2);
  const { frames, loadMs, maxRssMB } = await runWorker(av.python!, av.env, ffmpeg, a.asset.file, { fps, w: w - (w % 2), h, maxSeconds: opts.maxSeconds ?? seconds, tasks, signal: opts.signal });
  const cuts = a.observed.shots.slice(1).map((s) => s.t0);
  const tracks = trackObjects(frames, fps, cuts, a.observed.camera);
  const subjects = findSubjects(tracks, seconds);
  const subj = tracks.find((t) => t.id === subjects.primary);
  const gestures = frames.flatMap((f) => (f.hands ?? []).filter((x) => x[0] !== 'None' && x[1] >= 0.5).map(([label, score, hand, x, y, bw, bh]) => ({ t: f.t, label, score, hand, box: { x: r3(x + bw / 2), y: r3(y + bh / 2), w: bw, h: bh } })));
  const text = textOverTime(a.observed.text ?? [], opts.textStep ?? textStep(a));
  const dups = similarShots(a.observed.shots, frames, a.inferred.moments.map((m) => m.t));
  const record: SemanticRecord = {
    observed: { tracks, gestures, textTracks: text.tracks, frames: frames.length, fps },
    inferred: {
      subjects,
      reframe: [reframeKeys(subj, a.asset, [9, 16], a.observed.shots), reframeKeys(subj, a.asset, [1, 1], a.observed.shots), reframeKeys(subj, a.asset, [4, 5], a.observed.shots)],
      activities: poseActivities(frames, tracks, a.observed.camera),
      sceneTypes: sceneTypes(a, frames),
      duplicates: dups,
      textChanges: text.changes,
      alignment: opts.words?.length ? alignSpeech(opts.words, tracks, text.tracks) : [],
      events: eventCandidates(a, tracks, text.changes, dups),
    },
  };
  const per = frames.map((f) => f.ms ?? 0);
  return { record, ms: Date.now() - t0, loadMs, perFrameMs: r3(mean(per)), maxRssMB };
}

/** Spacing of OCR samples (temporal OCR is denser than shot keyframes). */
export function textStep(a: FootageAnalysis): number {
  const ts = (a.observed.text ?? []).map((x) => x.t);
  const gaps = ts.slice(1).map((t, i) => t - ts[i]!);
  return median(gaps) || 1;
}
