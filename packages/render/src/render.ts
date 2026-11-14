/**
 * Render orchestration: compile graphics, render content-hashed video units (in
 * parallel, cached, resumable), mix audio in bounded stages (see audio.ts), concat + mux with
 * stream copy, then
 * verify the output with ffprobe. Progress and cancellation go through RenderHooks.
 */
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import {
  type Timeline,
  type Project,
  type Word,
  TmepError,
  layout,
  timelineWords,
  totalFrames,
  resolveRef,
  hashOf,
  exists,
  r2,
  sha256,
  toPosix,
} from '../../core/src/index.ts';
import { ffmpeg, ffmpegInfo, probe } from '../../media/src/ffmpeg.ts';
import { compileAss } from '../../motion/src/compile.ts';
import { stageFonts } from '../../motion/src/fonts.ts';
import { planUnits, unitArgs, outSize, type MediaRef, type EncParams, type Unit } from './graph.ts';
import { renderAudio, AUDIO_VERSION, type AudioStats } from './audio.ts';
import { pool, tmpFor, publish, maybeScript } from './stage.ts';
import { sfxFile } from './sfx.ts';
import { ownerTag } from './recovery.ts';

export { publish };

export const RENDERER_VERSION = 'r1';

export type Quality = 'draft' | 'standard' | 'high';

export interface RenderOptions {
  preview?: boolean;
  /** Timeline range to render (segment preview). Unit-granular: may extend to cut points. */
  range?: [number, number];
  quality?: Quality;
  out?: string;
  /** Export only the graphics/captions layer with alpha (ProRes 4444 .mov or VP9 .webm). */
  alpha?: boolean;
  parallel?: number;
  encoder?: 'auto' | 'libx264' | 'h264_nvenc' | 'h264_qsv' | 'h264_videotoolbox';
}

export interface RenderHooks {
  signal?: AbortSignal;
  onProgress?: (p: number, phase: string) => void;
}

export interface RenderResult {
  out: string;
  dur: number;
  w: number;
  h: number;
  fps: number;
  units: number;
  unitsCached: number;
  audioCached: boolean;
  /** Stems the audio mix was built from, and how many were reused from the cache (absent when the mix itself was cached). */
  audioStems?: number;
  audioStemsCached?: number;
  cacheHit: boolean;
  ms: number;
  span?: [number, number];
  verified: { dur: number; w: number; h: number; audio: boolean };
}

const ENC: Record<Quality, { preset: string; crf: number }> = {
  draft: { preset: 'ultrafast', crf: 28 },
  standard: { preset: 'veryfast', crf: 19 },
  high: { preset: 'slow', crf: 17 },
};

async function pickEncoder(want: RenderOptions['encoder']): Promise<string> {
  const info = await ffmpegInfo();
  if (want && want !== 'auto') {
    if (!info.encoders.has(want)) throw new TmepError('E_FFMPEG_MISSING', `encoder ${want} not available in this ffmpeg build`);
    return want;
  }
  if (!info.encoders.has('libx264')) throw new TmepError('E_FFMPEG_MISSING', 'libx264 encoder not available', 'install a GPL FFmpeg build');
  return 'libx264'; // hardware encoders are opt-in: quality/availability vary per machine
}

async function mediaMap(project: Project, tl: Timeline): Promise<Record<string, MediaRef>> {
  const ids = new Set([...tl.clips.map((c) => c.src), ...tl.broll.map((b) => b.src), ...(tl.music ? [tl.music.src] : [])]);
  const out: Record<string, MediaRef> = {};
  for (const id of ids) {
    const a = await project.asset(id);
    if (!(await exists(a.path))) throw new TmepError('E_NOT_FOUND', `media for ${id} is missing: ${a.path}`, 're-import the file (same content keeps the same ID)');
    out[id] = { path: a.path, kind: a.kind, hash: a.hash, audio: a.audio, dur: a.dur };
  }
  return out;
}

