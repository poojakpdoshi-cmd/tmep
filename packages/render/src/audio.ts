/**
 * Audio mix in bounded stages (Stabilization A5).
 *
 * The mix used to be one FFmpeg process with one input per audible clip and one per sound
 * effect. Its command line, open files, threads and memory all grew with the timeline: about
 * 360 clips exceeded Windows' command-line limit ("spawn ENAMETOOLONG"), 800 clips took three
 * minutes and 1.5 GB. Now no process depends on the length of the timeline:
 *
 *   1. Speech stems. The clip sequence is cut into chunks of at most `maxClips` clips. Each
 *      chunk is rendered by its own FFmpeg process (same per-clip chain, crossfades and
 *      de-click fades as before) into a 32-bit float PCM file of an exact number of samples,
 *      stored in the cache under a hash of its content.
 *   2. Sound-effect stems. Effects are grouped into windows of at most `maxSfx` effects; each
 *      window is mixed into a PCM file the same way. An effect file is opened once per window
 *      however often it is used, and gaps between windows are a repeated one-second silence.
 *   3. Final pass. One process reads the speech stems through a concat list, the music, and the
 *      effect stems through a second list: three inputs at most. Ducking, mixing, loudness
 *      normalization and AAC encoding happen here, over the whole programme, as before.
 *
 * Positions are exact. Frame f of the timeline is sample round(f * 48000 / fps); every clip,
 * crossfade and chunk is trimmed and padded to sample counts derived from those positions, so
 * chunks join without gaps and nothing accumulates. (The single-pass graph rounded each clip
 * and crossfade to milliseconds, which let audio drift against video on long timelines.)
 *
 * A chunk may begin or end inside a run of crossfaded clips. The clip at such a boundary is
 * decoded by both chunks: the earlier one fades it in and stops when the crossfade ends, the
 * later one starts at that sample. `layout()` limits a transition to half of each neighbouring
 * clip, so a clip's fade-in and fade-out never overlap and the split is sample-exact.
 */
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { type Timeline, type Placed, TmepError, hashOf, exists, toPosix } from '../../core/src/index.ts';
import { ffmpeg } from '../../media/src/ffmpeg.ts';
import type { MediaRef } from './graph.ts';
import { pool, tmpFor, publish, maybeScript } from './stage.ts';

/** Sample rate of every stem and of the final mix. */
export const SR = 48000;
/** Part of every audio cache key: bump when the same timeline must produce different audio. */
export const AUDIO_VERSION = 'a2';

const n3 = (x: number) => String(Math.round(x * 1000) / 1000);
const STEREO = 'aformat=sample_fmts=fltp:channel_layouts=stereo';
/** Restart timestamps from the sample count (stems arrive through the concat demuxer). */
const RESTAMP = 'asetpts=N/SR/TB';
const PCM = ['-c:a', 'pcm_f32le', '-ar', String(SR), '-ac', '2', '-rf64', 'auto'];
/** De-click fades at every clip edge (samples): 12 ms in, 15 ms out. */
const FADE_IN = 576;
const FADE_OUT = 720;

export interface AudioLimits {
  /** A chunk is not ended by a content boundary before it has this many clips. */
  minClips: number;
  /** A chunk never has more clips than this (plus one borrowed crossfade partner). */
  maxClips: number;
  /** After `minClips`, a clip starts a new chunk when its content hash is divisible by this. */
  every: number;
  /** Upper bound for the characters of one chunk's input arguments. */
  maxInputChars: number;
  /** Sound effects started per effect window. */
  maxSfx: number;
}

/**
 * Chunk boundaries follow clip content, not clip index (content-defined chunking): inserting or
 * removing a clip changes the chunks around the edit and leaves the others, and their cache
 * entries, as they were. Average chunk: minClips + every clips.
 */
export const AUDIO_LIMITS: AudioLimits = { minClips: 8, maxClips: 32, every: 8, maxInputChars: 8000, maxSfx: 32 };

/** Sample position of a timeline frame. */
export const samplePos = (frame: number, fps: number): number => Math.round((frame * SR) / fps);

