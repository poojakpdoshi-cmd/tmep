/**
 * FRAME production orchestrator (Phase 6.1/6.3/6.5): a persistent, resumable pipeline
 *
 *   ingest → intelligence → brief → strategy → roughcut → assets → motion → fine → finish
 *          → preview → inspect → correct → final
 *
 * State lives in `.tmep/productions/<id>.json` (`frame.production/1`). Each stage records the hash of
 * its inputs; a resumed or revised production re-runs only stages whose inputs changed and everything
 * after them. Editing stages commit their own project revision (undo per stage); re-running one first
 * checks out the revision of the stage before it, so history is never rewritten. Explicit user
 * constraints are never overridden by corrections; what cannot be decided deterministically is
 * reported, not guessed.
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { TmepError, hashOf, readJsonOr, writeJson } from '../../core/src/index.ts';
import { parseOpString } from '../../core/src/ops.ts';
import * as api from './api.ts';
import { editingBrief } from '../../story/src/brief.ts';
import { buildPlan, compilePlan, mapToTimeline, type EditPlan, type PlanItem } from '../../story/src/plan.ts';
import { direct, GENRES, type Constraints, type Genre, type Strategy } from '../../story/src/director.ts';
import { colourStats, styleFromAnalysis, type StyleProfile } from '../../media/src/style.ts';
import { scoreSentence, sentences, keywords } from '../../speech/src/analyze.ts';

export const PRODUCTION_SCHEMA = 'frame.production/1';
export const STAGES = ['ingest', 'intelligence', 'brief', 'strategy', 'roughcut', 'assets', 'motion', 'fine', 'finish', 'preview', 'inspect', 'correct', 'final'] as const;
export type Stage = (typeof STAGES)[number];
const EDIT_STAGES: Stage[] = ['roughcut', 'assets', 'motion', 'fine', 'finish', 'correct'];
const MAX_CORRECTION_CYCLES = 2;

export interface StageOverride { skip?: boolean; ops?: Record<string, unknown>[]; drop?: string[] }
export interface ProductionInput {
  action?: 'start' | 'resume' | 'status' | 'revise' | 'report';
  id?: string;
  /** Source asset (imported video with speech or footage). */
  asset?: string;
  genre?: Genre;
  goal?: string;
  constraints?: Constraints;
  /** A reference video asset whose measurable style informs (not dictates) the strategy. */
  reference?: string;
  overrides?: Partial<Record<Stage, StageOverride>>;
  /** Run through this stage (default: inspect + correct; `final` renders the full-quality output). */
  until?: Stage;
  semantic?: boolean;
}
interface StageState { status: 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled'; hash?: string; rev?: number; ms?: number; error?: string; out?: Record<string, unknown> }
export interface Production {
  schema: typeof PRODUCTION_SCHEMA; id: string; created: string; updated: string;
  asset: string; genre: Genre; goal?: string; constraints: Constraints; reference?: string; overrides: Partial<Record<Stage, StageOverride>>;
  stages: Record<Stage, StageState>;
  strategy?: Strategy; style?: StyleProfile; plan?: EditPlan;
  history: { at: string; event: string }[];
  report?: Record<string, unknown>;
}

/** Productions running in this process (the file lock covers other processes). */
const RUNNING = new Set<string>();
const file = (root: string, id: string) => path.join(root, '.tmep', 'productions', `${id}.json`);
const now = () => new Date().toISOString();

/** The part of the strategy an editing stage depends on (so a caption change does not redo the rough cut). */
function strategySection(st: Stage, s?: Strategy): unknown {
  if (!s) return null;
  switch (st) {
    case 'roughcut': return [s.pacing, s.ratio, s.target];
    case 'assets': return s.assets;
    case 'motion': return [s.graphics, s.ratio];
    case 'fine': return [s.zooms, s.jumpCuts, s.captions, s.effectBudgetPerMinute, s.graphics.allowed];
    case 'finish': return [s.colour, s.audio];
    default: return null;
  }
}

function stageHash(pr: Production, st: Stage, upstream: string): string {
  const c = pr.constraints, o = pr.overrides[st];
  const rel: Partial<Record<Stage, unknown>> = {
    ingest: [pr.asset], intelligence: [pr.asset], brief: [pr.genre], strategy: [pr.genre, pr.goal, c, pr.reference],
    roughcut: [c.target, c.keep, c.avoid], assets: [], motion: [c.graphics], fine: [c.zooms, c.captions], finish: [c.music, c.allowLook],
    preview: [], inspect: [], correct: [], final: [],
  };
  return hashOf({ st, upstream, rel: rel[st] ?? null, o: o ?? null });
}

/** Shorten retained ranges to a target length: drop the least informative sentences first; honour keep/avoid. */
export function fitRanges(ranges: [number, number][], words: { w: string; s: number; e: number }[], c: Constraints, moments: number[]): { ranges: [number, number][]; dropped: number } {
  let rs = ranges.map((r) => [...r] as [number, number]);
  for (const [a, b] of c.avoid ?? []) rs = rs.flatMap(([s, e]) => (e <= a || s >= b ? [[s, e]] : [...(s < a ? [[s, a]] : []), ...(e > b ? [[b, e]] : [])]) as [number, number][]);
  const len = () => rs.reduce((s, [a, b]) => s + b - a, 0);
  if (!c.target || len() <= c.target) return { ranges: rs.filter(([a, b]) => b - a > 0.2), dropped: 0 };
  const ss = sentences(words as never);
  const kw = new Set(keywords(words as never, 8).map((k) => k.k));
  const kept = (s: number, e: number) => (c.keep ?? []).some(([a, b]) => s < b && e > a);
  const scored = ss.map((x) => ({ s: x.s, e: x.e, score: scoreSentence(x, words as never, kw) + (moments.some((t) => t >= x.s && t <= x.e) ? 2 : 0) })).filter((x) => !kept(x.s, x.e)).sort((a, b) => a.score - b.score);
  let dropped = 0;
  for (const x of scored) {
    if (len() <= c.target) break;
    rs = rs.flatMap(([s, e]) => (e <= x.s - 0.05 || s >= x.e + 0.05 ? [[s, e]] : [...(s < x.s - 0.05 ? [[s, x.s - 0.05]] : []), ...(e > x.e + 0.05 ? [[x.e + 0.05, e]] : [])]) as [number, number][]);
    dropped++;
  }
  return { ranges: rs.filter(([a, b]) => b - a > 0.2).map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100]), dropped };
}

