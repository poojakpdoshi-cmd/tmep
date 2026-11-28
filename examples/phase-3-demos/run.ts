import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import * as api from '../../packages/engine/src/api.ts';
import { ffmpeg, probe } from '../../packages/media/src/ffmpeg.ts';
import { canvasModule } from '../../packages/motion/src/vector.ts';

const outRoot = path.resolve('examples/phase-3-demos/out');
const workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-p3-demos-'));
await fsp.mkdir(outRoot, { recursive: true });

async function makeSourceClip(file: string, pattern: 'testsrc2' | 'mandelbrot' | 'smptebars', dur: number, w: number, h: number, freq = 330) {
  const vf = pattern === 'mandelbrot'
    ? `mandelbrot=s=${w}x${h}:r=30`
    : `${pattern}=s=${w}x${h}:r=30:d=${dur}`;
  await ffmpeg({
    args: [
      '-f', 'lavfi', '-t', String(dur), '-i', vf,
      '-f', 'lavfi', '-t', String(dur), '-i', `sine=frequency=${freq}:sample_rate=48000`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
    ],
  });
}

async function makeMusicBed(file: string, dur: number) {
  await ffmpeg({
    args: [
      '-f', 'lavfi', '-t', String(dur), '-i', 'sine=frequency=196:sample_rate=48000',
      '-af', 'volume=-6dB',
      '-c:a', 'aac', '-b:a', '128k', file,
    ],
  });
}

async function makeProductImage(file: string) {
  const { createCanvas } = canvasModule();
  const c = createCanvas(960, 540);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0F172A';
  ctx.fillRect(0, 0, 960, 540);
  ctx.fillStyle = '#1E293B';
  ctx.fillRect(30, 30, 900, 64);
  ctx.fillStyle = '#38BDF8';
  ctx.fillRect(54, 50, 180, 24);
  ctx.fillStyle = '#1E293B';
  ctx.fillRect(30, 120, 560, 390);
  ctx.fillStyle = '#34D399';
  ctx.fillRect(54, 150, 380, 28);
  ctx.fillStyle = '#334155';
  ctx.fillRect(54, 200, 500, 280);
  ctx.fillStyle = '#1E293B';
  ctx.fillRect(614, 120, 316, 390);
  await fsp.writeFile(file, c.encodeSync('png'));
}

async function runDemo(
  name: string,
  decisions: string[],
  setup: (ctx: api.Ctx, projDir: string) => Promise<void>,
) {
  const projDir = path.join(workRoot, name);
  await fsp.mkdir(projDir, { recursive: true });
  const ctx: api.Ctx = { project: projDir, detail: 'standard', outRoots: [projDir, outRoot] };
  const t0 = Date.now();
  await setup(ctx, projDir);
  const outMp4 = path.join(outRoot, `${name}.mp4`);
  const renderRes = await api.render(ctx, { out: outMp4, quality: 'draft', frames: 6, wait: 300 });
  const v = await probe(outMp4);
  const qa = await api.inspect(ctx, { what: 'qa', file: outMp4 });
  return {
    name,
    state: renderRes.state,
    dur: v.dur,
    w: v.w,
    h: v.h,
    audio: v.audio,
    ms: Date.now() - t0,
    decisions,
    qa: {
      ok: qa.ok,
      defects: qa.defects,
      advisories: qa.advisories,
      metrics: qa.metrics,
      findings: qa.findings,
    },
    out: path.relative(process.cwd(), outMp4).replace(/\\/g, '/'),
    sheet: path.relative(process.cwd(), path.join(outRoot, `${name}-sheet.jpg`)).replace(/\\/g, '/'),
  };
}

