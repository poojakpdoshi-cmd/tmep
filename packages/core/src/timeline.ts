/**
 * Declarative, non-destructive timeline model.
 *
 * Design rules:
 *  - Clips reference source media by asset ID with source in/out points (never copies).
 *  - Everything that should "stick" to speech (zooms, graphics, sound effects, cutaways)
 *    is anchored to SOURCE time ({src, t}) rather than timeline time. When the agent trims
 *    or reorders clips, anchored items move with their words automatically.
 *  - Timeline math is frame-quantized (all starts/durations are integer frame counts).
 */
import { TmepError } from './errors.ts';
import { type Effect, type Ease, type ColorGrade, ease, shiftFx } from './effects.ts';
import type { SceneEntry } from './scene.ts';

export type Ratio = '9:16' | '16:9' | '1:1' | '4:5';
export type Fit = 'cover' | 'contain' | 'blur';
export type CapStyle = 'kinetic' | 'karaoke' | 'clean' | 'boxed' | 'none';

export const RATIOS: Record<Ratio, [number, number]> = {
  '9:16': [1080, 1920],
  '16:9': [1920, 1080],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
};

export interface Settings {
  ratio: Ratio;
  w: number;
  h: number;
  fps: number;
  bg: string;
}

/** Zoom envelope anchored to source time `s` of the clip's media. */
export interface Zoom {
  s: number;
  d: number;
  to: number;
  mode: 'punch' | 'smooth';
}

export interface Transition {
  type: string;
  d: number;
}

export interface SpeedKey {
  /** Source-offset seconds from clip.in (0..out-in). */
  t: number;
  speed: number;
  e?: Ease;
}

