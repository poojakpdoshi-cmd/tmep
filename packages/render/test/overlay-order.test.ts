/** Layer z-order verified from graph topology and tiny decoded pixels. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { emptyTimeline, newClip, layout } from '../../core/src/timeline.ts';
import { compileAss } from '../../motion/src/compile.ts';
import { AssDoc } from '../../motion/src/ass.ts';
import { planUnits, unitArgs, type GfxOverlay } from '../src/graph.ts';

const FPS = 10, S = 64;
const enc = { vcodec: 'libx264', preset: 'ultrafast', crf: 30, scale: 1 };
const ff = spawnSync('ffmpeg', ['-filters']);
const hasSubtitles = ff.status === 0 && ff.stdout.toString().includes('subtitles');

const setup = () => {
  const tl = emptyTimeline('1:1', FPS);
  tl.settings.w = S; tl.settings.h = S;
  tl.clips.push(newClip(tl, 'v1', 0, 1));
  tl.broll.push({ id: 'b1', src: 'v2', in: 0, ref: { at: 0 }, d: 1, fit: 'cover' });
  const placed = layout(tl);
  const media = {
    v1: { path: 'blue.mkv', kind: 'video' as const, hash: 'blue', audio: false, dur: 1 },
    v2: { path: 'red.mkv', kind: 'video' as const, hash: 'red', audio: false, dur: 1 },
  };
  return { tl, placed, media };
};

test('legacy order is unchanged; explicit z sorts gfx and b-roll deterministically', () => {
  const { tl, placed, media } = setup();
  const gfx: GfxOverlay[] = [{ file: 'gfx0.ass', at: 0, d: 1, fx: [] }];
  const graph = () => unitArgs(tl, planUnits(placed)[0]!, media, enc, placed, 'out.mp4', undefined, undefined, gfx).graph;
  const old = graph();
  assert.ok(old.indexOf('][b0]overlay') < old.indexOf('][gfx0]overlay'), 'legacy b-roll below graphics');
  gfx[0]!.z = -5;
  const changed = graph();
  assert.ok(changed.indexOf('][gfx0]overlay') < changed.indexOf('][b0]overlay'), 'graphic below b-roll');
  tl.broll[0]!.z = -10;
  const moved = graph();
  assert.ok(moved.indexOf('][b0]overlay') < moved.indexOf('][gfx0]overlay'), 'b-roll below graphic');
});

test('explicit graphics z isolates a preset even without any fx; unlayered preset remains legacy ASS', () => {
  const { tl, placed } = setup();
  tl.gfx.push({ id: 'g1', preset: 'title', ref: { at: 0 }, d: 1, props: { text: 'LEGACY' } });
  tl.gfx.push({ id: 'g2', preset: 'title', ref: { at: 0 }, d: 1, props: { text: 'LAYERED' }, z: -5 });
  const compiled = compileAss(tl, [], placed);
  assert.ok(compiled.ass.includes('LEGACY'));
  assert.ok(!compiled.ass.includes('LAYERED'));
  assert.equal(compiled.layers.length, 1);
  assert.equal(compiled.layers[0]!.z, -5);
  assert.ok(compiled.layers[0]!.ass.includes('LAYERED'));
  assert.equal(compiled.layers[0]!.fx.length, 0);
});

test('64px FFmpeg: graphic visibly moves behind b-roll when z is lowered', { skip: !hasSubtitles }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmep-zorder-'));
  try {
    for (const c of ['blue', 'red']) {
      const p = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=' + c + ':s=64x64:r=10:d=1', '-c:v', 'ffv1', path.join(dir, c + '.mkv')]);
      assert.equal(p.status, 0, p.stderr.toString());
    }
    const ass = new AssDoc(S, S);
    ass.style({ name: 'Draw', font: 'DejaVu Sans', size: 12, color: '#FFFFFF', outlineW: 0, shadow: 0 });
    ass.add({ start: 0, end: 1, style: 'Draw', layer: 2, text: '{\\an7\\pos(8,8)\\p1\\bord0\\shad0\\1c&HFFFFFF&}m 0 0 l 40 0 l 40 40 l 0 40{\\p0}' });
    fs.writeFileSync(path.join(dir, 'gfx0.ass'), ass.toString());
    const { tl, placed, media } = setup();
    media.v1.path = path.join(dir, 'blue.mkv');
    media.v2.path = path.join(dir, 'red.mkv');
    const layer: GfxOverlay = { file: 'gfx0.ass', at: 0, d: 1, fx: [], z: 10 };
    const render = (z: number) => {
      layer.z = z;
      const { args, graph } = unitArgs(tl, planUnits(placed)[0]!, media, enc, placed, 'out.mp4', undefined, undefined, [layer]);
      const inputs = args.slice(0, args.indexOf('-filter_complex'));
      const raw = spawnSync('ffmpeg', ['-v', 'error', ...inputs, '-filter_complex', graph, '-map', '[vout]', '-frames:v', '10', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { cwd: dir, maxBuffer: 1 << 24 });
      assert.equal(raw.status, 0, raw.stderr.toString());
      assert.equal(raw.stdout.length, S * S * 3 * FPS);
      const at = (5 * S * S + 20 * S + 20) * 3;
      return [raw.stdout[at]!, raw.stdout[at + 1]!, raw.stdout[at + 2]!];
    };
    const above = render(10);
    const below = render(-10);
    assert.ok(above[0]! > 205 && above[1]! > 205 && above[2]! > 205, 'white graphic above red b-roll: ' + above);
    assert.ok(below[0]! > 160 && below[1]! < 80 && below[2]! < 80, 'red b-roll covers graphic: ' + below);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
