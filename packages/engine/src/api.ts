/**
 * TMEP engine facade: the single API used by both the MCP server and the CLI.
 * Every function takes a small input object, does the heavy work locally, persists
 * results to the project, and returns a compact, detail-shaped object.
 */
import path from 'node:path';
import { retryTransient } from '../../core/src/util.ts';
import { randomUUID } from 'node:crypto';
import { promises as fsp, statSync } from 'node:fs';
import {
  Project,
  type Detail,
  type Timeline,
  type Word,
  type Asset,
  TmepError,
  asTmepError,
  shape,
  mediaHash,
  hashOf,
  sha256,
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
  visualSceneSchema,
  assertSafeId,
  isUncOrDevicePath,
  parseAllowedRoots,
  resolveContainedPath,
} from '../../core/src/index.ts';
import { probe, detectSilence, extractSpeechWav, ffmpegInfo } from '../../media/src/ffmpeg.ts';
import { analyzeReferenceReel, type ReferenceOptions, type ReferencePacing } from '../../media/src/reference.ts';
import { type Transcript, makeTranscript, parseSubtitles, parseTranscriptJson, transcriptText } from '../../speech/src/transcript.ts';
import { transcribeWhisperCpp, transcribeFasterWhisper, whisperCppBatch, fasterWhisperBatch, findWhisperCpp, resolveGgmlModel, hasFasterWhisper, engineStatus } from '../../speech/src/engines.ts';
import { sentences, speechStats, keywords, searchSentences } from '../../speech/src/analyze.ts';
import { planTimeline } from '../../story/src/planner.ts';
import { compileIntent } from '../../story/src/compiler.ts';
import { compileStoryboard, storyboardSchema, STORYBOARD_FPS } from '../../story/src/storyboard.ts';
export { planScript } from '../../story/src/script.ts';
import { TEMPLATES } from '../../story/src/templates.ts';
import { PRESET_NAMES, presetCatalog } from '../../motion/src/presets.ts';
import { compileScenes, diagnoseScenes, sceneRange } from '../../motion/src/scene.ts';
import { ICON_NAMES } from '../../motion/src/icons.ts';
import { SFX, SFX_KINDS } from '../../render/src/sfx.ts';
import { renderTimeline, contactSheet, type RenderOptions } from '../../render/src/render.ts';
import { runInspector } from '../../render/src/inspector.ts';
import { footageFindings, sourceToOutput } from '../../render/src/footage-qa.ts';
import { analyzeFootage, FOOTAGE_VERSION, type FootageAnalysis } from '../../media/src/footage.ts';
import { editingBrief, BRIEF_TASKS, type BriefTask } from '../../story/src/brief.ts';
import { computeShotMatch } from '../../render/src/color.ts';
import { startJob, waitJob, cancelJob, jobView, readJob } from '../../render/src/jobs.ts';

export interface Ctx {
  project: string;
  detail: Detail;
  projectRoots?: string[];
  mediaRoots?: string[];
  outRoots?: string[];
}

async function resolveSafePath(raw: string, base: string, roots: string[] | undefined, label: string): Promise<string> {
  if (roots && roots.length) return resolveContainedPath(raw, roots, label);
  if (isUncOrDevicePath(raw)) throw new TmepError('E_SECURITY', `${label} cannot use UNC or device paths: ${raw}`);
  return path.resolve(base, raw);
}

export async function openProject(dir: string, create = true, projectRoots?: string[]): Promise<Project> {
  const safeDir = await resolveSafePath(dir, process.cwd(), projectRoots, 'project');
  return Project.open(safeDir, { create });
}

