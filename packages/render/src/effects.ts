/**
 * Compile clip effects (keyframed transforms, opacity, shape masks) into FFmpeg filter fragments.
 *
 *  - Scale/position/rotation: one `perspective` filter whose four source corners are the inverse
 *    affine transform of the output corners, evaluated per frame. The frame is padded by 2 px of
 *    background colour first, so anything uncovered (zoom-out, pans past the edge, rotation) shows
 *    the timeline background instead of smeared edge pixels.
 *  - Opacity: per-frame values sampled in JS (same easing as the model) and sent to a `blend`
 *    filter with `sendcmd` — no per-pixel expression evaluation.
 *  - Masks: a feathered signed-distance mask computed with `geq` at half resolution (a single
 *    looped frame when the mask is static), upscaled, `alphamerge`d and composited over the background.
 *
 * The fragment is inserted into a clip's linear filter chain; it may contain labelled sub-graphs
 * but always ends with an unlabelled output so the chain can continue with ",filter...".
 */
import {
  type Clip, type Effect, type FxMask, type Key, type KeyProp, type Ease, type MaskKey,
  sampleKeys, ease,
} from '../../core/src/index.ts';
import { canvasModule } from '../../motion/src/vector.ts';
import { TmepError } from '../../core/src/errors.ts';
import fsp from 'node:fs/promises';
import path from 'node:path';

type SkiaContext = ReturnType<ReturnType<ReturnType<typeof canvasModule>['createCanvas']>['getContext']>;

const n = (x: number) => {
  const r = Math.round(x * 1e5) / 1e5;
  return Object.is(r, -0) ? '0' : String(r);
};

/** FFmpeg expression for an easing curve applied to progress expression `p` (already clipped to [0,1]). */
export function easeExpr(e: Ease, p: string): string {
  switch (e) {
    case 'linear':
      return p;
    case 'in':
      return `pow(${p},3)`;
    case 'out':
      return `(1-pow(1-${p},3))`;
    case 'io':
      return `if(lt(${p},0.5),4*pow(${p},3),1-pow(2-2*${p},3)/2)`;
    case 'back':
      return `(1+2.70158*pow(${p}-1,3)+1.70158*pow(${p}-1,2))`;
    case 'spring':
      return `if(lte(${p},0),0,if(gte(${p},1),1,1-exp(-6*${p})*cos(${p}*2.5*PI)))`;
    case 'hold':
      return `gte(${p},1)`;
  }
}

/** Piecewise eased expression of time expression `T` for one property, or undefined if no key sets it. */
export function keyExpr(keys: Key[], prop: KeyProp, T: string): string | undefined {
  const ks = keys.filter((k) => k[prop] !== undefined);
  if (!ks.length) return undefined;
  let expr = n(ks[ks.length - 1]![prop]!);
  for (let i = ks.length - 1; i >= 1; i--) {
    const a = ks[i - 1]!;
    const b = ks[i]!;
    const va = a[prop]!;
    const vb = b[prop]!;
    const seg = va === vb ? n(va) : `(${n(va)}+${n(vb - va)}*${easeExpr(b.e ?? 'io', `clip((${T}-(${n(a.t)}))/${n(b.t - a.t)},0,1)`)})`;
    expr = `if(lt(${T},${n(b.t)}),${seg},${expr})`;
  }
  return expr;
}

const transforms = (fx: Effect[]) => fx.filter((f): f is Extract<Effect, { type: 'kf' }> => f.type === 'kf');
const masks = (fx: Effect[]) => fx.filter((f): f is FxMask => f.type === 'mask');

function combine(parts: (string | undefined)[], op: '*' | '+'): string | undefined {
  const p = parts.filter((x): x is string => !!x);
  if (!p.length) return undefined;
  return p.length === 1 ? p[0] : p.map((x) => `(${x})`).join(op);
}

