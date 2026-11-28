/**
 * Speech engines. All run locally; none is mandatory.
 *
 *  whisper.cpp   - single native binary + GGML model file. No Python. Prebuilt Windows
 *                  binaries exist. Default recommendation for minimal install friction.
 *  faster-whisper - Python + CTranslate2. Best throughput on NVIDIA GPUs (CUDA 12/cuDNN 9).
 *  sherpa-onnx   - Python + sherpa-onnx with a local model directory (NeMo CTC / transducer give word
 *                  timestamps; Whisper models give segment-spread timings). $FRAME_SHERPA_MODEL.
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

export interface EngineOptions {
  lang?: string;
  model?: string;
  prompt?: string;
  threads?: number;
  signal?: AbortSignal;
}

export const modelsDir = (): string => (process.env.FRAME_MODELS_DIR ?? process.env.TMEP_MODELS_DIR) || path.join(os.homedir(), '.cache', 'tmep', 'models');

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
  const explicit = process.env.FRAME_WHISPER_CPP ?? process.env.TMEP_WHISPER_CPP;
  if (explicit) return (await exists(explicit)) ? explicit : undefined;
  return (await which('whisper-cli')) ?? (await which('whisper-cpp'));
}

export async function resolveGgmlModel(name?: string): Promise<string | undefined> {
  const want = name ?? (process.env.FRAME_WHISPER_MODEL ?? process.env.TMEP_WHISPER_MODEL) ?? 'base';
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

export async function whisperCppBatch(wavs: string[], workDir: string, o: EngineOptions = {}): Promise<(Transcript | Error)[]> {
  const bin = await findWhisperCpp();
  if (!bin) throw new TmepError('E_ENGINE_MISSING', 'whisper.cpp (whisper-cli) not found', 'download a release from github.com/ggml-org/whisper.cpp/releases and set TMEP_WHISPER_CPP, or use engine:"import"');
  const model = await resolveGgmlModel(o.model);
  if (!model) throw new TmepError('E_ENGINE_MISSING', `whisper.cpp model "${o.model ?? (process.env.FRAME_WHISPER_MODEL ?? process.env.TMEP_WHISPER_MODEL) ?? 'base'}" not found in ${modelsDir()}`, 'download ggml-<name>.bin from huggingface.co/ggerganov/whisper.cpp into that folder or set TMEP_WHISPER_MODEL');
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
  if ((process.env.FRAME_PYTHON ?? process.env.TMEP_PYTHON)) return (process.env.FRAME_PYTHON ?? process.env.TMEP_PYTHON);
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
export async function fasterWhisperBatch(wavs: string[], workDir: string, o: EngineOptions = {}): Promise<(Transcript | Error)[]> {
  const py = await findPython();
  if (!py || !(await hasFasterWhisper())) throw new TmepError('E_ENGINE_MISSING', 'faster-whisper is not installed', 'install faster-whisper or select whisper.cpp');
  const model = o.model ?? 'small';
  const lang = !o.lang || o.lang === 'auto' ? '' : o.lang === 'hinglish' ? 'hi' : o.lang;
  const prompt = o.prompt ?? (o.lang === 'hinglish' ? HINGLISH_PROMPT : undefined);
  const manifest = path.join(workDir, 'inputs.json');
  const args = [FW_SCRIPT, '--batch', manifest, '--model', model];
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

const SHERPA_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'py', 'sherpa_asr.py');
const sherpaEnv = () => { const extra = process.env.FRAME_PYTHONPATH ?? process.env.TMEP_PYTHONPATH; return extra ? { ...process.env, PYTHONPATH: [extra, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } : process.env; };
/** Model directory: explicit path, else FRAME_SHERPA_MODEL_<LANG> (e.g. _HI for a multilingual Whisper), else FRAME_SHERPA_MODEL. */
export const sherpaModel = (o: EngineOptions = {}) => {
  if (o.model && /[\\/]/.test(o.model)) return o.model;
  const lang = o.lang && o.lang !== 'auto' ? (o.lang === 'hinglish' ? 'hi' : o.lang).toUpperCase() : undefined;
  return (lang && (process.env[`FRAME_SHERPA_MODEL_${lang}`] ?? process.env[`TMEP_SHERPA_MODEL_${lang}`])) || (process.env.FRAME_SHERPA_MODEL ?? process.env.TMEP_SHERPA_MODEL);
};
export async function hasSherpa(o: EngineOptions = {}): Promise<boolean> {
  const dir = sherpaModel(o); const py = await findPython();
  if (!dir || !py || !(await exists(dir))) return false;
  try { return (await run(py, ['-c', 'import sherpa_onnx'], { timeoutMs: 30000, env: sherpaEnv() })).code === 0; } catch { return false; }
}
export async function transcribeSherpa(wav: string, o: EngineOptions = {}): Promise<Transcript> {
  const py = await findPython(); const dir = sherpaModel(o);
  if (!py || !dir || !(await hasSherpa(o))) throw new TmepError('E_ENGINE_MISSING', 'sherpa-onnx engine not configured', 'pip install sherpa-onnx and set FRAME_SHERPA_MODEL to a model directory (e.g. sherpa-onnx-nemo-ctc-en-conformer-small from the sherpa-onnx GitHub releases)');
  const lang = !o.lang || o.lang === 'auto' ? 'auto' : o.lang === 'hinglish' ? 'hi' : o.lang;
  const res = await run(py, [SHERPA_SCRIPT, wav, dir, lang], { signal: o.signal, maxBuffer: 64 * 1024 * 1024, env: sherpaEnv() });
  if (res.code !== 0) throw new TmepError('E_ENGINE_FAILED', 'sherpa-onnx failed', undefined, res.stderr.slice(-2000));
  const j = JSON.parse(res.stdout) as { words: { w: string; s: number; e: number }[]; engine: string; timing: string };
  return makeTranscript('sherpa-onnx', o.lang && o.lang !== 'auto' ? o.lang : (j as { language?: string }).language ?? 'und', j.words, { model: `${path.basename(dir)} (${j.engine})`, ...(j.timing === 'segment' && { approx: true }) });
}

export async function engineStatus(): Promise<Record<string, unknown>> {
  const wcpp = await findWhisperCpp();
  const model = wcpp ? await resolveGgmlModel() : undefined;
  return {
    'whisper.cpp': wcpp ? (model ? 'ready' : 'binary found, model missing') : 'not installed',
    'faster-whisper': (await hasFasterWhisper()) ? 'ready' : 'not installed',
    'sherpa-onnx': (await hasSherpa()) ? 'ready' : sherpaModel() ? 'model set, sherpa_onnx not importable' : 'not configured (FRAME_SHERPA_MODEL)',
    import: 'ready',
  };
}
