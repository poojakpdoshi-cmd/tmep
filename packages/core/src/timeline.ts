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
import { type Effect, shiftFx } from './effects.ts';

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
}

/** A point in time: either absolute timeline time (`at`) or a source anchor (`src` + `t`). */
export interface TimeRef {
  at?: number;
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
  sfx: Sfx[];
  music?: Music;
  captions: Captions;
  /** Integrated loudness target in LUFS; 0 disables normalization. */
  loudness: number;
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

export function clipFrames(c: Clip, fps: number): number {
  return Math.max(1, Math.round(((c.out - c.in) / c.speed) * fps));
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
    if (c.src === src && t >= c.in - 1e-6 && t < c.out + 1e-6) return p.start + (Math.min(t, c.out) - c.in) / c.speed;
  }
  return undefined;
}

/** Map a timeline time to the clip/source position under it (topmost = later clip in transitions). */
export function tlToSrc(placed: Placed[], t: number): { p: Placed; srcT: number } | undefined {
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i]!;
    if (t >= p.start - 1e-6 && t < p.start + p.dur + 1e-6) {
      return { p, srcT: p.clip.in + (t - p.start) * p.clip.speed };
    }
  }
  return undefined;
}

export function resolveRef(placed: Placed[], ref: TimeRef): number | undefined {
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

/** Convert a resolved timeline time into a durable source anchor (falls back to absolute). */
export function anchorAt(placed: Placed[], t: number): TimeRef {
  const hit = tlToSrc(placed, t);
  return hit ? { src: hit.p.clip.src, t: Math.round(hit.srcT * 1000) / 1000 } : { at: t };
}

/** Remove a source range from every clip that uses it, splitting clips as needed. */
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
    const keepLeft = s - c.in > 0.04;
    const keepRight = c.out - e > 0.04;
    // effects use clip-local output time: the right part continues where the original was at `e`
    const withFx = (x: Clip, dt: number): Clip => {
      if (c.fx) x.fx = shiftFx(c.fx, dt);
      return x;
    };
    if (keepLeft) next.push(withFx({ ...c, out: s, zoom: c.zoom.filter((z) => z.s < s) }, 0));
    if (keepRight) {
      const right: Clip = withFx({ ...c, in: e, zoom: c.zoom.filter((z) => z.s >= e), trans: keepLeft ? undefined : c.trans }, (e - c.in) / c.speed);
      if (keepLeft) right.id = nextId(tl, 'c');
      next.push(right);
    }
  }
  tl.clips = next;
  return removed;
}

/** Remove a timeline range [a, b). Returns seconds removed. */
export function cutTimeline(tl: Timeline, a: number, b: number): number {
  if (b <= a) throw new TmepError('E_RANGE', `empty range ${a}-${b}`);
  const placed = layout(tl);
  const ranges: [string, number, number][] = [];
  for (const p of placed) {
    const s = Math.max(a, p.start);
    const e = Math.min(b, p.start + p.dur);
    if (e > s) ranges.push([p.clip.src, p.clip.in + (s - p.start) * p.clip.speed, p.clip.in + (e - p.start) * p.clip.speed]);
  }
  let removed = 0;
  for (const [src, s, e] of ranges) removed += removeSrcRange(tl, src, s, e);
  return removed;
}

export function findClip(tl: Timeline, id: string): Clip {
  const c = tl.clips.find((x) => x.id === id);
  if (!c) throw new TmepError('E_NOT_FOUND', `clip ${id} not found`, `clips: ${tl.clips.map((x) => x.id).slice(0, 12).join(',')}`);
  return c;
}
