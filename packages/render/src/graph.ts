/**
 * FFmpeg filter-graph builders. The agent never sees or writes these: they are derived
 * deterministically from the timeline.
 *
 * Video is rendered per "unit" (a run of clips joined by transitions; units split at
 * hard cuts). Each unit is an independent, content-hashed H.264 segment, so edits only
 * re-encode the units they touch, previews can render a subset, and interrupted renders
 * resume. Audio is built separately, in bounded stages, and muxed in at the end (audio.ts).
 */
import path from 'node:path';
import { type Timeline, type Placed, type Clip, type BRoll, type Effect, type FxMask, type FxBlend, resolveRef, sampleSpeedRamp } from '../../core/src/index.ts';
import { compileFx, compileOverlayFx, transformFilter } from './effects.ts';
import { colorFilterChain } from './color.ts';

export interface MediaRef {
  path: string;
  kind: 'video' | 'audio' | 'image';
  hash: string;
  audio: boolean;
  dur: number;
}

export interface EncParams {
  vcodec: string;
  preset: string;
  crf: number;
  scale: number;
}

export interface Unit {
  idx: number;
  clips: Placed[];
  startFrame: number;
  frames: number;
}

/** Compiled standalone ASS preset with independent compositing effects. */
export interface GfxOverlay {
  file: string;
  at: number;
  d: number;
  fx: Effect[];
  /** Explicit compositing order. Defaults to 10 for graphics. */
  z?: number;
  camera?: Effect[];
  /** Directory of a pre-rasterized transparent PNG sequence (00000.png…) starting at `at`, used instead of `file`. */
  seq?: string;
}

const n3 = (x: number) => String(Math.round(x * 1000) / 1000);
const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);

export function planUnits(placed: Placed[]): Unit[] {
  const units: Unit[] = [];
  for (const p of placed) {
    const last = units[units.length - 1];
    if (last && p.transFrames > 0) {
      last.clips.push(p);
      last.frames = p.startFrame + p.frames - last.startFrame;
    } else units.push({ idx: units.length, clips: [p], startFrame: p.startFrame, frames: p.frames });
  }
  return units;
}

export function outSize(tl: Timeline, scale: number): { W: number; H: number } {
  return { W: even(tl.settings.w * scale), H: even(tl.settings.h * scale) };
}

/** Fit any source into W x H. */
function fitChain(fit: Clip['fit'], W: number, H: number, cx: number, cy: number, bg: string, id: string): string {
  if (fit === 'contain') return `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg.replace('#', '0x')},setsar=1`;
  if (fit === 'blur') {
    const bw = even(W / 4);
    const bh = even(H / 4);
    return `split=2[bg0${id}][fg0${id}];[bg0${id}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=8:2,eq=brightness=-0.06:saturation=1.1,scale=${W}:${H}[bg1${id}];[fg0${id}]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg1${id}];[bg1${id}][fg1${id}]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  }
  return `scale=${W}:${H}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${W}:${H}:(iw-${W})*${n3(cx)}:(ih-${H})*${n3(cy)},setsar=1`;
}

/**
 * Per-frame zoom factor expression (variable `in` = frame index within the clip).
 * Combines static base scale, slow push-in and anchored zoom envelopes (max-combined).
 */
export function zoomExpr(c: Clip, frames: number, fps: number): string | undefined {
  const parts: string[] = [];
  const ts = `(${n3(c.in)}+in*${n3(c.speed)}/${fps})`;
  for (const z of c.zoom) {
    const amt = z.to - 1;
    if (amt <= 0) continue;
    if (z.mode === 'smooth') {
      const x = `clip((${ts}-${n3(z.s)})/${n3(Math.max(0.1, z.d))},0,1)`;
      parts.push(`${n3(amt)}*(${x})*(${x})*(3-2*(${x}))`);
    } else {
      const up = `clip((${ts}-${n3(z.s)})/0.12,0,1)`;
      const down = `clip((${n3(z.s + z.d + 0.28)}-${ts})/0.28,0,1)`;
      parts.push(`${n3(amt)}*min(${up},${down})`);
    }
  }
  let env = '';
  if (parts.length) env = parts.reduce((a, b) => `max(${a},${b})`);
  const base = c.base !== 1 ? n3(c.base) : '';
  const push = c.push > 0 ? `(1+${n3(c.push)}*in/${Math.max(1, frames)})` : '';
  if (!env && !base && !push) return undefined;
  return [base, push, env ? `(1+${env})` : ''].filter(Boolean).join('*');
}

function perspective(z: string, fy = 0.45): string {
  const Z = `(${z})`;
  const x0 = `W/2*(1-1/${Z})`;
  const y0 = `H*${fy}*(1-1/${Z})`;
  const x1 = `${x0}+W/${Z}`;
  const y1 = `${y0}+H/${Z}`;
  return `perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y0}':x2='${x0}':y2='${y1}':x3='${x1}':y3='${y1}':interpolation=linear:eval=frame`;
}

