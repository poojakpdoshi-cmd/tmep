/**
 * FRAME Inspector (Stage 3.6) — Automated Technical Quality Checks.
 *
 * Distinguishes objective technical defects (`defect`) from subjective creative
 * choices (`advisory`), and NEVER automatically overrides explicit user creative
 * instructions.
 */
import {
  type Timeline, type TlWord, type FxMask, type Asset,
  layout, duration, totalFrames,
} from '../../core/src/index.ts';
import { ffmpegInfo, probe } from '../../media/src/ffmpeg.ts';
import { run } from '../../media/src/exec.ts';
import { diagnoseScenes } from '../../motion/src/scene.ts';

export type QaSeverity = 'defect' | 'advisory';

export interface QaFinding {
  code:
    | 'audio-clipping'
    | 'loudness-inconsistency'
    | 'av-sync'
    | 'transition-boundary'
    | 'dropped-or-duplicated-frames'
    | 'invalid-mask'
    | 'text-overflow'
    | 'composition-collision'
    | 'safe-zone-violation'
    | 'colour-clipping'
    | 'unexpected-black'
    | 'unexpected-silence'
    | 'timing-inaccuracy';
  severity: QaSeverity;
  msg: string;
  detail?: Record<string, unknown>;
}

export interface QaReport {
  ok: boolean;
  defects: number;
  advisories: number;
  findings: QaFinding[];
  metrics: {
    expectedDur: number;
    videoDur?: number;
    audioDur?: number;
    maxVolumeDb?: number;
    integratedLufs?: number;
    truePeakDbtp?: number;
    lra?: number;
    yMin?: number;
    yMax?: number;
    blackSegments?: number;
    silentSegments?: number;
    fpsMismatch?: boolean;
  };
}

export interface InspectOptions {
  renderedPath?: string;
  targetLufs?: number;
  safeZonePlatform?: 'reels' | 'shorts' | 'tiktok' | 'youtube' | 'square' | 'default';
  assets?: Map<string, Asset>;
}

