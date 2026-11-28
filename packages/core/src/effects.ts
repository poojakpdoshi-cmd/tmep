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

// Phase 4A adds professional curves; every curve has identical JS (ease) and FFmpeg (easeExpr) forms.
export const EASES = ['linear', 'in', 'out', 'io', 'back', 'spring', 'hold', 'expo', 'expoio', 'circ', 'smooth', 'elastic', 'bounce', 'snap'] as const;
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

export type MaskShape = 'rect' | 'ellipse' | 'poly' | 'concave' | 'bezier';
export type RevealFrom = 'center' | 'left' | 'right' | 'top' | 'bottom';

export interface MaskKey {
  t: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  r?: number;
  feather?: number;
  e?: Ease;
}

export interface BezierSegment {
  cp1: [number, number];
  cp2: [number, number];
  to: [number, number];
}

export interface FxMask {
  type: 'mask';
  shape: MaskShape;
  /** rect/ellipse: centre and size as fractions of the frame. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** poly/concave: polygon vertices as frame fractions; bezier: [start, ...control/end] */
  pts?: [number, number][];
  /** bezier: start point + cubic bezier segments in frame fractions. */
  bezierStart?: [number, number];
  beziers?: BezierSegment[];
  /** Edge softness as a fraction of min(frame width, height). */
  feather: number;
  invert: boolean;
  reveal?: { at: number; d: number; e: Ease; from: RevealFrom };
  /** Animated mask properties over clip-local time. */
  keys?: MaskKey[];
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'softlight' | 'hardlight' | 'difference' | 'addition';
export const BLEND_MODES: readonly BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'softlight', 'hardlight', 'difference', 'addition'];

export interface FxBlur {
  type: 'blur';
  mode: 'gaussian' | 'directional';
  sigma: number;
  angle?: number;
}

export interface FxGlow {
  type: 'glow';
  radius: number;
  intensity: number;
  brightness?: number;
}

export interface FxShadow {
  type: 'shadow';
  dx: number;
  dy: number;
  blur: number;
  opacity: number;
  color?: string;
}

export interface FxBlend {
  type: 'blend';
  mode: BlendMode;
  opacity?: number;
}

export interface FxChromaKey {
  type: 'chromakey';
  color: string;
  similarity: number;
  blend: number;
  despill?: boolean;
}

export interface FxMotionBlur {
  type: 'mblur';
  frames: number;
  decay?: number;
}

export interface FxPerspective {
  type: 'persp';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
}

export interface ColorGrade {
  exposure?: number;
  contrast?: number;
  temp?: number;
  tint?: number;
  saturation?: number;
  vibrance?: number;
  highlights?: number;
  shadows?: number;
  curves?: { master?: string; r?: string; g?: string; b?: string };
  lut?: string;
  vignette?: number;
  inputColorSpace?: 'auto' | 'bt709' | 'bt601' | 'bt2020' | 'hlg' | 'pq';
}

export type Effect = FxTransform | FxMask | FxBlur | FxGlow | FxShadow | FxBlend | FxChromaKey | FxMotionBlur | FxPerspective;

export const FX_PRESETS = ['zoomin', 'zoomout', 'push', 'pull', 'panleft', 'panright', 'panup', 'pandown'] as const;
export const FX_KINDS = ['kf', 'mask', 'blur', 'glow', 'shadow', 'blend', 'chromakey', 'mblur', 'persp', 'chain', 'clear', ...FX_PRESETS] as const;

export const EFFECT_CHAINS: Record<string, () => Effect[]> = {
  'cinematic-vignette': () => [{ type: 'kf', keys: [{ t: 0, s: 1.02 }, { t: 4, s: 1.06, e: 'linear' }] }],
  'soft-glow-warm': () => [{ type: 'glow', radius: 12, intensity: 0.35, brightness: 0.04 }],
  'crisp-callout': () => [{ type: 'shadow', dx: 0, dy: 8, blur: 18, opacity: 0.45, color: '#000000' }],
  'dreamy-blur': () => [{ type: 'blur', mode: 'gaussian', sigma: 6 }, { type: 'glow', radius: 14, intensity: 0.4 }],
  'chroma-clean': () => [{ type: 'chromakey', color: '#00ff00', similarity: 0.14, blend: 0.08, despill: true }],
};

export interface TransitionPreset {
  type: string;
  d: number;
  luma?: boolean;
}

