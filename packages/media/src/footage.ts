/**
 * FRAME Intelligence — local footage understanding (Phase 4B, first architecture).
 *
 * One streaming low-resolution decode and one audio decode produce, deterministically and on CPU:
 * shot boundaries, scene groups, motion intensity, visual quality, audio activity, silences and
 * quiet screen regions; candidate moments are derived from those signals. Optional adapters (face
 * regions via OpenCV, visible text via tesseract) run only when the tools exist locally; otherwise
 * the capability is reported as unavailable — nothing is guessed in their place.
 *
 * The record (`frame.footage/1`) separates `observed` measurements from `inferred` interpretations,
 * and every inferred item carries its evidence and a confidence.
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TmepError } from '../../core/src/index.ts';
import { ffmpegInfo, probe } from './ffmpeg.ts';
import { run } from './exec.ts';
import { analyzeSemantics, eventCandidates, textOverTime, type SemanticRecord, type Track } from './semantic.ts';

export const FOOTAGE_SCHEMA = 'frame.footage/1';
export const FOOTAGE_VERSION = '5a.1';

export interface Box { x: number; y: number; w: number; h: number }
export interface Shot { id: string; t0: number; t1: number; cutScore: number; /** How the shot begins (absent on the first shot). */ boundary?: 'cut' | 'gradual'; keyframe: number; luma: number; motion: number; detail: number; signature: number[] }
export interface Scene { id: string; shots: string[]; t0: number; t1: number; confidence: number; basis: string }
export interface Moment { id: string; t: number; t0: number; t1: number; score: number; confidence: number; evidence: string[]; signals: Record<string, number> }
export interface QualityFlag { shot: string; flags: ('dark' | 'overexposed' | 'low-detail' | 'static')[]; luma: number; clipHigh: number; detail: number }
export type Capability = { status: 'ok'; tool: string } | { status: 'unavailable'; reason: string };

export interface FootageAnalysis {
  schema: typeof FOOTAGE_SCHEMA;
  asset: { file: string; dur: number; w: number; h: number; fps: number; audio: boolean; analyzedSeconds: number; truncated: boolean };
  provenance: { analyzer: string; version: string; method: string; params: Record<string, unknown>; ms: number }[];
  capabilities: Record<'shots' | 'motion' | 'quality' | 'audio' | 'speech' | 'faces' | 'text', Capability> & Partial<Record<'semantic', Capability>>;
  observed: {
    shots: Shot[];
    /** Mean absolute frame difference (0–255) per 0.5 s window. */
    motion: number[];
    /** Audio level (dBFS, RMS) per 0.5 s window; empty without an audio stream. */
    audio: number[];
    silences: { t0: number; t1: number }[];
    /** Phase 6: global camera motion per 0.5 s window (frame widths / heights per second; + = content moves right/down). */
    camera?: { dx: number; dy: number }[];
    /** Gradual transitions (dissolve, wipe, fade, graphic); hard cuts are the shot boundaries. */
    transitions?: { t0: number; t1: number; t: number; kind: 'gradual'; score: number }[];
    speech?: { t0: number; t1: number; text: string }[];
    faces?: { t: number; boxes: (Box & { conf: number })[] }[];
    text?: { t: number; text: string; conf: number }[];
    quality: QualityFlag[];
    /** 3×3 grid activity (motion + detail), normalized 0–1, row-major from top-left. */
    gridActivity: number[];
    /** Phase 5 semantic layer: detections linked into tracks (no identity). */
    tracks?: Track[];
    gestures?: SemanticRecord['observed']['gestures'];
    /** OCR tokens linked over time (temporal OCR). */
    textTracks?: SemanticRecord['observed']['textTracks'];
  };
  inferred: {
    scenes: Scene[];
    moments: Moment[];
    /** Screen regions with the least motion and detail: candidate places for graphics. */
    quietRegions: (Box & { activity: number })[];
    presenter?: Box & { confidence: number; basis: string };
    pacing: { cutsPerMinute: number; meanShotSec: number; label: 'low' | 'medium' | 'high' };
    subjects?: SemanticRecord['inferred']['subjects'];
    reframe?: SemanticRecord['inferred']['reframe'];
    activities?: SemanticRecord['inferred']['activities'];
    sceneTypes?: SemanticRecord['inferred']['sceneTypes'];
    duplicates?: SemanticRecord['inferred']['duplicates'];
    textChanges?: SemanticRecord['inferred']['textChanges'];
    alignment?: SemanticRecord['inferred']['alignment'];
    /** Moments where independent signals coincide; candidates only, never recognized event types. */
    events?: SemanticRecord['inferred']['events'];
  };
}

export interface FootageOptions {
  /** Analyze at most this many seconds (default 1800). */
  maxSeconds?: number;
  /** Words with timing from a transcript (speech segments come only from here). */
  words?: { w: string; s: number; e: number }[];
  faces?: boolean;
  ocr?: boolean;
  /** OCR every `textEvery` seconds (default 1) instead of only on shot keyframes. */
  temporalText?: boolean;
  textEvery?: number;
  /** MediaPipe semantic layer (objects, faces, pose, embeddings; gestures on request). */
  semantic?: boolean;
  gestures?: boolean;
  signal?: AbortSignal;
  /** A previous analysis of the same media and settings: only the requested adapters run again. */
  base?: FootageAnalysis;
}

