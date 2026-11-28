/**
 * FRAME visual asset engine (Phase 5): a project-local library of images, clips, screen recordings,
 * SVG icons/illustrations, charts, diagrams and reusable compositions, with licence records,
 * content hashes, perceptual hashes, text search, duplicate detection, relevance scoring and
 * timestamped recommendations. When nothing suitable exists it emits a structured asset request
 * instead — and a product demonstration is only ever requested, never synthesized.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { TmepError } from '../../core/src/index.ts';
import { ffmpegInfo, probe } from './ffmpeg.ts';
import { runBinary } from './exec.ts';

export const LIBRARY_SCHEMA = 'frame.assets/1';
export const ASSET_KINDS = ['image', 'video', 'svg', 'screen-recording', 'chart', 'diagram', 'composition', 'stock'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface Licence {
  /** SPDX-style id (CC-BY-4.0, CC0-1.0, Apache-2.0…), 'owned' for the user's own material, or 'unknown'. */
  id: string;
  source?: string; attribution?: string; url?: string;
  /** True only when the user (or a verified source record) states the licence. */
  verified: boolean;
}
export interface LibraryEntry {
  id: string; file: string; kind: AssetKind; title?: string; description?: string; tags: string[];
  w?: number; h?: number; dur?: number; bytes: number; sha256: string;
  /** 64-bit difference hash (16 hex chars) of a representative frame; absent for SVG. */
  dhash?: string;
  /** Text visible in the asset (SVG <title>/<text>, or OCR when requested). */
  text?: string;
  licence: Licence;
  provenance: 'user' | 'stock' | 'generated' | 'screen-capture';
  /** A real recording of the product or interface it shows (required for product demonstrations). */
  genuine?: boolean;
  added: string;
}
export interface Library { schema: typeof LIBRARY_SCHEMA; entries: LibraryEntry[] }
export type EntryMeta = Partial<Pick<LibraryEntry, 'kind' | 'title' | 'description' | 'tags' | 'provenance' | 'genuine'>> & { licence?: Partial<Licence> };

const STOP = new Set('a an and are as at be but by for from has have in is it its of on or that the this to was were will with you your we our i me my they them their there here what when where which who how not no yes do does did can could should would just so if then than into out up down over about also very more most some any all each'.split(' '));
/** Light suffix stripping so "launched", "launches" and "launch" meet. */
const stem = (w: string) => w.length > 5 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 5 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 4 && w.endsWith('es') && /(ch|sh|x|ss)es$/.test(w) ? w.slice(0, -2) : w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
export const tokens = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !STOP.has(w)).map(stem);

// ---------- hashing / probing ----------

