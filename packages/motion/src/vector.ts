/**
 * Deterministic Skia Canvas frame rasterizer for Visual Scene layers.
 *
 * Every frame is a pure function of (run spec, frame index, output size): sample the same
 * keyframe math as the validator and FFmpeg transform filter, then paint with @napi-rs/canvas.
 */
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { sampleKeys, ease, TmepError, type Ease, type Key } from '../../core/src/index.ts';
import { pointAt, lerpShape, shapeToPath, type MorphShape, type Polyline } from './paths.ts';

type Skia = typeof import('@napi-rs/canvas');
type Path2D = InstanceType<Skia['Path2D']>;
type Ctx = ReturnType<InstanceType<Skia['Canvas']>['getContext']>;
type SkiaImage = Awaited<ReturnType<Skia['loadImage']>>;

export const VECTOR_VERSION = 'v3';

export interface DrawKey { t: number; from?: number; to?: number; e?: Ease }
export interface CanvasGradientSpec {
  type: 'linear' | 'radial';
  angle: number;
  stops: { offset: number; color: string }[];
}
export interface CanvasShadowSpec {
  color: string;
  blur: number;
  x: number;
  y: number;
}
export interface CanvasClipSpec {
  kind: 'rect' | 'rrect' | 'ellipse';
  radius: number;
}
export interface CanvasChartDatum {
  label: string;
  value: number;
  color?: string;
}
export interface CanvasChartSpec {
  chartType: 'bar' | 'hbar' | 'line' | 'ring';
  data: CanvasChartDatum[];
  max?: number;
  unit: string;
  accent: string;
  trackColor: string;
}
export interface CanvasTextSpec {
  text: string;
  fontName: string;
  fontFile?: string;
  fontSize: number;
  bold?: boolean;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  lineHeight: number;
  wrap: boolean;
  maxLines?: number;
  ellipsis: boolean;
  bg?: string;
  pad: number;
  radius: number;
}

export interface VectorLayer {
  id: string;
  kind?: 'path' | 'rect' | 'rrect' | 'ellipse' | 'polygon' | 'text' | 'image' | 'chart';
  from: number;
  to: number;
  keys: Key[];
  draw: DrawKey[];
  /** SVG path fields (when kind is 'path' or omitted). */
  d?: string;
  view?: [number, number];
  box: [number, number];
  stroke: number;
  glow: number;
  color: string;
  fill?: string;
  cap: 'round' | 'butt' | 'square';
  /** Generalized Canvas fields. */
  radius?: number;
  points?: [number, number][];
  gradient?: CanvasGradientSpec;
  shadow?: CanvasShadowSpec;
  clip?: CanvasClipSpec;
  textSpec?: CanvasTextSpec;
  imagePath?: string;
  imageFit?: 'contain' | 'cover';
  chartSpec?: CanvasChartSpec;
  /** Phase 4A motion. */
  textAnim?: TextAnimSpec;
  /** Morph keys (first at t=0 is the base shape), prepared into point correspondence. */
  morph?: { t: number; e?: Ease; shape: MorphShape }[];
  /** Motion path in `view` units (default frame fractions); keys give arc-length progress. */
  motion?: { poly: Polyline; view: [number, number]; keys: { t: number; p: number; e?: Ease }[]; orient: boolean };
  reveal?: { from: 'left' | 'right' | 'top' | 'bottom' | 'center'; at: number; d: number; e?: Ease };
  depth?: number;
}

export interface UnitPoseSpec { o?: number; x?: number; y?: number; s?: number; r?: number }
export interface TextAnimSpec {
  by: 'char' | 'word' | 'line';
  at: number;
  stagger: number;
  d: number;
  e?: Ease;
  from: UnitPoseSpec;
  out?: { at: number; stagger: number; d: number; e?: Ease; to: UnitPoseSpec };
}

export interface VectorRun {
  id: string;
  at: number;
  d: number;
  frames: number;
  z: number;
  w: number;
  h: number;
  fps: number;
  camera: Key[];
  sceneFrame: number;
  layers: VectorLayer[];
  mblur?: { samples: number; shutter: number };
  focus?: { depth: number; blur: number };
}

