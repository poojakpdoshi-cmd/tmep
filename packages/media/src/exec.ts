/**
 * Safe subprocess execution: argument arrays only (never a shell), bounded output
 * buffers, timeouts and AbortSignal-based cancellation that kills the child.
 */
import { spawn } from 'node:child_process';
import { TmepError } from '../../core/src/index.ts';

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each stderr line (ffmpeg progress/log). */
  onLine?: (line: string) => void;
  /** Max bytes of stdout/stderr retained in memory (tail is kept). */
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const max = opts.maxBuffer ?? 4 * 1024 * 1024;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new TmepError('E_CANCELLED', 'cancelled before start'));
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    let err = '';
    let partial = '';
    let killedBy: 'timeout' | 'abort' | undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
      if (out.length > max) out = out.slice(-max);
    });
    child.stderr.on('data', (d: string) => {
      err += d;
      if (err.length > max) err = err.slice(-max);
      if (opts.onLine) {
        partial += d;
        const lines = partial.split(/\r\n|\r|\n/);
        partial = lines.pop() ?? '';
        for (const l of lines) if (l) opts.onLine(l);
      }
    });
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killedBy = 'timeout';
          kill();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      killedBy = 'abort';
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (killedBy === 'abort') return reject(new TmepError('E_CANCELLED', `${cmd} cancelled`));
      if (killedBy === 'timeout') return reject(new TmepError('E_INTERNAL', `${cmd} timed out after ${opts.timeoutMs}ms`));
      resolve({ code: code ?? -1, stdout: out, stderr: err, ms: Date.now() - t0 });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run and capture stdout as a Buffer (e.g. raw video frames). */
export function runBinary(cmd: string, args: string[], opts: { cwd?: string; maxBytes?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, shell: false, windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let err = '';
    const max = opts.maxBytes ?? 256 * 1024 * 1024;
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > max) {
        child.kill('SIGKILL');
        return reject(new TmepError('E_INTERNAL', 'binary output too large'));
      }
      chunks.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-8000);
    });
    opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new TmepError('E_FFMPEG_FAILED', `${cmd} exited ${code}`, undefined, err));
      resolve(Buffer.concat(chunks));
    });
  });
}