/** Filter ASS dialogue lines overlapping a time window (for unit hashing). */
function assWindow(ass: string, s: number, e: number): string {
  const head = ass.slice(0, ass.indexOf('[Events]'));
  const toSec = (t: string) => {
    const [h, m, x] = t.split(':');
    return Number(h) * 3600 + Number(m) * 60 + Number(x);
  };
  const lines = ass.split('\n').filter((l) => {
    if (!l.startsWith('Dialogue:')) return false;
    const parts = l.split(',', 3);
    return toSec(parts[1]!) < e && toSec(parts[2]!) > s;
  });
  return head + lines.join('\n');
}

const validVideo = async (f: string) => {
  const v = await probe(f);
  return v.dur > 0 && (v.w ?? 0) > 0;
};
const validAudio = async (f: string) => {
  const v = await probe(f);
  return v.dur > 0 && v.audio;
};

/**
 * Per-project render queue (in-process). Renders of the same project run one at a time:
 * they share content-addressed unit/audio cache entries, so a second render simply reuses
 * what the first produced instead of racing it. Different projects are not serialized.
 * Across processes, safety comes from per-attempt temp names + atomic publish (see publish()).
 */
const projectQueues = new Map<string, Promise<void>>();

async function exclusive<T>(key: string, signal: AbortSignal | undefined, onQueued: () => void, fn: () => Promise<T>): Promise<T> {
  const prev = projectQueues.get(key);
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = (prev ?? Promise.resolve()).then(() => mine);
  projectQueues.set(key, tail);
  try {
    if (prev) {
      onQueued();
      await prev;
    }
    if (signal?.aborted) throw new TmepError('E_CANCELLED', 'render cancelled while queued');
    return await fn();
  } finally {
    release();
    if (projectQueues.get(key) === tail) projectQueues.delete(key);
  }
}

export async function renderTimeline(project: Project, tl: Timeline, transcripts: Record<string, Word[] | undefined>, opts: RenderOptions = {}, hooks: RenderHooks = {}): Promise<RenderResult> {
  return exclusive(path.resolve(project.dir), hooks.signal, () => hooks.onProgress?.(0, 'queued'), () =>
    withWorkDir(project, (work) => renderUnlocked(project, tl, transcripts, opts, hooks, work)),
  );
}

/**
 * Private working directory for ONE render attempt. ASS files, staged fonts, filter-graph
 * scripts and concat lists are written here and nowhere else, so renders in other processes
 * never read, overwrite or lock each other's work files (previously all renders of the same
 * graphics shared `.tmep/work/ass-<hash>/`). Output does not depend on the directory name:
 * ffmpeg runs with `cwd` set to it and every file is referenced by a fixed relative name.
 * The directory is removed when the render finishes, fails or is cancelled.
 */
