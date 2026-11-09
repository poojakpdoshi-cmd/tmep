/**
 * Effects compiler: expression/unit checks plus a few tiny (64x64, 10 fps) FFmpeg runs that check
 * real pixels, so filter syntax and geometry are verified rather than assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { emptyTimeline, newClip, parseKeys, presetKeys, sampleKeys, validateMask, shiftFx, type Effect, type Clip, type FxMask } from '../../core/src/index.ts';
import { compileFx, keyExpr, opacitySchedule } from '../src/effects.ts';
import { unitArgs, planUnits } from '../src/graph.ts';
import { layout } from '../../core/src/index.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const S = 64;
const FPS = 10;
const BG = '#ff0000';

function clipWith(fx: Effect[]): Clip {
  const tl = emptyTimeline('1:1', FPS);
  const c = newClip(tl, 'v1', 0, 1);
  c.fx = fx;
  return c;
}

/** Render a white 64x64 1 s clip through the fx fragment; return RGB frames. */
function render(fx: Effect[]): Buffer[] {
  const frag = compileFx(clipWith(fx), S, S, FPS, BG, FPS, 't');
  assert.ok(frag);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=white:s=${S}x${S}:r=${FPS}:d=1`, '-filter_complex', `[0:v]${frag},format=rgb24[o]`, '-map', '[o]', '-frames:v', String(FPS), '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, r.stderr.toString());
  const sz = S * S * 3;
  assert.equal(r.stdout.length, sz * FPS, 'frame count');
  return Array.from({ length: FPS }, (_, i) => r.stdout.subarray(i * sz, (i + 1) * sz));
}
const px = (f: Buffer, x: number, y: number) => {
  const i = (y * S + x) * 3;
  return [f[i]!, f[i + 1]!, f[i + 2]!];
};
const isWhite = (p: number[]) => p.every((v) => v > 225);
const isBg = (p: number[]) => p[0]! > 200 && p[1]! < 40 && p[2]! < 40;

test('no effects -> no fragment, and unit graphs of old timelines are unchanged', () => {
  const tl = emptyTimeline('1:1', 30);
  tl.clips.push(newClip(tl, 'v1', 0, 2));
  assert.equal(compileFx(tl.clips[0]!, S, S, 30, BG, 60, 'x'), undefined);
  const placed = layout(tl);
  const u = planUnits(placed)[0]!;
  const media = { v1: { path: 'in.mp4', kind: 'video' as const, hash: 'h', audio: true, dur: 5 } };
  const { graph } = unitArgs(tl, u, media, { vcodec: 'libx264', preset: 'fast', crf: 18, scale: 1 }, placed, 'o.mp4', undefined, undefined);
  assert.ok(!/perspective|alphamerge|blend|geq/.test(graph));
  tl.clips[0]!.fx = [{ type: 'kf', keys: presetKeys('zoomin', 0, 1, 0.2, undefined) }];
  assert.ok(unitArgs(tl, u, media, { vcodec: 'libx264', preset: 'fast', crf: 18, scale: 1 }, placed, 'o.mp4', undefined, undefined).graph.includes('perspective'));
});

test('keyExpr mirrors sampleKeys structure; opacity schedule is deduplicated', () => {
  const keys = parseKeys('0:s=1;1:s=2,e=linear;2:s=2');
  const e = keyExpr(keys, 's', 'T')!;
  assert.equal((e.match(/if\(/g) ?? []).length, 2);
  assert.ok(e.includes('(1+1*clip((T-(0))/1,0,1))'));
  assert.equal(keyExpr(keys, 'o', 'T'), undefined);
  const sched = opacitySchedule([{ type: 'kf', keys: parseKeys('0:o=0;0.5:o=1,e=linear') }], 10, 10)!;
  assert.equal(sched[0]!.o, 0);
  assert.equal(sched[sched.length - 1]!.o, 1);
  assert.equal(sched.length, 6, 'constant tail collapsed');
  assert.equal(opacitySchedule([{ type: 'kf', keys: parseKeys('0:s=1.2') }], 10, 10), undefined);
});

test('ffmpeg: zoom-out uncovers the background, centre stays on image', { skip: !hasFfmpeg }, () => {
  const f = render([{ type: 'kf', keys: parseKeys('0:s=0.5') }]);
  assert.ok(isBg(px(f[0]!, 2, 2)), `corner ${px(f[0]!, 2, 2)}`);
  assert.ok(isWhite(px(f[0]!, 32, 32)));
  assert.ok(isBg(px(f[0]!, 32, 10)) && isWhite(px(f[0]!, 32, 20)), 'half-size image edge near 16px');
});

test('ffmpeg: translation and rotation', { skip: !hasFfmpeg }, () => {
  const moved = render([{ type: 'kf', keys: parseKeys('0:x=0.5') }])[0]!;
  assert.ok(isBg(px(moved, 10, 32)) && isWhite(px(moved, 50, 32)), 'shifted right by half a frame');
  const rot = render([{ type: 'kf', keys: parseKeys('0:r=45,s=0.7') }])[0]!;
  assert.ok(isBg(px(rot, 3, 3)) && isWhite(px(rot, 32, 32)) && isWhite(px(rot, 32, 8)), 'diamond: top-centre covered, corners not');
});

test('ffmpeg: keyframed opacity fades from background to image', { skip: !hasFfmpeg }, () => {
  const f = render([{ type: 'kf', keys: parseKeys('0:o=0;0.5:o=1,e=linear') }]);
  assert.ok(isBg(px(f[0]!, 32, 32)), `frame0 ${px(f[0]!, 32, 32)}`);
  const mid = px(f[2]!, 32, 32);
  assert.ok(mid[1]! > 60 && mid[1]! < 190, `partial at 0.2 s: ${mid}`);
  assert.ok(isWhite(px(f[7]!, 32, 32)));
});

test('ffmpeg: ellipse/rect/poly masks, feather, invert and intersection', { skip: !hasFfmpeg }, () => {
  const mk = (m: Partial<FxMask>): FxMask => validateMask({ type: 'mask', shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0, invert: false, ...m });
  const el = render([mk({})])[0]!;
  assert.ok(isWhite(px(el, 32, 32)) && isBg(px(el, 4, 32)) && isBg(px(el, 12, 12)), 'ellipse');
  const inv = render([mk({ invert: true })])[0]!;
  assert.ok(isBg(px(inv, 32, 32)) && isWhite(px(inv, 4, 4)), 'inverted');
  const soft = render([mk({ feather: 0.2 })])[0]!;
  const edge = px(soft, 32, 19);
  assert.ok(edge[1]! > 20 && edge[1]! < 235, `feathered edge ${edge}`);
  const tri = render([mk({ shape: 'poly', pts: [[0.1, 0.9], [0.5, 0.1], [0.9, 0.9]] })])[0]!;
  assert.ok(isWhite(px(tri, 32, 45)) && isBg(px(tri, 8, 10)) && isBg(px(tri, 56, 10)), 'triangle');
  const both = render([mk({ shape: 'rect', w: 1, h: 0.5 }), mk({ shape: 'rect', x: 0.25, w: 0.5, h: 1 })])[0]!;
  assert.ok(isWhite(px(both, 10, 32)) && isBg(px(both, 50, 32)) && isBg(px(both, 10, 5)), 'masks intersect');
});

test('ffmpeg: animated reveals (grow from centre, wipe from left)', { skip: !hasFfmpeg }, () => {
  const mk = (from: 'center' | 'left'): FxMask => ({ type: 'mask', shape: 'rect', x: 0.5, y: 0.5, w: 0.8, h: 0.8, feather: 0, invert: false, reveal: { at: 0.1, d: 0.5, e: 'linear', from } });
  const g = render([mk('center')]);
  assert.ok(isBg(px(g[0]!, 32, 32)), 'hidden before reveal');
  assert.ok(isWhite(px(g[4]!, 32, 32)) && isBg(px(g[4]!, 10, 32)), 'partly grown at 0.4 s');
  assert.ok(isWhite(px(g[9]!, 10, 32)), 'fully revealed');
  const w = render([mk('left')]);
  assert.ok(isWhite(px(w[4]!, 12, 32)) && isBg(px(w[4]!, 50, 32)), 'wipe progresses left to right');
  assert.ok(isWhite(px(w[9]!, 50, 32)));
});

test('ffmpeg: presets and masks compose on one clip', { skip: !hasFfmpeg }, () => {
  const keys = presetKeys('zoomout', 0, 1, 0.5, 'linear');
  assert.equal(sampleKeys(keys, 's', 0), 1.5);
  const f = render([{ type: 'kf', keys: parseKeys('0:s=0.6') }, { type: 'kf', keys: parseKeys('0:o=1') }, validateMask({ type: 'mask', shape: 'ellipse', x: 0.5, y: 0.5, w: 0.9, h: 0.9, feather: 0, invert: false })]);
  assert.ok(isWhite(px(f[0]!, 32, 32)) && isBg(px(f[0]!, 32, 4)));
});

test('ffmpeg: full unit graph with fit + zoom + fx renders the exact frame count', { skip: !hasFfmpeg }, async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmep-fx-'));
  const src = path.join(dir, 'in.mp4');
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=2', '-pix_fmt', 'yuv420p', src]).status, 0);
  const tl = emptyTimeline('9:16', 30);
  tl.clips.push(newClip(tl, 'v1', 0, 1), newClip(tl, 'v1', 1, 2));
  tl.clips[1]!.trans = { type: 'fade', d: 0.3 };
  tl.clips[0]!.zoom = [{ s: 0.2, d: 0.5, to: 1.2, mode: 'smooth' }];
  tl.clips[0]!.fx = [{ type: 'kf', keys: parseKeys('0:s=1,r=0,o=0;0.8:s=1.1,r=8,o=1,e=out') }];
  tl.clips[1]!.fx = [{ type: 'kf', keys: presetKeys('panleft', 0, 1, 0.2, undefined) }, validateMask({ type: 'mask', shape: 'ellipse', x: 0.5, y: 0.5, w: 0.8, h: 0.5, feather: 0.05, invert: false, reveal: { at: 0, d: 0.4, e: 'out', from: 'center' } })];
  const placed = layout(tl);
  const units = planUnits(placed);
  assert.equal(units.length, 1);
  const out = path.join(dir, 'u.mp4');
  const { args } = unitArgs(tl, units[0]!, { v1: { path: src, kind: 'video', hash: 'h', audio: false, dur: 2 } }, { vcodec: 'libx264', preset: 'ultrafast', crf: 30, scale: 0.25 }, placed, out, undefined, undefined);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  assert.equal(r.status, 0, r.stderr.toString());
  const n = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'csv=p=0', out]).stdout.toString().trim();
  assert.equal(n, `270,480,${units[0]!.frames}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ffmpeg: split-shifted effects (negative key/reveal times) render mid-animation at frame 0', { skip: !hasFfmpeg }, () => {
  const base: Effect[] = [{ type: 'kf', keys: parseKeys('0:o=0;1:o=1,e=linear') }, { type: 'mask', shape: 'rect', x: 0.5, y: 0.5, w: 1, h: 1, feather: 0, invert: false, reveal: { at: 0, d: 1, e: 'linear', from: 'left' } }];
  const f = render(shiftFx(base, 0.5)!)[0]!;
  const left = px(f, 12, 32);
  assert.ok(left[1]! > 90 && left[1]! < 165, `opacity ~0.5 continues: ${left}`);
  assert.ok(isBg(px(f, 52, 32)), 'wipe is half-way, right side still hidden');
});