/** Plan items allowed by the strategy, within the effect budget (lowest confidence dropped first). */
export function itemsFor(stage: Stage, plan: EditPlan, s: Strategy, minutes: number): PlanItem[] {
  const live = plan.items.filter((i) => i.status !== 'dropped');
  const pick = (k: PlanItem['kind'][]) => live.filter((i) => k.includes(i.kind));
  if (stage === 'assets') return s.assets.allowed ? pick(['asset']) : [];
  if (stage === 'motion') return [...(s.graphics.allowed ? pick(['graphic']).filter((i) => s.graphics.kinds.includes(String(i.ops[0]?.preset))) : []), ...pick(['reframe'])];
  if (stage === 'fine') {
    const zoomCap = Math.floor(s.zooms.perMinute * Math.max(0.5, minutes));
    const moments = s.zooms.allowed ? pick(['moment']).sort((a, b) => b.confidence - a.confidence).slice(0, zoomCap) : [];
    const jumps = s.jumpCuts === 'punch-alternate' ? pick(['jump-cut']) : [];
    const graphics = s.graphics.allowed ? pick(['graphic']).length : 0;
    const budget = Math.max(0, Math.floor(s.effectBudgetPerMinute * Math.max(0.5, minutes)) - moments.length - graphics);
    return [...moments, ...jumps.slice(0, Math.max(budget, 0) + jumps.filter((j) => j.ops[0]?.to === 1).length)];
  }
  if (stage === 'finish') return pick(['audio', 'colour']);
  return [];
}