/** One clip as the audio stage sees it. */
export interface ClipAudio {
  /** Source file; undefined for a clip without sound (image, muted, no audio stream). */
  path?: string;
  in: number;
  speed: number;
  vol: number;
  /** Length in samples. */
  n: number;
  /** Crossfade with the previous clip in samples (0 = hard cut). */
  x: number;
  /** Hash of everything above except the path (the media content hash stands in for it). */
  hash: string;
}

export interface SpeechChunk {
  /** Cache key: hash of the chunk's content. */
  key: string;
  /** Clips decoded by this chunk, in order. */
  clips: ClipAudio[];
  /** Index of the first clip in the timeline, and how many clips belong to this chunk. */
  first: number;
  count: number;
  /** True when the last entry of `clips` belongs to the next chunk (it is only faded in here). */
  borrowed: boolean;
  /** Samples dropped from the start: the first clip's fade-in was rendered by the previous chunk. */
  head: number;
  /** Timeline position and exact length, in samples. */
  at: number;
  samples: number;
}

export function clipAudio(placed: Placed[], media: Record<string, MediaRef>, fps: number): ClipAudio[] {
  return placed.map((p) => {
    const c = p.clip;
    const m = media[c.src]!;
    const audible = m.kind !== 'image' && m.audio && !c.mute;
    const at = samplePos(p.startFrame, fps);
    const n = samplePos(p.startFrame + p.frames, fps) - at;
    const x = p.transFrames > 0 ? samplePos(p.startFrame + p.transFrames, fps) - at : 0;
    const hash = hashOf(audible ? { h: m.hash, in: c.in, sp: c.speed, vol: c.vol, n, x } : { silent: true, n, x });
    return { ...(audible ? { path: m.path } : {}), in: c.in, speed: c.speed, vol: c.vol, n, x, hash };
  });
}

/** Characters one clip adds to its chunk's command line (quoted path, seek and duration). */
const inputChars = (c: ClipAudio): number => (c.path === undefined ? 0 : c.path.length + 3 + 32);

/** Cut the clip sequence into chunks of bounded size. Every sample of the timeline is in exactly one. */
export function planSpeech(clips: ClipAudio[], limits: AudioLimits = AUDIO_LIMITS): SpeechChunk[] {
  if (!clips.length) return [];
  const starts: number[] = [0];
  const at: number[] = [];
  let cursor = 0;
  for (const c of clips) {
    at.push(cursor - c.x);
    cursor += c.n - c.x;
  }
  const end = cursor;
  // A chunk may start at clip j when the clip can be split after its fade-in: that needs the
  // fade-in and the following fade-out to fit in the clip without overlapping.
  const canStart = (j: number) => clips[j]!.x === 0 || clips[j]!.x + (clips[j + 1]?.x ?? 0) <= clips[j]!.n;
  let size = 1;
  let chars = inputChars(clips[0]!);
  for (let j = 1; j < clips.length; j++) {
    const c = clips[j]!;
    const forced = size >= limits.maxClips || chars + inputChars(c) > limits.maxInputChars;
    const natural = size >= limits.minClips && parseInt(c.hash.slice(0, 8), 16) % limits.every === 0;
    if ((forced || natural) && canStart(j)) {
      starts.push(j);
      size = 1;
      chars = inputChars(c);
    } else {
      size++;
      chars += inputChars(c);
    }
  }
  return starts.map((first, i) => {
    const next = starts[i + 1];
    const count = (next ?? clips.length) - first;
    const borrowed = next !== undefined && clips[next]!.x > 0;
    const own = clips.slice(first, first + count + (borrowed ? 1 : 0));
    const head = first > 0 ? clips[first]!.x : 0;
    const from = at[first]! + head;
    const to = next === undefined ? end : at[next]! + clips[next]!.x;
    const samples = to - from;
    return { key: hashOf({ v: AUDIO_VERSION, kind: 'speech', clips: own.map((c) => c.hash), head, samples }), clips: own, first, count, borrowed, head, at: from, samples };
  });
}

export interface StemArgs {
  args: string[];
  graph: string;
}

