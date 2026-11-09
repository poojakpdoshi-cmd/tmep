/**
 * TMEP engine facade: the single API used by both the MCP server and the CLI.
 * Every function takes a small input object, does the heavy work locally, persists
 * results to the project, and returns a compact, detail-shaped object.
 */
import path from 'node:path';
import { promises as fsp, statSync } from 'node:fs';
import {
  Project,
  type Detail,
  type Timeline,
  type Word,
  type Asset,
  TmepError,
  shape,
  mediaHash,
  hashOf,
  readJsonOr,
  writeJson,
  exists,
  r2,
  applyOps,
  diffTimelines,
  layout,
  timelineWords,
  duration,
  emptyTimeline,
  resolveRef,
  resolveAnchor,
  fmtTime,
  OP_SCHEMAS,
  TRANSITIONS,
  fxSummary,
  type Ratio,
  RATIOS,
  VERSION,
  PROTOCOL,
} from '../../core/src/index.ts';
import { probe, detectSilence, extractSpeechWav, ffmpegInfo } from '../../media/src/ffmpeg.ts';
import { analyzeReferenceReel, type ReferenceOptions, type ReferencePacing } from '../../media/src/reference.ts';
import { type Transcript, makeTranscript, parseSubtitles, parseTranscriptJson, transcriptText } from '../../speech/src/transcript.ts';
import { transcribeWhisperCpp, transcribeFasterWhisper, findWhisperCpp, resolveGgmlModel, hasFasterWhisper, engineStatus } from '../../speech/src/engines.ts';
import { sentences, speechStats, keywords, searchSentences } from '../../speech/src/analyze.ts';
import { planTimeline } from '../../story/src/planner.ts';
import { TEMPLATES } from '../../story/src/templates.ts';
import { PRESET_NAMES, presetCatalog } from '../../motion/src/presets.ts';
import { ICON_NAMES } from '../../motion/src/icons.ts';
import { SFX, SFX_KINDS } from '../../render/src/sfx.ts';
import { renderTimeline, contactSheet, type RenderOptions } from '../../render/src/render.ts';
import { startJob, waitJob, cancelJob, jobView, readJob } from '../../render/src/jobs.ts';

export interface Ctx {
  project: string;
  detail: Detail;
}

export async function openProject(dir: string, create = true): Promise<Project> {
  return Project.open(dir, { create });
}

// ---------------------------------------------------------------- import
export async function importMedia(ctx: Ctx, inp: { paths: string[] }): Promise<Record<string, unknown>> {
  const p = await openProject(ctx.project);
  const out: Record<string, unknown>[] = [];
  for (const raw of inp.paths) {
    const file = path.resolve(ctx.project, raw);
    if (!(await exists(file))) throw new TmepError('E_NOT_FOUND', `file not found: ${raw}`);
    const pr = await probe(file);
    const { asset, existed } = await p.addAsset({
      kind: pr.kind,
      path: file,
      name: path.basename(file),
      hash: mediaHash(file),
      dur: pr.dur,
      w: pr.w,
      h: pr.h,
      fps: pr.fps,
      audio: pr.audio,
      vcodec: pr.vcodec,
      acodec: pr.acodec,
      size: statSync(file).size,
    });
    out.push(
      shape(ctx.detail, { id: asset.id, dur: asset.dur }, { kind: asset.kind, ...(asset.w ? { res: `${asset.w}x${asset.h}`, fps: asset.fps } : {}), audio: asset.audio, ...(existed ? { existed: true } : {}), ...(asset.tr ? { transcribed: true } : {}) }, { path: asset.path, hash: asset.hash }),
    );
  }
  return { ok: 1, assets: out };
}

