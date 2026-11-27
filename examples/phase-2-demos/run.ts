import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import * as api from '../../packages/engine/src/api.ts';
import { ffmpeg, probe } from '../../packages/media/src/ffmpeg.ts';
import { canvasModule } from '../../packages/motion/src/vector.ts';

const outRoot = path.resolve('examples/phase-2-demos/out');
const workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-p2-demos-'));
await fsp.mkdir(outRoot, { recursive: true });

async function makeSyntheticClip(file: string, color: string, dur = 4, w = 540, h = 960) {
  await ffmpeg({
    args: [
      '-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}:r=30:d=${dur}`,
      '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=48000:duration=${dur}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
    ],
  });
}

async function makeSyntheticProductScreenshot(file: string) {
  const { createCanvas } = canvasModule();
  const c = createCanvas(800, 480);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0F172A';
  ctx.fillRect(0, 0, 800, 480);
  ctx.fillStyle = '#1E293B';
  ctx.fillRect(24, 24, 752, 60);
  ctx.fillStyle = '#38BDF8';
  ctx.fillRect(48, 44, 140, 20);
  ctx.fillStyle = '#1E293B';
  ctx.fillRect(24, 108, 480, 340);
  ctx.fillStyle = '#70DAC4';
  ctx.fillRect(48, 140, 320, 24);
  ctx.fillStyle = '#334155';
  ctx.fillRect(48, 190, 420, 220);
  ctx.fillStyle = '#1E293B';
  ctx.fillRect(528, 108, 248, 340);
  await fsp.writeFile(file, c.encodeSync('png'));
}

async function runDemo(name: string, setup: (ctx: api.Ctx, projDir: string) => Promise<void>) {
  const projDir = path.join(workRoot, name);
  await fsp.mkdir(projDir, { recursive: true });
  const ctx: api.Ctx = { project: projDir, detail: 'standard' };
  const t0 = Date.now();
  await setup(ctx, projDir);
  const outMp4 = path.join(outRoot, `${name}.mp4`);
  const renderRes = await api.render(ctx, { out: outMp4, frames: 4, wait: 120 });
  const v = await probe(outMp4);
  return {
    name,
    state: renderRes.state,
    dur: v.dur,
    w: v.w,
    h: v.h,
    audio: v.audio,
    ms: Date.now() - t0,
    out: path.relative(process.cwd(), outMp4).replace(/\\/g, '/'),
  };
}