/** FFmpeg arguments for one speech chunk: at most `maxClips` + 1 inputs, PCM out. */
export function speechChunkArgs(chunk: SpeechChunk, out: string): StemArgs {
  const inputs: string[] = [];
  const g: string[] = [];
  let k = 0;
  chunk.clips.forEach((c, j) => {
    const chain: string[] = [];
    let src: string;
    if (c.path !== undefined) {
      inputs.push('-ss', n3(c.in), '-t', n3((c.n / SR) * c.speed + 0.3), '-i', c.path);
      src = `[${k++}:a]`;
      chain.push(`aresample=${SR}`, STEREO, 'asetpts=PTS-STARTPTS');
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
      chain.push(`atrim=end_sample=${c.n}`, `apad=whole_len=${c.n}`, `afade=t=in:ss=0:ns=${FADE_IN}`, `afade=t=out:ss=${Math.max(0, c.n - FADE_OUT)}:ns=${FADE_OUT}`);
    } else {
      src = '';
      chain.push(`anullsrc=r=${SR}:cl=stereo`, STEREO, `atrim=end_sample=${c.n}`);
    }
    // the previous chunk rendered this clip's fade-in: continue right after it
    if (j === 0 && chunk.head > 0) chain.push(`atrim=start_sample=${chunk.head}`, RESTAMP);
    g.push(`${src}${chain.join(',')}[a${j}]`);
  });
  let cur = 'a0';
  for (let j = 1; j < chunk.clips.length; j++) {
    const c = chunk.clips[j]!;
    if (c.x > 0) g.push(`[${cur}][a${j}]acrossfade=ns=${c.x}:c1=tri:c2=tri[m${j}]`);
    else g.push(`[${cur}][a${j}]concat=n=2:v=0:a=1[m${j}]`);
    cur = `m${j}`;
  }
  // exact length whatever happens upstream; this is also where a borrowed clip is cut off
  g.push(`[${cur}]apad=whole_len=${chunk.samples},atrim=end_sample=${chunk.samples},${RESTAMP}[aout]`);
  const graph = g.join(';');
  return { args: [...inputs, '-filter_complex', graph, '-map', '[aout]', ...PCM, out], graph };
}

/** A sound effect on the timeline. `len` is the effect's length in samples at 48 kHz. */
export interface SfxItem {
  file: string;
  t: number;
  vol: number;
  len: number;
}

export interface SfxWindow {
  key: string;
  /** Effects audible in this window; `off` is the start relative to the window (negative: began earlier). */
  uses: { file: string; off: number; vol: number }[];
  /** Whole seconds of silence between the previous window (or the start) and this one. */
  silence: number;
  at: number;
  samples: number;
}

/**
 * Group sound effects into windows of at most `maxSfx` effects. Windows follow each other on
 * the effect bus: `silence` one-second files, then the window's own stem. A window ends where
 * the next one starts or where its last effect ends; an effect still sounding at a boundary
 * continues in the next window. Start times are rounded to milliseconds, as `adelay` did.
 */
export function planSfx(sfx: SfxItem[], totalSamples: number, limits: AudioLimits = AUDIO_LIMITS): SfxWindow[] {
  const items = sfx
    .map((s, order) => ({ ...s, order, start: Math.round(s.t * 1000) * (SR / 1000) }))
    .filter((s) => s.t >= 0 && s.start < totalSamples && s.len > 0)
    .map((s) => ({ ...s, end: Math.min(s.start + s.len, totalSamples) }))
    .sort((a, b) => a.start - b.start || a.order - b.order);
  const windows: SfxWindow[] = [];
  let written = 0; // the bus is complete up to this sample
  let active: typeof items = []; // effects that began in earlier windows
  let carried = 0; // silence owed by a window that turned out empty
  for (let i = 0; i < items.length; i += limits.maxSfx) {
    const own = items.slice(i, i + limits.maxSfx);
    const nominal = own[0]!.start;
    active = active.filter((s) => s.end > nominal);
    // a gap before this window: whole seconds as repeated silence, the rest as lead-in here
    const gap = Math.max(0, nominal - written);
    const silence = active.length ? 0 : Math.floor(gap / SR);
    const at = active.length ? written : written + silence * SR;
    const used = [...active, ...own].sort((a, b) => a.order - b.order);
    const nextStart = items[i + limits.maxSfx]?.start ?? Infinity;
    const to = Math.min(Math.max(...used.map((s) => s.end)), nextStart);
    const uses = used.map((s) => ({ file: s.file, off: s.start - at, vol: s.vol }));
    const samples = to - at;
    active = used;
    if (samples === 0) {
      // more than `maxSfx` effects start at this very sample: they all sound in the next window
      carried += silence;
      written = to;
      continue;
    }
    windows.push({ key: hashOf({ v: AUDIO_VERSION, kind: 'sfx', uses: uses.map((u) => ({ f: path.basename(u.file), off: u.off, vol: u.vol })), samples }), uses, silence: silence + carried, at, samples });
    carried = 0;
    written = to;
  }
  return windows;
}