// ---------------------------------------------------------------- reference-reel analysis
/** Compact, cached cut/pacing metrics; no external API or AI tokens required. */
export async function reference(ctx: Ctx, inp: { asset: string } & ReferenceOptions): Promise<Record<string, unknown>> {
  const p = await openProject(ctx.project);
  const a = await p.asset(inp.asset);
  if (a.kind !== 'video') throw new TmepError('E_INPUT', 'reference analysis requires an imported video asset');
  const options: ReferenceOptions = {
    threshold: inp.threshold ?? 0.3,
    sampleFps: inp.sampleFps ?? 15,
    maxSeconds: inp.maxSeconds ?? 120,
    minGapSec: inp.minGapSec ?? 0.2,
  };
  if (!Object.values(options).every((n) => typeof n === 'number' && Number.isFinite(n)) ||
      options.threshold! < 0.05 || options.threshold! > 0.8 ||
      options.sampleFps! < 2 || options.sampleFps! > 30 ||
      options.maxSeconds! < 1 || options.maxSeconds! > 300 ||
      options.minGapSec! < 0.1 || options.minGapSec! > 2) {
    throw new TmepError('E_INPUT', 'invalid reference analysis settings');
  }
  const key = hashOf({ kind: 'reference-pacing-v1', media: a.hash, options });
  const file = p.cachePath('ref', key + '.json');
  let result = await readJsonOr<ReferencePacing | undefined>(file, undefined);
  const cached = !!result;
  if (!result) {
    result = await analyzeReferenceReel(a.path, options);
    await writeJson(file, result, false);
  }
  return shape(ctx.detail,
    { ok: 1, asset: a.id, cuts: result.cutCount, pacing: result.pacing, analyzedSeconds: result.analyzedSeconds, ...(cached ? { cached: true } : {}) },
    { meanShotSec: result.meanShotSec, medianShotSec: result.medianShotSec, cutsPerMinute: result.cutsPerMinute,
      cutTimes: result.cuts.slice(0, 24), ...(result.cuts.length > 24 ? { remainingCuts: result.cuts.length - 24 } : {}),
      truncated: result.truncated, method: result.method },
    { file: path.relative(ctx.project, file), width: result.width, height: result.height,
      fps: result.fps, threshold: result.threshold, sampleFps: result.sampleFps });
}

// ---------------------------------------------------------------- transcripts
async function loadTranscript(p: Project, a: Asset): Promise<Transcript | undefined> {
  if (!a.tr) return undefined;
  return readJsonOr<Transcript | undefined>(p.cachePath('tr', `${a.tr}.json`), undefined);
}

export async function transcriptsFor(p: Project, ids: Iterable<string>): Promise<Record<string, Word[] | undefined>> {
  const out: Record<string, Word[] | undefined> = {};
  for (const id of new Set(ids)) {
    const a = await p.asset(id);
    out[id] = (await loadTranscript(p, a))?.words;
  }
  return out;
}

