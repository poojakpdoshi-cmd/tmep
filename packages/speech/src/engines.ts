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
import { run } from '../../media/src/exec.ts';
import { parseWhisperCppJson, parseFasterWhisperJson, makeTranscript, type Transcript } from './transcript.ts';

export interface EngineOptions {
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
  const bin = await findWhisperCpp();
  if (!bin) throw new TmepError('E_ENGINE_MISSING', 'whisper.cpp (whisper-cli) not found', 'download a release from github.com/ggml-org/whisper.cpp/releases and set TMEP_WHISPER_CPP, or use engine:"import"');
  const model = await resolveGgmlModel(o.model);
  if (!model) throw new TmepError('E_ENGINE_MISSING', `whisper.cpp model "${o.model ?? process.env.TMEP_WHISPER_MODEL ?? 'base'}" not found in ${modelsDir()}`, 'download ggml-<name>.bin from huggingface.co/ggerganov/whisper.cpp into that folder or set TMEP_WHISPER_MODEL');
  await fsp.mkdir(workDir, { recursive: true });
  const outBase = path.join(workDir, 'wcpp');
  const lang = !o.lang || o.lang === 'auto' ? 'auto' : o.lang === 'hinglish' ? 'hi' : o.lang;
  const args = ['-m', model, '-f', wav, '-l', lang, '-ojf', '-of', outBase, '-np'];
  if (o.threads) args.push('-t', String(o.threads));
  const prompt = o.prompt ?? (o.lang === 'hinglish' ? HINGLISH_PROMPT : undefined);
  if (prompt) args.push('--prompt', prompt);
  const res = await run(bin, args, { signal: o.signal, maxBuffer: 2 * 1024 * 1024 });
  if (res.code !== 0) throw new TmepError('E_ENGINE_FAILED', `whisper.cpp exited ${res.code}`, undefined, res.stderr.slice(-2000));
  const json = await fsp.readFile(`${outBase}.json`, 'utf8');
  const parsed = parseWhisperCppJson(json);
  return makeTranscript('whisper.cpp', parsed.lang, parsed.words, { model: path.basename(model), approx: parsed.approx });
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

export async function engineStatus(): Promise<Record<string, unknown>> {
  const wcpp = await findWhisperCpp();
  const model = wcpp ? await resolveGgmlModel() : undefined;
  return {
    'whisper.cpp': wcpp ? (model ? 'ready' : 'binary found, model missing') : 'not installed',
    'faster-whisper': (await hasFasterWhisper()) ? 'ready' : 'not installed',
    import: 'ready',
  };
}