const require = createRequire(import.meta.url);
let skia: Skia | undefined;
const registeredFonts = new Set<string>();

export function canvasModule(): Skia {
  if (skia) return skia;
  try {
    skia = require('@napi-rs/canvas') as Skia;
    return skia;
  } catch {
    throw new TmepError('E_INPUT', 'Visual Scene Canvas layers require @napi-rs/canvas');
  }
}

export function ensureCanvasFont(fontName: string, fontFile?: string): void {
  if (!fontFile || registeredFonts.has(fontFile)) return;
  canvasModule().GlobalFonts.registerFromPath(fontFile, fontName);
  registeredFonts.add(fontFile);
}

/** Measure and wrap text into lines within maxWidth using Canvas glyph widths. */
export function wrapMeasuredText(
  ctx: Pick<Ctx, 'measureText'>,
  text: string,
  maxWidth: number,
  maxLines?: number,
  ellipsis = false,
): string[] {
  const paragraphs = text.split('\n');
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (!current || ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
        if (ctx.measureText(word).width > maxWidth) {
          // Break overly long single words / URLs cleanly
          let chunk = '';
          for (const ch of word) {
            if (chunk && ctx.measureText(chunk + ch).width > maxWidth) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          current = chunk;
        }
      }
    }
    if (current) lines.push(current);
  }
  if (maxLines !== undefined && lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    if (ellipsis && kept.length) {
      let last = kept[kept.length - 1]!;
      while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
        last = last.slice(0, -1);
      }
      kept[kept.length - 1] = `${last}…`;
    }
    return kept;
  }
  return lines;
}

export function pathBounds(d: string): [number, number, number, number] {
  const { Path2D } = canvasModule();
  try {
    return new Path2D(d).computeTightBounds();
  } catch {
    throw new TmepError('E_INPUT', 'invalid SVG path data');
  }
}

export function drawRange(draw: DrawKey[], t: number): [number, number] {
  if (!draw.length) return [0, 1];
  const keys: Key[] = draw.map(({ t: kt, from, to, e }) => ({
    t: kt,
    ...(e && { e }),
    ...(from !== undefined && { x: from }),
    ...(to !== undefined && { s: to }),
  }));
  return [sampleKeys(keys, 'x', t), sampleKeys(keys, 's', t)];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Eased progress from a list of {t, p, e} keys (constant before the first / after the last key). */
export function progressAt(keys: { t: number; p: number; e?: Ease }[], t: number): number {
  if (!keys.length) return 0;
  if (t <= keys[0]!.t) return keys[0]!.p;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!, b = keys[i]!;
    if (t < b.t) return a.p + (b.p - a.p) * ease(b.e ?? 'io', (t - a.t) / Math.max(1e-6, b.t - a.t));
  }
  return keys[keys.length - 1]!.p;
}

/** Pose of text unit `i` at layer time t: enter from `from`, optional exit to `out.to` (em units scaled by fontSize). */
export function unitPose(a: TextAnimSpec, i: number, t: number, fontSize: number): { o: number; x: number; y: number; s: number; r: number } {
  const p = ease(a.e ?? 'expo', clamp01((t - a.at - i * a.stagger) / a.d));
  const f = a.from;
  let o = (f.o ?? 1) + (1 - (f.o ?? 1)) * p;
  let x = (f.x ?? 0) * fontSize * (1 - p);
  let y = (f.y ?? 0) * fontSize * (1 - p);
  let sc = (f.s ?? 1) + (1 - (f.s ?? 1)) * p;
  let r = (f.r ?? 0) * (1 - p);
  if (a.out && t >= a.out.at) {
    const q = ease(a.out.e ?? 'in', clamp01((t - a.out.at - i * a.out.stagger) / a.out.d));
    const g = a.out.to;
    o *= 1 + ((g.o ?? 1) - 1) * q;
    x += (g.x ?? 0) * fontSize * q;
    y += (g.y ?? 0) * fontSize * q;
    sc *= 1 + ((g.s ?? 1) - 1) * q;
    r += (g.r ?? 0) * q;
  }
  return { o, x, y, s: sc, r };
}

