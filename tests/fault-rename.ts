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
 * Only `.tmep/jobs/<id>.json` paths are affected.
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
