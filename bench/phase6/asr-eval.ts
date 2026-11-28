/**
 * Phase 6 speech evaluation on real dialogue: WER of local ASR engines against official subtitles, and
 * word-timing agreement (share of correctly recognized words whose start falls inside the subtitle cue
 * that contains them, ±0.5 s).
 *
 *   node bench/phase6/asr-eval.ts <subtitles.ttml|.vtt|.srt> <asr.json>...   (asr.json from packages/speech/py/sherpa_asr.py)
 *
 * Subtitles are not verbatim transcripts (they compress and omit words), so WER here is an upper bound
 * on the engine's true error.
 */
import fs from 'node:fs';
const [subFile, ...asrFiles] = process.argv.slice(2);
const raw = fs.readFileSync(subFile!, 'utf8');
const tc = (s: string) => { const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(s)!; return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`); };
const cues: { s: number; e: number; text: string }[] = [];
for (const m of raw.matchAll(/<p begin="([^"]+)" end="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g)) cues.push({ s: tc(m[1]!), e: tc(m[2]!), text: m[3]!.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '') });
const norm = (t: string) => t.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
const ref = cues.flatMap((c) => norm(c.text).map((w) => ({ w, s: c.s, e: c.e })));
function align(a: string[], b: string[]) {
  const n = a.length, m = b.length, d = Array.from({ length: n + 1 }, (_, i) => new Int32Array(m + 1).fill(0).map((_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  const pairs: [number, number][] = []; let i = n, j = m;
  while (i > 0 && j > 0) { if (a[i - 1] === b[j - 1] && d[i]![j] === d[i - 1]![j - 1]) { pairs.push([i - 1, j - 1]); i--; j--; } else if (d[i]![j] === d[i - 1]![j - 1]! + 1) { i--; j--; } else if (d[i]![j] === d[i - 1]![j]! + 1) i--; else j--; }
  return { dist: d[n]![m]!, pairs };
}
const out: Record<string, unknown>[] = [];
for (const f of asrFiles) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const hyp = (j.words as { w: string; s: number }[]).flatMap((w) => norm(w.w).map((x) => ({ w: x, s: w.s })));
  const { dist, pairs } = align(ref.map((r) => r.w), hyp.map((h) => h.w));
  const timed = pairs.filter(([r, h]) => hyp[h]!.s >= ref[r]!.s - 0.5 && hyp[h]!.s <= ref[r]!.e + 0.5).length;
  // Also within dialogue regions (subtitle cues ±1 s): music-only stretches cannot add insertions there.
  const inDialog = hyp.filter((h) => cues.some((c) => h.s >= c.s - 1 && h.s <= c.e + 1));
  const dd = align(ref.map((r) => r.w), inDialog.map((h) => h.w)).dist;
  out.push({ werDialogueRegions: +(dd / ref.length).toFixed(3), file: f.split('/').pop(), engine: j.engine, timing: j.timing, refWords: ref.length, hypWords: hyp.length, wer: +(dist / ref.length).toFixed(3), correctWords: pairs.length, timingAgreement: +(timed / Math.max(1, pairs.length)).toFixed(3), audioSeconds: j.seconds, ms: j.ms, rtf: +(j.ms / 1000 / j.seconds).toFixed(3), maxRssMB: j.maxRssMB });
}
console.log(JSON.stringify(out, null, 1));
