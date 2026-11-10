/**
 * Reader process for tests/job-persistence.test.ts: reads a JSON record in a tight loop (as a
 * polling MCP client or a second CLI would) until a deadline, recording any error or torn read.
 *   node tests/json-reader-child.ts <file> <deadlineEpochMs> [intervalMs]   (0 / omitted = tight loop)
 */
import { writeSync, promises as fsp } from 'node:fs';
import { readJson } from '../packages/core/src/util.ts';

const [file, until, every = '0'] = process.argv.slice(2) as [string, string, string?];
const pause = Number(every);
const errors: string[] = [];
const rawErrors: string[] = [];
let reads = 0;
while (Date.now() < Number(until)) {
  // diagnostic: a plain read without retries (pre-A3 readJson) — counts real sharing violations
  try {
    JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    rawErrors.push((e as NodeJS.ErrnoException).code ?? 'parse');
  }
  try {
    const j = await readJson<{ state?: string }>(file);
    if (j.state !== 'running') errors.push('torn or unexpected record');
    reads++;
  } catch (e) {
    errors.push((e as NodeJS.ErrnoException).code ?? String(e));
  }
  if (pause > 0) await new Promise((r) => setTimeout(r, pause));
}
writeSync(1, `RESULT ${JSON.stringify({ reads, errors: errors.slice(0, 20), errorCount: errors.length, rawErrors: rawErrors.slice(0, 20), rawErrorCount: rawErrors.length })}\n`);
