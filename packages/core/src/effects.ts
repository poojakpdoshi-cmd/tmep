/**
 * Professional effects model (Phase 2.3): keyframed transforms and shape masks attached to clips.
 *
 *  - All effect times are CLIP-LOCAL output seconds (0 = first frame of the clip on the timeline).
 *  - Transform keyframes animate scale `s`, position `x`/`y` (fraction of frame width/height, +x right,
 *    +y down), rotation `r` (degrees, clockwise) and opacity `o` (0..1). Each key's `e` is the easing
 *    used to arrive at that key from the previous one.
 *  - Several transform effects on one clip compose: scales and opacities multiply, offsets and rotations add.
 *  - Masks are evaluated in frame space after the transform; several masks intersect.
 *  - Motion presets (zoomin/zoomout/push/pull/pan*) compile to ordinary keyframes, so they stay editable.
 *
 * The same easing definitions are used by `sampleKeys` (JS, for tests/inspection) and by the FFmpeg
 * expression compiler in packages/render/src/effects.ts.
 */
import { TmepError } from './errors.ts';

export const EASES = ['linear', 'in', 'out', 'io', 'back', 'hold'] as const;
export type Ease = (typeof EASES)[number];
export const KEY_PROPS = ['s', 'x', 'y', 'r', 'o'] as const;
export type KeyProp = (typeof KEY_PROPS)[number];
export const KEY_DEFAULTS: Record<KeyProp, number> = { s: 1, x: 0, y: 0, r: 0, o: 1 };

export interface Key {
  t: number;
  s?: number;
  x?: number;
  y?: number;
  r?: number;
  o?: number;
  e?: Ease;
}

export interface FxTransform {
  type: 'kf';
  keys: Key[];
}

export type MaskShape = 'rect' | 'ellipse' | 'poly';
export type RevealFrom = 'center' | 'left' | 'right' | 'top' | 'bottom';

export interface FxMask {
  type: 'mask';
  shape: MaskShape;
  /** rect/ellipse: centre and size as fractions of the frame. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** poly: convex polygon vertices as frame fractions. */
  pts?: [number, number][];
  /** Edge softness as a fraction of min(frame width, height). */
  feather: number;
  invert: boolean;
  reveal?: { at: number; d: number; e: Ease; from: RevealFrom };
}

export type Effect = FxTransform | FxMask;

export const FX_PRESETS = ['zoomin', 'zoomout', 'push', 'pull', 'panleft', 'panright', 'panup', 'pandown'] as const;
export const FX_KINDS = ['kf', 'mask', 'clear', ...FX_PRESETS] as const;

/** Easing curve on p in [0,1] (JS). Must match easeExpr in the renderer. */
export function ease(e: Ease, p: number): number {
  p = Math.min(1, Math.max(0, p));
  switch (e) {
    case 'linear':
      return p;
    case 'in':
      return p * p * p;
    case 'out':
      return 1 - (1 - p) ** 3;
    case 'io':
      return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    case 'back':
      return 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2;
    case 'hold':
      return p >= 1 ? 1 : 0;
  }
}

/** Value of property `prop` at clip time t (piecewise, eased; constant before the first / after the last key). */
export function sampleKeys(keys: Key[], prop: KeyProp, t: number): number {
  const ks = keys.filter((k) => k[prop] !== undefined);
  if (!ks.length) return KEY_DEFAULTS[prop];
  if (t <= ks[0]!.t) return ks[0]![prop]!;
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1]!;
    const b = ks[i]!;
    if (t < b.t) return a[prop]! + (b[prop]! - a[prop]!) * ease(b.e ?? 'io', (t - a.t) / (b.t - a.t));
  }
  return ks[ks.length - 1]![prop]!;
}

const bad = (msg: string, hint?: string) => new TmepError('E_INPUT', msg, hint);
const LIMITS: Record<KeyProp, [number, number]> = { s: [0.05, 10], x: [-2, 2], y: [-2, 2], r: [-3600, 3600], o: [0, 1] };

/** Validate + normalise keys (sorted, unique times, ranges). */
export function validateKeys(keys: Key[]): Key[] {
  if (!Array.isArray(keys) || keys.length < 1) throw bad('kf needs at least one key', 'keys="0:s=1;1.5:s=1.2,e=out"');
  const out = keys.map((k) => {
    if (typeof k.t !== 'number' || !Number.isFinite(k.t) || k.t < 0) throw bad(`key time must be >= 0 (got ${k.t})`);
    const n: Key = { t: k.t };
    for (const p of KEY_PROPS) {
      const v = k[p];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < LIMITS[p][0] || v > LIMITS[p][1]) throw bad(`key ${p}=${v} out of range [${LIMITS[p].join(',')}]`);
      n[p] = v;
    }
    if (k.e !== undefined) {
      if (!EASES.includes(k.e)) throw bad(`unknown easing "${k.e}"`, `easings: ${EASES.join(',')}`);
      n.e = k.e;
    }
    if (KEY_PROPS.every((p) => n[p] === undefined)) throw bad(`key at t=${k.t} sets no property`, 'props: s x y r o');
    return n;
  });
  out.sort((a, b) => a.t - b.t);
  for (let i = 1; i < out.length; i++) if (out[i]!.t - out[i - 1]!.t < 1e-3) throw bad(`duplicate key time ${out[i]!.t}`);
  return out;
}

