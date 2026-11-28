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
  type FxMask,
  type Effect,
  type Placed,
  readJsonOr,
  writeJson,
  TmepError,
  layout,
  timelineWords,
  totalFrames,
  resolveRef,
  hashOf,
  mediaHash,
  exists,
  r2,
  sha256,
  toPosix,
} from '../../core/src/index.ts';
import { rasterizeComplexMaskPng, rasterizeComplexMaskSequence, maskAnimated } from './effects.ts';
import { BT709_OUTPUT_TAGS, detectColorSpace } from './color.ts';
import { ffmpeg, ffmpegInfo, probe } from '../../media/src/ffmpeg.ts';
import { run } from '../../media/src/exec.ts';
import { compileAss } from '../../motion/src/compile.ts';
import { compileScenes, type SceneGraphic } from '../../motion/src/scene.ts';
import { rasterIdentity, rasterizeVectorRun, VECTOR_VERSION } from '../../motion/src/vector.ts';
import { stageFonts } from '../../motion/src/fonts.ts';
import { planUnits, unitArgs, outSize, type MediaRef, type EncParams, type Unit } from './graph.ts';
import { renderAudio, clipAudio, AUDIO_VERSION, type AudioStats } from './audio.ts';
import { pool, tmpFor, publish, maybeScript } from './stage.ts';
import { sfxFile } from './sfx.ts';
import { ownerTag } from './recovery.ts';

export { publish };

// r2 (Phase 4 Stage 4.0): speed-ramp video map, directional blur, zscale colour conversion,
// animated mask sequences. Bumped so cached units rendered with the old filters are not reused.
export const RENDERER_VERSION = 'r2';

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
    const st = await fsp.stat(a.path);
    let hash = a.hash;
    const addedMs = Date.parse(a.added);
    // Re-hash only when file size changed or mtime advanced past import time
    if (st.size !== a.size || (Number.isFinite(addedMs) && st.mtimeMs > addedMs + 1000)) {
      const fresh = mediaHash(a.path);
      if (fresh !== a.hash) {
        hash = fresh;
        await project.updateAsset(id, { hash: fresh, size: st.size }).catch(() => {});
      }
    }
    let colorSpace: string | undefined;
    if (a.kind === 'video') {
      const cs = await detectColorSpace(a.path).catch(() => undefined);
      const trc = cs?.colorTransfer?.toLowerCase();
      colorSpace = trc === 'smpte2084' ? 'pq' : trc === 'arib-std-b67' ? 'hlg' : cs?.colorSpace?.toLowerCase();
    }
    out[id] = { path: a.path, kind: a.kind, hash, audio: a.audio, dur: a.dur, ...(colorSpace ? { colorSpace } : {}) };
  }
  return out;
}

