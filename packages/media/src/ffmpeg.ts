/**
 * FFmpeg/ffprobe discovery, capability detection, probing and audio analysis.
 * Generated filter graphs target FFmpeg 6.1 .. 8.x.
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { TmepError, r2 } from '../../core/src/index.ts';
import { run, type RunOptions } from './exec.ts';

export interface FfmpegInfo {
  ffmpeg: string;
  ffprobe: string;
  version: string;
  major: number;
  filters: Set<string>;
  encoders: Set<string>;
}

let cached: Promise<FfmpegInfo> | undefined;

export function ffmpegInfo(): Promise<FfmpegInfo> {
  cached ??= detect();
  return cached;
}

async function detect(): Promise<FfmpegInfo> {
  const ffmpeg = process.env.TMEP_FFMPEG || 'ffmpeg';
  const ffprobe = process.env.TMEP_FFPROBE || (process.env.TMEP_FFMPEG ? path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe')) : 'ffprobe');
  let ver;
  try {
    ver = await run(ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 20000 });
    await run(ffprobe, ['-version'], { timeoutMs: 20000 });
  } catch {
    cached = undefined;
    throw new TmepError('E_FFMPEG_MISSING', 'ffmpeg/ffprobe not found on PATH', 'install FFmpeg (Windows: `winget install Gyan.FFmpeg`) or set TMEP_FFMPEG / TMEP_FFPROBE');
  }
  const m = /ffmpeg version (\S+)/.exec(ver.stdout);
  const version = m?.[1] ?? 'unknown';
  const major = parseInt(/^n?(\d+)/.exec(version)?.[1] ?? '0', 10);
  const [f, e] = await Promise.all([run(ffmpeg, ['-hide_banner', '-filters']), run(ffmpeg, ['-hide_banner', '-encoders'])]);
  const filters = new Set<string>();
  for (const line of f.stdout.split('\n')) {
    const mm = /^\s*[TSC.]{2,3}\s+(\S+)\s/.exec(line);
    if (mm) filters.add(mm[1]!);
  }
  const encoders = new Set<string>();
  for (const line of e.stdout.split('\n')) {
    const mm = /^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)/.exec(line);
    if (mm) encoders.add(mm[1]!);
  }
  return { ffmpeg, ffprobe, version, major, filters, encoders };
}

export function requireFilters(info: FfmpegInfo, names: string[]): void {
  const missing = names.filter((n) => !info.filters.has(n));
  if (missing.length) {
    throw new TmepError('E_FFMPEG_MISSING', `ffmpeg build lacks filters: ${missing.join(',')}`, 'use a full build (e.g. gyan.dev "full" or BtbN GPL builds) with libass/libfreetype');
  }
}

export interface ProbeSummary {
  kind: 'video' | 'audio' | 'image';
  dur: number;
  w?: number;
  h?: number;
  fps?: number;
  audio: boolean;
  vcodec?: string;
  acodec?: string;
  rotation?: number;
}

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'jpeg2000', 'webp', 'bmp', 'tiff', 'gif', 'svg', 'jpegls']);

export async function probe(file: string): Promise<ProbeSummary> {
  const info = await ffmpegInfo();
  const res = await run(info.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60000 });
  if (res.code !== 0) throw new TmepError('E_MEDIA', `ffprobe could not read ${path.basename(file)}`, undefined, res.stderr.slice(-2000));
  const j = JSON.parse(res.stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: { codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; duration?: string; side_data_list?: { rotation?: number }[]; tags?: { rotate?: string }; disposition?: { attached_pic?: number } }[];
  };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) throw new TmepError('E_MEDIA', `${path.basename(file)} has no audio or video streams`);
  const dur = parseFloat(j.format?.duration ?? v?.duration ?? a?.duration ?? '0') || 0;
  const rate = (s?: string) => {
    if (!s) return undefined;
    const [n, d] = s.split('/').map(Number);
    return n && d ? n / d : undefined;
  };
  const isImage = !!v && (IMAGE_CODECS.has(v.codec_name) && (dur === 0 || /image2|png_pipe|jpeg_pipe|webp_pipe|svg/.test(j.format?.format_name ?? '') || !a));
  let rotation = v?.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? (v?.tags?.rotate ? Number(v.tags.rotate) : 0);
  rotation = ((Math.round(rotation) % 360) + 360) % 360;
  let w = v?.width;
  let h = v?.height;
  if (rotation === 90 || rotation === 270) [w, h] = [h, w];
  return {
    kind: v ? (isImage && v.codec_name !== 'gif' ? 'image' : 'video') : 'audio',
    dur: r2(dur, 3),
    w,
    h,
    fps: v ? r2(rate(v.avg_frame_rate) ?? rate(v.r_frame_rate) ?? 30, 3) : undefined,
    audio: !!a,
    vcodec: v?.codec_name,
    acodec: a?.codec_name,
    rotation: rotation || undefined,
  };
}

export interface FfmpegRun {
  args: string[];
  cwd?: string;
  signal?: AbortSignal;
  /** Total output frames, for progress callbacks. */
  frames?: number;
  durationSec?: number;
  onProgress?: (fraction: number) => void;
}