// ---------------------------------------------------------------- import
export async function importMedia(ctx: Ctx, inp: { paths: string[] }): Promise<Record<string, unknown>> {
  const p = await openProject(ctx.project, true, ctx.projectRoots);
  const envRoots = parseAllowedRoots();
  const allowed = ctx.mediaRoots ?? (envRoots.length ? [ctx.project, ...envRoots] : undefined);
  const out: Record<string, unknown>[] = [];
  for (const raw of inp.paths) {
    const file = await resolveSafePath(raw, ctx.project, allowed, 'import path');
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

interface SpeechOptions { engine?: string; lang?: string; model?: string; prompt?: string; force?: boolean; signal?: AbortSignal }

function transcriptKey(a: Asset, engine: string, inp: SpeechOptions, fileHash?: string): string {
  return hashOf({ a: a.hash, engine, lang: inp.lang ?? 'auto', model: inp.model ?? null, prompt: inp.prompt ?? null, f: fileHash ?? null });
}

async function speechWav(p: Project, a: Asset, signal?: AbortSignal): Promise<string> {
  const wav = p.cachePath('wav', `${a.hash}.wav`);
  if (await exists(wav)) return wav;
  const tmp = p.cachePath('wav', `${a.hash}.${randomUUID()}.tmp.wav`);
  try {
    await extractSpeechWav(a.path, tmp, signal);
    await retryTransient(() => fsp.rename(tmp, wav), 16);
    return wav;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

function validateTranscript(tr: Transcript, a: Asset): void {
  if (!tr.words.length) throw new TmepError('E_ENGINE_FAILED', 'transcript is empty');
  const last = tr.words.at(-1)!;
  if (last.s > a.dur + 1) throw new TmepError('E_INPUT', `transcript extends past media end (${r2(last.s)}s > ${r2(a.dur)}s)`, 'is this the right file?');
}

async function saveTranscriptText(p: Project, a: Asset, lines: ReturnType<typeof sentences>) {
  const txt = p.rendersPath('..', 'transcripts', `${a.id}.txt`);
  await fsp.mkdir(path.dirname(txt), { recursive: true });
  await fsp.writeFile(txt, lines.map((line) => `[${fmtTime(line.s)}] ${line.text}`).join('\n') + '\n');
  return txt;
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
  const envRoots = parseAllowedRoots();
  const allowed = ctx.mediaRoots ?? (envRoots.length ? [ctx.project, ...envRoots] : undefined);
  const safeImportFile = inp.file ? await resolveSafePath(inp.file, ctx.project, allowed, 'transcript file') : undefined;
  const fileHash = safeImportFile ? mediaHash(safeImportFile) : undefined;
  const key = transcriptKey(a, engine, inp, fileHash);
  const cacheFile = p.cachePath('tr', `${key}.json`);
  let tr = inp.force ? undefined : await readJsonOr<Transcript | undefined>(cacheFile, undefined);
  const cached = !!tr;
  const t0 = Date.now();
  if (!tr) {
    if (engine === 'import') {
      if (!safeImportFile || !inp.file) throw new TmepError('E_INPUT', 'engine "import" needs file');
      const text = await fsp.readFile(safeImportFile, 'utf8');
      const isJson = /\.json$/i.test(inp.file) || text.trimStart().startsWith('{');
      const parsed = isJson ? parseTranscriptJson(text) : { words: parseSubtitles(text), lang: undefined, approx: true };
      tr = makeTranscript('import', inp.lang && inp.lang !== 'auto' ? inp.lang : (parsed.lang ?? 'und'), parsed.words, { approx: parsed.approx });
    } else {
      const wav = await speechWav(p, a, inp.signal);
      if (engine === 'whisper.cpp') tr = await transcribeWhisperCpp(wav, p.workPath(`wcpp-${key}`), { lang: inp.lang, model: inp.model, prompt: inp.prompt, signal: inp.signal });
      else if (engine === 'faster-whisper') tr = await transcribeFasterWhisper(wav, { lang: inp.lang, model: inp.model, prompt: inp.prompt, signal: inp.signal });
      else throw new TmepError('E_INPUT', `unknown engine "${engine}"`, 'engines: auto, whisper.cpp, faster-whisper, import');
    }
    validateTranscript(tr, a);
    await writeJson(cacheFile, tr, false);
  }
  await p.updateAsset(a.id, { tr: key, lang: tr.lang });
  const lines = sentences(tr.words);
  const txt = await saveTranscriptText(p, a, lines);
  const st = speechStats(tr.words);
  return shape(
    ctx.detail,
    { ok: 1, id: a.id, words: st.words, lang: tr.lang, ...(cached ? { cached: true } : {}) },
    { engine: tr.engine, speech: st.speech, pauses: st.pauses, fillers: st.fillers, wpm: st.wpm, sentences: lines.length, top: keywords(tr.words, 6).map((k) => k.k), ...(tr.approx ? { approx: true } : {}) },
    { file: path.relative(ctx.project, txt), cache: cacheFile, ms: Date.now() - t0, model: tr.model },
  );
}

/** Return only editing metadata, with full word timings in the existing transcript cache. */
export async function transcribeBatch(ctx: Ctx, inp: SpeechOptions & { assets: string[] }) {
  const engines = ['whisper.cpp', 'faster-whisper'] as const;
  type Engine = typeof engines[number];
  if (!Array.isArray(inp.assets) || inp.assets.length < 1 || inp.assets.length > 64 ||
      inp.assets.some((id) => typeof id !== 'string' || !/^[vai]\d+$/.test(id))) {
    throw new TmepError('E_INPUT', 'transcribe-batch needs 1–64 imported asset IDs');
  }
  if (inp.engine !== undefined && inp.engine !== 'auto' && !engines.includes(inp.engine as Engine)) {
    throw new TmepError('E_INPUT', 'batch engines: auto, whisper.cpp, faster-whisper');
  }
  for (const value of [inp.lang, inp.model, inp.prompt]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      throw new TmepError('E_INPUT', 'lang, model and prompt must be non-empty strings');
    }
  }
  const p = await openProject(ctx.project, false);
  const assets = new Map((await p.assets()).map((a) => [a.id, a]));
  const ids = [...new Set(inp.assets)];
  const summaries = new Map<string, Record<string, unknown>>();
  const failures = new Map<string, Record<string, unknown>>();
  const debug = ctx.detail === 'debug';
  const fail = (id: string, error: unknown) => {
    failures.set(id, { id, ...(assets.has(id) && { dur: assets.get(id)!.dur }), status: 'failed', err: asTmepError(error).toJSON(debug) });
  };
  const reference = (key: string) => p.cachePath('tr', key + '.json');
  async function complete(a: Asset, key: string, tr: Transcript, cached: boolean) {
    validateTranscript(tr, a);
    const lines = sentences(tr.words);
    if (!cached) {
      await writeJson(reference(key), tr, false);
      await saveTranscriptText(p, a, lines);
    }
    if (a.tr !== key || a.lang !== tr.lang) await p.updateAsset(a.id, { tr: key, lang: tr.lang });
    summaries.set(a.id, {
      id: a.id, dur: a.dur, status: cached ? 'cached' : 'done', lang: tr.lang,
      tr: path.relative(p.root, reference(key)).split(path.sep).join('/'),
      segments: lines.slice(0, debug ? lines.length : 8).map(({ s, e }) => [s, e]),
      ...(lines.length > 8 && !debug && { remainingSegments: lines.length - 8 }),
      top: keywords(tr.words, 3).map(({ k }) => k.slice(0, 32)),
      ...(tr.approx && { approx: true }),
      ...(debug && { engine: tr.engine, model: tr.model, words: tr.words.length }),
    });
  }
  const auto = !inp.engine || inp.engine === 'auto';
  const candidates: readonly Engine[] = auto ? engines : [inp.engine as Engine];
  const pending: Asset[] = [];
  for (const id of ids) {
    try {
      const a = assets.get(id);
      if (!a) throw new TmepError('E_NOT_FOUND', `asset ${id} not found`, 'import it first');
      if (a.kind === 'image') throw new TmepError('E_INPUT', `${id} is an image`);
      if (!a.audio) throw new TmepError('E_MEDIA', `${id} has no audio stream`);
      if (!inp.force) {
        for (const engine of candidates) {
          const key = transcriptKey(a, engine, inp);
          let tr: Transcript | undefined;
          try {
            tr = await readJsonOr<Transcript | undefined>(reference(key), undefined);
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
          if (tr?.v === 1 && tr.engine === engine && typeof tr.lang === 'string' && Array.isArray(tr.words) &&
              tr.words.length && tr.words.every((w, i, all) => w && typeof w.w === 'string' && Number.isFinite(w.s) &&
              Number.isFinite(w.e) && w.s >= (all[i - 1]?.e ?? 0) && w.e > w.s) &&
              tr.words.at(-1)!.s <= a.dur + 1) {
            await complete(a, key, tr, true);
            break;
          }
        }
      }
      if (!summaries.has(id)) pending.push(a);
    } catch (error) { fail(id, error); }
  }
  if (pending.length) {
    let scratch: string | undefined;
    try {
      let engine = candidates[0]!;
      if (auto && !((await findWhisperCpp()) && (await resolveGgmlModel(inp.model)))) {
        engine = await hasFasterWhisper() ? 'faster-whisper' : 'whisper.cpp';
      }
      if (engine === 'whisper.cpp') {
        if (!(await findWhisperCpp())) throw new TmepError('E_ENGINE_MISSING', 'whisper-cli not found', 'set TMEP_WHISPER_CPP to the executable path or install whisper.cpp');
        if (!(await resolveGgmlModel(inp.model))) throw new TmepError('E_ENGINE_MISSING', 'whisper.cpp model not found', 'set TMEP_WHISPER_MODEL to a local GGML file or pass --model');
      }
      const ready: Asset[] = [];
      const wavs: string[] = [];
      for (const a of pending) {
        try {
          const wav = await speechWav(p, a, inp.signal);
          ready.push(a);
          wavs.push(wav);
        } catch (error) { fail(a.id, error); }
      }
      if (ready.length) {
        await fsp.mkdir(p.workPath(), { recursive: true });
        scratch = await fsp.mkdtemp(p.workPath('speech-'));
        const results = await (engine === 'whisper.cpp' ? whisperCppBatch : fasterWhisperBatch)(wavs, scratch, inp);
        for (const [i, a] of ready.entries()) {
          try {
            const tr = results[i]!;
            if (tr instanceof Error) throw tr;
            await complete(a, transcriptKey(a, engine, inp), tr, false);
          } catch (error) { fail(a.id, error); }
        }
      }
    } catch (error) {
      for (const { id } of pending) if (!failures.has(id) && !summaries.has(id)) fail(id, error);
    } finally {
      if (scratch) await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
    }
  }
  return { ok: failures.size ? 0 : 1, assets: ids.flatMap((id) => summaries.get(id) ?? []), failures: ids.flatMap((id) => failures.get(id) ?? []) };
}

// ---------------------------------------------------------------- plan
export async function plan(ctx: Ctx, inp: { reference?: string; src?: string | string[]; template?: string; target?: number; ratio?: Ratio; captions?: Record<string, unknown>; title?: string; sub?: string; music?: string; sfx?: boolean; graphics?: boolean; zooms?: boolean; transitions?: boolean }): Promise<Record<string, unknown>> {
  if (inp.ratio && !(inp.ratio in RATIOS)) throw new TmepError('E_INPUT', `ratio must be one of ${Object.keys(RATIOS).join('|')}`);
  const p = await openProject(ctx.project, true, ctx.projectRoots);
  return p.withLock(async () => {
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
  });
}

/** Compile one storyboard into one editable project revision. */
export async function storyboard(ctx: Ctx, input: unknown) {
  const plan = compileStoryboard(input);
  const p = await openProject(ctx.project, true, ctx.projectRoots);
  return p.withLock(async () => {
    const assets = new Map((await p.assets()).map((asset) => [asset.id, asset]));
  const narration = plan.narration ? await p.asset(plan.narration) : undefined;
  if (narration && (narration.kind !== 'audio' || !narration.audio || !Number.isFinite(narration.dur) || narration.dur <= 0)) {
    throw new TmepError('E_INPUT', 'narration must be an imported audio asset');
  }
  const audioFrames = Math.min(plan.frames, Math.floor((narration?.dur ?? 0) * STORYBOARD_FPS + 1e-8));
  const base = emptyTimeline('9:16', STORYBOARD_FPS);
  base.captions.style = 'none';
  base.loudness = 0;
  base.meta.storyboard = { v: 1, script: plan.script };

  const placeholder = 'storyboardBackdrop';
  const ops: unknown[] = [];
  let frame = 0;
  for (const scene of plan.scenes) {
    const end = frame + scene.frames;
    const audioEnd = Math.min(end, audioFrames);
    if (narration && audioEnd > frame) {
      ops.push({ op: 'add', src: narration.id, in: frame / STORYBOARD_FPS, out: audioEnd / STORYBOARD_FPS });
    }
    const remaining = end - Math.max(frame, audioEnd);
    if (remaining > 0) ops.push({ op: 'add', src: placeholder, out: remaining / STORYBOARD_FPS });
    ops.push({ op: 'scene', spec: scene.spec });
    frame = end;
  }
  const { tl } = applyOps(base, ops, {
    assets: { ...Object.fromEntries(assets), [placeholder]: { kind: 'image', dur: 0 } },
    transcripts: {}, presets: PRESET_NAMES, sfxKinds: SFX_KINDS,
  });
  compileScenes(tl, [], assets);
  if (audioFrames < plan.frames) {
    // The regular image clip path loops this tiny, project-owned black source.
    const image = Buffer.concat([Buffer.from('P6\n2 2\n255\n'), Buffer.alloc(12)]);
    const hash = sha256(image);
    const file = path.join(p.dir, 'storyboard-black.ppm');
    const tmp = `${file}.${randomUUID()}.tmp`;
    if (!(await exists(file))) {
      try {
        await fsp.writeFile(tmp, image);
        await retryTransient(() => fsp.rename(tmp, file), 16);
      } finally {
        await fsp.rm(tmp, { force: true });
      }
    }
    const { asset } = await p.addAsset({ kind: 'image', path: file, name: path.basename(file), hash,
      dur: 0, w: 2, h: 2, audio: false, size: image.length });
    for (const clip of tl.clips) if (clip.src === placeholder) clip.src = asset.id;
    for (const op of ops as { src?: string }[]) if (op.src === placeholder) op.src = asset.id;
  }
    const rev = await p.commit(tl, ops, 'compile storyboard');
    return { ok: 1, rev, frames: plan.frames, dur: plan.frames / STORYBOARD_FPS, scenes: plan.scenes.length };
  });
}

// ---------------------------------------------------------------- edit
async function opContext(p: Project, tl: Timeline) {
  const assets: Record<string, { dur: number; kind: string; path?: string }> = {};
  for (const a of await p.assets()) assets[a.id] = { dur: a.dur, kind: a.kind, path: a.path };
  const transcripts = await transcriptsFor(p, tl.clips.map((c) => c.src));
  return { assets, transcripts, presets: PRESET_NAMES, sfxKinds: SFX_KINDS };
}

export async function compile(ctx: Ctx, input: Record<string, unknown> & { dryRun?: boolean; expectedRev?: number }): Promise<Record<string, unknown>> {
  const p = await openProject(ctx.project, !(input as { dryRun?: boolean })?.dryRun, ctx.projectRoots);
  const hasTl = await exists(path.join(p.dir, 'revs', 'r0001.json')).catch(() => false) ? await p.hasTimeline() : false;
  const base = hasTl ? await p.timeline() : emptyTimeline('9:16');
  const assets = await p.assets().catch(() => []);
  const assetHashes = assets.map((a) => `${a.id}:${a.hash}`);
  const cacheKey = hashOf({ v: '4a.1', input, ratio: base.settings.ratio, captionPos: base.captions.pos, assetHashes });
  const cacheFile = p.cachePath('workflows', `${cacheKey}.json`);
  let compiled = await readJsonOr<ReturnType<typeof compileIntent> | undefined>(cacheFile, undefined);
  const cacheHit = !!compiled;
  if (!compiled) {
    let intent: Record<string, unknown> = input;
    const notes: { code: 'placement'; msg: string }[] = [];
    if (typeof input.footage === 'string') {
      // Footage-aware placement: keep presets clear of the presenter region found in the analysis.
      const { footage, ...rest } = input as Record<string, unknown> & { footage: string };
      intent = rest;
      const analysis = (await cachedFootage(p, [footage])).get(footage) ?? (await footageAnalysis(p, { asset: footage })).analysis;
      const pres = analysis.inferred.presenter;
      if (pres) {
        const [W, H] = RATIOS[(rest.ratio as Ratio | undefined) ?? base.settings.ratio];
        const clip = base.clips.find((c) => c.src === footage);
        const b = sourceToOutput(pres, { w: analysis.asset.w, h: analysis.asset.h }, { w: W, h: H }, clip?.cx, clip?.cy);
        const x0 = Math.max(0, b.x - b.w / 2), x1 = Math.min(1, b.x + b.w / 2), y0 = Math.max(0, b.y - b.h / 2), y1 = Math.min(1, b.y + b.h / 2);
        if (x1 - x0 > 0.01 && y1 - y0 > 0.01) {
          intent = { ...rest, avoid: [...((rest.avoid as unknown[]) ?? []), { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }] };
          notes.push({ code: 'placement', msg: `kept clear of the presenter region from ${footage} (confidence ${pres.confidence})` });
        }
      } else {
        notes.push({ code: 'placement', msg: `${footage}: no presenter region detected (${analysis.capabilities.faces.status === 'ok' ? 'no persistent face' : 'face detection unavailable'}); placement uses safe zones only` });
      }
    }
    compiled = compileIntent(intent, { ratio: base.settings.ratio, captionPos: base.captions.pos });
    compiled.corrections.push(...notes);
    if (!(input as { dryRun?: boolean })?.dryRun && (await exists(p.dir))) {
      await writeJson(cacheFile, compiled, false).catch(() => {});
    }
  }
  const rawDry = Boolean((input as { dryRun?: boolean })?.dryRun);
  if (rawDry) {
    const c = await opContext(p, base);
    const { tl } = applyOps(base, compiled.ops, c);
    const transcripts = await transcriptsFor(p, tl.clips.map((clip) => clip.src));
    const diag = diagnoseScenes(tl, timelineWords(tl, transcripts), new Map((await p.assets()).map((a) => [a.id, a])));
    return { ok: diag.ok ? 1 : 0, dryRun: true, cacheHit, ops: compiled.ops, corrections: compiled.corrections, diagnostics: diag.issues };
  }
  const noteKind = compiled.spec ? compiled.spec.layers.map((l) => l.kind).join('+') : String(input.kind ?? 'workflow');
  const res = await edit(ctx, { ops: compiled.ops, note: `compile ${noteKind}`, expectedRev: (input as { expectedRev?: number })?.expectedRev });
  return { ...res, cacheHit, ops: compiled.ops, corrections: compiled.corrections };
}

/** Deterministic shot-matching assistance between a reference clip and a target clip. */
export async function colormatch(ctx: Ctx, inp: { targetClip: string; refClip: string; apply?: boolean }): Promise<Record<string, unknown>> {
  const p = await openProject(ctx.project, false, ctx.projectRoots);
  const tl = await p.timeline();
  const target = tl.clips.find((c) => c.id === inp.targetClip);
  const ref = tl.clips.find((c) => c.id === inp.refClip);
  if (!target || !ref) throw new TmepError('E_NOT_FOUND', `clip not found: ${!target ? inp.targetClip : inp.refClip}`);
  const [ta, ra] = await Promise.all([p.asset(target.src), p.asset(ref.src)]);
  const { grade, refStats, targetStats } = await computeShotMatch(ra.path, ta.path);
  if (inp.apply !== false) {
    const res = await edit(ctx, { ops: [{ op: 'color', clip: target.id, ...grade }], note: `colormatch ${target.id}<-${ref.id}` });
    return { ...res, grade, refStats, targetStats };
  }
  return { ok: 1, grade, refStats, targetStats };
}

export async function edit(ctx: Ctx, inp: { ops?: unknown[]; undo?: number; redo?: number; checkout?: number; note?: string; ratio?: Ratio; expectedRev?: number; dryRun?: boolean }): Promise<Record<string, unknown>> {
  const p = await openProject(ctx.project, !inp.dryRun, ctx.projectRoots);
  if (inp.undo || inp.redo || inp.checkout !== undefined) {
    return p.withLock(async () => {
      if (inp.expectedRev !== undefined) {
        const m = await p.manifest();
        if (m.head !== inp.expectedRev) {
          throw new TmepError('E_CONFLICT', `expected revision ${inp.expectedRev}, but head is ${m.head}`, 're-read timeline with video_inspect and retry');
        }
      }
      const rev = inp.undo ? await p.undo(inp.undo) : inp.redo ? await p.redo(inp.redo) : await p.checkout(inp.checkout!);
      const dur = rev > 0 ? r2(duration(await p.timeline(rev))) : 0;
      return { ok: 1, rev, dur };
    });
  }
  if (!inp.ops?.length) throw new TmepError('E_INPUT', 'edit needs ops[] (or undo/redo/checkout)');
  return p.withLock(async () => {
    if (inp.expectedRev !== undefined) {
      const m = await p.manifest();
      if (m.head !== inp.expectedRev) {
        throw new TmepError('E_CONFLICT', `expected revision ${inp.expectedRev}, but head is ${m.head}`, 're-read timeline with video_inspect and retry');
      }
    }
    const base = (await p.hasTimeline()) ? await p.timeline() : emptyTimeline(inp.ratio ?? '9:16');
    const before = r2(duration(base));
    const c = await opContext(p, base);
    // transcripts for sources introduced by this batch
    for (const raw of inp.ops!) {
      if (typeof raw === 'object' && raw) {
        const o = raw as Record<string, unknown>;
        if (typeof o.src === 'string' && !(o.src in c.transcripts) && c.assets[o.src]) {
          Object.assign(c.transcripts, await transcriptsFor(p, [o.src]));
        }
        if (o.op === 'color' && typeof o.lut === 'string' && o.lut.length > 0) {
          o.lut = await resolveSafePath(o.lut, p.root, ctx.mediaRoots ?? [p.root], 'LUT file');
        }
      }
    }
    const { tl, notes, created } = applyOps(base, inp.ops!, c);
    if (tl.scenes?.length) {
      // Resolve scene cues against the final batch, including clips added by compact string ops.
      const transcripts = await transcriptsFor(p, tl.clips.map((clip) => clip.src));
      const diag = diagnoseScenes(tl, timelineWords(tl, transcripts), new Map(Object.entries(c.assets)));
      if (inp.dryRun) {
        return { ok: diag.ok ? 1 : 0, dryRun: true, dur: r2(duration(tl)), did: notes, diagnostics: diag.issues, diff: diffTimelines(base, tl) };
      }
      if (!diag.ok) throw new TmepError('E_INPUT', diag.issues[0]!.msg);
    }
    if (inp.dryRun) {
      return { ok: 1, dryRun: true, dur: r2(duration(tl)), did: notes, diff: diffTimelines(base, tl) };
    }
    const rev = await p.commit(tl, inp.ops!, inp.note);
    return shape(ctx.detail, { ok: 1, rev, dur: r2(duration(tl)), ...(created.length ? { ids: created } : {}) }, { was: before, did: notes }, { diff: diffTimelines(base, tl) });
  });
}

// ---------------------------------------------------------------- inspect
// ---------------------------------------------------------------- footage intelligence (Phase 4B)
interface FootageInput { asset: string; faces?: boolean; ocr?: boolean; force?: boolean; maxSeconds?: number }

/** Content-addressed cache keys: media hash + analyzer version + settings + transcript; adapters layer on the base. */
export async function footageKeys(p: Project, assetId: string, inp: Omit<FootageInput, 'asset'>) {
  const a = await p.asset(assetId);
  if (a.kind !== 'video') throw new TmepError('E_INPUT', `footage analysis needs a video asset (${assetId} is ${a.kind})`);
  const words = (await transcriptsFor(p, [assetId]))[assetId] ?? [];
  const maxSeconds = inp.maxSeconds ?? 1800;
  if (!(maxSeconds >= 1 && maxSeconds <= 7200)) throw new TmepError('E_INPUT', 'maxSeconds must be 1–7200');
  const base = hashOf({ kind: 'footage', v: FOOTAGE_VERSION, media: a.hash, maxSeconds, tr: words.length ? hashOf(words) : null });
  const layered = inp.faces || inp.ocr ? hashOf({ base, faces: !!inp.faces, ocr: !!inp.ocr }) : base;
  return { a, words, maxSeconds, base, layered };
}

export async function footageAnalysis(p: Project, inp: FootageInput, signal?: AbortSignal): Promise<{ analysis: FootageAnalysis; cached: boolean }> {
  const k = await footageKeys(p, inp.asset, inp);
  const layeredFile = p.cachePath('footage', `${k.layered}.json`);
  const hit = inp.force ? undefined : await readJsonOr<FootageAnalysis | undefined>(layeredFile, undefined);
  if (hit) return { analysis: hit, cached: true };
  const baseFile = p.cachePath('footage', `${k.base}.json`);
  let base = inp.force ? undefined : await readJsonOr<FootageAnalysis | undefined>(baseFile, undefined);
  if (!base) {
    base = await analyzeFootage(k.a.path, { maxSeconds: k.maxSeconds, words: k.words, signal });
    await writeJson(baseFile, base, false);
  }
  if (k.layered === k.base) return { analysis: base, cached: false };
  // Only the requested adapters run; the video/audio passes are reused from the base record.
  const layered = await analyzeFootage(k.a.path, { base, faces: inp.faces, ocr: inp.ocr, signal });
  await writeJson(layeredFile, layered, false);
  return { analysis: layered, cached: false };
}

/** Cached analyses of the given assets (most complete layer first); never runs a new analysis. */
async function cachedFootage(p: Project, ids: Iterable<string>): Promise<Map<string, FootageAnalysis>> {
  const out = new Map<string, FootageAnalysis>();
  for (const id of new Set(ids)) {
    const a = await p.asset(id).catch(() => undefined);
    if (!a || a.kind !== 'video') continue;
    for (const v of [{ faces: true, ocr: true }, { faces: true }, { ocr: true }, {}]) {
      const k = await footageKeys(p, id, v);
      const hit = await readJsonOr<FootageAnalysis | undefined>(p.cachePath('footage', `${k.layered}.json`), undefined);
      if (hit) { out.set(id, hit); break; }
    }
  }
  return out;
}

function footageSummary(a: FootageAnalysis, cached: boolean, detail: Ctx['detail']): Record<string, unknown> {
  if (detail === 'debug') return { ok: 1, cached, ...a };
  const caps = Object.fromEntries(Object.entries(a.capabilities).map(([k, c]) => [k, c.status === 'ok' ? 'ok' : `unavailable: ${(c as { reason: string }).reason}`]));
  return {
    ok: 1, ...(cached && { cached: true }), dur: a.asset.dur, shots: a.observed.shots.length, scenes: a.inferred.scenes.length,
    pacing: a.inferred.pacing.label, silences: a.observed.silences.length, moments: a.inferred.moments.slice(0, detail === 'minimal' ? 3 : 8).map((m) => ({ t: m.t, conf: m.confidence, why: m.evidence.join('; ') })),
    ...(a.inferred.presenter && { presenter: a.inferred.presenter }),
    quiet: a.inferred.quietRegions.map((q) => [q.x, q.y]), ...(detail !== 'minimal' && { capabilities: caps }),
  };
}

export async function inspect(ctx: Ctx, inp: { what?: string; asset?: string; from?: number; to?: number; find?: string; max?: number; words?: boolean; rev?: number; scene?: string; spec?: unknown; file?: string; targetLufs?: number; task?: string; faces?: boolean; ocr?: boolean; force?: boolean; maxSeconds?: number }): Promise<Record<string, unknown>> {
  if (inp.what === 'footage' || inp.what === 'brief') {
    if (!inp.asset) throw new TmepError('E_INPUT', `inspect ${inp.what} needs asset`, 'e.g. {what:"brief", asset:"v1", task:"informative"}');
    const task = (inp.task ?? 'generic') as BriefTask;
    if (inp.what === 'brief' && !(BRIEF_TASKS as readonly string[]).includes(task)) throw new TmepError('E_INPUT', `unknown brief task "${inp.task}"`, `task: ${BRIEF_TASKS.join('|')}`);
    const p = await openProject(ctx.project, false);
    const { analysis, cached } = await footageAnalysis(p, { asset: inp.asset, faces: inp.faces, ocr: inp.ocr, force: inp.force, maxSeconds: inp.maxSeconds });
    if (inp.what === 'footage') return footageSummary(analysis, cached, ctx.detail);
    const words = (await transcriptsFor(p, [inp.asset]))[inp.asset] ?? [];
    return { ok: 1, ...(cached && { cached: true }), ...editingBrief(analysis, task, words, Math.min(12, Math.max(1, inp.max ?? 6))) };
  }
  if (inp.what === 'scenes') {
    const p = await openProject(ctx.project, false);
    const tl = await p.timeline(inp.rev);
    const words = timelineWords(tl, await transcriptsFor(p, tl.clips.map((c) => c.src)));
    if (inp.spec !== undefined && inp.scene !== undefined) throw new TmepError('E_INPUT', 'choose scene or spec for diagnostics');
    if (inp.spec !== undefined) tl.scenes = [{ id: 'draft', spec: inp.spec as never }];
    if (inp.scene !== undefined) {
      tl.scenes = tl.scenes?.filter(({ id }) => id === inp.scene);
      if (!tl.scenes?.length) throw new TmepError('E_NOT_FOUND', `scene ${inp.scene} not found`);
    }
    return diagnoseScenes(tl, words, new Map((await p.assets()).map((a) => [a.id, a])));
  }
  const what = inp.what ?? 'project';
  const manifestFile = path.join(ctx.project, 'tmep.json');
  if (what === 'project' && !(await exists(manifestFile))) {
    return shape(
      ctx.detail,
      { name: path.basename(ctx.project), rev: 0, dur: 0, assets: [] },
      {},
      { root: ctx.project, revs: 0 },
    );
  }
  const p = await openProject(ctx.project, false, ctx.projectRoots);
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
      return shape(ctx.detail, { rev: inp.rev ?? (await p.manifest()).head, dur: r2(duration(tl)), clips, items,
        ...(tl.scenes?.length && { scenes: tl.scenes.map(({ id }) => id) }) },
        { cap: `${tl.captions.style}/${tl.captions.pos}`, fmt: `${tl.settings.ratio}@${tl.settings.fps}`, music: tl.music ? `${tl.music.src} ${tl.music.vol}dB${tl.music.duck ? ' duck' : ''}` : undefined, lufs: tl.loudness },
        { settings: tl.settings, captions: tl.captions, ...(tl.scenes?.length && { sceneSpecs: tl.scenes }) });
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
    case 'qa': {
      const tl = await p.timeline(inp.rev);
      const words = timelineWords(tl, await transcriptsFor(p, tl.clips.map((c) => c.src)));
      const assets = new Map((await p.assets()).map((a) => [a.id, a]));
      const renderedPath = inp.file ? await resolveSafePath(inp.file, p.root, ctx.outRoots ?? [p.root], 'qa file') : undefined;
      const report = await runInspector(tl, words, { renderedPath, targetLufs: inp.targetLufs, assets });
      // Footage-aware advisories from cached analyses (inspect {what:"footage"} creates them).
      const extra = footageFindings(tl, await cachedFootage(p, tl.clips.map((c) => c.src)));
      const findings = [...report.findings, ...extra];
      return { ...report, findings, advisories: report.advisories + extra.length, ok: report.ok ? 1 : 0 };
    }
    default:
      throw new TmepError('E_INPUT', `unknown inspect target "${what}"`, 'what: project|assets|timeline|transcript|silence|diff|log|jobs|scenes|qa|footage|brief');
  }
}

// ---------------------------------------------------------------- render
export async function render(ctx: Ctx, inp: Omit<RenderOptions, 'range'> & { range?: (number | string)[]; wait?: number; frames?: number; scene?: string; rev?: number }): Promise<Record<string, unknown>> {
  if (inp.quality && !['draft', 'standard', 'high'].includes(inp.quality)) throw new TmepError('E_INPUT', 'quality must be draft|standard|high');
  if (inp.range && inp.range.length !== 2) throw new TmepError('E_INPUT', 'range needs [start, end]');
  const p = await openProject(ctx.project, inp.scene === undefined);
  const rev = inp.rev ?? (await p.manifest()).head;
  const tl = await p.timeline(rev);
  const transcripts = await transcriptsFor(p, tl.clips.map((c) => c.src));
  let range: [number, number] | undefined;
  if (inp.scene !== undefined) {
    const scene = tl.scenes?.find(({ id }) => id === inp.scene);
    if (!scene) throw new TmepError('E_NOT_FOUND', `scene ${inp.scene} not found`);
    if (inp.alpha) throw new TmepError('E_INPUT', 'scene previews use normal compositing');
    const [start, end] = sceneRange(tl, timelineWords(tl, transcripts), scene.spec);
    const local = inp.range ?? [0, end - start];
    if (local.some((v) => typeof v !== 'number' || !Number.isFinite(v)) ||
        Number(local[0]) < 0 || Number(local[1]) <= Number(local[0]) || Number(local[1]) > end - start + 1e-9) {
      throw new TmepError('E_RANGE', 'scene preview range must be increasing scene-local seconds within the scene');
    }
    range = [start + Number(local[0]), Math.min(end, start + Number(local[1]))];
  } else if (inp.range) {
    const words = timelineWords(tl, transcripts);
    const a = resolveAnchor(tl, words, inp.range[0]).t;
    const b = resolveAnchor(tl, words, inp.range[1]);
    range = [a, b.endT !== undefined && typeof inp.range[1] === 'string' && !String(inp.range[1]).startsWith('w:') ? b.endT : b.t];
  }
  const preview = inp.scene !== undefined ? true : inp.preview;
  let safeOut: string | undefined;
  if (inp.out) {
    if (!/\.(mp4|mov|webm)$/i.test(inp.out)) {
      throw new TmepError('E_INPUT', 'render out must end in .mp4, .mov, or .webm');
    }
    safeOut = await resolveSafePath(inp.out, ctx.project, ctx.outRoots, 'render output');
  }
  const opts: RenderOptions = { preview, range, quality: inp.quality, out: safeOut, alpha: inp.alpha, parallel: inp.parallel, encoder: inp.encoder };
  if (!opts.out && !opts.alpha) opts.out = p.rendersPath(`r${rev}${preview ? '-preview' : ''}${range ? `-${range.map((x) => r2(x, inp.scene !== undefined ? 3 : 1)).join('-')}` : ''}.mp4`);
  const job = await startJob(p, 'render', rev, { ...opts }, async (signal, progress) => {
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
  assertSafeId(inp.job, 'job id');
  const p = await openProject(ctx.project, false, ctx.projectRoots);
  const j = inp.cancel ? await cancelJob(p, inp.job) : await waitJob(p, inp.job, inp.wait ?? 0);
  return jobView(j, ctx.detail);
}

// ---------------------------------------------------------------- help (on-demand docs keep tool schemas tiny)
export function help(topic = 'workflow', includeSchema = false): Record<string, unknown> {
  switch (topic) {
    case 'storyboard':
      return includeSchema
        ? { schema: storyboardSchema.json, doc: 'docs/STORYBOARD.md' }
        : {
            templates: 'process|explanation|comparison|custom',
            fields: 'script,narration?,scenes[{id?,template,title,subtitle?,steps?,claim?,counter?,spec?,frames?}]',
            example: { scenes: [{ template: 'explanation', title: 'Topic', subtitle: 'Key point', frames: 90 }] },
            note: 'pass schema:true for full JSON Schema',
            doc: 'docs/STORYBOARD.md',
          };
    case 'scene':
      return includeSchema
        ? { op: { op: 'scene', spec: visualSceneSchema.json }, doc: 'docs/VISUAL_SCENE.md' }
        : {
            op: 'scene',
            fields: 'id?,at|anchor?,d,bg?,safe?,layers[{kind:text|rect|polygon|circle|path|media,id?,x,y,w?,h?,fx?,z?}]',
            note: 'pass schema:true for full JSON Schema',
            doc: 'docs/VISUAL_SCENE.md',
          };
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
      throw new TmepError('E_INPUT', `unknown help topic "${topic}"`, 'topics: workflow,ops,anchors,presets,templates,sfx,icons,captions,scene,storyboard');
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