export interface AudioClipPost {
  eq?: 'dialogue' | 'warm' | 'crisp';
  denoise?: number;
  deess?: number;
  comp?: 'light' | 'medium' | 'heavy';
  hp?: number;
  lp?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface AudioMaster {
  target?: 'reels' | 'shorts' | 'tiktok' | 'youtube' | 'podcast' | 'broadcast' | 'cinema';
  lufs?: number;
  tp?: number;
  lra?: number;
  twoPass?: boolean;
  limiter?: number;
}

export interface Clip {
  id: string;
  src: string;
  in: number;
  out: number;
  speed: number;
  fit: Fit;
  /** Crop centre (0..1) used when `fit` is cover and the aspect ratio differs. */
  cx: number;
  cy: number;
  /** Static scale (1 = none). Alternating 1.0/1.1 between jump cuts hides the cut. */
  base: number;
  /** Additional scale reached at the clip's end (slow push-in). */
  push: number;
  zoom: Zoom[];
  /** Transition INTO this clip from the previous one. */
  trans?: Transition;
  vol: number;
  mute: boolean;
  /** Keyframed transforms and masks (clip-local time). Optional: absent on older timelines. */
  fx?: Effect[];
  /** J-cut: seconds audio leads video into the previous clip (>=0). */
  jcut?: number;
  /** L-cut: seconds audio trails video into the next clip (>=0). */
  lcut?: number;
  /** Reverse video & audio playback. */
  reverse?: boolean;
  /** Freeze-frame duration in seconds (holds frame at `in`, silent audio). */
  freeze?: number;
  /** Variable speed ramp keyframes (t = source offset from `in`). */
  speedRamp?: SpeedKey[];
  /** Video stabilization parameters. */
  stabilize?: { shakiness?: number; accuracy?: number; smoothing?: number };
  /** Per-clip colour grade. */
  color?: ColorGrade;
  /** Per-clip audio post-processing. */
  audio?: AudioClipPost;
}

/** A point in time: either absolute timeline time (`at`) or a source anchor (`src` + `t`, optionally scoped to `clip` id). */
export interface TimeRef {
  at?: number;
  clip?: string;
  src?: string;
  t?: number;
}

export interface Gfx {
  id: string;
  preset: string;
  ref: TimeRef;
  d: number;
  props: Record<string, unknown>;
  /** Optional group effects for an independently composited graphics preset. */
  fx?: Effect[];
  /** Explicit compositing order. Higher is in front; captions always on top. */
  z?: number;
}

export interface BRoll {
  id: string;
  src: string;
  in: number;
  ref: TimeRef;
  d: number;
  fit: Fit;
  /** Clip-local effects, including keyframes and masks. Optional for older timelines. */
  fx?: Effect[];
  /** Explicit compositing order. Default 0; higher is in front. */
  z?: number;
  /** Render-time placement for a compiled Visual Scene media layer. */
  scene?: { w: number; h: number; camera?: Effect[] };
}

export interface Sfx {
  id: string;
  kind: string;
  ref: TimeRef;
  vol: number;
}

export interface Music {
  src: string;
  vol: number;
  duck: boolean;
  fade: number;
}

export interface Captions {
  style: CapStyle;
  pos: 'lower' | 'middle' | 'upper';
  maxWords: number;
  upper: boolean;
  color: string;
  accent: string;
  size: number;
  font?: string;
  emphasis: boolean;
  /** Text corrections applied at render time: [find, replace] (case-insensitive, whole word). */
  fix: [string, string][];
  /** Optional Devanagari -> Latin transliteration for Hinglish captions. */
  script?: 'latin' | 'native';
}

export interface Timeline {
  v: 1;
  seq: number;
  settings: Settings;
  clips: Clip[];
  broll: BRoll[];
  gfx: Gfx[];
  scenes?: SceneEntry[];
  sfx: Sfx[];
  music?: Music;
  captions: Captions;
  /** Integrated loudness target in LUFS; 0 disables normalization. */
  loudness: number;
  /** Global colour grade applied to the timeline. */
  color?: ColorGrade;
  /** Audio mastering configuration (two-pass loudnorm, platform target, limiter). */
  master?: AudioMaster;
  meta: Record<string, unknown>;
}

export interface Word {
  w: string;
  s: number;
  e: number;
  p?: number;
}

export interface Placed {
  clip: Clip;
  idx: number;
  startFrame: number;
  frames: number;
  /** Frames of overlap with the previous clip (transition length). */
  transFrames: number;
  start: number;
  dur: number;
}

export interface TlWord extends Word {
  src: string;
  /** Index of the word in its source transcript (stable reference). */
  i: number;
  /** Index in the timeline word list. */
  k: number;
}

export function defaultCaptions(): Captions {
  return {
    style: 'kinetic',
    pos: 'lower',
    maxWords: 3,
    upper: true,
    color: '#FFFFFF',
    accent: '#FFD400',
    size: 1,
    emphasis: true,
    fix: [],
  };
}

export function emptyTimeline(ratio: Ratio = '9:16', fps = 30): Timeline {
  const [w, h] = RATIOS[ratio];
  return {
    v: 1,
    seq: 0,
    settings: { ratio, w, h, fps, bg: '#000000' },
    clips: [],
    broll: [],
    gfx: [],
    sfx: [],
    captions: defaultCaptions(),
    loudness: -14,
    meta: {},
  };
}

export function nextId(tl: Timeline, prefix: string): string {
  tl.seq += 1;
  return `${prefix}${tl.seq}`;
}

export function newClip(tl: Timeline, src: string, inT: number, outT: number, extra: Partial<Clip> = {}): Clip {
  return {
    id: nextId(tl, 'c'),
    src,
    in: inT,
    out: outT,
    speed: 1,
    fit: 'cover',
    cx: 0.5,
    cy: 0.5,
    base: 1,
    push: 0,
    zoom: [],
    vol: 1,
    mute: false,
    ...extra,
  };
}

export function sampleSpeedRamp(keys: SpeedKey[], srcOffset: number): number {
  if (!keys.length) return 1;
  if (srcOffset <= keys[0]!.t) return keys[0]!.speed;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (srcOffset < b.t) {
      const p = (srcOffset - a.t) / Math.max(1e-6, b.t - a.t);
      return a.speed + (b.speed - a.speed) * ease(b.e ?? 'io', p);
    }
  }
  return keys[keys.length - 1]!.speed;
}