/** Perspective filter implementing scale `S`, translation (X,Y as frame fractions), rotation R (deg) about the centre. */
export function transformFilter(fx: Effect[], W: number, H: number, fps: number, bg: string, timeOffset = 0, transparent = false): string | undefined {
  const kfs = transforms(fx);
  const T = timeOffset ? `(in/${fps}+${n(timeOffset)})` : `(in/${fps})`;
  const S = combine(kfs.map((k) => keyExpr(k.keys, 's', T)), '*');
  const X = combine(kfs.map((k) => keyExpr(k.keys, 'x', T)), '+');
  const Y = combine(kfs.map((k) => keyExpr(k.keys, 'y', T)), '+');
  const R = combine(kfs.map((k) => keyExpr(k.keys, 'r', T)), '+');
  if (!S && !X && !Y && !R) return undefined;
  const P = 2;
  const Wp = W + 2 * P;
  const Hp = H + 2 * P;
  const cx = Wp / 2;
  const cy = Hp / 2;
  const s = S ? `(${S})` : '1';
  const th = R ? `((${R})*PI/180)` : '';
  const corner = (u: number, v: number): [string, string] => {
    const dx = `(${n(u - cx)}${X ? `-(${X})*${W}` : ''})`;
    const dy = `(${n(v - cy)}${Y ? `-(${Y})*${H}` : ''})`;
    if (!th) return [`${n(cx)}+${dx}/${s}`, `${n(cy)}+${dy}/${s}`];
    return [`${n(cx)}+(cos(${th})*${dx}+sin(${th})*${dy})/${s}`, `${n(cy)}+(cos(${th})*${dy}-sin(${th})*${dx})/${s}`];
  };
  const [x0, y0] = corner(0, 0);
  const [x1, y1] = corner(Wp, 0);
  const [x2, y2] = corner(0, Hp);
  const [x3, y3] = corner(Wp, Hp);
  const col = bg.replace('#', '0x');
  return `${transparent ? 'format=yuva420p,' : ''}pad=${Wp}:${Hp}:${P}:${P}:color=${transparent ? 'black@0' : col},perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y1}':x2='${x2}':y2='${y2}':x3='${x3}':y3='${y3}':interpolation=cubic:eval=frame,crop=${W}:${H}:${P}:${P}`;
}

/** Per-frame opacity commands; undefined when opacity is constant 1. */
export function opacitySchedule(fx: Effect[], frames: number, fps: number): { t: number; o: number }[] | undefined {
  const kfs = transforms(fx).filter((k) => k.keys.some((x) => x.o !== undefined));
  if (!kfs.length) return undefined;
  const out: { t: number; o: number }[] = [];
  let last = NaN;
  for (let f = 0; f <= frames; f++) {
    const t = f / fps;
    const o = Math.round(kfs.reduce((a, k) => a * sampleKeys(k.keys, 'o', t), 1) * 1000) / 1000;
    if (o !== last) out.push({ t, o });
    last = o;
  }
  if (out.length === 1 && out[0]!.o === 1) return undefined;
  return out;
}

function maskKeyExpr(keys: MaskKey[], prop: 'x' | 'y' | 'w' | 'h' | 'feather', T: string, fallback: number): string {
  const ks = keys.filter((k) => k[prop] !== undefined);
  if (!ks.length) return n(fallback);
  let expr = n(ks[ks.length - 1]![prop]!);
  for (let i = ks.length - 1; i >= 1; i--) {
    const a = ks[i - 1]!;
    const b = ks[i]!;
    const va = a[prop]!;
    const vb = b[prop]!;
    const seg = va === vb ? n(va) : `(${n(va)}+${n(vb - va)}*${easeExpr(b.e ?? 'io', `clip((${T}-(${n(a.t)}))/${n(b.t - a.t)},0,1)`)})`;
    expr = `if(lt(${T},${n(b.t)}),${seg},${expr})`;
  }
  return expr;
}

