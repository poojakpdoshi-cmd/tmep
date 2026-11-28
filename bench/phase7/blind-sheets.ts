/**
 * Blind pairs for human rating (Phase 7.6). Copies each segment's two contact sheets / renders to
 * anonymous names (X / Y, order randomized per segment) and writes the key separately, so a rater scores
 * against docs/phase-6/RUBRIC.md without knowing which version made which edit.
 *
 *   node bench/phase7/blind-sheets.ts --dir <eval out> --a p6 --b p7 --to <rater dir> --key <key file outside rater dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1]! : ''; };
const dir = arg('--dir'), a = arg('--a'), b = arg('--b'), to = arg('--to'), keyFile = arg('--key');
if (path.resolve(path.dirname(keyFile)).startsWith(path.resolve(to))) throw new Error('keep the key outside the rater directory');
fs.mkdirSync(to, { recursive: true });
const key: Record<string, Record<string, string>> = {};
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(`-${a}-sheet.jpg`))) {
  const seg = f.slice(0, -`-${a}-sheet.jpg`.length);
  const flip = randomInt(2) === 1, order = flip ? [b, a] : [a, b];
  key[seg] = { X: order[0]!, Y: order[1]! };
  for (const [slot, label] of [['X', order[0]!], ['Y', order[1]!]] as const) {
    fs.copyFileSync(path.join(dir, `${seg}-${label}-sheet.jpg`), path.join(to, `${seg}-${slot}-sheet.jpg`));
    const render = path.join(dir, `${seg}-${label}`, 'renders', 'reel.mp4');
    if (fs.existsSync(render)) fs.copyFileSync(render, path.join(to, `${seg}-${slot}.mp4`));
  }
}
fs.writeFileSync(keyFile, JSON.stringify(key, null, 1));
console.log(`${Object.keys(key).length} blind pairs in ${to}; key in ${keyFile}`);