/** FFmpeg arguments for one effect window: one input per distinct effect file, PCM out. */
export function sfxWindowArgs(win: SfxWindow, out: string): StemArgs {
  const files = [...new Set(win.uses.map((u) => u.file))];
  const inputs = files.flatMap((f) => ['-i', f]);
  const g: string[] = [];
  const mixed: string[] = [];
  files.forEach((f, k) => {
    const mine = win.uses.map((u, i) => ({ u, i })).filter((x) => x.u.file === f);
    const head = `[${k}:a]aresample=${SR},${STEREO}`;
    if (mine.length === 1) g.push(`${head}[s${mine[0]!.i}]`);
    else g.push(`${head},asplit=${mine.length}${mine.map((x) => `[s${x.i}]`).join('')}`);
  });
  win.uses.forEach((u, i) => {
    const place = u.off >= 0 ? `adelay=${u.off}S|${u.off}S` : `atrim=start_sample=${-u.off},${RESTAMP}`;
    g.push(`[s${i}]${place},volume=${n3(u.vol)}dB[x${i}]`);
    mixed.push(`[x${i}]`);
  });
  const mix = mixed.length > 1 ? `amix=inputs=${mixed.length}:duration=longest:dropout_transition=0:normalize=0,` : '';
  g.push(`${mixed.join('')}${mix}apad=whole_len=${win.samples},atrim=end_sample=${win.samples},${RESTAMP}[aout]`);
  const graph = g.join(';');
  return { args: [...inputs, '-filter_complex', graph, '-map', '[aout]', ...PCM, out], graph };
}

/** One second of silence in the stem format (gaps on the effect bus). */
function silenceArgs(out: string): StemArgs {
  const graph = `anullsrc=r=${SR}:cl=stereo,${STEREO},atrim=end_sample=${SR}[aout]`;
  return { args: ['-filter_complex', graph, '-map', '[aout]', ...PCM, out], graph };
}

export interface FinalMix {
  /** Concat list of the speech stems (relative to the working directory). */
  speechList: string;
  /** Concat list of the effect bus, when the timeline has sound effects. */
  sfxList?: string;
  music?: MediaRef;
  totalSamples: number;
  range?: { s: number; e: number };
  out: string;
  /** Output encoder arguments (default: the AAC settings of the final mix). */
  codec?: string[];
}

/**
 * The final pass: speech + ducked music + effects, loudness, AAC. Three inputs at most. Music,
 * ducking, mix order and loudness settings are those of the single-pass graph.
 */
