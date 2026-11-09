/** Phase 2.4B: focused gfx fx tests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { emptyTimeline, newClip, layout, applyOps, parseKeys, type FxTransform } from '../../core/src/index.ts';
import { compileAss } from '../../motion/src/compile.ts';
import { AssDoc } from '../../motion/src/ass.ts';
import { planUnits, unitArgs, type GfxOverlay } from '../src/graph.ts';

const W = 64, H = 64, FPS = 10;
const hasFFmpeg = spawnSync('ffmpeg', ['-filters']).stdout.toString().includes('subtitles');
const ctx = { transcripts: {}, assets: { v1: { dur: 4, kind: 'video' } }, presets: ['title'] };

test('fx addresses graphics gN, while no-target fx stays main-track only', () => {
  const tl = emptyTimeline('1:1', FPS);
  tl.clips.push(newClip(tl, 'v1', 0, 3));
  const created = applyOps(tl, ['gfx title 0.5 1.5 props.text="HELLO"'], ctx).tl;
  const id = created.gfx[0]!.id;
  const edited = applyOps(created, ['fx zoomin ' + id + ' amt=0.2', 'fx kf ' + id + ' keys="0:o=0;1:o=1"'], ctx).tl;
  assert.equal(edited.gfx[0]!.fx!.length, 2);
  assert.equal((edited.gfx[0]!.fx![0] as FxTransform).keys[1]!.t, 1.5);
  assert.equal(edited.clips[0]!.fx, undefined);
  assert.equal(created.gfx[0]!.fx, undefined);
  const defaulted = applyOps(edited, ['fx panleft'], ctx).tl;
  assert.equal(defaulted.clips[0]!.fx!.length, 1);
  assert.equal(defaulted.gfx[0]!.fx!.length, 2);
  assert.equal(applyOps(defaulted, ['fx clear ' + id], ctx).tl.gfx[0]!.fx, undefined);
});

test('ASS compiler isolates effect-enabled preset but keeps ordinary graphics', () => {
  const tl = emptyTimeline('1:1', FPS);
  tl.clips.push(newClip(tl, 'v1', 0, 3));
  tl.gfx.push({ id: 'g1', preset: 'title', ref: { at: 0.2 }, d: 1.5, props: { text: 'NORMAL' } });
  tl.gfx.push({ id: 'g2', preset: 'title', ref: { at: 0.5 }, d: 1.5, props: { text: 'EFFECTED' }, fx: [{ type: 'kf', keys: parseKeys('0:o=0;1:o=1') }] });
  const c = compileAss(tl, [], layout(tl));
  assert.equal(c.layers.length, 1);
  assert.equal(c.layers[0]!.id, 'g2');
  assert.equal(c.layers[0]!.at, 0.5);
  assert.ok(c.layers[0]!.ass.includes('EFFECTED'));
  assert.ok(!c.ass.includes('EFFECTED'));
  assert.ok(c.ass.includes('NORMAL'));
});

test('graphs resume local graphic keyframes across independent units', () => {
  const tl = emptyTimeline('1:1', FPS);
  tl.settings.w = W; tl.settings.h = H;
  tl.clips.push(newClip(tl, 'v1', 0, 1), newClip(tl, 'v1', 1, 2));
  const placed = layout(tl), units = planUnits(placed);
  const media = { v1: { path: 'v1.mp4', kind: 'video' as const, hash: 'h', audio: false, dur: 2 } };
  const overlays: GfxOverlay[] = [{ file: 'fxg0.ass', at: 0.5, d: 1, fx: [{ type: 'kf', keys: parseKeys('0:o=0;1:o=1,e=linear') }] }];
  const enc = { vcodec: 'libx264', preset: 'ultrafast', crf: 30, scale: 1 };
  const first = unitArgs(tl, units[0]!, media, enc, placed, 'o.mp4', undefined, undefined, overlays).graph;
  const second = unitArgs(tl, units[1]!, media, enc, placed, 'o.mp4', undefined, undefined, overlays).graph;
  assert.ok(first.includes('subtitles=filename=fxg0.ass:alpha=1'));
  assert.ok(first.includes('overlay=eof_action=pass'));
  assert.ok(second.includes('setpts=PTS-STARTPTS+0.5/TB,subtitles=filename=fxg0.ass'));
  assert.ok(second.includes('T+0.5'));
  assert.ok(!unitArgs(tl, units[0]!, media, enc, placed, 'o.mp4', undefined, undefined).graph.includes('fxg0.ass'));
});

test('ffmpeg 64px: graphics mask and opacity preserve underlying blue video', { skip: !hasFFmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmep-gfx-fx-'));
  try {
    const ass = new AssDoc(W, H);
    ass.style({ name: 'Draw', font: 'DejaVu Sans', size: 12, color: '#FFFFFF', outlineW: 0, shadow: 0 });
    ass.add({ start: 0, end: 1, style: 'Draw', layer: 2,
      text: '{\\an7\\pos(8,8)\\p1\\bord0\\shad0\\1c&HFFFFFF&}m 0 0 l 40 0 l 40 40 l 0 40{\\p0}' });
    fs.writeFileSync(path.join(dir, 'fxg0.ass'), ass.toString());
    const src = path.join(dir, 'blue.mkv');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=1', '-c:v', 'ffv1', src]);
    assert.equal(made.status, 0, made.stderr.toString());
    const tl = emptyTimeline('1:1', FPS);
    tl.settings.w = W; tl.settings.h = H;
    tl.clips.push(newClip(tl, 'v1', 0, 1));
    const placed = layout(tl), unit = planUnits(placed)[0]!;
    const fx: GfxOverlay[] = [{ file: 'fxg0.ass', at: 0, d: 1, fx: [
      { type: 'kf', keys: parseKeys('0:o=0.5') },
      { type: 'mask', shape: 'rect', x: 0.3, y: 0.5, w: 0.6, h: 1, feather: 0, invert: false },
    ] }];
    const media = { v1: { path: src, kind: 'video' as const, hash: 'a', audio: false, dur: 1 } };
    const g = unitArgs(tl, unit, media, { vcodec: 'libx264', preset: 'ultrafast', crf: 30, scale: 1 }, placed, 'o.mp4', undefined, undefined, fx).graph;
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', src, '-filter_complex', g, '-map', '[vout]',
      '-frames:v', '10', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { cwd: dir, maxBuffer: 1 << 22 });
    assert.equal(raw.status, 0, raw.stderr.toString());
    assert.equal(raw.stdout.length, W * H * 3 * FPS);
    const px = (x: number, y: number) => {
      const i = (y * W + x) * 3;
      return [raw.stdout[i]!, raw.stdout[i + 1]!, raw.stdout[i + 2]!];
    };
    const inside = px(20, 20), outside = px(50, 20);
    assert.ok(inside[0]! > 60 && inside[0]! < 200, 'inside graphic should be half-opacity: ' + inside);
    assert.ok(outside[2]! > 165 && outside[0]! < 50, 'outside mask should be original blue: ' + outside);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
