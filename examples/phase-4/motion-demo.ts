/**
 * Phase 4A motion demo through the public API: kinetic typography, shape morph, motion path,
 * mask reveal, 2.5D parallax camera and motion blur in one Visual Scene over a synthetic plate.
 *
 *   node examples/phase-4/motion-demo.ts [outdir]
 *
 * Writes <outdir>/motion-demo.mp4 and <outdir>/motion-demo-sheet.png. Media is synthetic; nothing
 * is committed except this script.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as api from '../../packages/engine/src/api.ts';

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'frame-motion-demo'));
mkdirSync(out, { recursive: true });
const plate = path.join(out, 'plate.mp4');
spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=1080x1920:c0=0x0b1220:c1=0x1b2a4a:x0=0:y0=0:x1=1080:y1=1920:d=6:r=30,format=yuv420p',
  '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', plate], { stdio: 'inherit' });

const ctx = { project: path.join(out, 'proj'), detail: 'standard' as const };
mkdirSync(ctx.project, { recursive: true });
await api.importMedia(ctx, { paths: [plate] });
const spec = {
  v: 1, at: 0, duration: 5.5, ratio: '9:16',
  safe: { left: 0.06, right: 0.11, top: 0.08, bottom: 0.19 },
  styles: [
    { id: 'kicker', size: 34, font: 'bold', color: '#70DAC4' },
    { id: 'title', size: 104, font: 'heavy', color: '#FFFFFF' },
    { id: 'body', size: 44, font: 'regular', color: '#C9D4E5' },
  ],
  camera: [{ t: 0, x: 0, s: 1 }, { t: 5.4, x: -0.02, s: 1.03, e: 'smooth' }],
  mblur: { samples: 4, shutter: 0.5 },
  layers: [
    { id: 'kicker', kind: 'text', text: 'PHASE 4A · MOTION', style: 'kicker', x: .475, y: .2, w: .66, h: .04,
      anim: { by: 'char', stagger: 0.02, d: 0.5, e: 'expo', from: { o: 0, x: 0.4 } } },
    { id: 'title', kind: 'text', text: 'Every frame, by design', style: 'title', x: .475, y: .3, w: .74, h: .14, wrap: true,
      anim: { by: 'word', at: 0.3, stagger: 0.12, d: 0.7, e: 'expo', from: { o: 0, y: 0.5 } } },
    { id: 'rule', kind: 'rrect', x: .475, y: .395, w: .5, h: .004, radius: 2, fill: '#70DAC4', reveal: { from: 'left', at: 0.9, d: 0.8, e: 'smooth' } },
    { id: 'shape', kind: 'path', x: .475, y: .56, w: .42, h: .236, stroke: 0, fill: '#3B82F6', depth: 1.5,
      d: 'M20 20 H80 V80 H20 Z',
      morph: [{ t: 1.6, d: 'M50 10 A40 40 0 1 1 50 90 A40 40 0 1 1 50 10 Z', e: 'smooth' }, { t: 3.2, d: 'M50 8 L92 88 L8 88 Z', e: 'smooth' }] },
    { id: 'dot', kind: 'ellipse', x: .5, y: .5, w: .05, h: .028, fill: '#F59E0B', render: 'canvas',
      motionPath: { d: 'M0.16 0.66 C0.3 0.6 0.62 0.72 0.8 0.66', keys: [{ t: 0.8, p: 0 }, { t: 3.6, p: 1, e: 'smooth' }], orient: true } },
    { id: 'body', kind: 'text', text: 'Kinetic type · morphing · motion paths · parallax · motion blur', style: 'body',
      x: .475, y: .74, w: .72, h: .08, wrap: true,
      anim: { by: 'line', at: 1.8, d: 0.6, e: 'smooth', from: { o: 0, y: 0.6 }, out: { at: 4.8, d: 0.4, to: { o: 0 } } } },
  ],
};
await api.edit(ctx, { ratio: '9:16', ops: [{ op: 'add', src: 'v1', in: 0, out: 5.5 }, { op: 'scene', spec }] });
const file = path.join(ctx.project, 'renders', 'motion-demo.mp4');
const t0 = Date.now();
const r = await api.render(ctx, { out: file, wait: 600 });
console.log(JSON.stringify({ state: r.state, s: r.s, ms: Date.now() - t0, size: r.size, err: r.err }));
const sheet = path.join(out, 'motion-demo-sheet.png');
spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', "select='eq(n\\,6)+eq(n\\,20)+eq(n\\,36)+eq(n\\,60)+eq(n\\,85)+eq(n\\,110)+eq(n\\,140)+eq(n\\,158)',scale=270:-1,tile=8x1", '-frames:v', '1', sheet]);
console.log(sheet);
