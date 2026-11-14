import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { sha256, type Project } from '../../core/src/index.ts';

// Projects may be shared across machines. A PID alone cannot identify a render owner.
const hostTag = sha256(os.hostname()).slice(0, 16);
export const ownerTag = (pid = process.pid) => `${hostTag}-${pid}`;

export function processIsGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Reclaim only staging paths for a confirmed dead, local owner. Published files have no owner tag. */
export async function recoverRenderFiles(project: Project, pid: number, out: unknown): Promise<void> {
  const owner = ownerTag(pid);
  async function removeMatching(dir: string, pattern: RegExp, directories = false, prefix = '') {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    // Check after listing so a process that reused the PID cannot add files to this snapshot.
    if (!entries.length || !processIsGone(pid)) return;
    for (const entry of entries) {
      if ((directories ? entry.isDirectory() : entry.isFile()) && entry.name.startsWith(prefix) && pattern.test(entry.name.slice(prefix.length))) {
        await fsp.rm(path.join(dir, entry.name), { recursive: directories, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      }
    }
  }

  const temp = `\\.${owner}\\.[a-f0-9]{8}\\.tmp`;
  await Promise.all([
    removeMatching(project.workPath(), new RegExp(`^render-${owner}-[a-f0-9]{12}$`), true),
    removeMatching(project.cachePath('units'), new RegExp(`^[a-f0-9]{20}\\.mp4${temp}\\.mp4$`)),
    removeMatching(project.cachePath('audio'), new RegExp(`^[a-f0-9]{20}\\.m4a${temp}\\.m4a$`)),
    removeMatching(project.cachePath('audio', 'stems'), new RegExp(`^[a-f0-9]{20}\\.wav${temp}\\.wav$`)),
    removeMatching(project.cachePath('sfx'), new RegExp(`^[a-z]+-v1\\.wav${temp}\\.wav$`)),
    ...(typeof out === 'string' && path.isAbsolute(out)
      ? [removeMatching(path.dirname(out), new RegExp(`^${temp}\\.mp4$`), false, path.basename(out))]
      : []),
  ]);
}
