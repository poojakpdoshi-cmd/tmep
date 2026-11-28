/**
 * Phase 4 Stage 4.0 gate: every advertised editing op / effect / transition / colour / audio
 * operation is applied through the public engine API, rendered to a complete MP4, decoded, and
 * compared with the same timeline rendered without it. A case passes only if the render succeeds
 * AND the decoded output measurably changes where the operation says it should.
 *
 *   node bench/phase4/effect-matrix.ts [workdir] [--filter=substr]
 *
 * Writes docs/phase-4/evidence/effect-matrix.json. Synthetic media only (testsrc2 + tones);
 * this verifies wiring and visibility, not aesthetic quality.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as api from '../../packages/engine/src/api.ts';
import { probe } from '../../packages/media/src/ffmpeg.ts';

const args = process.argv.slice(2);
const filter = args.find((a) => a.startsWith('--filter='))?.slice(9);
const noAudioCache = args.includes('--no-audio-cache');
const work = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(os.tmpdir(), 'frame-effect-matrix'));
rmSync(work, { recursive: true, force: true });
const proj = path.join(work, 'proj');
mkdirSync(proj, { recursive: true });

const ff = (a: string[]) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a], { maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return r.stdout as Buffer;
};
// A: moving test pattern + 440 Hz with a little noise (so denoise/de-ess have something to act on).
ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4:sample_rate=48000,volume=3.5,tremolo=f=2:d=0.9[s];anoisesrc=d=4:c=pink:r=48000:a=0.05[n];[s][n]amix=inputs=2:normalize=0',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(proj, 'a.mp4')]);
// B: a different pattern with a green field (chroma key target) + 660 Hz with a 7 kHz component (de-ess target).
ff(['-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=4,drawbox=x=380:y=40:w=220:h=280:color=0x00ff00:t=fill', '-f', 'lavfi', '-i', 'sine=f=660:d=4:sample_rate=48000,volume=0.4[s];sine=f=7000:d=4:sample_rate=48000,volume=0.15[h];[s][h]amix=inputs=2:normalize=0',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(proj, 'b.mp4')]);
// A tiny identity-with-a-twist LUT (swaps red and blue) inside the project.
{
  const N = 2, rows: string[] = ['LUT_3D_SIZE 2'];
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) rows.push(`${b} ${g} ${r}`);
  writeFileSync(path.join(proj, 'swap.cube'), rows.join('\n') + '\n');
}

const ctx = { project: proj, detail: 'standard' as const };
await api.importMedia(ctx, { paths: ['a.mp4', 'b.mp4'] });
const base = await api.edit(ctx, { ratio: '16:9', ops: [{ op: 'add', src: 'v1', in: 0, out: 3 }, { op: 'add', src: 'v2', in: 0, out: 3 }] });
const baseRev = base.rev as number;

type Expect = 'video' | 'audio' | 'both' | 'any' | 'dur';
interface Case { name: string; ops: unknown[]; expect: Expect; win?: [number, number]; baseOps?: unknown[] }
const C = (name: string, ops: unknown[], expect: Expect, win: [number, number] = [0.4, 2.6]): Case => ({ name, ops, expect, win });
const fx = (kind: string, extra: Record<string, unknown> = {}, clip = 'c1') => ({ op: 'fx', kind, clip, ...extra });
const chevron = [[0.3, 0.2], [0.7, 0.2], [0.55, 0.5], [0.7, 0.8], [0.3, 0.8], [0.45, 0.5]];

const cases: Case[] = [
  C('fx kf', [fx('kf', { keys: '0:s=1;2:s=1.4,e=io' })], 'video'),
  ...['zoomin', 'zoomout', 'push', 'pull', 'panleft', 'panright', 'panup', 'pandown'].map((k) => C(`fx ${k}`, [fx(k, { d: 3 })], 'video')),
  C('fx mask rect', [fx('mask', { shape: 'rect', w: 0.5, h: 0.5 })], 'video'),
  C('fx mask ellipse', [fx('mask', { shape: 'ellipse', w: 0.5, h: 0.5, feather: 0.05 })], 'video'),
  C('fx mask poly', [fx('mask', { shape: 'poly', pts: [[0.2, 0.2], [0.8, 0.2], [0.5, 0.8]] })], 'video'),
  C('fx mask concave', [fx('mask', { shape: 'concave', pts: chevron })], 'video'),
  C('fx mask concave keyed', [fx('mask', { shape: 'concave', pts: chevron, keys: [{ t: 0, x: 0.3 }, { t: 2, x: 0.7 }] })], 'video'),
  C('fx mask bezier', [fx('mask', { shape: 'bezier', bezierStart: [0.2, 0.5], beziers: [{ cp1: [0.2, 0.1], cp2: [0.8, 0.1], to: [0.8, 0.5] }, { cp1: [0.8, 0.9], cp2: [0.2, 0.9], to: [0.2, 0.5] }] })], 'video'),
  C('fx mask reveal', [fx('mask', { shape: 'rect', at: 0.5, reveal: 1, from: 'left' })], 'video'),
  C('fx blur gaussian', [fx('blur', { mode: 'gaussian', sigma: 6 })], 'video'),
  C('fx blur directional', [fx('blur', { mode: 'directional', sigma: 6, angle: 30 })], 'video'),
  C('fx glow', [fx('glow', { radius: 12, intensity: 0.6 })], 'video'),
  C('fx shadow (b-roll)', [{ op: 'pip', src: 'v2', at: 0.5, d: 2, pos: 'br', scale: 0.4 }, { op: 'fx', kind: 'shadow', clip: '$last', dx: 0, dy: 12, blur: 10, opacity: 0.9 }], 'video'),
  C('fx blend multiply (b-roll)', [{ op: 'pip', src: 'v2', at: 0.5, d: 2, pos: 'br', scale: 0.5 }, { op: 'fx', kind: 'blend', clip: '$last', mode: 'multiply' }], 'video'),
  C('fx chromakey (b-roll)', [{ op: 'broll', src: 'v2', at: 0.5, d: 2 }, { op: 'fx', kind: 'chromakey', clip: '$last', color: '#00ff00', similarity: 0.2 }], 'video'),
  C('fx mblur', [fx('mblur', { frames: 6 })], 'video'),
  C('fx persp', [fx('persp', { x0: 0.1, y0: 0.05, x1: 0.9, y1: 0, x2: 0, y2: 1, x3: 1, y3: 0.95 })], 'video'),
  ...['cinematic-vignette', 'soft-glow-warm', 'dreamy-blur'].map((ch) => C(`fx chain ${ch}`, [fx('chain', { chain: ch })], 'video')),
  C('fx chain chroma-clean (b-roll)', [{ op: 'broll', src: 'v2', at: 0.5, d: 2 }, { op: 'fx', kind: 'chain', clip: '$last', chain: 'chroma-clean' }], 'video'),
  C('fx chain crisp-callout (b-roll)', [{ op: 'pip', src: 'v2', at: 0.5, d: 2, pos: 'br', scale: 0.4 }, { op: 'fx', kind: 'chain', clip: '$last', chain: 'crisp-callout' }], 'video'),
  // A J-cut needs source audio before the incoming clip's in-point: start c2 at 1 s in both renders.
  { ...C('jcut', [{ op: 'trim', clip: 'c2', in: 1, out: 4 }, 'jcut c2 0.6'], 'audio', [2.3, 3.0]), baseOps: [{ op: 'trim', clip: 'c2', in: 1, out: 4 }] },
  C('lcut', ['lcut c1 0.6'], 'audio', [3.0, 3.6]),
  C('ramp', [{ op: 'ramp', clip: 'c1', keys: '0:speed=1;1:speed=2;2:speed=1' }], 'any', [0.6, 2.4]),
  C('freeze', ['freeze 1 1'], 'both', [1.2, 1.9]),
  C('reverse', ['reverse c1 true'], 'video'),
  C('punch', ['punch 1 to=1.3 d=1.2'], 'video', [1.1, 2.0]),
  C('matchcut', ['matchcut c1 c2'], 'video', [2.6, 3.4]),
  // reframe only crops when the output aspect differs from the source; checked in 9:16 below.
  { ...C('reframe (9:16)', [{ op: 'format', ratio: '9:16' }, { op: 'reframe', clip: 'c1', cx: 0.15 }], 'video'), baseOps: [{ op: 'format', ratio: '9:16' }] },
  C('stabilize', ['stabilize c1 smoothing=10'], 'video'),
  C('splitscreen', [{ op: 'splitscreen', srcs: ['v1', 'v2'], at: 0.5, d: 2, layout: '2h' }], 'video'),
  C('pip', [{ op: 'pip', src: 'v2', at: 0.5, d: 2, pos: 'br', scale: 0.3 }], 'video'),
  C('parallax', [{ op: 'parallax', srcs: ['v1', 'v2'], at: 0.5, d: 2 }], 'video'),
  ...['exposure=0.6', 'contrast=1.6', 'temp=3000', 'tint=0.5', 'saturation=0.2', 'vibrance=0.8', 'highlights=-0.6', 'shadows=1', 'vignette=0.8', 'inputColorSpace=bt601']
    .map((p) => C(`color ${p}`, [`color c1 ${p}`], 'video')),
  C('color curves', [{ op: 'color', clip: 'c1', curves: { r: '0/0 0.5/0.8 1/1' } }], 'video'),
  C('color lut', [{ op: 'color', clip: 'c1', lut: 'swap.cube' }], 'video'),
  C('audio c2 deess=1', ['audio c2 deess=1'], 'audio', [3.4, 5.6]),
  ...['eq=dialogue', 'eq=warm', 'eq=crisp', 'denoise=0.9', 'comp=heavy', 'hp=500', 'lp=1000', 'fadeIn=1.5', 'fadeOut=1.5']
    .map((p) => C(`audio c1 ${p}`, [`audio c1 ${p}`], 'audio')),
  C('audio master lufs -24', ['audio lufs=-24 twoPass=true'], 'audio', [0.4, 5.6]),
  C('audio master target podcast', ['audio target=podcast'], 'audio', [0.4, 5.6]),
  C('audio master limiter', ['audio limiter=-6'], 'audio', [0.4, 5.6]),
];
// Every advertised transition, on the cut at 3 s.
const { TRANSITIONS } = await import('../../packages/core/src/ops.ts');
for (const tr of TRANSITIONS) if (tr !== 'none') cases.push(C(`transition ${tr}`, [{ op: 'transition', type: tr, clip: 'c2', d: 0.5 }], 'video', [2.75, 3.25]));

const W = 160, H = 90, AR = 48000;
const gray = (file: string, t0: number, t1: number) => ff(['-ss', String(t0), '-to', String(t1), '-i', file, '-vf', `fps=10,scale=${W}:${H}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
const pcm = (file: string, t0: number, t1: number) => {
  const b = ff(['-ss', String(t0), '-to', String(t1), '-i', file, '-vn', '-ac', '1', '-ar', String(AR), '-f', 's16le', '-']);
  return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
};
const vdiff = (a: Buffer, b: Buffer) => { const n = Math.min(a.length, b.length); if (!n) return 0; let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i]! - b[i]!); return s / n; };
const adiff = (a: Int16Array, b: Int16Array) => {
  const n = Math.min(a.length, b.length); if (!n) return 0;
  let d = 0, r = 0;
  for (let i = 0; i < n; i++) { d += (a[i]! - b[i]!) ** 2; r += b[i]! ** 2; }
  return Math.sqrt(d / n) / Math.max(1, Math.sqrt(r / n));
};

const render = async (name: string) => {
  if (noAudioCache) rmSync(path.join(proj, '.tmep', 'cache', 'audio'), { recursive: true, force: true });
  const out = path.join(proj, 'renders', `${name.replace(/[^a-z0-9]+/gi, '-')}.mp4`);
  const r = await api.render(ctx, { out, preview: true, wait: 300 });
  if (r.state !== 'done') throw new Error(`render ${r.state}: ${JSON.stringify(r.err)}`);
  return { out, s: r.s as number };
};
const baseline = await render('baseline');
const baseDur = (await probe(baseline.out)).dur;

const results: Record<string, unknown>[] = [];
for (const c of cases) {
  if (filter && !c.name.includes(filter)) continue;
  const t0 = Date.now();
  const row: Record<string, unknown> = { name: c.name, expect: c.expect };
  try {
    await api.edit(ctx, { checkout: baseRev });
    // `$last` refers to the overlay id created by the previous op of the same case.
    let last: string | undefined;
    for (const op of c.ops) {
      const o = typeof op === 'object' && op && (op as { clip?: string }).clip === '$last' ? { ...(op as object), clip: last } : op;
      const r = await api.edit(ctx, { ops: [o] });
      const ids = (r.ids as string[] | undefined) ?? [];
      last = ids.find((i) => /^b/.test(i)) ?? last;
      row.did = [...((row.did as string[]) ?? []), ...((r.did as string[]) ?? [])];
    }
    const { out, s } = await render(c.name);
    const dur = (await probe(out)).dur;
    let ref = baseline.out;
    if (c.baseOps) {
      await api.edit(ctx, { checkout: baseRev });
      for (const op of c.baseOps) await api.edit(ctx, { ops: [op] });
      ref = (await render(`${c.name} base`)).out;
    }
    const [w0, w1] = c.win!;
    const v = vdiff(gray(out, w0, w1), gray(ref, w0, w1));
    const a = adiff(pcm(out, w0, w1), pcm(ref, w0, w1));
    const durChange = Math.abs(dur - baseDur);
    const vOk = v > 1.5, aOk = a > 0.05, dOk = durChange > 0.05;
    const ok = c.expect === 'video' ? vOk : c.expect === 'audio' ? aOk : c.expect === 'both' ? vOk && aOk : c.expect === 'dur' ? dOk : vOk || aOk || dOk;
    Object.assign(row, { ok, videoDiff: +v.toFixed(2), audioDiff: +a.toFixed(3), dur: +dur.toFixed(3), baseDur: +baseDur.toFixed(3), renderS: s });
  } catch (e) {
    Object.assign(row, { ok: false, error: (e as Error).message.slice(0, 300) });
  }
  row.ms = Date.now() - t0;
  results.push(row);
  console.log(`${row.ok ? 'PASS' : 'FAIL'} ${c.name.padEnd(36)} v=${row.videoDiff ?? '-'} a=${row.audioDiff ?? '-'} dur=${row.dur ?? '-'}${row.error ? '  ' + row.error : ''}`);
}

const pass = results.filter((r) => r.ok).length;
const report = { date: new Date().toISOString(), host: `${os.platform()} ${os.arch()} ${os.cpus().length} cpu, node ${process.version}`, media: 'synthetic testsrc2/testsrc + tones', baseline: { dur: baseDur }, pass, total: results.length, results };
if (!filter) {
  const outFile = path.resolve(import.meta.dirname, '../../docs/phase-4/evidence/effect-matrix.json');
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(report, null, 1) + '\n');
}
console.log(`\n${pass}/${results.length} cases produced a measurable change in a complete render`);