const GW = 160, GH = 90, N = GW * GH, TW = 32, TH = 18;
const WIN = 0.5;

/** Adaptive sampling: dense for short media, sparser for long-form, bounded total work. */
export function samplingFps(seconds: number, nativeFps: number): number {
  const target = seconds <= 600 ? 10 : seconds <= 1800 ? 5 : 2;
  return Math.max(1, Math.min(target, Math.round(nativeFps) || target));
}

interface FrameStat { t: number; luma: number; clipLow: number; clipHigh: number; detail: number; diff: number; hist: Float32Array; grid: number[]; thumb?: number[]; t32?: Float32Array }

function stream(bin: string, args: string[], onData: (b: Buffer) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let err = '';
    const abort = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    p.stdout.on('data', onData);
    p.stderr.on('data', (d) => { if (err.length < 4000) err += String(d); });
    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new TmepError('E_CANCELLED', 'analysis cancelled'));
      else if (code === 0) resolve();
      else reject(new TmepError('E_FFMPEG_FAILED', `ffmpeg exited ${code}`, undefined, { tail: err.slice(-800) }));
    });
  });
}

export async function videoStats(bin: string, file: string, fps: number, maxSeconds: number, signal?: AbortSignal): Promise<FrameStat[]> {
  const stats: FrameStat[] = [];
  let carry: Buffer = Buffer.alloc(0);
  let prev: Buffer | undefined;
  let f = 0;
  const take = (fr: Buffer) => {
    let sum = 0, lo = 0, hi = 0, lap = 0, diff = 0;
    const hist = new Float32Array(16);
    const grid = new Array(9).fill(0);
    const thumb = new Array(64).fill(0);
    const t32 = new Float32Array(TW * TH);
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        const i = y * GW + x, v = fr[i]!;
        sum += v; if (v < 16) lo++; if (v > 235) hi++;
        thumb[((y * 8 / GH) | 0) * 8 + ((x * 8 / GW) | 0)] += v;
        t32[((y * TH / GH) | 0) * TW + ((x * TW / GW) | 0)]! += v / (N / (TW * TH));
        hist[v >> 4]! += 1;
        let l = 0;
        if (x > 0 && y > 0 && x < GW - 1 && y < GH - 1) { l = Math.abs(4 * v - fr[i - 1]! - fr[i + 1]! - fr[i - GW]! - fr[i + GW]!); lap += l * l; }
        const d = prev ? Math.abs(v - prev[i]!) : 0;
        diff += d;
        grid[Math.min(2, Math.floor((y * 3) / GH)) * 3 + Math.min(2, Math.floor((x * 3) / GW))] += d + l * 0.25;
      }
    }
    for (let k = 0; k < 16; k++) hist[k]! /= N;
    stats.push({ t: f / fps, luma: sum / N, clipLow: lo / N, clipHigh: hi / N, detail: Math.sqrt(lap / N), diff: prev ? diff / N : 0, hist, grid: grid.map((g) => g / (N / 9)), thumb: thumb.map((v) => v / (N / 64)), t32 });
    prev = Buffer.from(fr);
    f++;
  };
  await stream(bin, ['-v', 'error', '-t', String(maxSeconds), '-i', file, '-an', '-vf', `fps=${fps},scale=${GW}:${GH}:flags=area,format=gray`, '-f', 'rawvideo', '-'], (b) => {
    carry = carry.length ? Buffer.concat([carry, b]) : b;
    let o = 0;
    while (carry.length - o >= N) { take(carry.subarray(o, o + N)); o += N; }
    carry = carry.subarray(o);
  }, signal);
  return stats;
}

