/**
 * Helpers shared by the render stages (video units, audio stems, final mux): a bounded worker
 * pool, per-attempt temporary names, atomic publishing into the content-addressed cache, and
 * moving a long filter graph off the command line.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { exists, sha256 } from '../../core/src/index.ts';
import { ffmpegInfo } from '../../media/src/ffmpeg.ts';
import { commandLineLength } from '../../media/src/exec.ts';
import { ownerTag } from './recovery.ts';

/**
 * Run `fn` over items with at most `n` in flight. Never rejects: errors go to `fail`, and
 * no new item starts once `stop()` is true, so callers can wait for every running worker
 * (and its ffmpeg child) to finish before cleaning up.
 */
export async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>, stop: () => boolean, fail: (e: unknown) => void): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length && !stop()) {
      const x = items[i++]!;
      try {
        await fn(x);
      } catch (e) {
        fail(e);
      }
    }
  });
  await Promise.all(workers);
}

/** Collision-resistant temporary path for one write attempt (unique per process AND attempt). */
export function tmpFor(file: string, ext: string): string {
  return `${file}.${ownerTag()}.${randomBytes(4).toString('hex')}.tmp${ext}`;
}

/**
 * Publish a finished, complete temporary file to a content-addressed cache path with one
 * atomic rename, so readers only ever see a missing entry or a complete one.
 *
 * Concurrent publishers of the same key (renders in separate processes) produce entries from
 * identical inputs. On POSIX the rename atomically REPLACES an existing entry: no error, no
 * validation, and that is safe because both files are complete and equivalent, and a reader
 * that already opened the old file keeps reading the old inode. On Windows the rename can
 * fail instead (e.g. EPERM/EBUSY while another process has the entry open); only then is the
 * existing entry checked with `validate` and accepted. A failed rename is never treated as
 * success without that check; otherwise the original error is thrown.
 */
export async function publish(tmp: string, dest: string, validate: (file: string) => Promise<boolean>): Promise<void> {
  try {
    await fsp.rename(tmp, dest);
  } catch (e) {
    if ((await exists(dest)) && (await validate(dest).catch(() => false))) {
      await fsp.rm(tmp, { force: true });
      return;
    }
    throw e;
  }
}

/**
 * A filter graph this long is passed in a file rather than on the command line. Well under
 * Windows' 32,767-character limit, which also has to hold the inputs and the output path.
 */
export const SCRIPT_THRESHOLD = 16_000;

/** Whether this command's filter graph has to move off the command line. */
export function graphToScript(args: string[]): boolean {
  return args.includes('-filter_complex') && commandLineLength('ffmpeg', args) >= SCRIPT_THRESHOLD;
}

/** Very long filter graphs go to a script file (Windows command-line limit is 32767 chars). */
export async function maybeScript(args: string[], work: string): Promise<string[]> {
  if (!graphToScript(args)) return args;
  const i = args.indexOf('-filter_complex');
  const info = await ffmpegInfo();
  // unique per call: parallel units of one render can have byte-identical graphs
  const file = tmpFor(path.join(work, `graph-${sha256(args[i + 1]!).slice(0, 12)}`), '.txt');
  await fsp.writeFile(file, args[i + 1]!);
  const copy = [...args];
  if (info.major >= 8) copy.splice(i, 2, '-/filter_complex', file);
  else copy.splice(i, 2, '-filter_complex_script', file);
  return copy;
}