export async function produce(ctx: api.Ctx, inp: ProductionInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const action = inp.action ?? (inp.id ? 'resume' : 'start');
  const p = await api.openProject(ctx.project, action === 'start', ctx.projectRoots);
  let pr: Production;
  if (action === 'start') {
    if (!inp.asset) throw new TmepError('E_INPUT', 'produce needs asset', 'import the footage first; e.g. {asset:"v1", genre:"informative"}');
    if (!inp.genre || !(GENRES as readonly string[]).includes(inp.genre)) throw new TmepError('E_INPUT', `genre must be one of ${GENRES.join('|')}`);
    await p.asset(inp.asset);
    if (inp.reference) await p.asset(inp.reference);
    const id = inp.id ?? `p${Date.now().toString(36)}`;
    if (!/^[a-z0-9-]{1,40}$/i.test(id)) throw new TmepError('E_INPUT', 'production id: letters, digits, dashes (≤ 40)');
    pr = { schema: PRODUCTION_SCHEMA, id, created: now(), updated: now(), asset: inp.asset, genre: inp.genre, ...(inp.goal && { goal: inp.goal }), constraints: inp.constraints ?? {}, ...(inp.reference && { reference: inp.reference }), overrides: inp.overrides ?? {}, stages: Object.fromEntries(STAGES.map((s) => [s, { status: 'pending' }])) as Production['stages'], history: [{ at: now(), event: 'start' }] };
  } else {
    if (!inp.id || !/^[a-z0-9-]{1,40}$/i.test(inp.id)) throw new TmepError('E_INPUT', 'production id required');
    const prev = await readJsonOr<Production | undefined>(file(p.root, inp.id), undefined);
    if (!prev) throw new TmepError('E_NOT_FOUND', `production ${inp.id} not found`);
    pr = prev;
    if (action === 'status' || action === 'report') return view(pr, ctx.detail);
    // Recovery: a stage left "running" by a crashed or cancelled process is simply re-run.
    for (const st of STAGES) if (pr.stages[st].status === 'running') { pr.stages[st] = { status: 'pending' }; pr.history.push({ at: now(), event: `recovered ${st}` }); }
    if (action === 'revise') {
      if (inp.constraints) pr.constraints = { ...pr.constraints, ...inp.constraints };
      if (inp.overrides) pr.overrides = { ...pr.overrides, ...inp.overrides };
      if (inp.goal) pr.goal = inp.goal;
      pr.history.push({ at: now(), event: `revise ${JSON.stringify({ constraints: inp.constraints, overrides: inp.overrides })}`.slice(0, 300) });
    }
  }
  let analysis: Awaited<ReturnType<typeof api.footageAnalysis>>['analysis'] | undefined;
  let words: { w: string; s: number; e: number }[] = [];
  let approx = false, unverified: string | undefined;
  // One runner per production: a lock file with the owner pid; a dead owner's lock is reclaimed.
  const lock = file(p.root, pr.id).replace(/\.json$/, '.lock');
  if (RUNNING.has(lock)) throw new TmepError('E_CONFLICT', `production ${pr.id} is already running`, 'wait for it, or cancel it');
  RUNNING.add(lock); // claimed synchronously with the check: no in-process race
  try {
  await fsp.mkdir(path.dirname(lock), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { await fsp.writeFile(lock, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt) throw new TmepError('E_CONFLICT', `production ${pr.id} is already running`, 'wait for it, or cancel it');
      const owner = Number(await fsp.readFile(lock, 'utf8').catch(() => '0'));
      let alive = false; try { if (owner) { process.kill(owner, 0); alive = true; } } catch { /* dead */ }
      if (alive && owner !== process.pid) throw new TmepError('E_CONFLICT', `production ${pr.id} is running in pid ${owner}`, 'wait for it, or cancel it');
      await fsp.rm(lock, { force: true });
    }
  }
  try { return await run(); } finally { await fsp.rm(lock, { force: true }); }
  } finally { RUNNING.delete(lock); }

  async function run(): Promise<Record<string, unknown>> {
  const until = inp.until ?? 'correct';
  const stop = STAGES.indexOf(until);
  const save = async () => { pr.updated = now(); await writeJson(file(p.root, pr.id), pr, false); };
  await save();

  let upstream = '', lastRev = 0, intelHash = '';
  const recomputed: Stage[] = [];
  for (const [k, st] of STAGES.entries()) {
    if (k > stop) break;
    if (signal?.aborted) { pr.stages[st] = { status: 'cancelled' }; pr.history.push({ at: now(), event: `cancelled before ${st}` }); await save(); throw new TmepError('E_CANCELLED', `production ${pr.id} cancelled before ${st}; resume to continue`); }
    // Editing stages chain on each other plus their own strategy section; the strategy stage itself is
    // not in their chain, so only the stages whose section changed (and later ones) recompute.
    const up = st === 'roughcut' ? hashOf([intelHash, strategySection(st, pr.strategy)]) : EDIT_STAGES.includes(st) && st !== 'correct' ? hashOf([upstream, strategySection(st, pr.strategy)]) : upstream;
    const h = stageHash(pr, st, up);
    const cur = pr.stages[st];
    const needData = ['intelligence', 'brief', 'strategy', 'roughcut', 'assets', 'motion', 'fine', 'finish', 'correct'].includes(st);
    if (needData && !analysis && k >= 1) {
      analysis = (await api.footageAnalysis(p, { asset: pr.asset, faces: true, semantic: inp.semantic })).analysis;
      const tr = (await api.transcriptsFor(p, [pr.asset]))[pr.asset] ?? [];
      words = tr;
      const q = (await p.asset(pr.asset)).tr ? await transcriptQuality(p, pr.asset) : { approx: false };
      approx = q.approx; unverified = q.unverified;
    }
    if (cur.hash === h && (cur.status === 'done' || cur.status === 'skipped')) { if (st === 'intelligence') intelHash = h; if (st !== 'brief' && st !== 'strategy') upstream = h; if (cur.rev !== undefined) lastRev = cur.rev; continue; }
    // Editing stage re-run: start from the revision the previous editing stage left (history kept).
    if (EDIT_STAGES.includes(st) && lastRev && (await p.manifest()).head !== lastRev) await api.edit(ctx, { checkout: lastRev });
    pr.stages[st] = { status: 'running' }; await save();
    const t0 = Date.now();
    try {
      const ov = pr.overrides[st];
      if (ov?.skip) { pr.stages[st] = { status: 'skipped', hash: h, ms: 0, out: { reason: 'skipped by override' } }; if (st !== 'brief' && st !== 'strategy') upstream = h; await save(); continue; }
      const out = await runStage(st);
      pr.stages[st] = { status: 'done', hash: h, ms: Date.now() - t0, out, ...(out.rev !== undefined && { rev: out.rev as number }) };
      if (out.rev !== undefined) lastRev = out.rev as number;
      recomputed.push(st);
    } catch (e) {
      pr.stages[st] = { status: (e as TmepError).code === 'E_CANCELLED' ? 'cancelled' : 'failed', hash: undefined, ms: Date.now() - t0, error: (e as Error).message };
      pr.history.push({ at: now(), event: `${st} failed: ${(e as Error).message}`.slice(0, 300) });
      await save();
      throw e;
    }
    if (st === 'intelligence') intelHash = h;
    if (st !== 'brief' && st !== 'strategy') upstream = h;
    await save();
  }
  pr.report = report(pr);
  await save();
  return { ...view(pr, ctx.detail), recomputed };
  }

  async function runStage(st: Stage): Promise<Record<string, unknown>> {
    const a = analysis!;
    const ov = pr.overrides[st];
    const applyOps = async (ops: Record<string, unknown>[], note: string) => {
      const final = ov?.ops ?? ops;
      if (!final.length) return { ops: 0, rev: (await p.manifest()).head };
      const r = await api.edit(ctx, { ops: final, note: `production ${pr.id}: ${note}` }) as { rev: number; did?: string[] };
      return { ops: final.length, rev: r.rev, did: r.did };
    };
    switch (st) {
      case 'ingest': { const as = await p.asset(pr.asset); return { asset: as.id, dur: as.dur, audio: as.audio, transcript: !!as.tr }; }
      case 'intelligence': return { shots: a.observed.shots.length, transitions: a.observed.transitions?.length ?? 0, moments: a.inferred.moments.length, semantic: a.capabilities.semantic?.status ?? 'not requested', words: words.length, transcriptApprox: approx };
      case 'brief': { const b = editingBrief(a, pr.genre, words as never, 6); return { keys: Object.keys(b), size: JSON.stringify(b).length }; }
      case 'strategy': {
        if (pr.reference) {
          const ra = (await api.footageAnalysis(p, { asset: pr.reference, temporalText: true, semantic: inp.semantic })).analysis;
          pr.style = styleFromAnalysis(ra, await colourStats((await p.asset(pr.reference)).path));
        }
        pr.strategy = direct({ genre: pr.genre, goal: pr.goal, constraints: pr.constraints }, a, words, { transcriptApprox: approx, transcriptUnverified: unverified, reference: pr.style });
        return { decisions: pr.strategy.decisions.length, open: pr.strategy.open };
      }
      case 'roughcut': {
        const s = pr.strategy!;
        if ((await p.manifest()).head === 0 || !(await p.timeline().catch(() => undefined))) await api.edit(ctx, { ratio: s.ratio as never, ops: [] }).catch(() => undefined);
        const lib = (await api.readLibrary(p)).entries;
        pr.plan = buildPlan({ asset: pr.asset, dur: a.asset.dur, analysis: a, words: words as never, library: lib, ratio: s.ratio, task: pr.genre, baseRev: (await p.manifest()).head, pause: s.pacing.removePausesOver, pad: s.pacing.padding });
        const retain = pr.plan.items.find((i) => i.kind === 'retain')!;
        const fit = fitRanges(retain.ops[0]!.ranges as [number, number][], words, pr.constraints, a.inferred.moments.map((m) => m.t));
        retain.ops[0]!.ranges = fit.ranges;
        const res = await applyOps([{ op: 'format', ratio: s.ratio }, ...retain.ops], 'rough cut');
        return { ...res, ranges: fit.ranges.length, seconds: Math.round(fit.ranges.reduce((x, [u, v]) => x + v - u, 0) * 10) / 10, droppedSentences: fit.dropped };
      }
      case 'assets': case 'motion': case 'fine': case 'finish': {
        const s = pr.strategy!, plan = pr.plan!;
        const minutes = ((plan.items.find((i) => i.kind === 'retain')!.ops[0]!.ranges as [number, number][]).reduce((x, [u, v]) => x + v - u, 0)) / 60;
        let items = itemsFor(st, plan, s, minutes).filter((i) => !(ov?.drop ?? []).includes(i.id));
        const lib = (await api.readLibrary(p)).entries;
        const imported = new Map<string, string>();
        for (const it of items) for (const op of it.ops) for (const v of Object.values(op)) if (typeof v === 'string' && v.startsWith('library:') && !imported.has(v.slice(8))) {
          const e = lib.find((x) => x.id === v.slice(8));
          if (e) imported.set(e.id, ((await api.importMedia(ctx, { paths: [e.file] })) as { assets: { id: string }[] }).assets[0]!.id);
        }
        const ranges = plan.items.find((i) => i.kind === 'retain')!.ops[0]!.ranges as [number, number][];
        const { ops, skipped } = compilePlan({ ...plan, items }, (id) => imported.get(id) ?? id, { ranges });
        if (st === 'fine') ops.push(s.captions.burn ? { op: 'captions', pos: s.captions.position } : { op: 'captions', style: 'none' });
        if (st === 'finish') { if (s.colour.look?.saturation) ops.push({ op: 'color', saturation: s.colour.look.saturation }); if (s.audio.music) ops.push({ op: 'music', src: s.audio.music }); }
        items = items.filter((i) => !skipped.some((x) => x.id === i.id));
        const res = await applyOps(ops, st);
        return { ...res, items: items.map((i) => i.id), ...(skipped.length && { skipped }) };
      }
      case 'preview': {
        const out = path.join(p.root, 'renders', `${pr.id}-preview.mp4`);
        const r = await api.render(ctx, { out, preview: true, wait: 600 }) as { state: string; out?: string; s?: number };
        if (r.state !== 'done') throw new TmepError('E_INTERNAL', `preview render ${r.state}`);
        return { file: path.relative(p.root, out), seconds: r.s };
      }
      case 'inspect': return { findings: prioritize(await qa()) };
      case 'correct': return correct();
      case 'final': {
        const out = path.join(p.root, 'renders', `${pr.id}.mp4`);
        const r = await api.render(ctx, { out, quality: 'high' as never, wait: 3600 }) as { state: string; s?: number };
        if (r.state !== 'done') throw new TmepError('E_INTERNAL', `final render ${r.state}`);
        return { file: path.relative(p.root, out), seconds: r.s };
      }
    }
  }

  async function qa(): Promise<Finding[]> {
    const prev = pr.stages.preview.out?.file as string | undefined;
    const r = await api.inspect(ctx, { what: 'qa', ...(prev && { file: path.join(p.root, prev) }) }) as { findings: Finding[] };
    return r.findings;
  }

  /** Bounded, deterministic corrections that never contradict an explicit instruction. */
  async function correct(): Promise<Record<string, unknown>> {
    const c = pr.constraints;
    const applied: string[] = [], refused: string[] = [];
    let findings = prioritize(await qa());
    let cycles = 0, seen = '';
    while (cycles < MAX_CORRECTION_CYCLES) {
      const key = findings.map((f) => f.code).sort().join(',');
      if (!findings.length || key === seen) break; // nothing left, or the same defects persist: stop
      seen = key; cycles++;
      const ops: Record<string, unknown>[] = [];
      for (const f of findings) {
        if (f.fix && /^reframe /.test(f.fix)) { ops.push(parseOpString(f.fix) as Record<string, unknown>); applied.push(`${f.code}: ${f.fix}`); }
        else if (f.code === 'captions-over-presenter' && c.captions !== false) { const tl = await p.timeline(); const pos = tl.captions.pos === 'upper' ? 'lower' : 'upper'; ops.push({ op: 'captions', pos }); applied.push(`${f.code}: captions ${pos}`); }
        else if (f.code === 'repetitive-zoom') refused.push(`${f.code}: ${c.zooms === true ? 'zooms were explicitly requested' : 'zoom count comes from the plan; lower zooms.perMinute or drop moment items'}`);
      }
      if (!ops.length) break;
      await api.edit(ctx, { ops, note: `production ${pr.id}: correction ${cycles}` });
      findings = prioritize(await qa());
    }
    const unresolved = findings.filter((f) => f.severity !== 'info').map((f) => `${f.code}: ${f.msg}`.slice(0, 200));
    return { cycles, applied, refused, unresolved, rev: (await p.manifest()).head };
  }
}