/** Shape of a morphing path layer at layer time t. */
export function morphAt(morph: NonNullable<VectorLayer['morph']>, t: number): MorphShape {
  if (t <= morph[0]!.t || morph.length === 1) return morph[0]!.shape;
  for (let i = 1; i < morph.length; i++) {
    const a = morph[i - 1]!, b = morph[i]!;
    if (t < b.t) return lerpShape(a.shape, b.shape, ease(b.e ?? 'io', (t - a.t) / Math.max(1e-6, b.t - a.t)));
  }
  return morph[morph.length - 1]!.shape;
}

let segmenters: Record<string, Intl.Segmenter> | undefined;
function textUnits(line: string, by: TextAnimSpec['by']): { text: string; index: number }[] {
  if (by === 'line') return [{ text: line, index: 0 }];
  segmenters ??= { char: new Intl.Segmenter(undefined, { granularity: 'grapheme' }), word: new Intl.Segmenter(undefined, { granularity: 'word' }) };
  return [...segmenters[by]!.segment(line)].map((x) => ({ text: x.segment, index: x.index }));
}

const sample = (keys: Key[], t: number) => ({
  x: sampleKeys(keys, 'x', t),
  y: sampleKeys(keys, 'y', t),
  s: sampleKeys(keys, 's', t),
  r: sampleKeys(keys, 'r', t),
  o: sampleKeys(keys, 'o', t),
});

function makeGradient(c: Ctx, grad: CanvasGradientSpec, bw: number, bh: number) {
  if (grad.type === 'radial') {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, Math.max(bw, bh) / 2);
    for (const st of grad.stops) g.addColorStop(st.offset, st.color);
    return g;
  }
  const rad = (grad.angle * Math.PI) / 180;
  const dx = Math.cos(rad) * (bw / 2);
  const dy = Math.sin(rad) * (bh / 2);
  const g = c.createLinearGradient(-dx, -dy, dx, dy);
  for (const st of grad.stops) g.addColorStop(st.offset, st.color);
  return g;
}

function traceShape(c: Ctx, kind: 'rect' | 'rrect' | 'ellipse', bw: number, bh: number, radius = 0): void {
  c.beginPath();
  if (kind === 'ellipse') {
    c.ellipse(0, 0, bw / 2, bh / 2, 0, 0, Math.PI * 2);
  } else if (kind === 'rrect' && radius > 0) {
    c.roundRect(-bw / 2, -bh / 2, bw, bh, Math.min(radius, bw / 2, bh / 2));
  } else {
    c.rect(-bw / 2, -bh / 2, bw, bh);
  }
}