function sampleMaskKey(keys: MaskKey[], prop: 'x' | 'y' | 'w' | 'h' | 'feather' | 'r', t: number, fallback: number): number {
  const ks = keys.filter((k) => k[prop] !== undefined);
  if (!ks.length) return fallback;
  if (t <= ks[0]!.t) return ks[0]![prop]!;
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1]!;
    const b = ks[i]!;
    if (t < b.t) {
      const p = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return a[prop]! + (b[prop]! - a[prop]!) * ease(b.e ?? 'io', p);
    }
  }
  return ks[ks.length - 1]![prop]!;
}

/** True when a mask changes over time (reveal or more than one key) and so needs one raster per frame. */
export function maskAnimated(m: FxMask): boolean {
  return !!m.reveal || (m.keys?.length ?? 0) > 1;
}

interface MaskState { x: number; y: number; w: number; h: number; f: number; r: number; p: number }

function maskState(m: FxMask, t: number): MaskState {
  const k = m.keys?.length ? m.keys : undefined;
  const p = m.reveal ? ease(m.reveal.e, Math.min(1, Math.max(0, (t - m.reveal.at) / Math.max(1e-6, m.reveal.d)))) : 1;
  return {
    x: k ? sampleMaskKey(k, 'x', t, m.x) : m.x,
    y: k ? sampleMaskKey(k, 'y', t, m.y) : m.y,
    w: k ? sampleMaskKey(k, 'w', t, m.w) : m.w,
    h: k ? sampleMaskKey(k, 'h', t, m.h) : m.h,
    f: k ? sampleMaskKey(k, 'feather', t, m.feather) : m.feather,
    r: k ? sampleMaskKey(k, 'r', t, 0) : 0,
    p,
  };
}

/** Shape bounding box in mask pixels (untransformed), used for directional reveals. */
function shapeBox(m: FxMask, MW: number, MH: number): [number, number, number, number] {
  const pts: [number, number][] = m.shape === 'bezier' && m.bezierStart && m.beziers?.length
    ? [m.bezierStart, ...m.beziers.flatMap((s) => [s.cp1, s.cp2, s.to])]
    : m.pts?.length ? m.pts : [[m.x - m.w / 2, m.y - m.h / 2], [m.x + m.w / 2, m.y + m.h / 2]];
  const xs = pts.map((q) => q[0] * MW), ys = pts.map((q) => q[1] * MH);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Draw one frame of a mask (white = visible) with the same semantics as the `geq` path:
 * keyed move/scale/rotation about the shape centre, feather, a reveal limited to the shape's
 * bounding box (wipe from a side, or growth from the centre), then inversion.
 */
function drawComplexMask(ctx: SkiaContext, m: FxMask, MW: number, MH: number, s: MaskState): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, MW, MH);
  const featherPx = Math.max(0, s.f * Math.min(MW, MH));
  if (s.p > 0) {
    const [bx0, by0, bx1, by1] = shapeBox(m, MW, MH);
    const ox = m.x * MW, oy = m.y * MH;
    // keyed transform: move the shape centre to (x,y), scale by w/h relative to the base size, rotate (degrees)
    ctx.translate(s.x * MW, s.y * MH);
    if (s.r) ctx.rotate((s.r * Math.PI) / 180);
    ctx.scale(s.w / Math.max(1e-4, m.w), s.h / Math.max(1e-4, m.h));
    ctx.translate(-ox, -oy);
    if (m.reveal && s.p < 1) {
      const from = m.reveal.from;
      if (from === 'center') {
        const g = Math.max(s.p, 0.001);
        const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
        ctx.translate(cx, cy);
        ctx.scale(g, g);
        ctx.translate(-cx, -cy);
      } else {
        const bw = bx1 - bx0, bh = by1 - by0;
        const pad = featherPx + 2;
        const [rx, ry, rw, rh] = {
          left: [bx0 - pad, by0 - pad, bw * s.p + pad, bh + 2 * pad],
          right: [bx1 - bw * s.p, by0 - pad, bw * s.p + pad, bh + 2 * pad],
          top: [bx0 - pad, by0 - pad, bw + 2 * pad, bh * s.p + pad],
          bottom: [bx0 - pad, by1 - bh * s.p, bw + 2 * pad, bh * s.p + pad],
        }[from] as [number, number, number, number];
        ctx.beginPath();
        ctx.rect(rx, ry, rw, rh);
        ctx.clip();
      }
    }
    if (featherPx > 0.5) ctx.filter = `blur(${featherPx.toFixed(2)}px)`;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    if (m.shape === 'bezier' && m.bezierStart && m.beziers?.length) {
      ctx.moveTo(m.bezierStart[0] * MW, m.bezierStart[1] * MH);
      for (const seg of m.beziers) ctx.bezierCurveTo(seg.cp1[0] * MW, seg.cp1[1] * MH, seg.cp2[0] * MW, seg.cp2[1] * MH, seg.to[0] * MW, seg.to[1] * MH);
      ctx.closePath();
    } else if (m.pts?.length) {
      ctx.moveTo(m.pts[0]![0] * MW, m.pts[0]![1] * MH);
      for (let i = 1; i < m.pts.length; i++) ctx.lineTo(m.pts[i]![0] * MW, m.pts[i]![1] * MH);
      ctx.closePath();
    } else if (m.shape === 'ellipse') {
      ctx.ellipse(ox, oy, (m.w * MW) / 2, (m.h * MH) / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.rect(ox - (m.w * MW) / 2, oy - (m.h * MH) / 2, m.w * MW, m.h * MH);
    }
    ctx.fill('evenodd');
  }
  ctx.restore();
  if (m.invert) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, MW, MH);
    ctx.restore();
  }
}

