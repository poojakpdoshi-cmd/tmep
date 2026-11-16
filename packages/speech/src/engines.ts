/**
 * Speech engines. All run locally; none is mandatory.
 *
 *  whisper.cpp   - single native binary + GGML model file. No Python. Prebuilt Windows
 *                  binaries exist. Default recommendation for minimal install friction.
 *  faster-whisper - Python + CTranslate2. Best throughput on NVIDIA GPUs (CUDA 12/cuDNN 9).
 *  import        - bring your own transcript (SRT/VTT/JSON from any tool).
 *
 * Engine binaries/models are configured with env vars:
 *   TMEP_WHISPER_CPP   path to whisper-cli (default: whisper-cli on PATH)
 *   TMEP_WHISPER_MODEL path to ggml model file, or a model name resolved in TMEP_MODELS_DIR
 *   TMEP_PYTHON        python executable for faster-whisper (default: python3 / python)
 */
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TmepError, exists } from '../../core/src/index.ts';
import { commandLineLength, run, WINDOWS_CMDLINE_MAX } from '../../media/src/exec.ts';
import { parseWhisperCppJson, parseFasterWhisperJson, makeTranscript, type Transcript } from './transcript.ts';

import { validateVad, detectChunks, joinChunks, compareVad, type VadOptions } from './vad.ts';

export interface EngineOptions extends VadOptions {
  lang?: string;
  model?: string;
  prompt?: string;
  threads?: number;
  signal?: AbortSignal;
}

export const modelsDir = (): string => process.env.TMEP_MODELS_DIR || path.join(os.homedir(), '.cache', 'tmep', 'models');

async function which(cmd: string): Promise<string | undefined> {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      if (dir && (await exists(p))) return p;
    }
  }
  return undefined;
}

export async function findWhisperCpp(): Promise<string | undefined> {
  if (process.env.TMEP_WHISPER_CPP) return (await exists(process.env.TMEP_WHISPER_CPP)) ? process.env.TMEP_WHISPER_CPP : undefined;
  return (await which('whisper-cli')) ?? (await which('whisper-cpp'));
}

export async function resolveGgmlModel(name?: string): Promise<string | undefined> {
  const want = name ?? process.env.TMEP_WHISPER_MODEL ?? 'base';
  if (/\.(bin|gguf)$/i.test(want)) return (await exists(want)) ? want : undefined;
  for (const cand of [`ggml-${want}.bin`, `ggml-${want}-q5_1.bin`, `ggml-${want}-q8_0.bin`, `${want}.bin`]) {
    const p = path.join(modelsDir(), cand);
    if (await exists(p)) return p;
  }
  return undefined;
}

