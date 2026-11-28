/**
 * Phase 4A composition intelligence and motion presets.
 *
 * An agent states intent ("lower third for Dr. Rao, cardiologist") and FRAME decides, deterministically:
 *  - where it goes: a small constraint solver places each element inside the platform safe zone while
 *    avoiding the caption band, reserved presenter regions and caller-supplied regions;
 *  - how big the type is: a frame-relative type scale fitted to the box with measured text;
 *  - how it moves and when: a style profile fixes easing, durations, stagger and a timing beat so
 *    every element of an edit shares one rhythm.
 * Output is ordinary Visual Scene ops, validated by the same scene checker as hand-written specs.
 */
import {
  arr, num, obj, oneOf, str, formatIssues, TmepError,
  visualSceneSchema, type Infer, type Ratio, type VisualScene, RATIOS, type Ease,
} from '../../core/src/index.ts';
import { canvasModule, wrapMeasuredText } from '../../motion/src/vector.ts';
import { resolveFont } from '../../motion/src/fonts.ts';

export const PRESET_KINDS = ['lower_third', 'callout', 'ui_demo', 'animated_diagram', 'dynamic_chart', 'kinetic_title'] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];

// ---- style profiles ----
export interface StyleProfile {
  palette: { panel: string; panelEnd: string; text: string; muted: string; accent: string; accentText: string; line: string };
  head: 'bold' | 'heavy';
  body: 'regular' | 'bold';
  /** Type scale as fractions of frame height (portrait); landscape multiplies by 1.45. */
  scale: { head: number; sub: number; label: number };
  radius: number;
  ease: Ease;
  exit: Ease;
  enter: number;
  stagger: number;
  /** Timing beat (s): elements of one preset start on multiples of it. */
  beat: number;
  textBy: 'char' | 'word' | 'line';
  shadow: boolean;
}
export const STYLE_PROFILES: Record<string, StyleProfile> = {
  editorial: { palette: { panel: '#0F172AE6', panelEnd: '#1E293BE6', text: '#F8FAFC', muted: '#CBD5E1', accent: '#38BDF8', accentText: '#0B1220', line: '#38BDF8' },
    head: 'bold', body: 'regular', scale: { head: 0.05, sub: 0.024, label: 0.019 }, radius: 18, ease: 'expo', exit: 'in', enter: 0.6, stagger: 0.08, beat: 0.2, textBy: 'word', shadow: true },
  bold: { palette: { panel: '#111111F0', panelEnd: '#1A1A1AF0', text: '#FFFFFF', muted: '#E5E5E5', accent: '#FACC15', accentText: '#111111', line: '#FACC15' },
    head: 'heavy', body: 'bold', scale: { head: 0.058, sub: 0.026, label: 0.021 }, radius: 10, ease: 'snap', exit: 'in', enter: 0.45, stagger: 0.03, beat: 0.15, textBy: 'char', shadow: true },
  minimal: { palette: { panel: '#FFFFFFEE', panelEnd: '#F1F5F9EE', text: '#0F172A', muted: '#475569', accent: '#0F172A', accentText: '#FFFFFF', line: '#0F172A' },
    head: 'bold', body: 'regular', scale: { head: 0.044, sub: 0.022, label: 0.018 }, radius: 4, ease: 'smooth', exit: 'smooth', enter: 0.7, stagger: 0.12, beat: 0.25, textBy: 'line', shadow: false },
  documentary: { palette: { panel: '#0A0A0ACC', panelEnd: '#0A0A0ACC', text: '#F5F5F4', muted: '#D6D3D1', accent: '#D6D3D1', accentText: '#0A0A0A', line: '#A8A29E' },
    head: 'bold', body: 'regular', scale: { head: 0.042, sub: 0.022, label: 0.018 }, radius: 2, ease: 'smooth', exit: 'smooth', enter: 0.9, stagger: 0.15, beat: 0.3, textBy: 'line', shadow: false },
  sports: { palette: { panel: '#0B1F3AF0', panelEnd: '#12305AF0', text: '#FFFFFF', muted: '#BFDBFE', accent: '#F97316', accentText: '#FFFFFF', line: '#F97316' },
    head: 'heavy', body: 'bold', scale: { head: 0.06, sub: 0.027, label: 0.022 }, radius: 8, ease: 'back', exit: 'in', enter: 0.4, stagger: 0.025, beat: 0.12, textBy: 'char', shadow: true },
  tech: { palette: { panel: '#020617EB', panelEnd: '#0F172AEB', text: '#E2E8F0', muted: '#94A3B8', accent: '#22D3EE', accentText: '#020617', line: '#22D3EE' },
    head: 'bold', body: 'regular', scale: { head: 0.048, sub: 0.023, label: 0.019 }, radius: 14, ease: 'expoio', exit: 'in', enter: 0.55, stagger: 0.05, beat: 0.18, textBy: 'word', shadow: true },
};

