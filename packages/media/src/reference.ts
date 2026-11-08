/**
 * Reference-reel shot/pacing analysis using only the existing local FFmpeg tools.
 * Candidate hard cuts only: it does not infer typography, effects or editorial intent.
 */
import { TmepError, r2 } from '../../core/src/index.ts';
import { ffmpegInfo, probe } from './ffmpeg.ts';
import { run } from './exec.ts';

export interface ReferenceOptions {
  threshold?: number;
  sampleFps?: number;
  maxSeconds?: number;
  minGapSec?: number;
}

export interface ReferencePacing {
  method: 'ffmpeg-scene-sampled-v1';
  duration: number;
  analyzedSeconds: number;
  truncated: boolean;
  width: number;
  height: number;
  fps: number;
  sampleFps: number;
  threshold: number;
  cutCount: number;
  cuts: number[];
  meanShotSec: number;
  medianShotSec: number;
  cutsPerMinute: number;
  pacing: 'low' | 'medium' | 'high';
}

/** Extract PTS times only from showinfo after select=gt(scene,...). */
export function parseSceneTimes(log: string, duration: number, minGapSec = 0.2): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(minGapSec) || minGapSec < 0) {
    throw new TmepError('E_INPUT', 'invalid scene-analysis duration or minimum gap');
  }
  const out: number[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (!/Parsed_showinfo_\d+/.test(line)) continue;
    const match = /\bpts_time:\s*(-?(?:\d+\.?\d*|\.\d+))\b/.exec(line);
    if (!match) continue;
    const time = Number(match[1]);
    if (!Number.isFinite(time) || time <= 0 || time >= duration) continue;
    if (out.length && time - out[out.length - 1]! < minGapSec) continue;
    out.push(r2(time, 3));
  }
  return out;
}

export function shotPacing(cuts: number[], duration: number): Pick<ReferencePacing, 'cutCount' | 'meanShotSec' | 'medianShotSec' | 'cutsPerMinute' | 'pacing'> {
  if (!Number.isFinite(duration) || duration <= 0) throw new TmepError('E_INPUT', 'invalid analysis duration');
  if (cuts.some((t, i) => !Number.isFinite(t) || t <= (cuts[i - 1] ?? 0) || t >= duration)) {
    throw new TmepError('E_INPUT', 'cut timestamps must be ascending and inside duration');
  }
  const points = [0, ...cuts, duration];
  const lengths = points.slice(1).map((p, i) => p - points[i]!).sort((a, b) => a - b);
  const middle = Math.floor(lengths.length / 2);
  const median = lengths.length % 2 ? lengths[middle]! : (lengths[middle - 1]! + lengths[middle]!) / 2;
  const rate = cuts.length * 60 / duration;
  return {
    cutCount: cuts.length,
    meanShotSec: r2(duration / lengths.length, 2),
    medianShotSec: r2(median, 2),
    cutsPerMinute: r2(rate, 1),
    pacing: rate >= 20 ? 'high' : rate >= 8 ? 'medium' : 'low',
  };
}

/** Bounded-resolution/FPS scan; outputs candidate hard cuts, not a cloned editing style. */
export async function analyzeReferenceReel(file: string, options: ReferenceOptions = {}): Promise<ReferencePacing> {
  const threshold = options.threshold ?? 0.3;
  const sampleFps = options.sampleFps ?? 15;
  const maxSeconds = options.maxSeconds ?? 120;
  const minGapSec = options.minGapSec ?? 0.2;
  if (![threshold, sampleFps, maxSeconds, minGapSec].every(Number.isFinite) ||
    threshold < 0.05 || threshold > 0.8 || sampleFps < 2 || sampleFps > 30 ||
    maxSeconds < 1 || maxSeconds > 300 || minGapSec < 0.1 || minGapSec > 2) {
    throw new TmepError('E_INPUT', 'invalid reference analysis settings');
  }
  const video = await probe(file);
  if (video.kind !== 'video' || !video.w || !video.h || !video.fps || video.dur <= 0) {
    throw new TmepError('E_MEDIA', 'reference must be a video with valid duration and dimensions');
  }
  const analyzedSeconds = Math.min(maxSeconds, video.dur);
  const info = await ffmpegInfo();
  const filter = 'fps=' + sampleFps + ',scale=320:-2,select=gt(scene\\,' + threshold + '),showinfo';
  const res = await run(info.ffmpeg, [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-i', file,
    '-t', String(analyzedSeconds), '-map', '0:v:0', '-an', '-sn', '-vf', filter,
    '-f', 'null', '-',
  ], { timeoutMs: Math.max(30000, analyzedSeconds * 3000), maxBuffer: 4 * 1024 * 1024 });
  if (res.code !== 0) throw new TmepError('E_FFMPEG_FAILED', 'reference scene detection failed', undefined, res.stderr.slice(-1500));
  const cuts = parseSceneTimes(res.stderr, analyzedSeconds, minGapSec);
  return {
    method: 'ffmpeg-scene-sampled-v1', duration: video.dur,
    analyzedSeconds: r2(analyzedSeconds, 3), truncated: analyzedSeconds < video.dur,
    width: video.w, height: video.h, fps: video.fps, sampleFps, threshold,
    cuts, ...shotPacing(cuts, analyzedSeconds),
  };
}