/** Rasterize one frame (item-local time `t`) of a concave or bezier mask into a PNG at MW x MH. */
export function rasterizeComplexMaskPng(m: FxMask, MW: number, MH: number, t = 0): Buffer {
  const { createCanvas } = canvasModule();
  const canvas = createCanvas(MW, MH);
  drawComplexMask(canvas.getContext('2d'), m, MW, MH, maskState(m, t));
  return canvas.encodeSync('png');
}

/** File name of frame `f` in a mask sequence directory (matches the `%05d.png` input pattern). */
export const maskFrameFile = (f: number) => `${String(f).padStart(5, '0')}.png`;

/**
 * Rasterize `frames` frames (item-local time f/fps) of an animated mask into `dir`, reusing one
 * canvas so memory stays bounded by a single frame. Consecutive identical states are encoded once.
 */
export async function rasterizeComplexMaskSequence(
  m: FxMask, MW: number, MH: number, fps: number, frames: number, dir: string, signal?: AbortSignal,
): Promise<{ frames: number; encoded: number }> {
  const { createCanvas } = canvasModule();
  const canvas = createCanvas(MW, MH);
  const ctx = canvas.getContext('2d');
  await fsp.mkdir(dir, { recursive: true });
  let last = '', png: Buffer | undefined, encoded = 0;
  for (let f = 0; f < frames; f++) {
    if (signal?.aborted) throw new TmepError('E_CANCELLED', 'render cancelled');
    const s = maskState(m, f / fps);
    const key = [s.x, s.y, s.w, s.h, s.f, s.r, s.p].map((v) => v.toFixed(5)).join(',');
    if (key !== last || !png) {
      drawComplexMask(ctx, m, MW, MH, s);
      png = canvas.encodeSync('png');
      encoded++;
      last = key;
    }
    await fsp.writeFile(path.join(dir, maskFrameFile(f)), png);
  }
  return { frames, encoded };
}

const escFilterPath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

/**
 * Gray alpha source (MW x MH, `D` seconds) for a pre-rasterized mask: a single PNG looped, or a
 * frame sequence directory entered at item-local frame `offsetFrames` (for overlays that span
 * several render units). Holds the last frame if the sequence is shorter than `D`.
 */