export async function transcribe(ctx: Ctx, inp: { asset: string; engine?: string; lang?: string; model?: string; file?: string; prompt?: string; force?: boolean; signal?: AbortSignal }): Promise<Record<string, unknown>> {
  const p = await openProject(ctx.project);
  const a = await p.asset(inp.asset);
  if (a.kind === 'image') throw new TmepError('E_INPUT', `${a.id} is an image`);
  if (!a.audio && !inp.file) throw new TmepError('E_MEDIA', `${a.id} has no audio stream`);
  let engine = inp.engine ?? 'auto';
  if (engine === 'auto') {
    if (inp.file) engine = 'import';
    else if ((await findWhisperCpp()) && (await resolveGgmlModel(inp.model))) engine = 'whisper.cpp';
    else if (await hasFasterWhisper()) engine = 'faster-whisper';
    else throw new TmepError('E_ENGINE_MISSING', 'no local speech engine installed', 'install whisper.cpp (+ ggml model) or faster-whisper, or pass file:"subs.srt|.vtt|.json" to import a transcript; see `tmep doctor`');
  }
  const fileHash = inp.file ? mediaHash(path.resolve(ctx.project, inp.file)) : undefined;
  const key = hashOf({ a: a.hash, engine, lang: inp.lang ?? 'auto', model: inp.model ?? null, prompt: inp.prompt ?? null, f: fileHash ?? null });
  const cacheFile = p.cachePath('tr', `${key}.json`);
  let tr = inp.force ? undefined : await readJsonOr<Transcript | undefined>(cacheFile, undefined);
  const cached = !!tr;
  const t0 = Date.now();
  if (!tr) {
    if (engine === 'import') {
      if (!inp.file) throw new TmepError('E_INPUT', 'engine "import" needs file');
      const text = await fsp.readFile(path.resolve(ctx.project, inp.file), 'utf8');
      const isJson = /\.json$/i.test(inp.file) || text.trimStart().startsWith('{');
      const parsed = isJson ? parseTranscriptJson(text) : { words: parseSubtitles(text), lang: undefined, approx: true };
      tr = makeTranscript('import', inp.lang && inp.lang !== 'auto' ? inp.lang : (parsed.lang ?? 'und'), parsed.words, { approx: parsed.approx });
    } else {
      const wav = p.cachePath('wav', `${a.hash}.wav`);
      if (!(await exists(wav))) await extractSpeechWav(a.path, wav, inp.signal);
      if (engine === 'whisper.cpp') tr = await transcribeWhisperCpp(wav, p.workPath(`wcpp-${key}`), { lang: inp.lang, model: inp.model, prompt: inp.prompt, signal: inp.signal });
      else if (engine === 'faster-whisper') tr = await transcribeFasterWhisper(wav, { lang: inp.lang, model: inp.model, prompt: inp.prompt, signal: inp.signal });
      else throw new TmepError('E_INPUT', `unknown engine "${engine}"`, 'engines: auto, whisper.cpp, faster-whisper, import');
    }
    if (!tr.words.length) throw new TmepError('E_ENGINE_FAILED', 'transcript is empty');
    const last = tr.words[tr.words.length - 1]!;
    if (last.s > a.dur + 1) throw new TmepError('E_INPUT', `transcript extends past media end (${r2(last.s)}s > ${r2(a.dur)}s)`, 'is this the right file?');
    await writeJson(cacheFile, tr, false);
  }
  await p.updateAsset(a.id, { tr: key, lang: tr.lang });
  // human-readable transcript for the user (never returned inline)
  const txt = p.rendersPath('..', 'transcripts', `${a.id}.txt`);
  await fsp.mkdir(path.dirname(txt), { recursive: true });
  await fsp.writeFile(txt, sentences(tr.words).map((s) => `[${fmtTime(s.s)}] ${s.text}`).join('\n') + '\n');
  const st = speechStats(tr.words);
  return shape(
    ctx.detail,
    { ok: 1, id: a.id, words: st.words, lang: tr.lang, ...(cached ? { cached: true } : {}) },
    { engine: tr.engine, speech: st.speech, pauses: st.pauses, fillers: st.fillers, wpm: st.wpm, sentences: sentences(tr.words).length, top: keywords(tr.words, 6).map((k) => k.k), ...(tr.approx ? { approx: true } : {}) },
    { file: path.relative(ctx.project, txt), cache: cacheFile, ms: Date.now() - t0, model: tr.model },
  );
}

// ---------------------------------------------------------------- plan
export async function plan(ctx: Ctx, inp: { reference?: string; src?: string | string[]; template?: string; target?: number; ratio?: Ratio; captions?: Record<string, unknown>; title?: string; sub?: string; music?: string; sfx?: boolean; graphics?: boolean; zooms?: boolean; transitions?: boolean }): Promise<Record<string, unknown>> {
  if (inp.ratio && !(inp.ratio in RATIOS)) throw new TmepError('E_INPUT', `ratio must be one of ${Object.keys(RATIOS).join('|')}`);
  const p = await openProject(ctx.project);
  const all = await p.assets();
  let ids = typeof inp.src === 'string' ? [inp.src] : inp.src;
  if (!ids?.length) ids = all.filter((a) => a.kind === 'video' && a.id !== inp.reference).map((a) => a.id).slice(0, 1);
  if (!ids.length) throw new TmepError('E_STATE', 'no video assets imported', 'call video_import first');
  const sources = [];
  const warn: string[] = [];
  for (const id of ids) {
    const a = await p.asset(id);
    const tr = await loadTranscript(p, a);
    if (inp.reference && (!tr?.words.length || tr.approx)) throw new TmepError('E_INPUT', 'reference planning requires measured word timestamps for each source');
    if (!tr && a.kind !== 'image') warn.push(`${id}: no transcript (kept raw footage; run transcribe for smart cuts/captions)`);
    if (tr?.approx) warn.push(`${id}: word timing is approximate (imported subtitles)`);
    sources.push({ id, dur: a.dur, kind: a.kind, w: a.w, h: a.h, words: tr?.words });
  }
  const ref = inp.reference ? await reference({ ...ctx, detail: 'standard' }, { asset: inp.reference }) : undefined;
  if (ref?.truncated) warn.push('reference analysis limited to the first 120 seconds');
  if (ref) warn.push('reference pace is advisory; narration is preserved, target duration ignored; no style replication');
  if (inp.music) await p.asset(inp.music);
  const { tl, summary } = planTimeline({ referenceShotSec: ref ? Number(ref.medianShotSec) : undefined, template: inp.template ?? 'reel', sources, target: inp.target, ratio: inp.ratio, captions: inp.captions as never, title: inp.title, sub: inp.sub, music: inp.music, sfx: inp.sfx, graphics: inp.graphics, zooms: inp.zooms, transitions: inp.transitions });
  const rev = await p.commit(tl, [{ op: 'plan', ...inp }], `plan ${inp.template ?? 'reel'}`);
  return shape(
    ctx.detail,
    { ok: 1, rev, dur: summary.dur, ...(ref ? { reference: inp.reference, shot: ref.medianShotSec } : {}), ...(warn.length ? { warn } : {}) },
    { clips: summary.clips, gfx: summary.gfx, zooms: summary.zooms, sfx: summary.sfx, trans: summary.trans, cap: tl.captions.style, ratio: tl.settings.ratio },
    { kept: summary.kept, sentences: summary.sentences, rejected: summary.rejected },
  );
}