async function dhashOf(file: string, t: number | undefined): Promise<string | undefined> {
  const { ffmpeg } = await ffmpegInfo();
  const b = await runBinary(ffmpeg, ['-v', 'error', ...(t !== undefined ? ['-ss', String(t)] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=9:8:flags=area,format=gray', '-f', 'rawvideo', '-']).catch(() => undefined);
  if (!b || b.length < 72) return undefined;
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (b[y * 9 + x]! > b[y * 9 + x + 1]! ? 1n : 0n);
  return bits.toString(16).padStart(16, '0');
}
export const hamming = (a: string, b: string) => { let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };

function svgInfo(src: string): { w?: number; h?: number; text: string } {
  const num = (re: RegExp) => { const m = src.match(re); return m ? parseFloat(m[1]!) : undefined; };
  const vb = src.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  const w = num(/<svg[^>]*\swidth\s*=\s*["']([\d.]+)/) ?? (vb ? parseFloat(vb[1]!) : undefined);
  const h = num(/<svg[^>]*\sheight\s*=\s*["']([\d.]+)/) ?? (vb ? parseFloat(vb[2]!) : undefined);
  const text = [...src.matchAll(/<(title|desc|text|tspan)[^>]*>([^<]{1,200})</g)].map((m) => m[2]!.trim()).filter(Boolean).join(' ');
  return { w, h, text };
}

/** Describe one file for the library (no network, no models). */
export async function describeAsset(file: string, meta: EntryMeta, id: string): Promise<LibraryEntry> {
  const buf = await fsp.readFile(file);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const ext = path.extname(file).toLowerCase();
  const base: Omit<LibraryEntry, 'kind'> = {
    id, file, bytes: buf.length, sha256, tags: [...new Set((meta.tags ?? []).map((t) => t.toLowerCase()))],
    ...(meta.title && { title: meta.title }), ...(meta.description && { description: meta.description }),
    licence: { id: meta.licence?.id ?? 'unknown', ...(meta.licence?.source && { source: meta.licence.source }), ...(meta.licence?.attribution && { attribution: meta.licence.attribution }), ...(meta.licence?.url && { url: meta.licence.url }), verified: !!meta.licence?.id && meta.licence.id !== 'unknown' && meta.licence.verified !== false },
    provenance: meta.provenance ?? 'user', ...(meta.genuine !== undefined && { genuine: meta.genuine }), added: new Date().toISOString(),
  };
  if (ext === '.svg') {
    const s = svgInfo(buf.toString('utf8'));
    return { ...base, kind: meta.kind ?? 'svg', ...(s.w && { w: s.w }), ...(s.h && { h: s.h }), ...(s.text && { text: s.text.slice(0, 400) }) };
  }
  const pr = await probe(file);
  if (pr.kind !== 'video' && pr.kind !== 'image') throw new TmepError('E_MEDIA', `${path.basename(file)}: the asset library holds visual media (got ${pr.kind})`);
  const dhash = await dhashOf(file, pr.kind === 'video' ? Math.min(1, pr.dur / 2) : undefined);
  return { ...base, kind: meta.kind ?? (pr.kind === 'video' ? 'video' : 'image'), w: pr.w, h: pr.h, ...(pr.kind === 'video' && { dur: pr.dur }), ...(dhash && { dhash }) };
}

// ---------- duplicates ----------

export function duplicates(entries: LibraryEntry[], maxDistance = 6): { a: string; b: string; kind: 'exact' | 'near'; distance: number }[] {
  const out: { a: string; b: string; kind: 'exact' | 'near'; distance: number }[] = [];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i]!, b = entries[j]!;
    if (a.sha256 === b.sha256) out.push({ a: a.id, b: b.id, kind: 'exact', distance: 0 });
    else if (a.dhash && b.dhash) { const d = hamming(a.dhash, b.dhash); if (d <= maxDistance) out.push({ a: a.id, b: b.id, kind: 'near', distance: d }); }
  }
  return out;
}

// ---------- search / relevance ----------

const docTokens = (e: LibraryEntry) => [
  ...e.tags.flatMap(tokens), ...e.tags.flatMap(tokens), // tags count double
  ...tokens(e.title ?? ''), ...tokens(e.title ?? ''), ...tokens(e.description ?? ''), ...tokens(e.text ?? ''),
  ...tokens(path.basename(e.file, path.extname(e.file)).replace(/[-_]+/g, ' ')),
];

/** BM25 over tags, title, description, visible text and file name. */
export function search(entries: LibraryEntry[], query: string, opts: { kind?: AssetKind; max?: number; usableOnly?: boolean } = {}): { id: string; score: number; matched: string[]; licence: string; usable: boolean }[] {
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  const docs = entries.filter((e) => !opts.kind || e.kind === opts.kind).map((e) => ({ e, t: docTokens(e) }));
  const N = docs.length, avg = docs.reduce((a, d) => a + d.t.length, 0) / Math.max(1, N);
  const df = new Map(q.map((w) => [w, docs.filter((d) => d.t.includes(w)).length]));
  const k1 = 1.2, b = 0.75;
  return docs.map(({ e, t }) => {
    let s = 0; const matched: string[] = [];
    for (const w of q) {
      const tf = t.filter((x) => x === w).length; if (!tf) continue;
      matched.push(w);
      const idf = Math.log(1 + (N - df.get(w)! + 0.5) / (df.get(w)! + 0.5));
      s += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * t.length) / Math.max(1, avg)));
    }
    // Normalize by the score of a document matching the query's three most specific terms that any asset
    // carries (words absent from the whole library cannot be matched), so a long
    // sentence is not penalized for words no asset needs to carry; thresholds then mean the same in any library.
    const idfs = q.filter((w) => df.get(w)! > 0).map((w) => Math.log(1 + (N - df.get(w)! + 0.5) / (df.get(w)! + 0.5))).sort((x, y) => y - x).slice(0, 3);
    const ideal = idfs.reduce((a, idf) => a + idf * (k1 + 1) / (1 + k1), 0);
    return { id: e.id, score: Math.round(Math.min(1, s / Math.max(1e-9, ideal)) * 1000) / 1000, matched, licence: e.licence.id, usable: usable(e) };
  }).filter((r) => r.score > 0 && (!opts.usableOnly || r.usable)).sort((x, y) => y.score - x.score).slice(0, opts.max ?? 10);
}

export const usable = (e: LibraryEntry) => e.licence.verified && e.licence.id !== 'unknown';

// ---------- recommendations / requests ----------

const DEMO = /\b(click|tap|app|screen|dashboard|settings|button|menu|login|sign up|feature|interface|ui|demo|workflow|install|download)\b/i;
const NUMERIC = /\d|percent|per cent|million|billion|thousand|growth|increase|decrease|rate|share/i;
const PROCESS = /\b(first|second|third|then|next|finally|step|steps|stage|process|pipeline|flow|cycle)\b/i;

export interface Recommendation { at: [number, number]; text: string; asset: string; kind: AssetKind; score: number; matched: string[] }
export interface AssetRequest { at: [number, number]; text: string; need: string; kind: AssetKind; reason: string; mustBeGenuine: boolean; aspect?: string; seconds: number }

/**
 * Timestamped recommendations for transcript segments. A segment gets the best usable asset scoring
 * ≥ `minScore`; otherwise, when it carries a visual idea, a structured request.
 */
export function recommend(entries: LibraryEntry[], segments: { t0: number; t1: number; text: string }[], opts: { minScore?: number; aspect?: string; max?: number; product?: string } = {}): { recommendations: Recommendation[]; requests: AssetRequest[]; skipped: { at: [number, number]; asset: string; reason: string }[] } {
  const min = opts.minScore ?? 0.35;
  const recs: Recommendation[] = [], reqs: AssetRequest[] = [], skipped: { at: [number, number]; asset: string; reason: string }[] = [];
  const used = new Set<string>();
  for (const sg of segments) {
    const at: [number, number] = [Math.round(sg.t0 * 10) / 10, Math.round(sg.t1 * 10) / 10];
    const isDemo = DEMO.test(sg.text) || (!!opts.product && sg.text.toLowerCase().includes(opts.product.toLowerCase()));
    const hits = search(entries, sg.text, { max: 5 });
    let chosen: (typeof hits)[number] | undefined;
    for (const h of hits) {
      if (h.score < min) break;
      const e = entries.find((x) => x.id === h.id)!;
      if (!h.usable) { skipped.push({ at, asset: h.id, reason: `licence ${e.licence.id}${e.licence.verified ? '' : ' (unverified)'}: record the licence before use` }); continue; }
      if (isDemo && (e.kind === 'screen-recording' || e.kind === 'video') && e.genuine !== true) { skipped.push({ at, asset: h.id, reason: 'not marked as a genuine recording of the product; a demonstration needs one' }); continue; }
      if (used.has(h.id) && hits.some((o) => o.id !== h.id && o.score >= min && o.usable)) continue; // prefer variety
      chosen = h; break;
    }
    if (chosen) { const e = entries.find((x) => x.id === chosen!.id)!; used.add(e.id); recs.push({ at, text: sg.text.slice(0, 120), asset: e.id, kind: e.kind, score: chosen.score, matched: chosen.matched }); continue; }
    const kind: AssetKind | undefined = isDemo ? 'screen-recording' : NUMERIC.test(sg.text) ? 'chart' : PROCESS.test(sg.text) ? 'diagram' : tokens(sg.text).length >= 3 ? 'image' : undefined;
    if (!kind) continue;
    const key = [...new Set(tokens(sg.text))].slice(0, 6).join(' ');
    reqs.push({
      at, text: sg.text.slice(0, 120), kind, seconds: Math.round((sg.t1 - sg.t0) * 10) / 10, ...(opts.aspect && { aspect: opts.aspect }),
      need: kind === 'screen-recording' ? `a real screen recording of ${opts.product ?? 'the product'} showing: ${key}` : kind === 'chart' ? `the source figures for: ${key} (FRAME can animate a chart from data you confirm)` : kind === 'diagram' ? `the steps or structure for: ${key} (FRAME can build an animated diagram)` : `an image or clip of: ${key}`,
      reason: hits.length ? `best library match ${hits[0]!.id} scored ${hits[0]!.score} (< ${min})` : 'no library asset matches',
      mustBeGenuine: kind === 'screen-recording',
    });
  }
  return { recommendations: recs.slice(0, opts.max ?? 50), requests: reqs.slice(0, opts.max ?? 50), skipped: skipped.slice(0, 50) };
}