interface Finding { code: string; severity: string; msg: string; fix?: string }
const SEV: Record<string, number> = { defect: 0, error: 0, advisory: 1, warning: 1, info: 2 };
/** Defects first, then advisories by kind (subject/legibility before taste). */
export function prioritize(f: Finding[]): Finding[] {
  const kind = (c: string) => (/presenter|subject|crop|caption|safe|clip|loud|sync/.test(c) ? 0 : 1);
  return [...f].sort((a, b) => (SEV[a.severity] ?? 1) - (SEV[b.severity] ?? 1) || kind(a.code) - kind(b.code)).slice(0, 30);
}

/** Small local ASR models whose measured accuracy (docs/phase-6/INTELLIGENCE.md) is too low for unreviewed captions. */
const UNVERIFIED_ENGINES = new Set(['sherpa-onnx']);
/** Models measured caption-grade in Phase 7 (Parakeet-TDT 0.6B: FLEURS-en WER 9.6 %; film dialogue 33 % vs condensed subtitles). */
const CAPTION_GRADE_MODELS = /parakeet/i;
async function transcriptQuality(p: Awaited<ReturnType<typeof api.openProject>>, asset: string): Promise<{ approx: boolean; unverified?: string }> {
  const a = await p.asset(asset);
  const tr = await readJsonOr<{ approx?: boolean; engine?: string; model?: string } | undefined>(p.cachePath('tr', `${a.tr}.json`), undefined);
  return { approx: !!tr?.approx, ...(tr?.engine && UNVERIFIED_ENGINES.has(tr.engine) && !CAPTION_GRADE_MODELS.test(tr.model ?? '') && { unverified: `${tr.engine}${tr.model ? ` ${tr.model}` : ''}` }) };
}