// ---------------------------------------------------------------- edit
async function opContext(p: Project, tl: Timeline) {
  const assets: Record<string, { dur: number; kind: string }> = {};
  for (const a of await p.assets()) assets[a.id] = { dur: a.dur, kind: a.kind };
  const transcripts = await transcriptsFor(p, tl.clips.map((c) => c.src));
  return { assets, transcripts, presets: PRESET_NAMES, sfxKinds: SFX_KINDS };
}

export async function edit(ctx: Ctx, inp: { ops?: unknown[]; undo?: number; redo?: number; checkout?: number; note?: string; ratio?: Ratio }): Promise<Record<string, unknown>> {
  const p = await openProject(ctx.project);
  if (inp.undo || inp.redo || inp.checkout !== undefined) {
    const rev = inp.undo ? await p.undo(inp.undo) : inp.redo ? await p.redo(inp.redo) : await p.checkout(inp.checkout!);
    const dur = rev > 0 ? r2(duration(await p.timeline(rev))) : 0;
    return { ok: 1, rev, dur };
  }
  if (!inp.ops?.length) throw new TmepError('E_INPUT', 'edit needs ops[] (or undo/redo/checkout)');
  const base = (await p.hasTimeline()) ? await p.timeline() : emptyTimeline(inp.ratio ?? '9:16');
  const before = r2(duration(base));
  const c = await opContext(p, base);
  // transcripts for sources introduced by this batch
  for (const raw of inp.ops) {
    const src = typeof raw === 'object' && raw ? (raw as Record<string, unknown>).src : undefined;
    if (typeof src === 'string' && !(src in c.transcripts) && c.assets[src]) Object.assign(c.transcripts, await transcriptsFor(p, [src]));
  }
  const { tl, notes, created } = applyOps(base, inp.ops, c);
  const rev = await p.commit(tl, inp.ops, inp.note);
  return shape(ctx.detail, { ok: 1, rev, dur: r2(duration(tl)), ...(created.length ? { ids: created } : {}) }, { was: before, did: notes }, { diff: diffTimelines(base, tl) });
}

