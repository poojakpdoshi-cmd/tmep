/**
 * Background render jobs with disk-persisted state. Jobs run in the process that
 * started them; any process (CLI, another MCP server) can read status or request
 * cancellation through the job file. A job interrupted by a crash can be re-run:
 * already-rendered units are reused from the content-addressed cache.
 */
import { type Project, type Detail, TmepError, asTmepError, writeJson, readJsonOr, shortId, r2 } from '../../core/src/index.ts';

export type JobState = 'running' | 'done' | 'error' | 'cancelled';

export interface Job {
  id: string;
  kind: string;
  state: JobState;
  progress: number;
  phase: string;
  rev: number;
  opts: Record<string, unknown>;
  started: string;
  ended?: string;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  cancel?: boolean;
  pid: number;
}

interface Live {
  ctrl: AbortController;
  promise: Promise<Job>;
}

const live = new Map<string, Live>();

export async function readJob(project: Project, id: string): Promise<Job> {
  const j = await readJsonOr<Job | null>(project.jobPath(id), null);
  if (!j) throw new TmepError('E_NOT_FOUND', `job ${id} not found`);
  return j;
}

export async function startJob(project: Project, kind: string, rev: number, opts: Record<string, unknown>, work: (signal: AbortSignal, progress: (p: number, phase: string) => void) => Promise<Record<string, unknown>>): Promise<Job> {
  const job: Job = { id: `j${shortId()}`, kind, state: 'running', progress: 0, phase: 'start', rev, opts, started: new Date().toISOString(), pid: process.pid };
  await writeJson(project.jobPath(job.id), job);
  const ctrl = new AbortController();
  let lastWrite = 0;
  let writing: Promise<void> = Promise.resolve();
  const persist = (force = false) => {
    const now = Date.now();
    if (!force && now - lastWrite < 500) return;
    lastWrite = now;
    const snapshot = { ...job };
    writing = writing.then(() => writeJson(project.jobPath(job.id), snapshot)).catch(() => {});
  };
  // cross-process cancellation: poll the job file for a cancel flag
  const poll = setInterval(async () => {
    const disk = await readJsonOr<Job | null>(project.jobPath(job.id), null);
    if (disk?.cancel) ctrl.abort();
  }, 1000);
  poll.unref?.();
  const promise = (async () => {
    try {
      job.result = await work(ctrl.signal, (p, phase) => {
        job.progress = r2(p, 3);
        job.phase = phase;
        persist();
      });
      job.state = 'done';
      job.progress = 1;
      job.phase = 'done';
    } catch (e) {
      const err = asTmepError(e);
      job.state = err.code === 'E_CANCELLED' ? 'cancelled' : 'error';
      job.error = err.toJSON(true);
    } finally {
      clearInterval(poll);
      job.ended = new Date().toISOString();
      live.delete(job.id);
      persist(true);
      await writing;
    }
    return job;
  })();
  live.set(job.id, { ctrl, promise });
  return job;
}

/** Wait up to `seconds` for a job; returns its current state either way. */
export async function waitJob(project: Project, id: string, seconds: number): Promise<Job> {
  const l = live.get(id);
  if (l && seconds > 0) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((res) => (timer = setTimeout(() => res(null), Math.min(seconds * 1000, 2 ** 31 - 1))));
    const r = await Promise.race([l.promise, timeout]);
    if (timer) clearTimeout(timer);
    if (r) return r;
  }
  return readJob(project, id);
}

export async function cancelJob(project: Project, id: string): Promise<Job> {
  const l = live.get(id);
  if (l) {
    l.ctrl.abort();
    return l.promise;
  }
  const j = await readJob(project, id);
  if (j.state === 'running') {
    j.cancel = true;
    await writeJson(project.jobPath(id), j);
  }
  return j;
}

export function jobView(j: Job, detail: Detail): Record<string, unknown> {
  const o: Record<string, unknown> = { job: j.id, state: j.state };
  if (j.state === 'running') o.p = j.progress;
  if (j.result) {
    o.out = j.result.out;
    if (detail !== 'minimal') Object.assign(o, { dur: j.result.dur, size: `${j.result.w}x${j.result.h}`, units: j.result.units, cached: j.result.unitsCached, s: r2(Number(j.result.ms) / 1000, 1), ...(j.result.span ? { span: j.result.span } : {}) });
    if (detail === 'debug') o.result = j.result;
  }
  if (j.error) o.err = detail === 'debug' ? j.error : { code: j.error.code, msg: j.error.msg, ...(j.error.hint ? { hint: j.error.hint } : {}) };
  if (detail === 'debug') Object.assign(o, { phase: j.phase, started: j.started, ended: j.ended, opts: j.opts });
  return o;
}