try {
  const results = [];

  // 1. Professional technology explainer
  results.push(await runDemo('01-tech-explainer', async (ctx, projDir) => {
    const clip = path.join(projDir, 'bg.mp4');
    await makeSyntheticClip(clip, '#0B1120', 4);
    await api.importMedia(ctx, { paths: [clip] });
    await api.edit(ctx, { ops: ['add v1 0 4'], ratio: '9:16' });
    await api.compile(ctx, {
      kind: 'explainer_card',
      platform: 'reels',
      theme: 'dark',
      motion: 'editorial',
      badge: 'SYNTHETIC DEMO',
      title: 'Local Compilation Offloads Agent Work',
      subtitle: 'Measured wrapping, safe zones, and keyframe timing run deterministically in Node + Skia.',
      at: 0,
      duration: 3.5,
    });
  }));

  // 2. Animated product demonstration
  results.push(await runDemo('02-product-demo', async (ctx, projDir) => {
    const clip = path.join(projDir, 'bg.mp4');
    const shot = path.join(projDir, 'ui-mockup.png');
    await makeSyntheticClip(clip, '#0F172A', 4, 960, 540);
    await makeSyntheticProductScreenshot(shot);
    await api.importMedia(ctx, { paths: [clip, shot] });
    await api.edit(ctx, { ops: ['add v1 0 4'], ratio: '16:9' });
    await api.compile(ctx, {
      kind: 'product_demo',
      platform: 'youtube',
      theme: 'slate',
      motion: 'dynamic',
      badge: 'SYNTHETIC UI',
      title: 'FRAME Timeline Inspector',
      asset: 'i1',
      at: 0,
      duration: 3.5,
    });
  }));

  // 3. Sports statistics and highlight overlay
  results.push(await runDemo('03-sports-stats', async (ctx, projDir) => {
    const clip = path.join(projDir, 'highlight.mp4');
    await makeSyntheticClip(clip, '#064E3B', 4);
    await api.importMedia(ctx, { paths: [clip] });
    await api.edit(ctx, { ops: ['add v1 0 4'], ratio: '9:16' });
    await api.compile(ctx, {
      kind: 'sports_stat',
      platform: 'shorts',
      theme: 'emerald',
      motion: 'dynamic',
      badge: 'SYNTHETIC STATS',
      title: 'Second Half Telemetry',
      chart: {
        chartType: 'hbar',
        data: [
          { label: 'Possession', value: 64, color: '#34D399' },
          { label: 'Pass Acc', value: 89, color: '#38BDF8' },
          { label: 'Press', value: 76, color: '#FBBF24' },
        ],
        max: 100,
        unit: '%',
      },
      at: 0,
      duration: 3.5,
    });
  }));

  // 4. Educational diagram animation
  results.push(await runDemo('04-educational-diagram', async (ctx, projDir) => {
    const clip = path.join(projDir, 'lesson.mp4');
    await makeSyntheticClip(clip, '#1E1B4B', 4);
    await api.importMedia(ctx, { paths: [clip] });
    await api.edit(ctx, { ops: ['add v1 0 4'], ratio: '9:16' });
    await api.compile(ctx, {
      kind: 'diagram',
      platform: 'reels',
      theme: 'slate',
      motion: 'editorial',
      badge: 'SYNTHETIC DIAGRAM',
      title: 'Three-Stage Render Pipeline',
      steps: ['Compile declarative intent locally', 'Rasterize Skia Canvas layers', 'Verify streams & safe zones'],
      at: 0,
      duration: 3.5,
    });
  }));

  // 5. Talking-head reel with captions and supporting visuals
  results.push(await runDemo('05-talking-head-captions', async (ctx, projDir) => {
    const clip = path.join(projDir, 'presenter.mp4');
    const subs = path.join(projDir, 'speech.json');
    await makeSyntheticClip(clip, '#1F2937', 4);
    await fsp.writeFile(subs, JSON.stringify({
      lang: 'en',
      words: [
        { w: 'Every', s: 0.1, e: 0.4 },
        { w: 'caption', s: 0.4, e: 0.8 },
        { w: 'stays', s: 0.8, e: 1.1 },
        { w: 'clear', s: 1.1, e: 1.5 },
        { w: 'of', s: 1.5, e: 1.7 },
        { w: 'graphics.', s: 1.7, e: 2.3 },
      ],
    }));
    await api.importMedia(ctx, { paths: [clip] });
    await api.transcribe(ctx, { asset: 'v1', engine: 'import', file: subs });
    await api.edit(ctx, { ops: ['add v1 0 4', 'captions kinetic'], ratio: '9:16' });
    await api.compile(ctx, {
      kind: 'talking_head_callout',
      platform: 'reels',
      theme: 'dark',
      motion: 'restrained',
      badge: 'SYNTHETIC PRESENTER',
      title: 'Zero-Reflow Captions',
      subtitle: 'Active-word emphasis without horizontal line jitter.',
      reservePresenter: { x: 0.5, y: 0.55, w: 0.7, h: 0.2 },
      at: 0,
      duration: 3.5,
    });
  }));

  const report = { generatedAt: new Date().toISOString(), syntheticNote: 'All media and telemetry in these 5 demos are synthetic fixtures for deterministic verification.', demos: results };
  await fsp.writeFile(path.resolve('examples/phase-2-demos/qa-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fsp.rm(workRoot, { recursive: true, force: true });
}