const SAFE: Record<string, { left: number; top: number; right: number; bottom: number }> = {
  reels: { left: 0.05, top: 0.08, right: 0.11, bottom: 0.21 },
  shorts: { left: 0.05, top: 0.08, right: 0.12, bottom: 0.22 },
  tiktok: { left: 0.05, top: 0.09, right: 0.12, bottom: 0.22 },
  youtube: { left: 0.05, top: 0.06, right: 0.05, bottom: 0.10 },
  square: { left: 0.05, top: 0.06, right: 0.05, bottom: 0.10 },
  default: { left: 0.05, top: 0.06, right: 0.05, bottom: 0.12 },
};

const id = str({ min: 1, max: 48, pattern: /^[A-Za-z][\w-]*$/ });
const region = obj({ x: num({ min: 0, max: 1 }), y: num({ min: 0, max: 1 }), w: num({ min: 0.01, max: 1 }), h: num({ min: 0.01, max: 1 }) });
const point = obj({ x: num({ min: 0, max: 1 }), y: num({ min: 0, max: 1 }) });
const color = str({ pattern: /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/ });

export const presetSchema = obj({
  kind: oneOf(PRESET_KINDS),
  id: id.default('fx1'),
  at: num({ min: 0 }).default(0),
  duration: num({ min: 0.8, max: 60 }).default(4),
  ratio: oneOf(['9:16', '16:9', '1:1', '4:5'] as const).optional(),
  platform: oneOf(['reels', 'shorts', 'tiktok', 'youtube', 'square', 'default'] as const).default('default'),
  profile: oneOf(Object.keys(STYLE_PROFILES) as [string, ...string[]]).default('editorial'),
  accent: color.optional(),
  z: num({ int: true, min: -100, max: 100 }).default(9),
  /** Regions to keep clear (frame fractions, centre + size), e.g. a presenter's face or a product. */
  avoid: arr(region, { max: 8 }).default([]),
  title: str({ min: 1, max: 140 }).optional(),
  subtitle: str({ min: 1, max: 200 }).optional(),
  side: oneOf(['auto', 'left', 'right'] as const).default('auto'),
  target: point.optional(),
  label: str({ min: 1, max: 80 }).optional(),
  asset: id.optional(),
  clicks: arr(obj({ x: num({ min: 0, max: 1 }), y: num({ min: 0, max: 1 }), t: num({ min: 0 }), label: str({ min: 1, max: 40 }).optional() }), { min: 1, max: 12 }).optional(),
  nodes: arr(str({ min: 1, max: 48 }), { min: 2, max: 8 }).optional(),
  edges: arr(arr(num({ int: true, min: 0, max: 7 }), { min: 2, max: 2 }), { max: 16 }).optional(),
  layout: oneOf(['auto', 'row', 'column', 'grid'] as const).default('auto'),
  chart: obj({
    chartType: oneOf(['bar', 'hbar', 'line', 'ring'] as const),
    data: arr(obj({ label: str({ min: 1, max: 40 }), value: num({ min: 0, max: 1e9 }) }), { min: 1, max: 12 }),
    unit: str({ max: 16 }).default(''),
    max: num({ min: 0.001, max: 1e9 }).optional(),
    /** Label of the datum that carries the accent (default: the largest value). */
    highlight: str({ min: 1, max: 40 }).optional(),
  }).optional(),
});
export type PresetIntent = Infer<typeof presetSchema>;

export interface Box { x: number; y: number; w: number; h: number }
export interface PresetCorrection { code: string; msg: string }

const overlap = (a: Box, b: Box) => {
  const v = Math.max(0, Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2)) *
    Math.max(0, Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2));
  return v < 1e-12 ? 0 : v; // touching edges are not an overlap
};

/**
 * Deterministic placement: the centre that keeps a w×h box inside `area`, minimizes overlap with
 * `avoid` (weighted heavily) and then the distance to `prefer`. Scans a 0.01 grid.
 */
export function placeBox(w: number, h: number, prefer: { x: number; y: number }, area: Box, avoid: Box[]): { box: Box; overlap: number } {
  let best: { box: Box; overlap: number; score: number } | undefined;
  const x0 = area.x - area.w / 2 + w / 2, x1 = area.x + area.w / 2 - w / 2;
  const y0 = area.y - area.h / 2 + h / 2, y1 = area.y + area.h / 2 - h / 2;
  if (x1 < x0 - 1e-9 || y1 < y0 - 1e-9) throw new TmepError('E_RANGE', `a ${w.toFixed(2)}×${h.toFixed(2)} element does not fit the safe area`);
  for (let y = y0; y <= y1 + 1e-9; y += 0.01) {
    for (let x = x0; x <= x1 + 1e-9; x += 0.01) {
      const box = { x, y, w, h };
      const ov = avoid.reduce((s, a) => s + overlap(box, a), 0);
      const score = ov * 1000 + Math.hypot(x - prefer.x, y - prefer.y);
      if (!best || score < best.score - 1e-12) best = { box, overlap: ov, score };
    }
  }
  return { box: best!.box, overlap: best!.overlap };
}

