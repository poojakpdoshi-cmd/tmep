/**
 * Phase 7.6 comparative production evaluation: one FRAME code version (by repository root) produces a
 * 9:16 reel from each prepared segment with identical inputs and requirements. Run once per version
 * (Phase 6 head in a git worktree, Phase 7 here), each in its own process; compare with asd-crop.ts and
 * the frozen rubric (docs/phase-6/RUBRIC.md).
 *
 *   FRAME_MODELS=<dir> FRAME_PYTHONPATH=<site> node bench/phase7/production-eval.ts \
 *     --root <repo> --label p7 --segments <dir with *.mp4 [+ same-name .srt]> --out <dir> [--only name,…]
 *
 * User-supplied footage: put clips in the segments directory; an optional requests.json maps a file name to
 * {genre, constraints} (default below). Without a .srt the version's default local ASR transcribes it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(arg('--root', '.')!), label = arg('--label', 'run')!, segDir = path.resolve(arg('--segments')!), out = path.resolve(arg('--out')!);
const only = arg('--only')?.split(',');
const api = await import(pathToFileURL(path.join(root, 'packages/engine/src/api.ts')).href);
const { produce } = await import(pathToFileURL(path.join(root, 'packages/engine/src/production.ts')).href);
const { estimateTokens } = await import(pathToFileURL(path.resolve('bench/tokens.ts')).href);
fs.mkdirSync(out, { recursive: true });

// Identical for every version; `min` is the rubric's 30 s floor (a version that cannot express it ignores it).
export const REQUEST = { genre: 'cinematic', constraints: { target: 40, min: 30, ratio: '9:16', captions: true } };

function measure(file: string) {
  const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString().trim();
  const lo = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { maxBuffer: 1 << 26 }).stderr.toString();
  const I = /I:\s+(-?[\d.]+) LUFS/.exec(lo.slice(lo.lastIndexOf('Summary')))?.[1], TP = /Peak:\s+(-?[\d.]+) dBFS/.exec(lo.slice(lo.lastIndexOf('True peak')))?.[1];
  const sil = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'silencedetect=n=-40dB:d=1', '-f', 'null', '-'], { maxBuffer: 1 << 26 }).stderr.toString();
  return { duration: Number(pr), lufs: I ? Number(I) : null, truePeak: TP ? Number(TP) : null, deadAirOver1s: (sil.match(/silence_end/g) ?? []).length };
}

const rows: Record<string, unknown>[] = [];
const requests: Record<string, typeof REQUEST> = fs.existsSync(path.join(segDir, 'requests.json')) ? JSON.parse(fs.readFileSync(path.join(segDir, 'requests.json'), 'utf8')) : {};
for (const f of fs.readdirSync(segDir).filter((x) => /\.(mp4|mov|mkv|webm)$/i.test(x)).sort()) {
  const tag = f.replace(/\.[^.]+$/, '');
  if (only && !only.some((o) => tag === o || tag === `tos-${o}`)) continue;
  const req = requests[f] ?? REQUEST;
  const dir = path.join(out, `${tag}-${label}`); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  const ctx = { project: dir, detail: 'standard', mediaRoots: [segDir, dir], outRoots: [dir] };
  const calls: unknown[] = [];
  let peak = process.memoryUsage().rss; const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 200);
  const t0 = performance.now();
  calls.push({ name: 'video_import', args: { paths: [path.join(segDir, f)] } }); await api.importMedia(ctx, { paths: [path.join(segDir, f)] });
  const srt = path.join(segDir, `${tag}.srt`), tr = fs.existsSync(srt) ? { asset: 'v1', file: srt } : { asset: 'v1' };
  calls.push({ name: 'video_transcribe', args: tr }); await api.transcribe(ctx, tr);
  const args = { action: 'start', id: 'reel', asset: 'v1', ...req, until: 'final', semantic: true };
  calls.push({ name: 'video_plan', args: { mode: 'produce', ...args } });
  const r = await produce(ctx, args) as { report: Record<string, unknown>; stages: Record<string, { out?: Record<string, unknown>; ms?: number }> };
  const ms = Math.round(performance.now() - t0); clearInterval(iv);
  const file = path.join(dir, 'renders', 'reel.mp4');
  const tl = await (await api.openProject(dir, false)).timeline();
  const qa = await api.inspect(ctx, { what: 'qa', file, constraints: req.constraints }) as { defects: number; advisories: number; findings: { code: string; class?: string }[]; editorial?: unknown };
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', 'fps=1/4,scale=180:320,tile=10x1:padding=2', '-frames:v', '1', '-q:v', '5', path.join(out, `${tag}-${label}-sheet.jpg`)]);
  rows.push({
    segment: tag, label, ms, peakMB: Math.round(peak / 1048576), calls: calls.length, agentWrittenTok: estimateTokens(JSON.stringify(calls)), ...measure(file),
    timeline: { clips: tl.clips.map((c: { src: string; in: number; out: number; cx: number; follow?: unknown[] }) => ({ in: c.in, out: c.out, cx: c.cx, followKeys: c.follow?.length ?? 0 })), zooms: tl.clips.reduce((n: number, c: { zoom: unknown[] }) => n + c.zoom.length, 0), gfx: tl.gfx.length, sfx: tl.sfx.length, captions: tl.captions.style, captionPos: tl.captions.pos, color: tl.color ?? null },
    follow: tl.clips.map((c: { follow?: { t: number; cx: number }[] }) => c.follow ?? []),
    qa: { defects: qa.defects, advisories: qa.advisories, codes: qa.findings.map((x) => `${x.code}${x.class ? `:${x.class}` : ''}`), editorial: qa.editorial },
    stages: Object.fromEntries(Object.entries(r.stages).map(([k, v]) => [k, v.ms])),
    correct: r.stages.correct?.out, roughcut: r.stages.roughcut?.out, decisions: (r as { strategy?: { decisions: unknown[]; open: unknown[] } }).strategy,
  });
  console.error(tag, label, ms, 'ms');
}
fs.writeFileSync(path.join(out, `production-eval-${label}.json`), JSON.stringify(rows, null, 1));
console.log(JSON.stringify(rows.map((r) => ({ segment: r.segment, label: r.label, ms: r.ms, duration: r.duration, lufs: r.lufs, qa: r.qa })), null, 1));