async function audioLevels(bin: string, file: string, maxSeconds: number, signal?: AbortSignal): Promise<number[]> {
  const SR = 16000, per = SR * WIN;
  const out: number[] = [];
  let acc = 0, n = 0;
  let carry: Buffer = Buffer.alloc(0);
  await stream(bin, ['-v', 'error', '-t', String(maxSeconds), '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], (b) => {
    carry = carry.length ? Buffer.concat([carry, b]) : b;
    const len = carry.length - (carry.length % 2);
    for (let i = 0; i < len; i += 2) {
      const v = carry.readInt16LE(i) / 32768;
      acc += v * v; n++;
      if (n === per) { out.push(10 * Math.log10(Math.max(1e-10, acc / n))); acc = 0; n = 0; }
    }
    carry = carry.subarray(len);
  }, signal);
  if (n > per * 0.25) out.push(10 * Math.log10(Math.max(1e-10, acc / n)));
  return out;
}

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const histDist = (a: ArrayLike<number>, b: ArrayLike<number>) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!); return d / 2; };
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Hard cuts from histogram change: above an absolute floor and well above the local median. */
export function detectCuts(stats: FrameStat[], fps: number, minShot = 0.4): { t: number; score: number }[] {
  const d = stats.map((s, i) => (i ? histDist(s.hist, stats[i - 1]!.hist) : 0));
  const cuts: { t: number; score: number }[] = [];
  const W = Math.max(3, Math.round(fps * 1.5));
  const lv = stats[0]?.t32 ? stats.map((s, i) => (i ? compensated(stats[i - 1]!.t32!, s.t32!).plain : 0)) : undefined;
  for (let i = 1; i < d.length; i++) {
    const local = median(d.slice(Math.max(1, i - W), Math.min(d.length, i + W + 1)).filter((_, k, arr) => arr.length > 0));
    // Structural cue for cuts between shots with similar colour histograms: a frame-difference spike.
    const localDiff = median(stats.slice(Math.max(1, i - W), Math.min(stats.length, i + W + 1)).map((s) => s.diff));
    const structural = stats[i]!.diff > 22 && stats[i]!.diff > 4 * localDiff + 4;
    // Level-normalized 32×18 step (when available): catches cuts between shots of similar tone and
    // vetoes exposure jumps, which change histograms but not structure.
    const L = lv ? lv[i]! : undefined;
    const levelCut = L !== undefined && d[i]! > 0.12 && L > 25 && L > 3 * median(lv!.slice(Math.max(1, i - W), Math.min(lv!.length, i + W + 1))) + 8 && compensated(stats[i - 1]!.t32!, stats[i]!.t32!).best > 0.65 * L;
    const exposure = L !== undefined && (d[i - 1] ?? 0) < 0.1 && (d[i + 1] ?? 0) < 0.1 && correlation(stats[i - 1]!.t32!, stats[i]!.t32!) > 0.9;
    const strong = ((d[i]! > 0.3 && d[i]! > 3 * local + 0.05) || structural || levelCut) && !exposure;
    // A flash jumps away and back: frame i differs from i-1, frame i+1 jumps again and looks like i-1.
    // A cut jumps once (the next frame continues the new shot). Histograms alone cannot tell two shots
    // with the same tones from a return, so the second jump must also show in pixel differences.
    const back = (a: number, b: number) => histDist(stats[a]!.hist, stats[b]!.hist) < 0.12 && Math.abs(stats[a]!.luma - stats[b]!.luma) < 8;
    const flashy = i + 1 < d.length && stats[i + 1]!.diff > 0.5 * stats[i]!.diff && back(i + 1, i - 1);
    const returning = i >= 2 && stats[i - 1]!.diff > 0.5 * stats[i]!.diff && (d[i - 1]! > 0.3 || stats[i - 1]!.diff > 22) && back(i, i - 2);
    if (strong && !flashy && !returning && (!cuts.length || stats[i]!.t - cuts[cuts.length - 1]!.t >= minShot)) cuts.push({ t: stats[i]!.t, score: r3(d[i]!) });
  }
  return cuts;
}

const thumbDist = (a: FrameStat, b: FrameStat) => { let d = 0; for (let i = 0; i < 64; i++) d += Math.abs(a.thumb![i]! - b.thumb![i]!); return d / 64; };

/** Pearson correlation of two thumbnails: high when structure is kept (exposure change), low across a cut. */
export function correlation(A: Float32Array, B: Float32Array): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < A.length; i++) { ma += A[i]!; mb += B[i]!; }
  ma /= A.length; mb /= B.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < A.length; i++) { const x = A[i]! - ma, y = B[i]! - mb; ab += x * y; aa += x * x; bb += y * y; }
  return ab / Math.sqrt(Math.max(1e-9, aa * bb));
}

/** Share of the difference between two thumbnails that remains after equalizing their mean level. */
function levelled(A: Float32Array, B: Float32Array): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < A.length; i++) { ma += A[i]!; mb += B[i]!; }
  ma /= A.length; mb /= B.length;
  let ab = 0, abn = 0;
  for (let i = 0; i < A.length; i++) { ab += Math.abs(A[i]! - B[i]!); abn += Math.abs(A[i]! - ma - (B[i]! - mb)); }
  return abn / Math.max(1e-6, ab);
}

/** Mean-normalized difference of 32×18 thumbnails, unshifted and at the best shift (±4, ±2 cells). */
export function compensated(a: Float32Array, b: Float32Array): { plain: number; best: number; dx: number; dy: number } {
  let ma = 0, mb = 0, bx = 0, by = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= a.length; mb /= b.length;
  let plain = 0, best = Infinity;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -7; dx <= 7; dx++) {
    let d = 0, n = 0;
    for (let y = Math.max(0, -dy); y < TH - Math.max(0, dy); y++) for (let x = Math.max(0, -dx); x < TW - Math.max(0, dx); x++) {
      d += Math.abs(a[y * TW + x]! - ma - (b[(y + dy) * TW + x + dx]! - mb)); n++;
    }
    d /= n; if (dx === 0 && dy === 0) plain = d; if (d < best) { best = d; bx = dx; by = dy; }
  }
  return { plain, best, dx: bx, dy: by };
}

/**
 * Global camera motion: the best-matching shift between thumbnails 0.5 s apart (32×18 grid, ±7/±3 cells),
 * accepted only when shifting explains the change (best < 0.8 × unshifted); cuts give zero.
 */