export function speedRampDuration(c: Clip): number {
  const srcDur = Math.max(0, c.out - c.in);
  if (!c.speedRamp?.length) return srcDur / c.speed;
  const steps = 256;
  const du = srcDur / steps;
  let out = 0;
  for (let i = 0; i < steps; i++) {
    const u = (i + 0.5) * du;
    out += du / Math.max(0.1, sampleSpeedRamp(c.speedRamp, u));
  }
  return out;
}

export function clipFrames(c: Clip, fps: number): number {
  if (c.freeze !== undefined && c.freeze > 0) return Math.max(1, Math.round(c.freeze * fps));
  return Math.max(1, Math.round(speedRampDuration(c) * fps));
}

/** Frame-exact placement of every clip, accounting for transition overlaps. */
export function layout(tl: Timeline): Placed[] {
  const fps = tl.settings.fps;
  const out: Placed[] = [];
  let cursor = 0;
  tl.clips.forEach((clip, idx) => {
    const frames = clipFrames(clip, fps);
    let transFrames = 0;
    if (idx > 0 && clip.trans && clip.trans.d > 0) {
      const prev = out[idx - 1]!;
      const want = Math.round(clip.trans.d * fps);
      transFrames = Math.max(0, Math.min(want, Math.floor(prev.frames / 2), Math.floor(frames / 2)));
    }
    const startFrame = cursor - transFrames;
    out.push({ clip, idx, startFrame, frames, transFrames, start: startFrame / fps, dur: frames / fps });
    cursor = startFrame + frames;
  });
  return out;
}

export function totalFrames(tl: Timeline): number {
  const p = layout(tl);
  const last = p[p.length - 1];
  return last ? last.startFrame + last.frames : 0;
}

export const duration = (tl: Timeline): number => totalFrames(tl) / tl.settings.fps;

/** Map a source time to timeline time (first clip that contains it). */
export function srcToTl(placed: Placed[], src: string, t: number): number | undefined {
  for (const p of placed) {
    const c = p.clip;
    if (c.src === src && t >= c.in - 1e-6 && t <= c.out + 1e-6) {
      const offset = Math.min(p.dur, Math.max(0, (Math.min(t, c.out) - c.in) / c.speed));
      return p.start + offset;
    }
  }
  return undefined;
}

/** Map a timeline time to the clip/source position under it (topmost = later clip in transitions). */
export function tlToSrc(placed: Placed[], t: number): { p: Placed; srcT: number } | undefined {
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i]!;
    if (t >= p.start - 1e-6 && t < p.start + p.dur + 1e-6) {
      const raw = p.clip.in + (t - p.start) * p.clip.speed;
      const srcT = Math.min(p.clip.out, Math.max(p.clip.in, raw));
      return { p, srcT };
    }
  }
  return undefined;
}

export function resolveRef(placed: Placed[], ref: TimeRef): number | undefined {
  if (ref.clip !== undefined && ref.t !== undefined) {
    const exact = placed.find((p) => p.clip.id === ref.clip && ref.t! >= p.clip.in - 1e-6 && ref.t! <= p.clip.out + 1e-6);
    if (exact) {
      const c = exact.clip;
      const offset = Math.min(exact.dur, Math.max(0, (Math.min(ref.t, c.out) - c.in) / c.speed));
      return exact.start + offset;
    }
  }
  if (ref.src !== undefined && ref.t !== undefined) return srcToTl(placed, ref.src, ref.t);
  return ref.at;
}