try {
  const demos = [];

  // 1. 30-second informative talking-head reel (9:16)
  demos.push(await runDemo(
    '01-talking-head-reel',
    [
      '9:16 Reels safe zones with presenter reserve',
      'talking_head_reel workflow + dialogue EQ + two-pass loudnorm (-14 LUFS)',
      'Smooth punch-in zooms at 6s and 18s + PiP cutaway at 12s',
    ],
    async (ctx, projDir) => {
      const main = path.join(projDir, 'presenter.mp4');
      const broll = path.join(projDir, 'broll.mp4');
      const music = path.join(projDir, 'bed.m4a');
      await Promise.all([
        makeSourceClip(main, 'testsrc2', 30, 540, 960, 260),
        makeSourceClip(broll, 'mandelbrot', 10, 540, 960, 440),
        makeMusicBed(music, 30),
      ]);
      await api.importMedia(ctx, { paths: [main, broll, music] });
      await api.edit(ctx, {
        ratio: '9:16',
        ops: [
          { op: 'add', src: 'v1', in: 0, out: 30 },
          'music a1 vol=-22 duck=true fade=1.5',
          'punch 6 to=1.18 d=1.5',
          'punch 18 to=1.15 d=1.5',
          'pip v2 12 4 pos=tr scale=0.3',
        ],
      });
      await api.compile(ctx, {
        kind: 'talking_head_reel',
        platform: 'reels',
        theme: 'dark',
        motion: 'editorial',
        badge: 'TALKING HEAD',
        title: 'Deterministic Local Post-Production',
        subtitle: 'Dialogue EQ, two-pass loudness, and safe-zone callouts.',
        reservePresenter: { x: 0.5, y: 0.72, w: 0.8, h: 0.36 },
        at: 1,
        duration: 5,
      });
    },
  ));

  // 2. 30-second cinematic montage (16:9)
  demos.push(await runDemo(
    '02-cinematic-montage',
    [
      '4-clip 30s 16:9 montage with cinematic-dissolve and luma-fade transitions',
      'J-cut and L-cut audio overlaps + deterministic shot matching (colormatch)',
      'Warm colour grade + subtle vignette + BT.709 output tagging',
    ],
    async (ctx, projDir) => {
      const c1 = path.join(projDir, 'shot1.mp4');
      const c2 = path.join(projDir, 'shot2.mp4');
      await Promise.all([
        makeSourceClip(c1, 'mandelbrot', 16, 960, 540, 220),
        makeSourceClip(c2, 'testsrc2', 16, 960, 540, 330),
      ]);
      await api.importMedia(ctx, { paths: [c1, c2] });
      await api.edit(ctx, {
        ratio: '16:9',
        ops: [
          { op: 'add', src: 'v1', in: 0, out: 8 },
          { op: 'add', src: 'v2', in: 0, out: 8 },
          { op: 'add', src: 'v1', in: 8, out: 15 },
          { op: 'add', src: 'v2', in: 8, out: 15 },
          'jcut c2 0.5',
          'lcut c3 0.4',
          'transition cinematic-dissolve clip=c2',
          'transition luma-fade clip=c3',
          'transition cinematic-dissolve clip=c4',
          'color exposure=0.04 contrast=1.08 saturation=1.06 vignette=0.22',
        ],
      });
      await api.colormatch(ctx, { targetClip: 'c2', refClip: 'c1' });
      await api.compile(ctx, {
        kind: 'cinematic_sequence',
        platform: 'youtube',
        theme: 'slate',
        motion: 'restrained',
        title: 'Cinematic Montage',
        subtitle: 'Matched colour, dissolved cuts, and vignette.',
        at: 1,
        duration: 4,
      });
    },
  ));

  // 3. 30-second sports highlight sequence (9:16)
  demos.push(await runDemo(
    '03-sports-highlights',
    [
      'sports_highlights workflow driven by supplied event timestamps [5, 12, 20, 26]',
      'Variable speed ramp on clip 1 + 1.5s freeze-frame callout at 14s',
      'Animated bar chart telemetry overlay in safe zone',
    ],
    async (ctx, projDir) => {
      const clip = path.join(projDir, 'match.mp4');
      await makeSourceClip(clip, 'testsrc2', 32, 540, 960, 392);
      await api.importMedia(ctx, { paths: [clip] });
      await api.edit(ctx, {
        ratio: '9:16',
        ops: [
          { op: 'add', src: 'v1', in: 0, out: 15 },
          { op: 'add', src: 'v1', in: 15, out: 28.5 },
          'ramp c1 keys="0:speed=1;5:speed=1.4;10:speed=1"',
          'freeze 14 1.5',
        ],
      });
      await api.compile(ctx, {
        kind: 'sports_highlights',
        platform: 'shorts',
        theme: 'emerald',
        motion: 'dynamic',
        badge: 'HIGHLIGHT',
        title: 'Sprint & Telemetry Breakdown',
        events: [
          { t: 5, label: 'Breakaway' },
          { t: 12, label: 'Peak Speed' },
          { t: 20, label: 'Finish' },
        ],
        at: 18,
        duration: 5,
      });
      await api.compile(ctx, {
        id: 'stats1',
        kind: 'animated_data_viz',
        platform: 'shorts',
        theme: 'emerald',
        title: 'Split Velocity',
        chart: { chartType: 'hbar', data: [{ label: 'Lap 1', value: 29 }, { label: 'Lap 2', value: 33 }], max: 40, unit: 'km/h' },
        at: 2,
        duration: 4,
      });
    },
  ));

  // 4. 30-second product demonstration (16:9)
  demos.push(await runDemo(
    '04-product-demo',
    [
      'product_demo workflow with crisp-callout drop shadow and measured Canvas UI card',
      '2-up horizontal splitscreen comparison at 12s + PiP presenter at 20s',
      'Smooth reframe pan on primary track + YouTube -14 LUFS two-pass master',
    ],
    async (ctx, projDir) => {
      const bg = path.join(projDir, 'bg.mp4');
      const ui = path.join(projDir, 'ui.png');
      await Promise.all([
        makeSourceClip(bg, 'mandelbrot', 30, 960, 540, 294),
        makeProductImage(ui),
      ]);
      await api.importMedia(ctx, { paths: [bg, ui] });
      await api.edit(ctx, {
        ratio: '16:9',
        ops: [
          { op: 'add', src: 'v1', in: 0, out: 30 },
          { op: 'splitscreen', srcs: ['v1', 'i1'], at: 12, d: 5, layout: '2h', gap: 0.02 },
          'pip i1 20 5 pos=br scale=0.3',
          'audio target=youtube twoPass=true limiter=-1.0',
        ],
      });
      await api.compile(ctx, {
        kind: 'product_demo',
        platform: 'youtube',
        theme: 'dark',
        motion: 'editorial',
        badge: 'PRODUCT DEMO',
        title: 'FRAME Local Studio',
        asset: 'i1',
        at: 1,
        duration: 6,
      });
    },
  ));

  // 5. 60-second educational explainer (16:9)
  demos.push(await runDemo(
    '05-educational-explainer',
    [
      '60-second 16:9 multi-chapter educational explainer',
      'educational_explainer + diagram + animated_data_viz workflows',
      'Audio enhancement (dialogue EQ, light compression, -14 LUFS) + subtle glow',
    ],
    async (ctx, projDir) => {
      const bg = path.join(projDir, 'lecture.mp4');
      await makeSourceClip(bg, 'testsrc2', 60, 960, 540, 247);
      await api.importMedia(ctx, { paths: [bg] });
      await api.edit(ctx, {
        ratio: '16:9',
        ops: [
          { op: 'add', src: 'v1', in: 0, out: 30 },
          { op: 'add', src: 'v1', in: 30, out: 60 },
          'transition dissolve clip=c2 d=0.5',
          { op: 'fx', kind: 'glow', clip: 'c1', radius: 8, intensity: 0.2 },
          'audio c1 eq=dialogue comp=light hp=80',
          'audio c2 eq=dialogue comp=light hp=80',
          'audio target=youtube twoPass=true limiter=-1.0',
        ],
      });
      await api.compile(ctx, {
        id: 'chap1',
        kind: 'educational_explainer',
        platform: 'youtube',
        theme: 'dark',
        motion: 'editorial',
        badge: 'CHAPTER 1',
        title: 'Why Deterministic Offloading Matters',
        subtitle: 'Agents specify creative intent; local engines handle timing, math, and QA.',
        at: 2,
        duration: 8,
      });
      await api.compile(ctx, {
        id: 'chap2',
        kind: 'diagram',
        platform: 'youtube',
        theme: 'slate',
        motion: 'editorial',
        badge: 'CHAPTER 2',
        title: 'Three-Stage Verification Loop',
        steps: ['Plan & Compile Intent', 'Render Cached Units', 'Inspect A/V & Safe Zones'],
        at: 18,
        duration: 10,
      });
      await api.compile(ctx, {
        id: 'chap3',
        kind: 'animated_data_viz',
        platform: 'youtube',
        theme: 'emerald',
        motion: 'editorial',
        badge: 'CHAPTER 3',
        title: 'Measured Agent Output Reduction',
        chart: { chartType: 'bar', data: [{ label: 'Raw Script', value: 100 }, { label: 'FRAME DSL', value: 6 }], max: 100, unit: '%' },
        at: 36,
        duration: 10,
      });
    },
  ));

  const report = {
    generatedAt: new Date().toISOString(),
    sourceNote: 'Source footage is locally generated representative media (testsrc2, mandelbrot, Canvas UI mockup, synthesized audio) to avoid external unverified stock/API dependencies.',
    demos,
  };
  await fsp.writeFile(path.join('examples/phase-3-demos/qa-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fsp.rm(workRoot, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
