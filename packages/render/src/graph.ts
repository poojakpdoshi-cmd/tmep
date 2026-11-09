/**
 * FFmpeg filter-graph builders. The agent never sees or writes these: they are derived
 * deterministically from the timeline.
 *
 * Video is rendered per "unit" (a run of clips joined by transitions; units split at
 * hard cuts). Each unit is an independent, content-hashed H.264 segment, so edits only
 * re-encode the units they touch, previews can render a subset, and interrupted renders
 * resume. Audio is mixed in one continuous pass (no AAC priming gaps at joins).
 */
import { type Timeline, type Placed, type Clip, type BRoll, type Effect, resolveRef } from '../../core/src/index.ts';
import { compileFx, compileOverlayFx } from './effects.ts';

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

/** Build ffmpeg args for one video unit. `assName` is relative to cwd (job dir). */
export function unitArgs(tl: Timeline, unit: Unit, media: Record<string, MediaRef>, enc: EncParams, placed: Placed[], out: string, assName: string | undefined, fontsDir: string | undefined, gfxOverlays: GfxOverlay[] = []): UnitArgs {
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
    const srcDur = (p.frames / fps) * c.speed;
    if (m.kind === 'image') inputs.push('-loop', '1', '-framerate', String(fps), '-t', n3(srcDur + 0.5), '-i', m.path);
    else if (m.kind === 'audio') inputs.push('-f', 'lavfi', '-t', n3(srcDur + 0.5), '-i', `color=c=${tl.settings.bg.replace('#', '0x')}:s=${W}x${H}:r=${fps}`);
    else inputs.push('-ss', n3(c.in), '-t', n3(srcDur + 0.5), '-i', m.path);
    const chain: string[] = ['setpts=PTS-STARTPTS'];
    if (c.speed !== 1) chain.push(`setpts=PTS/${n3(c.speed)}`);
    chain.push(`fps=${fps}`);
    chain.push(fitChain(c.fit, W, H, c.cx, c.cy, tl.settings.bg, `c${j}`));
    const z = zoomExpr(c, p.frames, fps);
    if (z) chain.push(perspective(z));
    const fx = compileFx(c, W, H, fps, tl.settings.bg, p.frames, `c${j}`);
    if (fx) chain.push(fx);
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
    g.push(`[${cur}][v${j}]xfade=transition=${p.clip.trans?.type ?? 'fade'}:duration=${n3(d)}:offset=${n3(off)}[x${j}]`);
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
    if (T >= U0 - 1e-6) fades.push(`fade=t=in:st=0:d=0.12:alpha=1`);
    if (T + b.d <= U1 + 1e-6) fades.push(`fade=t=out:st=${n3(Math.max(0, len - 0.12))}:d=0.12:alpha=1`);
    const overlayFx = compileOverlayFx(b.fx, W, H, fps, frames, `b${bi}`, s - T);
    const chain = [
      'setpts=PTS-STARTPTS',
      `fps=${fps}`,
      // Preserve original PNG alpha and transparent letterboxing for effected overlays.
      ...(b.fx?.length ? ['format=yuva420p'] : []),
      fitChain(b.fit, W, H, 0.5, 0.5, b.fx?.length ? 'black@0' : tl.settings.bg, `b${bi}`),
      ...(overlayFx ? [overlayFx] : []),
      'format=yuva420p',
      'tpad=stop_mode=clone:stop_duration=1',
      `trim=end_frame=${frames}`,
      ...fades,
      `setpts=PTS-STARTPTS+${n3(ls)}/TB`,
    ].join(',');
    g.push(`[${k}:v]${chain}[b${bi}]`);
    g.push(`[${cur}][b${bi}]overlay=eof_action=pass:enable='between(t,${n3(ls)},${n3(ls + len)})'[o${bi}]`);
    cur = `o${bi}`;
    k++;
  };
  // Independent ASS graphics preserve their own local animation time.
  // Each preset has local ASS timestamps, so a graphic spanning multiple video units
  // starts the next unit partway into its original animation instead of restarting.
  const drawGfx = (layer: GfxOverlay, gi: number) => {
    const s = Math.max(layer.at, U0);
    const e = Math.min(layer.at + layer.d, U1);
    if (e - s < 1 / fps) return;
    const ls = s - U0;
    const len = e - s;
    const frames = Math.round(len * fps);
    const offset = s - layer.at;
    const fd = fontsDir ? `:fontsdir=${fontsDir}` : '';
    const fx = compileOverlayFx(layer.fx, W, H, fps, frames, `g${gi}`, offset);
    const chain = [
      `color=c=black@0.0:s=${W}x${H}:r=${fps}:d=${n3(len + 0.5)}`,
      'format=rgba',
      `setpts=PTS-STARTPTS+${n3(offset)}/TB`,
      `subtitles=filename=${layer.file}${fd}:alpha=1`,
      'setpts=PTS-STARTPTS',
      ...(fx ? [fx] : []),
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

export interface AudioPlan {
  args: string[];
  graph: string;
}

/** One continuous audio pass: speech (with crossfades) + ducked music + SFX + loudness. */
export function audioArgs(tl: Timeline, placed: Placed[], media: Record<string, MediaRef>, sfx: { file: string; t: number; vol: number }[], totalFrames: number, out: string, range?: { s: number; e: number }): AudioPlan {
  const fps = tl.settings.fps;
  const total = totalFrames / fps;
  const inputs: string[] = [];
  const g: string[] = [];
  let k = 0;
  const labels: string[] = [];
  placed.forEach((p, j) => {
    const c = p.clip;
    const m = media[c.src]!;
    const D = p.frames / fps;
    const srcDur = D * c.speed;
    if (m.kind !== 'image' && m.audio && !c.mute) {
      inputs.push('-ss', n3(c.in), '-t', n3(srcDur + 0.3), '-i', m.path);
      const chain = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'asetpts=PTS-STARTPTS'];
      let sp = c.speed;
      while (sp > 2.0) {
        chain.push('atempo=2.0');
        sp /= 2;
      }
      while (sp < 0.5) {
        chain.push('atempo=0.5');
        sp /= 0.5;
      }
      if (Math.abs(sp - 1) > 1e-6) chain.push(`atempo=${n3(sp)}`);
      if (c.vol !== 1) chain.push(`volume=${n3(c.vol)}`);
      chain.push(`atrim=duration=${n3(D)}`, `apad=whole_dur=${n3(D)}`, 'afade=t=in:d=0.012', `afade=t=out:st=${n3(Math.max(0, D - 0.015))}:d=0.015`);
      g.push(`[${k}:a]${chain.join(',')}[a${j}]`);
      k++;
    } else g.push(`aevalsrc=0:s=48000:c=stereo:d=${n3(D)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${j}]`);
    labels.push(`a${j}`);
  });
  let cur = labels[0]!;
  for (let j = 1; j < placed.length; j++) {
    const p = placed[j]!;
    if (p.transFrames > 0) g.push(`[${cur}][a${j}]acrossfade=d=${n3(p.transFrames / fps)}:c1=tri:c2=tri[ax${j}]`);
    else g.push(`[${cur}][a${j}]concat=n=2:v=0:a=1[ax${j}]`);
    cur = `ax${j}`;
  }
  const mix: string[] = [];
  if (tl.music) {
    const m = media[tl.music.src];
    if (m && (m.kind === 'audio' || m.audio)) {
      inputs.push('-stream_loop', '-1', '-i', m.path);
      const f = Math.min(tl.music.fade, total / 3);
      g.push(`[${k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${n3(total)},asetpts=PTS-STARTPTS,volume=${n3(tl.music.vol)}dB,afade=t=in:d=${n3(f)},afade=t=out:st=${n3(Math.max(0, total - f))}:d=${n3(f)}[mus]`);
      k++;
      if (tl.music.duck) {
        g.push(`[${cur}]asplit=2[sp][sc]`);
        g.push('[mus][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=380:makeup=1[musd]');
        cur = 'sp';
        mix.push('musd');
      } else mix.push('mus');
    }
  }
  sfx.forEach((s, i) => {
    if (s.t < 0 || s.t >= total) return;
    inputs.push('-i', s.file);
    const d = Math.round(s.t * 1000);
    g.push(`[${k}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${d}|${d},volume=${n3(s.vol)}dB[sx${i}]`);
    mix.push(`sx${i}`);
    k++;
  });
  let master = cur;
  if (mix.length) {
    g.push(`[${cur}]${mix.map((x) => `[${x}]`).join('')}amix=inputs=${mix.length + 1}:duration=first:dropout_transition=0:normalize=0[mix]`);
    master = 'mix';
  }
  const post: string[] = [];
  if (tl.loudness < 0) post.push(`loudnorm=I=${tl.loudness}:TP=-1.5:LRA=11`, 'aresample=48000');
  if (range) post.push(`atrim=start=${n3(range.s)}:end=${n3(range.e)}`, 'asetpts=PTS-STARTPTS');
  const len = range ? range.e - range.s : total;
  post.push(`apad=whole_dur=${n3(len)}`, `atrim=duration=${n3(len)}`);
  g.push(`[${master}]${post.join(',')}[aout]`);
  const graph = g.join(';');
  return { args: [...inputs, '-filter_complex', graph, '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', out], graph };
}