/** Run ffmpeg with progress parsing and concise error extraction. */
export async function ffmpeg(job: FfmpegRun): Promise<{ ms: number; log: string }> {
  const info = await ffmpegInfo();
  const opts: RunOptions = {
    cwd: job.cwd,
    signal: job.signal,
    maxBuffer: 512 * 1024,
    onLine: job.onProgress
      ? (line) => {
          const f = /frame=\s*(\d+)/.exec(line);
          if (f && job.frames) return job.onProgress!(Math.min(1, Number(f[1]) / job.frames));
          const t = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
          if (t && job.durationSec) job.onProgress!(Math.min(1, (Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3])) / job.durationSec));
        }
      : undefined,
  };
  const res = await run(info.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...job.args], opts);
  if (res.code !== 0) {
    const lines = res.stderr.split(/\r?\n/).filter((l) => l.trim() && !/^\s*(frame|size)=/.test(l));
    const key = [...lines].reverse().find((l) => /error|invalid|no such|failed|unable|not found|cannot|unknown/i.test(l)) ?? lines[lines.length - 1] ?? 'unknown error';
    throw new TmepError('E_FFMPEG_FAILED', key.trim().slice(0, 300), undefined, { tail: lines.slice(-25).join('\n'), args: job.args });
  }
  return { ms: res.ms, log: res.stderr };
}

export interface Silence {
  s: number;
  e: number;
}

/** Silence detection (FFmpeg silencedetect). Deterministic; cached by caller. */
export async function detectSilence(file: string, opts: { noiseDb?: number; minDur?: number } = {}): Promise<{ silences: Silence[]; dur: number }> {
  const noise = opts.noiseDb ?? -35;
  const d = opts.minDur ?? 0.35;
  const info = await ffmpegInfo();
  const res = await run(info.ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-map', '0:a:0', '-af', `silencedetect=noise=${noise}dB:d=${d}`, '-f', 'null', '-'], { maxBuffer: 8 * 1024 * 1024 });
  if (res.code !== 0) throw new TmepError('E_FFMPEG_FAILED', 'silencedetect failed', undefined, res.stderr.slice(-1500));
  const out: Silence[] = [];
  let start: number | undefined;
  for (const line of res.stderr.split(/\r?\n/)) {
    const a = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (a) start = Math.max(0, parseFloat(a[1]!));
    const b = /silence_end:\s*([\d.]+)/.exec(line);
    if (b && start !== undefined) {
      out.push({ s: r2(start, 3), e: r2(parseFloat(b[1]!), 3) });
      start = undefined;
    }
  }
  const durM = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(res.stderr);
  const dur = durM ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3]) : 0;
  if (start !== undefined) out.push({ s: r2(start, 3), e: r2(dur, 3) });
  return { silences: out, dur };
}

/** Integrated loudness / true peak via ebur128 summary. */
export async function measureLoudness(file: string): Promise<{ lufs: number; peak: number }> {
  const info = await ffmpegInfo();
  const res = await run(info.ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024 });
  const tail = res.stderr.slice(-3000);
  const i = /I:\s*(-?[\d.]+) LUFS/.exec(tail);
  const p = /Peak:\s*(-?[\d.]+) dBFS/.exec(tail);
  return { lufs: i ? parseFloat(i[1]!) : NaN, peak: p ? parseFloat(p[1]!) : NaN };
}

/** Extract 16 kHz mono PCM WAV for speech engines. */
export async function extractSpeechWav(file: string, out: string, signal?: AbortSignal): Promise<string> {
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await ffmpeg({ args: ['-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], signal });
  return out;
}
