/**
 * Professional Colour Pipeline (Stage 3.3).
 *
 * Deterministic FFmpeg filter compilation for:
 *  - Input colour-space detection & conversion to BT.709
 *  - Exposure, contrast, white balance (temperature), tint
 *  - Saturation, vibrance, highlights, shadows, RGB curves
 *  - .cube 3D LUTs (path-validated by caller) and vignette
 *  - Deterministic shot-matching assistance via FFmpeg signalstats
 */
import type { ColorGrade } from '../../core/src/index.ts';
import { run } from '../../media/src/exec.ts';
import { ffmpegInfo, probe } from '../../media/src/ffmpeg.ts';

const n3 = (x: number) => String(Math.round(x * 1000) / 1000);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface ColorSpaceInfo {
  colorSpace?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
  pixFmt?: string;
  isHdr: boolean;
}

/** Detect input colour space via ffprobe stream metadata. */
export async function detectColorSpace(filePath: string): Promise<ColorSpaceInfo> {
  const { ffprobe: bin } = await ffmpegInfo();
  const res = await run(bin, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=color_space,color_primaries,color_transfer,pix_fmt',
    '-of', 'json', filePath,
  ]);
  const parsed = JSON.parse(res.stdout || '{}') as { streams?: Record<string, string>[] };
  const s = parsed.streams?.[0] ?? {};
  const trc = s.color_transfer?.toLowerCase();
  const isHdr = trc === 'smpte2084' || trc === 'arib-std-b67';
  return {
    colorSpace: s.color_space,
    colorPrimaries: s.color_primaries,
    colorTransfer: s.color_transfer,
    pixFmt: s.pix_fmt,
    isHdr,
  };
}

/** Build FFmpeg video filter chain for a ColorGrade. Returns undefined if no filters are needed. */
export function colorFilterChain(grade: ColorGrade | undefined, detectedCS?: string): string | undefined {
  if (!grade) return undefined;
  const f: string[] = [];

  const cs = grade.inputColorSpace && grade.inputColorSpace !== 'auto' ? grade.inputColorSpace : detectedCS;
  if (cs === 'bt601' || cs === 'smpte170m' || cs === 'bt470bg') {
    f.push('colorspace=all=bt709:iall=bt601-6-625:fast=1');
  } else if (cs === 'bt2020' || cs === 'bt2020nc') {
    f.push('colorspace=all=bt709:iall=bt2020:fast=1');
  } else if (cs === 'hlg' || cs === 'pq') {
    f.push('colorspace=all=bt709:iall=bt2020:trc=bt709:fast=1');
  }

  // Exposure, contrast, saturation
  const eqParts: string[] = [];
  if (grade.exposure !== undefined && grade.exposure !== 0) {
    eqParts.push(`brightness=${n3(clamp(grade.exposure * 0.15, -1, 1))}`);
  }
  if (grade.contrast !== undefined && grade.contrast !== 1) {
    eqParts.push(`contrast=${n3(clamp(grade.contrast, 0.2, 3))}`);
  }
  if (grade.saturation !== undefined && grade.saturation !== 1) {
    eqParts.push(`saturation=${n3(clamp(grade.saturation, 0, 3))}`);
  }
  if (eqParts.length) f.push(`eq=${eqParts.join(':')}`);

  // White balance (temperature in Kelvin, neutral ~6500K)
  if (grade.temp !== undefined && Math.abs(grade.temp - 6500) > 10) {
    f.push(`colortemperature=temperature=${Math.round(clamp(grade.temp, 2000, 15000))}`);
  }

  // Green-magenta tint
  if (grade.tint !== undefined && grade.tint !== 0) {
    const g = clamp(grade.tint * 0.25, -0.5, 0.5);
    f.push(`colorbalance=gm=${n3(g)}:gh=${n3(g * 0.5)}:gs=${n3(g * 0.5)}`);
  }

  // Vibrance
  if (grade.vibrance !== undefined && grade.vibrance !== 0) {
    f.push(`vibrance=intensity=${n3(clamp(grade.vibrance, -1, 1))}`);
  }

  // Shadows / highlights / RGB curves
  const curveParts: string[] = [];
  if (grade.curves?.master) curveParts.push(`master='${grade.curves.master}'`);
  else if (grade.shadows || grade.highlights) {
    const sh = clamp(0.25 + (grade.shadows ?? 0) * 0.12, 0.05, 0.45);
    const hi = clamp(0.75 + (grade.highlights ?? 0) * 0.12, 0.55, 0.95);
    curveParts.push(`master='0/0 0.25/${n3(sh)} 0.75/${n3(hi)} 1/1'`);
  }
  if (grade.curves?.r) curveParts.push(`r='${grade.curves.r}'`);
  if (grade.curves?.g) curveParts.push(`g='${grade.curves.g}'`);
  if (grade.curves?.b) curveParts.push(`b='${grade.curves.b}'`);
  if (curveParts.length) f.push(`curves=${curveParts.join(':')}`);

  // .cube 3D LUT
  if (grade.lut) {
    const esc = grade.lut.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    f.push(`lut3d=file='${esc}':interp=trilinear`);
  }

  // Vignette
  if (grade.vignette !== undefined && grade.vignette > 0) {
    const angle = clamp(grade.vignette * 0.65, 0.05, Math.PI / 2);
    f.push(`vignette=angle=${n3(angle)}:mode=forward`);
  }

  return f.length ? f.join(',') : undefined;
}