/**
 * Height a single unwrapped line needs on this platform: the font's ascent + descent (what the scene
 * validator checks) or the line height, whichever is larger, plus 2 px of rounding headroom.
 */
function singleLineHeight(c: { measureText: (t: string) => { fontBoundingBoxAscent: number; fontBoundingBoxDescent: number } }, text: string, size: number, lineHeight: number): number {
  const m = c.measureText(text);
  return Math.max(size * lineHeight, m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) + 2;
}

/** Largest font size ≤ max whose measured wrap fits boxW×boxH in ≤ maxLines lines. */
export function fitText(text: string, weight: 'regular' | 'bold' | 'heavy', boxW: number, boxH: number, max: number, min: number, maxLines: number, lineHeight = 1.22): { size: number; lines: number; shrunk: boolean; lineH: number } {
  const font = resolveFont(weight);
  const { createCanvas, GlobalFonts } = canvasModule();
  if (font.file) GlobalFonts.registerFromPath(font.file, font.name);
  const c = createCanvas(1, 1).getContext('2d');
  const top = Math.max(min, Math.floor(max));
  for (let s = top; s >= min; s -= 1) {
    c.font = `${weight === 'regular' ? '' : '700 '}${s}px "${font.name}"`;
    const lines = wrapMeasuredText(c, text, boxW);
    if (lines.length <= maxLines && lines.length * s * lineHeight <= boxH) return { size: s, lines: lines.length, shrunk: s < top, lineH: singleLineHeight(c, text, s, lineHeight) };
  }
  c.font = `${weight === 'regular' ? '' : '700 '}${min}px "${font.name}"`;
  return { size: min, lines: maxLines, shrunk: true, lineH: singleLineHeight(c, text, min, lineHeight) };
}

/**
 * Narrowest box width (px) that keeps `text` on the same number of lines as at `maxW`: balances
 * multi-line headings so the last line is not a stranded single word.
 */
export function balancedWidth(text: string, weight: 'regular' | 'bold' | 'heavy', size: number, maxW: number): number {
  const font = resolveFont(weight);
  const c = canvasModule().createCanvas(1, 1).getContext('2d');
  c.font = `${weight === 'regular' ? '' : '700 '}${size}px "${font.name}"`;
  const n = wrapMeasuredText(c, text, maxW).length;
  if (n <= 1) return Math.min(maxW, c.measureText(text).width + 4);
  let lo = maxW / n, hi = maxW;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (wrapMeasuredText(c, text, mid).length <= n) hi = mid; else lo = mid;
  }
  return Math.min(maxW, Math.ceil(hi) + 4);
}