export function maskFileSource(file: string, fps: number, D: string, offsetFrames = 0): string {
  if (file.endsWith('.png')) {
    return `movie='${escFilterPath(file)}',loop=loop=-1:size=1,setpts=N/(${fps}*TB),trim=duration=${D},format=gray`;
  }
  const pattern = escFilterPath(`${file.replace(/%/g, '%%')}/%05d.png`);
  return `movie='${pattern}':f=image2,setpts=N/(${fps}*TB),trim=start_frame=${Math.max(0, Math.round(offsetFrames))},` +
    `setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${D},trim=duration=${D},format=gray`;
}

/**
 * Combine alpha sources into one gray stream by multiplication. Each source is an unlabelled
 * chain; the result is an unlabelled chain that can continue with ",filter".
 */
function multiplyAlpha(sources: string[], id: string): string {
  if (sources.length === 1) return sources[0]!;
  const labels = sources.map((_, i) => `[ma${id}x${i}]`);
  let out = sources.map((s, i) => `${s}${labels[i]}`).join(';') + ';';
  let acc = labels[0]!;
  for (let i = 1; i < labels.length; i++) {
    const next = i === labels.length - 1 ? '' : `[ma${id}y${i}]`;
    out += `${acc}${labels[i]}blend=all_mode=multiply${next}${next ? ';' : ''}`;
    acc = next;
  }
  return out;
}

/** Signed distance (px, positive inside) of a mask shape at mask resolution MW x MH, as a geq expression of X,Y. */
export function maskExpr(m: FxMask, MW: number, MH: number, timeOffset = 0): string {
  const Tp = timeOffset ? `(T+${n(timeOffset)})` : 'T';
  let prog: string | undefined;
  if (m.reveal) prog = easeExpr(m.reveal.e, `clip((${Tp}-(${n(m.reveal.at)}))/${n(m.reveal.d)},0,1)`);
  const grow = m.reveal && m.reveal.from === 'center' ? `max(${prog},0.001)` : undefined;
  const mxExpr = m.keys?.length ? `(${maskKeyExpr(m.keys, 'x', Tp, m.x)}*${MW})` : n(m.x * MW);
  const myExpr = m.keys?.length ? `(${maskKeyExpr(m.keys, 'y', Tp, m.y)}*${MH})` : n(m.y * MH);
  const mwExpr = m.keys?.length ? `(${maskKeyExpr(m.keys, 'w', Tp, m.w)}*${MW})` : n(m.w * MW);
  const mhExpr = m.keys?.length ? `(${maskKeyExpr(m.keys, 'h', Tp, m.h)}*${MH})` : n(m.h * MH);
  // shape centre and bbox in mask pixels
  let cxp: number, cyp: number, bx0: number, bx1: number, by0: number, by1: number;
  if (m.shape === 'poly') {
    const pts = m.pts!;
    cxp = (pts.reduce((a, p) => a + p[0], 0) / pts.length) * MW;
    cyp = (pts.reduce((a, p) => a + p[1], 0) / pts.length) * MH;
    bx0 = Math.min(...pts.map((p) => p[0])) * MW;
    bx1 = Math.max(...pts.map((p) => p[0])) * MW;
    by0 = Math.min(...pts.map((p) => p[1])) * MH;
    by1 = Math.max(...pts.map((p) => p[1])) * MH;
  } else {
    cxp = m.x * MW;
    cyp = m.y * MH;
    bx0 = cxp - (m.w * MW) / 2;
    bx1 = cxp + (m.w * MW) / 2;
    by0 = cyp - (m.h * MH) / 2;
    by1 = cyp + (m.h * MH) / 2;
  }
  // sample point, pulled toward the centre when the shape grows from 0
  const qx = grow ? `(${mxExpr}+(X-${mxExpr})/${grow})` : 'X';
  const qy = grow ? `(${myExpr}+(Y-${myExpr})/${grow})` : 'Y';
  let d0: string;
  if (m.shape === 'rect') {
    d0 = `min(${mwExpr}/2-abs(${qx}-${mxExpr}),${mhExpr}/2-abs(${qy}-${myExpr}))`;
  } else if (m.shape === 'ellipse') {
    const rx = `(${mwExpr}/2)`;
    const ry = `(${mhExpr}/2)`;
    d0 = `(1-sqrt(pow((${qx}-${mxExpr})/${rx},2)+pow((${qy}-${myExpr})/${ry},2)))*min(${rx},${ry})`;
  } else {
    const pts = (m.pts ?? [[0.2, 0.2], [0.8, 0.2], [0.5, 0.8]]).map(([x, y]) => [x * MW, y * MH] as [number, number]);
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      area += a[0] * b[1] - b[0] * a[1];
    }
    const sg = area > 0 ? 1 : -1;
    const edges = pts.map((a, i) => {
      const b = pts[(i + 1) % pts.length]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return `(${n((sg * (b[0] - a[0])) / len)}*(${qy}-${n(a[1])})-${n((sg * (b[1] - a[1])) / len)}*(${qx}-${n(a[0])}))`;
    });
    d0 = edges.reduce((a, b) => `min(${a},${b})`);
  }
  let d = grow ? `(${grow})*(${d0})` : d0;
  if (m.reveal && m.reveal.from !== 'center') {
    const p = prog!;
    const wipe = {
      left: `(${n(bx0)}+${p}*${n(bx1 - bx0)}-X)`,
      right: `(X-(${n(bx1)}-${p}*${n(bx1 - bx0)}))`,
      top: `(${n(by0)}+${p}*${n(by1 - by0)}-Y)`,
      bottom: `(Y-(${n(by1)}-${p}*${n(by1 - by0)}))`,
    }[m.reveal.from];
    d = `min(${d},${wipe})`;
  }
  const f = Math.max(1, m.feather * Math.min(MW, MH));
  const a = `clip((${d})/${n(f)},0,1)`;
  return m.invert ? `(1-${a})` : a;
}

