/**
 * End-to-end: synthetic speech footage -> import -> transcript -> plan (reel) -> render
 * preview + final -> verify with ffprobe and pixel checks -> edit -> partial re-render.
 * Requires FFmpeg with libass/libx264 on PATH; skipped otherwise.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { makeFixture, type Fixture } from './fixtures.ts';
import * as api from '../packages/engine/src/api.ts';
import { ffmpegInfo, probe } from '../packages/media/src/ffmpeg.ts';
import { runBinary } from '../packages/media/src/exec.ts';
import { Project, layout, timelineWords, duration } from '../packages/core/src/index.ts';
import { compileAss } from '../packages/motion/src/compile.ts';
import { displayWord } from '../packages/motion/src/captions.ts';

let fx: Fixture;
let ctx: api.Ctx;
let skip: string | undefined;

before(async () => {
  try {
    const info = await ffmpegInfo();
    if (!info.filters.has('subtitles') || !info.encoders.has('libx264')) skip = 'ffmpeg lacks libass/libx264';
  } catch {
    skip = 'ffmpeg not installed';
  }
  if (skip) return;
  fx = await makeFixture(path.join(os.tmpdir(), 'tmep-e2e-fixture'));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tmep-e2e-'));
  ctx = { project: dir, detail: 'standard' };
});

/** Count bright (text) pixels in a horizontal band of a frame. */
async function brightPixels(video: string, t: number, y0: number, y1: number, alpha = false): Promise<number> {
  const v = await probe(video);
  const W = v.w!;
  const H = v.h!;
  const vf = alpha ? `alphaextract,format=gray` : 'format=gray';
  const raw = await runBinary((await ffmpegInfo()).ffmpeg, ['-v', 'error', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-']);
  let n = 0;
  for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++) for (let x = 0; x < W; x++) if (raw[y * W + x]! > 200) n++;
  return n;
}

test('end-to-end reel: plan, render, verify, edit, cache', { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const imp = await api.importMedia(ctx, { paths: [fx.video] });
  assert.equal((imp.assets as { id: string }[])[0]!.id, 'v1');
  const again = await api.importMedia(ctx, { paths: [fx.video] });
  assert.equal((again.assets as { existed?: boolean }[])[0]!.existed, true, 'same content keeps id');

  const tr = await api.transcribe(ctx, { asset: 'v1', file: fx.truth });
  assert.equal(tr.words, fx.words.length);
  const tr2 = await api.transcribe(ctx, { asset: 'v1', file: fx.truth });
  assert.equal(tr2.cached, true, 'transcript reused from cache');

  const plan = await api.plan(ctx, { template: 'reel', target: 20, title: 'AI video in 20s' });
  assert.ok((plan.dur as number) > 10 && (plan.dur as number) <= 21, `dur ${plan.dur}`);
  const gfx = plan.gfx as Record<string, number>;
  for (const k of ['icons', 'stat', 'title', 'cta']) assert.ok(gfx[k], `storytelling produced ${k}: ${JSON.stringify(gfx)}`);

  // caption sync: every kept word is on screen in an event active at the word's midpoint
  const p = await Project.open(ctx.project);
  const tl = await p.timeline();
  const words = timelineWords(tl, await api.transcriptsFor(p, ['v1']), layout(tl));
  assert.ok(!words.some((w) => /^um/i.test(w.w)), 'filler removed');
  const ass = compileAss(tl, words).ass;
  const events = ass
    .split('\n')
    .filter((l) => l.startsWith('Dialogue: 2,'))
    .map((l) => {
      const [, s, e] = l.split(',');
      const sec = (x: string) => x.split(':').reduce((a, v) => a * 60 + Number(v), 0);
      return { s: sec(s!), e: sec(e!), text: l };
    });
  for (const w of words) {
    const mid = (w.s + w.e) / 2;
    const shown = events.filter((e) => e.s <= mid + 0.011 && e.e >= mid - 0.011);
    assert.ok(shown.some((e) => e.text.includes(displayWord(w.w, tl.captions))), `word "${w.w}" visible at ${mid.toFixed(2)}`);
  }

  // preview render
  const prev = await api.render(ctx, { preview: true, wait: 600 });
  assert.equal(prev.state, 'done', JSON.stringify(prev));
  assert.equal(prev.size, '540x960');
  const prevFile = path.join(ctx.project, String(prev.out));
  const pv = await probe(prevFile);
  assert.ok(Math.abs(pv.dur - duration(tl)) < 0.1 && pv.audio);

  // final render: exact geometry, duration, audio, burned-in captions
  const fin = await api.render(ctx, { wait: 600 });
  assert.equal(fin.state, 'done', JSON.stringify(fin));
  const finFile = path.join(ctx.project, String(fin.out));
  const fv = await probe(finFile);
  assert.equal(fv.w, 1080);
  assert.equal(fv.h, 1920);
  assert.ok(Math.abs(fv.dur - duration(tl)) < 2 / 30 + 0.05, `duration ${fv.dur} vs ${duration(tl)}`);
  const midWord = words[Math.floor(words.length / 2)]!;
  const lit = await brightPixels(finFile, (midWord.s + midWord.e) / 2, 0.62, 0.78);
  assert.ok(lit > 800, `caption pixels in band: ${lit}`);

  // loudness normalized near -14 LUFS (single-pass loudnorm on short speech: allow +-3 LU)
  const { measureLoudness } = await import('../packages/media/src/ffmpeg.ts');
  const loud = await measureLoudness(finFile);
  assert.ok(Math.abs(loud.lufs + 14) < 3, `loudness ${loud.lufs}`);

  // re-render same revision: whole-output cache hit
  const hit = await api.render({ ...ctx, detail: 'debug' }, { wait: 600 });
  assert.equal((hit.result as { cacheHit: boolean }).cacheHit, true);

  // edit late in the timeline -> earlier units are reused
  const lastWord = words[words.length - 2]!;
  const ed = await api.edit(ctx, { ops: [`zoom ${lastWord.s.toFixed(2)} to=1.2`] });
  assert.equal(ed.rev, 2);
  const re = await api.render(ctx, { wait: 600 });
  assert.equal(re.state, 'done');
  assert.ok((re.cached as number) >= 1 && (re.cached as number) < (re.units as number), `units cached ${re.cached}/${re.units}`);

  // segment preview of a 3s range
  const seg = await api.render(ctx, { preview: true, range: [2, 5], wait: 600 });
  assert.equal(seg.state, 'done');
  const span = seg.span as [number, number];
  assert.ok(span[0] <= 2 && span[1] >= 5);

  // graphics-only alpha overlay: captions present in alpha channel
  const ov = await api.render(ctx, { alpha: true, wait: 600 });
  assert.equal(ov.state, 'done', JSON.stringify(ov));
  const ovFile = path.join(ctx.project, String(ov.out));
  const alphaLit = await brightPixels(ovFile, (midWord.s + midWord.e) / 2, 0.62, 0.78, true);
  assert.ok(alphaLit > 800, `alpha caption pixels: ${alphaLit}`);

  // undo restores previous revision
  const un = await api.edit(ctx, { undo: 1 });
  assert.equal(un.rev, 1);
});

test('render jobs can be cancelled', { timeout: 300_000 }, async (t) => {
  if (skip) return t.skip(skip);
  await api.edit(ctx, { ops: ['captions karaoke'] });
  const r = await api.render(ctx, { quality: 'high', wait: 0 });
  const s = await api.status(ctx, { job: String(r.job), cancel: true });
  assert.ok(['cancelled', 'done'].includes(String(s.state)), JSON.stringify(s));
});

test('b-roll cutaway, image asset, ducked music bed, SFX, 16:9 template', { timeout: 300_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tmep-e2e-media-'));
  const c2: api.Ctx = { project: dir, detail: 'standard' };
  const { ffmpeg } = await import('../packages/media/src/ffmpeg.ts');
  // generated (license-free) assets: a cutaway clip, a still image, and a music bed
  const broll = path.join(dir, 'cutaway.mp4');
  const still = path.join(dir, 'still.png');
  const music = path.join(dir, 'music.m4a');
  await ffmpeg({ args: ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', broll] });
  await ffmpeg({ args: ['-f', 'lavfi', '-i', 'color=c=0x3355aa:s=800x800', '-frames:v', '1', still] });
  await ffmpeg({ args: ['-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*220*t)+0.15*sin(2*PI*277*t)+0.12*sin(2*PI*330*t):s=48000:d=12', '-c:a', 'aac', music] });
  const imp = await api.importMedia(c2, { paths: [fx.video, broll, still, music] });
  assert.deepEqual((imp.assets as { id: string }[]).map((a) => a.id), ['v1', 'v2', 'i1', 'a1']);
  await api.transcribe(c2, { asset: 'v1', file: fx.truth });
  const plan = await api.plan(c2, { template: 'talking_head', music: 'a1' });
  assert.equal(plan.ratio, '16:9');
  const ed = await api.edit(c2, { ops: ['broll v2 @generative ai can d=2.5', 'broll i1 @record d=1.5', 'sfx whoosh @record', 'gfx lower_third 0.5 props.name=Pooja props.role=Creator'] });
  assert.equal((ed.ids as string[]).length, 4);
  const r = await api.render(c2, { preview: true, wait: 600, frames: 4 });
  assert.equal(r.state, 'done', JSON.stringify(r));
  const v = await probe(path.join(dir, String(r.out)));
  assert.equal(v.w, 960);
  assert.ok(v.audio);
  await fsp.rm(dir, { recursive: true, force: true });
});