/** Compile a motion preset intent into a validated scene op. */
export function compilePreset(raw: unknown, defaults: { ratio?: Ratio; captionPos?: 'lower' | 'middle' | 'upper' } = {}): { ops: Record<string, unknown>[]; spec: VisualScene; corrections: PresetCorrection[] } {
  const parsed = presetSchema.parse(raw);
  if (!parsed.ok) throw new TmepError('E_INPUT', `invalid preset intent: ${formatIssues(parsed.issues)}`);
  const inp = parsed.value;
  const ratio: Ratio = inp.ratio ?? defaults.ratio ?? '9:16';
  const [W, H] = RATIOS[ratio];
  const portrait = H > W;
  const P = { ...STYLE_PROFILES[inp.profile]! };
  const pal = { ...P.palette, ...(inp.accent ? { accent: inp.accent, line: inp.accent } : {}) };
  const safe = SAFE[inp.platform]!;
  const corrections: PresetCorrection[] = [];
  const area: Box = { x: (safe.left + 1 - safe.right) / 2, y: (safe.top + 1 - safe.bottom) / 2, w: 1 - safe.left - safe.right - 0.02, h: 1 - safe.top - safe.bottom - 0.02 };
  const cap = defaults.captionPos ?? 'lower';
  const captionBand: Box | undefined = cap === 'lower' ? (portrait ? { x: .5, y: .715, w: 1, h: .17 } : { x: .5, y: .84, w: 1, h: .14 })
    : cap === 'upper' ? (portrait ? { x: .5, y: .27, w: 1, h: .12 } : { x: .5, y: .18, w: 1, h: .12 }) : undefined;
  const avoid: Box[] = [...(captionBand ? [captionBand] : []), ...inp.avoid];
  const px = (f: number) => f * H * (portrait ? 1 : 1.45);
  const D = inp.duration;
  const out = Math.max(D - 0.45, D * 0.8); // exit start
  const beat = (n: number) => Math.min(D * 0.5, n * P.beat);
  const styles: Record<string, unknown>[] = [];
  const layers: Record<string, unknown>[] = [];
  const style = (sid: string, weight: 'regular' | 'bold' | 'heavy', size: number, col: string) => styles.push({ id: sid, font: weight, size: Math.round(size), color: col });
  const place = (w: number, h: number, prefer: { x: number; y: number }, what: string, extraAvoid: Box[] = []) => {
    const r = placeBox(w, h, prefer, area, [...avoid, ...extraAvoid]);
    if (r.overlap > 1e-6) corrections.push({ code: 'unavoidable-overlap', msg: `${what}: no position clears every reserved region (overlap ${(r.overlap * 100).toFixed(2)}% of frame)` });
    if (Math.hypot(r.box.x - prefer.x, r.box.y - prefer.y) > 0.02) corrections.push({ code: 'placement', msg: `${what} moved to (${r.box.x.toFixed(2)}, ${r.box.y.toFixed(2)}) to stay in the safe area and clear reserved regions` });
    return r.box;
  };
  const textAnim = (at: number, by = P.textBy) => ({ by, at, stagger: by === 'char' ? P.stagger * 0.5 : by === 'word' ? P.stagger : P.stagger * 2, d: P.enter, e: P.ease,
    from: { o: 0, y: P.textBy === 'line' ? 0.35 : 0.5 }, out: { at: out, stagger: 0.01, d: 0.35, e: P.exit, to: { o: 0 } } });
  const fade = (k = 1) => [{ t: 0, o: 0 }, { t: Math.min(D * 0.3, P.enter * k), o: 1, e: P.ease }, { t: out, o: 1 }, { t: Math.min(D - 0.05, out + 0.4), o: 0, e: P.exit }];

  switch (inp.kind) {
    case 'kinetic_title': {
      const title = inp.title ?? bad('kinetic_title needs title');
      const w = Math.min(area.w, portrait ? 0.82 : 0.7);
      const head = fitText(title, P.head, w * W, px(P.scale.head) * 2.6, px(P.scale.head), px(P.scale.head) * 0.55, 2);
      const sub = inp.subtitle ? fitText(inp.subtitle, P.body, w * W, px(P.scale.sub) * 2.6, px(P.scale.sub), 18, 2) : undefined;
      if (head.shrunk) corrections.push({ code: 'font-fit', msg: `title set at ${head.size}px (scale ${Math.round(px(P.scale.head))}px) to fit 2 lines` });
      const hH = (head.lines * head.size * 1.22 + 8) / H, sH = sub ? (sub.lines * sub.size * 1.22 + 8) / H : 0;
      const headW = balancedWidth(title, P.head, head.size, w * W) / W;
      const total = hH + 0.02 + (sub ? sH + 0.012 : 0);
      const b = place(w, total, { x: area.x, y: portrait ? 0.36 : 0.42 }, 'title block');
      const top = b.y - total / 2;
      style('head', P.head, head.size, pal.text);
      layers.push({ id: 'head', kind: 'text', text: title, style: 'head', x: b.x, y: top + hH / 2, w: headW, h: hH, wrap: true, maxLines: 2, render: 'canvas', anim: textAnim(0) });
      layers.push({ id: 'rule', kind: 'rrect', x: b.x, y: top + hH + 0.01, w: w * 0.28, h: Math.max(0.003, 6 / H), radius: 3, fill: pal.accent, reveal: { from: 'left', at: beat(2), d: P.enter, e: P.ease }, keys: fade() });
      if (sub) {
        style('sub', P.body, sub.size, pal.muted);
        layers.push({ id: 'sub', kind: 'text', text: inp.subtitle!, style: 'sub', x: b.x, y: top + hH + 0.02 + sH / 2 + 0.012, w, h: sH, wrap: true, maxLines: 2, render: 'canvas', anim: textAnim(beat(3), 'line') });
      }
      break;
    }
    case 'lower_third': {
      const name = inp.title ?? bad('lower_third needs title (the name)');
      const w = Math.min(area.w * 0.9, portrait ? 0.72 : 0.42);
      // Lower thirds sit low, on the side away from the presenter (or the requested side), above captions.
      const presenter = inp.avoid[0];
      const side = inp.side !== 'auto' ? inp.side : presenter && presenter.x < 0.5 ? 'right' : 'left';
      const capTop = captionBand && cap === 'lower' ? captionBand.y - captionBand.h / 2 : area.y + area.h / 2;
      // Search only the lower band (a lower third that floats to mid-frame is not a lower third). To clear
      // reserved regions, first narrow the panel, then step the type down (never below a legible floor).
      let b: Box | undefined, nameFit = fitText(name, P.head, (w - 0.06) * W, 1e6, px(P.scale.sub * 1.5), 20, 1), roleFit: ReturnType<typeof fitText> | undefined, h = 0, prefer = { x: 0, y: 0 };
      const fits = (scale: number) => {
        nameFit = fitText(name, P.head, (w - 0.06) * W, 1e6, px(P.scale.sub * 1.5) * scale, 20, 1);
        // Legibility floor for the role line: 1.3% of frame height (≈25 px at 1080×1920).
        roleFit = inp.subtitle ? fitText(inp.subtitle, P.body, (w - 0.06) * W, 1e6, Math.max(px(0.013), px(P.scale.label) * scale), Math.round(px(0.013)), 1) : undefined;
        h = (nameFit.lineH + (roleFit ? roleFit.lineH : 0)) / H + 0.03;
        prefer = { x: side === 'left' ? area.x - area.w / 2 + w / 2 : area.x + area.w / 2 - w / 2, y: capTop - h / 2 - 0.015 };
        const band: Box = { x: area.x, y: (0.5 + capTop - 0.015) / 2, w: area.w, h: capTop - 0.015 - 0.5 };
        const textW = Math.max(balancedWidth(name, P.head, nameFit.size, (w - 0.06) * W), roleFit ? balancedWidth(inp.subtitle!, P.body, roleFit.size, (w - 0.06) * W) : 0) / W + 0.07;
        for (const k of [1, 0.85, 0.7, 0.55, 0]) {
          const ww = Math.max(w * k, textW);
          if (band.h < h || ww > band.w) continue;
          const r = placeBox(ww, h, { ...prefer, x: side === 'left' ? area.x - area.w / 2 + ww / 2 : area.x + area.w / 2 - ww / 2 }, band, avoid);
          if (r.overlap === 0) return r.box;
        }
        return undefined;
      };
      for (const scale of [1, 0.85, 0.72, 0.62, 0.52]) {
        b = fits(scale);
        if (b) {
          if (scale < 1) corrections.push({ code: 'font-fit', msg: `lower third type stepped down to ${Math.round(scale * 100)}% to fit beside reserved regions` });
          if (b.w < w - 1e-6) corrections.push({ code: 'placement', msg: `lower third narrowed to ${(b.w * 100).toFixed(0)}% width to clear reserved regions` });
          break;
        }
      }
      if (!b) {
        // No clear spot even at the smallest legible size: stay in the lower band, minimize overlap, say so.
        fits(1);
        const band: Box = { x: area.x, y: (0.5 + capTop - 0.015) / 2, w: area.w, h: capTop - 0.015 - 0.5 };
        const r = placeBox(w, h, prefer, band.h >= h ? band : area, avoid);
        b = r.box;
        if (r.overlap > 0) corrections.push({ code: 'unavoidable-overlap', msg: `lower third overlaps a reserved region by ${(r.overlap * 100).toFixed(2)}% of the frame; consider a smaller avoid region (face only)` });
      }
      // Single-line boxes get font-ascent headroom (platform fonts differ in ascent + descent).
      const nH = nameFit.lineH / H, rH = roleFit ? roleFit.lineH / H : 0;
      if (Math.abs(b.y - prefer.y) > 0.02) corrections.push({ code: 'placement', msg: `lower third placed at y=${b.y.toFixed(2)}` });
      const left = b.x - b.w / 2;
      const pw = b.w;
      layers.push({ id: 'panel', kind: 'rrect', x: b.x, y: b.y, w: pw, h, radius: P.radius, overlap: true,
        gradient: { type: 'linear', angle: 0, stops: [{ offset: 0, color: pal.panel }, { offset: 1, color: pal.panelEnd }] },
        ...(P.shadow && { shadow: { color: '#00000055', blur: 18, x: 0, y: 6 } }),
        reveal: { from: side === 'left' ? 'left' : 'right', at: 0, d: P.enter, e: P.ease }, keys: fade() });
      layers.push({ id: 'bar', kind: 'rrect', x: left + 0.012, y: b.y, w: Math.max(0.006, 10 / W), h: h * 0.7, radius: 3, fill: pal.accent, overlap: true, reveal: { from: 'top', at: beat(1), d: P.enter, e: P.ease }, keys: fade() });
      style('name', P.head, nameFit.size, pal.text);
      layers.push({ id: 'name', kind: 'text', text: name, style: 'name', align: 'left', x: left + 0.035 + (pw - 0.05) / 2, y: b.y - h / 2 + 0.012 + nH / 2, w: pw - 0.05, h: nH, overlap: true, render: 'canvas', anim: textAnim(beat(2)) });
      if (roleFit) {
        style('role', P.body, roleFit.size, pal.muted);
        layers.push({ id: 'role', kind: 'text', text: inp.subtitle!, style: 'role', align: 'left', x: left + 0.035 + (pw - 0.05) / 2, y: b.y - h / 2 + 0.018 + nH + rH / 2, w: pw - 0.05, h: rH, overlap: true, render: 'canvas', anim: textAnim(beat(4), 'line') });
      }
      break;
    }
    case 'callout': {
      const target = inp.target ?? bad('callout needs target {x,y}');
      const label = inp.label ?? inp.title ?? bad('callout needs label');
      const fit = fitText(label, P.body === 'regular' ? 'bold' : P.body, (portrait ? 0.5 : 0.3) * W, px(P.scale.label) * 2.6, px(P.scale.label * 1.15), 16, 2);
      const lines = fit.lines;
      const w = Math.min(portrait ? 0.56 : 0.34, (fit.size * 0.62 * Math.min(label.length, 28)) / W + 0.06);
      const h = (lines * fit.size * 1.22) / H + 0.03;
      // Prefer a spot toward the frame centre, ~0.16 away from the target, never covering it.
      const dx = target.x < 0.5 ? 1 : -1, dy = target.y < 0.5 ? 1 : -1;
      const ring: Box = { x: target.x, y: target.y, w: 0.09 * (portrait ? 1 : 0.5625), h: 0.09 * (portrait ? 0.5625 : 1) };
      const b = place(w, h, { x: target.x + dx * (w / 2 + 0.06), y: target.y + dy * 0.12 }, 'callout label', [ring]);
      // Leader from the target ring to the nearest edge of the label.
      const ex = Math.min(Math.max(target.x, b.x - w / 2), b.x + w / 2), ey = Math.min(Math.max(target.y, b.y - h / 2), b.y + h / 2);
      const minX = Math.min(target.x, ex), minY = Math.min(target.y, ey);
      const lw = Math.max(0.004, Math.abs(ex - target.x)), lh = Math.max(0.004, Math.abs(ey - target.y));
      const sx = target.x <= ex ? 0 : 100, sy = target.y <= ey ? 0 : 100;
      layers.push({ id: 'ring', kind: 'ellipse', x: target.x, y: target.y, w: ring.w * 0.5, h: ring.h * 0.5, fill: '#00000000', strokeWidth: 5, strokeColor: pal.line, overlap: true, render: 'canvas',
        keys: [{ t: 0, s: 0.4, o: 0 }, { t: P.enter * 0.8, s: 1, o: 1, e: P.ease }, { t: out, s: 1, o: 1 }, { t: Math.min(D - 0.05, out + 0.35), s: 1.3, o: 0, e: P.exit }] });
      layers.push({ id: 'leader', kind: 'path', x: minX + lw / 2, y: minY + lh / 2, w: lw, h: lh, view: { w: 100, h: 100 }, d: `M${sx} ${sy} L${100 - sx} ${100 - sy}`, stroke: 4, overlap: true, bleed: true,
        draw: [{ t: beat(1), from: 0, to: 0 }, { t: beat(1) + P.enter, from: 0, to: 1, e: P.ease }], keys: fade() });
      style('label', P.body === 'regular' ? 'bold' : P.body, fit.size, pal.accentText);
      layers.push({ id: 'label', kind: 'text', text: label, style: 'label', x: b.x, y: b.y, w, h, wrap: true, maxLines: 2, bg: pal.accent, pad: 12, radius: P.radius, overlap: true, render: 'canvas',
        reveal: { from: 'center', at: beat(2), d: P.enter, e: P.ease }, keys: fade() });
      styles.push({ id: 'leader', color: pal.line, font: 'regular', size: 20 });
      (layers[1] as Record<string, unknown>).style = 'leader';
      break;
    }
    case 'ui_demo': {
      const asset = inp.asset ?? bad('ui_demo needs an image asset (screenshot)');
      const clicks = inp.clicks ?? bad('ui_demo needs clicks [{x,y,t}] in screenshot fractions');
      const w = Math.min(area.w, portrait ? 0.86 : 0.74), h = Math.min(area.h * 0.8, portrait ? 0.42 : 0.7);
      const b = place(w, h, { x: area.x, y: portrait ? 0.4 : area.y }, 'screen');
      layers.push({ id: 'screen', kind: 'image', asset, x: b.x, y: b.y, w, h, fit: 'contain', radius: P.radius, ...(P.shadow && { shadow: { color: '#00000077', blur: 30, x: 0, y: 14 } }), keys: fade(0.8) });
      const toFrame = (c: { x: number; y: number }) => ({ x: b.x - w / 2 + c.x * w, y: b.y - h / 2 + c.y * h });
      const pts = clicks.map(toFrame);
      const start = { x: Math.min(area.x + area.w / 2 - 0.04, pts[0]!.x + 0.12), y: Math.min(area.y + area.h / 2 - 0.04, pts[0]!.y + 0.1) };
      const all = [start, ...pts];
      const d = all.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(4)} ${q.y.toFixed(4)}`).join(' ');
      // Arc-length progress at each click so the cursor arrives exactly at its click time.
      const segLen = all.slice(1).map((q, i) => Math.hypot((q.x - all[i]!.x) * W, (q.y - all[i]!.y) * H));
      const total = segLen.reduce((a, c) => a + c, 0) || 1;
      let acc = 0;
      const keys: { t: number; p: number; e?: Ease }[] = [{ t: 0, p: 0 }];
      clicks.forEach((c, i) => {
        acc += segLen[i]!;
        const t = Math.min(D - 0.1, Math.max(keys[keys.length - 1]!.t + 0.2, c.t - 0.15));
        keys.push({ t, p: acc / total, e: 'expoio' });
      });
      const cs = 0.045;
      layers.push({ id: 'cursor', kind: 'path', x: .5, y: .5, w: cs * (portrait ? 1 : 0.5625), h: cs * (portrait ? 0.5625 : 1), view: { w: 100, h: 100 },
        d: 'M10 5 L10 85 L32 64 L46 96 L60 90 L46 59 L76 59 Z', fill: '#FFFFFF', stroke: 3, overlap: true, bleed: true,
        ...(P.shadow && { shadow: { color: '#00000088', blur: 8, x: 0, y: 3 } }),
        motionPath: { d, keys }, keys: fade(0.6) });
      styles.push({ id: 'cursor', color: '#0F172A', font: 'regular', size: 20 });
      (layers[layers.length - 1] as Record<string, unknown>).style = 'cursor';
      clicks.forEach((c, i) => {
        const q = pts[i]!;
        const t0 = Math.max(0.05, Math.min(D - 0.5, c.t));
        layers.push({ id: `tap${i}`, kind: 'ellipse', x: q.x, y: q.y, w: 0.05 * (portrait ? 1 : 0.5625), h: 0.05 * (portrait ? 0.5625 : 1), fill: `${pal.accent}55`, strokeWidth: 4, strokeColor: pal.accent, overlap: true, render: 'canvas',
          start: t0, end: Math.min(D, t0 + 0.6), keys: [{ t: 0, s: 0.3, o: 0.9 }, { t: 0.55, s: 1.6, o: 0, e: 'expo' }] });
        if (c.label) {
          const fit = fitText(c.label, 'bold', 0.4 * W, px(P.scale.label) * 1.4, px(P.scale.label), 16, 1);
          const lw = (fit.size * 0.6 * c.label.length) / W + 0.05, lh = (fit.size * 1.22) / H + 0.02;
          // Keep the clicked control itself visible: clear a generous zone around the click point.
          const lb = place(lw, lh, { x: q.x, y: q.y - 0.09 }, `tap ${i} label`, [{ x: q.x, y: q.y, w: Math.min(0.3, w * 0.28), h: portrait ? 0.07 : 0.12 }]);
          style(`tl${i}`, 'bold', fit.size, pal.accentText);
          const end = Math.min(D, (clicks[i + 1]?.t ?? D) - 0.05);
          if (end - t0 > 0.3) layers.push({ id: `tl${i}`, kind: 'text', text: c.label, style: `tl${i}`, x: lb.x, y: lb.y, w: lw, h: lh, bg: pal.accent, pad: 8, radius: P.radius, overlap: true, render: 'canvas',
            start: t0, end, reveal: { from: 'center', at: 0, d: 0.3, e: P.ease } });
        }
      });
      break;
    }
    case 'animated_diagram': {
      const nodes = inp.nodes ?? bad('animated_diagram needs nodes');
      const n = nodes.length;
      const layout = inp.layout === 'auto' ? (portrait ? (n <= 4 ? 'column' : 'grid') : n <= 5 ? 'row' : 'grid') : inp.layout;
      const cols = layout === 'row' ? n : layout === 'column' ? 1 : Math.ceil(Math.sqrt(n * (portrait ? 0.6 : 1.6)));
      const rows = Math.ceil(n / cols);
      const reg = place(Math.min(area.w, portrait ? 0.84 : 0.8), Math.min(area.h * 0.85, portrait ? 0.5 : 0.62), { x: area.x, y: portrait ? 0.4 : area.y }, 'diagram');
      const gx = 0.04, gy = portrait ? 0.035 : 0.06;
      const nw = (reg.w - gx * (cols - 1)) / cols, nh = Math.min((reg.h - gy * (rows - 1)) / rows, portrait ? 0.08 : 0.16);
      const size = Math.min(...nodes.map((t) => fitText(t, 'bold', nw * W - 28, nh * H - 16, px(P.scale.label * 1.2), 14, 2).size));
      style('node', 'bold', size, pal.text);
      const centers = nodes.map((_, i) => {
        const r = Math.floor(i / cols), c = i % cols, inRow = Math.min(cols, n - r * cols);
        const rowW = inRow * nw + (inRow - 1) * gx;
        return { x: reg.x - rowW / 2 + nw / 2 + c * (nw + gx), y: reg.y - (rows * nh + (rows - 1) * gy) / 2 + nh / 2 + r * (nh + gy) };
      });
      const edges = inp.edges ?? nodes.slice(1).map((_, i) => [i, i + 1]);
      edges.forEach(([a, b2], k) => {
        if (a! >= n || b2! >= n) bad(`edge ${a}-${b2} references a missing node`);
        const A = centers[a!]!, B = centers[b2!]!;
        const x0 = Math.min(A.x, B.x), y0 = Math.min(A.y, B.y), ew = Math.max(0.004, Math.abs(B.x - A.x)), eh = Math.max(0.004, Math.abs(B.y - A.y));
        const sx = A.x <= B.x ? 0 : 100, sy = A.y <= B.y ? 0 : 100;
        const t0 = beat(2 + 2 * Math.max(a!, b2!) - 1);
        styles.push({ id: `e${k}`, color: pal.line, font: 'regular', size: 20 });
        layers.push({ id: `e${k}`, kind: 'path', style: `e${k}`, x: x0 + ew / 2, y: y0 + eh / 2, w: ew, h: eh, view: { w: 100, h: 100 }, d: `M${sx} ${sy} L${100 - sx} ${100 - sy}`, stroke: 4, overlap: true, bleed: true,
          draw: [{ t: t0, from: 0, to: 0 }, { t: t0 + P.enter, from: 0, to: 1, e: P.ease }], keys: fade() });
      });
      nodes.forEach((t, i) => {
        const q = centers[i]!;
        const t0 = beat(2 * i);
        layers.push({ id: `n${i}`, kind: 'rrect', x: q.x, y: q.y, w: nw, h: nh, radius: P.radius, overlap: true,
          gradient: { type: 'linear', angle: 135, stops: [{ offset: 0, color: pal.panel }, { offset: 1, color: pal.panelEnd }] }, strokeWidth: 3, strokeColor: pal.accent,
          start: t0, keys: [{ t: 0, s: 0.85, o: 0 }, { t: P.enter, s: 1, o: 1, e: P.ease }, { t: Math.max(P.enter + 0.01, out - t0), o: 1 }, { t: Math.max(P.enter + 0.02, Math.min(D - t0 - 0.05, out - t0 + 0.4)), o: 0, e: P.exit }] });
        layers.push({ id: `t${i}`, kind: 'text', text: t, style: 'node', x: q.x, y: q.y, w: nw - 0.02, h: nh - 0.01, wrap: true, maxLines: 2, overlap: true, render: 'canvas',
          start: t0, anim: { ...textAnim(0.1, 'word'), out: { at: Math.max(0.2, out - t0), stagger: 0.01, d: 0.35, e: P.exit, to: { o: 0 } } } });
      });
      break;
    }
    case 'dynamic_chart': {
      const chart = inp.chart ?? bad('dynamic_chart needs chart');
      const w = Math.min(area.w, portrait ? 0.84 : 0.66);
      const title = inp.title ? fitText(inp.title, P.head, w * W, px(P.scale.sub * 1.4) * 2.5, px(P.scale.sub * 1.4), 18, 2) : undefined;
      const tH = title ? (title.lines * title.size * 1.22) / H + 0.01 : 0;
      const ch = portrait ? 0.3 : 0.5;
      const b = place(w, tH + ch + 0.02, { x: area.x, y: portrait ? 0.4 : area.y }, 'chart block');
      const top = b.y - b.h / 2;
      if (title) {
        style('ctitle', P.head, title.size, pal.text);
        const tw = balancedWidth(inp.title!, P.head, title.size, w * W) / W;
        layers.push({ id: 'ctitle', kind: 'text', text: inp.title!, style: 'ctitle', x: b.x - (w - tw) / 2, y: top + tH / 2, w: tw, h: tH, wrap: true, maxLines: 2, align: 'left', render: 'canvas', anim: textAnim(0) });
      }
      const maxV = Math.max(...chart.data.map((d) => d.value));
      if (chart.highlight && !chart.data.some((d) => d.label === chart.highlight)) bad(`chart.highlight "${chart.highlight}" is not a data label`);
      // One datum carries the accent (the stated point, else the largest); the rest recede.
      const hot = (d: { label: string; value: number }) => (chart.highlight ? d.label === chart.highlight : d.value === maxV);
      const data = chart.data.map((d) => ({ label: d.label, value: d.value, color: hot(d) ? pal.accent : `${pal.muted}88` }));
      styles.push({ id: 'chart', color: pal.text, font: 'bold', size: Math.round(px(P.scale.label)) });
      layers.push({ id: 'chart', kind: 'chart', style: 'chart', chartType: chart.chartType, data, unit: chart.unit, ...(chart.max && { max: chart.max }), accent: pal.accent,
        x: b.x, y: top + tH + 0.02 + ch / 2, w, h: ch, overlap: true,
        draw: [{ t: beat(2), from: 0, to: 0 }, { t: beat(2) + Math.max(0.8, P.enter * 2), from: 0, to: 1, e: P.ease }], keys: fade() });
      break;
    }
  }

  const rawSpec = { v: 1 as const, at: inp.at, offset: 0, duration: D, ratio, z: inp.z, safe, styles, layers };
  const checked = visualSceneSchema.parse(rawSpec);
  if (!checked.ok) throw new TmepError('E_INTERNAL', `preset ${inp.kind} produced an invalid scene: ${formatIssues(checked.issues)}`);
  return { ops: [{ op: 'scene', spec: checked.value }], spec: checked.value, corrections };
}

function bad(msg: string): never {
  throw new TmepError('E_INPUT', msg);
}