/** Compile Stage 3.2 linear/compositing filters (blur, glow, shadow, chromakey, mblur, persp). */
function compileProFx(fx: Effect[], W: number, H: number, fps: number, D: string, id: string, isOverlay: boolean): string[] {
  const out: string[] = [];
  let k = 0;
  for (const f of fx) {
    const tag = `${id}p${k++}`;
    if (f.type === 'blur') {
      if (f.mode === 'gaussian') {
        out.push(`gblur=sigma=${n(f.sigma)}`);
      } else {
        // True directional (motion) blur along `angle` on all planes. The previous boxblur form
        // was a 2-D box blur on luma only, and its "vertical" branch blurred only chroma.
        const angle = (((f.angle ?? 0) % 360) + 360) % 360;
        out.push(`dblur=angle=${n(angle)}:radius=${n(Math.max(1, f.sigma * 2))}`);
      }
    } else if (f.type === 'glow') {
      out.push(
        `split=2[ga${tag}][gb${tag}];[gb${tag}]gblur=sigma=${n(f.radius)}${f.brightness ? `,eq=brightness=${n(f.brightness)}` : ''}[gc${tag}];[ga${tag}][gc${tag}]blend=all_mode=screen:all_opacity=${n(f.intensity)}`,
      );
    } else if (f.type === 'chromakey') {
      out.push(`format=yuva420p,chromakey=color=${f.color.replace('#', '0x')}:similarity=${n(f.similarity)}:blend=${n(f.blend)}${f.despill ? ',despill=green' : ''}`);
    } else if (f.type === 'mblur') {
      const weights = Array.from({ length: f.frames }, (_, i) => n(Math.pow(f.decay ?? 0.6, f.frames - 1 - i))).join(' ');
      out.push(`tmix=frames=${f.frames}:weights='${weights}'`);
    } else if (f.type === 'persp') {
      out.push(
        `perspective=x0='${n(f.x0 * W)}':y0='${n(f.y0 * H)}':x1='${n(f.x1 * W)}':y1='${n(f.y1 * H)}':x2='${n(f.x2 * W)}':y2='${n(f.y2 * H)}':x3='${n(f.x3 * W)}':y3='${n(f.y3 * H)}':interpolation=cubic`,
      );
    } else if (f.type === 'shadow' && isOverlay) {
      const col = (f.color ?? '#000000').replace('#', '0x');
      out.push(
        `format=yuva420p,split=2[sf${tag}][ss${tag}];[ss${tag}]alphaextract,gblur=sigma=${n(f.blur)}[sa${tag}];color=c=${col}:s=${W}x${H}:r=${fps}:d=${D},format=yuva420p[sc${tag}];[sc${tag}][sa${tag}]alphamerge[sh${tag}];color=c=black@0:s=${W}x${H}:r=${fps}:d=${D},format=yuva420p[sb${tag}];[sb${tag}][sh${tag}]overlay=${Math.round(f.dx)}:${Math.round(f.dy)}:shortest=1,format=yuva420p,colorchannelmixer=aa=${n(f.opacity)}[so${tag}];[so${tag}][sf${tag}]overlay=0:0:shortest=1`,
      );
    }
  }
  return out;
}

