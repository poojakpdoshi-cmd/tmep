/**
 * Phase 4A presets through the public API (`api.compile`): kinetic title, lower third (avoiding a
 * reserved presenter region), callout, UI demo, animated diagram and dynamic chart, one after another.
 *
 *   node examples/phase-4/presets-demo.ts [outdir] [profile]
 *
 * Synthetic media only. Writes <outdir>/presets-demo.mp4 and a contact sheet.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as api from '../../packages/engine/src/api.ts';
import { canvasModule } from '../../packages/motion/src/vector.ts';

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'frame-presets-demo'));
const profile = process.argv[3] ?? 'editorial';
mkdirSync(out, { recursive: true });
const plate = path.join(out, 'plate.mp4');
// A plate with a "presenter" silhouette on the left half (where the lower third must not go).
spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=1080x1920:c0=0x101827:c1=0x1f2a44:x0=0:y0=0:x1=1080:y1=1920:d=24:r=30,format=yuv420p,drawbox=x=170:y=640:w=360:h=520:color=0x3a4a6a:t=fill',
  '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '24', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', plate], { stdio: 'inherit' });
// A synthetic app screenshot for the UI demo.
const shot = path.join(out, 'app.png');
{
  const c = canvasModule().createCanvas(900, 600); const g = c.getContext('2d');
  g.fillStyle = '#F8FAFC'; g.fillRect(0, 0, 900, 600);
  g.fillStyle = '#0F172A'; g.fillRect(0, 0, 900, 70);
  g.fillStyle = '#E2E8F0'; for (let i = 0; i < 4; i++) g.fillRect(40, 110 + i * 110, 520, 80);
  g.fillStyle = '#2563EB'; g.fillRect(620, 470, 220, 70);
  g.fillStyle = '#FFFFFF'; g.font = '700 30px sans-serif'; g.fillText('Render', 680, 515);
  writeFileSync(shot, c.toBuffer('image/png'));
}
const ctx = { project: path.join(out, 'proj'), detail: 'standard' as const };
rmSync(ctx.project, { recursive: true, force: true });
mkdirSync(ctx.project, { recursive: true });
await api.importMedia(ctx, { paths: [plate, shot] });
await api.edit(ctx, { ratio: '9:16', ops: [{ op: 'add', src: 'v1', in: 0, out: 24 }] });
const base = { profile, platform: 'reels', duration: 3.8 };
const presenter = { x: 0.324, y: 0.469, w: 0.333, h: 0.271 };
const intents = [
  { kind: 'kinetic_title', id: 'k', at: 0, title: 'Footage in. Story out.', subtitle: 'Local understanding, deterministic motion, verified renders.' },
  { kind: 'lower_third', id: 'l', at: 4, title: 'Dr. Ananya Rao', subtitle: 'Cardiologist, AIIMS Delhi', avoid: [presenter] },
  { kind: 'callout', id: 'c', at: 8, target: { x: 0.32, y: 0.4 }, label: 'Presenter detected', avoid: [] },
  { kind: 'ui_demo', id: 'u', at: 12, asset: 'i1', clicks: [{ x: 0.33, y: 0.3, t: 1.0, label: 'Choose clip' }, { x: 0.81, y: 0.84, t: 2.4, label: 'Render' }] },
  { kind: 'animated_diagram', id: 'd', at: 16, nodes: ['Footage', 'Understand', 'Compile', 'Render', 'Inspect'] },
  { kind: 'dynamic_chart', id: 'g', at: 20, title: 'Agent output tokens per edit', chart: { chartType: 'hbar', highlight: 'FRAME ops', data: [{ label: 'Hand-written scripts', value: 18187 }, { label: 'FRAME ops', value: 217 }] } },
];
for (const it of intents) {
  const r = await api.compile(ctx, { ...base, ...it });
  console.log(it.kind, JSON.stringify({ ok: r.ok, rev: r.rev, corrections: r.corrections }));
}
const file = path.join(ctx.project, 'renders', 'presets-demo.mp4');
const t0 = Date.now();
const r = await api.render(ctx, { out: file, wait: 900 });
console.log(JSON.stringify({ state: r.state, s: r.s, ms: Date.now() - t0, err: r.err }));
const frames = [1.6, 2.6, 5.2, 6.4, 9.4, 13.1, 14.5, 17.4, 18.6, 21.6, 22.8];
spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `select='${frames.map((t) => `eq(n\\,${Math.round(t * 30)})`).join('+')}',scale=216:-1,tile=${frames.length}x1`, '-frames:v', '1', path.join(out, `presets-${profile}-sheet.png`)]);
const qa = await api.inspect(ctx, { what: 'qa', file });
console.log('qa', JSON.stringify({ ok: qa.ok, defects: qa.defects, findings: qa.findings }).slice(0, 600));
