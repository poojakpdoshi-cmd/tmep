/**
 * Phase 7 ASR evaluation on FLEURS (Google, CC BY 4.0; clean read speech with reference transcripts).
 *
 *   FRAME_PYTHONPATH=<site> node bench/phase7/asr-wer.ts <fleurs/xx/test.tsv> <audioDir> <modelDir> [--lang en|hi] [--n 150]
 *
 * Takes the first N distinct sentences (one recording each, in file order), resamples to 16 kHz mono,
 * runs the sherpa-onnx worker in batch mode and reports WER (and CER for scripts without spaces-based
 * words). Normalization: lower case, Unicode punctuation removed, digits kept. FLEURS is read speech, not
 * conversational speech — reported as such.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const [tsv, audioDir, modelDir] = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1]! : d; };
const lang = arg('--lang', 'en'), N = Number(arg('--n', '150'));
const seen = new Set<string>(); const items: { file: string; ref: string }[] = [];
for (const line of fs.readFileSync(tsv!, 'utf8').split('\n')) {
  const c = line.split('\t'); if (c.length < 4 || seen.has(c[0]!)) continue;
  seen.add(c[0]!); items.push({ file: path.join(audioDir!, c[1]!), ref: c[3]! });
  if (items.length >= N) break;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-wer-'));
const list = path.join(tmp, 'in.list');
fs.writeFileSync(list, items.map((it, i) => { const o = path.join(tmp, `${i}.wav`); spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', it.file, '-ac', '1', '-ar', '16000', o]); return o; }).join('\n'));
const t0 = performance.now();
const py = process.env.FRAME_PYTHON ?? 'python3';
const env = { ...process.env, PYTHONPATH: [process.env.FRAME_PYTHONPATH, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
const r = spawnSync(py, [new URL('../../packages/speech/py/sherpa_asr.py', import.meta.url).pathname, list, modelDir!, lang], { env, maxBuffer: 1 << 28, encoding: 'utf8' });
const wall = performance.now() - t0;
if (r.status !== 0) { console.error(r.stderr.slice(-2000)); process.exit(1); }
const outs = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
const norm = (t: string) => t.toLowerCase().normalize('NFKC').replace(/[\p{P}\p{S}]+/gu, ' ').split(/\s+/).filter(Boolean);
const ed = (a: string[], b: string[]) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0]![j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length]![b.length]!; };
let we = 0, wn = 0, ce = 0, cn = 0, secs = 0, ms = 0, rss = 0;
const samples: unknown[] = [];
outs.forEach((o, i) => {
  const ref = norm(items[i]!.ref), hyp = norm((o.words as { w: string }[]).map((w) => w.w).join(' '));
  we += ed(ref, hyp); wn += ref.length;
  const rc = [...ref.join('')], hc = [...hyp.join('')]; ce += ed(rc, hc); cn += rc.length;
  secs += o.seconds; ms += o.ms; rss = Math.max(rss, o.maxRssMB);
  if (i < 3) samples.push({ ref: ref.join(' '), hyp: hyp.join(' ') });
});
console.log(JSON.stringify({ dataset: tsv!.split(path.sep).slice(-2).join('/'), model: path.basename(modelDir!), lang, utterances: outs.length, words: wn, wer: +(we / wn).toFixed(3), cer: +(ce / cn).toFixed(3), audioSeconds: Math.round(secs), rtf: +(ms / 1000 / secs).toFixed(3), wallSeconds: Math.round(wall / 1000), maxRssMB: rss, samples }, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