/**
 * Filter fragment for all effects on a clip, or undefined when it has none.
 * `id` must be unique within the unit graph; `frames` is the clip's frame count.
 */
export function compileFx(c: Clip, W: number, H: number, fps: number, bg: string, frames: number, id: string, maskFiles?: Map<FxMask, string>): string | undefined {
  const fx = c.fx;
  if (!fx?.length) return undefined;
  const col = bg.replace('#', '0x');
  const D = n((frames + fps) / fps);
  const parts: string[] = [];
  const tf = transformFilter(fx, W, H, fps, bg);
  if (tf) parts.push(tf);
  parts.push(...compileProFx(fx, W, H, fps, D, id, false));
  let frag = parts.join(',');
  const sched = opacitySchedule(fx, frames, fps);
  if (sched) {
    // blend only applies all_opacity when it is < 1, so full opacity is sent as 0.99999 (visually identical)
    const op = (o: number) => n(Math.min(o, 0.99999));
    const cmds = sched.map((s) => `${n(Math.max(0, s.t - 0.0005))} blend@o${id} all_opacity ${op(s.o)}`).join(';');
    const head = frag ? `${frag},` : '';
    frag = `${head}format=yuv420p,sendcmd=c='${cmds}'[fxa${id}];color=c=${col}:s=${W}x${H}:r=${fps}:d=${D},format=yuv420p[fxg${id}];[fxa${id}][fxg${id}]blend@o${id}=all_mode=normal:all_opacity=${op(sched[0]!.o)}:shortest=1`;
  }
  const ms = masks(fx);
  if (ms.length) {
    const MW = Math.max(2, Math.round(W / 2));
    const MH = Math.max(2, Math.round(H / 2));
    // Pre-rasterized (concave/bezier) masks come from files; the rest are evaluated with geq.
    // Every mask multiplies, so a file mask never silently drops the others.
    const sources = ms.filter((m) => maskFiles?.has(m)).map((m) => maskFileSource(maskFiles!.get(m)!, fps, D));
    const exprMasks = ms.filter((m) => !maskFiles?.has(m));
    if (exprMasks.length) {
      const alpha = exprMasks.map((m) => maskExpr(m, MW, MH)).reduce((a, b) => `${a}*${b}`);
      const animated = exprMasks.some((m) => m.reveal || (m.keys && m.keys.length > 1));
      sources.push(animated
        ? `color=c=black:s=${MW}x${MH}:r=${fps}:d=${D},format=gray,geq=lum='255*${alpha}'`
        : `color=c=black:s=${MW}x${MH}:r=${fps}:d=${n(1 / fps)},format=gray,geq=lum='255*${alpha}',loop=loop=-1:size=1,setpts=N/(${fps}*TB),trim=duration=${D}`);
    }
    const src = multiplyAlpha(sources, id);
    const head = frag ? `${frag},` : '';
    frag = `${head}format=yuva420p[fxc${id}];${src},scale=${W}:${H}:flags=bicubic,format=gray[fxm${id}];[fxc${id}][fxm${id}]alphamerge[fxk${id}];color=c=${col}:s=${W}x${H}:r=${fps}:d=${D}[fxb${id}];[fxb${id}][fxk${id}]overlay=shortest=1:format=auto`;
  }
  return frag || undefined;
}