export async function runInspector(tl: Timeline, words: TlWord[], opts: InspectOptions = {}): Promise<QaReport> {
  const findings: QaFinding[] = [];
  const fps = tl.settings.fps;
  const placed = layout(tl);
  const expectedDur = duration(tl);
  const metrics: QaReport['metrics'] = { expectedDur };

  // 1. Timeline timing & transition boundary checks
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i]!;
    const c = p.clip;
    if (c.out <= c.in || c.speed <= 0) {
      findings.push({ code: 'timing-inaccuracy', severity: 'defect', msg: `clip ${c.id} has invalid range/speed (${c.in}..${c.out}, speed=${c.speed})` });
    }
    if (i > 0 && c.trans && c.trans.d > 0) {
      const want = Math.round(c.trans.d * fps);
      if (p.transFrames < want) {
        findings.push({
          code: 'transition-boundary',
          severity: 'advisory',
          msg: `clip ${c.id} transition clamped from ${want}f to ${p.transFrames}f to fit adjacent clip lengths`,
        });
      }
    }
    for (const fx of c.fx ?? []) {
      if (fx.type === 'kf') {
        for (let k = 1; k < fx.keys.length; k++) {
          if (fx.keys[k]!.t < fx.keys[k - 1]!.t) {
            findings.push({ code: 'timing-inaccuracy', severity: 'defect', msg: `clip ${c.id} has unsorted keyframe times` });
          }
        }
      } else if (fx.type === 'mask') {
        checkMask(fx, c.id, findings);
      }
    }
  }
  for (const b of tl.broll) {
    for (const fx of b.fx ?? []) {
      if (fx.type === 'mask') checkMask(fx, b.id, findings);
    }
  }

  // 2. Scene safe-zone, text overflow, and composition collision checks
  if (tl.scenes?.length) {
    const diag = diagnoseScenes(tl, words, opts.assets ?? new Map());
    for (const issue of diag.issues) {
      if (issue.code === 'safe-area') {
        findings.push({ code: 'safe-zone-violation', severity: 'defect', msg: `scene ${issue.scene}: ${issue.msg}` });
      } else if (issue.code === 'collision') {
        findings.push({ code: 'composition-collision', severity: 'defect', msg: `scene ${issue.scene}: ${issue.msg}` });
      } else if (issue.code === 'clipping' || issue.code === 'caption') {
        findings.push({ code: 'text-overflow', severity: 'advisory', msg: `scene ${issue.scene}: ${issue.msg}` });
      }
    }
  }

  // 3. Rendered file checks (if renderedPath provided)
  if (opts.renderedPath) {
    const pr = await probe(opts.renderedPath);
    metrics.videoDur = pr.dur;
    const { ffmpeg: bin, ffprobe: pbin } = await ffmpegInfo();

    // Stream durations & frame rate consistency
    const streamRes = await run(pbin, [
      '-v', 'error', '-show_entries', 'stream=codec_type,duration,r_frame_rate,avg_frame_rate,nb_frames',
      '-of', 'json', opts.renderedPath,
    ]);
    const sJson = JSON.parse(streamRes.stdout || '{}') as { streams?: Record<string, string>[] };
    const vStream = sJson.streams?.find((s) => s.codec_type === 'video');
    const aStream = sJson.streams?.find((s) => s.codec_type === 'audio');
    const vDur = vStream?.duration ? Number(vStream.duration) : pr.dur;
    const aDur = aStream?.duration ? Number(aStream.duration) : undefined;
    metrics.videoDur = vDur;
    if (aDur !== undefined) metrics.audioDur = aDur;

    const frameTol = Math.max(0.05, 1.5 / fps);
    if (Math.abs(vDur - expectedDur) > frameTol) {
      findings.push({
        code: 'av-sync',
        severity: 'defect',
        msg: `video duration ${vDur.toFixed(3)}s differs from timeline ${expectedDur.toFixed(3)}s`,
      });
    }
    if (aDur !== undefined && Math.abs(aDur - vDur) > frameTol) {
      findings.push({
        code: 'av-sync',
        severity: 'defect',
        msg: `audio duration ${aDur.toFixed(3)}s drifts from video ${vDur.toFixed(3)}s`,
      });
    }
    if (vStream?.nb_frames && Math.abs(Number(vStream.nb_frames) - totalFrames(tl)) > 2) {
      metrics.fpsMismatch = true;
      findings.push({
        code: 'dropped-or-duplicated-frames',
        severity: 'defect',
        msg: `rendered frame count ${vStream.nb_frames} != expected ${totalFrames(tl)}`,
      });
    }

    // Audio clipping, loudness, silence
    if (aStream) {
      const targetLufs = opts.targetLufs ?? (tl.master?.lufs ?? tl.loudness);
      const aRes = await run(bin, [
        '-v', 'info', '-i', opts.renderedPath, '-vn',
        '-af', `volumedetect,loudnorm=I=${targetLufs < 0 ? targetLufs : -14}:TP=-1.0:LRA=11:print_format=json,silencedetect=noise=-50dB:d=1.5`,
        '-f', 'null', '-',
      ]);
      const aText = `${aRes.stdout}\n${aRes.stderr}`;
      const maxVolMatch = /max_volume:\s*([-\d.]+)\s*dB/.exec(aText);
      if (maxVolMatch) {
        const maxDb = Number(maxVolMatch[1]);
        metrics.maxVolumeDb = maxDb;
        if (maxDb >= -0.2) {
          findings.push({ code: 'audio-clipping', severity: 'defect', msg: `audio peak ${maxDb} dBFS risks clipping (>= -0.2 dBFS)` });
        }
      }
      const lnMatch = /\{[\s\S]*?"input_i"[\s\S]*?\}/.exec(aText);
      if (lnMatch) {
        const ln = JSON.parse(lnMatch[0]) as { input_i: string; input_tp: string; input_lra: string };
        const lufs = Number(ln.input_i);
        const tp = Number(ln.input_tp);
        const lra = Number(ln.input_lra);
        metrics.integratedLufs = lufs;
        metrics.truePeakDbtp = tp;
        metrics.lra = lra;
        if (tp > -0.5) {
          findings.push({ code: 'audio-clipping', severity: 'defect', msg: `true peak ${tp.toFixed(2)} dBTP exceeds -0.5 dBTP ceiling` });
        }
        if (targetLufs < 0 && Number.isFinite(lufs) && Math.abs(lufs - targetLufs) > 2.5) {
          findings.push({
            code: 'loudness-inconsistency',
            severity: 'advisory',
            msg: `integrated loudness ${lufs.toFixed(1)} LUFS differs from target ${targetLufs} LUFS by > 2.5 LU`,
          });
        }
      }
      const silMatches = [...aText.matchAll(/silence_duration:\s*([\d.]+)/g)];
      metrics.silentSegments = silMatches.length;
      if (silMatches.length > 0 && pr.dur > 2) {
        const totalSil = silMatches.reduce((a, m) => a + Number(m[1]), 0);
        if (totalSil > pr.dur * 0.6) {
          findings.push({ code: 'unexpected-silence', severity: 'advisory', msg: `${silMatches.length} silent segments totaling ${totalSil.toFixed(1)}s` });
        }
      }
    }

    // Video blackdetect + colour clipping
    const vRes = await run(bin, [
      '-v', 'info', '-i', opts.renderedPath, '-an',
      '-vf', 'blackdetect=d=0.5:pic_th=0.98,signalstats,metadata=mode=print:file=-',
      '-f', 'null', '-',
    ]);
    const vText = `${vRes.stdout}\n${vRes.stderr}`;
    const blackMatches = [...vText.matchAll(/black_duration:\s*([\d.]+)/g)];
    metrics.blackSegments = blackMatches.length;
    if (blackMatches.length > 0) {
      findings.push({ code: 'unexpected-black', severity: 'advisory', msg: `${blackMatches.length} black segment(s) >= 0.5s detected` });
    }
    const yMins = [...vText.matchAll(/lavfi\.signalstats\.YMIN=([\d.]+)/g)].map((m) => Number(m[1]));
    const yMaxs = [...vText.matchAll(/lavfi\.signalstats\.YMAX=([\d.]+)/g)].map((m) => Number(m[1]));
    if (yMins.length) metrics.yMin = Math.min(...yMins);
    if (yMaxs.length) metrics.yMax = Math.max(...yMaxs);
    if (metrics.yMin !== undefined && metrics.yMin < 4 && metrics.yMax !== undefined && metrics.yMax > 253) {
      findings.push({ code: 'colour-clipping', severity: 'advisory', msg: `full-range luma extremes detected (YMIN=${metrics.yMin}, YMAX=${metrics.yMax})` });
    }
  }

  const defects = findings.filter((f) => f.severity === 'defect').length;
  const advisories = findings.filter((f) => f.severity === 'advisory').length;
  return { ok: defects === 0, defects, advisories, findings, metrics };
}

function checkMask(m: FxMask, ownerId: string, findings: QaFinding[]): void {
  if ((m.shape === 'rect' || m.shape === 'ellipse') && (!(m.w > 0) || !(m.h > 0))) {
    findings.push({ code: 'invalid-mask', severity: 'defect', msg: `${ownerId} mask has non-positive dimensions` });
  }
  if (m.feather < 0 || m.feather > 0.5) {
    findings.push({ code: 'invalid-mask', severity: 'defect', msg: `${ownerId} mask feather ${m.feather} out of [0, 0.5]` });
  }
  if (m.shape === 'bezier' && (!m.bezierStart || !m.beziers || m.beziers.length < 2)) {
    findings.push({ code: 'invalid-mask', severity: 'defect', msg: `${ownerId} bezier mask lacks start/segments` });
  }
}
