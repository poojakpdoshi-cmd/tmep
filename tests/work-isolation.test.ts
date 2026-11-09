/**
 * Cross-process work-file safety (Stabilization A2).
 *
 * Several Node processes render the SAME project at the same moment with real graphics
 * (shared-ASS and independent z-layer graphics), kinetic captions and a custom font loaded
 * from TMEP_FONTS_DIR. Every render must succeed, every output must decode to the same frames
 * as a single-process reference render (a partially read ASS or font file would change the
 * pixels or fail the job), and no temporary or per-render work files may be left behind.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as api from '../packages/engine/src/api.ts';
import { ffmpegInfo } from '../packages/media/src/ffmpeg.ts';
import { resolveFont, readFontFace, resetFontIndex } from '../packages/motion/src/fonts.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'reliability-child.ts');
const FIX = path.join(os.tmpdir(), 'tmep-reliability-fixture');
const N = 4;
const ROUNDS = 3;
let skip: string | undefined;
let fontDir = '';
let fontName = '';

before(async () => {
  try {
    const info = await ffmpegInfo();
    if (!info.encoders.has('libx264') || !info.filters.has('subtitles')) skip = 'ffmpeg lacks libx264/libass';
  } catch {
    skip = 'ffmpeg not installed';
  }
  if (skip) return;
  mkdirSync(FIX, { recursive: true });
  const ff = (args: string[]) => assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]).status, 0);
  if (!existsSync(path.join(FIX, 'clip.mp4'))) {
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3:sample_rate=48000', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(FIX, 'clip.mp4')]);
  }
  // Custom font: a copy of an installed regular face under a new file name in TMEP_FONTS_DIR,
  // which is searched before system folders, so captions resolve to OUR copy.
  const sys = resolveFont('regular');
  if (!sys.file) {
    skip = 'no installed font to copy';
    return;
  }
  fontDir = mkdtempSync(path.join(os.tmpdir(), 'tmep-custom-fonts-'));
  const copy = path.join(fontDir, `tmep-custom-font${path.extname(sys.file)}`);
  copyFileSync(sys.file, copy);
  fontName = readFontFace(copy)!.full;
  process.env.TMEP_FONTS_DIR = fontDir;
  process.env.TMEP_TEST_FONT_NAME = fontName;
  resetFontIndex();
});

function child(args: string[]): Promise<{ code: number | null; stderr: string; result?: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      resolve({ code, stderr: err, result: line ? JSON.parse(line.slice(7)) : undefined });
    });
  });
}

async function graphicsProject(): Promise<api.Ctx> {
  const ctx: api.Ctx = { project: mkdtempSync(path.join(os.tmpdir(), 'tmep-a2-')), detail: 'standard' };
  await api.importMedia(ctx, { paths: [path.join(FIX, 'clip.mp4')] });
  const words = ['cross', 'process', 'renders', 'share', 'nothing', 'mutable', 'at', 'all', 'now'].map((w, i) => ({ w, s: 0.1 + i * 0.32, e: 0.36 + i * 0.32 }));
  const tr = path.join(ctx.project, 'words.json');
  writeFileSync(tr, JSON.stringify({ words }));
  await api.transcribe(ctx, { asset: 'v1', file: tr });
  await api.edit(ctx, {
    ops: [
      { op: 'format', ratio: '9:16' },
      { op: 'keep', src: 'v1', ranges: [[0, 1.4], [1.5, 2.9]] },
      { op: 'captions', font: fontName },
      { op: 'gfx', preset: 'title', at: 0.2, d: 2, props: { text: 'SHARED ASS' } },
      { op: 'gfx', preset: 'keyword', at: 0.8, d: 1.2, props: { text: 'LAYER' }, z: 3 },
      { op: 'gfx', preset: 'cta', at: 1.6, d: 1, props: { text: 'GO' }, z: 5 },
    ],
  });
  return ctx;
}

const md5 = (f: string) => spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-f', 'md5', '-'], { encoding: 'utf8' }).stdout.trim();
const amd5 = (f: string) => spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:a', '-f', 'md5', '-'], { encoding: 'utf8' }).stdout.trim();
const listAll = (d: string) => (existsSync(d) ? (readdirSync(d, { recursive: true }) as string[]).map(String) : []);

test('simultaneous renders of one project with graphics + custom font: no collisions, identical output, nothing left behind', { timeout: 900_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const projects: string[] = [];
  const outputs: string[] = [];
  // a few rounds, each a fresh project rendered by N processes released together
  for (let round = 0; round < ROUNDS; round++) {
    const ctx = await graphicsProject();
    projects.push(ctx.project);
    const barrier = path.join(ctx.project, 'go');
    const kids = Array.from({ length: N }, (_, k) => child(['render-shared', FIX, ctx.project, `renders/p${k}.mp4`, barrier]));
    await new Promise((r) => setTimeout(r, 1500)); // all children loaded and waiting on the barrier
    writeFileSync(barrier, '');
    const runs = await Promise.all(kids);
    // 1. every process survived and every job succeeded (EBUSY etc. would surface here)
    for (const [k, r] of runs.entries()) {
      assert.equal(r.code, 0, `round ${round} child ${k} crashed:\n${r.stderr.slice(-1500)}`);
      const job = r.result!.job as { state: string; err?: unknown; out: string };
      assert.equal(job.state, 'done', `round ${round} child ${k}: ${JSON.stringify(job.err)}`);
      assert.equal(path.dirname(r.result!.fontFile as string), fontDir, 'custom font resolved from TMEP_FONTS_DIR');
      outputs.push(job.out);
    }
  }

  // 2. no partial reads: every output equals a single-process reference render of an identical project
  const ref = await graphicsProject();
  projects.push(ref.project);
  const rr = (await api.render(ref, { wait: 600 })) as Record<string, unknown>;
  assert.equal(rr.state, 'done', JSON.stringify(rr.err));
  const refOut = path.resolve(ref.project, rr.out as string);
  const want = { v: md5(refOut), a: amd5(refOut) };
  for (const o of outputs) assert.deepEqual({ v: md5(o), a: amd5(o) }, want, `${o} differs from the reference render`);

  // 3. cleanup: no temporary files and no per-render work files left in any project
  for (const p of projects) {
    assert.deepEqual(listAll(p).filter((f) => f.includes('.tmp')), [], `temporary files left in ${p}`);
    assert.deepEqual(listAll(path.join(p, '.tmep', 'work')), [], `work files left in ${p}`);
  }
});
