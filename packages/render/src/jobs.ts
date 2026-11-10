/**
 * Background render jobs with disk-persisted state. Jobs run in the process that
 * started them; any process (CLI, another MCP server) can read status or request
 * cancellation through the job file. A job interrupted by a crash can be re-run:
 * already-rendered units are reused from the content-addressed cache.
 */
import os from 'node:os';
import { promises as fsp } from 'node:fs';
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
  /** Host that runs the job (absent on records written before stale-job detection). */
  host?: string;
  /** Progress updates that could not be written (the next successful write carries this count). */
  persistFailures?: number;
  /** Set (in the owning process only) when the terminal state could not be written to disk. */
  persistError?: Record<string, unknown>;
}

/** Retry budget for writing a terminal job state (about 6.5 s of transient sharing violations). */
const TERMINAL_WRITE_ATTEMPTS = 30;

/** A running job refreshes `<job>.alive` (mtime) this often ... */
export const HEARTBEAT_MS = 2000;
/** ... and is considered dead when the heartbeat is older than this, even if its pid looks alive. */
export const STALE_MS = 60_000;

const heartbeatPath = (project: Project, id: string) => project.jobPath(id).replace(/\.json$/, '.alive');

/** Jobs owned by this process, registered synchronously before the job file is written. */
const owned = new Set<string>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by another user
  }
}

/**
 * Decide whether a job file that says `running` belongs to a process that is gone.
 * Conservative: a job is only declared interrupted when that is certain (same host and
 * the pid is dead, or this very process does not own it) or its heartbeat is long stale.
 * Legacy records (no host / no heartbeat) are checked by pid on the assumption they are local.
 */
async function interrupted(project: Project, j: Job): Promise<string | undefined> {
  if (owned.has(j.id)) return undefined;
  const sameHost = j.host === undefined || j.host === os.hostname();
  if (sameHost && j.pid === process.pid) return 'its process restarted';
  if (sameHost && !pidAlive(j.pid)) return `process ${j.pid} is no longer running`;
  const hb = await fsp.stat(heartbeatPath(project, j.id)).then((s) => s.mtimeMs, () => undefined);
  if (hb !== undefined && Date.now() - hb > STALE_MS) return `no heartbeat for ${Math.round((Date.now() - hb) / 1000)} s`;
  return undefined;
}

interface Live {
  ctrl: AbortController;
  promise: Promise<Job>;
}

const live = new Map<string, Live>();
/** Finished jobs of this process whose terminal record is not on disk yet (write kept failing). */
const unsaved = new Map<string, Job>();

export async function readJob(project: Project, id: string): Promise<Job> {
  const pending = unsaved.get(id);
  if (pending) {
    // this process finished the job but could not record it: answer from memory, try again
    try {
      const { persistError: _, ...record } = pending;
      await writeJson(project.jobPath(id), record);
      unsaved.delete(id);
      delete pending.persistError;
      await fsp.rm(heartbeatPath(project, id), { force: true }).catch(() => {});
    } catch {
      // still failing: keep reporting the in-memory result with its persistError
    }
    return pending;
  }
  const j = await readJsonOr<Job | null>(project.jobPath(id), null);
  if (!j) throw new TmepError('E_NOT_FOUND', `job ${id} not found`);
  if (j.state === 'running') {
    const why = await interrupted(project, j);
    if (why) {
      j.state = 'error';
      j.ended = new Date().toISOString();
      j.error = new TmepError('E_INTERRUPTED', `job was interrupted: ${why}`, 're-run the render; completed units are reused from the cache').toJSON(true);
      // Best effort, but the evidence must survive a failed write: the stale heartbeat (or dead
      // pid) is what lets the NEXT reader re-derive E_INTERRUPTED, so it is removed only once
      // the terminal record is on disk. Otherwise a live-but-stalled owner with no heartbeat
      // file would read as "running" again.
      try {
        // short budget: this is a status read; a failed attempt is simply repeated next read
        await writeJson(project.jobPath(id), j, true, { attempts: 4 });
        await fsp.rm(heartbeatPath(project, id), { force: true }).catch(() => {});
      } catch {
        // record still says running; heartbeat kept; the next read repeats this recovery
      }
    }
  }
  return j;
}

export async function startJob(project: Project, kind: string, rev: number, opts: Record<string, unknown>, work: (signal: AbortSignal, progress: (p: number, phase: string) => void) => Promise<Record<string, unknown>>): Promise<Job> {
  const job: Job = { id: `j${shortId()}`, kind, state: 'running', progress: 0, phase: 'start', rev, opts, started: new Date().toISOString(), pid: process.pid, host: os.hostname() };
  owned.add(job.id);
  const beat = () => fsp.writeFile(heartbeatPath(project, job.id), String(Date.now())).catch(() => {});
  try {
    await writeJson(project.jobPath(job.id), job);
  } catch (e) {
    owned.delete(job.id);
    throw e;
  }
  await beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  heartbeat.unref?.();
  const ctrl = new AbortController();
  let lastWrite = 0;
  let writing: Promise<void> = Promise.resolve();
  const persist = (force = false) => {
    const now = Date.now();
    if (!force && now - lastWrite < 500) return;
    lastWrite = now;
    const snapshot = { ...job };
    // progress writes are best effort but never silent: a failure (after retries) is counted
    // on the job and carried by the next write; the chain itself never rejects
    writing = writing.then(() =>
      writeJson(project.jobPath(job.id), snapshot).catch(() => {
        job.persistFailures = (job.persistFailures ?? 0) + 1;
      }),
    );
  };
  // cross-process cancellation: poll the job file for a cancel flag (a failed read is skipped;
  // it must never become an unhandled rejection)
  const poll = setInterval(() => {
    readJsonOr<Job | null>(project.jobPath(job.id), null).then(
      (disk) => {
        if (disk?.cancel) ctrl.abort();
      },
      () => {},
    );
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
      clearInterval(heartbeat);
      job.ended = new Date().toISOString();
      await writing; // queued progress writes first, so they cannot overwrite the final state
      // The job is finalized only once its terminal state is on disk (or the failure is reported).
      try {
        await writeJson(project.jobPath(job.id), { ...job }, true, { attempts: TERMINAL_WRITE_ATTEMPTS });
        await fsp.rm(heartbeatPath(project, job.id), { force: true }).catch(() => {});
      } catch (e) {
        const why = asTmepError(e);
        job.persistError = new TmepError('E_IO', `job state could not be saved: ${why.message}`, 'the result is correct in this process; other processes will report the job as interrupted').toJSON(true);
        unsaved.set(job.id, job);
        process.emitWarning(`tmep job ${job.id}: ${job.persistError.msg}`, { code: 'TMEP_JOB_PERSIST' });
        // The heartbeat file is kept (no longer refreshed): once this process exits or the
        // heartbeat ages out, other processes report E_INTERRUPTED instead of "running" forever.
      }
      live.delete(job.id);
      owned.delete(job.id);
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
  if (j.persistError) o.persistErr = { code: j.persistError.code, msg: j.persistError.msg };
  if (detail === 'debug') Object.assign(o, { phase: j.phase, started: j.started, ended: j.ended, opts: j.opts });
  return o;
}