/** Transcript words re-timed onto the timeline. Words cut out of the edit disappear. */
export function timelineWords(tl: Timeline, transcripts: Record<string, Word[] | undefined>, placed = layout(tl)): TlWord[] {
  const out: TlWord[] = [];
  for (const p of placed) {
    const words = transcripts[p.clip.src];
    if (!words) continue;
    const c = p.clip;
    words.forEach((w, i) => {
      const mid = (w.s + w.e) / 2;
      if (mid < c.in || mid >= c.out) return;
      const s = p.start + (Math.max(w.s, c.in) - c.in) / c.speed;
      const e = p.start + (Math.min(w.e, c.out) - c.in) / c.speed;
      out.push({ ...w, s, e, src: c.src, i, k: 0 });
    });
  }
  out.sort((a, b) => a.s - b.s);
  out.forEach((w, k) => (w.k = k));
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, '').trim();

/**
 * Resolve a compact time anchor to timeline time:
 *   12.5 | "12.5" | "12.5s"   absolute timeline seconds
 *   "@generative ai"          start of the first occurrence of the phrase (timeline words)
 *   "@generative ai#2"        second occurrence;  "@...^end" -> end of the phrase
 *   "w:42"                    timeline word #42
 *   "c:c7" / "c:c7^end"       start/end of clip c7
 *   "end"                     end of timeline
 */
export function resolveAnchor(tl: Timeline, words: TlWord[], a: unknown, placed = layout(tl)): { t: number; word?: TlWord; endT?: number } {
  if (typeof a === 'number') return { t: a };
  if (typeof a !== 'string') throw new TmepError('E_ANCHOR', `bad anchor ${JSON.stringify(a)}`);
  const s = a.trim();
  if (/^-?\d+(\.\d+)?s?$/.test(s)) return { t: parseFloat(s) };
  if (s === 'end') return { t: duration(tl) };
  if (s.startsWith('w:')) {
    const k = parseInt(s.slice(2), 10);
    const w = words[k];
    if (!w) throw new TmepError('E_ANCHOR', `no word ${k} (timeline has ${words.length})`);
    return { t: w.s, word: w, endT: w.e };
  }
  if (s.startsWith('c:')) {
    const [id, mod] = s.slice(2).split('^');
    const p = placed.find((x) => x.clip.id === id);
    if (!p) throw new TmepError('E_ANCHOR', `no clip ${id}`);
    return mod === 'end' ? { t: p.start + p.dur } : { t: p.start, endT: p.start + p.dur };
  }
  if (s.startsWith('@')) {
    let body = s.slice(1);
    let wantEnd = false;
    if (body.endsWith('^end')) {
      wantEnd = true;
      body = body.slice(0, -4);
    }
    let nth = 1;
    const m = /#(\d+)$/.exec(body);
    if (m) {
      nth = parseInt(m[1]!, 10);
      body = body.slice(0, m.index);
    }
    const target = norm(body).split(/\s+/).filter(Boolean);
    if (!target.length) throw new TmepError('E_ANCHOR', 'empty phrase anchor');
    const toks = words.map((w) => norm(w.w));
    let found = 0;
    for (let i = 0; i + target.length <= toks.length; i++) {
      let ok = true;
      for (let j = 0; j < target.length; j++) {
        const tk = toks[i + j]!;
        // allow prefix match on the last token ("generat" matches "generative")
        if (!(tk === target[j] || (j === target.length - 1 && tk.startsWith(target[j]!)))) {
          ok = false;
          break;
        }
      }
      if (ok && ++found === nth) {
        const first = words[i]!;
        const last = words[i + target.length - 1]!;
        return { t: wantEnd ? last.e : first.s, word: first, endT: last.e };
      }
    }
    throw new TmepError('E_ANCHOR', `phrase "${body}" not found in timeline transcript`, 'use video_inspect {what:"transcript",find:"..."} to locate it');
  }
  throw new TmepError('E_ANCHOR', `unrecognized anchor "${s}"`, 'use seconds, "@phrase", "w:N", "c:ID" or "end"');
}

/** Convert a resolved timeline time into a durable clip-scoped source anchor (falls back to absolute). */
export function anchorAt(placed: Placed[], t: number): TimeRef {
  const hit = tlToSrc(placed, t);
  if (!hit) return { at: t };
  const clamped = Math.min(hit.p.clip.out, Math.max(hit.p.clip.in, hit.srcT));
  return { clip: hit.p.clip.id, src: hit.p.clip.src, t: Math.round(clamped * 1e6) / 1e6 };
}