export interface LumaStats {
  yAvg: number;
  yLow: number;
  yHigh: number;
  uAvg: number;
  vAvg: number;
  satAvg: number;
}

/** Sample deterministic frame statistics via FFmpeg signalstats. */
export async function measureSignalStats(filePath: string, sampleSec = 1.0): Promise<LumaStats> {
  const { ffmpeg: bin } = await ffmpegInfo();
  const pr = await probe(filePath);
  const ss = Math.min(Math.max(0, pr.dur * 0.3), sampleSec);
  const res = await run(bin, [
    '-v', 'info', '-ss', n3(ss), '-i', filePath,
    '-frames:v', '5', '-vf', 'signalstats,metadata=mode=print:file=-',
    '-f', 'null', '-',
  ]);
  const text = `${res.stdout}\n${res.stderr}`;
  const avgOf = (key: string, fallback: number): number => {
    const matches = [...text.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.-]+)`, 'g'))].map((m) => Number(m[1]));
    if (!matches.length) return fallback;
    return matches.reduce((a, b) => a + b, 0) / matches.length;
  };
  return {
    yAvg: avgOf('YAVG', 128),
    yLow: avgOf('YLOW', 16),
    yHigh: avgOf('YHIGH', 235),
    uAvg: avgOf('UAVG', 128),
    vAvg: avgOf('VAVG', 128),
    satAvg: avgOf('SATAVG', 40),
  };
}

/** Compute deterministic ColorGrade adjustments to match `targetPath` to `refPath`. */
export async function computeShotMatch(refPath: string, targetPath: string): Promise<{ grade: ColorGrade; refStats: LumaStats; targetStats: LumaStats }> {
  const [refStats, targetStats] = await Promise.all([measureSignalStats(refPath), measureSignalStats(targetPath)]);
  const exposure = clamp((refStats.yAvg - targetStats.yAvg) / 128, -1.2, 1.2);
  const refRange = Math.max(20, refStats.yHigh - refStats.yLow);
  const tgtRange = Math.max(20, targetStats.yHigh - targetStats.yLow);
  const contrast = clamp(refRange / tgtRange, 0.7, 1.5);
  const saturation = clamp(refStats.satAvg / Math.max(8, targetStats.satAvg), 0.7, 1.5);
  // V channel > 128 is warmer (red), < 128 is cooler (blue)
  const vDelta = refStats.vAvg - targetStats.vAvg;
  const temp = Math.round(clamp(6500 + vDelta * 45, 3500, 10000));
  const grade: ColorGrade = {
    ...(Math.abs(exposure) > 0.03 ? { exposure: Math.round(exposure * 100) / 100 } : {}),
    ...(Math.abs(contrast - 1) > 0.03 ? { contrast: Math.round(contrast * 100) / 100 } : {}),
    ...(Math.abs(saturation - 1) > 0.04 ? { saturation: Math.round(saturation * 100) / 100 } : {}),
    ...(Math.abs(temp - 6500) > 150 ? { temp } : {}),
  };
  return { grade, refStats, targetStats };
}

export const BT709_OUTPUT_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'] as const;
