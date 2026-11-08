import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp, openSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';

/** Round to `d` decimals; keeps JSON responses short. */
export const r2 = (n: number, d = 2): number => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stable JSON (sorted keys) used for content hashing of plans and render units. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

export const hashOf = (v: unknown): string => sha256(stableStringify(v)).slice(0, 20);

/**
 * Content hash for media files. Files <= 32 MiB are hashed fully; larger files hash
 * size + three 4 MiB windows (start/middle/end). Fast on multi-GB footage while still
 * detecting re-encodes and truncation. Documented trade-off: an edit that changes only
 * bytes outside the sampled windows of a huge file and keeps its size is not detected.
 */
export function mediaHash(file: string): string {
  const st = statSync(file);
  const h = createHash('sha256');
  h.update(`size:${st.size};`);
  const FULL = 32 * 1024 * 1024;
  const WIN = 4 * 1024 * 1024;
  const fd = openSync(file, 'r');
  try {
    const readAt = (pos: number, len: number) => {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, pos);
      h.update(buf.subarray(0, n));
    };
    if (st.size <= FULL) {
      for (let pos = 0; pos < st.size; pos += WIN) readAt(pos, Math.min(WIN, st.size - pos));
    } else {
      readAt(0, WIN);
      readAt(Math.floor(st.size / 2) - WIN / 2, WIN);
      readAt(st.size - WIN, WIN);
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex').slice(0, 24);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
}

export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

/** Atomic JSON write (tmp + rename) so an interrupted process never leaves torn state. */
export async function writeJson(file: string, data: unknown, pretty = true): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, pretty ? `${JSON.stringify(data, null, 1)}\n` : JSON.stringify(data));
  await fsp.rename(tmp, file);
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export const shortId = (): string => randomBytes(4).toString('hex');

/** Snap a time to the frame grid. All timeline math is frame-quantized to avoid drift. */
export const snap = (t: number, fps: number): number => Math.round(t * fps) / fps;

export const toPosix = (p: string): string => p.split(path.sep).join('/');
