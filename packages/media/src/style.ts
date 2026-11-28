/**
 * Reference style profile (Phase 6.4): what can be measured about a reference video, with the method
 * stated for each characteristic. Built on the footage analysis (shots, transitions, motion, camera,
 * OCR text geometry, subjects) plus FFmpeg signalstats for colour. Nothing is inferred about intent.
 */
import { run } from './exec.ts';
import { ffmpegInfo } from './ffmpeg.ts';
import type { FootageAnalysis } from './footage.ts';

export const STYLE_SCHEMA = 'frame.style/1';
export interface StyleProfile {
  schema: typeof STYLE_SCHEMA;
  pacing: { cutsPerMinute: number; medianShotSec: number; gradualShare: number };
  motion: { meanMotion: number; cameraMovingShare: number; cameraPanSpeed: number };
  colour?: { luma: number; saturation: number; contrast: number; warmth: number };
  audio?: { onsetsPerMinute: number; dynamicRangeDb: number };
  typography?: { textShare: number; position: 'upper' | 'middle' | 'lower'; medianHeight: number };
  composition?: { subjectX: number; subjectY: number; subjectArea: number };
  methods: Record<string, string>;
}

const med = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Mean luma / saturation / contrast and a warmth index (U/V balance) at 1 frame per second. */
export async function colourStats(file: string, maxSeconds = 120): Promise<StyleProfile['colour'] | undefined> {
  const { ffmpeg } = await ffmpegInfo();
  const r = await run(ffmpeg, ['-v', 'error', '-t', String(maxSeconds), '-i', file, '-an', '-vf', 'fps=1,scale=160:-2,signalstats,metadata=print:file=-', '-f', 'null', '-'], { timeoutMs: 300000, maxBuffer: 16 << 20 });
  if (r.code !== 0) return undefined;
  const get = (k: string) => [...r.stdout.matchAll(new RegExp(`lavfi\\.signalstats\\.${k}=([\\d.]+)`, 'g'))].map((m) => Number(m[1]));
  const y = get('YAVG'), sat = get('SATAVG'), lo = get('YLOW'), hi = get('YHIGH'), u = get('UAVG'), v = get('VAVG');
  if (!y.length) return undefined;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return { luma: r3(mean(y) / 255), saturation: r3(mean(sat) / 128), contrast: r3((mean(hi) - mean(lo)) / 255), warmth: r3((mean(v) - mean(u)) / 128) };
}

export function styleFromAnalysis(a: FootageAnalysis, colour?: StyleProfile['colour']): StyleProfile {
  const o = a.observed, dur = Math.max(1, a.asset.analyzedSeconds);
  const shots = o.shots.map((s) => s.t1 - s.t0);
  const cam = o.camera ?? [];
  const moving = cam.filter((c) => Math.abs(c.dx) + Math.abs(c.dy) > 0.02);
  // Audio onsets: windows ≥ 6 dB above the previous one and above the silence floor.
  const lv = o.audio;
  const onsets = lv.filter((v, i) => i > 0 && v - lv[i - 1]! >= 6 && v > -45).length;
  const sorted = [...lv].sort((x, y) => x - y);
  const text = o.text ?? [];
  const tGeom = text.filter((x) => x.y !== undefined);
  const subj = o.tracks?.find((t) => t.id === a.inferred.subjects?.primary);
  const methods: Record<string, string> = {
    pacing: 'shot boundaries (hard cuts + gradual transitions) from the footage base pass',
    motion: 'mean frame difference; camera motion from 32×18 shift matching at 2 Hz',
  };
  const p: StyleProfile = {
    schema: STYLE_SCHEMA,
    pacing: { cutsPerMinute: r3(((o.shots.length - 1) / dur) * 60), medianShotSec: r3(med(shots)), gradualShare: r3((o.transitions?.length ?? 0) / Math.max(1, o.shots.length - 1)) },
    motion: { meanMotion: r3(o.motion.reduce((x, y) => x + y, 0) / Math.max(1, o.motion.length)), cameraMovingShare: r3(moving.length / Math.max(1, cam.length)), cameraPanSpeed: r3(med(moving.map((c) => Math.hypot(c.dx, c.dy)))) },
    methods,
  };
  if (colour) { p.colour = colour; methods.colour = 'FFmpeg signalstats at 1 fps: YAVG, SATAVG, YHIGH−YLOW, VAVG−UAVG'; }
  if (lv.length) { p.audio = { onsetsPerMinute: r3((onsets / dur) * 60), dynamicRangeDb: r3((sorted[Math.floor(sorted.length * 0.95)] ?? 0) - (sorted[Math.floor(sorted.length * 0.1)] ?? 0)) }; methods.audio = '0.5 s RMS levels: rises ≥ 6 dB as onsets; 95th−10th percentile range'; }
  if (tGeom.length) {
    const y = med(tGeom.map((x) => x.y!));
    p.typography = { textShare: r3(text.length / Math.max(1, Math.round(dur))), position: y < 0.36 ? 'upper' : y > 0.64 ? 'lower' : 'middle', medianHeight: r3(med(tGeom.map((x) => x.h!))) };
    methods.typography = 'tesseract word boxes on sampled frames: share of seconds with text, median vertical centre and word height';
  }
  if (subj) {
    const bx = subj.boxes;
    p.composition = { subjectX: r3(med(bx.map((b) => b[1] + b[3] / 2))), subjectY: r3(med(bx.map((b) => b[2] + b[4] / 2))), subjectArea: subj.area };
    methods.composition = 'primary subject track (MediaPipe) median centre and area';
  }
  return p;
}