export const TRANSITION_PRESETS: Record<string, TransitionPreset> = {
  'cinematic-dissolve': { type: 'dissolve', d: 0.5 },
  'whip-pan-left': { type: 'smoothleft', d: 0.28 },
  'whip-pan-right': { type: 'smoothright', d: 0.28 },
  'luma-fade': { type: 'luma', d: 0.45, luma: true },
  'flash-cut': { type: 'fadewhite', d: 0.25 },
  'iris-open': { type: 'circleopen', d: 0.45 },
};

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
    case 'spring':
      return p <= 0 ? 0 : p >= 1 ? 1 : 1 - Math.exp(-6 * p) * Math.cos(p * Math.PI * 2.5);
    case 'hold':
      return p >= 1 ? 1 : 0;
    case 'expo': // exponential ease-out: fast start, long settle (UI/kinetic type standard)
      return p >= 1 ? 1 : 1 - 2 ** (-10 * p);
    case 'expoio':
      return p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? 2 ** (20 * p - 10) / 2 : (2 - 2 ** (-20 * p + 10)) / 2;
    case 'circ':
      return Math.sqrt(1 - (p - 1) ** 2);
    case 'smooth': // smootherstep: zero velocity and acceleration at both ends
      return p * p * p * (p * (6 * p - 15) + 10);
    case 'elastic':
      return p <= 0 ? 0 : p >= 1 ? 1 : 2 ** (-10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    case 'bounce': {
      const n1 = 7.5625, d1 = 2.75;
      if (p < 1 / d1) return n1 * p * p;
      if (p < 2 / d1) return n1 * (p -= 1.5 / d1) * p + 0.75;
      if (p < 2.5 / d1) return n1 * (p -= 2.25 / d1) * p + 0.9375;
      return n1 * (p -= 2.625 / d1) * p + 0.984375;
    }
    case 'snap': // critically-damped spring: quick, no overshoot
      return p >= 1 ? 1 : 1 - (1 + 8 * p) * Math.exp(-8 * p) * (1 - p) - p * Math.exp(-8);
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

/** Parse "x,y x,y ..." or [[x,y],...] into points; require a convex, non-degenerate polygon when requireConvex=true. */
export function parsePoints(v: unknown, requireConvex = true): [number, number][] {
  let pts: [number, number][];
  if (Array.isArray(v)) pts = v as [number, number][];
  else if (typeof v === 'string') pts = v.trim().split(/\s+/).map((p) => p.split(',').map(Number) as [number, number]);
  else throw bad('poly mask needs pts', 'pts="0.2,0.2 0.8,0.2 0.5,0.8"');
  if (pts.length < 3 || pts.length > (requireConvex ? 16 : 64)) throw bad(`poly needs 3..${requireConvex ? 16 : 64} points (got ${pts.length})`);
  for (const p of pts) if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => Number.isFinite(n) && n >= -1 && n <= 2)) throw bad(`bad point ${JSON.stringify(p)}`, 'points are frame fractions "x,y"');
  let sign = 0;
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[(i + 1) % pts.length]!;
    area2 += ax * by - bx * ay;
    const [cx, cy] = pts[(i + 2) % pts.length]!;
    const cr = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cr) < 1e-9) continue;
    if (requireConvex && sign && Math.sign(cr) !== sign) throw bad('poly mask must be convex', 'use shape=concave for concave polygons');
    sign = Math.sign(cr);
  }
  if (Math.abs(area2) < 1e-9) throw bad('poly mask is degenerate (zero area)');
  return pts.map(([x, y]) => [x, y]);
}

export function validateMaskKeys(keys: MaskKey[]): MaskKey[] {
  if (!Array.isArray(keys) || !keys.length) throw bad('mask keys need at least one key');
  const out = keys.map((k) => {
    if (typeof k.t !== 'number' || !Number.isFinite(k.t) || k.t < 0) throw bad(`mask key time must be >= 0 (got ${k.t})`);
    const n: MaskKey = { t: k.t };
    for (const p of ['x', 'y', 'w', 'h', 'r', 'feather'] as const) {
      if (k[p] === undefined) continue;
      if (typeof k[p] !== 'number' || !Number.isFinite(k[p]!)) throw bad(`mask key ${p} must be finite`);
      if ((p === 'w' || p === 'h') && k[p]! <= 0) throw bad(`mask key ${p} must be > 0`);
      if (p === 'feather' && (k[p]! < 0 || k[p]! > 0.5)) throw bad('mask key feather must be in [0, 0.5]');
      n[p] = k[p];
    }
    if (k.e !== undefined) {
      if (!EASES.includes(k.e)) throw bad(`unknown easing "${k.e}"`);
      n.e = k.e;
    }
    return n;
  });
  out.sort((a, b) => a.t - b.t);
  return out;
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
  if (!['rect', 'ellipse', 'poly', 'concave', 'bezier'].includes(m.shape)) {
    throw bad(`unknown mask shape "${m.shape}"`, 'shapes: rect,ellipse,poly,concave,bezier');
  }
  if ((m.shape === 'rect' || m.shape === 'ellipse') && (!(m.w > 0) || !(m.h > 0))) throw bad('mask w and h must be > 0');
  if (m.shape === 'poly') m.pts = parsePoints(m.pts, true);
  if (m.shape === 'concave') m.pts = parsePoints(m.pts, false);
  if (m.shape === 'bezier') {
    if (!m.bezierStart || !Array.isArray(m.beziers) || m.beziers.length < 2) {
      throw bad('bezier mask needs bezierStart and >= 2 bezier segments');
    }
    for (const seg of m.beziers) {
      for (const pt of [seg.cp1, seg.cp2, seg.to]) {
        if (!Array.isArray(pt) || pt.length !== 2 || !pt.every((n) => Number.isFinite(n) && n >= -1 && n <= 2)) {
          throw bad(`bad bezier point ${JSON.stringify(pt)}`);
        }
      }
    }
  }
  if (!(m.feather >= 0 && m.feather <= 0.5)) throw bad('feather must be in [0, 0.5] (fraction of the short frame side)');
  if (m.reveal && !(m.reveal.d > 0)) throw bad('reveal duration must be > 0');
  if (m.keys) m.keys = validateMaskKeys(m.keys);
  return m;
}

