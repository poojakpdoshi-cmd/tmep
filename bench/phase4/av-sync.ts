/**
 * Phase 4 Stage 4.0 gate: audio/video synchronisation through J/L-cuts and speed changes.
 *
 * Each source carries a one-frame white flash and a 40 ms 1 kHz beep at the same instants
 * (every 0.8 s). After an edit, every flash still on screen must coincide with a beep from the
 * same source moment. The script detects flash frames (luma) and beep onsets (audio envelope)
 * in the rendered MP4 and reports the nearest-beep offset of every flash.
 *
 *   node bench/phase4/av-sync.ts [workdir]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as api from '../../packages/engine/src/api.ts';

const work = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'frame-av-sync'));
rmSync(work, { recursive: true, force: true });
const ff = (a: string[]) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a], { maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(String(r.stderr).slice(0, 800));
  return r.stdout as Buffer;
};
const FPS = 30, D = 5;
const events = Array.from({ length: 6 }, (_, i) => 0.5 + i * 0.8); // 0.5 … 4.5 s
const flashOn = events.map((t) => `between(n,${Math.round(t * FPS)},${Math.round(t * FPS) + 2})`).join('+');
const beepOn = events.map((t) => `between(t,${t},${(t + 0.04).toFixed(3)})`).join('+');
const mkSource = (file: string, tone: number, bg: string) => ff([
  '-f', 'lavfi', '-i', `color=c=${bg}:s=320x180:r=${FPS}:d=${D},drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${flashOn}'`,
  '-f', 'lavfi', '-i', `sine=f=${tone}:d=${D}:sample_rate=48000,volume=0.6,volume=0:enable='not(${beepOn})'`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '1', '-c:a', 'pcm_s16le', '-shortest', file.replace(/\.mp4$/, '.mov'),
]);

const flashes = (file: string): number[] => {
  const px = ff(['-i', file, '-vf', 'scale=32:18,format=gray', '-f', 'rawvideo', '-']);
  const n = 32 * 18, out: number[] = [];
  let prev = false;
  for (let f = 0; f * n < px.length; f++) {
    let s = 0; for (let i = 0; i < n; i++) s += px[f * n + i]!;
    const on = s / n > 128;
    if (on && !prev) out.push(f / FPS);
    prev = on;
  }
  return out;
};
const beeps = (file: string): number[] => {
  const AR = 48000, b = ff(['-i', file, '-vn', '-ac', '1', '-ar', String(AR), '-f', 's16le', '-']);
  const a = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
  const win = 48, out: number[] = []; // 1 ms windows
  let prev = false, lastOn = -1;
  for (let i = 0; i + win <= a.length; i += win) {
    let p = 0; for (let k = 0; k < win; k++) p = Math.max(p, Math.abs(a[i + k]!));
    const on = p > 3000;
    if (on && !prev && i / AR - lastOn > 0.1) out.push(i / AR);
    if (on) lastOn = i / AR;
    prev = on;
  }
  return out;
};

interface Case { name: string; ops: unknown[] }
const cases: Case[] = [
  { name: 'hard cut (control)', ops: [] },
  { name: 'jcut c2 0.6', ops: ['jcut c2 0.6'] },
  { name: 'lcut c1 0.6', ops: ['lcut c1 0.6'] },
  { name: 'speed c1 x2', ops: [{ op: 'speed', clip: 'c1', x: 2 }] },
  { name: 'ramp c1 1→2→1', ops: [{ op: 'ramp', clip: 'c1', keys: '0:speed=1;1:speed=2;2:speed=1' }] },
  { name: 'ramp c1 1→0.5', ops: [{ op: 'ramp', clip: 'c1', keys: '0:speed=1;2:speed=0.5' }] },
  { name: 'ramp + jcut', ops: [{ op: 'ramp', clip: 'c1', keys: '0:speed=1;1:speed=2;2:speed=1' }, 'jcut c2 0.6'] },
];

const rows: Record<string, unknown>[] = [];
for (const c of cases) {
  const proj = path.join(work, c.name.replace(/[^a-z0-9]+/gi, '-'));
  mkdirSync(proj, { recursive: true });
  // Distinct content so the two sources do not deduplicate into one asset.
  mkSource(path.join(proj, 'a.mp4'), 1000, '0x202020');
  mkSource(path.join(proj, 'b.mp4'), 1200, '0x201830');
  const ctx = { project: proj, detail: 'standard' as const };
  await api.importMedia(ctx, { paths: ['a.mov', 'b.mov'] });
  // c1 = a[0.2, 3.0], c2 = b[1.0, 4.9] — c2 starts mid-source so a J-cut has pre-roll to use.
  await api.edit(ctx, { ratio: '16:9', ops: [{ op: 'add', src: 'v1', in: 0.2, out: 3.0 }, { op: 'add', src: 'v2', in: 1.0, out: 4.9 }] });
  let note = '';
  try {
    for (const op of c.ops) await api.edit(ctx, { ops: [op] });
  } catch (e) { note = (e as Error).message; }
  const out = path.join(proj, 'renders', 'out.mp4');
  const r = await api.render(ctx, { out, wait: 300 });
  if (r.state !== 'done') { rows.push({ name: c.name, ok: false, error: JSON.stringify(r.err) }); continue; }
  const fl = flashes(out), bp = beeps(out);
  const offs = fl.map((t) => { const near = bp.reduce((m, b) => (Math.abs(b - t) < Math.abs(m - t) ? b : m), Infinity); return +((near - t) * 1000).toFixed(1); });
  const worst = offs.length ? Math.max(...offs.map(Math.abs)) : NaN;
  const ok = offs.length > 0 && worst <= 45; // one frame at 30 fps (33 ms) + beep onset detection slack
  rows.push({ name: c.name, ok, worstMs: worst, flashes: fl.map((t) => +t.toFixed(3)), beeps: bp.map((t) => +t.toFixed(3)), offsetsMs: offs, ...(note ? { note } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name.padEnd(22)} worst=${worst}ms offsets=${JSON.stringify(offs)}${note ? '  ' + note : ''}`);
}
const outFile = path.resolve(import.meta.dirname, '../../docs/phase-4/evidence/av-sync.json');
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), tolerance_ms: 45, fps: FPS, rows }, null, 1) + '\n');
