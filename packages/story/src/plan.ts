/**
 * FRAME structured editing plan (Phase 5.4): intelligence → an inspectable, overridable plan → a
 * deterministic op list. The plan never decides taste on its own: every item cites its evidence and
 * dependencies, starts as `proposed`, and only the items the user leaves in compile.
 *
 * Times inside items are SOURCE seconds. Compilation keeps the retained source ranges (`keep`) and
 * maps every later placement onto the resulting timeline analytically, so the op list is identical
 * for identical inputs.
 */
import { createHash } from 'node:crypto';
import type { Word } from '../../core/src/index.ts';
import type { FootageAnalysis } from '../../media/src/footage.ts';
import { recommend, type AssetRequest, type LibraryEntry } from '../../media/src/library.ts';
import { centreToOffset } from '../../media/src/semantic.ts';
import { captionBand } from './director.ts';
import { detectList, detectStat, splitSentences } from './rules.ts';

export const PLAN_SCHEMA = 'frame.plan/1';
export const PLAN_KINDS = ['retain', 'moment', 'captions', 'graphic', 'graphic-zone', 'asset', 'reframe', 'jump-cut', 'audio', 'colour'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
export type Dep = 'footage' | 'transcript' | 'library' | 'format';

export interface PlanItem {
  id: string; kind: PlanKind;
  /** Source-time span the item concerns. */
  at?: [number, number];
  /** Op templates; `tl:<sourceSeconds>` strings and `library:<id>` sources are resolved at compile. */
  ops: Record<string, unknown>[];
  reason: string; evidence: string[]; confidence: number; deps: Dep[];
  status: 'proposed' | 'accepted' | 'dropped';
  recomputed?: boolean;
}
export interface EditPlan {
  schema: typeof PLAN_SCHEMA; task: string; asset: string; ratio: string;
  inputs: Record<Dep, string>;
  /** Project head revision the plan was built against (compile refuses a moved head unless rebased). */
  baseRev: number;
  items: PlanItem[]; requests: AssetRequest[]; notes: string[];
}
export interface PlanInputs { asset: string; dur: number; analysis: FootageAnalysis; words: Word[]; library: LibraryEntry[]; ratio: string; task: string; baseRev: number; /** Phase 6: pause threshold and padding from the Director. */ pause?: number; pad?: number }

const r2 = (x: number) => Math.round(x * 100) / 100;
const h = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

export function planInputs(i: PlanInputs): Record<Dep, string> {
  const a = i.analysis;
  return {
    footage: h({ v: a.provenance.map((p) => [p.analyzer, p.version]), shots: a.observed.shots.map((s) => [s.t0, s.t1]), m: a.inferred.moments.map((m) => m.t), sub: a.inferred.subjects, rf: a.inferred.reframe, q: a.observed.quality }),
    transcript: h(i.words.map((w) => [w.w, w.s, w.e])),
    library: h(i.library.map((e) => [e.id, e.sha256, e.tags, e.licence, e.genuine])),
    format: h([i.ratio, i.task]),
  };
}

/** Retained source ranges: speech (with padding) when there is a transcript, else non-silent audio, else all. */
export function retainedRanges(i: PlanInputs, pad = 0.15, gap = 0.8): { ranges: [number, number][]; basis: string } {
  if (i.words.length) {
    const out: [number, number][] = [];
    for (const w of i.words) {
      const last = out.at(-1);
      if (last && w.s - last[1] < gap) last[1] = w.e; else out.push([w.s, w.e]);
    }
    return { ranges: out.map(([s, e]) => [r2(Math.max(0, s - pad)), r2(Math.min(i.dur, e + pad))]), basis: `transcript speech, pauses ≥ ${gap} s removed, ${pad} s padding` };
  }
  const sil = i.analysis.observed.silences.filter((s) => s.t1 - s.t0 >= 1.0);
  if (i.analysis.asset.audio && sil.length) {
    const out: [number, number][] = [];
    let t = 0;
    for (const s of sil) { if (s.t0 - t > 0.3) out.push([r2(t), r2(s.t0 + pad)]); t = Math.max(t, s.t1 - pad); }
    if (i.dur - t > 0.3) out.push([r2(t), r2(i.dur)]);
    return { ranges: out, basis: 'audio silences ≥ 1 s removed (no transcript)' };
  }
  return { ranges: [[0, r2(i.dur)]], basis: 'whole source (no transcript, no silences)' };
}

/** Source time → output time after `keep ranges`; undefined when the moment was cut. */
export function mapToTimeline(ranges: [number, number][], t: number): number | undefined {
  let acc = 0;
  for (const [s, e] of ranges) { if (t >= s && t <= e) return r2(acc + (t - s)); acc += e - s; }
  return undefined;
}

export const FOLLOW_MAX_SPEED = 0.35;
/**
 * Follow keys from raw reframe keys: limit crop-centre speed (no whip pans), drop keys that a straight
 * line between neighbours already explains (≤ 0.01), keep shot changes as hard steps.
 */
export function smoothFollow(keys: { t: number; cx: number; cy: number }[], maxSpeed = FOLLOW_MAX_SPEED): { t: number; cx: number; cy: number }[] {
  if (!keys.length) return [];
  const out = [{ ...keys[0]! }];
  for (const k of keys.slice(1)) {
    const prev = out.at(-1)!, dt = Math.max(1e-3, k.t - prev.t), lim = maxSpeed * dt;
    const step = (a: number, b: number) => a + Math.max(-lim, Math.min(lim, b - a));
    out.push({ t: k.t, cx: r2(step(prev.cx, k.cx)), cy: r2(step(prev.cy, k.cy)) });
  }
  const kept = [out[0]!];
  for (let j = 1; j < out.length - 1; j++) {
    const a = kept.at(-1)!, b = out[j]!, c = out[j + 1]!, u = (b.t - a.t) / Math.max(1e-3, c.t - a.t);
    if (Math.abs(a.cx + (c.cx - a.cx) * u - b.cx) > 0.01 || Math.abs(a.cy + (c.cy - a.cy) * u - b.cy) > 0.01) kept.push(b);
  }
  if (out.length > 1) kept.push(out.at(-1)!);
  return kept.slice(0, 400);
}

export function buildPlan(i: PlanInputs): EditPlan {
  const a = i.analysis, inf = a.inferred, items: PlanItem[] = [];
  const add = (it: Omit<PlanItem, 'id' | 'status'>) => items.push({ ...it, id: `${it.kind}-${it.at ? it.at[0].toFixed(2) : items.filter((x) => x.kind === it.kind).length}`, status: 'proposed' });
  const ret = retainedRanges(i, i.pad ?? 0.15, i.pause ?? 0.8);
  add({ kind: 'retain', at: [0, r2(i.dur)], ops: [{ op: 'keep', src: i.asset, ranges: ret.ranges }], reason: `keep ${ret.ranges.length} ranges (${r2(ret.ranges.reduce((s, [x, y]) => s + y - x, 0))} of ${r2(i.dur)} s)`, evidence: [ret.basis], confidence: i.words.length ? 0.9 : 0.6, deps: i.words.length ? ['transcript'] : ['footage'] });

  const talky = ['informative', 'podcast', 'educational', 'generic', 'product'].includes(i.task);
  if (talky) {
    const ms = inf.moments.filter((m) => m.confidence >= 0.6 && mapToTimeline(ret.ranges, m.t) !== undefined).sort((x, y) => y.score - x.score).slice(0, Math.max(1, Math.floor(i.dur / 30)));
    for (const m of ms) add({ kind: 'moment', at: [m.t0, m.t1], ops: [{ op: 'punch', at: `tl:${m.t}`, to: 1.12, d: 0.6 }], reason: 'emphasize a strong moment with a restrained punch-in', evidence: m.evidence, confidence: m.confidence, deps: ['footage', 'transcript'] });
    // Jump cuts: a removed pause inside one continuous shot of one person.
    for (let k = 1; k < ret.ranges.length; k++) {
      const t = ret.ranges[k]![0], prev = ret.ranges[k - 1]![1];
      const shot = a.observed.shots.find((s) => s.t0 <= prev && s.t1 >= t);
      const type = shot && inf.sceneTypes?.find((x) => x.shot === shot.id)?.label;
      if (shot && (type === 'talking-head' || inf.presenter)) add({ kind: 'jump-cut', at: [r2(prev), r2(t)], ops: [{ op: 'punch', at: `tl:${t}`, to: k % 2 ? 1.08 : 1.0, d: 0 }], reason: 'a pause was removed inside one shot; alternate framing hides the jump', evidence: [`shot ${shot.id}${type ? ` (${type})` : ''} spans the removed pause ${r2(prev)}–${r2(t)} s`], confidence: 0.5, deps: ['footage', 'transcript'] });
    }
  }

  // Captions: in the band that covers the fewest heads (Phase 6; Phase 5 avoided body boxes and could
  // put captions on faces in full-body shots).
  const subj = a.observed.tracks?.find((t) => t.id === inf.subjects?.primary);
  const pos = captionBand(a);
  if (i.words.length) add({ kind: 'captions', ops: [{ op: 'captions', pos }], reason: `${pos} captions keep clear of the subject`, evidence: [subj || a.observed.faces?.length || inf.presenter ? 'head positions from person tracks, faces and the presenter region' : 'no people detected'], confidence: subj || inf.presenter ? 0.7 : 0.5, deps: ['footage', 'transcript', 'format'] });

  // Graphics from what is said (stats and lists only), placed by footage-aware compile later.
  if (talky && i.words.length) {
    const tlw = i.words.map((w, k) => ({ ...w, src: i.asset, i: k, k }));
    for (const sent of splitSentences(tlw as never)) {
      const stat = detectStat(sent), list = detectList(sent);
      if (stat && mapToTimeline(ret.ranges, stat.t) !== undefined) add({ kind: 'graphic', at: [r2(stat.t), r2(stat.t + 2.5)], ops: [{ op: 'gfx', preset: 'stat', at: `tl:${stat.t}`, props: { value: stat.value, ...(stat.label && { label: stat.label }) } }], reason: 'a spoken figure', evidence: [`"${stat.value}${stat.label ? ` ${stat.label}` : ''}" at ${r2(stat.t)} s`], confidence: 0.6, deps: ['transcript', 'footage'] });
      else if (list && list.length >= 2 && mapToTimeline(ret.ranges, list[0]!.t) !== undefined) add({ kind: 'graphic', at: [r2(list[0]!.t), r2(list.at(-1)!.t + 1)], ops: [{ op: 'gfx', preset: 'icons', at: `tl:${list[0]!.t}`, props: { items: list.map((l) => ({ label: l.label })) } }], reason: 'a spoken list', evidence: [list.map((l) => l.label).join(', ')], confidence: 0.55, deps: ['transcript', 'footage'] });
    }
  }
  if (inf.quietRegions.length) add({ kind: 'graphic-zone', ops: [], reason: 'regions with least motion/detail and no subject: candidate places for graphics (used by footage-aware compile)', evidence: inf.quietRegions.slice(0, 3).map((q) => `(${q.x}, ${q.y}) activity ${q.activity}`), confidence: 0.6, deps: ['footage'] });

  // Subject-aware reframe for a different output aspect: a static centre when the subject stays put,
  // smooth follow keyframes (source time) when it travels.
  const rf = inf.reframe?.find((r) => r.aspect === i.ratio && r.keys.length);
  if (rf) {
    // Keys are window centres; the renderer takes offsets (cx/cy/follow convention).
    const cw = rf.crop?.w ?? Math.min(1, (a.asset.h * 9) / 16 / a.asset.w), ch = rf.crop?.h ?? 1;
    const off = rf.keys.map((k) => ({ t: k.t, cx: centreToOffset(k.cx, cw), cy: centreToOffset(k.cy, ch) }));
    const xs = off.map((k) => k.cx).sort((p, q) => p - q), ys = off.map((k) => k.cy).sort((p, q) => p - q);
    const cx = xs[Math.floor(xs.length / 2)]!, cy = ys[Math.floor(ys.length / 2)]!;
    const travels = xs.at(-1)! - xs[0]! > 0.15;
    const follow = travels ? smoothFollow(off) : undefined;
    add({ kind: 'reframe', ops: [follow ? { op: 'reframe', cx, cy, follow } : { op: 'reframe', cx, cy }], reason: follow ? `follow ${rf.subject} with a smoothed ${i.ratio} crop (${follow.length} keys)` : `centre the ${i.ratio} crop on ${rf.subject}`, evidence: [rf.basis, `subject inside the crop in ${Math.round(rf.subjectInside * 100)}% of samples`, ...(travels ? [`subject travels (crop centre ${xs[0]}–${xs.at(-1)}): keyframed follow, speed-limited to ${FOLLOW_MAX_SPEED} frame widths/s`] : [])], confidence: r2(0.4 + 0.5 * rf.subjectInside), deps: ['footage', 'format'] });
  }

  // Audio and colour: measured, conservative.
  if (a.asset.audio && i.words.length) add({ kind: 'audio', ops: [{ op: 'audio', comp: 'medium' }], reason: 'dialogue: gentle compression (gain is staged to the measured loudness before the compressor)', evidence: [`${i.words.length} transcribed words`], confidence: 0.7, deps: ['transcript'] });
  const darkSec = a.observed.quality.filter((q) => q.flags.includes('dark')).reduce((s, q) => { const sh = a.observed.shots.find((x) => x.id === q.shot)!; return s + sh.t1 - sh.t0; }, 0);
  const overSec = a.observed.quality.filter((q) => q.flags.includes('overexposed')).reduce((s, q) => { const sh = a.observed.shots.find((x) => x.id === q.shot)!; return s + sh.t1 - sh.t0; }, 0);
  if (darkSec > i.dur / 2) add({ kind: 'colour', ops: [{ op: 'color', exposure: 0.3 }], reason: 'most of the source is dark', evidence: [`${r2(darkSec)} s of ${r2(i.dur)} s flagged dark (mean luma < 40)`], confidence: 0.6, deps: ['footage'] });
  else if (overSec > i.dur / 2) add({ kind: 'colour', ops: [{ op: 'color', exposure: -0.2, highlights: -0.3 }], reason: 'most of the source clips highlights', evidence: [`${r2(overSec)} s of ${r2(i.dur)} s flagged overexposed`], confidence: 0.6, deps: ['footage'] });

  // Assets from the library for what is said; requests where nothing fits.
  let requests: AssetRequest[] = [];
  if (i.words.length && talky) {
    const segs: { t0: number; t1: number; text: string }[] = [];
    for (const w of i.words) { const l = segs.at(-1); if (l && w.s - l.t1 < 0.6 && l.t1 - l.t0 < 8 && !/[.!?]$/.test(l.text)) { l.t1 = w.e; l.text += ` ${w.w}`; } else segs.push({ t0: w.s, t1: w.e, text: w.w }); }
    const rec = recommend(i.library, segs.filter((s) => mapToTimeline(ret.ranges, s.t0) !== undefined), { aspect: i.ratio });
    for (const r of rec.recommendations) add({ kind: 'asset', at: r.at, ops: [{ op: 'broll', src: `library:${r.asset}`, at: `tl:${r.at[0]}`, d: r2(Math.min(4, Math.max(1.5, r.at[1] - r.at[0]))) }], reason: `library ${r.kind} ${r.asset} matches what is said`, evidence: [`matched: ${r.matched.join(', ')}`, `"${r.text}"`], confidence: r2(Math.min(0.9, r.score)), deps: ['library', 'transcript'] });
    requests = rec.requests;
  }
  const notes = [
    'every item is a proposal: override with accept/drop/ops; compile includes proposed and accepted items, never dropped ones',
    ...(a.capabilities.semantic?.status !== 'ok' ? ['semantic layer not run: no subject-aware reframe or subject-based caption placement'] : []),
    ...(!i.words.length ? ['no transcript: no captions, graphics, assets or jump-cut items'] : []),
  ];
  return { schema: PLAN_SCHEMA, task: i.task, asset: i.asset, ratio: i.ratio, inputs: planInputs(i), baseRev: i.baseRev, items, requests, notes };
}

/**
 * Rebuild only what changed: items whose dependencies all kept their hashes are carried over with
 * their user status; the rest are replaced by freshly built items marked `recomputed`.
 */
export function refreshPlan(prev: EditPlan, i: PlanInputs): { plan: EditPlan; changed: Dep[]; kept: number; recomputed: number } {
  const next = buildPlan(i);
  const changed = (Object.keys(next.inputs) as Dep[]).filter((k) => next.inputs[k] !== prev.inputs[k]);
  const stale = (it: PlanItem) => it.deps.some((d) => changed.includes(d));
  const kept = prev.items.filter((it) => !stale(it)).map(({ recomputed: _r, ...it }) => it);
  const fresh = next.items.filter((it) => stale(it)).map((it) => {
    const old = prev.items.find((o) => o.id === it.id);
    return { ...it, recomputed: true, ...(old?.status === 'dropped' && { status: 'dropped' as const }) };
  });
  const items = [...kept, ...fresh].sort((x, y) => PLAN_KINDS.indexOf(x.kind) - PLAN_KINDS.indexOf(y.kind) || (x.at?.[0] ?? 0) - (y.at?.[0] ?? 0));
  return { plan: { ...next, items, baseRev: i.baseRev, requests: changed.length ? next.requests : prev.requests }, changed, kept: kept.length, recomputed: fresh.length };
}

export type Override = 'accept' | 'drop' | { ops: Record<string, unknown>[] };
export function applyOverrides(plan: EditPlan, overrides: Record<string, Override>): EditPlan {
  const unknown = Object.keys(overrides).filter((id) => !plan.items.some((it) => it.id === id));
  if (unknown.length) throw new Error(`unknown plan item(s): ${unknown.join(', ')}`);
  return { ...plan, items: plan.items.map((it) => { const o = overrides[it.id]; if (!o) return it; if (o === 'accept') return { ...it, status: 'accepted' }; if (o === 'drop') return { ...it, status: 'dropped' }; return { ...it, ops: o.ops, status: 'accepted' }; }) };
}

/** Deterministic op list: keep first, then everything else in kind order with mapped times. */
export function compilePlan(plan: EditPlan, resolveLibrary: (id: string) => string, opts: { ranges?: [number, number][] } = {}): { ops: Record<string, unknown>[]; skipped: { id: string; why: string }[] } {
  const live = plan.items.filter((it) => it.status !== 'dropped');
  const retain = live.find((it) => it.kind === 'retain');
  // Explicit ranges (an already-applied rough cut) map times without emitting the keep op again.
  const ranges = opts.ranges ?? (retain?.ops[0]?.ranges as [number, number][] | undefined) ?? [[0, Infinity]];
  const ops: Record<string, unknown>[] = [], skipped: { id: string; why: string }[] = [];
  for (const it of [...live].sort((x, y) => PLAN_KINDS.indexOf(x.kind) - PLAN_KINDS.indexOf(y.kind) || (x.at?.[0] ?? 0) - (y.at?.[0] ?? 0))) {
    for (const op of it.ops) {
      const o: Record<string, unknown> = {};
      let bad = '';
      for (const [k, v] of Object.entries(op)) {
        if (typeof v === 'string' && v.startsWith('tl:')) { const t = mapToTimeline(ranges, Number(v.slice(3))); if (t === undefined) bad = `${k} ${v.slice(3)} s falls in removed footage`; else o[k] = t; }
        else if (typeof v === 'string' && v.startsWith('library:')) o[k] = resolveLibrary(v.slice(8));
        else o[k] = v;
      }
      if (bad) skipped.push({ id: it.id, why: bad }); else ops.push(o);
    }
  }
  return { ops, skipped };
}
