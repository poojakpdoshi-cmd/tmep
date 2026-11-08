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
  cutTimeline,
  removeSrcRange,
  findClip,
  newClip,
  nextId,
  duration,
  srcToTl,
} from './timeline.ts';
import { r2 } from './util.ts';

export interface OpContext {
  transcripts: Record<string, Word[] | undefined>;
  assets: Record<string, { dur: number; kind: string }>;
  presets?: string[];
  sfxKinds?: string[];
}

const anchor = union([num(), str({ min: 1 })]);
const ratio = oneOf(['9:16', '16:9', '1:1', '4:5'] as const);
const fit = oneOf(['cover', 'contain', 'blur'] as const);
export const TRANSITIONS = ['fade', 'dissolve', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'slideup', 'smoothleft', 'smoothup', 'circleopen', 'zoomin', 'radial', 'none'] as const;

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
  broll: obj({ op: str(), src: str(), at: anchor, d: num({ min: 0.2, max: 600 }), in: num({ min: 0 }).default(0), fit: fit.default('cover') }),
  gfx: obj({ op: str(), preset: str(), at: anchor, d: num({ min: 0.2, max: 600 }).default(2.5), props: record(any()).default({}) }),
  set: obj({ op: str(), id: str(), at: anchor.optional(), d: num({ min: 0.1, max: 600 }).optional(), props: record(any()).optional(), vol: num().optional() }),
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
  broll: ['src', 'at', 'd'],
  music: ['src', 'vol'],
  format: ['ratio'],
  move: ['clip', 'index'],
  fix: ['find', 'replace'],
  add: ['src', 'in', 'out'],
  trim: ['clip', 'in', 'out'],
  loudness: ['lufs'],
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
      while (i + 1 < toks.length && !toks[i + 1]!.includes('=') && !/^-?\d+(\.\d+)?$/.test(toks[i + 1]!) && !toks[i + 1]!.startsWith('@')) {
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
export function addTransition(tl: Timeline, i: number, type: string, d: number, transcripts: Record<string, Word[] | undefined>, srcDur: (id: string) => number): number {
  const c = tl.clips[i];
  const prev = tl.clips[i - 1];
  if (!c || !prev) return 0;
  const pw = transcripts[prev.src] ?? [];
  const cw = transcripts[c.src] ?? [];
  const nextWordAfter = pw.length ? (pw.find((w) => w.s >= prev.out - 1e-3)?.s ?? Infinity) : Infinity;
  const prevWordBefore = cw.length ? ([...cw].reverse().find((w) => w.e <= c.in + 1e-3)?.e ?? -Infinity) : -Infinity;
  const hOut = Math.max(0, Math.min(d, nextWordAfter - 0.03 - prev.out, srcDur(prev.src) - prev.out));
  const hIn = Math.max(0, Math.min(d, c.in - (prevWordBefore + 0.03), c.in));
  const td = Math.min(d, hOut + hIn);
  if (td < 0.15) return 0;
  const useOut = Math.min(hOut, td);
  prev.out = r2(prev.out + useOut, 3);
  c.in = r2(c.in - (td - useOut), 3);
  c.trans = { type, d: r2(td, 3) };
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
          if (target.every((x, j) => toks[i + j] === x)) {
            const first = ws[i]!;
            const last = ws[i + target.length - 1]!;
            if (first.src === last.src) {
              const tr = ctx.transcripts[first.src]!;
              hits.push({ src: first.src, s: tr[first.i]!.s, e: tr[last.i]!.e });
            }
          }
        }
        if (!hits.length) throw new TmepError('E_ANCHOR', `"${op.text}" not found in timeline transcript`);
      } else throw new TmepError('E_INPUT', 'delete needs text or fillers:true');
      let removed = 0;
      for (const h of hits) removed += removeSrcRange(tl, h.src, h.s - pad, h.e + pad);
      return `delete ${hits.length}x ${r2(removed)}s`;
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
      const out = (op.out as number | undefined) ?? (a.kind === 'image' ? 3 : a.dur);
      const c = newClip(tl, src, op.in as number, a.kind === 'image' ? out : Math.min(out, a.dur));
      const idx = (op.index as number | undefined) ?? tl.clips.length;
      tl.clips.splice(idx, 0, c);
      created.push(c.id);
      return `add ${c.id}`;
    }
    case 'trim': {
      const c = findClip(tl, op.clip as string);
      if (op.in !== undefined) c.in = op.in as number;
      if (op.out !== undefined) c.out = op.out as number;
      if (c.out <= c.in) throw new TmepError('E_RANGE', `clip ${c.id} would be empty`);
      return `trim ${c.id}`;
    }
    case 'move': {
      const c = findClip(tl, op.clip as string);
      tl.clips = tl.clips.filter((x) => x !== c);
      tl.clips.splice(Math.min(op.index as number, tl.clips.length), 0, c);
      return `move ${c.id}`;
    }
    case 'remove': {
      const id = op.id as string;
      for (const key of ['clips', 'gfx', 'sfx', 'broll'] as const) {
        const list = tl[key] as { id: string }[];
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) {
          list.splice(i, 1);
          return `remove ${id}`;
        }
      }
      throw new TmepError('E_NOT_FOUND', `no clip/gfx/sfx/broll with id ${id}`);
    }
    case 'speed': {
      const targets = op.clip ? [findClip(tl, op.clip as string)] : tl.clips;
      for (const c of targets) c.speed = op.x as number;
      return `speed x${op.x} (${targets.length} clips)`;
    }
    case 'frame': {
      const targets = op.clip ? [findClip(tl, op.clip as string)] : tl.clips;
      for (const c of targets) {
        for (const k of ['fit', 'cx', 'cy', 'base', 'push'] as const) if (op[k] !== undefined) (c as unknown as Record<string, unknown>)[k] = op[k];
      }
      return `frame ${targets.length} clips`;
    }
    case 'zoom': {
      const at = t(op.at).t;
      const hit = anchorAt(placed(), at);
      const c = tl.clips.find((x) => x.src === hit.src && hit.t !== undefined && hit.t >= x.in && hit.t < x.out);
      if (!c || hit.t === undefined) throw new TmepError('E_RANGE', `no clip at ${r2(at)}s`);
      c.zoom = c.zoom.filter((z) => Math.abs(z.s - hit.t!) > 0.05);
      c.zoom.push({ s: hit.t, d: op.d as number, to: op.to as number, mode: op.mode as 'punch' | 'smooth' });
      c.zoom.sort((x, y) => x.s - y.s);
      return `zoom ${c.id}@${r2(at)}`;
    }
    case 'transition': {
      const type = op.type as string;
      const tr = type === 'none' || (op.d as number) === 0 ? undefined : { type, d: op.d as number };
      let targets = tl.clips.slice(1);
      if (!op.all) {
        if (op.clip) targets = [findClip(tl, op.clip as string)];
        else if (op.at !== undefined) {
          const at = t(op.at).t;
          const ps = placed().slice(1);
          const best = ps.reduce((b, p) => (Math.abs(p.start - at) < Math.abs(b.start - at) ? p : b), ps[0]!);
          if (!best) throw new TmepError('E_STATE', 'transitions need at least two clips');
          targets = [best.clip];
        } else throw new TmepError('E_INPUT', 'transition needs clip, at, or all:true');
      }
      let applied = 0;
      for (const c of targets) {
        const idx = tl.clips.indexOf(c);
        if (idx <= 0) continue;
        if (!tr) {
          delete c.trans;
          continue;
        }
        // jump cuts inside continuous speech get no transition: it would overlap words
        if (addTransition(tl, idx, tr.type, tr.d, ctx.transcripts, (id) => ctx.assets[id]?.dur ?? Infinity) > 0) applied++;
      }
      return `transition ${type} x${tr ? applied : targets.length}${tr && applied < targets.length ? ` (${targets.length - applied} skipped: no silence for handles)` : ''}`;
    }
    case 'broll': {
      const a = needAsset(ctx, op.src as string, ['video', 'image']);
      const at = t(op.at).t;
      const id = nextId(tl, 'b');
      const inT = op.in as number;
      const d = a.kind === 'image' ? (op.d as number) : Math.min(op.d as number, a.dur - inT);
      if (d <= 0) throw new TmepError('E_RANGE', `broll in=${inT} is past the end of ${op.src}`);
      tl.broll.push({ id, src: op.src as string, in: inT, ref: anchorAt(placed(), at), d, fit: op.fit as 'cover' });
      created.push(id);
      return `broll ${id}@${r2(at)}`;
    }
    case 'gfx': {
      if (ctx.presets && !ctx.presets.includes(op.preset as string)) {
        const hint = closest(op.preset as string, ctx.presets);
        throw new TmepError('E_INPUT', `unknown gfx preset "${op.preset}"`, hint ? `did you mean "${hint}"?` : `presets: ${ctx.presets.join(',')}`);
      }
      const at = t(op.at).t;
      const id = nextId(tl, 'g');
      tl.gfx.push({ id, preset: op.preset as string, ref: anchorAt(placed(), at), d: op.d as number, props: op.props as Record<string, unknown> });
      created.push(id);
      return `gfx ${id} ${op.preset}@${r2(at)}`;
    }
    case 'set': {
      const id = op.id as string;
      const item = [...tl.gfx, ...tl.sfx, ...tl.broll].find((x) => x.id === id) as
        | { ref: { at?: number }; d?: number; props?: Record<string, unknown>; vol?: number }
        | undefined;
      if (!item) throw new TmepError('E_NOT_FOUND', `no gfx/sfx/broll ${id}`);
      if (op.at !== undefined) item.ref = anchorAt(placed(), t(op.at).t);
      if (op.d !== undefined && 'd' in item) item.d = op.d as number;
      if (op.props && item.props) Object.assign(item.props, op.props);
      if (op.vol !== undefined && 'vol' in item) item.vol = op.vol as number;
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
      const at = t(op.at).t;
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
  return out;
}

export { srcToTl };