export interface UnitArgs {
  args: string[];
  graph: string;
}

/** Build piecewise setpts expression for a variable speed ramp. */
function speedRampPtsExpr(c: Clip): string {
  const keys = c.speedRamp!;
  const srcDur = Math.max(0.01, c.out - c.in);
  const segs = 16;
  const du = srcDur / segs;
  let outT = 0;
  const pts: { srcT: number; outT: number }[] = [{ srcT: 0, outT: 0 }];
  for (let i = 0; i < segs; i++) {
    const s = Math.max(0.1, sampleSpeedRamp(keys, (i + 0.5) * du));
    outT += du / s;
    pts.push({ srcT: (i + 1) * du, outT });
  }
  let expr = `${n3(pts[pts.length - 1]!.outT)}/TB`;
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const slope = (b.outT - a.outT) / Math.max(1e-6, b.srcT - a.srcT);
    const segExpr = `(${n3(a.outT)}+(T-${n3(a.srcT)})*${n3(slope)})/TB`;
    expr = i === 0 ? segExpr : `if(lt(T,${n3(b.srcT)}),${segExpr},${expr})`;
  }
  return `setpts='${expr}'`;
}

/** Build ffmpeg args for one video unit. `assName` is relative to cwd (job dir). */
export function unitArgs(tl: Timeline, unit: Unit, media: Record<string, MediaRef>, enc: EncParams, placed: Placed[], out: string, assName: string | undefined, fontsDir: string | undefined, gfxOverlays: GfxOverlay[] = [], maskFiles?: Map<FxMask, string>): UnitArgs {
  const fps = tl.settings.fps;
  const { W, H } = outSize(tl, enc.scale);
  const inputs: string[] = [];
  const g: string[] = [];
  let k = 0;
  const U0 = unit.startFrame / fps;
  const U1 = (unit.startFrame + unit.frames) / fps;
  unit.clips.forEach((p, j) => {
    const c = p.clip;
    const m = media[c.src]!;
    const isFreeze = c.freeze !== undefined && c.freeze > 0;
    const srcDur = isFreeze ? (2 / fps) : (c.speedRamp?.length ? Math.max(0.1, c.out - c.in) : (p.frames / fps) * c.speed);
    if (m.kind === 'image') inputs.push('-loop', '1', '-framerate', String(fps), '-t', n3(srcDur + 0.5), '-i', m.path);
    else if (m.kind === 'audio') inputs.push('-f', 'lavfi', '-t', n3(srcDur + 0.5), '-i', `color=c=${tl.settings.bg.replace('#', '0x')}:s=${W}x${H}:r=${fps}`);
    else inputs.push('-ss', n3(c.in), '-t', n3(isFreeze ? Math.max(0.2, 2 / fps) : srcDur + 0.5), '-i', m.path);
    const chain: string[] = ['setpts=PTS-STARTPTS'];
    if (isFreeze) {
      chain.push(`trim=end_frame=1`, 'loop=loop=-1:size=1', `setpts=N/(${fps}*TB)`);
    } else {
      if (c.reverse && m.kind === 'video') {
        chain.push(`trim=duration=${n3(srcDur)}`, 'reverse', 'setpts=PTS-STARTPTS');
      }
      if (c.speedRamp?.length) chain.push(speedRampPtsExpr(c));
      else if (c.speed !== 1) chain.push(`setpts=PTS/${n3(c.speed)}`);
      chain.push(`fps=${fps}`);
    }
    if (c.stabilize && m.kind === 'video' && !isFreeze) {
      const rx = Math.min(64, Math.max(16, Math.round(((c.stabilize.shakiness ?? 5) * 4) / 16) * 16));
      chain.push(`deshake=rx=${rx}:ry=${rx}:edge=clamp`);
    }
    chain.push(fitChain(c.fit, W, H, c.cx, c.cy, tl.settings.bg, `c${j}`));
    const z = zoomExpr(c, p.frames, fps);
    if (z) chain.push(perspective(z));
    const fx = compileFx(c, W, H, fps, tl.settings.bg, p.frames, `c${j}`, maskFiles);
    if (fx) chain.push(fx);
    const clipCol = colorFilterChain(c.color);
    if (clipCol) chain.push(clipCol);
    const globalCol = colorFilterChain(tl.color);
    if (globalCol) chain.push(globalCol);
    chain.push('format=yuv420p', 'tpad=stop_mode=clone:stop_duration=1', `trim=end_frame=${p.frames}`, 'setpts=PTS-STARTPTS');
    const body = chain.join(',');
    g.push(`[${k}:v]${body}[v${j}]`);
    k++;
  });
  let cur = 'v0';
  for (let j = 1; j < unit.clips.length; j++) {
    const p = unit.clips[j]!;
    const off = (p.startFrame - unit.startFrame) / fps;
    const d = p.transFrames / fps;
    const rawTr = p.clip.trans?.type ?? 'fade';
    const tr = rawTr === 'luma' ? 'fadegrays' : rawTr;
    g.push(`[${cur}][v${j}]xfade=transition=${tr}:duration=${n3(d)}:offset=${n3(off)}[x${j}]`);
    cur = `x${j}`;
  }
  // Render in explicit z-order (low to high). Legacy defaults: b-roll 0,
  // independent graphics 10, then shared ASS captions and plain graphics above all.
  const drawBroll = (b: BRoll, bi: number) => {
    const T = resolveRef(placed, b.ref);
    if (T === undefined) return;
    const s = Math.max(T, U0);
    const e = Math.min(T + b.d, U1);
    if (e - s < 1 / fps) return;
    const m = media[b.src];
    if (!m) return;
    const ls = s - U0;
    const len = e - s;
    const frames = Math.round(len * fps);
    if (m.kind === 'image') inputs.push('-loop', '1', '-framerate', String(fps), '-t', n3(len + 0.5), '-i', m.path);
    else inputs.push('-ss', n3(b.in + (s - T)), '-t', n3(len + 0.5), '-i', m.path);
    const fades: string[] = [];
    if (!b.scene && T >= U0 - 1e-6) fades.push(`fade=t=in:st=0:d=0.12:alpha=1`);
    if (!b.scene && T + b.d <= U1 + 1e-6) fades.push(`fade=t=out:st=${n3(Math.max(0, len - 0.12))}:d=0.12:alpha=1`);
    const overlayFx = compileOverlayFx(b.fx, W, H, fps, frames, `b${bi}`, s - T, maskFiles);
    const sw = b.scene && even(W * b.scene.w), sh = b.scene && even(H * b.scene.h);
    const sceneFit = sw && sh ? [`scale=${sw}:${sh}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`, 'setsar=1'] : undefined;
    const camera = b.scene?.camera && transformFilter(b.scene.camera, W, H, fps, 'black', s - T, true);
    const chain = [
      'setpts=PTS-STARTPTS',
      `fps=${fps}`,
      // Preserve original PNG alpha and transparent letterboxing for effected overlays.
      ...(b.scene || b.fx?.length ? ['format=yuva420p'] : []),
      ...(sceneFit ?? [fitChain(b.fit, W, H, 0.5, 0.5, b.fx?.length ? 'black@0' : tl.settings.bg, `b${bi}`)]),
      ...(overlayFx ? [overlayFx] : []),
      ...(camera ? [camera] : []),
      'format=yuva420p',
      'tpad=stop_mode=clone:stop_duration=1',
      `trim=end_frame=${frames}`,
      ...fades,
      `setpts=PTS-STARTPTS+${n3(ls)}/TB`,
    ].join(',');
    g.push(`[${k}:v]${chain}[b${bi}]`);
    const blendFx = b.fx?.find((f): f is FxBlend => f.type === 'blend');
    if (blendFx && blendFx.mode !== 'normal') {
      const opVal = blendFx.opacity !== undefined ? `:all_opacity=${n3(blendFx.opacity)}` : '';
      g.push(`[${cur}]format=yuva420p[bg${bi}];[bg${bi}][b${bi}]blend=all_mode=${blendFx.mode}${opVal}:enable='between(t,${n3(ls)},${n3(ls + len)})'[o${bi}]`);
    } else {
      g.push(`[${cur}][b${bi}]overlay=eof_action=pass:enable='between(t,${n3(ls)},${n3(ls + len)})'[o${bi}]`);
    }
    cur = `o${bi}`;
    k++;
  };
  // Independent ASS graphics preserve their own local animation time.
  // Each preset has local ASS timestamps, so a graphic spanning multiple video units
  // starts the next unit partway into its original animation instead of restarting.
  const drawGfx = (layer: GfxOverlay, gi: number) => {
    if (layer.seq) {
      // Frame-exact in integer frames: the sequence frame is selected by index, placed with an
      // integer PTS offset (its time base is 1/fps) and gated half a frame wide of its edges.
      const first = Math.round(layer.at * fps), sF = Math.max(first, unit.startFrame);
      const n = Math.min(first + Math.round(layer.d * fps), unit.startFrame + unit.frames) - sF;
      if (n < 1) return;
      const lsF = sF - unit.startFrame;
      inputs.push('-framerate', String(fps), '-start_number', String(sF - first), '-i', path.join(layer.seq.replace(/%/g, '%%'), '%05d.png'));
      g.push(`[${k}:v]setpts=PTS-STARTPTS,format=yuva420p,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${n},setpts=PTS-STARTPTS+${lsF}[gfx${gi}]`);
      g.push(`[${cur}][gfx${gi}]overlay=eof_action=pass:enable='between(t,${n3((lsF - .5) / fps)},${n3((lsF + n - .5) / fps)})'[gc${gi}]`);
      cur = `gc${gi}`;
      k++;
      return;
    }
    const s = Math.max(layer.at, U0);
    const e = Math.min(layer.at + layer.d, U1);
    if (e - s < 1 / fps) return;
    const ls = s - U0;
    const len = e - s;
    const frames = Math.round(len * fps);
    const offset = s - layer.at;
    const fd = fontsDir ? `:fontsdir=${fontsDir}` : '';
    const fx = compileOverlayFx(layer.fx, W, H, fps, frames, `g${gi}`, offset, maskFiles);
    const camera = layer.camera && transformFilter(layer.camera, W, H, fps, 'black', offset, true);
    const chain = [
      `color=c=black@0.0:s=${W}x${H}:r=${fps}:d=${n3(len + 0.5)}`,
      'format=rgba',
      `setpts=PTS-STARTPTS+${n3(offset)}/TB`,
      `subtitles=filename=${layer.file}${fd}:alpha=1`,
      'setpts=PTS-STARTPTS',
      ...(fx ? [fx] : []),
      ...(camera ? [camera] : []),
      'format=yuva420p',
      'tpad=stop_mode=clone:stop_duration=1',
      `trim=end_frame=${frames}`,
      `setpts=PTS-STARTPTS+${n3(ls)}/TB`,
    ].join(',');
    g.push(`${chain}[gfx${gi}]`);
    g.push(`[${cur}][gfx${gi}]overlay=eof_action=pass:enable='between(t,${n3(ls)},${n3(ls + len)})'[gc${gi}]`);
    cur = `gc${gi}`;
  };
  const layers = [
    ...tl.broll.map((b, bi) => ({ kind: 'broll' as const, z: b.z ?? 0, order: bi, b, bi })),
    ...gfxOverlays.map((layer, gi) => ({ kind: 'gfx' as const, z: layer.z ?? 10, order: tl.broll.length + gi, layer, gi })),
  ].sort((a, b) => a.z - b.z || a.order - b.order);
  for (const layer of layers) {
    if (layer.kind === 'broll') drawBroll(layer.b, layer.bi);
    else drawGfx(layer.layer, layer.gi);
  }
  if (assName) {
    const fd = fontsDir ? `:fontsdir=${fontsDir}` : '';
    g.push(`[${cur}]setpts=PTS-STARTPTS+${n3(U0)}/TB,subtitles=filename=${assName}${fd},setpts=PTS-STARTPTS,format=yuv420p[vout]`);
  } else g.push(`[${cur}]format=yuv420p[vout]`);
  const graph = g.join(';');
  const args = [
    ...inputs,
    '-filter_complex',
    graph,
    '-map',
    '[vout]',
    '-frames:v',
    String(unit.frames),
    '-r',
    String(fps),
    ...encoderArgs(enc, fps),
    '-an',
    out,
  ];
  return { args, graph };
}

export function encoderArgs(enc: EncParams, fps: number): string[] {
  const common = ['-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-video_track_timescale', String(fps * 1000)];
  if (enc.vcodec === 'libx264') return ['-c:v', 'libx264', '-preset', enc.preset, '-crf', String(enc.crf), '-profile:v', 'high', '-g', String(fps * 2), '-bf', '2', ...common];
  // hardware encoders: constant-quality where supported
  if (enc.vcodec === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(enc.crf + 2), '-b:v', '0', '-g', String(fps * 2), ...common];
  if (enc.vcodec === 'h264_qsv') return ['-c:v', 'h264_qsv', '-global_quality', String(enc.crf + 2), '-g', String(fps * 2), ...common];
  if (enc.vcodec === 'h264_videotoolbox') return ['-c:v', 'h264_videotoolbox', '-q:v', '60', '-g', String(fps * 2), ...common];
  return ['-c:v', enc.vcodec, ...common];
}