export function finalMixArgs(tl: Timeline, mix: FinalMix): StemArgs {
  const total = mix.totalSamples / SR;
  const inputs = ['-f', 'concat', '-safe', '0', '-i', mix.speechList];
  const g = [`[0:a]${STEREO},${RESTAMP}[sp]`];
  let k = 1;
  let cur = 'sp';
  const buses: string[] = [];
  if (tl.music && mix.music) {
    inputs.push('-stream_loop', '-1', '-i', mix.music.path);
    const f = Math.min(tl.music.fade, total / 3);
    g.push(`[${k++}:a]aresample=${SR},${STEREO},atrim=duration=${n3(total)},asetpts=PTS-STARTPTS,volume=${n3(tl.music.vol)}dB,afade=t=in:d=${n3(f)},afade=t=out:st=${n3(Math.max(0, total - f))}:d=${n3(f)}[mus]`);
    if (tl.music.duck) {
      g.push(`[${cur}]asplit=2[spm][sc]`);
      g.push('[mus][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=380:makeup=1[musd]');
      cur = 'spm';
      buses.push('musd');
    } else buses.push('mus');
  }
  if (mix.sfxList) {
    inputs.push('-f', 'concat', '-safe', '0', '-i', mix.sfxList);
    g.push(`[${k++}:a]${STEREO},${RESTAMP}[sfx]`);
    buses.push('sfx');
  }
  let master = cur;
  if (buses.length) {
    g.push(`[${cur}]${buses.map((b) => `[${b}]`).join('')}amix=inputs=${buses.length + 1}:duration=first:dropout_transition=0:normalize=0[mix]`);
    master = 'mix';
  }
  const post: string[] = [];
  if (tl.loudness < 0) post.push(`loudnorm=I=${tl.loudness}:TP=-1.5:LRA=11`, `aresample=${SR}`);
  let len = mix.totalSamples;
  if (mix.range) {
    const a = Math.round(mix.range.s * SR);
    const b = Math.round(mix.range.e * SR);
    post.push(`atrim=start_sample=${a}:end_sample=${b}`, RESTAMP);
    len = b - a;
  }
  post.push(`apad=whole_len=${len}`, `atrim=end_sample=${len}`);
  g.push(`[${master}]${post.join(',')}[aout]`);
  const graph = g.join(';');
  const codec = mix.codec ?? ['-c:a', 'aac', '-b:a', '192k', '-ar', String(SR)];
  return { args: [...inputs, '-filter_complex', graph, '-map', '[aout]', ...codec, mix.out], graph };
}

/** Length of a PCM WAV file in samples at 48 kHz, read from its header. */
export async function wavSamples(file: string): Promise<number> {
  const fh = await fsp.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(size, 4096));
    await fh.read(buf, 0, buf.length, 0);
    if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`not a WAV file: ${file}`);
    let rate = 0;
    let align = 0;
    for (let p = 12; p + 8 <= buf.length; ) {
      const id = buf.toString('latin1', p, p + 4);
      const len = buf.readUInt32LE(p + 4);
      if (id === 'fmt ') {
        rate = buf.readUInt32LE(p + 12);
        align = buf.readUInt16LE(p + 20);
      } else if (id === 'data' && rate && align) {
        // a writer that could not seek back leaves 0 or 0xFFFFFFFF: use what is on disk
        const bytes = len === 0 || len === 0xffffffff ? size - (p + 8) : Math.min(len, size - (p + 8));
        return Math.ceil((bytes / align) * (SR / rate));
      }
      p += 8 + len + (len & 1);
    }
    throw new Error(`no audio data in WAV file: ${file}`);
  } finally {
    await fh.close();
  }
}

export interface AudioJob {
  tl: Timeline;
  placed: Placed[];
  media: Record<string, MediaRef>;
  sfx: { file: string; t: number; vol: number }[];
  /** Total timeline frames. */
  frames: number;
  range?: { s: number; e: number };
  /** Where the finished mix (.m4a) is written. */
  out: string;
  /** Directory of the stem cache. */
  stemDir: string;
  /** Private working directory of this render: list files, graph scripts. */
  work: string;
  signal?: AbortSignal;
  /** Temporary files of this render: the caller removes whatever is still listed when it ends. */
  temps: Set<string>;
  /** Stem processes running at once (default: 2, or 1 on a single core). */
  parallel?: number;
  limits?: AudioLimits;
  /** Output encoder arguments of the final pass (default: AAC; tests render PCM to compare). */
  codec?: string[];
}

export interface AudioStats {
  /** Distinct stems the mix is built from, and how many of them were already in the cache. */
  stems: number;
  stemsCached: number;
  /** Most `-i` inputs of any FFmpeg process of the stage. */
  maxInputs: number;
}

const stemBytes = (samples: number) => samples * 8; // 32-bit float, stereo

