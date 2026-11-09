/** Tiny 64x64 FFmpeg frames verify alpha compositing. No trial reel rendering. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { emptyTimeline, newClip, layout, parseKeys, presetKeys, type Effect, type FxMask } from '../../core/src/index.ts';
import { compileOverlayFx } from '../src/effects.ts';
import { planUnits, unitArgs } from '../src/graph.ts';

const S = 64;
const FPS = 10;
const hasFFmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const px = (f: Buffer, x: number, y: number) => {
  const i = (y * S + x) * 3;
  return [f[i]!, f[i + 1]!, f[i + 2]!];
};
const blue = (p: number[]) => p[2]! > 200 && p[0]! < 45 && p[1]! < 45;
const white = (p: number[]) => p.every((v) => v > 215);
const mask = (extra: Partial<FxMask> = {}): FxMask => ({
  type: 'mask', shape: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 1,
  feather: 0, invert: false, ...extra,
});

/** An opaque white overlay, over a blue base. Return actual decoded RGB pixels. */
function render(fx: Effect[], timeOffset = 0, preserveInputAlpha = false): Buffer[] {
  const frag = compileOverlayFx(fx, S, S, FPS, FPS, 'b0', timeOffset);
  assert.ok(frag);
  const alpha = preserveInputAlpha ? ',format=rgba,colorchannelmixer=aa=0.5' : '';
  const filter = `[0:v]${alpha ? 'format=rgba' + alpha : 'format=yuva420p'},${frag}[fg];` +
    `color=c=blue:s=${S}x${S}:r=${FPS}:d=1[bg];` +
    '[bg][fg]overlay=shortest=1:format=auto,format=rgb24[o]';
  const p = spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `color=c=white:s=${S}x${S}:r=${FPS}:d=1`,
    '-filter_complex', filter, '-map', '[o]', '-frames:v', String(FPS), '-f', 'rawvideo', '-',
  ], { maxBuffer: 1 << 24 });
  assert.equal(p.status, 0, p.stderr.toString());
  assert.equal(p.stdout.length, S * S * 3 * FPS);
  const N = S * S * 3;
  return Array.from({ length: FPS }, (_, i) => p.stdout.subarray(i * N, (i + 1) * N));
}

test('b-roll fx omitted leaves legacy graph unchanged; present fx routes through alpha compositor', () => {
  const tl = emptyTimeline('1:1', 10);
  tl.clips.push(newClip(tl, 'v1', 0, 1));
  tl.broll.push({ id: 'b2', src: 'v2', in: 0, ref: { at: 0 }, d: 1, fit: 'cover' });
  const placed = layout(tl), u = planUnits(placed)[0]!;
  const media = {
    v1: { path: 'base.mp4', kind: 'video' as const, hash: 'a', audio: false, dur: 2 },
    v2: { path: 'overlay.mp4', kind: 'video' as const, hash: 'b', audio: false, dur: 2 },
  };
  const settings = { vcodec: 'libx264', preset: 'fast', crf: 22, scale: 64 / 1080 };
  const oldGraph = unitArgs(tl, u, media, settings, placed, 'out.mp4').graph;
  assert.ok(!oldGraph.includes('fxorigb0'));
  tl.broll[0]!.fx = [mask()];
  const newGraph = unitArgs(tl, u, media, settings, placed, 'out.mp4').graph;
  assert.ok(newGraph.includes('alphaextract') && newGraph.includes('fxorigb0'));
  assert.ok(newGraph.includes('blend=all_mode=multiply') && newGraph.includes('alphamerge'));
  assert.ok(newGraph.includes('overlay=eof_action=pass'));
});

test('ffmpeg: b-roll rectangle mask reveals underlying blue layer, not black', { skip: !hasFFmpeg }, () => {
  const f = render([mask()])[5]!;
  assert.ok(white(px(f, 32, 32)), String(px(f, 32, 32)));
  assert.ok(blue(px(f, 4, 32)), String(px(f, 4, 32)));
});

test('ffmpeg: alpha keyframes blend into the underlying layer', { skip: !hasFFmpeg }, () => {
  const f = render([{ type: 'kf', keys: parseKeys('0:o=0;1:o=1,e=linear') }]);
  assert.ok(blue(px(f[0]!, 32, 32)));
  const mid = px(f[5]!, 32, 32);
  assert.ok(mid[0]! > 90 && mid[0]! < 175 && mid[1]! > 90 && mid[1]! < 175, String(mid));
  assert.ok(white(px(f[9]!, 32, 32)) || px(f[9]!, 32, 32)[0]! > 210);
});

test('ffmpeg: zoom-out preserves alpha at uncovered frame edges', { skip: !hasFFmpeg }, () => {
  const f = render([{ type: 'kf', keys: parseKeys('0:s=0.5') }])[0]!;
  assert.ok(white(px(f, 32, 32)));
  assert.ok(blue(px(f, 2, 2)), `exposed corner must show base, got ${px(f, 2, 2)}`);
});

test('ffmpeg: overlay timing offset continues opacity and wipe across render units', { skip: !hasFFmpeg }, () => {
  const f = render([
    { type: 'kf', keys: parseKeys('0:o=0;1:o=1,e=linear') },
    mask({ w: 1, reveal: { at: 0, d: 1, e: 'linear', from: 'left' } }),
  ], 0.5)[0]!;
  const left = px(f, 12, 32), right = px(f, 52, 32);
  assert.ok(left[0]! > 90 && left[0]! < 175, String(left));
  assert.ok(blue(right), String(right));
});

test('ffmpeg: source alpha is multiplied by effect alpha, not overwritten', { skip: !hasFFmpeg }, () => {
  const f = render([mask({ w: 1, h: 1 })], 0, true)[4]!;
  const c = px(f, 32, 32);
  assert.ok(c[0]! > 85 && c[0]! < 175, `source alpha should remain ~0.5: ${c}`);
});
