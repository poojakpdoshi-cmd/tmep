/**
 * TMEP edit operations: small, declarative, incremental changes applied to a timeline.
 *
 * An op is either an object  {op:"zoom", at:"@generative", to:1.2}
 * or the equivalent compact string  "zoom @generative to=1.2"
 * (positional args follow POSITIONAL[op]; other args are key=value; quote values
 * containing spaces with '...' or "...").
 *
 * Times accept anchors (see resolveAnchor): seconds, "@phrase", "w:N", "c:ID", "end".
 * Ops resolve anchors to SOURCE time so later edits do not desynchronise them.
 */
import { TmepError } from './errors.ts';
import { obj, str, num, bool, oneOf, arr, any, union, record, formatIssues, closest, type Schema } from './schema.ts';
import {
  type Timeline,
  type Word,
  type Ratio,
  RATIOS,
  layout,
  timelineWords,
  resolveAnchor,
  anchorAt,
  tlToSrc,
  cutTimeline,
  removeSrcRange,
  findClip,
  newClip,
  nextId,
  duration,
  srcToTl,
} from './timeline.ts';
import { r2 } from './util.ts';
import { visualSceneSchema, type VisualScene } from './scene.ts';
import {
  FX_KINDS, FX_PRESETS, EASES, BLEND_MODES, EFFECT_CHAINS, TRANSITION_PRESETS,
  parseKeys, presetKeys, validateMask, validateEffect, shiftFx, scaleFx,
  type Effect, type FxMask, type Ease, type RevealFrom, type BlendMode, type ColorGrade,
} from './effects.ts';

export interface OpContext {
  transcripts: Record<string, Word[] | undefined>;
  assets: Record<string, { dur: number; kind: string }>;
  presets?: string[];
  sfxKinds?: string[];
}

const anchor = union([num(), str({ min: 1 })]);
const ratio = oneOf(['9:16', '16:9', '1:1', '4:5'] as const);
const fit = oneOf(['cover', 'contain', 'blur'] as const);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const TRANSITIONS = ['fade', 'dissolve', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'slideup', 'smoothleft', 'smoothright', 'smoothup', 'circleopen', 'zoomin', 'radial', 'luma', 'none', ...Object.keys(TRANSITION_PRESETS)] as const;

