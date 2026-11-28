/**
 * Phase 4B footage intelligence through the public API: analysis of labelled synthetic footage,
 * content-addressed caching, incremental adapters, briefs, and footage-aware QA advisories.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as api from '../packages/engine/src/api.ts';
import { ffmpegInfo } from '../packages/media/src/ffmpeg.ts';

let dir: string;
let skip: string | undefined;
before(async () => {
  try { const info = await ffmpegInfo(); if (!info.encoders.has('libx264')) skip = 'ffmpeg lacks libx264'; } catch { skip = 'ffmpeg not installed'; }
  if (!skip) dir = mkdtempSync(path.join(os.tmpdir(), 'frame-footage-'));
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test('footage analysis finds labelled cuts and events, caches, layers adapters, briefs and feeds QA', { timeout: 240_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ff = (a: string[]) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a]); assert.equal(r.status, 0, String(r.stderr)); };
  // Three shots with hard cuts at 3 s and 6 s, a loud burst at 4.5 s and true silence 7.5–8.7 s.
  const parts = ['testsrc2=s=480x270:r=30', 'mandelbrot=s=480x270:r=30', 'smptehdbars=s=480x270:r=30,hue=h=t*60'].map((src, i) => {
    const f = path.join(dir, `p${i}.mp4`);
    ff(['-f', 'lavfi', '-i', `${src},format=yuv420p`, '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', f]);
    return f;
  });
  const file = path.join(dir, 'footage.mp4');
  ff([...parts.flatMap((p) => ['-i', p]), '-f', 'lavfi', '-i', "anoisesrc=d=9:c=pink:r=48000:a=0.04,volume='if(between(t,4.5,5.1),12,if(between(t,7.5,8.7),0,1))':eval=frame",
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a', '-t', '9', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  const proj = path.join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  const ctx = { project: proj, detail: 'debug' as const };
  await api.importMedia(ctx, { paths: [file] });

  const a = await api.inspect(ctx, { what: 'footage', asset: 'v1' }) as Record<string, any>;
  assert.equal(a.schema, 'frame.footage/1');
  assert.deepEqual(a.observed.shots.slice(1).map((s: { t0: number }) => Math.round(s.t0 * 10) / 10), [3, 6]);
  assert.ok(a.observed.silences.some((s: { t0: number; t1: number }) => s.t0 <= 7.6 && s.t1 >= 8.5), JSON.stringify(a.observed.silences));
  assert.ok(a.inferred.moments.some((m: { t: number }) => Math.abs(m.t - 4.8) <= 1), JSON.stringify(a.inferred.moments));
  assert.equal(a.capabilities.speech.status, 'unavailable', 'no speech is claimed without a transcript');
  assert.ok(a.provenance.length >= 2 && a.provenance.every((p: { version: string }) => p.version));

  // Cached on repeat (content-addressed), compact at standard detail.
  const again = await api.inspect({ project: proj, detail: 'standard' }, { what: 'footage', asset: 'v1' }) as Record<string, any>;
  assert.equal(again.cached, true);
  assert.equal(again.shots, 3);
  assert.ok(JSON.stringify(again).length < 1500, `standard summary is compact (${JSON.stringify(again).length} chars)`);

  // Adapters layer on the cached base; when a tool is missing it is reported, never guessed.
  const faces = await api.inspect(ctx, { what: 'footage', asset: 'v1', faces: true }) as Record<string, any>;
  if (faces.capabilities.faces.status === 'unavailable') assert.equal(faces.observed.faces, undefined);
  else assert.ok(Array.isArray(faces.observed.faces));
  assert.deepEqual(faces.observed.shots, a.observed.shots, 'base passes are reused');
  assert.ok(readdirSync(path.join(proj, '.tmep', 'cache', 'footage')).length >= 2);

  const brief = await api.inspect({ project: proj, detail: 'standard' }, { what: 'brief', asset: 'v1', task: 'sports' }) as Record<string, any>;
  assert.equal(brief.brief, 'frame.brief/1');
  assert.match(brief.note, /not recognized/);
  await assert.rejects(() => api.inspect(ctx, { what: 'brief', asset: 'v1', task: 'weddings' }), /unknown brief task/);

  // QA uses the cached analysis: the 4.8 s moment is outside an edit that keeps only 0–3 s.
  await api.edit(ctx, { ratio: '16:9', ops: [{ op: 'add', src: 'v1', in: 0, out: 3 }] });
  const qa = await api.inspect(ctx, { what: 'qa' }) as Record<string, any>;
  const missing = qa.findings.filter((f: { code: string }) => f.code === 'missing-moment');
  assert.equal(missing.length, 1, JSON.stringify(qa.findings));
});

test('presets compiled with footage keep clear of the analysed presenter region', { timeout: 240_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { Project } = await import('../packages/core/src/project.ts');
  const file = path.join(dir, 'talk.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30,format=yuv420p', '-f', 'lavfi', '-i', 'anoisesrc=d=4:c=pink:r=48000:a=0.05', '-t', '4', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', file]);
  assert.equal(r.status, 0);
  const proj = path.join(dir, 'talk');
  mkdirSync(proj, { recursive: true });
  const ctx = { project: proj, detail: 'standard' as const };
  await api.importMedia(ctx, { paths: [file] });
  await api.edit(ctx, { ratio: '9:16', ops: [{ op: 'add', src: 'v1', in: 0, out: 4 }] });
  await api.inspect(ctx, { what: 'footage', asset: 'v1' });
  // Face detection is optional; stand in for it by layering a presenter onto the real cached base record.
  const p = await Project.open(proj, { create: false });
  const k = await api.footageKeys(p, 'v1', { faces: true });
  const base = JSON.parse(readFileSync(p.cachePath('footage', `${k.base}.json`), 'utf8'));
  base.capabilities.faces = { status: 'ok', tool: 'test stand-in' };
  base.inferred.presenter = { x: 0.56, y: 0.6, w: 0.12, h: 0.45, confidence: 0.9, basis: 'test stand-in' };
  writeFileSync(p.cachePath('footage', `${k.layered}.json`), JSON.stringify(base));
  // Control: without footage the default lower third lands on the presenter and QA says so.
  await api.compile(ctx, { kind: 'lower_third', title: 'Dr. Ananya Rao', subtitle: 'Cardiologist', platform: 'reels', side: 'right' });
  const before = await api.inspect(ctx, { what: 'qa' }) as Record<string, any>;
  assert.ok(before.findings.some((f: { code: string }) => f.code === 'graphics-over-presenter'), `control: ${JSON.stringify(before.findings)}`);
  await api.edit(ctx, { undo: 1 });
  const res = await api.compile(ctx, { kind: 'lower_third', title: 'Dr. Ananya Rao', subtitle: 'Cardiologist', platform: 'reels', side: 'right', footage: 'v1' }) as Record<string, any>;
  assert.equal(res.ok, 1);
  assert.ok(res.corrections.some((c: { msg: string }) => /presenter region from v1/.test(c.msg)), JSON.stringify(res.corrections));
  const spec = res.ops[0].spec;
  const panel = spec.layers.find((l: { id: string }) => l.id === 'panel');
  const qa = await api.inspect(ctx, { what: 'qa' }) as Record<string, any>;
  assert.ok(!qa.findings.some((f: { code: string }) => f.code === 'graphics-over-presenter'), JSON.stringify(qa.findings));
  assert.ok(panel, 'lower third compiled');
});
