/**
 * Deterministic frame rasterizer for Visual Scene `path` layers.
 *
 * Every frame is a pure function of (run spec, frame index, output size): sample the same
 * keyframe math as the validator and the FFmpeg transform filter, then paint with the
 * existing in-process Skia canvas (@napi-rs/canvas). No browser, clock or random state.
 */
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { sampleKeys, TmepError, type Ease, type Key } from '../../core/src/index.ts';

type Skia = typeof import('@napi-rs/canvas');
type Path2D = InstanceType<Skia['Path2D']>;
type Ctx = ReturnType<InstanceType<Skia['Canvas']>['getContext']>;

/** Bump when the drawing of an existing spec changes; it is part of the raster cache key. */
export const VECTOR_VERSION = 'v1';

export interface DrawKey { t: number; from?: number; to?: number; e?: Ease }
export interface VectorLayer {
  id: string;
  /** Active frames relative to the first frame of the run: [from, to). */
  from: number;
  to: number;
  /** Transform and opacity keys in active-layer seconds, identical to the FFmpeg `kf` effect of other layers. */
  keys: Key[];
  draw: DrawKey[];
  d: string;
  /** SVG viewBox size. The view is fitted uniformly and centred in the box. */
  view: [number, number];
  /** Layer box in reference pixels. */
  box: [number, number];
  /** Stroke width in reference pixels (0 = no stroke). */
  stroke: number;
  /** Blur radius of a stroke-coloured glow in reference pixels (0 = none). Not scaled by keys. */
  glow: number;
  color: string;
  fill?: string;
  cap: 'round' | 'butt' | 'square';
}
/** Consecutive path layers of one scene, drawn into one transparent frame sequence. */
export interface VectorRun {
  id: string;
  /** Timeline start and duration in seconds, frame-aligned. */
  at: number;
  d: number;
  frames: number;
  z: number;
  /** Reference frame size and rate. */
  w: number;
  h: number;
  fps: number;
  /** Camera keys in scene seconds, and the scene frame of the run's first frame. */
  camera: Key[];
  sceneFrame: number;
  layers: VectorLayer[];
}

const require = createRequire(import.meta.url);
let skia: Skia | undefined;
export function canvasModule(): Skia {
  if (skia) return skia;
  try {
    skia = require('@napi-rs/canvas') as Skia;
    return skia;
  } catch {
    throw new TmepError('E_INPUT', 'Visual Scene path layers require the existing @napi-rs/canvas dependency');
  }
}

/** Parse SVG path data with Skia and return its tight bounds in view units. Throws E_INPUT on invalid data. */
export function pathBounds(d: string): [number, number, number, number] {
  const { Path2D } = canvasModule();
  try {
    return new Path2D(d).computeTightBounds();
  } catch {
    throw new TmepError('E_INPUT', 'invalid SVG path data');
  }
}

/** Visible stroke interval [from, to] as fractions of total path length. Defaults: fully drawn. */
export function drawRange(draw: DrawKey[], t: number): [number, number] {
  if (!draw.length) return [0, 1];
  // Reuse the shared key sampler: `x` defaults to 0 (from) and `s` to 1 (to).
  const keys: Key[] = draw.map(({ t: kt, from, to, e }) => ({ t: kt, ...(e && { e }),
    ...(from !== undefined && { x: from }), ...(to !== undefined && { s: to }) }));
  return [sampleKeys(keys, 'x', t), sampleKeys(keys, 's', t)];
}

const sample = (keys: Key[], t: number) => ({ x: sampleKeys(keys, 'x', t), y: sampleKeys(keys, 'y', t),
  s: sampleKeys(keys, 's', t), r: sampleKeys(keys, 'r', t), o: sampleKeys(keys, 'o', t) });

/**
 * Paint frame `f` of a run. `scale` maps reference pixels to output pixels. Returns a state
 * signature: equal signatures always paint identical pixels, so callers may reuse a frame.
 */
export function drawVectorFrame(ctx: Ctx, run: VectorRun, f: number, scale: number, shapes: Path2D[]): string {
  const { Path2D } = canvasModule();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const cam = sample(run.camera, (run.sceneFrame + f) / run.fps);
  const state: number[] = [cam.x, cam.y, cam.s, cam.r];
  run.layers.forEach((layer, i) => {
    if (f < layer.from || f >= layer.to) return;
    const t = (f - layer.from) / run.fps;
    const a = sample(layer.keys, t);
    const [from, to] = drawRange(layer.draw, t);
    state.push(i, a.x, a.y, a.s, a.r, a.o, from, to);
    if (a.o <= 0) return;
    // Same composition as the validator and FFmpeg: layer rotate/scale about its centre, then
    // offset; the camera then rotates/zooms about the frame centre and offsets.
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.translate(run.w / 2 + cam.x * run.w, run.h / 2 + cam.y * run.h);
    ctx.rotate(cam.r * Math.PI / 180);
    ctx.scale(cam.s, cam.s);
    ctx.translate(a.x * run.w, a.y * run.h);
    ctx.rotate(a.r * Math.PI / 180);
    ctx.scale(a.s, a.s);
    const k = Math.min(layer.box[0] / layer.view[0], layer.box[1] / layer.view[1]);
    ctx.scale(k, k);
    ctx.translate(-layer.view[0] / 2, -layer.view[1] / 2);
    ctx.globalAlpha = Math.min(1, a.o);
    const shape = shapes[i]!;
    if (layer.fill) {
      ctx.fillStyle = layer.fill;
      ctx.fill(shape);
    }
    if (layer.stroke > 0 && to > from) {
      ctx.lineWidth = layer.stroke / k;
      ctx.lineCap = layer.cap;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = layer.color;
      // Canvas shadow blur is in device pixels and ignores the current transform.
      ctx.shadowColor = layer.color;
      ctx.shadowBlur = layer.glow * scale;
      // Path2D.trim mutates its receiver, so trim a copy.
      ctx.stroke(from <= 0 && to >= 1 ? shape : new Path2D(shape).trim(from, to));
      ctx.shadowBlur = 0;
    }
  });
  return state.join(',');
}

export const frameFile = (f: number) => `${String(f).padStart(5, '0')}.png`;

/**
 * Everything that determines the pixels of a run at a given output size, and nothing else:
 * IDs, timeline position and compositing order are excluded, so a renamed, re-added or
 * retimed scene reuses its cached frames.
 */
export function rasterIdentity(run: VectorRun): unknown {
  const { id: _id, at: _at, z: _z, layers, ...pixels } = run;
  return { ...pixels, layers: layers.map(({ id: _layer, ...layer }) => layer) };
}

/**
 * Write the run as `00000.png`… into `dir` at W×H. Frames whose drawing state repeats reuse
 * the previous encoded bytes. Checks `signal` between frames.
 */
export async function rasterizeVectorRun(run: VectorRun, W: number, H: number, dir: string, signal?: AbortSignal): Promise<{ encoded: number }> {
  const { createCanvas, Path2D } = canvasModule();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const shapes = run.layers.map((layer) => new Path2D(layer.d));
  await fsp.mkdir(dir, { recursive: true });
  let last = '', png: Buffer | undefined, encoded = 0;
  for (let f = 0; f < run.frames; f++) {
    if (signal?.aborted) throw new TmepError('E_CANCELLED', 'render cancelled');
    const state = drawVectorFrame(ctx, run, f, W / run.w, shapes);
    if (state !== last || !png) {
      png = canvas.encodeSync('png');
      encoded++;
      last = state;
    }
    await fsp.writeFile(path.join(dir, frameFile(f)), png);
  }
  return { encoded };
}