export const OP_SCHEMAS: Record<string, Schema<Record<string, unknown>>> = {
  cut: obj({ op: str(), from: anchor, to: anchor.optional() }),
  delete: obj({ op: str(), text: str({ min: 1 }).optional(), fillers: bool().optional(), pad: num({ min: 0, max: 0.5 }).default(0.03) }),
  tighten: obj({ op: str(), max: num({ min: 0.05, max: 5 }).default(0.35), pad: num({ min: 0, max: 0.5 }).default(0.08) }),
  keep: obj({ op: str(), src: str(), ranges: arr(arr(num(), { min: 2, max: 2 }), { min: 1 }), append: bool().default(false) }),
  add: obj({ op: str(), src: str(), in: num({ min: 0 }).default(0), out: num({ min: 0 }).optional(), index: num({ int: true, min: 0 }).optional() }),
  trim: obj({ op: str(), clip: str(), in: num({ min: 0 }).optional(), out: num({ min: 0 }).optional() }),
  move: obj({ op: str(), clip: str(), index: num({ int: true, min: 0 }) }),
  remove: obj({ op: str(), id: str() }),
  speed: obj({ op: str(), clip: str().optional(), x: num({ min: 0.25, max: 4 }) }),
  frame: obj({ op: str(), clip: str().optional(), fit: fit.optional(), cx: num({ min: 0, max: 1 }).optional(), cy: num({ min: 0, max: 1 }).optional(), base: num({ min: 1, max: 3 }).optional(), push: num({ min: 0, max: 1 }).optional() }),
  zoom: obj({ op: str(), at: anchor, d: num({ min: 0.1, max: 30 }).default(0.9), to: num({ min: 1, max: 3 }).default(1.15), mode: oneOf(['punch', 'smooth'] as const).default('punch') }),
  transition: obj({ op: str(), type: oneOf(TRANSITIONS), d: num({ min: 0, max: 2 }).default(0.35), clip: str().optional(), at: anchor.optional(), all: bool().default(false) }),
  broll: obj({ op: str(), src: str(), at: anchor, d: num({ min: 0.2, max: 600 }), in: num({ min: 0 }).default(0), fit: fit.default('cover'), z: num({ int: true, min: -100, max: 100 }).optional() }),
  gfx: obj({ op: str(), preset: str(), at: anchor, d: num({ min: 0.2, max: 600 }).default(2.5), props: record(any()).default({}), z: num({ int: true, min: -100, max: 100 }).optional() }),
  scene: obj({ op: str(), spec: visualSceneSchema }),
  set: obj({ op: str(), id: str(), at: anchor.optional(), d: num({ min: 0.1, max: 600 }).optional(), props: record(any()).optional(), vol: num({ min: -60, max: 12 }).optional(), gain: num({ min: 0, max: 4 }).optional(), mute: bool().optional(), z: num({ int: true, min: -100, max: 100 }).optional() }),
  captions: obj({
    op: str(),
    style: oneOf(['kinetic', 'karaoke', 'clean', 'boxed', 'none'] as const).optional(),
    pos: oneOf(['lower', 'middle', 'upper'] as const).optional(),
    maxWords: num({ int: true, min: 1, max: 8 }).optional(),
    upper: bool().optional(),
    color: str({ pattern: /^#[0-9a-fA-F]{6}$/ }).optional(),
    accent: str({ pattern: /^#[0-9a-fA-F]{6}$/ }).optional(),
    size: num({ min: 0.4, max: 2.5 }).optional(),
    font: str().optional(),
    emphasis: bool().optional(),
    script: oneOf(['latin', 'native'] as const).optional(),
  }),
  fix: obj({ op: str(), find: str({ min: 1 }), replace: str() }),
  music: obj({ op: str(), src: str().optional(), vol: num({ min: -60, max: 12 }).default(-18), duck: bool().default(true), fade: num({ min: 0, max: 10 }).default(1.5), off: bool().default(false) }),
  sfx: obj({ op: str(), kind: str(), at: anchor, vol: num({ min: -60, max: 12 }).default(-12) }),
  format: obj({ op: str(), ratio: ratio.optional(), fps: num({ int: true, min: 12, max: 60 }).optional() }),
  loudness: obj({ op: str(), lufs: num({ min: -40, max: 0 }) }),
  fx: obj({
    op: str(),
    kind: oneOf(FX_KINDS),
    clip: str().optional(),
    at: num({ min: 0 }).default(0),
    d: num({ min: 0.05, max: 600 }).optional(),
    amt: num({ min: -0.9, max: 3 }).optional(),
    e: oneOf(EASES).optional(),
    keys: any().optional(),
    shape: oneOf(['rect', 'ellipse', 'poly', 'concave', 'bezier'] as const).default('rect'),
    x: num({ min: -1, max: 2 }).default(0.5),
    y: num({ min: -1, max: 2 }).default(0.5),
    w: num({ min: 0, max: 4 }).default(0.8),
    h: num({ min: 0, max: 4 }).default(0.8),
    pts: any().optional(),
    bezierStart: any().optional(),
    beziers: any().optional(),
    feather: num({ min: 0, max: 0.5 }).default(0),
    invert: bool().default(false),
    reveal: num({ min: 0.05, max: 600 }).optional(),
    from: oneOf(['center', 'left', 'right', 'top', 'bottom'] as const).default('center'),
    mode: str().optional(),
    sigma: num({ min: 0.1, max: 100 }).optional(),
    angle: num({ min: -360, max: 360 }).optional(),
    radius: num({ min: 0.1, max: 100 }).optional(),
    intensity: num({ min: 0, max: 1 }).optional(),
    brightness: num({ min: -1, max: 1 }).optional(),
    dx: num({ min: -200, max: 200 }).optional(),
    dy: num({ min: -200, max: 200 }).optional(),
    blur: num({ min: 0, max: 100 }).optional(),
    opacity: num({ min: 0, max: 1 }).optional(),
    color: str().optional(),
    similarity: num({ min: 0.01, max: 1 }).optional(),
    blend: num({ min: 0, max: 1 }).optional(),
    despill: bool().optional(),
    frames: num({ int: true, min: 2, max: 16 }).optional(),
    decay: num({ min: 0, max: 1 }).optional(),
    x0: num({ min: -0.5, max: 1.5 }).optional(),
    y0: num({ min: -0.5, max: 1.5 }).optional(),
    x1: num({ min: -0.5, max: 1.5 }).optional(),
    y1: num({ min: -0.5, max: 1.5 }).optional(),
    x2: num({ min: -0.5, max: 1.5 }).optional(),
    y2: num({ min: -0.5, max: 1.5 }).optional(),
    x3: num({ min: -0.5, max: 1.5 }).optional(),
    y3: num({ min: -0.5, max: 1.5 }).optional(),
    chain: str().optional(),
  }),
  jcut: obj({ op: str(), clip: str(), d: num({ min: 0, max: 10 }) }),
  lcut: obj({ op: str(), clip: str(), d: num({ min: 0, max: 10 }) }),
  ramp: obj({ op: str(), clip: str().optional(), keys: any() }),
  freeze: obj({ op: str(), at: anchor, d: num({ min: 0.1, max: 30 }).default(1.5) }),
  reverse: obj({ op: str(), clip: str().optional(), on: bool().default(true) }),
  punch: obj({ op: str(), at: anchor, to: num({ min: 1.01, max: 3 }).default(1.2), d: num({ min: 0.2, max: 15 }).default(1.2) }),
  matchcut: obj({ op: str(), fromClip: str(), toClip: str(), scale: num({ min: 1, max: 2 }).default(1.08), d: num({ min: 0, max: 1 }).default(0.2) }),
  reframe: obj({ op: str(), clip: str().optional(), cx: num({ min: 0, max: 1 }).optional(), cy: num({ min: 0, max: 1 }).optional(), keys: any().optional() }),
  stabilize: obj({ op: str(), clip: str().optional(), smoothing: num({ int: true, min: 1, max: 60 }).default(10), shakiness: num({ int: true, min: 1, max: 10 }).default(5), accuracy: num({ int: true, min: 1, max: 15 }).default(10), off: bool().default(false) }),
  splitscreen: obj({ op: str(), srcs: arr(str(), { min: 2, max: 4 }), at: anchor.default(0), d: num({ min: 0.2, max: 600 }).default(4), layout: oneOf(['2h', '2v', '2x2', '3v'] as const).default('2h'), gap: num({ min: 0, max: 0.1 }).default(0.01), z: num({ int: true, min: -100, max: 100 }).default(2) }),
  pip: obj({ op: str(), src: str(), at: anchor, d: num({ min: 0.2, max: 600 }).default(4), in: num({ min: 0 }).default(0), pos: oneOf(['br', 'bl', 'tr', 'tl'] as const).default('br'), scale: num({ min: 0.1, max: 0.8 }).default(0.3), feather: num({ min: 0, max: 0.1 }).default(0.01), z: num({ int: true, min: -100, max: 100 }).default(4) }),
  parallax: obj({ op: str(), srcs: arr(str(), { min: 2, max: 4 }), at: anchor.default(0), d: num({ min: 0.2, max: 600 }).default(4), drift: num({ min: 0.01, max: 0.3 }).default(0.08), z: num({ int: true, min: -100, max: 100 }).default(2) }),
  color: obj({
    op: str(),
    clip: str().optional(),
    exposure: num({ min: -3, max: 3 }).optional(),
    contrast: num({ min: 0.2, max: 3 }).optional(),
    temp: num({ min: 2000, max: 15000 }).optional(),
    tint: num({ min: -1, max: 1 }).optional(),
    saturation: num({ min: 0, max: 3 }).optional(),
    vibrance: num({ min: -1, max: 1 }).optional(),
    highlights: num({ min: -1, max: 1 }).optional(),
    shadows: num({ min: -1, max: 1 }).optional(),
    curves: record(str()).optional(),
    lut: str().optional(),
    vignette: num({ min: 0, max: 1 }).optional(),
    inputColorSpace: oneOf(['auto', 'bt709', 'bt601', 'bt2020', 'hlg', 'pq'] as const).optional(),
    clear: bool().default(false),
  }),
  audio: obj({
    op: str(),
    clip: str().optional(),
    eq: oneOf(['dialogue', 'warm', 'crisp'] as const).optional(),
    denoise: num({ min: 0, max: 1 }).optional(),
    deess: num({ min: 0, max: 1 }).optional(),
    comp: oneOf(['light', 'medium', 'heavy'] as const).optional(),
    hp: num({ min: 20, max: 500 }).optional(),
    lp: num({ min: 1000, max: 20000 }).optional(),
    fadeIn: num({ min: 0, max: 10 }).optional(),
    fadeOut: num({ min: 0, max: 10 }).optional(),
    target: oneOf(['reels', 'shorts', 'tiktok', 'youtube', 'podcast', 'broadcast', 'cinema'] as const).optional(),
    lufs: num({ min: -40, max: 0 }).optional(),
    tp: num({ min: -9, max: 0 }).optional(),
    lra: num({ min: 1, max: 20 }).optional(),
    twoPass: bool().optional(),
    limiter: num({ min: -9, max: 0 }).optional(),
  }),
};

/** Positional argument order for the compact string form. */
const POSITIONAL: Record<string, string[]> = {
  cut: ['from', 'to'],
  delete: ['text'],
  zoom: ['at', 'to', 'd'],
  gfx: ['preset', 'at', 'd'],
  sfx: ['kind', 'at', 'vol'],
  transition: ['type', 'd'],
  speed: ['x'],
  captions: ['style'],
  remove: ['id'],
  set: ['id'],
  broll: ['src', 'at', 'd'],
  music: ['src', 'vol'],
  format: ['ratio'],
  move: ['clip', 'index'],
  fix: ['find', 'replace'],
  add: ['src', 'in', 'out'],
  trim: ['clip', 'in', 'out'],
  loudness: ['lufs'],
  fx: ['kind', 'clip'],
  jcut: ['clip', 'd'],
  lcut: ['clip', 'd'],
  ramp: ['clip', 'keys'],
  freeze: ['at', 'd'],
  reverse: ['clip', 'on'],
  punch: ['at', 'to', 'd'],
  matchcut: ['fromClip', 'toClip'],
  reframe: ['clip'],
  stabilize: ['clip'],
  pip: ['src', 'at', 'd'],
  color: ['clip'],
  audio: ['clip'],
};

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /(?:[^\s'"]+|'[^']*'|"[^"]*")+/g;
  for (const m of s.matchAll(re)) out.push(m[0]);
  return out;
}

function coerce(v: string): unknown {
  const unq = v.replace(/^(['"])(.*)\1$/s, '$2');
  if (unq !== v) return unq;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  if (v.startsWith('[') || v.startsWith('{')) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** Parse the compact string form into an op object. */
export function parseOpString(line: string): Record<string, unknown> {
  const toks = tokenize(line.trim());
  const name = toks.shift();
  if (!name) throw new TmepError('E_INPUT', 'empty op');
  if (!OP_SCHEMAS[name]) {
    const hint = closest(name, Object.keys(OP_SCHEMAS));
    throw new TmepError('E_INPUT', `unknown op "${name}"`, hint ? `did you mean "${hint}"?` : `ops: ${Object.keys(OP_SCHEMAS).join(',')}`);
  }
  const out: Record<string, unknown> = { op: name };
  const pos = [...(POSITIONAL[name] ?? [])];
  // unquoted multi-word phrase anchors: "@generative ai can" -> one token
  for (let i = 0; i < toks.length; i++) {
    if (toks[i]!.startsWith('@')) {
      // A phrase ends at the next key=value, number, time (12.5s) or anchor token (@…, end, w:N, c:ID).
      const anchorLike = (x: string) => x.includes('=') || x.startsWith('@') || /^-?\d+(\.\d+)?s?$/.test(x) || /^(end|w:\S+|c:\S+)$/.test(x);
      while (i + 1 < toks.length && !anchorLike(toks[i + 1]!)) {
        toks[i] = `${toks[i]} ${toks[i + 1]}`;
        toks.splice(i + 1, 1);
      }
    }
  }
  for (const t of toks) {
    const eq = t.indexOf('=');
    if (eq > 0 && /^[a-zA-Z_.]+$/.test(t.slice(0, eq))) {
      const key = t.slice(0, eq);
      const val = coerce(t.slice(eq + 1));
      if (key.startsWith('props.')) {
        const props = (out.props as Record<string, unknown>) ?? {};
        props[key.slice(6)] = val;
        out.props = props;
      } else out[key] = val;
    } else {
      const key = pos.shift();
      if (!key) throw new TmepError('E_INPUT', `unexpected argument "${t}" for op ${name}`, `form: ${name} ${(POSITIONAL[name] ?? []).join(' ')} key=value...`);
      out[key] = coerce(t);
    }
  }
  return out;
}

export function normalizeOp(raw: unknown): Record<string, unknown> {
  const o = typeof raw === 'string' ? parseOpString(raw) : (raw as Record<string, unknown>);
  if (!o || typeof o !== 'object' || typeof o.op !== 'string') throw new TmepError('E_INPUT', 'each op needs an "op" field');
  const schema = OP_SCHEMAS[o.op];
  if (!schema) {
    const hint = closest(o.op, Object.keys(OP_SCHEMAS));
    throw new TmepError('E_INPUT', `unknown op "${o.op}"`, hint ? `did you mean "${hint}"?` : `ops: ${Object.keys(OP_SCHEMAS).join(',')}`);
  }
  const res = schema.parse(o);
  if (!res.ok) throw new TmepError('E_INPUT', `op ${o.op}: ${formatIssues(res.issues)}`);
  return res.value;
}

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'erm', 'er', 'ah', 'hmm', 'mm', 'uhm']);
const clean = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

export function isFiller(w: string): boolean {
  return FILLERS.has(clean(w));
}

/**
 * Add a transition into clip `i` with "handles": extend both clips into surrounding
 * silence so the overlap holds no speech. The duration shrinks to the silence that is
 * available; returns the applied duration (0 = not applied).
 */
/** Undo the handles a transition added (recorded since Phase 5; older revisions carry none). */
export function revertTransition(tl: Timeline, i: number): boolean {
  const c = tl.clips[i];
  const prev = tl.clips[i - 1];
  if (!c?.trans) return false;
  const reverted = c.trans.hOut !== undefined || c.trans.hIn !== undefined;
  if (prev && c.trans.hOut) prev.out = r2(prev.out - c.trans.hOut, 3);
  if (c.trans.hIn) c.in = r2(c.in + c.trans.hIn, 3);
  delete c.trans;
  return reverted;
}

export function addTransition(tl: Timeline, i: number, type: string, d: number, transcripts: Record<string, Word[] | undefined>, srcDur: (id: string) => number): number {
  const c = tl.clips[i];
  const prev = tl.clips[i - 1];
  if (!c || !prev) return 0;
  // Re-applying a transition first removes the handles the previous one added (idempotent).
  if (c.trans) revertTransition(tl, i);
  const pw = transcripts[prev.src] ?? [];
  const cw = transcripts[c.src] ?? [];
  // A word that straddles the cut leaves no silent handle on that side.
  const straddleOut = pw.some((w) => w.s < prev.out - 1e-3 && w.e > prev.out + 1e-3);
  const straddleIn = cw.some((w) => w.s < c.in - 1e-3 && w.e > c.in + 1e-3);
  const nextWordAfter = pw.length ? (pw.find((w) => w.s >= prev.out - 1e-3)?.s ?? Infinity) : Infinity;
  const prevWordBefore = cw.length ? ([...cw].reverse().find((w) => w.e <= c.in + 1e-3)?.e ?? -Infinity) : -Infinity;
  const hOut = straddleOut ? 0 : Math.max(0, Math.min(d, nextWordAfter - 0.03 - prev.out, srcDur(prev.src) - prev.out));
  const hIn = straddleIn ? 0 : Math.max(0, Math.min(d, c.in - (prevWordBefore + 0.03), c.in));
  const td = Math.min(d, hOut + hIn);
  if (td < 0.15) return 0;
  const useOut = r2(Math.min(hOut, td), 3);
  const useIn = r2(td - useOut, 3);
  prev.out = r2(prev.out + useOut, 3);
  c.in = r2(c.in - useIn, 3);
  c.trans = { type, d: r2(td, 3), hOut: useOut, hIn: useIn };
  return td;
}

/** Apply a batch of ops to a copy of `tl`. Returns the new timeline and one note per op. */
export function applyOps(tlIn: Timeline, rawOps: unknown[], ctx: OpContext): { tl: Timeline; notes: string[]; created: string[] } {
  const tl: Timeline = structuredClone(tlIn);
  const notes: string[] = [];
  const created: string[] = [];
  rawOps.forEach((raw, i) => {
    let op: Record<string, unknown>;
    try {
      op = normalizeOp(raw);
      const note = applyOne(tl, op, ctx, created);
      notes.push(note);
    } catch (e) {
      if (e instanceof TmepError) throw new TmepError(e.code, `op #${i + 1}: ${e.message}`, e.hint, e.detail);
      throw e;
    }
  });
  validateTimeline(tl, ctx);
  return { tl, notes, created };
}

function needAsset(ctx: OpContext, id: string, kinds?: string[]): { dur: number; kind: string } {
  const a = ctx.assets[id];
  if (!a) throw new TmepError('E_NOT_FOUND', `asset ${id} not found`, `assets: ${Object.keys(ctx.assets).join(',') || 'none'}`);
  if (kinds && !kinds.includes(a.kind)) throw new TmepError('E_INPUT', `asset ${id} is ${a.kind}; expected ${kinds.join('/')}`);
  return a;
}

function applyOne(tl: Timeline, op: Record<string, unknown>, ctx: OpContext, created: string[]): string {
  const words = () => timelineWords(tl, ctx.transcripts);
  const placed = () => layout(tl);
  const t = (a: unknown) => resolveAnchor(tl, words(), a);
  // A point placement (graphic, sound, zoom, freeze…) must land on the timeline.
  const pt = (a: unknown) => {
    const r = t(a);
    const dur = duration(tl);
    if (dur > 0 && r.t > dur + 1 / tl.settings.fps) throw new TmepError('E_RANGE', `time ${r.t}s is past the timeline end (${r2(dur, 3)}s)`, 'use "end" for the last frame');
    return r;
  };
  switch (op.op) {
    case 'cut': {
      const a = t(op.from);
      const b = op.to !== undefined ? t(op.to).t : a.endT;
      if (b === undefined) throw new TmepError('E_INPUT', 'cut needs "to" unless "from" is a phrase/word/clip anchor');
      const removed = cutTimeline(tl, a.t, b);
      return `cut ${r2(removed)}s`;
    }
    case 'delete': {
      const ws = words();
      const pad = op.pad as number;
      let hits: { src: string; s: number; e: number }[] = [];
      if (op.fillers) {
        hits = ws.filter((w) => isFiller(w.w)).map((w) => ({ src: w.src, s: ctx.transcripts[w.src]![w.i]!.s, e: ctx.transcripts[w.src]![w.i]!.e }));
      } else if (typeof op.text === 'string') {
        const target = op.text.toLowerCase().split(/\s+/).map(clean).filter(Boolean);
        const toks = ws.map((w) => clean(w.w));
        for (let i = 0; i + target.length <= toks.length; i++) {
          if (!target.every((x, j) => toks[i + j] === x)) continue;
          // Delete the phrase as it is heard on the timeline: one source range per run of words that
          // are consecutive in the same source (a phrase can span a cut between reordered clips).
          let run: { src: string; s: number; e: number; i: number } | undefined;
          for (let j = 0; j < target.length; j++) {
            const w = ws[i + j]!, src = ctx.transcripts[w.src]![w.i]!;
            if (run && run.src === w.src && w.i === run.i + 1) { run.e = src.e; run.i = w.i; continue; }
            if (run) hits.push({ src: run.src, s: run.s, e: run.e });
            run = { src: w.src, s: src.s, e: src.e, i: w.i };
          }
          if (run) hits.push({ src: run.src, s: run.s, e: run.e });
        }
        if (!hits.length) throw new TmepError('E_ANCHOR', `"${op.text}" not found in timeline transcript`);
      } else throw new TmepError('E_INPUT', 'delete needs text or fillers:true');
      // Remove each distinct source range once, and report the real change in timeline length.
      const before = layout(tl).reduce((m, p) => Math.max(m, p.start + p.dur), 0);
      const uniq = [...new Map(hits.map((h) => [`${h.src}:${h.s}:${h.e}`, h])).values()];
      for (const h of uniq) removeSrcRange(tl, h.src, h.s - pad, h.e + pad);
      const removed = before - layout(tl).reduce((m, p) => Math.max(m, p.start + p.dur), 0);
      if (removed <= 1e-6) {
        if (op.fillers) return 'delete 0x 0s (no fillers on the timeline)';
        throw new TmepError('E_RANGE', `"${op.text}" matched but no timeline footage was removed`, 'the matched words may be outside every clip range');
      }
      return `delete ${uniq.length}x ${r2(removed)}s`;
    }
    case 'tighten': {
      const max = op.max as number;
      const pad = op.pad as number;
      let removed = 0;
      let n = 0;
      for (const src of new Set(tl.clips.map((c) => c.src))) {
        const tr = ctx.transcripts[src];
        if (!tr?.length) continue;
        for (let i = 1; i < tr.length; i++) {
          const gapS = tr[i - 1]!.e + pad;
          const gapE = tr[i]!.s - pad;
          if (tr[i]!.s - tr[i - 1]!.e > max && gapE > gapS) {
            removed += removeSrcRange(tl, src, gapS, gapE);
            n++;
          }
        }
      }
      return `tighten ${n} gaps ${r2(removed)}s`;
    }
    case 'keep': {
      const src = op.src as string;
      const a = needAsset(ctx, src, ['video', 'audio']);
      if (!op.append) tl.clips = [];
      for (const [s, e] of op.ranges as [number, number][]) {
        if (!(e > s) || s < 0 || s >= a.dur) throw new TmepError('E_RANGE', `bad range ${s}-${e} for ${src} (dur ${r2(a.dur)})`);
        const c = newClip(tl, src, s, Math.min(e, a.dur));
        tl.clips.push(c);
        created.push(c.id);
      }
      return `keep ${(op.ranges as unknown[]).length} ranges`;
    }
    case 'add': {
      const src = op.src as string;
      const a = needAsset(ctx, src, ['video', 'image', 'audio']);
      // An image without an explicit out holds for 3 s from its in-point.
      const out = (op.out as number | undefined) ?? (a.kind === 'image' ? (op.in as number) + 3 : a.dur);
      const c = newClip(tl, src, op.in as number, a.kind === 'image' ? out : Math.min(out, a.dur));
      const idx = (op.index as number | undefined) ?? tl.clips.length;
      tl.clips.splice(idx, 0, c);
      created.push(c.id);
      return `add ${c.id}`;
    }
    case 'trim': {
      const c = findClip(tl, op.clip as string);
      const oldIn = c.in;
      if (op.in !== undefined) c.in = op.in as number;
      if (op.out !== undefined) c.out = op.out as number;
      // Clamp to the media now, so later ops in the same batch see the real range (and say so).
      const media = ctx.assets[c.src];
      let clamped = '';
      if (media && media.kind !== 'image' && media.dur > 0 && c.out > media.dur) { c.out = media.dur; clamped = ` (out clamped to media end ${media.dur}s)`; }
      if (c.out <= c.in) throw new TmepError('E_RANGE', `clip ${c.id} would be empty`);
      // effects are clip-local: moving the start keeps them on the same source content
      if (c.fx && c.in !== oldIn) c.fx = shiftFx(c.fx, (c.in - oldIn) / c.speed);
      return `trim ${c.id}${clamped}`;
    }
    case 'move': {
      const c = findClip(tl, op.clip as string);
      tl.clips = tl.clips.filter((x) => x !== c);
      tl.clips.splice(Math.min(op.index as number, tl.clips.length), 0, c);
      return `move ${c.id}`;
    }
    case 'remove': {
      const id = op.id as string;
      const sceneIndex = tl.scenes?.findIndex((scene) => scene.id === id) ?? -1;
      if (sceneIndex >= 0) {
        tl.scenes!.splice(sceneIndex, 1);
        return `remove ${id}`;
      }
      for (const key of ['clips', 'gfx', 'sfx', 'broll'] as const) {
        const list = tl[key] as { id: string }[];
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) {
          list.splice(i, 1);
          return `remove ${id}`;
        }
      }
      throw new TmepError('E_NOT_FOUND', `no clip/gfx/sfx/broll/scene with id ${id}`);
    }
    case 'speed': {
      const targets = op.clip ? [findClip(tl, op.clip as string)] : tl.clips;
      for (const c of targets) {
        // effects are clip-local output time: scale them so they stay on the same source content
        if (c.fx && c.speed !== op.x) c.fx = scaleFx(c.fx, c.speed / (op.x as number));
        c.speed = op.x as number;
      }
      return `speed x${op.x} (${targets.length} clips)`;
    }
    case 'frame': {
      const targets = op.clip ? [findClip(tl, op.clip as string)] : tl.clips;
      for (const c of targets) {
        for (const k of ['fit', 'cx', 'cy', 'base', 'push'] as const) if (op[k] !== undefined) (c as unknown as Record<string, unknown>)[k] = op[k];
      }
      return `frame ${targets.length} clips`;
    }
    case 'fx': {
      // Explicit ids can address main clips (cN), b-roll (bN), and graphics (gN).
      // With no id, preserve legacy main-track-only behavior.
      const target = op.clip
        ? tl.clips.find((c) => c.id === op.clip)
          ?? tl.broll.find((b) => b.id === op.clip)
          ?? tl.gfx.find((g) => g.id === op.clip)
        : undefined;
      if (op.clip && !target) throw new TmepError('E_NOT_FOUND', `no clip or b-roll or graphic "${op.clip}"`);
      const targets = op.clip ? [target!] : tl.clips;
      if (!targets.length) throw new TmepError('E_RANGE', 'no clips to apply fx to');
      const kind = op.kind as string;
      for (const c of targets) {
        if (kind === 'clear') {
          delete c.fx;
          continue;
        }
        let eff: Effect;
        if (kind === 'kf') {
          if (op.keys === undefined) throw new TmepError('E_INPUT', 'fx kf needs keys', 'keys="0:s=1,o=0;0.6:s=1.1,o=1,e=out"');
          eff = { type: 'kf', keys: parseKeys(op.keys) };
        } else if (kind === 'mask') {
          const m: FxMask = { type: 'mask', shape: op.shape as FxMask['shape'], x: op.x as number, y: op.y as number, w: op.w as number, h: op.h as number, feather: op.feather as number, invert: op.invert as boolean };
          if (op.pts !== undefined) m.pts = op.pts as [number, number][];
          if (op.bezierStart !== undefined) m.bezierStart = op.bezierStart as [number, number];
          if (op.beziers !== undefined) m.beziers = op.beziers as FxMask['beziers'];
          if (op.keys !== undefined) m.keys = op.keys as FxMask['keys'];
          if (op.reveal !== undefined) m.reveal = { at: op.at as number, d: op.reveal as number, e: (op.e as Ease | undefined) ?? 'out', from: op.from as RevealFrom };
          eff = validateMask(m);
        } else if (kind === 'blur') {
          eff = validateEffect({ type: 'blur', mode: (op.mode as 'gaussian' | 'directional') ?? 'gaussian', sigma: (op.sigma as number) ?? 6, ...(op.angle !== undefined ? { angle: op.angle as number } : {}) });
        } else if (kind === 'glow') {
          eff = validateEffect({ type: 'glow', radius: (op.radius as number) ?? 12, intensity: (op.intensity as number) ?? 0.4, ...(op.brightness !== undefined ? { brightness: op.brightness as number } : {}) });
        } else if (kind === 'shadow') {
          eff = validateEffect({ type: 'shadow', dx: (op.dx as number) ?? 0, dy: (op.dy as number) ?? 8, blur: (op.blur as number) ?? 16, opacity: (op.opacity as number) ?? 0.45, ...(op.color !== undefined ? { color: op.color as string } : {}) });
        } else if (kind === 'blend') {
          eff = validateEffect({ type: 'blend', mode: ((op.mode as BlendMode) ?? 'screen'), ...(op.opacity !== undefined ? { opacity: op.opacity as number } : {}) });
        } else if (kind === 'chromakey') {
          eff = validateEffect({ type: 'chromakey', color: (op.color as string) ?? '#00ff00', similarity: (op.similarity as number) ?? 0.14, blend: (op.blend as number) ?? 0.08, ...(op.despill !== undefined ? { despill: op.despill as boolean } : {}) });
        } else if (kind === 'mblur') {
          eff = validateEffect({ type: 'mblur', frames: (op.frames as number) ?? 3, ...(op.decay !== undefined ? { decay: op.decay as number } : {}) });
        } else if (kind === 'persp') {
          eff = validateEffect({
            type: 'persp',
            x0: (op.x0 as number) ?? 0, y0: (op.y0 as number) ?? 0,
            x1: (op.x1 as number) ?? 1, y1: (op.y1 as number) ?? 0,
            x2: (op.x2 as number) ?? 0, y2: (op.y2 as number) ?? 1,
            x3: (op.x3 as number) ?? 1, y3: (op.y3 as number) ?? 1,
          });
        } else if (kind === 'chain') {
          const chainName = (op.chain as string) ?? (op.mode as string);
          const builder = chainName ? EFFECT_CHAINS[chainName] : undefined;
          if (!builder) throw new TmepError('E_INPUT', `unknown effect chain "${chainName ?? ''}"`, `chains: ${Object.keys(EFFECT_CHAINS).join(',')}`);
          for (const ce of builder()) (c.fx ??= []).push(ce);
          continue;
        } else {
          const clipDur = 'speed' in c ? (c.out - c.in) / c.speed : c.d;
          const at = op.at as number;
          const d = (op.d as number | undefined) ?? Math.max(0.05, clipDur - at);
          eff = { type: 'kf', keys: presetKeys(kind as (typeof FX_PRESETS)[number], at, d, op.amt as number | undefined, op.e as never) };
        }
        (c.fx ??= []).push(eff);
      }
      return `fx ${kind} ${targets.length === 1 ? targets[0]!.id : `${targets.length} clips`}`;
    }
    case 'zoom': {
      const at = pt(op.at).t;
      const hit = tlToSrc(placed(), at);
      if (!hit) throw new TmepError('E_RANGE', `no clip at ${r2(at)}s`);
      const c = hit.p.clip;
      c.zoom = (c.zoom ?? []).filter((z) => Math.abs(z.s - hit.srcT) > 0.05);
      c.zoom.push({ s: hit.srcT, d: op.d as number, to: op.to as number, mode: op.mode as 'punch' | 'smooth' });
      c.zoom.sort((x, y) => x.s - y.s);
      return `zoom ${c.id}@${r2(at)}`;
    }
    case 'transition': {
      const rawType = op.type as string;
      const preset = TRANSITION_PRESETS[rawType];
      const type = preset ? preset.type : rawType;
      const dVal = preset && op.d === 0.35 ? preset.d : (op.d as number);
      const tr = type === 'none' || dVal === 0 ? undefined : { type, d: dVal };
      let targets = tl.clips.slice(1);
      if (!op.all) {
        if (op.clip) targets = [findClip(tl, op.clip as string)];
        else if (op.at !== undefined) {
          const at = pt(op.at).t;
          const ps = placed().slice(1);
          const best = ps.reduce((b, p) => (Math.abs(p.start - at) < Math.abs(b.start - at) ? p : b), ps[0]!);
          if (!best) throw new TmepError('E_STATE', 'transitions need at least two clips');
          targets = [best.clip];
        } else throw new TmepError('E_INPUT', 'transition needs clip, at, or all:true');
      }
      let applied = 0, first = 0;
      // A still image can be held as long as needed, so its handle is unlimited.
      const handleDur = (id: string) => (ctx.assets[id]?.kind === 'image' ? Infinity : ctx.assets[id]?.dur ?? Infinity);
      for (const c of targets) {
        const idx = tl.clips.indexOf(c);
        if (idx <= 0) { first++; continue; }
        if (!tr) {
          // Removing a transition also gives back the handle footage it added.
          revertTransition(tl, idx);
          continue;
        }
        // jump cuts inside continuous speech get no transition: it would overlap words
        if (addTransition(tl, idx, tr.type, tr.d, ctx.transcripts, handleDur) > 0) applied++;
      }
      const noHandle = targets.length - first - applied;
      const why = [first ? `${first} skipped: the first clip has no previous clip` : '', tr && noHandle > 0 ? `${noHandle} skipped: no silent handle footage` : ''].filter(Boolean).join('; ');
      return `transition ${type} x${tr ? applied : targets.length - first}${why ? ` (${why})` : ''}`;
    }
    case 'broll': {
      const a = needAsset(ctx, op.src as string, ['video', 'image']);
      const at = pt(op.at).t;
      const id = nextId(tl, 'b');
      const inT = op.in as number;
      const d = a.kind === 'image' ? (op.d as number) : Math.min(op.d as number, a.dur - inT);
      if (d <= 0) throw new TmepError('E_RANGE', `broll in=${inT} is past the end of ${op.src}`);
      tl.broll.push({ id, src: op.src as string, in: inT, ref: anchorAt(placed(), at), d, fit: op.fit as 'cover', ...(op.z !== undefined ? { z: op.z as number } : {}) });
      created.push(id);
      return `broll ${id}@${r2(at)}`;
    }
    case 'gfx': {
      if (ctx.presets && !ctx.presets.includes(op.preset as string)) {
        const hint = closest(op.preset as string, ctx.presets);
        throw new TmepError('E_INPUT', `unknown gfx preset "${op.preset}"`, hint ? `did you mean "${hint}"?` : `presets: ${ctx.presets.join(',')}`);
      }
      const at = pt(op.at).t;
      const id = nextId(tl, 'g');
      tl.gfx.push({ id, preset: op.preset as string, ref: anchorAt(placed(), at), d: op.d as number, props: op.props as Record<string, unknown>, ...(op.z !== undefined ? { z: op.z as number } : {}) });
      created.push(id);
      return `gfx ${id} ${op.preset}@${r2(at)}`;
    }
    case 'scene': {
      const spec = op.spec as VisualScene;
      const id = nextId(tl, 'scene');
      (tl.scenes ??= []).push({ id, spec });
      created.push(id);
      return `scene ${id}`;
    }
    case 'set': {
      const id = op.id as string;
      // Clips: linear gain and mute (the mixer always honoured them; no op could set them before).
      const clip = tl.clips.find((c) => c.id === id);
      if (clip) {
        const bad = ['at', 'd', 'props', 'vol', 'z'].filter((k) => op[k] !== undefined);
        if (bad.length) throw new TmepError('E_INPUT', `set ${id}: ${bad.join(', ')} do not apply to clips`, 'clips take gain (0–4, linear) and mute');
        if (op.gain === undefined && op.mute === undefined) throw new TmepError('E_INPUT', `set ${id}: nothing to set`, 'clips take gain and mute');
        if (op.gain !== undefined) clip.vol = op.gain as number;
        if (op.mute !== undefined) clip.mute = op.mute as boolean;
        return `set ${id}${op.gain !== undefined ? ` gain=${clip.vol}` : ''}${op.mute !== undefined ? ` mute=${clip.mute}` : ''}`;
      }
      const kind = tl.gfx.some((x) => x.id === id) ? 'gfx' : tl.sfx.some((x) => x.id === id) ? 'sfx' : tl.broll.some((x) => x.id === id) ? 'broll' : undefined;
      if (!kind) throw new TmepError('E_NOT_FOUND', `no clip/gfx/sfx/broll ${id}`);
      const item = [...tl.gfx, ...tl.sfx, ...tl.broll].find((x) => x.id === id) as { ref: { at?: number }; d?: number; props?: Record<string, unknown>; vol?: number; z?: number };
      // Fields that do not apply to this kind are errors, not silent no-ops.
      const allowed: Record<string, string[]> = { gfx: ['at', 'd', 'props', 'z'], sfx: ['at', 'vol'], broll: ['at', 'd', 'z'] };
      const bad = ['at', 'd', 'props', 'vol', 'z', 'gain', 'mute'].filter((k) => op[k] !== undefined && !allowed[kind]!.includes(k));
      if (kind === 'sfx' && op.z !== undefined) throw new TmepError('E_INPUT', 'z is only supported for b-roll and graphics');
      if (bad.length) throw new TmepError('E_INPUT', `set ${id}: ${bad.join(', ')} do not apply to ${kind}`, `${kind} takes ${allowed[kind]!.join(', ')}`);
      if (op.at !== undefined) item.ref = anchorAt(placed(), pt(op.at).t);
      if (op.d !== undefined) item.d = op.d as number;
      if (op.props) item.props = { ...(item.props ?? {}), ...(op.props as Record<string, unknown>) };
      if (op.vol !== undefined) item.vol = op.vol as number;
      if (op.z !== undefined) item.z = op.z as number;
      return `set ${id}`;
    }
    case 'captions': {
      for (const k of ['style', 'pos', 'maxWords', 'upper', 'color', 'accent', 'size', 'font', 'emphasis', 'script'] as const) {
        if (op[k] !== undefined) (tl.captions as unknown as Record<string, unknown>)[k] = op[k];
      }
      return `captions ${tl.captions.style}`;
    }
    case 'fix': {
      tl.captions.fix = tl.captions.fix.filter(([f]) => f.toLowerCase() !== (op.find as string).toLowerCase());
      tl.captions.fix.push([op.find as string, op.replace as string]);
      return `fix "${op.find}"`;
    }
    case 'music': {
      if (op.off) {
        delete tl.music;
        return 'music off';
      }
      if (!op.src) throw new TmepError('E_INPUT', 'music needs src (audio asset id) or off:true');
      needAsset(ctx, op.src as string, ['audio', 'video']);
      tl.music = { src: op.src as string, vol: op.vol as number, duck: op.duck as boolean, fade: op.fade as number };
      return `music ${op.src}`;
    }
    case 'sfx': {
      if (ctx.sfxKinds && !ctx.sfxKinds.includes(op.kind as string)) {
        throw new TmepError('E_INPUT', `unknown sfx "${op.kind}"`, `kinds: ${ctx.sfxKinds.join(',')}`);
      }
      const at = pt(op.at).t;
      const id = nextId(tl, 's');
      tl.sfx.push({ id, kind: op.kind as string, ref: anchorAt(placed(), at), vol: op.vol as number });
      created.push(id);
      return `sfx ${id} ${op.kind}@${r2(at)}`;
    }
    case 'format': {
      if (op.ratio) {
        const [w, h] = RATIOS[op.ratio as Ratio];
        tl.settings = { ...tl.settings, ratio: op.ratio as Ratio, w, h };
      }
      if (op.fps) tl.settings.fps = op.fps as number;
      return `format ${tl.settings.ratio}@${tl.settings.fps}`;
    }
    case 'loudness': {
      tl.loudness = op.lufs as number;
      return `loudness ${tl.loudness}`;
    }
    case 'jcut': {
      // The incoming clip's audio starts early, so it needs source audio before its in-point.
      const c = findClip(tl, op.clip as string);
      c.jcut = op.d as number;
      const first = tl.clips[0] === c;
      const avail = first ? 0 : c.in / c.speed;
      if (avail + 1e-6 < c.jcut) {
        const why = first ? 'the first clip has no previous clip to overlap' : `only ${r3(avail)}s of source audio before its in-point`;
        return `jcut ${c.id} ${r3(Math.min(avail, c.jcut))}s (requested ${c.jcut}s; ${why})`;
      }
      return `jcut ${c.id} ${c.jcut}s`;
    }
    case 'lcut': {
      // The outgoing clip's audio continues under the next clip, so it needs source audio after its out-point.
      const c = findClip(tl, op.clip as string);
      c.lcut = op.d as number;
      const last = tl.clips[tl.clips.length - 1] === c;
      const dur = ctx.assets[c.src]?.dur ?? Infinity;
      const avail = last ? 0 : Math.max(0, (dur - c.out) / c.speed);
      if (avail + 1e-6 < c.lcut) {
        const why = last ? 'the last clip has no next clip to overlap' : `only ${r3(avail)}s of source audio after its out-point`;
        return `lcut ${c.id} ${r3(Math.min(avail, c.lcut))}s (requested ${c.lcut}s; ${why})`;
      }
      return `lcut ${c.id} ${c.lcut}s`;
    }
    case 'ramp': {
      const targets = op.clip ? [findClip(tl, op.clip as string)] : tl.clips;
      if (!targets.length) throw new TmepError('E_RANGE', 'no clips for ramp');
      let keys: { t: number; speed: number; e?: Ease }[];
      if (Array.isArray(op.keys)) {
        keys = op.keys as { t: number; speed: number; e?: Ease }[];
      } else if (typeof op.keys === 'string') {
        keys = op.keys.split(';').filter((x) => x.trim()).map((seg) => {
          const m = /^\s*(-?[\d.]+)\s*:(.*)$/.exec(seg);
          if (!m) throw new TmepError('E_INPUT', `bad ramp key "${seg}"`, 'keys="0:speed=1;1.5:speed=2,e=io"');
          const k: { t: number; speed: number; e?: Ease } = { t: Number(m[1]), speed: 1 };
          for (const kv of m[2]!.split(',').filter((x) => x.trim())) {
            const [name, val] = kv.split('=').map((x) => x.trim());
            if (name === 'speed' || name === 's') k.speed = Number(val);
            else if (name === 'e') k.e = val as Ease;
          }
          return k;
        });
      } else {
        throw new TmepError('E_INPUT', 'ramp needs keys', 'keys="0:speed=1;1:speed=2.5;2:speed=1"');
      }
      if (keys.length < 2) throw new TmepError('E_INPUT', 'ramp needs at least 2 keys');
      for (const k of keys) {
        if (!Number.isFinite(k.t) || k.t < 0 || !Number.isFinite(k.speed) || k.speed < 0.25 || k.speed > 4) {
          throw new TmepError('E_INPUT', `invalid ramp key ${JSON.stringify(k)} (speed in [0.25, 4])`);
        }
      }
      keys.sort((a, b) => a.t - b.t);
      for (const c of targets) c.speedRamp = structuredClone(keys);
      return `ramp ${targets.length === 1 ? targets[0]!.id : `${targets.length} clips`} (${keys.length}k)`;
    }
    case 'freeze': {
      const at = pt(op.at).t;
      const hit = tlToSrc(placed(), at);
      if (!hit) throw new TmepError('E_RANGE', `no clip at ${r2(at)}s`);
      const c = hit.p.clip;
      const idx = tl.clips.indexOf(c);
      const splitSrc = Math.max(c.in + 1 / tl.settings.fps, Math.min(c.out - 1 / tl.settings.fps, hit.srcT));
      const frameDur = 1 / tl.settings.fps;
      const fClip = newClip(tl, c.src, splitSrc, Math.min(c.out, splitSrc + frameDur), {
        fit: c.fit, cx: c.cx, cy: c.cy, base: c.base, freeze: op.d as number, mute: true,
      });
      if (splitSrc > c.in + 1e-4 && splitSrc < c.out - 1e-4) {
        const right = newClip(tl, c.src, splitSrc, c.out, {
          speed: c.speed, fit: c.fit, cx: c.cx, cy: c.cy, base: c.base, push: c.push, vol: c.vol, mute: c.mute,
          ...(c.fx ? { fx: shiftFx(c.fx, (splitSrc - c.in) / c.speed) } : {}),
        });
        c.out = splitSrc;
        tl.clips.splice(idx + 1, 0, fClip, right);
      } else {
        tl.clips.splice(idx + 1, 0, fClip);
      }
      created.push(fClip.id);
      return `freeze ${fClip.id}@${r2(at)} ${op.d}s`;
    }
    case 'reverse': {
      const targets = op.clip ? [findClip(tl, op.clip as string)] : tl.clips;
      if (!targets.length) throw new TmepError('E_RANGE', 'no clips to reverse');
      for (const c of targets) c.reverse = op.on as boolean;
      return `reverse ${op.on ? 'on' : 'off'} ${targets.length} clips`;
    }
    case 'punch': {
      const at = pt(op.at).t;
      const hit = tlToSrc(placed(), at);
      if (!hit) throw new TmepError('E_RANGE', `no clip at ${r2(at)}s`);
      const c = hit.p.clip;
      const localT = Math.max(0, (hit.srcT - c.in) / c.speed);
      const d = op.d as number;
      const to = op.to as number;
      const rampIn = Math.min(0.25, d * 0.25);
      const rampOut = Math.min(0.3, d * 0.25);
      const keys = [
        { t: localT, s: 1 },
        { t: localT + rampIn, s: to, e: 'out' as Ease },
        { t: Math.max(localT + rampIn + 0.05, localT + d - rampOut), s: to, e: 'linear' as Ease },
        { t: localT + d, s: 1, e: 'io' as Ease },
      ];
      (c.fx ??= []).push({ type: 'kf', keys });
      return `punch ${c.id}@${r2(at)} to=${to}`;
    }
    case 'matchcut': {
      const a = findClip(tl, op.fromClip as string);
      const b = findClip(tl, op.toClip as string);
      const durA = (a.out - a.in) / a.speed;
      const s = op.scale as number;
      const d = op.d as number;
      (a.fx ??= []).push({ type: 'kf', keys: [{ t: Math.max(0, durA - Math.max(0.2, d)), s: 1 }, { t: durA, s, e: 'in' }] });
      (b.fx ??= []).push({ type: 'kf', keys: [{ t: 0, s }, { t: Math.min(0.4, (b.out - b.in) / b.speed), s: 1, e: 'out' }] });
      if (d > 0 && tl.clips.indexOf(b) === tl.clips.indexOf(a) + 1) {
        addTransition(tl, tl.clips.indexOf(b), 'dissolve', d, ctx.transcripts, (id) => ctx.assets[id]?.dur ?? Infinity);
      }
      return `matchcut ${a.id}->${b.id}`;
    }
    case 'reframe': {
      const targets = op.clip ? [findClip(tl, op.clip as string)] : tl.clips;
      if (!targets.length) throw new TmepError('E_RANGE', 'no clips to reframe');
      for (const c of targets) {
        if (op.cx !== undefined) c.cx = op.cx as number;
        if (op.cy !== undefined) c.cy = op.cy as number;
        if (op.keys !== undefined) {
          (c.fx ??= []).push({ type: 'kf', keys: parseKeys(op.keys) });
        }
      }
      return `reframe ${targets.length} clips`;
    }
    case 'stabilize': {
      const targets = op.clip ? [findClip(tl, op.clip as string)] : tl.clips;
      if (!targets.length) throw new TmepError('E_RANGE', 'no clips to stabilize');
      for (const c of targets) {
        if (op.off) delete c.stabilize;
        else c.stabilize = { smoothing: op.smoothing as number, shakiness: op.shakiness as number, accuracy: op.accuracy as number };
      }
      return `stabilize ${op.off ? 'off' : 'on'} ${targets.length} clips`;
    }
    case 'splitscreen': {
      const srcs = op.srcs as string[];
      const at = pt(op.at).t;
      const d = op.d as number;
      const lay = op.layout as '2h' | '2v' | '2x2' | '3v';
      const gap = op.gap as number;
      const z = op.z as number;
      const slots: { x: number; y: number; w: number; h: number }[] =
        lay === '2h'
          ? [{ x: 0.25 - gap / 4, y: 0.5, w: 0.5 - gap, h: 1 }, { x: 0.75 + gap / 4, y: 0.5, w: 0.5 - gap, h: 1 }]
          : lay === '2v'
            ? [{ x: 0.5, y: 0.25 - gap / 4, w: 1, h: 0.5 - gap }, { x: 0.5, y: 0.75 + gap / 4, w: 1, h: 0.5 - gap }]
            : lay === '3v'
              ? [0, 1, 2].map((i) => ({ x: 0.5, y: (i + 0.5) / 3, w: 1, h: 1 / 3 - gap }))
              : [
                  { x: 0.25, y: 0.25, w: 0.5 - gap, h: 0.5 - gap },
                  { x: 0.75, y: 0.25, w: 0.5 - gap, h: 0.5 - gap },
                  { x: 0.25, y: 0.75, w: 0.5 - gap, h: 0.5 - gap },
                  { x: 0.75, y: 0.75, w: 0.5 - gap, h: 0.5 - gap },
                ];
      const ref = anchorAt(placed(), at);
      for (let i = 0; i < Math.min(srcs.length, slots.length); i++) {
        const s = srcs[i]!;
        const sl = slots[i]!;
        needAsset(ctx, s, ['video', 'image']);
        const id = nextId(tl, 'b');
        tl.broll.push({
          id, src: s, in: 0, ref, d, fit: 'cover', z,
          fx: [
            { type: 'kf', keys: [{ t: 0, s: Math.max(sl.w, sl.h), x: sl.x - 0.5, y: sl.y - 0.5 }] },
            { type: 'mask', shape: 'rect', x: sl.x, y: sl.y, w: sl.w, h: sl.h, feather: 0, invert: false },
          ],
        });
        created.push(id);
      }
      return `splitscreen ${lay} x${Math.min(srcs.length, slots.length)}`;
    }
    case 'pip': {
      const a = needAsset(ctx, op.src as string, ['video', 'image']);
      const at = pt(op.at).t;
      const inT = op.in as number;
      const d = a.kind === 'image' ? (op.d as number) : Math.min(op.d as number, a.dur - inT);
      if (d <= 0) throw new TmepError('E_RANGE', `pip in=${inT} is past end of ${op.src}`);
      const sc = op.scale as number;
      const pad = 0.05;
      const pos = op.pos as 'br' | 'bl' | 'tr' | 'tl';
      const cx = pos.endsWith('r') ? 1 - pad - sc / 2 : pad + sc / 2;
      const cy = pos.startsWith('b') ? 1 - pad - sc / 2 : pad + sc / 2;
      const id = nextId(tl, 'b');
      tl.broll.push({
        id, src: op.src as string, in: inT, ref: anchorAt(placed(), at), d, fit: 'cover', z: op.z as number,
        fx: [
          { type: 'kf', keys: [{ t: 0, s: sc, x: cx - 0.5, y: cy - 0.5, o: 0 }, { t: 0.25, o: 1, e: 'out' }] },
          { type: 'mask', shape: 'rect', x: cx, y: cy, w: sc, h: sc, feather: op.feather as number, invert: false },
        ],
      });
      created.push(id);
      return `pip ${id} ${pos}@${r2(at)}`;
    }
    case 'parallax': {
      const srcs = op.srcs as string[];
      const at = pt(op.at).t;
      const d = op.d as number;
      const drift = op.drift as number;
      const baseZ = op.z as number;
      const ref = anchorAt(placed(), at);
      for (let i = 0; i < srcs.length; i++) {
        needAsset(ctx, srcs[i]!, ['video', 'image']);
        const depth = (i + 1) / srcs.length;
        const dx = drift * depth;
        const id = nextId(tl, 'b');
        tl.broll.push({
          id, src: srcs[i]!, in: 0, ref, d, fit: 'cover', z: baseZ + i,
          fx: [{ type: 'kf', keys: [{ t: 0, s: 1 + dx * 2, x: -dx / 2 }, { t: d, s: 1 + dx * 2, x: dx / 2, e: 'linear' }] }],
        });
        created.push(id);
      }
      return `parallax x${srcs.length}@${r2(at)}`;
    }
    case 'color': {
      const targets = op.clip ? [findClip(tl, op.clip as string)] : undefined;
      if (op.clear) {
        if (targets) for (const c of targets) delete c.color;
        else delete tl.color;
        return `color cleared`;
      }
      const grade: ColorGrade = {};
      for (const k of ['exposure', 'contrast', 'temp', 'tint', 'saturation', 'vibrance', 'highlights', 'shadows', 'curves', 'lut', 'vignette', 'inputColorSpace'] as const) {
        if (op[k] !== undefined) (grade as Record<string, unknown>)[k] = op[k];
      }
      if (targets) {
        for (const c of targets) c.color = { ...(c.color ?? {}), ...grade };
        return `color ${targets.map((c) => c.id).join(',')}`;
      }
      tl.color = { ...(tl.color ?? {}), ...grade };
      return 'color timeline';
    }
    case 'audio': {
      if (op.clip) {
        const c = findClip(tl, op.clip as string);
        c.audio = { ...(c.audio ?? {}) };
        for (const k of ['eq', 'denoise', 'deess', 'comp', 'hp', 'lp', 'fadeIn', 'fadeOut'] as const) {
          if (op[k] !== undefined) (c.audio as Record<string, unknown>)[k] = op[k];
        }
        return `audio ${c.id}`;
      }
      tl.master = { ...(tl.master ?? {}) };
      for (const k of ['target', 'lufs', 'tp', 'lra', 'twoPass', 'limiter'] as const) {
        if (op[k] !== undefined) (tl.master as Record<string, unknown>)[k] = op[k];
      }
      if (op.lufs !== undefined) tl.loudness = op.lufs as number;
      return `audio master`;
    }
    default:
      throw new TmepError('E_INPUT', `unhandled op ${String(op.op)}`);
  }
}

export function validateTimeline(tl: Timeline, ctx: OpContext): void {
  for (const c of tl.clips) {
    const a = ctx.assets[c.src];
    if (!a) throw new TmepError('E_NOT_FOUND', `clip ${c.id} references missing asset ${c.src}`);
    if (c.in < 0 || c.out <= c.in) throw new TmepError('E_RANGE', `clip ${c.id} has empty range ${c.in}-${c.out}`);
    if (a.kind !== 'image' && c.in >= a.dur) throw new TmepError('E_RANGE', `clip ${c.id} starts after end of ${c.src}`);
    if (a.kind !== 'image') c.out = Math.min(c.out, a.dur);
  }
}

/** Compact structural diff between two timelines (for inspect what:"diff"). */
export function diffTimelines(a: Timeline, b: Timeline): Record<string, unknown> {
  const ids = (l: { id: string }[]) => new Set(l.map((x) => x.id));
  const setDiff = (x: Set<string>, y: Set<string>) => [...y].filter((i) => !x.has(i));
  const out: Record<string, unknown> = { dur: [r2(duration(a)), r2(duration(b))] };
  for (const key of ['clips', 'gfx', 'sfx', 'broll'] as const) {
    const A = ids(a[key]);
    const B = ids(b[key]);
    const add = setDiff(A, B);
    const rm = setDiff(B, A);
    const changed = (b[key] as { id: string }[])
      .filter((x) => A.has(x.id))
      .filter((x) => JSON.stringify(x) !== JSON.stringify((a[key] as { id: string }[]).find((y) => y.id === x.id)))
      .map((x) => x.id);
    if (add.length || rm.length || changed.length) out[key] = { ...(add.length && { add }), ...(rm.length && { rm }), ...(changed.length && { chg: changed }) };
  }
  const capChg = Object.keys(b.captions).filter((k) => JSON.stringify((a.captions as unknown as Record<string, unknown>)[k]) !== JSON.stringify((b.captions as unknown as Record<string, unknown>)[k]));
  if (capChg.length) out.captions = capChg;
  if (JSON.stringify(a.settings) !== JSON.stringify(b.settings)) out.settings = b.settings;
  if (JSON.stringify(a.music) !== JSON.stringify(b.music)) out.music = b.music ?? null;
  if (JSON.stringify(a.scenes ?? []) !== JSON.stringify(b.scenes ?? [])) out.scenes = (b.scenes ?? []).map(({ id }) => id);
  return out;
}

export { srcToTl };