/** Remove a source range from every clip that uses it, splitting clips as needed. */
/**
 * Remove source range [s, e) (already clamped to the clip) from one clip. Returns the 0-2 clips
 * that replace it; remainders shorter than 40 ms are dropped. The right part gets a new id only
 * when both parts survive.
 */
function splitClip(tl: Timeline, c: Clip, s: number, e: number): Clip[] {
  const keepLeft = s - c.in > 0.04;
  const keepRight = c.out - e > 0.04;
  const out: Clip[] = [];
  // effects use clip-local output time: the right part continues where the original was at `e`
  const withFx = (x: Clip, dt: number): Clip => {
    if (c.fx) x.fx = shiftFx(c.fx, dt);
    return x;
  };
  if (keepLeft) out.push(withFx({ ...c, out: s, zoom: c.zoom.filter((z) => z.s < s) }, 0));
  if (keepRight) {
    const right: Clip = withFx({ ...c, in: e, zoom: c.zoom.filter((z) => z.s >= e), trans: keepLeft ? undefined : c.trans }, (e - c.in) / c.speed);
    if (keepLeft) {
      right.id = nextId(tl, 'c');
      for (const item of [...tl.gfx, ...tl.broll, ...tl.sfx]) {
        if (item.ref.clip === c.id && item.ref.t !== undefined && item.ref.t >= e - 1e-6) {
          item.ref.clip = right.id;
        }
      }
    }
    out.push(right);
  }
  return out;
}

/**
 * Source-wide removal: removes [s, e) of `src` from EVERY clip that uses it. This is the intended
 * semantics for transcript edits (`delete`, `tighten`): a word removed from a source is removed
 * wherever that footage appears. Returns removed SOURCE seconds.
 */
export function removeSrcRange(tl: Timeline, src: string, s: number, e: number): number {
  if (e <= s) return 0;
  let removed = 0;
  const next: Clip[] = [];
  for (const c of tl.clips) {
    if (c.src !== src || e <= c.in || s >= c.out) {
      next.push(c);
      continue;
    }
    removed += Math.min(e, c.out) - Math.max(s, c.in);
    next.push(...splitClip(tl, c, s, e));
  }
  tl.clips = next;
  return removed;
}

/**
 * Timeline cut: removes timeline range [a, b) from exactly the placed clips that intersect it.
 * Other occurrences of the same source footage are left untouched. Returns removed TIMELINE
 * seconds (duration before minus after, so speed, transition overlap and dropped slivers count).
 */
export function cutTimeline(tl: Timeline, a: number, b: number): number {
  if (b <= a) throw new TmepError('E_RANGE', `empty range ${a}-${b}`);
  const before = duration(tl);
  const ranges = new Map<string, [number, number]>();
  for (const p of layout(tl)) {
    const s = Math.max(a, p.start);
    const e = Math.min(b, p.start + p.dur);
    if (e <= s) continue;
    // placed durations are frame-quantised, so clamp the mapped source range to the clip's own in/out
    const c = p.clip;
    const ss = Math.max(c.in, c.in + (s - p.start) * c.speed);
    const se = Math.min(c.out, c.in + (e - p.start) * c.speed);
    if (se > ss) ranges.set(c.id, [ss, se]);
  }
  tl.clips = tl.clips.flatMap((c) => {
    const r = ranges.get(c.id);
    return r ? splitClip(tl, c, r[0], r[1]) : [c];
  });
  return Math.max(0, before - duration(tl));
}

export function findClip(tl: Timeline, id: string): Clip {
  const c = tl.clips.find((x) => x.id === id);
  if (!c) throw new TmepError('E_NOT_FOUND', `clip ${id} not found`, `clips: ${tl.clips.map((x) => x.id).slice(0, 12).join(',')}`);
  return c;
}