// ---------------------------------------------------------------- inspect
export async function inspect(ctx: Ctx, inp: { what?: string; asset?: string; from?: number; to?: number; find?: string; max?: number; words?: boolean; rev?: number }): Promise<Record<string, unknown>> {
  const p = await openProject(ctx.project);
  const what = inp.what ?? 'project';
  switch (what) {
    case 'project': {
      const m = await p.manifest();
      const assets = await p.assets();
      const tl = m.head ? await p.timeline() : undefined;
      return shape(
        ctx.detail,
        { name: m.name, rev: m.head, dur: tl ? r2(duration(tl)) : 0, assets: assets.map((a) => `${a.id}:${a.kind}:${r2(a.dur, 1)}s${a.tr ? ':tr' : ''}`) },
        tl ? { clips: tl.clips.length, gfx: tl.gfx.length, sfx: tl.sfx.length, broll: tl.broll.length, cap: tl.captions.style, fmt: `${tl.settings.ratio}@${tl.settings.fps}`, music: tl.music?.src } : {},
        { root: p.root, revs: m.revs },
      );
    }
    case 'assets': {
      const assets = await p.assets();
      return { assets: assets.map((a) => shape(ctx.detail, { id: a.id, kind: a.kind, dur: a.dur }, { name: a.name, ...(a.w ? { res: `${a.w}x${a.h}`, fps: a.fps } : {}), audio: a.audio, tr: !!a.tr, lang: a.lang }, { path: a.path, hash: a.hash, size: a.size })) };
    }
    case 'timeline': {
      const tl = await p.timeline(inp.rev);
      const placed = layout(tl);
      const a = inp.from ?? 0;
      const b = inp.to ?? Infinity;
      const clips = placed
        .filter((x) => x.start < b && x.start + x.dur > a)
        .map((x) => {
          const c = x.clip;
          let s = `${c.id} ${r2(x.start)}+${r2(x.dur)} ${c.src}[${r2(c.in)}-${r2(c.out)}]`;
          if (c.speed !== 1) s += ` x${c.speed}`;
          if (c.base !== 1) s += ` b${c.base}`;
          if (c.zoom.length) s += ` z${c.zoom.length}`;
          if (c.fx?.length) s += ` fx[${fxSummary(c.fx)}]`;
          if (c.trans) s += ` <${c.trans.type}`;
          if (ctx.detail !== 'minimal' && c.fit !== 'cover') s += ` ${c.fit}`;
          return s;
        });
      const items = [...tl.gfx.map((g) => ({ id: g.id, k: g.preset, t: resolveRef(placed, g.ref), d: g.d, extra: ctx.detail === 'minimal' ? '' : ` ${JSON.stringify(g.props).slice(0, 80)}` })), ...tl.sfx.map((s) => ({ id: s.id, k: `sfx:${s.kind}`, t: resolveRef(placed, s.ref), d: 0, extra: '' })), ...tl.broll.map((x) => ({ id: x.id, k: `broll:${x.src}`, t: resolveRef(placed, x.ref), d: x.d, extra: '' }))]
        .filter((x) => x.t !== undefined && x.t < b && x.t + x.d >= a)
        .sort((x, y) => x.t! - y.t!)
        .map((x) => `${x.id} ${x.k}@${r2(x.t!)}${x.d ? `+${r2(x.d)}` : ''}${x.extra}`);
      return shape(ctx.detail, { rev: inp.rev ?? (await p.manifest()).head, dur: r2(duration(tl)), clips, items }, { cap: `${tl.captions.style}/${tl.captions.pos}`, fmt: `${tl.settings.ratio}@${tl.settings.fps}`, music: tl.music ? `${tl.music.src} ${tl.music.vol}dB${tl.music.duck ? ' duck' : ''}` : undefined, lufs: tl.loudness }, { settings: tl.settings, captions: tl.captions });
    }
    case 'transcript': {
      let words: { w: string; s: number; e: number; k?: number }[];
      let label: string;
      if (inp.asset) {
        const a = await p.asset(inp.asset);
        const tr = await loadTranscript(p, a);
        if (!tr) throw new TmepError('E_NO_TRANSCRIPT', `${a.id} has no transcript`, 'run video_transcribe');
        words = tr.words;
        label = `${a.id} source time`;
      } else {
        const tl = await p.timeline();
        words = timelineWords(tl, await transcriptsFor(p, tl.clips.map((c) => c.src)));
        label = 'timeline time';
      }
      if (inp.find) {
        const hits = searchSentences(words, inp.find, 5);
        return { of: label, hits: hits.map((h) => `${r2(h.s)}-${r2(h.e)} ${h.text}`) };
      }
      const a = inp.from ?? 0;
      const b = inp.to ?? Infinity;
      const sel = words.filter((w) => w.s >= a && w.s < b);
      const max = inp.max ?? 1500;
      if (inp.words) {
        const lines: string[] = [];
        let used = 0;
        for (const w of sel) {
          const s = `${w.k !== undefined ? `w${w.k}` : ''}@${r2(w.s)} ${w.w}`;
          used += s.length + 1;
          if (used > max) break;
          lines.push(s);
        }
        return { of: label, words: lines, more: lines.length < sel.length ? sel.length - lines.length : undefined };
      }
      const lines: string[] = [];
      let used = 0;
      for (const s of sentences(sel)) {
        const line = `${r2(s.s)} ${s.text}`;
        used += line.length + 1;
        if (used > max) break;
        lines.push(line);
      }
      const total = sentences(sel).length;
      return { of: label, text: lines, ...(lines.length < total ? { more: total - lines.length, hint: 'narrow with from/to or find' } : {}) };
    }
    case 'silence': {
      if (!inp.asset) throw new TmepError('E_INPUT', 'silence needs asset');
      const a = await p.asset(inp.asset);
      const key = p.cachePath('an', `${a.hash}-sil.json`);
      let r = await readJsonOr<{ silences: { s: number; e: number }[] } | undefined>(key, undefined);
      if (!r) {
        r = await detectSilence(a.path);
        await writeJson(key, r, false);
      }
      const total = r.silences.reduce((x, s) => x + s.e - s.s, 0);
      return shape(ctx.detail, { n: r.silences.length, total: r2(total) }, { longest: r.silences.sort((x, y) => y.e - y.s - (x.e - x.s)).slice(0, 5).map((s) => `${r2(s.s)}-${r2(s.e)}`) });
    }
    case 'diff': {
      const m = await p.manifest();
      const to = inp.to ?? m.head;
      const from = inp.from ?? (await p.revision(to)).parent;
      if (!from) return { from: 0, to, created: true };
      return { from, to, ...diffTimelines(await p.timeline(from), await p.timeline(to)) };
    }
    case 'log':
      return { log: (await p.log(inp.max ?? 10)).map((l) => `r${l.rev}<r${l.parent} ${l.ops}op${l.note ? ` ${l.note}` : ''}`) };
    case 'jobs': {
      const dir = path.join(p.dir, 'jobs');
      const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).slice(-10);
      const jobs = [];
      for (const f of files) jobs.push(jobView(await readJob(p, f.slice(0, -5)), 'minimal'));
      return { jobs };
    }
    default:
      throw new TmepError('E_INPUT', `unknown inspect target "${what}"`, 'what: project|assets|timeline|transcript|silence|diff|log|jobs');
  }
}