export function validateEffect(e: Effect): Effect {
  switch (e.type) {
    case 'kf':
      return { type: 'kf', keys: validateKeys(e.keys) };
    case 'mask':
      return validateMask({ ...e });
    case 'blur':
      if (!['gaussian', 'directional'].includes(e.mode)) throw bad('blur mode must be gaussian|directional');
      if (!(e.sigma > 0 && e.sigma <= 100)) throw bad('blur sigma must be in (0, 100]');
      return e;
    case 'glow':
      if (!(e.radius > 0 && e.radius <= 100)) throw bad('glow radius must be in (0, 100]');
      if (!(e.intensity >= 0 && e.intensity <= 1)) throw bad('glow intensity must be in [0, 1]');
      return e;
    case 'shadow':
      if (!(e.blur >= 0 && e.blur <= 100) || !(e.opacity >= 0 && e.opacity <= 1)) throw bad('invalid shadow blur/opacity');
      return e;
    case 'blend':
      if (!BLEND_MODES.includes(e.mode)) throw bad(`unknown blend mode "${e.mode}"`);
      if (e.opacity !== undefined && !(e.opacity >= 0 && e.opacity <= 1)) throw bad('blend opacity must be in [0, 1]');
      return e;
    case 'chromakey':
      if (!(e.similarity > 0 && e.similarity <= 1) || !(e.blend >= 0 && e.blend <= 1)) throw bad('chromakey similarity in (0,1], blend in [0,1]');
      return e;
    case 'mblur':
      if (!Number.isInteger(e.frames) || e.frames < 2 || e.frames > 16) throw bad('mblur frames must be integer 2..16');
      return e;
    case 'persp':
      for (const k of ['x0', 'y0', 'x1', 'y1', 'x2', 'y2', 'x3', 'y3'] as const) {
        if (!Number.isFinite(e[k]) || e[k] < -0.5 || e[k] > 1.5) throw bad(`persp ${k} out of range [-0.5, 1.5]`);
      }
      return e;
  }
}

export function shiftFx(fx: Effect[] | undefined, dt: number): Effect[] | undefined {
  if (!fx) return undefined;
  const out = structuredClone(fx);
  if (Math.abs(dt) < 1e-9) return out;
  const r = (x: number) => Math.round((x - dt) * 1e6) / 1e6;
  for (const f of out) {
    if (f.type === 'kf') for (const k of f.keys) k.t = r(k.t);
    else if (f.type === 'mask') {
      if (f.reveal) f.reveal.at = r(f.reveal.at);
      if (f.keys) for (const k of f.keys) k.t = r(k.t);
    }
  }
  return out;
}

export function scaleFx(fx: Effect[] | undefined, k: number): Effect[] | undefined {
  if (!fx) return undefined;
  const out = structuredClone(fx);
  if (Math.abs(k - 1) < 1e-12) return out;
  const r = (x: number) => Math.round(x * k * 1e6) / 1e6;
  for (const f of out) {
    if (f.type === 'kf') for (const key of f.keys) key.t = r(key.t);
    else if (f.type === 'mask') {
      if (f.reveal) {
        f.reveal.at = r(f.reveal.at);
        f.reveal.d = Math.max(1e-6, r(f.reveal.d));
      }
      if (f.keys) for (const mk of f.keys) mk.t = r(mk.t);
    }
  }
  return out;
}

/** One-line summary for compact tool output, e.g. "kf3 mask:ellipse". */
export function fxSummary(fx: Effect[] | undefined): string {
  return (fx ?? [])
    .map((f) => {
      if (f.type === 'kf') return `kf${f.keys.length}`;
      if (f.type === 'mask') return `mask:${f.shape}${f.invert ? '!' : ''}${f.reveal ? '+rv' : ''}${f.keys ? '+k' : ''}`;
      return f.type;
    })
    .join(' ');
}