export function cameraMotion(stats: FrameStat[], fps: number, cuts: number[], seconds: number): { dx: number; dy: number }[] {
  const out: { dx: number; dy: number }[] = [];
  const step = Math.max(1, Math.round(fps * WIN));
  for (let t = 0; t < seconds; t += WIN) {
    const i = Math.round(t * fps), j = i + step;
    const a = stats[i], b = stats[j];
    if (!a?.t32 || !b?.t32 || cuts.some((c) => c > a.t && c <= b.t)) { out.push({ dx: 0, dy: 0 }); continue; }
    const c = compensated(a.t32, b.t32);
    const ok = c.best < 0.8 * c.plain && c.plain > 1;
    out.push(ok ? { dx: r3(c.dx / TW / WIN), dy: r3(c.dy / TH / WIN) } : { dx: 0, dy: 0 });
  }
  return out;
}

/**
 * Gradual transitions (dissolves, wipes, fades, graphic transitions): the picture before and after a
 * window differs strongly while each side is stable and no single frame step explains the change
 * (that would be a hard cut). A camera move changes continuously, so its sides are not stable.
 */
export function detectGradual(stats: FrameStat[], fps: number, cuts: { t: number }[], opts: { half?: number; min?: number } = {}): { t0: number; t1: number; t: number; score: number }[] {
  if (!stats.length || !stats[0]!.thumb) return [];
  const k = Math.max(2, Math.round((opts.half ?? 0.5) * fps)), min = opts.min ?? 22;
  const cand: { i: number; a: number; ratio: number }[] = [];
  for (let i = 2 * k; i + 2 * k < stats.length; i++) {
    const a = thumbDist(stats[i - k]!, stats[i + k]!);
    if (a < min) continue;
    const side = Math.max(thumbDist(stats[i - 2 * k]!, stats[i - k]!), thumbDist(stats[i + k]!, stats[i + 2 * k]!));
    let step = 0;
    for (let j = i - k + 1; j <= i + k; j++) step = Math.max(step, thumbDist(stats[j - 1]!, stats[j]!));
    if (side > 0.45 * a || step > 0.55 * a) continue;
    // Tones must change too: a camera move over one scene keeps its histogram, a new shot does not.
    if (histDist(stats[i - k]!.hist, stats[i + k]!.hist) < 0.15) continue;
    // Camera motion is explained by shifting consecutive frames, an exposure change by re-levelling
    // them; a blend between two shots is explained by neither.
    if (stats[i]!.t32) {
      let plain = 0, best = 0;
      for (let j = i - k + 1; j <= i + k; j++) { const c = compensated(stats[j - 1]!.t32!, stats[j]!.t32!); plain += c.plain; best += c.best; }
      if (best < 0.9 * plain || levelled(stats[i - k]!.t32!, stats[i + k]!.t32!) < 0.8) continue;
    }
    if (cuts.some((c) => Math.abs(c.t - stats[i]!.t) <= (2 * k) / fps)) continue;
    cand.push({ i, a, ratio: a / Math.max(1, side) });
  }
  const out: { t0: number; t1: number; t: number; score: number }[] = [];
  for (const c of [...cand].sort((x, y) => y.a - x.a)) {
    const t = stats[c.i]!.t;
    if (out.some((o) => Math.abs(o.t - t) < 1)) continue;
    out.push({ t: r3(t), t0: r3(stats[c.i - k]!.t), t1: r3(stats[c.i + k]!.t), score: r3(Math.min(1, c.a / 80)) });
  }
  return out.sort((x, y) => x.t - y.t);
}

export function buildShots(stats: FrameStat[], cuts: { t: number; score: number; kind?: 'cut' | 'gradual' }[], dur: number): Shot[] {
  const bounds = [0, ...cuts.map((c) => c.t), dur];
  const shots: Shot[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const t0 = bounds[k]!, t1 = bounds[k + 1]!;
    const fr = stats.filter((s) => s.t >= t0 && s.t < t1);
    if (!fr.length || t1 - t0 <= 0) continue;
    const sig = new Array(16).fill(0);
    for (const s of fr) for (let i = 0; i < 16; i++) sig[i] += s.hist[i]! / fr.length;
    shots.push({
      id: `s${shots.length + 1}`, t0: r3(t0), t1: r3(t1), cutScore: k ? cuts[k - 1]!.score : 0, ...(k ? { boundary: cuts[k - 1]!.kind ?? 'cut' } : {}),
      keyframe: r3(fr[Math.floor(fr.length / 2)]!.t),
      luma: r3(fr.reduce((a, s) => a + s.luma, 0) / fr.length),
      motion: r3(median(fr.slice(1).map((s) => s.diff))),
      detail: r3(fr.reduce((a, s) => a + s.detail, 0) / fr.length),
      signature: sig.map(r3),
    });
  }
  return shots;
}

