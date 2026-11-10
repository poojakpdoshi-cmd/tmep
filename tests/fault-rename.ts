/**
 * Fault injection for job-persistence tests (loaded with `node --import`).
 *
 * Makes `fs.promises.rename` fail with a Windows-style sharing violation for job-record writes,
 * deterministically, so the behaviour can be tested on every OS:
 *
 *   TMEP_FAULT_RENAME="<state>:<count>:<code>"
 *     state  job state in the record being written ("done", "error", "cancelled", "running", "any")
 *     count  how many matching renames fail ("all" = every one)
 *     code   errno code to raise (default EPERM)
 *
 *   TMEP_FAULT_READ="<count>:<code>"
 *     makes the first <count> `fs.promises.readFile` calls on a job record fail (e.g. EBUSY)
 *
 *   TMEP_FAULT_BLIND="<skip>:<ms>:<code>"
 *     after <skip> successful matching calls (e.g. the API's own read when a render starts),
 *     every read of a job record and every check (access/stat/readFile) of a cancel marker fails
 *     for <ms>: the owner's cancel poll is blind for a fixed time window, independent of retries
 *
 *   TMEP_FAULT_DELAY="cancel-write:<ms>"   (deterministic interleaving for cancellation races)
 *     delay writes of a job record (rename) and of a cancel marker (writeFile) in THIS
 *     process, so a canceller's write lands late
 *
 * Only `.tmep/jobs/<id>.json` / `.cancel` paths are affected.
 */
import { promises as fsp, readFileSync } from 'node:fs';

const spec = process.env.TMEP_FAULT_RENAME;
if (spec) {
  const [state = 'any', countS = '1', code = 'EPERM'] = spec.split(':');
  let left = countS === 'all' ? Infinity : Number(countS);
  const real = fsp.rename.bind(fsp);
  fsp.rename = (async (from: string, to: string) => {
    const dest = String(to);
    if (left > 0 && /[\\/]jobs[\\/]j[0-9a-z]+\.json$/i.test(dest)) {
      let rec: { state?: string } = {};
      try {
        rec = JSON.parse(readFileSync(String(from), 'utf8'));
      } catch {
        // not a job record
      }
      if (state === 'any' || rec.state === state) {
        left--;
        const e = new Error(`${code}: operation not permitted, rename '${from}' -> '${to}' (injected)`) as NodeJS.ErrnoException;
        e.code = code;
        e.syscall = 'rename';
        throw e;
      }
    }
    return real(from, to);
  }) as typeof fsp.rename;
}

const readSpec = process.env.TMEP_FAULT_READ;
if (readSpec) {
  const [countS = '1', code = 'EBUSY'] = readSpec.split(':');
  let left = countS === 'all' ? Infinity : Number(countS);
  const realRead = fsp.readFile.bind(fsp);
  fsp.readFile = (async (file: unknown, ...rest: unknown[]) => {
    if (left > 0 && /[\\/]jobs[\\/]j[0-9a-z]+\.json$/i.test(String(file))) {
      left--;
      const e = new Error(`${code}: resource busy or locked, open '${String(file)}' (injected)`) as NodeJS.ErrnoException;
      e.code = code;
      e.syscall = 'open';
      throw e;
    }
    return (realRead as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
  }) as typeof fsp.readFile;
}

const blindSpec = process.env.TMEP_FAULT_BLIND;
if (blindSpec) {
  const [skipS = '0', msS = '3000', code = 'EBUSY'] = blindSpec.split(':');
  let skipLeft = Number(skipS);
  const ms = Number(msS);
  const re = /[\\/]jobs[\\/]j[0-9a-z]+\.(json|cancel)$/i;
  let since: number | undefined;
  for (const name of ['readFile', 'access', 'stat'] as const) {
    const real = (fsp[name] as (...a: unknown[]) => Promise<unknown>).bind(fsp);
    (fsp as unknown as Record<string, unknown>)[name] = async (file: unknown, ...rest: unknown[]) => {
      if (re.test(String(file)) && skipLeft-- <= 0) {
        since ??= Date.now();
        if (Date.now() - since < ms) {
          const e = new Error(`${code}: resource busy or locked, open '${String(file)}' (injected)`) as NodeJS.ErrnoException;
          e.code = code;
          e.syscall = 'open';
          throw e;
        }
      }
      return real(file, ...rest);
    };
  }
}

const delaySpec = process.env.TMEP_FAULT_DELAY;
if (delaySpec) {
  const [what, msS = '1000'] = delaySpec.split(':');
  const ms = Number(msS);
  const rec = /[\\/]jobs[\\/]j[0-9a-z]+\.json$/i;
  const marker = /[\\/]jobs[\\/]j[0-9a-z]+\.cancel$/i;
  const sleep = () => new Promise((r) => setTimeout(r, ms));
  const wrap = <K extends 'readFile' | 'access' | 'stat' | 'rename' | 'writeFile'>(name: K, match: (args: unknown[]) => boolean) => {
    const real = (fsp[name] as (...a: unknown[]) => Promise<unknown>).bind(fsp);
    (fsp as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      if (match(args)) await sleep();
      return real(...args);
    };
  };
  if (what === 'cancel-write') {
    wrap('rename', (a) => rec.test(String(a[1])));
    wrap('writeFile', (a) => marker.test(String(a[0])));
  }
}