// ---------------------------------------------------------------- render
export async function render(ctx: Ctx, inp: Omit<RenderOptions, 'range'> & { range?: (number | string)[]; wait?: number; frames?: number }): Promise<Record<string, unknown>> {
  if (inp.quality && !['draft', 'standard', 'high'].includes(inp.quality)) throw new TmepError('E_INPUT', 'quality must be draft|standard|high');
  if (inp.range && inp.range.length !== 2) throw new TmepError('E_INPUT', 'range needs [start, end]');
  const p = await openProject(ctx.project);
  const m = await p.manifest();
  const tl = await p.timeline();
  const transcripts = await transcriptsFor(p, tl.clips.map((c) => c.src));
  let range: [number, number] | undefined;
  if (inp.range) {
    const words = timelineWords(tl, transcripts);
    const a = resolveAnchor(tl, words, inp.range[0]).t;
    const b = resolveAnchor(tl, words, inp.range[1]);
    range = [a, b.endT !== undefined && typeof inp.range[1] === 'string' && !String(inp.range[1]).startsWith('w:') ? b.endT : b.t];
  }
  const opts: RenderOptions = { preview: inp.preview, range, quality: inp.quality, out: inp.out ? path.resolve(ctx.project, inp.out) : undefined, alpha: inp.alpha, parallel: inp.parallel, encoder: inp.encoder };
  if (!opts.out && !opts.alpha) opts.out = p.rendersPath(`r${m.head}${inp.preview ? '-preview' : ''}${range ? `-${range.map((x) => r2(x, 1)).join('-')}` : ''}.mp4`);
  const job = await startJob(p, 'render', m.head, { ...opts }, async (signal, progress) => {
    const res = await renderTimeline(p, tl, transcripts, opts, { signal, onProgress: progress });
    const out: Record<string, unknown> = { ...res, out: path.relative(ctx.project, res.out) || res.out };
    if (inp.frames && !opts.alpha) {
      const sheet = res.out.replace(/\.[^.]+$/, '-sheet.jpg');
      await contactSheet(res.out, sheet, Math.min(8, Math.max(1, inp.frames)));
      out.sheet = path.relative(ctx.project, sheet);
    }
    return out;
  });
  const j = await waitJob(p, job.id, inp.wait ?? 50);
  const view = jobView(j, ctx.detail);
  if (j.result?.sheet) view.sheet = j.result.sheet;
  return view;
}