function paintChart(c: Ctx, spec: CanvasChartSpec, bw: number, bh: number, progress: number): void {
  const items = spec.data;
  const maxVal = spec.max ?? Math.max(1, ...items.map((d) => d.value));
  const p = Math.min(1, Math.max(0, progress));
  const padX = Math.min(24, bw * 0.06);
  const padY = Math.min(28, bh * 0.12);
  const iw = Math.max(10, bw - padX * 2);
  const ih = Math.max(10, bh - padY * 2);

  if (spec.chartType === 'ring') {
    const d = items[0]!;
    const frac = Math.min(1, (d.value / maxVal) * p);
    const radius = Math.max(8, Math.min(iw, ih) / 2 - 14);
    const lineW = Math.max(8, Math.min(26, radius * 0.22));
    c.lineCap = 'round';
    c.lineWidth = lineW;
    c.strokeStyle = spec.trackColor;
    c.beginPath();
    c.arc(0, 0, radius, 0, Math.PI * 2);
    c.stroke();

    c.strokeStyle = d.color ?? spec.accent;
    c.beginPath();
    c.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    c.stroke();

    c.fillStyle = '#FFFFFF';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const valSize = Math.max(16, Math.round(radius * 0.44));
    c.font = `700 ${valSize}px sans-serif`;
    c.fillText(`${Math.round(d.value * p)}${spec.unit}`, 0, -valSize * 0.14);
    c.font = `500 ${Math.max(12, Math.round(valSize * 0.42))}px sans-serif`;
    c.fillStyle = '#CBD5E1';
    c.fillText(d.label, 0, valSize * 0.55);
    return;
  }

  if (spec.chartType === 'hbar') {
    const rowH = ih / items.length;
    const barH = Math.max(8, Math.min(28, rowH * 0.48));
    const labelSize = Math.max(12, Math.min(24, Math.round(rowH * 0.34)));
    c.font = `600 ${labelSize}px sans-serif`;
    for (let i = 0; i < items.length; i++) {
      const d = items[i]!;
      const y = -ih / 2 + i * rowH + rowH * 0.52;
      const frac = Math.min(1, (d.value / maxVal) * p);
      c.fillStyle = '#E2E8F0';
      c.textAlign = 'left';
      c.textBaseline = 'bottom';
      c.fillText(d.label, -bw / 2 + padX, y - barH * 0.2);

      c.fillStyle = '#FFFFFF';
      c.textAlign = 'right';
      c.fillText(`${Math.round(d.value * p)}${spec.unit}`, bw / 2 - padX, y - barH * 0.2);

      c.fillStyle = spec.trackColor;
      c.beginPath();
      c.roundRect(-bw / 2 + padX, y, iw, barH, barH / 2);
      c.fill();

      if (frac > 0) {
        c.fillStyle = d.color ?? spec.accent;
        c.beginPath();
        c.roundRect(-bw / 2 + padX, y, Math.max(barH, iw * frac), barH, barH / 2);
        c.fill();
      }
    }
    return;
  }

  if (spec.chartType === 'line') {
    const pts: [number, number][] = items.map((d, i) => {
      const fx = items.length === 1 ? 0.5 : i / (items.length - 1);
      const fy = 1 - Math.min(1, d.value / maxVal);
      return [-iw / 2 + fx * iw, -ih / 2 + fy * ih];
    });
    c.strokeStyle = spec.trackColor;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(-iw / 2, ih / 2);
    c.lineTo(iw / 2, ih / 2);
    c.stroke();

    const maxIdx = (pts.length - 1) * p;
    c.strokeStyle = spec.accent;
    c.lineWidth = Math.max(3, Math.min(8, bw * 0.012));
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) c.moveTo(pts[0]![0], pts[0]![1]);
      else if (i <= maxIdx) c.lineTo(pts[i]![0], pts[i]![1]);
      else if (i - 1 < maxIdx) {
        const t = maxIdx - (i - 1);
        const [x0, y0] = pts[i - 1]!;
        const [x1, y1] = pts[i]!;
        c.lineTo(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      }
    }
    c.stroke();
    return;
  }

  // Default: vertical 'bar' chart
  const slot = iw / items.length;
  const barW = Math.max(10, slot * 0.58);
  const labelSize = Math.max(11, Math.min(22, Math.round(slot * 0.22)));
  c.font = `600 ${labelSize}px sans-serif`;
  for (let i = 0; i < items.length; i++) {
    const d = items[i]!;
    const cx = -iw / 2 + slot * (i + 0.5);
    const barH = Math.max(4, (d.value / maxVal) * (ih * 0.78) * p);
    const bottom = ih / 2 - labelSize * 1.4;
    c.fillStyle = d.color ?? spec.accent;
    c.beginPath();
    c.roundRect(cx - barW / 2, bottom - barH, barW, barH, Math.min(10, barW / 3));
    c.fill();

    c.fillStyle = '#E2E8F0';
    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.fillText(d.label, cx, bottom + 8);
    c.fillStyle = '#FFFFFF';
    c.textBaseline = 'bottom';
    c.fillText(`${Math.round(d.value * p)}${spec.unit}`, cx, bottom - barH - 6);
  }
}