/** Consecutive shots that look alike (histogram signature) form one inferred scene. */
export function groupScenes(shots: Shot[], silences: { t0: number; t1: number }[], threshold = 0.3): Scene[] {
  const scenes: Scene[] = [];
  for (const s of shots) {
    const cur = scenes[scenes.length - 1];
    const last = cur && shots.find((x) => x.id === cur.shots[cur.shots.length - 1]);
    const dist = last ? histDist(last.signature, s.signature) : 1;
    const pause = silences.some((p) => p.t0 <= s.t0 + 0.05 && p.t1 >= s.t0 - 0.05 && p.t1 - p.t0 >= 1.2);
    if (cur && dist < threshold && !pause) {
      cur.shots.push(s.id); cur.t1 = s.t1; cur.confidence = r3(Math.min(cur.confidence, 1 - dist / threshold * 0.5));
    } else {
      scenes.push({ id: `sc${scenes.length + 1}`, shots: [s.id], t0: s.t0, t1: s.t1, confidence: 0.6, basis: cur ? (pause ? 'visual change + long pause' : `visual change (histogram distance ${r3(dist)})`) : 'start' });
    }
  }
  return scenes;
}

export function findSilences(levels: number[], minDur = 0.6): { t0: number; t1: number }[] {
  if (!levels.length) return [];
  const floor = Math.max(-60, median(levels) - 25);
  const thr = Math.min(-40, floor + 6);
  const out: { t0: number; t1: number }[] = [];
  let start = -1;
  levels.forEach((l, i) => {
    if (l < thr && start < 0) start = i;
    if ((l >= thr || i === levels.length - 1) && start >= 0) {
      const end = l < thr ? i + 1 : i;
      if ((end - start) * WIN >= minDur) out.push({ t0: start * WIN, t1: end * WIN });
      start = -1;
    }
  });
  return out;
}

/** Inferred candidate moments: local maxima of combined audio, motion and cut-density evidence. */
export function findMoments(motion: number[], audio: number[], cuts: number[], max = 12): Moment[] {
  const n = Math.max(motion.length, audio.length);
  if (!n) return [];
  const mMed = median(motion.filter((v) => v > 0)) || 1, aMed = median(audio);
  const score: number[] = [], sig: Record<string, number>[] = [];
  for (let i = 0; i < n; i++) {
    const m = motion[i] ?? 0, a = audio[i] ?? aMed;
    const mz = Math.max(0, m / mMed - 1);
    const az = audio.length ? Math.max(0, (a - aMed) / 6) : 0;
    const t = i * WIN;
    const dens = cuts.filter((c) => c >= t - 2 && c < t + 2).length;
    const cz = Math.max(0, dens - 1) * 0.5;
    score.push(mz * 0.9 + az * 1.2 + cz);
    sig.push({ motionX: r3(m / mMed), audioDb: r3(a - aMed), cuts4s: dens });
  }
  const sm = score.map((_, i) => (score[i - 1] ?? score[i]!) * 0.25 + score[i]! * 0.5 + (score[i + 1] ?? score[i]!) * 0.25);
  const peaks = sm.map((v, i) => ({ v, i })).filter(({ v, i }) => v > 0.8 && v >= (sm[i - 1] ?? 0) && v >= (sm[i + 1] ?? 0)).sort((a, b) => b.v - a.v);
  const chosen: { v: number; i: number }[] = [];
  for (const p of peaks) if (chosen.length < max && chosen.every((c) => Math.abs(c.i - p.i) * WIN >= 2)) chosen.push(p);
  chosen.sort((a, b) => a.i - b.i);
  return chosen.map(({ v, i }, k) => {
    const s = sig[i]!, ev: string[] = [];
    if (s.audioDb! >= 4) ev.push(`audio ${s.audioDb!.toFixed(1)} dB above median`);
    if (s.motionX! >= 1.6) ev.push(`motion ${s.motionX!.toFixed(1)}× median`);
    if (s.cuts4s! >= 2) ev.push(`${s.cuts4s} cuts within 4 s`);
    const t = r3(i * WIN + WIN / 2);
    return { id: `m${k + 1}`, t, t0: r3(Math.max(0, t - 1.5)), t1: r3(t + 1.5), score: r3(v), confidence: r3(1 - Math.exp(-v / 2)), evidence: ev.length ? ev : ['combined signal peak'], signals: s };
  });
}

export function quietRegions(gridActivity: number[]): (Box & { activity: number })[] {
  return gridActivity.map((a, i) => ({ x: r3((i % 3) / 3 + 1 / 6), y: r3(Math.floor(i / 3) / 3 + 1 / 6), w: r3(1 / 3), h: r3(1 / 3), activity: r3(a) }))
    .sort((a, b) => a.activity - b.activity).slice(0, 3);
}

// ---------- optional adapters ----------

async function pythonWith(module: string): Promise<string | undefined> {
  for (const py of [process.env.FRAME_PYTHON ?? process.env.TMEP_PYTHON, 'python3', 'python'].filter(Boolean) as string[]) {
    // run() resolves on a non-zero exit, so the import must be checked by exit code.
    try { if ((await run(py, ['-c', `import ${module}`], { timeoutMs: 15000 })).code === 0) return py; } catch { /* not on PATH */ }
  }
  return undefined;
}