export async function status(ctx: Ctx, inp: { job: string; cancel?: boolean; wait?: number }): Promise<Record<string, unknown>> {
  const p = await openProject(ctx.project);
  const j = inp.cancel ? await cancelJob(p, inp.job) : await waitJob(p, inp.job, inp.wait ?? 0);
  return jobView(j, ctx.detail);
}

// ---------------------------------------------------------------- help (on-demand docs keep tool schemas tiny)
export function help(topic = 'workflow'): Record<string, unknown> {
  switch (topic) {
    case 'workflow':
      return {
        steps: ['video_import {paths}', 'video_transcribe {asset}', 'video_plan {template, target?, title?}', 'video_render {preview:true}', 'video_edit {ops} (iterate)', 'video_render {}'],
        tips: ['Refer to media by asset id (v1, a1, i1); never paste transcripts', 'Times accept anchors: seconds | "@phrase" | "w:N" | "c:ID" | "end"', 'Inspect selectively: video_inspect {what:"transcript", find:"..."}', 'Ops can be compact strings: "zoom @key phrase to=1.2"'],
      };
    case 'ops':
      return {
        ops: Object.fromEntries(Object.entries(OP_SCHEMAS).map(([k, s]) => [k, Object.keys((s.json.properties as Record<string, unknown>) ?? {}).filter((x) => x !== 'op').join(',')])),
        string_form: 'op positional... key=value (quote spaces) e.g. "gfx title 0 props.text=\'Hello\'"',
        transitions: TRANSITIONS.join(','),
      };
    case 'anchors':
      return { anchors: { '12.5': 'timeline seconds', '@phrase': 'first occurrence in timeline transcript', '@phrase#2': 'nth occurrence', '@phrase^end': 'end of phrase', 'w:42': 'timeline word 42', 'c:c7': 'clip start', 'c:c7^end': 'clip end', end: 'timeline end' }, note: 'anchored items follow their words through later cuts' };
    case 'presets':
      return { presets: presetCatalog() };
    case 'templates':
      return { templates: Object.fromEntries(Object.values(TEMPLATES).map((t) => [t.name, t.desc])) };
    case 'sfx':
      return { sfx: Object.fromEntries(Object.entries(SFX).map(([k, v]) => [k, v.desc])) };
    case 'icons':
      return { icons: ICON_NAMES.join(',') };
    case 'captions':
      return { styles: 'kinetic|karaoke|clean|boxed|none', fields: 'style,pos(lower|middle|upper),maxWords,upper,color,accent,size,font,emphasis,script(latin|native)', fix: 'op fix {find,replace} corrects transcript words in captions' };
    default:
      throw new TmepError('E_INPUT', `unknown help topic "${topic}"`, 'topics: workflow,ops,anchors,presets,templates,sfx,icons,captions');
  }
}

// ---------------------------------------------------------------- doctor
export async function doctor(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { tmep: VERSION, protocol: PROTOCOL, node: process.version, platform: `${process.platform}-${process.arch}` };
  try {
    const info = await ffmpegInfo();
    const need = ['subtitles', 'xfade', 'perspective', 'loudnorm', 'sidechaincompress', 'acrossfade', 'amix', 'silencedetect'];
    out.ffmpeg = { version: info.version, missingFilters: need.filter((f) => !info.filters.has(f)), libx264: info.encoders.has('libx264'), prores: info.encoders.has('prores_ks'), nvenc: info.encoders.has('h264_nvenc') };
  } catch (e) {
    out.ffmpeg = { error: (e as Error).message };
  }
  out.speech = await engineStatus();
  return out;
}