export async function transcribeWhisperCpp(wav: string, workDir: string, o: EngineOptions = {}): Promise<Transcript> {
  await fsp.mkdir(workDir, { recursive: true });
  const scratch = await fsp.mkdtemp(path.join(workDir, 'run-'));
  try {
    const [result] = await whisperCppBatch([wav], scratch, o);
    if (result instanceof Error) throw result;
    return result!;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function whisperCppPass(wavs: string[], workDir: string, o: EngineOptions = {}): Promise<(Transcript | Error)[]> {
  const bin = await findWhisperCpp();
  if (!bin) throw new TmepError('E_ENGINE_MISSING', 'whisper.cpp (whisper-cli) not found', 'download a release from github.com/ggml-org/whisper.cpp/releases and set TMEP_WHISPER_CPP, or use engine:"import"');
  const model = await resolveGgmlModel(o.model);
  if (!model) throw new TmepError('E_ENGINE_MISSING', `whisper.cpp model "${o.model ?? process.env.TMEP_WHISPER_MODEL ?? 'base'}" not found in ${modelsDir()}`, 'download ggml-<name>.bin from huggingface.co/ggerganov/whisper.cpp into that folder or set TMEP_WHISPER_MODEL');
  await fsp.mkdir(workDir, { recursive: true });
  const lang = !o.lang || o.lang === 'auto' ? 'auto' : o.lang === 'hinglish' ? 'hi' : o.lang;
  // LRC output enables token timestamps in whisper-cli; its sidecar stays in scratch.
  const common = ['-m', model, '-l', lang, '-ojf', '-olrc', '-np'];
  if (o.threads) common.push('-t', String(o.threads));
  const prompt = o.prompt ?? (o.lang === 'hinglish' ? HINGLISH_PROMPT : undefined);
  if (prompt) common.push('--prompt', prompt);
  const results: (Transcript | Error)[] = [];
  let offset = 0;
  while (offset < wavs.length) {
    const args = [...common];
    const outputs: string[] = [];
    for (let i = offset; i < wavs.length; i++) {
      const out = path.join(workDir, `wcpp-${i}`);
      const pair = ['-f', wavs[i]!, '-of', out];
      if (outputs.length && process.platform === 'win32' && commandLineLength(bin, [...args, ...pair]) > WINDOWS_CMDLINE_MAX) break;
      args.push(...pair);
      outputs.push(out);
    }
    const res = await run(bin, args, { signal: o.signal, maxBuffer: 2 * 1024 * 1024 });
    const failure = new TmepError('E_ENGINE_FAILED', res.code ? `whisper.cpp exited ${res.code}` : 'whisper.cpp produced no transcript for this asset',
      'check the audio and model, then retry the failed asset', res.stderr.slice(-2000));
    for (const out of outputs) {
      try {
        const parsed = parseWhisperCppJson(await fsp.readFile(`${out}.json`, 'utf8'));
        results.push(makeTranscript('whisper.cpp', parsed.lang, parsed.words, { model: path.basename(model), approx: parsed.approx }));
      } catch (error) {
        results.push((error as NodeJS.ErrnoException).code === 'ENOENT' ? failure : error as Error);
      }
    }
    offset += outputs.length;
  }
  return results;
}

/** Romanized Hinglish prompt: biases Whisper toward Latin-script code-mixed output. */
export const HINGLISH_PROMPT = 'Haan toh dosto, aaj hum AI ke baare mein baat karenge. Yeh video bahut interesting hone wala hai.';

const FW_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'py', 'fw_transcribe.py');

export async function findPython(): Promise<string | undefined> {
  if (process.env.TMEP_PYTHON) return process.env.TMEP_PYTHON;
  for (const c of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    if (await which(c)) return c;
  }
  return undefined;
}

export async function hasFasterWhisper(): Promise<boolean> {
  const py = await findPython();
  if (!py) return false;
  try {
    const r = await run(py, ['-c', 'import faster_whisper,sys;sys.stdout.write(faster_whisper.__version__)'], { timeoutMs: 30000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

export async function transcribeFasterWhisper(wav: string, o: EngineOptions = {}): Promise<Transcript> {
  if (o.vad !== undefined) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tmep speech '));
    try {
      const [tr] = await fasterWhisperBatch([wav], dir, o);
      if (tr instanceof Error) throw tr;
      return tr!;
    } finally { await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
  }
  const py = await findPython();
  if (!py || !(await hasFasterWhisper())) throw new TmepError('E_ENGINE_MISSING', 'faster-whisper is not installed', 'pip install faster-whisper (Python 3.9+), or use engine:"whisper.cpp"/"import"');
  const model = o.model ?? 'small';
  const lang = !o.lang || o.lang === 'auto' ? '' : o.lang === 'hinglish' ? 'hi' : o.lang;
  const args = [FW_SCRIPT, wav, '--model', model];
  if (lang) args.push('--lang', lang);
  const prompt = o.prompt ?? (o.lang === 'hinglish' ? HINGLISH_PROMPT : undefined);
  if (prompt) args.push('--prompt', prompt);
  const res = await run(py, args, { signal: o.signal, maxBuffer: 64 * 1024 * 1024 });
  if (res.code !== 0) throw new TmepError('E_ENGINE_FAILED', 'faster-whisper failed', undefined, res.stderr.slice(-2000));
  const parsed = parseFasterWhisperJson(res.stdout);
  return makeTranscript('faster-whisper', parsed.lang, parsed.words, { model });
}

/** One Python worker loads the model once and writes per-asset results to disk. */
async function fasterWhisperPass(wavs: string[], workDir: string, o: EngineOptions = {}): Promise<(Transcript | Error)[]> {
  const py = await findPython();
  if (!py || !(await hasFasterWhisper())) throw new TmepError('E_ENGINE_MISSING', 'faster-whisper is not installed', 'install faster-whisper or select whisper.cpp');
  const model = o.model ?? 'small';
  const lang = !o.lang || o.lang === 'auto' ? '' : o.lang === 'hinglish' ? 'hi' : o.lang;
  const prompt = o.prompt ?? (o.lang === 'hinglish' ? HINGLISH_PROMPT : undefined);
  const manifest = path.join(workDir, 'inputs.json');
  const args = [FW_SCRIPT, '--batch', manifest, '--model', model, '--vad', o.vad === 'off' ? 'off' : 'on', '--vad-threshold', String(o.vadThreshold ?? .5), '--vad-pad-ms', String(o.vadPadMs ?? 400)];
  if (lang) args.push('--lang', lang);
  if (prompt) args.push('--prompt', prompt);
  const items = wavs.map((wav, i) => ({ wav, out: path.join(workDir, `fw-${i}.json`) }));
  await fsp.writeFile(manifest, JSON.stringify(items));
  const res = await run(py, args, { signal: o.signal });
  const failure = new TmepError('E_ENGINE_FAILED', 'faster-whisper batch did not produce a transcript for this asset',
    'check that the local model is available and retry the failed asset', res.stderr.slice(-2000));
  return Promise.all(items.map(async ({ out }) => {
    try {
      const json = JSON.parse(await fsp.readFile(out, 'utf8'));
      if (json.error) return new TmepError('E_ENGINE_FAILED', 'faster-whisper failed for this asset', undefined, json.error);
      const parsed = parseFasterWhisperJson(JSON.stringify(json));
      return makeTranscript('faster-whisper', parsed.lang, parsed.words, { model });
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? failure : error as Error;
    }
  }));
}

export async function engineStatus(): Promise<Record<string, unknown>> {
  const wcpp = await findWhisperCpp();
  const model = wcpp ? await resolveGgmlModel() : undefined;
  return {
    'whisper.cpp': wcpp ? (model ? 'ready' : 'binary found, model missing') : 'not installed',
    'faster-whisper': (await hasFasterWhisper()) ? 'ready' : 'not installed',
    import: 'ready',
  };
}

// Each pass still batches files in one model process where command-line limits permit.
export async function whisperCppBatch(wavs: string[], dir: string, o: EngineOptions = {}): Promise<(Transcript | Error)[]> {
  validateVad(o);
  if (!o.vad || o.vad === 'off') return whisperCppPass(wavs, dir, o);
  const bin = await findWhisperCpp();
  if (!bin) return whisperCppPass(wavs, dir, { ...o, vad: 'off' });
  const plans: (Awaited<ReturnType<typeof detectChunks>> | Error)[] = [];
  for (const [i, wav] of wavs.entries()) {
    try { plans.push(await detectChunks(wav, path.join(dir, `vad-${i}`), bin, o, o.signal)); }
    catch (error) { if (o.signal?.aborted) throw error; plans.push(error as Error); }
  }
  const flat = plans.flatMap(p => p instanceof Error ? [] : p.chunks);
  const parts = flat.length ? await whisperCppPass(flat.map(c => c.file), path.join(dir, 'parts'), { ...o, vad: 'off' }) : [];
  let offset = 0;
  const candidates = plans.map(p => {
    if (p instanceof Error) return p;
    const result = parts.slice(offset, offset += p.chunks.length);
    try {
      const error = result.find(r => r instanceof Error);
      if (error) return error;
      const tr = joinChunks(result as Transcript[], p.chunks);
      tr.vad = { status: 'unverified', processedSeconds: p.processed, sourceSeconds: p.duration,
        reason: 'Speech selection can omit quiet speech; use --vad verify for a full-audio comparison' };
      return tr;
    } catch (error) { return error as Error; }
  });
  const results = await finishVad(wavs, dir, o, candidates, whisperCppPass);
  for (const [i, tr] of results.entries()) {
    const p = plans[i]!;
    if (!(tr instanceof Error) && tr.vad && !(p instanceof Error)) {
      tr.vad.sourceSeconds = p.duration;
      tr.vad.processedSeconds = p.processed + (tr.vad.status === 'unverified' ? 0 : p.duration);
    }
  }
  return results;
}

type SpeechPass = typeof whisperCppPass;
async function finishVad(wavs: string[], dir: string, o: EngineOptions, candidates: (Transcript | Error)[], pass: SpeechPass) {
  const indices = candidates.flatMap((c, i) => c instanceof Error || o.vad === 'verify' ? [i] : []);
  await fsp.mkdir(path.join(dir, 'full'), { recursive: true });
  const refs = indices.length ? await pass(indices.map(i => wavs[i]!), path.join(dir, 'full'), { ...o, vad: 'off' }) : [];
  for (const [j, i] of indices.entries()) {
    const ref = refs[j]!, candidate = candidates[i]!;
    if (ref instanceof Error) { candidates[i] = ref; continue; }
    const agrees = !(candidate instanceof Error) && compareVad(ref, candidate);
    // Verification always preserves the full-audio word data and probabilities.
    ref.vad = { status: agrees ? 'verified' : 'fallback',
      reason: agrees ? 'VAD agrees; full-audio word data retained' : candidate instanceof Error ? candidate.message.slice(0, 180) : 'VAD text or timing differs; full-audio word data retained' };
    candidates[i] = ref;
  }
  return candidates;
}
export async function fasterWhisperBatch(wavs: string[], dir: string, o: EngineOptions = {}) {
  validateVad(o);
  await fsp.mkdir(dir, { recursive: true });
  let candidates = await fasterWhisperPass(wavs, dir, o);
  if (!o.vad || o.vad === 'off') return candidates; // Preserve legacy default behavior.
  candidates = candidates.map(c => {
    if (c instanceof Error) return c;
    if (!c.words.length || c.words.some(w => w.p !== undefined && w.p < .2)) return new Error('uncertain VAD result');
    c.vad = { status: 'unverified', reason: 'Speech selection can omit quiet speech; use --vad verify' };
    return c;
  });
  await fsp.mkdir(path.join(dir, 'full'), { recursive: true });
  return finishVad(wavs, dir, o, candidates, fasterWhisperPass);
}