function report(pr: Production): Record<string, unknown> {
  const s = pr.strategy;
  return {
    stages: Object.fromEntries(STAGES.map((st) => [st, pr.stages[st].status])),
    revisions: Object.fromEntries(EDIT_STAGES.filter((st) => pr.stages[st].rev !== undefined).map((st) => [st, pr.stages[st].rev])),
    ...(s && { decisions: s.decisions.map((d) => `${d.what} — ${d.why}`), openDecisions: s.open }),
    ...(pr.stages.correct.out && { unresolved: pr.stages.correct.out.unresolved, refused: pr.stages.correct.out.refused }),
    ...(pr.stages.final.out?.file ? { output: pr.stages.final.out.file } : pr.stages.preview.out?.file ? { preview: pr.stages.preview.out.file } : {}),
  };
}

function view(pr: Production, detail?: string): Record<string, unknown> {
  return { ok: 1, id: pr.id, genre: pr.genre, report: pr.report ?? report(pr), ...(detail !== 'minimal' && { stages: Object.fromEntries(STAGES.map((st) => [st, { status: pr.stages[st].status, ...(pr.stages[st].ms !== undefined && { ms: pr.stages[st].ms }), ...(pr.stages[st].error && { error: pr.stages[st].error }), ...(detail === 'debug' && pr.stages[st].out && { out: pr.stages[st].out }) }])) }), ...(detail === 'debug' && { strategy: pr.strategy, style: pr.style }) };
}

export { mapToTimeline };