async function extractKeyframes(bin: string, file: string, times: number[], dir: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const f = path.join(dir, `k${String(i).padStart(4, '0')}.png`);
    const r = await run(bin, ['-v', 'error', '-y', '-ss', String(times[i]), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', f], { timeoutMs: 60000 });
    if (r.code !== 0) throw new TmepError('E_FFMPEG_FAILED', `keyframe extraction failed at ${times[i]}s`, undefined, r.stderr.slice(-400));
    out.push(f);
  }
  return out;
}

const FACE_PY = `
import sys, json, os, cv2
path = os.path.join(getattr(getattr(cv2, 'data', None), 'haarcascades', ''), 'haarcascade_frontalface_default.xml')
if not hasattr(cv2, 'CascadeClassifier') or not os.path.exists(path):
    print(json.dumps({'error': 'OpenCV ' + cv2.__version__ + ' has no bundled Haar face cascade (OpenCV 5 removed it): pip install "opencv-python-headless<5"'}))
    sys.exit(0)
casc = cv2.CascadeClassifier(path)
res = []
for p in sys.argv[1:]:
    img = cv2.imread(p, cv2.IMREAD_GRAYSCALE)
    h, w = img.shape
    found = casc.detectMultiScale(img, scaleFactor=1.1, minNeighbors=6, minSize=(max(24, w // 20), max(24, w // 20)))
    res.append([[float(x)/w, float(y)/h, float(fw)/w, float(fh)/h] for (x, y, fw, fh) in found])
print(json.dumps(res))
`;

async function detectFaces(bin: string, file: string, times: number[], tmp: string): Promise<{ cap: Capability; faces?: FootageAnalysis['observed']['faces'] }> {
  const py = await pythonWith('cv2');
  if (!py) return { cap: { status: 'unavailable', reason: 'OpenCV for Python not installed (pip install "opencv-python-headless<5")' } };
  const frames = await extractKeyframes(bin, file, times, tmp);
  const r = await run(py, ['-c', FACE_PY, ...frames], { timeoutMs: 300000 });
  if (r.code !== 0) return { cap: { status: 'unavailable', reason: `face detector failed: ${r.stderr.trim().split('\n').pop() ?? 'unknown error'}` } };
  const parsed = JSON.parse(r.stdout) as number[][][] | { error: string };
  if (!Array.isArray(parsed)) return { cap: { status: 'unavailable', reason: parsed.error } };
  const boxes = parsed;
  return {
    cap: { status: 'ok', tool: 'opencv haarcascade_frontalface_default' },
    faces: boxes.map((bs, i) => ({ t: r3(times[i]!), boxes: bs.map(([x, y, w, h]) => ({ x: r3(x! + w! / 2), y: r3(y! + h! / 2), w: r3(w!), h: r3(h!), conf: 0.5 })) })),
  };
}

async function readText(bin: string, file: string, times: number[], tmp: string): Promise<{ cap: Capability; text?: FootageAnalysis['observed']['text'] }> {
  const tess = process.env.FRAME_TESSERACT ?? process.env.TMEP_TESSERACT ?? 'tesseract';
  let ok = false;
  try { ok = (await run(tess, ['--version'], { timeoutMs: 15000 })).code === 0; } catch { /* not on PATH */ }
  if (!ok) {
    return { cap: { status: 'unavailable', reason: 'tesseract OCR not installed (e.g. apt install tesseract-ocr)' } };
  }
  const frames = await extractKeyframes(bin, file, times, tmp);
  const text: NonNullable<FootageAnalysis['observed']['text']> = [];
  for (let i = 0; i < frames.length; i++) {
    const r = await run(tess, [frames[i]!, '-', '--psm', '11', 'tsv'], { timeoutMs: 120000 }).catch(() => undefined);
    if (!r || r.code !== 0) continue;
    // Keep words ≥ 70% confidence; single characters only when alphanumeric and ≥ 80% (scores, digits).
    const words = r.stdout.split('\n').slice(1).map((l) => l.split('\t')).filter((c) => {
      if (c.length < 12) return false;
      const w = c[11]!.trim(), conf = Number(c[10]);
      return w.length >= 2 ? conf >= 70 : /^[\p{L}\p{N}]$/u.test(w) && conf >= 80;
    });
    if (words.length) text.push({ t: r3(times[i]!), text: words.map((c) => c[11]!.trim()).join(' ').slice(0, 200), conf: r3(words.reduce((a, c) => a + Number(c[10]), 0) / words.length / 100) });
  }
  return { cap: { status: 'ok', tool: 'tesseract' }, text };
}

// ---------- entry point ----------

export async function analyzeFootage(file: string, opts: FootageOptions = {}): Promise<FootageAnalysis> {
  const info = await ffmpegInfo();
  if (opts.base) return addAdapters(info.ffmpeg, file, structuredClone(opts.base), opts);
  const pr = await probe(file);
  if (!pr.w || !pr.h) throw new TmepError('E_MEDIA', 'footage analysis needs a video stream');
  const maxSeconds = opts.maxSeconds ?? 1800;
  const seconds = Math.min(pr.dur, maxSeconds);
  const fps = samplingFps(seconds, pr.fps ?? 30);
  const t0 = Date.now();
  const [stats, levels] = await Promise.all([
    videoStats(info.ffmpeg, file, fps, maxSeconds, opts.signal),
    pr.audio ? audioLevels(info.ffmpeg, file, maxSeconds, opts.signal) : Promise.resolve([] as number[]),
  ]);
  const tVideo = Date.now() - t0;
  const cuts = detectCuts(stats, fps);
  const gradual = detectGradual(stats, fps, cuts);
  // Shots end at hard cuts and at the middle of gradual transitions.
  const shots = buildShots(stats, [...cuts, ...gradual.map((g) => ({ t: g.t, score: g.score, kind: 'gradual' as const }))].sort((a, b) => a.t - b.t), seconds);
  const motion: number[] = [];
  for (let t = 0; t < seconds; t += WIN) {
    const fr = stats.filter((s) => s.t >= t && s.t < t + WIN && !cuts.some((c) => Math.abs(c.t - s.t) < 0.5 / fps));
    motion.push(r3(fr.length ? fr.reduce((a, s) => a + s.diff, 0) / fr.length : 0));
  }
  const silences = findSilences(levels);
  const camera = cameraMotion(stats, fps, cuts.map((c) => c.t), seconds);
  const gridSum = new Array(9).fill(0);
  for (const s of stats) s.grid.forEach((g, i) => (gridSum[i] += g));
  const gmax = Math.max(...gridSum, 1e-9);
  const gridActivity = gridSum.map((g) => r3(g / gmax));
  const medDetail = median(shots.map((s) => s.detail)) || 1;
  const quality: QualityFlag[] = shots.map((s) => {
    const fr = stats.filter((x) => x.t >= s.t0 && x.t < s.t1);
    const clipHigh = r3(fr.reduce((a, x) => a + x.clipHigh, 0) / Math.max(1, fr.length));
    const flags: QualityFlag['flags'] = [];
    if (s.luma < 40) flags.push('dark');
    if (clipHigh > 0.08) flags.push('overexposed');
    if (s.detail < medDetail * 0.4) flags.push('low-detail');
    if (s.motion < 0.3 && s.t1 - s.t0 > 2) flags.push('static');
    return { shot: s.id, flags, luma: s.luma, clipHigh, detail: s.detail };
  }).filter((q) => q.flags.length);

  const caps: FootageAnalysis['capabilities'] = {
    shots: { status: 'ok', tool: 'histogram + structural cut detector, gradual-transition detector' },
    motion: { status: 'ok', tool: 'ffmpeg frame difference' },
    quality: { status: 'ok', tool: 'luma/clipping/Laplacian statistics' },
    audio: pr.audio ? { status: 'ok', tool: 'ffmpeg PCM RMS' } : { status: 'unavailable', reason: 'no audio stream' },
    speech: opts.words?.length ? { status: 'ok', tool: 'transcript (provided)' } : { status: 'unavailable', reason: 'no transcript: run transcribe first (no speech is inferred from audio level)' },
    faces: { status: 'unavailable', reason: 'not requested' },
    text: { status: 'unavailable', reason: 'not requested' },
  };
  const provenance: FootageAnalysis['provenance'] = [
    { analyzer: 'frame.video-stats', version: FOOTAGE_VERSION, method: `${GW}x${GH} gray @ ${fps} fps: histogram + level-normalized structural cuts, gradual transitions (blend vs camera-motion test), frame difference, Laplacian detail, 3×3 activity`, params: { fps, maxSeconds }, ms: tVideo },
  ];
  if (pr.audio) provenance.push({ analyzer: 'frame.audio-levels', version: FOOTAGE_VERSION, method: 'mono 16 kHz RMS per 0.5 s; silence = 6 dB above an adaptive floor, ≥ 0.6 s', params: {}, ms: tVideo });

  const observed: FootageAnalysis['observed'] = { shots, motion, audio: levels.map(r3), silences, transitions: gradual.map((g) => ({ ...g, kind: 'gradual' as const })), camera, quality, gridActivity };
  if (opts.words?.length) {
    // Speech segments come from the transcript: consecutive words with gaps < 0.6 s.
    const segs: { t0: number; t1: number; text: string }[] = [];
    for (const w of opts.words) {
      const last = segs[segs.length - 1];
      if (last && w.s - last.t1 < 0.6) { last.t1 = w.e; last.text += ` ${w.w}`; } else segs.push({ t0: w.s, t1: w.e, text: w.w });
    }
    observed.speech = segs.map((s) => ({ t0: r3(s.t0), t1: r3(s.t1), text: s.text.slice(0, 240) }));
  }
  const inferred: FootageAnalysis['inferred'] = {
    scenes: groupScenes(shots, silences),
    moments: findMoments(motion, levels, cuts.map((c) => c.t)),
    quietRegions: quietRegions(gridActivity),
    pacing: (() => {
      const cpm = seconds > 0 ? ((cuts.length + gradual.length) / seconds) * 60 : 0;
      return { cutsPerMinute: r3(cpm), meanShotSec: r3(shots.length ? seconds / shots.length : seconds), label: cpm >= 20 ? 'high' : cpm >= 6 ? 'medium' : 'low' };
    })(),
  };
  const result: FootageAnalysis = {
    schema: FOOTAGE_SCHEMA,
    asset: { file, dur: r3(pr.dur), w: pr.w, h: pr.h, fps: pr.fps ?? 0, audio: pr.audio, analyzedSeconds: r3(seconds), truncated: pr.dur > maxSeconds },
    provenance, capabilities: caps, observed, inferred,
  };
  result.inferred.events = eventCandidates(result, [], [], []);
  return opts.faces || opts.ocr || opts.temporalText || opts.semantic ? addAdapters(info.ffmpeg, file, result, opts) : result;
}

const textEvery = (prov: FootageAnalysis['provenance']) => prov.find((p) => p.analyzer === 'frame.ocr')?.params.every as number | undefined;

/** Run the optional adapters (faces, visible text) on shot keyframes and derive the presenter region. */
async function addAdapters(bin: string, file: string, a: FootageAnalysis, opts: FootageOptions): Promise<FootageAnalysis> {
  const keyTimes = a.observed.shots.slice(0, 40).map((s) => s.keyframe);
  const { observed, inferred, capabilities: caps, provenance } = a;
  if (!(opts.faces || opts.ocr || opts.temporalText || opts.semantic)) return a;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-footage-'));
  try {
    if (opts.faces && caps.faces.status !== 'ok') {
      const t = Date.now();
      const r = await detectFaces(bin, file, keyTimes, tmp);
      caps.faces = r.cap; if (r.faces) observed.faces = r.faces;
      if (r.cap.status === 'ok') provenance.push({ analyzer: 'frame.faces', version: FOOTAGE_VERSION, method: r.cap.tool + ' on shot keyframes (location only, no identity)', params: { frames: keyTimes.length }, ms: Date.now() - t });
    }
    const temporal = provenance.some((p) => p.analyzer === 'frame.ocr' && p.params.every);
    if ((opts.ocr && caps.text.status !== 'ok') || (opts.temporalText && !temporal)) {
      const t = Date.now();
      const every = opts.textEvery ?? 1;
      const times = opts.temporalText ? Array.from({ length: Math.min(180, Math.floor(a.asset.analyzedSeconds / every)) }, (_, i) => r3(i * every + every / 2)) : keyTimes;
      const r = await readText(bin, file, times, tmp);
      caps.text = r.cap; if (r.text) observed.text = r.text;
      if (r.cap.status === 'ok') {
        for (let i = provenance.length - 1; i >= 0; i--) if (provenance[i]!.analyzer === 'frame.ocr') provenance.splice(i, 1);
        provenance.push({ analyzer: 'frame.ocr', version: FOOTAGE_VERSION, method: `tesseract psm 11 on ${opts.temporalText ? `frames every ${every} s` : 'shot keyframes'}, words ≥ 70% confidence`, params: opts.temporalText ? { frames: times.length, every } : { frames: times.length }, ms: Date.now() - t });
      }
    }
    if (opts.semantic && caps.semantic?.status !== 'ok') {
      const r = await analyzeSemantics(bin, a, { gestures: opts.gestures, words: opts.words, signal: opts.signal, maxSeconds: a.asset.analyzedSeconds, textStep: textEvery(provenance) });
      if (!r.record) caps.semantic = { status: 'unavailable', reason: r.reason ?? 'unknown' };
      else {
        caps.semantic = { status: 'ok', tool: 'MediaPipe Tasks (EfficientDet-Lite0, BlazeFace, BlazePose lite, MobileNetV3 embedder' + (opts.gestures ? ', gesture recognizer' : '') + ')' };
        const { observed: o, inferred: n } = r.record;
        observed.tracks = o.tracks; if (o.gestures.length) observed.gestures = o.gestures;
        Object.assign(inferred, { subjects: n.subjects, reframe: n.reframe, activities: n.activities, sceneTypes: n.sceneTypes, duplicates: n.duplicates, ...(n.alignment.length ? { alignment: n.alignment } : {}) });
        provenance.push({ analyzer: 'frame.semantic', version: FOOTAGE_VERSION, method: `MediaPipe CPU @ ${o.fps} fps (${o.frames} frames): IoU tracking, subjects, reframe keys, pose activity, scene rules, embedding similarity`, params: { fps: o.fps, frames: o.frames, gestures: !!opts.gestures, loadMs: r.loadMs, perFrameMs: r.perFrameMs, workerMaxRssMB: r.maxRssMB }, ms: r.ms });
      }
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
  if (observed.text?.length) {
    const tt = textOverTime(observed.text, textEvery(provenance) ?? 1);
    observed.textTracks = tt.tracks; inferred.textChanges = tt.changes;
  }
  inferred.events = eventCandidates(a, observed.tracks ?? [], inferred.textChanges ?? [], inferred.duplicates ?? []);
  if (observed.faces?.some((f) => f.boxes.length)) {
    // Presenter region: the most persistent face box across keyframes, expanded to head and shoulders.
    const all = observed.faces.flatMap((f) => f.boxes);
    const big = [...all].sort((a, b) => b.w * b.h - a.w * a.h)[0]!;
    const seen = observed.faces.filter((f) => f.boxes.some((b) => Math.abs(b.x - big.x) < 0.1 && Math.abs(b.y - big.y) < 0.1)).length;
    inferred.presenter = { x: big.x, y: r3(Math.min(1, big.y + big.h * 0.6)), w: r3(Math.min(1, big.w * 2.2)), h: r3(Math.min(1, big.h * 2.6)), confidence: r3(seen / observed.faces.length), basis: `face box persistent in ${seen}/${observed.faces.length} keyframes, expanded to head and shoulders` };
  }
  return a;
}
