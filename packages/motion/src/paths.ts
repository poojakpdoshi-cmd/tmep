/**
 * Deterministic SVG path geometry for the Canvas motion engine (Phase 4A):
 *  - parse + flatten SVG path data (M L H V C S Q T A Z, absolute and relative) into polylines,
 *  - resample by arc length,
 *  - shape morphing between paths with different structure (correspondence by arc length,
 *    start-point alignment and winding matching),
 *  - point/tangent lookup along a motion path.
 * Pure functions, no dependencies; results are stable across platforms for the same input.
 */
export type Pt = [number, number];
export interface Polyline { pts: Pt[]; closed: boolean }

const CMD = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

function tokenize(d: string): (string | number)[] {
  const bad = /[^MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]/.exec(d);
  if (bad) throw new Error(`path: unsupported command ${bad[0]}`);
  const out: (string | number)[] = [];
  for (const m of d.matchAll(CMD)) out.push(m[1] ?? Number(m[2]));
  return out;
}

const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, steps: number, out: Pt[]) => {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
};

/** SVG elliptical arc (endpoint parameterization, SVG 1.1 F.6.5) appended as line segments. */
function arc(p0: Pt, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p1: Pt, out: Pt[]) {
  if (rx === 0 || ry === 0) { out.push(p1); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2, cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil((Math.abs(dt) / (Math.PI / 2)) * 12));
  for (let i = 1; i <= steps; i++) {
    const t = t1 + (dt * i) / steps;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
}

/** Flatten SVG path data into polylines (one per subpath). Throws on malformed data. */
export function flattenPath(d: string, curveSteps = 16): Polyline[] {
  const tk = tokenize(d);
  const subs: Polyline[] = [];
  let cur: Pt = [0, 0], start: Pt = [0, 0], pts: Pt[] | undefined;
  let lastCtrl: Pt | undefined, lastQ: Pt | undefined, prevCmd = '';
  let i = 0;
  const num = () => {
    const v = tk[i++];
    if (typeof v !== 'number') throw new Error(`path: expected a number at token ${i - 1}`);
    return v;
  };
  const begin = (p: Pt) => { if (pts && pts.length > 1) subs.push({ pts, closed: false }); pts = [p]; start = p; };
  let cmd = '';
  while (i < tk.length) {
    if (typeof tk[i] === 'string') cmd = tk[i++] as string;
    else if (!cmd) throw new Error('path: must start with a moveto');
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const at = (x: number, y: number): Pt => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    if (C === 'Z') {
      if (pts && pts.length > 1) subs.push({ pts, closed: true });
      pts = undefined; cur = start; lastCtrl = lastQ = undefined; prevCmd = 'Z';
      continue;
    }
    if (!pts) pts = [cur];
    switch (C) {
      case 'M': { const p = at(num(), num()); begin(p); cur = p; cmd = rel ? 'l' : 'L'; break; }
      case 'L': { cur = at(num(), num()); pts.push(cur); break; }
      case 'H': { const x = num(); cur = [rel ? cur[0] + x : x, cur[1]]; pts.push(cur); break; }
      case 'V': { const y = num(); cur = [cur[0], rel ? cur[1] + y : y]; pts.push(cur); break; }
      case 'C': { const p1 = at(num(), num()), p2 = at(num(), num()), p3 = at(num(), num()); cubic(cur, p1, p2, p3, curveSteps, pts); lastCtrl = p2; cur = p3; break; }
      case 'S': {
        const p1: Pt = lastCtrl && 'CS'.includes(prevCmd) ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
        const p2 = at(num(), num()), p3 = at(num(), num());
        cubic(cur, p1, p2, p3, curveSteps, pts); lastCtrl = p2; cur = p3; break;
      }
      case 'Q': {
        const q = at(num(), num()), p3 = at(num(), num());
        cubic(cur, [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], [p3[0] + (2 / 3) * (q[0] - p3[0]), p3[1] + (2 / 3) * (q[1] - p3[1])], p3, curveSteps, pts);
        lastQ = q; cur = p3; break;
      }
      case 'T': {
        const q: Pt = lastQ && 'QT'.includes(prevCmd) ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur;
        const p3 = at(num(), num());
        cubic(cur, [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], [p3[0] + (2 / 3) * (q[0] - p3[0]), p3[1] + (2 / 3) * (q[1] - p3[1])], p3, curveSteps, pts);
        lastQ = q; cur = p3; break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num() !== 0, sweep = num() !== 0, p = at(num(), num());
        arc(cur, rx, ry, rot, large, sweep, p, pts); cur = p; break;
      }
      default: throw new Error(`path: unsupported command ${cmd}`);
    }
    prevCmd = C;
    if (C !== 'C' && C !== 'S') lastCtrl = undefined;
    if (C !== 'Q' && C !== 'T') lastQ = undefined;
  }
  if (pts && (pts as Pt[]).length > 1) subs.push({ pts, closed: false });
  if (!subs.length) throw new Error('path: no drawable segments');
  return subs;
}

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Cumulative arc length of a polyline (including the closing segment when closed). */
function lengths(p: Polyline): number[] {
  const L = [0];
  const n = p.pts.length;
  for (let i = 1; i < n; i++) L.push(L[i - 1]! + dist(p.pts[i - 1]!, p.pts[i]!));
  if (p.closed) L.push(L[n - 1]! + dist(p.pts[n - 1]!, p.pts[0]!));
  return L;
}

/** Point at arc-length fraction u ∈ [0,1] and the unit tangent there. */
export function pointAt(p: Polyline, u: number, L = lengths(p)): { pt: Pt; tan: Pt } {
  const total = L[L.length - 1]!;
  const n = p.pts.length;
  if (total <= 0) return { pt: p.pts[0]!, tan: [1, 0] };
  const s = Math.min(1, Math.max(0, u)) * total;
  let i = 1;
  while (i < L.length - 1 && L[i]! < s) i++;
  const a = p.pts[(i - 1) % n]!, b = p.pts[i % n]!;
  const seg = L[i]! - L[i - 1]!;
  const t = seg > 0 ? (s - L[i - 1]!) / seg : 0;
  const len = dist(a, b) || 1;
  return { pt: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], tan: [(b[0] - a[0]) / len, (b[1] - a[1]) / len] };
}