export function drawVectorFrame(
  ctx: Ctx,
  run: VectorRun,
  f: number,
  scale: number,
  shapes: (Path2D | undefined)[],
  images: Map<string, SkiaImage> = new Map(),
): string {
  const { Path2D } = canvasModule();
  const clear = (c: Ctx) => {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
  };
  clear(ctx);
  const cam = sample(run.camera, (run.sceneFrame + f) / run.fps);
  const state: number[] = [cam.x, cam.y, cam.s, cam.r];
  run.layers.forEach((layer, i) => {
    if (f < layer.from || f >= layer.to) return;
    const t = (f - layer.from) / run.fps;
    const a = sample(layer.keys, t);
    const [from, to] = drawRange(layer.draw, t);
    state.push(i, a.x, a.y, a.s, a.r, a.o, from, to);
    if (a.o <= 0) return;

    const translucent = a.o < 1;
    const c = translucent ? scratchFor(ctx) : ctx;
    if (translucent) clear(c);

    c.save();
    c.setTransform(scale, 0, 0, scale, 0, 0);
    // 2.5D: a layer at depth d follows the camera's pan and zoom with factor 1/(1+d) (parallax).
    const k = 1 / (1 + (layer.depth ?? 0));
    c.translate(run.w / 2 + cam.x * run.w * k, run.h / 2 + cam.y * run.h * k);
    c.rotate((cam.r * Math.PI) / 180);
    const cs = 1 + (cam.s - 1) * k;
    c.scale(cs, cs);
    let orient = 0;
    if (layer.motion) {
      const mp = layer.motion;
      const pr = progressAt(mp.keys, t);
      const { pt, tan } = pointAt(mp.poly, pr);
      c.translate((pt[0] / mp.view[0] - 0.5) * run.w, (pt[1] / mp.view[1] - 0.5) * run.h);
      if (mp.orient) orient = (Math.atan2(tan[1] * run.h / mp.view[1], tan[0] * run.w / mp.view[0]) * 180) / Math.PI;
      state.push(pr);
    }
    c.translate(a.x * run.w, a.y * run.h);
    c.rotate(((a.r + orient) * Math.PI) / 180);
    c.scale(a.s, a.s);

    const [bw, bh] = layer.box;
    if (layer.reveal) {
      const rv = layer.reveal;
      const p = ease(rv.e ?? 'expo', clamp01((t - rv.at) / rv.d));
      state.push(p);
      if (p <= 0) { c.restore(); return; }
      if (p < 1) {
        c.beginPath();
        if (rv.from === 'center') c.ellipse(0, 0, (bw / 2) * Math.SQRT2 * p, (bh / 2) * Math.SQRT2 * p, 0, 0, Math.PI * 2);
        else if (rv.from === 'left') c.rect(-bw / 2 - 2, -bh / 2 - 2, bw * p + 2, bh + 4);
        else if (rv.from === 'right') c.rect(bw / 2 - bw * p, -bh / 2 - 2, bw * p + 2, bh + 4);
        else if (rv.from === 'top') c.rect(-bw / 2 - 2, -bh / 2 - 2, bw + 4, bh * p + 2);
        else c.rect(-bw / 2 - 2, bh / 2 - bh * p, bw + 4, bh * p + 2);
        c.clip();
      }
    }
    if (run.focus && layer.depth !== undefined) {
      const blur = Math.abs(layer.depth - run.focus.depth) * run.focus.blur * scale;
      if (blur > 0.25) c.filter = `blur(${blur.toFixed(2)}px)`;
    }
    if (layer.clip) {
      traceShape(c, layer.clip.kind, bw, bh, layer.clip.radius);
      c.clip();
    }
    if (layer.shadow) {
      c.shadowColor = layer.shadow.color;
      c.shadowBlur = layer.shadow.blur * scale;
      c.shadowOffsetX = layer.shadow.x * scale;
      c.shadowOffsetY = layer.shadow.y * scale;
    }

    const kind = layer.kind ?? 'path';
    if (kind === 'path') {
      const view = layer.view ?? [100, 100];
      const k = Math.min(bw / view[0], bh / view[1]);
      c.scale(k, k);
      c.translate(-view[0] / 2, -view[1] / 2);
      const shape = layer.morph ? new Path2D(shapeToPath(morphAt(layer.morph, t))) : shapes[i];
      if (layer.morph) state.push(t);
      if (shape) {
        if (layer.fill) {
          c.fillStyle = layer.fill;
          c.fill(shape);
        }
        if (layer.stroke > 0 && to > from) {
          c.lineWidth = layer.stroke / k;
          c.lineCap = layer.cap;
          c.lineJoin = 'round';
          c.strokeStyle = layer.color;
          c.shadowColor = layer.color;
          c.shadowBlur = layer.glow * scale;
          c.stroke(from <= 0 && to >= 1 ? shape : new Path2D(shape).trim(from, to));
          c.shadowBlur = 0;
        }
      }
    } else if (kind === 'rect' || kind === 'rrect' || kind === 'ellipse' || kind === 'polygon') {
      if (kind === 'polygon' && layer.points?.length) {
        c.beginPath();
        layer.points.forEach(([px, py], idx) => {
          const x = (px - 0.5) * bw;
          const y = (py - 0.5) * bh;
          if (idx === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        });
        c.closePath();
      } else {
        traceShape(c, kind === 'polygon' ? 'rect' : kind, bw, bh, layer.radius ?? 0);
      }
      if (layer.gradient) {
        c.fillStyle = makeGradient(c, layer.gradient, bw, bh);
        c.fill();
      } else if (layer.fill || !layer.stroke) {
        c.fillStyle = layer.fill ?? layer.color;
        c.fill();
      }
      if (layer.stroke > 0) {
        c.shadowBlur = 0;
        c.lineWidth = layer.stroke;
        c.strokeStyle = layer.color;
        c.stroke();
      }
    } else if (kind === 'text' && layer.textSpec) {
      const ts = layer.textSpec;
      ensureCanvasFont(ts.fontName, ts.fontFile);
      if (ts.bg) {
        c.fillStyle = ts.bg;
        traceShape(c, 'rrect', bw, bh, ts.radius);
        c.fill();
        c.shadowBlur = 0;
      }
      c.font = `${ts.bold ? '700 ' : ''}${ts.fontSize}px "${ts.fontName}"`;
      const availW = Math.max(8, bw - (ts.bg ? ts.pad * 2 : 0));
      const lines = ts.wrap ? wrapMeasuredText(c, ts.text, availW, ts.maxLines, ts.ellipsis) : ts.text.split('\n');
      const lineStep = ts.fontSize * ts.lineHeight;
      const totalH = lines.length * lineStep;
      c.textAlign = ts.align;
      c.textBaseline = 'middle';
      c.fillStyle = layer.gradient ? makeGradient(c, layer.gradient, bw, bh) : layer.color;
      const tx = ts.align === 'left' ? -bw / 2 + (ts.bg ? ts.pad : 0) : ts.align === 'right' ? bw / 2 - (ts.bg ? ts.pad : 0) : 0;
      const startY = ts.valign === 'top'
        ? -bh / 2 + (ts.bg ? ts.pad : 0) + lineStep / 2
        : ts.valign === 'bottom'
          ? bh / 2 - (ts.bg ? ts.pad : 0) - totalH + lineStep / 2
          : -totalH / 2 + lineStep / 2;
      if (layer.textAnim) {
        // Each unit is placed at its offset inside the measured line, so kerning and alignment
        // match the static text exactly; only the per-unit pose animates.
        const A = layer.textAnim;
        c.textAlign = 'left';
        let ui = 0;
        state.push(t);
        lines.forEach((line, li) => {
          const lw = c.measureText(line).width;
          const x0 = ts.align === 'left' ? tx : ts.align === 'right' ? tx - lw : tx - lw / 2;
          const y = startY + li * lineStep;
          for (const u of textUnits(line, A.by)) {
            if (!u.text.trim()) continue;
            const pose = unitPose(A, ui++, t, ts.fontSize);
            if (pose.o <= 0.001) continue;
            // After whitespace the unit starts at width(prefix). Inside a word the kerning pair with the
            // previous character matters, so use width(prefix + unit) - width(unit).
            const uw = c.measureText(u.text).width;
            const prev = line[u.index - 1];
            const ux = x0 + (u.index === 0 || prev === undefined || /\s/.test(prev)
              ? c.measureText(line.slice(0, u.index)).width
              : c.measureText(line.slice(0, u.index + u.text.length)).width - uw);
            c.save();
            c.globalAlpha *= Math.min(1, pose.o);
            c.translate(ux + uw / 2 + pose.x, y + pose.y);
            if (pose.r) c.rotate((pose.r * Math.PI) / 180);
            if (pose.s !== 1) c.scale(pose.s, pose.s);
            c.fillText(u.text, -uw / 2, 0);
            c.restore();
          }
        });
      } else lines.forEach((line, li) => c.fillText(line, tx, startY + li * lineStep));
    } else if (kind === 'image' && layer.imagePath) {
      const img = images.get(layer.imagePath);
      if (img) {
        if ((layer.radius ?? 0) > 0 && !layer.clip) {
          traceShape(c, 'rrect', bw, bh, layer.radius);
          c.clip();
        }
        const fit = layer.imageFit ?? 'contain';
        const k = fit === 'cover' ? Math.max(bw / img.width, bh / img.height) : Math.min(bw / img.width, bh / img.height);
        const dw = img.width * k;
        const dh = img.height * k;
        c.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      }
    } else if (kind === 'chart' && layer.chartSpec) {
      paintChart(c, layer.chartSpec, bw, bh, to);
    }

    c.restore();

    if (translucent) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = a.o;
      ctx.drawImage(c.canvas, 0, 0);
      ctx.globalAlpha = 1;
    }
  });
  return state.join(',');
}