/** Filter ASS dialogue lines overlapping a time window (for unit hashing). */
function assWindow(ass: string, s: number, e: number): string {
  const evIdx = ass.indexOf('[Events]');
  const head = evIdx >= 0 ? ass.slice(0, evIdx) : ass;
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

/** Integrated (gated) loudness of a source range, LUFS; -70 for silence. */
async function measureLoudness(file: string, t0: number, t1: number): Promise<number> {
  const { ffmpeg: bin } = await ffmpegInfo();
  const r = await run(bin, ['-hide_banner', '-nostats', '-ss', String(t0), '-t', String(Math.max(0.1, t1 - t0)), '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { timeoutMs: 300000 });
  const m = /I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(r.stderr) ?? [...r.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
  return m ? Number(m[1]) : -70;
}

/**
 * Gain staging for compressed dialogue: compressor thresholds are absolute, so a quiet recording
 * (e.g. -34 LUFS) was never compressed. Each compressed clip is measured once (cached by media hash
 * and range) and raised so speech reaches about -20 LUFS before the chain (0..+18 dB). Hot sources are
 * never attenuated: that would take them out of the compressor's range and turn the requested
 * compression into a no-op (caught by the effect matrix). Silent ranges are left alone.
 */
async function stageDialogueGain(project: Project, placed: Placed[], media: Record<string, MediaRef>): Promise<void> {
  for (const p of placed) {
    const c = p.clip;
    const m = media[c.src];
    if (!c.audio?.comp || !m?.audio || m.kind === 'image' || c.mute) continue;
    const file = project.cachePath('gain', `${hashOf({ v: 1, h: m.hash, in: c.in, out: c.out })}.json`);
    let lufs = (await readJsonOr<{ lufs: number } | undefined>(file, undefined))?.lufs;
    if (lufs === undefined) {
      lufs = await measureLoudness(m.path, c.in, c.out);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await writeJson(file, { lufs }, false);
    }
    if (lufs <= -60) continue;
    const gain = Math.max(0, Math.min(18, -20 - lufs));
    if (gain >= 1) c.audio = { ...c.audio, preGainDb: Math.round(gain * 10) / 10 };
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
  const enc: EncParams = { vcodec: await pickEncoder(opts.encoder), ...ENC[quality], scale: opts.preview ? 0.5 : 1, zscale: (await ffmpegInfo()).filters.has('zscale') };
  const fps = tl.settings.fps;
  const placed = layout(tl);
  const frames = totalFrames(tl);
  const words = timelineWords(tl, transcripts, placed);
  const scenes = tl.scenes?.length ? compileScenes(tl, words, new Map((await project.assets()).map((a) => [a.id, a]))) : undefined;
  if (scenes?.media.length) tl = { ...tl, broll: [...tl.broll, ...scenes.media] };
  const media = await mediaMap(project, tl);
  await stageDialogueGain(project, placed, media);
  const compiled = compileAss(tl, words, placed);
  const { W, H } = outSize(tl, enc.scale);
  const progress = hooks.onProgress ?? (() => {});

  // per-render working dir (ASS + fonts referenced by relative names: avoids filtergraph path escaping on Windows)
  await fsp.writeFile(path.join(work, 'gfx.ass'), compiled.ass);
  // Use generated filenames for independent ASS overlays.
  const layers: (Omit<SceneGraphic, 'z'> & { z?: number })[] = [...compiled.layers, ...(scenes?.layers ?? [])];
  const overlays = layers.map(({ ass, id, ...g }, i) => ({ ...g, file: `gfx-fx-${i}.ass` }));
  await Promise.all(layers.map((g, i) => fsp.writeFile(path.join(work, overlays[i]!.file), g.ass)));
  // Path layers become content-addressed transparent frame sequences at the output size,
  // rasterized below only when an uncached unit needs them.
  const vectors = (scenes?.vectors ?? []).map((run) => {
    const key = hashOf({ v: VECTOR_VERSION, W, H, run: rasterIdentity(run) });
    return { run, key, overlay: { file: '', at: run.at, d: run.d, fx: [], z: run.z, seq: project.cachePath('vectors', key) } };
  });
  const gfxOverlays = [...overlays, ...vectors.map((v) => v.overlay)];
  const fonts = [...compiled.fonts, ...(scenes?.fonts ?? [])];
  const hasFonts = fonts.some((f) => f.file);
  if (hasFonts) stageFonts(fonts, work);
  const fontKey = fonts.map((f) => (f.file ? path.basename(f.file) : f.name)).join('|');

  const baseName = opts.out ? path.basename(opts.out).replace(/\.[^.]+$/, '') : `render-${Date.now().toString(36)}`;

  // ---- alpha graphics-only export ----
  if (opts.alpha) {
    if (scenes) throw new TmepError('E_INPUT', 'Visual Scenes require normal composited export');
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
  if (scenes) {
    const intervals = [
      ...scenes.layers.map(({ at, d }) => ({ at, d })),
      ...scenes.media.map(({ ref, d }) => ({ at: ref.at!, d })),
      ...scenes.vectors.map(({ at, d }) => ({ at, d })),
    ];
    for (const unit of units) {
      // Compiled scene geometry already lies on the frame grid. Compare integer
      // boundaries so adjacent storyboard scenes cannot count as overlapping.
      const end = unit.startFrame + unit.frames;
      if (intervals.filter(({ at, d }) => {
        const first = Math.round(at * fps);
        return first < end && first + Math.round(d * fps) > unit.startFrame;
      }).length > 16) {
        throw new TmepError('E_INPUT', 'a video render unit supports at most 16 Visual Scene layers', 'reduce layers or place scenes in separate video units');
      }
    }
  }
  // In integer frames, matching the frame-exact placement of path runs in graph.ts.
  const overlaps = (g: { at: number; frames: number }, u: Unit) => {
    const first = Math.round(g.at * fps);
    return first < u.startFrame + u.frames && first + g.frames > u.startFrame;
  };
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
      ...(layers.length || vectors.length ? {
        gfxFx: [
          ...layers
            .filter((g) => g.at < (u.startFrame + u.frames) / fps && g.at + g.d > u.startFrame / fps)
            .map((g) => ({ at: r2(g.at - u.startFrame / fps, 4), d: g.d, ass: sha256(g.ass), fx: g.fx, z: g.z ?? 10, ...(g.camera && { camera: g.camera }) })),
          ...vectors
            .filter(({ run }) => overlaps(run, u))
            .map(({ run, key }) => ({ at: r2(run.at - u.startFrame / fps, 4), d: run.d, vec: key, z: run.z })),
        ],
      } : {}),
      fonts: fontKey,
    });
  const hashes = units.map(unitHash);
  const unitFiles = hashes.map((h) => path.join(unitDir, `${h}.mp4`));
  let cachedUnits = 0;
  const todo: number[] = [];
  for (let i = 0; i < units.length; i++) {
    if ((await exists(unitFiles[i]!)) && (await validVideo(unitFiles[i]!))) cachedUnits++;
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
    // The per-clip audio hash covers everything the mixer reads for a clip (media, range, speed,
    // ramp, reverse, J/L offsets, per-clip post, volume/mute, length and crossfade). Keying the
    // final mix on anything less served a stale mix after audio-only edits.
    clips: clipAudio(placed, media, fps).map((c) => c.hash),
    master: tl.master ?? null,
    music: tl.music ? { ...tl.music, h: media[tl.music.src]?.hash } : null,
    sfx: sfxList.map((s) => [path.basename(s.file), r2(s.t, 3), s.vol]),
    lufs: tl.loudness,
    range: audioRange ?? null,
  });
  const audioFile = project.cachePath('audio', `${audioHash}.m4a`);
  const audioCached = (await exists(audioFile)) && (await validAudio(audioFile));

  const finalKey = hashOf({ hashes, audioHash });
  const outPath = opts.out ? path.resolve(opts.out) : project.rendersPath(`${baseName}${opts.preview ? '-preview' : ''}.mp4`);
  const markerFile = `${outPath}.tmep`;
  const expect = span ? span[1] - span[0] : frames / fps;
  const verifyOutput = async (file: string) => {
    const v = await probe(file);
    if (Math.abs(v.dur - expect) > 2 / fps + 0.06 || v.w !== W || v.h !== H || !v.audio) {
      throw new TmepError('E_INTERNAL', `output verification failed: got ${v.dur}s ${v.w}x${v.h} audio=${v.audio}, expected ${r2(expect, 3)}s ${W}x${H}`);
    }
    return v;
  };
  if ((await exists(outPath)) && (await fsp.readFile(markerFile, 'utf8').catch(() => '')) === finalKey) {
    try {
      const v = await verifyOutput(outPath);
      progress(1, 'cached');
      return { out: outPath, dur: v.dur, w: W, h: H, fps, units: units.length, unitsCached: units.length, audioCached: true, cacheHit: true, ms: Date.now() - t0, span, verified: { dur: v.dur, w: v.w ?? 0, h: v.h ?? 0, audio: v.audio } };
    } catch {
      await fsp.rm(markerFile, { force: true }).catch(() => {});
    }
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

    for (const { run, overlay } of vectors) {
      if (ctrl.signal.aborted || !todo.some((i) => overlaps(run, units[i]!)) || (await exists(overlay.seq))) continue;
      const tmp = tmpFor(overlay.seq, '');
      try {
        await rasterizeVectorRun(run, W, H, tmp, ctrl.signal);
        // A concurrent render may publish the same content-addressed sequence first.
        await fsp.rename(tmp, overlay.seq).catch(async (e) => { if (!(await exists(overlay.seq))) throw e; });
      } catch (e) {
        fail(e);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
      }
    }

    const maskFiles = new Map<FxMask, string>();
    const MW = Math.max(2, Math.round(W / 2));
    const MH = Math.max(2, Math.round(H / 2));
    // Each effect stack with the duration (s) of the item it belongs to: an animated mask is
    // rasterized once per item frame (plus one second of tail for the unit graph's padding).
    const effectItems: [Effect[], number][] = [
      ...placed.map((p) => [p.clip.fx ?? [], p.frames / fps] as [Effect[], number]),
      ...tl.broll.map((b) => [b.fx ?? [], b.d] as [Effect[], number]),
      ...gfxOverlays.map((g) => [g.fx ?? [], g.d] as [Effect[], number]),
    ];
    for (const [fxs, dur] of effectItems) {
      for (const eff of fxs) {
        if (eff.type !== 'mask' || (eff.shape !== 'concave' && eff.shape !== 'bezier')) continue;
        if (ctrl.signal.aborted) break;
        const animated = maskAnimated(eff);
        const mFrames = animated ? Math.ceil((dur + 1) * fps) + 1 : 1;
        const mKey = hashOf({ v: 2, m: eff, MW, MH, fps: animated ? fps : 0, frames: mFrames });
        const mFile = project.cachePath('masks', animated ? mKey : `${mKey}.png`);
        if (!(await exists(mFile))) {
          await fsp.mkdir(path.dirname(mFile), { recursive: true });
          const tmpM = tmpFor(mFile, animated ? '' : '.png');
          try {
            if (animated) await rasterizeComplexMaskSequence(eff, MW, MH, fps, mFrames, tmpM, ctrl.signal);
            else await fsp.writeFile(tmpM, rasterizeComplexMaskPng(eff, MW, MH, 0));
            // A concurrent render may publish the same content-addressed mask first.
            await fsp.rename(tmpM, mFile).catch(async (e) => { if (!(await exists(mFile))) throw e; });
          } finally {
            await fsp.rm(tmpM, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
          }
        }
        maskFiles.set(eff, mFile);
      }
    }

    await pool(
      todo,
      par,
      async (i) => {
        const u = units[i]!;
        const tmp = tmpFor(unitFiles[i]!, '.mp4');
        temps.add(tmp);
        const { args } = unitArgs(tl, u, media, enc, placed, tmp, compiled.events ? 'gfx.ass' : undefined, hasFonts ? 'fonts' : undefined, gfxOverlays, maskFiles);
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
    await ffmpeg({ args: ['-f', 'concat', '-safe', '0', '-i', list, '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', ...BT709_OUTPUT_TAGS, '-movflags', '+faststart', tmpOut], signal: ctrl.signal });
    await fsp.rename(tmpOut, outPath);
    temps.delete(tmpOut);
  } finally {
    hooks.signal?.removeEventListener('abort', onCallerAbort);
    await Promise.all([...temps].map((f) => fsp.rm(f, { force: true }).catch(() => {})));
  }

  // ---- verify before writing cache marker ----
  let v: Awaited<ReturnType<typeof probe>>;
  try {
    v = await verifyOutput(outPath);
    await fsp.writeFile(markerFile, finalKey);
  } catch (e) {
    await fsp.rm(markerFile, { force: true }).catch(() => {});
    throw e;
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
