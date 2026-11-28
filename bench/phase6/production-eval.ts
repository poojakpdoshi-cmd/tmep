/**
 * Phase 6.6 real production evaluation (rubric: docs/phase-6/RUBRIC.md, frozen before this ran).
 *
 *   FRAME_MODELS=<dir> FRAME_PYTHONPATH=<site> [FRAME_SHERPA_MODEL=<dir>] \
 *   node bench/phase6/production-eval.ts --video v.mp4 --audio a.mp4 --subs s.ttml --out <dir> [--segments 15-75,185-250]
 *
 * For each segment: the Phase 5 workflow (brief → structured plan → compile → caption/format → render)
 * and the Phase 6 workflow (one production call through `final`) on identical requirements, plus a
 * Phase 6 run on a local-ASR transcript to exercise the caption-accuracy gate. Writes measurements,
 * contact sheets and a JSON summary; scoring against the rubric is done by viewing the sheets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as api from '../../packages/engine/src/api.ts';
import { produce } from '../../packages/engine/src/production.ts';
import { estimateTokens } from '../tokens.ts';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const video = path.resolve(arg('--video')!), audio = path.resolve(arg('--audio')!), subs = arg('--subs')!, out = path.resolve(arg('--out')!);
const segments = (arg('--segments', '15-75,185-250')!).split(',').map((s) => s.split('-').map(Number) as [number, number]);
fs.mkdirSync(out, { recursive: true });
const ff = (a: string[]) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a], { maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(String(r.stderr)); return r; };
const tc = (x: string) => { const [h, m, s] = x.split(':'); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
const srtT = (t: number) => { const ms = Math.round(t * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const cues = [...fs.readFileSync(subs, 'utf8').matchAll(/<p begin="([^"]+)" end="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => ({ s: tc(m[1]!), e: tc(m[2]!), text: m[3]!.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').trim() }));

function measure(file: string) {
  const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString().trim();
  const lo = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { maxBuffer: 1 << 26 }).stderr.toString();
  const I = /I:\s+(-?[\d.]+) LUFS/.exec(lo.slice(lo.lastIndexOf('Summary')))?.[1], TP = /Peak:\s+(-?[\d.]+) dBFS/.exec(lo.slice(lo.lastIndexOf('True peak')))?.[1];
  const sil = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'silencedetect=n=-40dB:d=1', '-f', 'null', '-'], { maxBuffer: 1 << 26 }).stderr.toString();
  return { duration: Number(pr), lufs: I ? Number(I) : null, truePeak: TP ? Number(TP) : null, deadAirOver1s: (sil.match(/silence_end/g) ?? []).length };
}
function sheet(file: string, dest: string) {
  ff(['-i', file, '-vf', 'fps=1/5,scale=180:320,tile=8x1:padding=2', '-frames:v', '1', '-q:v', '5', dest]);
}
async function timed<T>(fn: () => Promise<T>) {
  let peak = process.memoryUsage().rss; const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 200);
  const t0 = performance.now(); try { const r = await fn(); return { r, ms: Math.round(performance.now() - t0), peakMB: Math.round(peak / 1048576) }; } finally { clearInterval(iv); }
}
function timelineStats(tl: Awaited<ReturnType<Awaited<ReturnType<typeof api.openProject>>['timeline']>>) {
  const zooms = tl.clips.reduce((n, c) => n + c.zoom.length + (c.fx ?? []).filter((e) => e.type === 'kf').length, 0);
  return { clips: tl.clips.length, zooms, gfx: tl.gfx.length, transitions: tl.clips.filter((c) => c.trans && c.trans.type !== 'none').length, captions: tl.captions.style, captionPos: tl.captions.pos ?? 'lower', follow: tl.clips.some((c) => c.follow?.length), ratio: tl.settings.ratio };
}

const summary: Record<string, unknown>[] = [];
for (const [s0, s1] of segments) {
  const tag = `tos-${s0}-${s1}`, seg = path.join(out, `${tag}.mp4`), srt = path.join(out, `${tag}.srt`);
  ff(['-ss', String(s0), '-t', String(s1 - s0), '-i', video, '-ss', String(s0), '-t', String(s1 - s0), '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', seg]);
  const inSeg = cues.filter((c) => c.s >= s0 && c.e <= s1);
  fs.writeFileSync(srt, inSeg.map((c, i) => `${i + 1}\n${srtT(c.s - s0)} --> ${srtT(c.e - s0)}\n${c.text}\n`).join('\n'));
  const req = { genre: 'cinematic' as const, constraints: { target: 40, ratio: '9:16' as const, captions: true } };

  // ---- Previous workflow (Phase 5 interface) ----
  const dA = path.join(out, `${tag}-prev`); fs.rmSync(dA, { recursive: true, force: true }); fs.mkdirSync(dA);
  const cA: api.Ctx = { project: dA, detail: 'standard', mediaRoots: [out, dA], outRoots: [dA] };
  const callsA: unknown[] = [];
  const A = await timed(async () => {
    const call = async <T>(name: string, args: Record<string, unknown>, fn: () => Promise<T>) => { callsA.push({ name, args }); return fn(); };
    await call('video_import', { paths: [seg] }, () => api.importMedia(cA, { paths: [seg] }));
    await call('video_transcribe', { asset: 'v1', file: srt }, () => api.transcribe(cA, { asset: 'v1', file: srt }));
    await call('video_inspect', { what: 'brief', asset: 'v1', task: 'cinematic', semantic: true }, () => api.inspect(cA, { what: 'brief', asset: 'v1', task: 'cinematic', semantic: true }));
    await call('video_edit', { ratio: '9:16', ops: [] }, () => api.edit(cA, { ratio: '9:16', ops: [] }).catch(() => undefined));
    await call('video_plan', { mode: 'structured', action: 'build', asset: 'v1', task: 'cinematic', semantic: true }, () => api.editPlan(cA, { action: 'build', asset: 'v1', task: 'cinematic', semantic: true }));
    await call('video_plan', { mode: 'structured', action: 'compile', asset: 'v1', task: 'cinematic', rebase: true }, () => api.editPlan(cA, { action: 'compile', asset: 'v1', task: 'cinematic', rebase: true }));
    await call('video_edit', { ops: ['format 9:16', 'captions pos=lower'] }, () => api.edit(cA, { ops: ['format 9:16', 'captions pos=lower'] }));
    const o = path.join(dA, 'renders', 'final.mp4');
    await call('video_render', { out: o, quality: 'high' }, () => api.render(cA, { out: o, quality: 'high' as never, wait: 3600 }));
    return o;
  });
  const tlA = await (await api.openProject(dA, false)).timeline();
  const qaA = await api.inspect(cA, { what: 'qa', file: A.r }) as { defects: number; advisories: number; findings: { code: string }[] };
  sheet(A.r, path.join(out, `${tag}-prev-sheet.jpg`));

  // ---- FRAME Phase 6 ----
  const dB = path.join(out, `${tag}-frame`); fs.rmSync(dB, { recursive: true, force: true }); fs.mkdirSync(dB);
  const cB: api.Ctx = { project: dB, detail: 'standard', mediaRoots: [out, dB], outRoots: [dB] };
  const callsB: unknown[] = [];
  const B = await timed(async () => {
    callsB.push({ name: 'video_import', args: { paths: [seg] } }); await api.importMedia(cB, { paths: [seg] });
    callsB.push({ name: 'video_transcribe', args: { asset: 'v1', file: srt } }); await api.transcribe(cB, { asset: 'v1', file: srt });
    const args = { mode: 'produce', action: 'start', id: 'reel', asset: 'v1', ...req, until: 'final', semantic: true };
    callsB.push({ name: 'video_plan', args });
    return produce(cB, { action: 'start', id: 'reel', asset: 'v1', ...req, until: 'final', semantic: true }) as Promise<{ report: Record<string, unknown> }>;
  });
  const outB = path.join(dB, 'renders', 'reel.mp4');
  const tlB = await (await api.openProject(dB, false)).timeline();
  const qaB = await api.inspect(cB, { what: 'qa', file: outB }) as { defects: number; advisories: number; findings: { code: string }[] };
  sheet(outB, path.join(out, `${tag}-frame-sheet.jpg`));

  // ---- FRAME Phase 6 on a local-ASR transcript (caption-accuracy gate) ----
  let asr: Record<string, unknown> | undefined;
  if (process.env.FRAME_SHERPA_MODEL) {
    const dC = path.join(out, `${tag}-asr`); fs.rmSync(dC, { recursive: true, force: true }); fs.mkdirSync(dC);
    const cC: api.Ctx = { project: dC, detail: 'debug', mediaRoots: [out, dC], outRoots: [dC] };
    await api.importMedia(cC, { paths: [seg] });
    const tr = await api.transcribe(cC, { asset: 'v1', engine: 'sherpa-onnx' }) as { words: number };
    const r = await produce(cC, { action: 'start', id: 'reel', asset: 'v1', genre: 'cinematic', constraints: { target: 40, ratio: '9:16' }, until: 'strategy' }) as { strategy: { captions: unknown }; report: { openDecisions: string[] } };
    asr = { words: tr.words, captions: r.strategy.captions, open: r.report.openDecisions };
  }

  const row = {
    segment: [s0, s1], subtitleCues: inSeg.length,
    previous: { calls: callsA.length, agentWrittenTok: estimateTokens(JSON.stringify(callsA)), ms: A.ms, peakMB: A.peakMB, ...measure(A.r), timeline: timelineStats(tlA), qa: { defects: qaA.defects, advisories: qaA.advisories, codes: qaA.findings.map((f) => f.code) } },
    frame: { calls: callsB.length, agentWrittenTok: estimateTokens(JSON.stringify(callsB)), ms: B.ms, peakMB: B.peakMB, ...measure(outB), timeline: timelineStats(tlB), qa: { defects: qaB.defects, advisories: qaB.advisories, codes: qaB.findings.map((f) => f.code) }, report: B.r.report },
    ...(asr && { frameAsr: asr }),
  };
  summary.push(row);
  console.error(tag, 'done');
}
fs.writeFileSync(path.join(out, 'production-eval.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