const scratches = new WeakMap<object, Ctx>();
function scratchFor(ctx: Ctx): Ctx {
  let scratch = scratches.get(ctx.canvas);
  if (!scratch) {
    scratch = canvasModule().createCanvas(ctx.canvas.width, ctx.canvas.height).getContext('2d');
    scratches.set(ctx.canvas, scratch);
  }
  return scratch;
}

export const frameFile = (f: number) => `${String(f).padStart(5, '0')}.png`;

export function rasterIdentity(run: VectorRun): unknown {
  const { id: _id, at: _at, z: _z, layers, ...pixels } = run;
  return { ...pixels, layers: layers.map(({ id: _layer, ...layer }) => layer) };
}

export async function rasterizeVectorRun(run: VectorRun, W: number, H: number, dir: string, signal?: AbortSignal): Promise<{ encoded: number }> {
  const { createCanvas, Path2D, loadImage } = canvasModule();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const shapes = run.layers.map((layer) => (layer.d ? new Path2D(layer.d) : undefined));
  const images = new Map<string, SkiaImage>();
  for (const layer of run.layers) {
    if (layer.imagePath && !images.has(layer.imagePath)) {
      images.set(layer.imagePath, await loadImage(layer.imagePath));
    }
  }
  await fsp.mkdir(dir, { recursive: true });
  let last = '', png: Buffer | undefined, encoded = 0;
  // Motion blur: average `samples` sub-frames spread over the shutter interval (additive, 1/N each).
  const mb = run.mblur;
  const sub = mb ? createCanvas(W, H).getContext('2d') : undefined;
  const drawFrame = (f: number): string => {
    if (!mb || !sub) return drawVectorFrame(ctx, run, f, W / run.w, shapes, images);
    const states: string[] = [];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < mb.samples; i++) {
      const df = mb.shutter * ((i + 0.5) / mb.samples - 0.5);
      states.push(drawVectorFrame(sub, run, Math.min(run.frames - 1e-3, Math.max(0, f + df)), W / run.w, shapes, images));
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1 / mb.samples;
      ctx.drawImage(sub.canvas, 0, 0);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // A static frame (all sub-frames identical) is drawn sharp, without accumulation error.
    if (states.every((x) => x === states[0])) return drawVectorFrame(ctx, run, f, W / run.w, shapes, images);
    return states.join('|');
  };
  for (let f = 0; f < run.frames; f++) {
    if (signal?.aborted) throw new TmepError('E_CANCELLED', 'render cancelled');
    const state = drawFrame(f);
    if (state !== last || !png) {
      png = canvas.encodeSync('png');
      encoded++;
      last = state;
    }
    await fsp.writeFile(path.join(dir, frameFile(f)), png);
  }
  return { encoded };
}
