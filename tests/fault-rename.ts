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
 *   TMEP_FAULT_HOLD="cancel-write:<gate file>"   (deterministic interleaving for cancellation races)
 *     writes of a job record (rename) and the publishing of a cancel marker (rename onto it or
 *     writeFile straight to it) in THIS process wait until <gate file> exists, so a canceller's
 *     write lands exactly when the test lets it, whatever the speed of the machine
 *
 *   TMEP_FAULT_CANCEL="<step>:<count>:<code>"   (failures while a cancel request is being delivered)
 *     The first <count> ("all" = every one) matching calls fail with <code> (default EPERM).
 *     step "publish": the call that makes the marker `<id>.cancel` visible to the owner fails
 *                     before it touches the disk, by whichever primitive the implementation uses
 *                     (`rename` of a temporary file onto the marker, or `writeFile` straight to
 *                     it). Models a Windows sharing violation.
 *     step "write":   the `writeFile` that writes the marker's content (to the marker itself or
 *                     to its temporary file `<id>.cancel.*.tmp`) leaves a truncated file at its
 *                     target and then fails. Models a write that died half-way (disk full).
 *     Matching is by path, not by syscall, so the injection keeps firing if the way the marker
 *     is written changes.
 *
 *   TMEP_FAULT_LOG="<file>"
 *     every fault injected by TMEP_FAULT_RENAME / TMEP_FAULT_CANCEL / TMEP_FAULT_HOLD appends one
 *     line "<kind> <code> <file name>" (kind: rename | cancel-publish | cancel-write | hold; for
 *     a hold, <code> is what was held, logged when the wait starts). Tests assert on it: an
 *     injection that never fires proves nothing.
 *
 * Only `.tmep/jobs/<id>.json` / `.cancel` paths are affected.
 */
import { promises as fsp, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const logFile = process.env.TMEP_FAULT_LOG;
/** Record an injected fault (synchronously: the process may die right after). */
function hit(kind: string, code: string, file: unknown): void {
  if (logFile) appendFileSync(logFile, `${kind} ${code} ${String(file).split(/[\\/]/).pop()}\n`);
}

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
        hit('rename', code, dest);
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

const holdSpec = process.env.TMEP_FAULT_HOLD;
if (holdSpec) {
  const sep = holdSpec.indexOf(':'); // the gate path may itself contain ':' (C:\...)
  const what = holdSpec.slice(0, sep);
  const gate = holdSpec.slice(sep + 1);
  if (what !== 'cancel-write' || !gate) throw new Error(`TMEP_FAULT_HOLD: expected "cancel-write:<gate file>", got "${holdSpec}"`);
  const rec = /[\\/]jobs[\\/]j[0-9a-z]+\.json$/i;
  const marker = /[\\/]jobs[\\/]j[0-9a-z]+\.cancel$/i;
  const wrap = (name: 'rename' | 'writeFile', target: (args: unknown[]) => unknown, match: RegExp[]) => {
    const real = (fsp[name] as (...a: unknown[]) => Promise<unknown>).bind(fsp);
    (fsp as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      const file = String(target(args));
      if (match.some((re) => re.test(file))) {
        hit('hold', what, file);
        while (!existsSync(gate)) await new Promise((r) => setTimeout(r, 20));
      }
      return real(...args);
    };
  };
  // the call that makes the write visible, whichever primitive publishes the marker
  wrap('rename', (a) => a[1], [rec, marker]);
  wrap('writeFile', (a) => a[0], [marker]);
}

const cancelSpec = process.env.TMEP_FAULT_CANCEL;
if (cancelSpec) {
  const [step = '', countS = '1', code = 'EPERM'] = cancelSpec.split(':');
  // a misspelt step must not turn into an injection that silently does nothing
  if (step !== 'publish' && step !== 'write') throw new Error(`TMEP_FAULT_CANCEL: unknown step "${step}" (publish | write)`);
  let left = countS === 'all' ? Infinity : Number(countS);
  const marker = /[\\/]jobs[\\/]j[0-9a-z]+\.cancel$/i;
  const markerOrTemp = /[\\/]jobs[\\/]j[0-9a-z]+\.cancel(\.[^\\/]+\.tmp)?$/i;
  const fail = (syscall: string, file: string): never => {
    left--;
    hit(`cancel-${step}`, code, file);
    const e = new Error(`${code}: injected failure, ${syscall} '${file}'`) as NodeJS.ErrnoException;
    e.code = code;
    e.syscall = syscall;
    throw e;
  };
  const realRename = fsp.rename.bind(fsp);
  fsp.rename = (async (from: string, to: string) => {
    if (step === 'publish' && left > 0 && marker.test(String(to))) fail('rename', String(to));
    return realRename(from, to);
  }) as typeof fsp.rename;
  const realWrite = (fsp.writeFile as (...a: unknown[]) => Promise<void>).bind(fsp);
  fsp.writeFile = (async (file: unknown, ...rest: unknown[]) => {
    const f = String(file);
    if (step === 'publish' && left > 0 && marker.test(f)) fail('open', f);
    if (step === 'write' && left > 0 && markerOrTemp.test(f)) {
      writeFileSync(f, '{"at":"20'); // the file exists, its content is cut short
      fail('write', f);
    }
    return realWrite(file, ...rest);
  }) as typeof fsp.writeFile;
}