/** Render the mix for a timeline: stems (cached, a bounded number at a time), then the final pass. */
export async function renderAudio(job: AudioJob): Promise<AudioStats> {
  const limits = job.limits ?? AUDIO_LIMITS;
  const fps = job.tl.settings.fps;
  const totalSamples = samplePos(job.frames, fps);
  const chunks = planSpeech(clipAudio(job.placed, job.media, fps), limits);
  const lens = new Map<string, number>();
  for (const s of job.sfx) if (!lens.has(s.file)) lens.set(s.file, await wavSamples(s.file));
  const windows = planSfx(job.sfx.map((s) => ({ ...s, len: lens.get(s.file)! })), totalSamples, limits);

  // every stem once, whatever its kind: identical content has an identical key
  const stems = new Map<string, { samples: number; build: (out: string) => StemArgs }>();
  for (const c of chunks) stems.set(c.key, { samples: c.samples, build: (out) => speechChunkArgs(c, out) });
  for (const w of windows) stems.set(w.key, { samples: w.samples, build: (out) => sfxWindowArgs(w, out) });
  const silenceKey = hashOf({ v: AUDIO_VERSION, kind: 'silence', samples: SR });
  if (windows.some((w) => w.silence > 0)) stems.set(silenceKey, { samples: SR, build: silenceArgs });

  await fsp.mkdir(job.stemDir, { recursive: true });
  const file = (key: string) => path.join(job.stemDir, `${key}.wav`);
  const todo: string[] = [];
  for (const key of stems.keys()) if (!(await exists(file(key)))) todo.push(key);
  let maxInputs = 0;
  let failure: unknown;
  await pool(
    todo,
    job.parallel ?? Math.min(2, os.cpus().length),
    async (key) => {
      const stem = stems.get(key)!;
      const tmp = tmpFor(file(key), '.wav');
      job.temps.add(tmp);
      const { args } = stem.build(tmp);
      maxInputs = Math.max(maxInputs, args.filter((a) => a === '-i').length);
      await ffmpeg({ args: await maybeScript(args, job.work), cwd: job.work, signal: job.signal });
      // a stem of the wrong length would shift everything after it: never publish one
      const size = (await fsp.stat(tmp)).size;
      if (size < stemBytes(stem.samples)) throw new TmepError('E_INTERNAL', `audio stem ${key} is too short: ${size} bytes for ${stem.samples} samples`);
      await publish(tmp, file(key), async (f) => (await fsp.stat(f)).size >= stemBytes(stem.samples));
      job.temps.delete(tmp);
    },
    () => failure !== undefined || !!job.signal?.aborted,
    (e) => (failure ??= e),
  );
  if (failure !== undefined) throw failure;
  if (job.signal?.aborted) throw new TmepError('E_CANCELLED', 'render cancelled');

  // concat lists live in the working directory and are referenced by relative name
  const entry = (key: string) => `file '${toPosix(file(key)).replace(/'/g, "'\\''")}'`;
  await fsp.writeFile(path.join(job.work, 'speech.txt'), chunks.map((c) => entry(c.key)).join('\n') + '\n');
  if (windows.length) {
    const lines = windows.flatMap((w) => [...Array.from({ length: w.silence }, () => entry(silenceKey)), entry(w.key)]);
    await fsp.writeFile(path.join(job.work, 'sfx.txt'), lines.join('\n') + '\n');
  }
  const music = job.tl.music ? job.media[job.tl.music.src] : undefined;
  const { args } = finalMixArgs(job.tl, {
    speechList: 'speech.txt',
    ...(windows.length ? { sfxList: 'sfx.txt' } : {}),
    ...(music && (music.kind === 'audio' || music.audio) ? { music } : {}),
    totalSamples,
    ...(job.range ? { range: job.range } : {}),
    out: job.out,
    ...(job.codec ? { codec: job.codec } : {}),
  });
  maxInputs = Math.max(maxInputs, args.filter((a) => a === '-i').length);
  await ffmpeg({ args: await maybeScript(args, job.work), cwd: job.work, signal: job.signal });
  return { stems: stems.size, stemsCached: stems.size - todo.length, maxInputs };
}
