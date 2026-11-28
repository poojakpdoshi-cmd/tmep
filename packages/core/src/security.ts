import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { TmepError } from './errors.ts';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WIN_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

export function assertSafeId(id: unknown, kind = 'id'): string {
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id) || id.includes('..') || WIN_RESERVED_RE.test(id)) {
    throw new TmepError('E_SECURITY', `invalid ${kind} "${String(id)}"`, `use a simple ${kind} without path separators or ".."`);
  }
  return id;
}

export function isUncOrDevicePath(p: string): boolean {
  return /^(\\\\[?.]\\|\\\\[^\\]|\/\/[^/])/.test(p);
}

/**
 * Resolve a path to its canonical realpath, walking up to the deepest existing
 * ancestor when the target (or parent directory) does not yet exist.
 */
export async function canonicalPath(target: string): Promise<string> {
  const abs = path.resolve(target);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await fsp.realpath(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function normForCompare(p: string): string {
  const cleaned = path.normalize(p);
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
}

export function isWithinRoot(targetCanonical: string, rootCanonical: string): boolean {
  const t = normForCompare(targetCanonical);
  const r = normForCompare(rootCanonical);
  const rel = path.relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function resolveContainedPath(raw: string, allowedRoots: string[], label = 'path'): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) {
    throw new TmepError('E_SECURITY', `invalid ${label}`);
  }
  if (!allowedRoots.length) {
    throw new TmepError('E_SECURITY', `no allowed root configured for ${label}`);
  }
  if (isUncOrDevicePath(raw) && !allowedRoots.some((r) => isUncOrDevicePath(r))) {
    throw new TmepError('E_SECURITY', `${label} cannot use UNC or device paths: ${raw}`);
  }
  const candidate = path.resolve(allowedRoots[0]!, raw);
  const canonTarget = await canonicalPath(candidate);
  const canonRoots = await Promise.all(allowedRoots.map((r) => canonicalPath(r)));
  if (!canonRoots.some((r) => isWithinRoot(canonTarget, r))) {
    throw new TmepError('E_SECURITY', `${label} escapes allowed workspace boundary: ${raw}`, `keep ${label} inside ${allowedRoots[0]}`);
  }
  return canonTarget;
}

export function parseAllowedRoots(raw = process.env.FRAME_MEDIA_ROOTS ?? (process.env.FRAME_MEDIA_ROOTS ?? process.env.TMEP_MEDIA_ROOTS)): string[] {
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}