/** Resample a polyline to exactly n points spaced evenly by arc length. */
export function resample(p: Polyline, n: number): Pt[] {
  const L = lengths(p);
  const out: Pt[] = [];
  const denom = p.closed ? n : n - 1;
  for (let k = 0; k < n; k++) out.push(pointAt(p, denom > 0 ? k / denom : 0, L).pt);
  return out;
}

const area = (pts: Pt[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i]!, q = pts[(i + 1) % pts.length]!; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
};
const centroid = (pts: Pt[]): Pt => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

/** A path prepared for morphing: every subpath resampled to the same point count. */
export interface MorphShape { subs: { pts: Pt[]; closed: boolean }[] }

export const MORPH_POINTS = 128;

/**
 * Bring several paths into point-to-point correspondence so they can be interpolated:
 * equal subpath counts (missing subpaths collapse to the centroid of a partner), equal point counts,
 * matching winding and the start rotation that minimizes travel for closed subpaths.
 */
export function prepareMorph(paths: string[], n = MORPH_POINTS): MorphShape[] {
  const flat = paths.map((d) => flattenPath(d));
  const count = Math.max(...flat.map((f) => f.length));
  const shapes: MorphShape[] = flat.map((f) => {
    const subs = f.map((p) => ({ pts: resample(p, n), closed: p.closed }));
    while (subs.length < count) {
      const c = centroid(subs[subs.length - 1]!.pts);
      subs.push({ pts: Array.from({ length: n }, () => [c[0], c[1]] as Pt), closed: subs[subs.length - 1]!.closed });
    }
    return { subs };
  });
  // Align each shape to the previous one (chain), so consecutive keys morph with least motion.
  for (let s = 1; s < shapes.length; s++) {
    for (let k = 0; k < count; k++) {
      const ref = shapes[s - 1]!.subs[k]!, cur = shapes[s]!.subs[k]!;
      if (!cur.closed || !ref.closed) continue;
      if (Math.sign(area(cur.pts)) !== Math.sign(area(ref.pts)) && area(cur.pts) !== 0) cur.pts.reverse();
      let best = 0, bestErr = Infinity;
      for (let off = 0; off < n; off += 2) {
        let e = 0;
        for (let i = 0; i < n; i += 4) { const a = ref.pts[i]!, b = cur.pts[(i + off) % n]!; e += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2; }
        if (e < bestErr) { bestErr = e; best = off; }
      }
      if (best) cur.pts = [...cur.pts.slice(best), ...cur.pts.slice(0, best)];
    }
  }
  return shapes;
}

/** Linear interpolation between two prepared shapes (progress already eased). */
export function lerpShape(a: MorphShape, b: MorphShape, p: number): MorphShape {
  return { subs: a.subs.map((sa, k) => {
    const sb = b.subs[k]!;
    return { closed: p < 0.5 ? sa.closed : sb.closed, pts: sa.pts.map((q, i) => [q[0] + (sb.pts[i]![0] - q[0]) * p, q[1] + (sb.pts[i]![1] - q[1]) * p] as Pt) };
  }) };
}

/** SVG path data for a prepared shape (used to build a Path2D). */
export function shapeToPath(s: MorphShape): string {
  const f = (v: number) => (Math.round(v * 1000) / 1000).toString();
  return s.subs.map((sub) => `M${sub.pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}${sub.closed ? 'Z' : ''}`).join('');
}

/** First subpath of a motion path, flattened for arc-length lookups. */
export function motionPolyline(d: string): Polyline {
  const subs = flattenPath(d, 24);
  return subs.length === 1 ? subs[0]! : { pts: subs.flatMap((s) => s.pts), closed: false };
}