async function withWorkDir<T>(project: Project, fn: (work: string) => Promise<T>): Promise<T> {
  const work = project.workPath(`render-${ownerTag()}-${randomBytes(6).toString('hex')}`);
  await fsp.mkdir(work, { recursive: true });
  try {
    return await fn(work);
  } finally {
    // maxRetries: Windows can briefly keep a handle on files a just-exited ffmpeg used
    await fsp.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

async function renderUnlocked(project: Project, tl: Timeline, transcripts: Record<string, Word[] | undefined>, opts: RenderOptions, hooks: RenderHooks, work: string): Promise<RenderResult> {
  const t0 = Date.now();
  if (!tl.clips.length) throw new TmepError('E_STATE', 'timeline has no clips');
  const info = await ffmpegInfo();
  for (const f of ['subtitles', 'xfade', 'perspective', 'loudnorm', 'sidechaincompress', 'amix', 'acrossfade', 'asetnsamples', 'adelay', 'apad', 'atrim']) {
    if (!info.filters.has(f)) throw new TmepError('E_FFMPEG_MISSING', `ffmpeg lacks filter "${f}"`, 'use a full FFmpeg build with libass (gyan.dev full / BtbN GPL)');
  }
  const quality: Quality = opts.quality ?? (opts.preview ? 'draft' : 'standard');
  const enc: EncParams = { vcodec: await pickEncoder(opts.encoder), ...ENC[quality], scale: opts.preview ? 0.5 : 1 };
  const fps = tl.settings.fps;
  const placed = layout(tl);
  const frames = totalFrames(tl);
  const media = await mediaMap(project, tl);
  const words = timelineWords(tl, transcripts, placed);
  const compiled = compileAss(tl, words, placed);
  const { W, H } = outSize(tl, enc.scale);
  const progress = hooks.onProgress ?? (() => {});

  // per-render working dir (ASS + fonts referenced by relative names: avoids filtergraph path escaping on Windows)
  await fsp.writeFile(path.join(work, 'gfx.ass'), compiled.ass);
  // The separate ASS overlays use stable generated filenames, not user-provided ids.
  const overlays = compiled.layers.map((g, i) => ({ file: `gfx-fx-${i}.ass`, at: g.at, d: g.d, fx: g.fx, ...(g.z !== undefined ? { z: g.z } : {}) }));
  await Promise.all(compiled.layers.map((g, i) => fsp.writeFile(path.join(work, overlays[i]!.file), g.ass)));
  const hasFonts = compiled.fonts.some((f) => f.file);
  if (hasFonts) stageFonts(compiled.fonts, work);
  const fontKey = compiled.fonts.map((f) => (f.file ? path.basename(f.file) : f.name)).join('|');

  const baseName = opts.out ? path.basename(opts.out).replace(/\.[^.]+$/, '') : `render-${Date.now().toString(36)}`;

  // ---- alpha graphics-only export ----
  if (opts.alpha) {
    if (compiled.layers.length) {
      throw new TmepError('E_INPUT', 'alpha-only export of effects on graphics is not supported yet', 'render normally, or remove fx from graphics before --alpha');
    }
    const prores = info.encoders.has('prores_ks');
    const ext = prores ? 'mov' : 'webm';
    const out = opts.out ? path.resolve(opts.out) : project.rendersPath(`${baseName}-overlay.${ext}`);
    const dur = frames / fps;
    progress(0.05, 'overlay');
    await ffmpeg({
      cwd: work,
      args: [
        '-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H}:r=${fps}:d=${(dur + 0.1).toFixed(3)},format=rgba`,
        '-vf', `subtitles=filename=gfx.ass${hasFonts ? ':fontsdir=fonts' : ''}:alpha=1`,
        '-frames:v', String(frames),
        ...(prores ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le'] : ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30']),
        out,
      ],
      frames,
      signal: hooks.signal,
      onProgress: (p) => progress(0.05 + p * 0.9, 'overlay'),
    });
    const v = await probe(out);
    progress(1, 'done');
    return { out, dur: r2(dur, 3), w: W, h: H, fps, units: 0, unitsCached: 0, audioCached: false, cacheHit: false, ms: Date.now() - t0, verified: { dur: v.dur, w: v.w ?? 0, h: v.h ?? 0, audio: v.audio } };
  }

  // ---- units ----
  let units = planUnits(placed);
  let span: [number, number] | undefined;
  if (opts.range) {
    const [a, b] = opts.range;
    units = units.filter((u) => u.startFrame / fps < b && (u.startFrame + u.frames) / fps > a);
    if (!units.length) throw new TmepError('E_RANGE', `range ${a}-${b} is outside the timeline (0-${r2(frames / fps)})`);
    span = [units[0]!.startFrame / fps, (units[units.length - 1]!.startFrame + units[units.length - 1]!.frames) / fps];
  }
  const unitDir = project.cachePath('units');
  await fsp.mkdir(unitDir, { recursive: true });
  const unitHash = (u: Unit) =>
    hashOf({
      v: RENDERER_VERSION,
      s: tl.settings,
      enc,
      start: u.startFrame,
      frames: u.frames,
      clips: u.clips.map((p) => ({ c: { ...p.clip, id: undefined }, h: media[p.clip.src]!.hash, f: p.frames, t: p.transFrames, sf: p.startFrame - u.startFrame })),
      broll: tl.broll
        .map((b) => ({ b: { ...b, id: undefined, ref: undefined }, T: resolveRef(placed, b.ref), h: media[b.src]?.hash }))
        .filter((x) => x.T !== undefined && x.T < (u.startFrame + u.frames) / fps && x.T + x.b.d > u.startFrame / fps)
        .map((x) => ({ ...x, T: r2(x.T! - u.startFrame / fps, 4) })),
      ass: sha256(assWindow(compiled.ass, u.startFrame / fps, (u.startFrame + u.frames) / fps)),
      ...(compiled.layers.length ? {
        gfxFx: compiled.layers
          .filter((g) => g.at < (u.startFrame + u.frames) / fps && g.at + g.d > u.startFrame / fps)
          .map((g) => ({ at: r2(g.at - u.startFrame / fps, 4), d: g.d, ass: sha256(g.ass), fx: g.fx, z: g.z ?? 10 })),
      } : {}),
      fonts: fontKey,
    });
  const hashes = units.map(unitHash);
  const unitFiles = hashes.map((h) => path.join(unitDir, `${h}.mp4`));
  let cachedUnits = 0;
  const todo: number[] = [];
  for (let i = 0; i < units.length; i++) {
    if (await exists(unitFiles[i]!)) cachedUnits++;
    else todo.push(i);
  }

  // ---- audio ----
  const sfxDir = project.cachePath('sfx');
  const sfxList: { file: string; t: number; vol: number }[] = [];
  for (const s of tl.sfx) {
    const t = resolveRef(placed, s.ref);
    if (t === undefined) continue;
    sfxList.push({ file: await sfxFile(sfxDir, s.kind), t, vol: s.vol });
  }
  const audioRange = span ? { s: span[0], e: span[1] } : undefined;
  const audioHash = hashOf({
    v: RENDERER_VERSION,
    a: AUDIO_VERSION,
    fps,
    clips: placed.map((p) => ({ src: media[p.clip.src]!.hash, in: p.clip.in, sp: p.clip.speed, f: p.frames, t: p.transFrames, vol: p.clip.vol, m: p.clip.mute })),
    music: tl.music ? { ...tl.music, h: media[tl.music.src]?.hash } : null,
    sfx: sfxList.map((s) => [path.basename(s.file), r2(s.t, 3), s.vol]),
    lufs: tl.loudness,
    range: audioRange ?? null,
  });
  const audioFile = project.cachePath('audio', `${audioHash}.m4a`);
  const audioCached = await exists(audioFile);

  const finalKey = hashOf({ hashes, audioHash });
  const outPath = opts.out ? path.resolve(opts.out) : project.rendersPath(`${baseName}${opts.preview ? '-preview' : ''}.mp4`);
  const markerFile = `${outPath}.tmep`;
  if ((await exists(outPath)) && (await fsp.readFile(markerFile, 'utf8').catch(() => '')) === finalKey) {
    const v = await probe(outPath);
    progress(1, 'cached');
    return { out: outPath, dur: v.dur, w: W, h: H, fps, units: units.length, unitsCached: units.length, audioCached: true, cacheHit: true, ms: Date.now() - t0, span, verified: { dur: v.dur, w: v.w ?? 0, h: v.h ?? 0, audio: v.audio } };
  }

  const totalWork = todo.reduce((a, i) => a + units[i]!.frames, 0) + 1;
  const done = new Map<number, number>();
  const report = () => progress(Math.min(0.95, ([...done.values()].reduce((a, b) => a + b, 0) / totalWork) * 0.92), 'video');
  const par = opts.parallel ?? (os.cpus().length >= 8 ? 3 : os.cpus().length >= 4 ? 2 : 1);

  // One controller for every ffmpeg child of this render: the first failure (or a caller
  // cancel) aborts the siblings. Temporary files are tracked and removed in `finally`.
  const ctrl = new AbortController();
  const onCallerAbort = () => ctrl.abort();
  if (hooks.signal?.aborted) ctrl.abort();
  hooks.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const temps = new Set<string>();
  let audioStats: AudioStats | undefined;
  let failure: unknown;
  const isCancel = (e: unknown) => e instanceof TmepError && e.code === 'E_CANCELLED';
  const fail = (e: unknown) => {
    // keep the root cause: sibling processes killed by our own abort report E_CANCELLED
    if (failure === undefined || (isCancel(failure) && !isCancel(e))) failure = e;
    ctrl.abort();
  };

  try {
    // started first and handled immediately: a failed audio mix can never become an
    // unhandled rejection while video units are still rendering
    const audioTask = (async () => {
      if (audioCached) return;
      await fsp.mkdir(path.dirname(audioFile), { recursive: true });
      const tmp = tmpFor(audioFile, '.m4a');
      temps.add(tmp);
      // stems in bounded processes, then one final pass: no command grows with the timeline
      audioStats = await renderAudio({ tl, placed, media, sfx: sfxList, frames, ...(audioRange ? { range: audioRange } : {}), out: tmp, stemDir: project.cachePath('audio', 'stems'), work, signal: ctrl.signal, temps });
      await publish(tmp, audioFile, validAudio);
      temps.delete(tmp);
    })().catch(fail);

    await pool(
      todo,
      par,
      async (i) => {
        const u = units[i]!;
        const tmp = tmpFor(unitFiles[i]!, '.mp4');
        temps.add(tmp);
        const { args } = unitArgs(tl, u, media, enc, placed, tmp, compiled.events ? 'gfx.ass' : undefined, hasFonts ? 'fonts' : undefined, overlays);
        await ffmpeg({
          args: await maybeScript(args, work),
          cwd: work,
          frames: u.frames,
          signal: ctrl.signal,
          onProgress: (p) => {
            done.set(i, p * u.frames);
            report();
          },
        });
        await publish(tmp, unitFiles[i]!, validVideo);
        temps.delete(tmp);
        done.set(i, u.frames);
        report();
      },
      () => ctrl.signal.aborted,
      fail,
    );
    await audioTask;
    if (failure === undefined && ctrl.signal.aborted) failure = new TmepError('E_CANCELLED', 'render cancelled');
    if (failure !== undefined) throw failure;

    // ---- concat + mux (stream copy) ----
    progress(0.96, 'mux');
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    const list = tmpFor(path.join(work, `concat-${finalKey}`), '.txt');
    temps.add(list);
    await fsp.writeFile(list, unitFiles.map((f) => `file '${toPosix(f).replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const tmpOut = tmpFor(outPath, '.mp4');
    temps.add(tmpOut);
    await ffmpeg({ args: ['-f', 'concat', '-safe', '0', '-i', list, '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', tmpOut], signal: ctrl.signal });
    await fsp.rename(tmpOut, outPath);
    temps.delete(tmpOut);
    await fsp.writeFile(markerFile, finalKey);
  } finally {
    hooks.signal?.removeEventListener('abort', onCallerAbort);
    await Promise.all([...temps].map((f) => fsp.rm(f, { force: true }).catch(() => {})));
  }

  // ---- verify ----
  const v = await probe(outPath);
  const expect = span ? span[1] - span[0] : frames / fps;
  if (Math.abs(v.dur - expect) > 2 / fps + 0.06 || v.w !== W || v.h !== H || !v.audio) {
    throw new TmepError('E_INTERNAL', `output verification failed: got ${v.dur}s ${v.w}x${v.h} audio=${v.audio}, expected ${r2(expect, 3)}s ${W}x${H}`);
  }
  progress(1, 'done');
  return {
    out: outPath,
    dur: r2(expect, 3),
    w: W,
    h: H,
    fps,
    units: units.length,
    unitsCached: cachedUnits,
    audioCached,
    ...(audioStats ? { audioStems: audioStats.stems, audioStemsCached: audioStats.stemsCached } : {}),
    cacheHit: false,
    ms: Date.now() - t0,
    span: span ? [r2(span[0], 3), r2(span[1], 3)] : undefined,
    verified: { dur: v.dur, w: v.w ?? 0, h: v.h ?? 0, audio: v.audio },
  };
}

/** Extract a few frames as a contact sheet (for agents that can view images). */
export async function contactSheet(video: string, out: string, n = 4, width = 270): Promise<string> {
  const v = await probe(video);
  const total = Math.max(1, Math.floor(v.dur * (v.fps ?? 30)));
  const sel = Array.from({ length: n }, (_, i) => `eq(n,${Math.floor(((i + 1) * total) / (n + 1))})`).join('+');
  await ffmpeg({ args: ['-i', video, '-vf', `select='${sel}',scale=${width}:-2,tile=${n}x1`, '-frames:v', '1', '-update', '1', out] });
  return out;
}