/**
 * B-roll variant of clip effects. Produces an ALPHA-PRESERVING overlay (unlike the
 * main-track compiler, which intentionally flattens into the timeline background).
 * Existing source alpha, transformed empty areas, opacity and all masks multiply.
 * timeOffset is the elapsed overlay time when a b-roll spans multiple render units.
 */
export function compileOverlayFx(
  fx: Effect[] | undefined, W: number, H: number, fps: number,
  frames: number, id: string, timeOffset = 0, maskFiles?: Map<FxMask, string>,
): string | undefined {
  if (!fx?.length) return undefined;
  const D = n((frames + fps) / fps);
  const tf = transformFilter(fx, W, H, fps, 'black', timeOffset, true);
  const pro = compileProFx(fx, W, H, fps, D, id, true);
  const head = [tf, ...pro].filter(Boolean).join(',');
  const opacity = combine(
    transforms(fx).map((k) => keyExpr(k.keys, 'o', timeOffset ? `(T+${n(timeOffset)})` : 'T')),
    '*',
  );
  const ms = masks(fx);
  if (!opacity && !ms.length) return head || undefined;

  // Opacity without a mask is uniform. Evaluate its time expression on a tiny
  // plane, then use the same upscaling and source-alpha multiplication as masks.
  const MW = ms.length ? Math.max(2, Math.round(W / 2)) : 2;
  const MH = ms.length ? Math.max(2, Math.round(H / 2)) : 2;
  const offsetFrames = Math.round(timeOffset * fps);
  const sources = ms.filter((m) => maskFiles?.has(m)).map((m) => maskFileSource(maskFiles!.get(m)!, fps, D, offsetFrames));
  const exprMasks = ms.filter((m) => !maskFiles?.has(m));
  if (exprMasks.length || opacity || !sources.length) {
    const alpha = [...exprMasks.map((m) => maskExpr(m, MW, MH, timeOffset)), ...(opacity ? [opacity] : [])]
      .map((x) => `(${x})`).join('*') || '1';
    const dynamic = exprMasks.some((m) => !!m.reveal || (m.keys && m.keys.length > 1)) ||
      transforms(fx).some((k) => k.keys.filter((x) => x.o !== undefined).length > 1);
    sources.push(dynamic
      ? `color=c=black:s=${MW}x${MH}:r=${fps}:d=${D},format=gray,geq=lum='255*clip(${alpha},0,1)'`
      : `color=c=black:s=${MW}x${MH}:r=${fps}:d=${n(1 / fps)},format=gray,geq=lum='255*clip(${alpha},0,1)',loop=loop=-1:size=1,setpts=N/(${fps}*TB),trim=duration=${D}`);
  }
  const src = multiplyAlpha(sources, id);
  // Never overwrite the input alpha: compose it with the computed effect alpha.
  return `${head ? head + ',' : ''}format=yuva420p,split=2[fxcol${id}][fxold${id}];` +
    `[fxold${id}]alphaextract[fxorig${id}];` +
    `${src},scale=${W}:${H}:flags=bicubic,format=gray[fxnew${id}];` +
    `[fxorig${id}][fxnew${id}]blend=all_mode=multiply[fxmul${id}];` +
    `[fxcol${id}][fxmul${id}]alphamerge`;
}