/** Compact key syntax: "0:s=1,o=0;0.5:s=1.2,o=1,e=out" (or a JSON array of Key). */
export function parseKeys(v: unknown): Key[] {
  if (Array.isArray(v)) return validateKeys(v as Key[]);
  if (typeof v !== 'string' || !v.trim()) throw bad('keys must be a string or array', 'keys="0:s=1;1.5:s=1.2,e=out"');
  const keys = v.split(';').filter((x) => x.trim()).map((seg) => {
    const m = /^\s*(-?[\d.]+)\s*:(.*)$/.exec(seg);
    if (!m) throw bad(`bad key "${seg}"`, 'form: t:prop=value,prop=value');
    const k: Record<string, unknown> = { t: Number(m[1]) };
    for (const kv of m[2]!.split(',').filter((x) => x.trim())) {
      const [name, val] = kv.split('=').map((x) => x.trim());
      if (!name || val === undefined) throw bad(`bad key property "${kv}"`);
      if (name === 'e') k.e = val;
      else if ((KEY_PROPS as readonly string[]).includes(name)) k[name] = Number(val);
      else throw bad(`unknown key property "${name}"`, 'props: s x y r o e');
    }
    return k as unknown as Key;
  });
  return validateKeys(keys);
}

/** Parse "x,y x,y ..." or [[x,y],...] into points; require a convex, non-degenerate polygon. */
export function parsePoints(v: unknown): [number, number][] {
  let pts: [number, number][];
  if (Array.isArray(v)) pts = v as [number, number][];
  else if (typeof v === 'string') pts = v.trim().split(/\s+/).map((p) => p.split(',').map(Number) as [number, number]);
  else throw bad('poly mask needs pts', 'pts="0.2,0.2 0.8,0.2 0.5,0.8"');
  if (pts.length < 3 || pts.length > 16) throw bad(`poly needs 3..16 points (got ${pts.length})`);
  for (const p of pts) if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => Number.isFinite(n) && n >= -1 && n <= 2)) throw bad(`bad point ${JSON.stringify(p)}`, 'points are frame fractions "x,y"');
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[(i + 1) % pts.length]!;
    const [cx, cy] = pts[(i + 2) % pts.length]!;
    const cr = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cr) < 1e-9) continue;
    if (sign && Math.sign(cr) !== sign) throw bad('poly mask must be convex', 'split a concave shape into several masks or use rect/ellipse');
    sign = Math.sign(cr);
  }
  if (!sign) throw bad('poly mask is degenerate (zero area)');
  return pts.map(([x, y]) => [x, y]);
}

/** Build preset keyframes. `d` = duration (s), `at` = start (clip time), `amt` = strength. */
export function presetKeys(kind: (typeof FX_PRESETS)[number], at: number, d: number, amt: number | undefined, e: Ease | undefined): Key[] {
  const end = at + Math.max(0.05, d);
  switch (kind) {
    case 'zoomin':
      return validateKeys([{ t: at, s: 1 }, { t: end, s: 1 + (amt ?? 0.15), e: e ?? 'io' }]);
    case 'zoomout':
      return validateKeys([{ t: at, s: 1 + (amt ?? 0.15) }, { t: end, s: 1, e: e ?? 'io' }]);
    case 'push':
      return validateKeys([{ t: at, s: 1 }, { t: end, s: 1 + (amt ?? 0.08), e: e ?? 'linear' }]);
    case 'pull':
      return validateKeys([{ t: at, s: 1 + (amt ?? 0.08) }, { t: end, s: 1, e: e ?? 'linear' }]);
    default: {
      // pans: scale up just enough that the travel never exposes the frame edge
      const a = amt ?? 0.12;
      const m = a / 2;
      const axis = kind === 'panleft' || kind === 'panright' ? 'x' : 'y';
      const dir = kind === 'panleft' || kind === 'panup' ? -1 : 1;
      return validateKeys([
        { t: at, s: 1 + a, [axis]: -dir * m },
        { t: end, s: 1 + a, [axis]: dir * m, e: e ?? 'io' },
      ] as Key[]);
    }
  }
}

export function validateMask(m: FxMask): FxMask {
  if (!['rect', 'ellipse', 'poly'].includes(m.shape)) throw bad(`unknown mask shape "${m.shape}"`, 'shapes: rect,ellipse,poly');
  if (m.shape !== 'poly' && (!(m.w > 0) || !(m.h > 0))) throw bad('mask w and h must be > 0');
  if (m.shape === 'poly') m.pts = parsePoints(m.pts);
  if (!(m.feather >= 0 && m.feather <= 0.5)) throw bad('feather must be in [0, 0.5] (fraction of the short frame side)');
  if (m.reveal && !(m.reveal.d > 0)) throw bad('reveal duration must be > 0');
  return m;
}

/** One-line summary for compact tool output, e.g. "kf3 mask:ellipse". */
export function fxSummary(fx: Effect[] | undefined): string {
  return (fx ?? []).map((f) => (f.type === 'kf' ? `kf${f.keys.length}` : `mask:${f.shape}${f.invert ? '!' : ''}${f.reveal ? '+rv' : ''}`)).join(' ');
}
