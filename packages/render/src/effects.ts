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
import { type Clip, type Effect, type FxMask, type Key, type KeyProp, type Ease, sampleKeys } from '../../core/src/index.ts';

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
export function transformFilter(fx: Effect[], W: number, H: number, fps: number, bg: string): string | undefined {
  const kfs = transforms(fx);
  const T = `(in/${fps})`;
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
  return `pad=${Wp}:${Hp}:${P}:${P}:color=${col},perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y1}':x2='${x2}':y2='${y2}':x3='${x3}':y3='${y3}':interpolation=cubic:eval=frame,crop=${W}:${H}:${P}:${P}`;
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

/** Signed distance (px, positive inside) of a mask shape at mask resolution MW x MH, as a geq expression of X,Y. */
export function maskExpr(m: FxMask, MW: number, MH: number): string {
  const Tp = 'T';
  let prog: string | undefined;
  if (m.reveal) prog = easeExpr(m.reveal.e, `clip((${Tp}-(${n(m.reveal.at)}))/${n(m.reveal.d)},0,1)`);
  const grow = m.reveal && m.reveal.from === 'center' ? `max(${prog},0.001)` : undefined;
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
  const qx = grow ? `(${n(cxp)}+(X-${n(cxp)})/${grow})` : 'X';
  const qy = grow ? `(${n(cyp)}+(Y-${n(cyp)})/${grow})` : 'Y';
  let d0: string;
  if (m.shape === 'rect') {
    d0 = `min(${n((m.w * MW) / 2)}-abs(${qx}-${n(cxp)}),${n((m.h * MH) / 2)}-abs(${qy}-${n(cyp)}))`;
  } else if (m.shape === 'ellipse') {
    const rx = (m.w * MW) / 2;
    const ry = (m.h * MH) / 2;
    d0 = `(1-sqrt(pow((${qx}-${n(cxp)})/${n(rx)},2)+pow((${qy}-${n(cyp)})/${n(ry)},2)))*${n(Math.min(rx, ry))}`;
  } else {
    const pts = m.pts!.map(([x, y]) => [x * MW, y * MH] as [number, number]);
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

/**
 * Filter fragment for all effects on a clip, or undefined when it has none.
 * `id` must be unique within the unit graph; `frames` is the clip's frame count.
 */
export function compileFx(c: Clip, W: number, H: number, fps: number, bg: string, frames: number, id: string): string | undefined {
  const fx = c.fx;
  if (!fx?.length) return undefined;
  const col = bg.replace('#', '0x');
  const D = n((frames + fps) / fps);
  const parts: string[] = [];
  const tf = transformFilter(fx, W, H, fps, bg);
  if (tf) parts.push(tf);
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
    const alpha = ms.map((m) => maskExpr(m, MW, MH)).reduce((a, b) => `${a}*${b}`);
    const animated = ms.some((m) => m.reveal);
    const src = animated
      ? `color=c=black:s=${MW}x${MH}:r=${fps}:d=${D},format=gray,geq=lum='255*${alpha}'`
      : `color=c=black:s=${MW}x${MH}:r=${fps}:d=${n(1 / fps)},format=gray,geq=lum='255*${alpha}',loop=loop=-1:size=1,setpts=N/(${fps}*TB),trim=duration=${D}`;
    const head = frag ? `${frag},` : '';
    frag = `${head}format=yuva420p[fxc${id}];${src},scale=${W}:${H}:flags=bicubic,format=gray[fxm${id}];[fxc${id}][fxm${id}]alphamerge[fxk${id}];color=c=${col}:s=${W}x${H}:r=${fps}:d=${D}[fxb${id}];[fxb${id}][fxk${id}]overlay=shortest=1:format=auto`;
  }
  return frag || undefined;
}
