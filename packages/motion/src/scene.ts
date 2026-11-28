import { createRequire } from 'node:module';
import {
  duration, formatIssues, KEY_PROPS, resolveAnchor, sampleKeys, TmepError, validateKeys, visualSceneSchema,
  type BRoll, type Effect, type Key, type Timeline, type TlWord, type VisualScene,
} from '../../core/src/index.ts';
import { AssDoc, escapeText, tagColor } from './ass.ts';
import { captionLayout, paginate } from './captions.ts';
import { resolveFont, type ResolvedFont } from './fonts.ts';
import { poly, rect, signedArea } from './icons.ts';
import { pathBounds, wrapMeasuredText, progressAt, type DrawKey, type VectorLayer, type VectorRun } from './vector.ts';
import { motionPolyline, pointAt, prepareMorph } from './paths.ts';

export interface SceneGraphic { id: string; at: number; d: number; ass: string; fx: Effect[]; z: number; camera?: Effect[] }
export interface CompiledScenes { layers: SceneGraphic[]; media: BRoll[]; fonts: ResolvedFont[]; vectors: VectorRun[] }
export type SceneAssets = ReadonlyMap<string, { kind: string; dur: number; path?: string }>;
export interface SceneDiagnostic {
  code: 'invalid' | 'clipping' | 'safe-area' | 'collision' | 'caption' | 'discontinuity';
  severity: 'error';
  scene: string;
  layers: string[];
  t: number | null;
  msg: string;
}
type Report = (code: SceneDiagnostic['code'], layers: string[], t: number | null, msg: string) => void;
type Point = [number, number];
type Layer = VisualScene['layers'][number];
type Sample = { x: number; y: number; s: number; r: number; o: number };
type Parent = { x: number; y: number; s: number; r: number; opacity: number };
const origin: Parent = { x: 0, y: 0, s: 1, r: 0, opacity: 1 };
const require = createRequire(import.meta.url);
const bad = (message: string): never => { throw new TmepError('E_INPUT', message); };
const chartFont = (weight?: 'regular' | 'bold' | 'heavy') => { const f = resolveFont(weight ?? 'bold'); return { fontName: f.name, ...(f.file && { fontFile: f.file }) }; };

function byId<T extends { id: string }>(values: T[], name: string): Map<string, T> {
  const map = new Map(values.map((value) => [value.id, value]));
  if (map.size !== values.length) bad(`duplicate ${name} ID`);
  return map;
}

function keysFor(input: Key[] | undefined, span: number, name: string, onJump: (t: number, msg: string) => void): Key[] {
  if (!input) return [];
  const keys = validateKeys(input);
  if (keys.some((k, i) => k.t >= span || k.t !== input[i]!.t)) bad(`${name}: keys must be ordered and inside the active interval`);
  for (const prop of KEY_PROPS) {
    const track = keys.filter((key) => key[prop] !== undefined);
    for (let i = 1; i < track.length; i++) {
      const key = track[i]!;
      if (key.e === 'hold' && key[prop] !== track[i - 1]![prop]) onJump(key.t, `${name}: ${prop} jumps at a hold key`);
    }
  }
  return keys;
}

function drawKeysFor(draw: DrawKey[], span: number, name: string, onJump: (t: number, msg: string) => void): void {
  draw.forEach((key, i) => {
    if (key.from === undefined && key.to === undefined) bad(`${name}: draw key at t=${key.t} sets neither from nor to`);
    if (key.t >= span || (i > 0 && key.t - draw[i - 1]!.t < 1e-3)) bad(`${name}: draw keys must be ordered and inside the active interval`);
  });
  for (const prop of ['from', 'to'] as const) {
    const track = draw.filter((key) => key[prop] !== undefined);
    for (let i = 1; i < track.length; i++) {
      if (track[i]!.e === 'hold' && track[i]![prop] !== track[i - 1]![prop]) onJump(track[i]!.t, `${name}: draw ${prop} jumps at a hold key`);
    }
  }
}

export function sceneRange(tl: Timeline, words: TlWord[], spec: VisualScene, onStart?: (time: number) => void): [number, number] {
  const { fps } = tl.settings;
  const start = resolveAnchor(tl, words, spec.at).t + spec.offset;
  onStart?.(start);
  const first = Math.round(start * fps), frames = Math.round(spec.duration * fps);
  if (start < 0 || frames < 1 || first + frames > Math.round(duration(tl) * fps)) bad('scene is outside the timeline');
  return [first / fps, (first + frames) / fps];
}

/** Keep the first occurrence of each finding and cap the amount of returned data. */
export function diagnoseScenes(tl: Timeline, words: TlWord[], assets: SceneAssets) {
  const issues: SceneDiagnostic[] = [];
  const seen = new Set<string>();
  let truncated = false;
  compileScenes(tl, words, assets, (issue) => {
    const key = JSON.stringify([issue.scene, issue.code, issue.layers, issue.code === 'invalid' ? issue.msg : '']);
    if (seen.has(key)) return;
    if (issues.length === 64) { truncated = true; return; }
    seen.add(key);
    issues.push(issue);
  });
  issues.sort((a, b) => (a.t ?? -1) - (b.t ?? -1));
  return { ok: issues.length === 0, issues, truncated: Boolean(truncated) };
}

function transform(keys: Key[], t: number): Sample {
  return { x: sampleKeys(keys, 'x', t), y: sampleKeys(keys, 'y', t), s: sampleKeys(keys, 's', t),
    r: sampleKeys(keys, 'r', t), o: sampleKeys(keys, 'o', t) };
}

function transformPoint([x, y]: Point, a: Sample, w: number, h: number): Point {
  const angle = a.r * Math.PI / 180;
  return [(x * Math.cos(angle) - y * Math.sin(angle)) * a.s + a.x * w,
    (x * Math.sin(angle) + y * Math.cos(angle)) * a.s + a.y * h];
}

function corners(w: number, h: number): Point[] {
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
}

/** Separating axes for the rectangular footprints, including rotated layers. Touching edges are safe. */
function intersects(a: Point[], b: Point[]): boolean {
  // Most boxes in a layout are disjoint on a screen axis. Skip the rotated-axis pass.
  const extent = (p: Point[], axis: 0 | 1) => {
    const v = p.map((q) => q[axis]);
    return [Math.min(...v), Math.max(...v)] as const;
  };
  for (const axis of [0, 1] as const) {
    const [a0, a1] = extent(a, axis), [b0, b1] = extent(b, axis);
    if (a1 <= b0 + 1e-5 || b1 <= a0 + 1e-5) return false;
  }
  for (const p of [a, b]) {
    for (let i = 0; i < 2; i++) {
      const x = p[i + 1]![1] - p[i]![1], y = p[i]![0] - p[i + 1]![0];
      const project = (q: Point[]) => q.map(([u, v]) => u * x + v * y);
      const l = project(a), r = project(b);
      if (Math.max(...l) <= Math.min(...r) + 1e-5 || Math.max(...r) <= Math.min(...l) + 1e-5) return false;
    }
  }
  return true;
}

function layerKeys(keys: Key[], x: number, y: number, o: number): Key[] {
  const base = Object.fromEntries(Object.entries({ x, y, o }).filter(([p, value]) => value !== (p === 'o' ? 1 : 0)));
  const seeded = Object.fromEntries(Object.entries(base).filter(([p]) => !keys.some((key) => key[p as keyof Key] !== undefined)));
  const result = keys.map((key) => ({ ...key,
    ...(key.x !== undefined && { x: key.x + x }), ...(key.y !== undefined && { y: key.y + y }),
    ...(key.o !== undefined && { o: key.o * o }),
  }));
  if (Object.keys(seeded).length) {
    if (result[0]?.t === 0) Object.assign(result[0], seeded);
    else result.unshift({ t: 0, ...seeded });
  }
  return result;
}

const metricFonts = new Set<string>();
function textFits(
  text: string,
  font: ResolvedFont,
  size: number,
  w: number,
  h: number,
  opts: { wrap?: boolean; lineHeight?: number; pad?: number; hasBg?: boolean; maxLines?: number; bold?: boolean } = {},
): boolean {
  let canvas: typeof import('@napi-rs/canvas');
  try {
    canvas = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
  } catch {
    throw new TmepError('E_INPUT', 'Visual Scene text validation requires the existing @napi-rs/canvas dependency');
  }
  if (font.file && !metricFonts.has(font.file)) {
    canvas.GlobalFonts.registerFromPath(font.file, font.name);
    metricFonts.add(font.file);
  }
  const ctx = canvas.createCanvas(1, 1).getContext('2d');
  // Measure with the weight the Canvas renderer draws with (bold styles are drawn at 700).
  ctx.font = `${opts.bold ? '700 ' : ''}${size}px "${font.name}"`;
  const availW = Math.max(8, w - (opts.hasBg ? (opts.pad ?? 16) * 2 : 0));
  const availH = Math.max(8, h - (opts.hasBg ? (opts.pad ?? 16) * 2 : 0));
  if (opts.wrap) {
    const wrapped = wrapMeasuredText(ctx, text, availW, opts.maxLines, false);
    const totalH = wrapped.length * size * (opts.lineHeight ?? 1.22);
    return totalH <= availH + 1;
  }
  const lines = text.split('\n').map((line) => ctx.measureText(line));
  return lines.every((m) => Math.max(m.width, m.actualBoundingBoxLeft + m.actualBoundingBoxRight) <= availW)
    && lines.reduce((sum, m) => sum + Math.max(size, m.fontBoundingBoxAscent + m.fontBoundingBoxDescent), 0) <= availH;
}

/** Compile agent scene specs to existing ASS layer and media overlay inputs. Throws before queueing edits on invalid scenes. */
export function compileScenes(tl: Timeline, words: TlWord[], assets: SceneAssets, onIssue?: (issue: SceneDiagnostic) => void): CompiledScenes {
  const out: CompiledScenes = { layers: [], media: [], fonts: [], vectors: [] };
  if (!tl.scenes?.length) return out;
  if (tl.scenes.length > 16) {
    const msg = 'a timeline supports at most 16 visual scenes';
    if (!onIssue) bad(msg);
    onIssue!({ scene: '*', code: 'invalid', severity: 'error', layers: [], t: null, msg });
    return out;
  }
  const { w, h, fps, ratio } = tl.settings;
  const cap = captionLayout(tl.captions, w, h);
  const pages = tl.captions.style === 'none' ? [] : paginate(words, tl.captions, cap.maxChars);
  const captionHalf = cap.size * (tl.captions.style === 'kinetic' ? 1.6 : 1.4);
  const captionBand = corners(w, captionHalf * 2).map(([x, y]): Point => [x, y + cap.y - h / 2]);
  for (const [sceneIndex, entry] of tl.scenes.entries()) {
    const report: Report = (code, layers, t, msg) => {
      if (!onIssue) bad(msg);
      onIssue!({ code, layers, t: t === null ? null : Math.round(t * 1000) / 1000, msg, severity: 'error', scene: entry.id });
    };
    let sceneStart: number | null = null;
    try {
      const parsed = visualSceneSchema.parse(entry.spec);
      if (!parsed.ok) {
        if (!onIssue) bad(`${entry.id}: ${formatIssues(parsed.issues)}`);
        for (const issue of parsed.issues) {
          const i = /^layers\[(\d+)\]/.exec(issue.path)?.[1];
          const id = i === undefined ? undefined : entry.spec?.layers?.[Number(i)]?.id;
          report('invalid', typeof id === 'string' ? [id] : [], null, `${issue.path}: ${issue.msg}`);
        }
        continue;
      }
      const spec = parsed.value;
      if (spec.ratio && spec.ratio !== ratio) bad(`${entry.id}: scene aspect ratio does not match timeline`);
      const [start, end] = sceneRange(tl, words, spec, (time) => { sceneStart = time; });
      const first = Math.round(start * fps), frames = Math.round((end - start) * fps);
      const styles = byId(spec.styles ?? [], 'style');
      const groups = byId(spec.groups ?? [], 'group');
      byId(spec.layers, 'layer');
      const parents = new Map<string, Parent>();
      const children = new Map<string, number>();
      function parent(id: string | undefined, stack: string[] = []): Parent {
        if (!id) return origin;
        const saved = parents.get(id);
        if (saved) return saved;
        const g = groups.get(id) ?? bad(`unknown group ${id}`);
        if (stack.includes(id)) bad(`cyclic group ${id}`);
        const p = parent(g.parent, [...stack, id]);
        const value = { x: p.x + g.x, y: p.y + g.y, s: p.s * (g.s ?? 1), r: p.r + (g.r ?? 0), opacity: p.opacity * g.opacity };
        parents.set(id, value);
        return value;
      }
      for (const id of groups.keys()) parent(id);
      const camera = keysFor(spec.camera, frames / fps, `${entry.id} camera`,
        (t, msg) => report('discontinuity', [], start + t, msg));
      const safe = spec.safe ?? { left: 0, right: 0, top: 0, bottom: 0 };
      const safeBox = { l: (safe.left - .5) * w, r: (.5 - safe.right) * w,
        t: (safe.top - .5) * h, b: (.5 - safe.bottom) * h };
      if (safeBox.l >= safeBox.r || safeBox.t >= safeBox.b) bad(`${entry.id}: empty safe area`);
      const firstCaption = pages.find((page) => page.s < end && page.e > start);
      if (firstCaption &&
          (cap.y - captionHalf < safe.top * h || cap.y + captionHalf > (1 - safe.bottom) * h)) {
        report('caption', [], Math.max(start, firstCaption.s), `${entry.id}: captions outside vertical safe area`);
      }
      // Path layers in scene frames, by layer index; consecutive ones share one raster overlay.
      const paths = new Map<number, { layer: VectorLayer; id: string; z: number }>();
      const layers = spec.layers.flatMap((layer, layerIndex) => {
        let layerStart = start + layer.start;
        try {
          const name = `${entry.id}/${layer.id}`;
          const p = parent(layer.group);
          const index = layer.group ? (children.get(layer.group) ?? 0) : 0;
          if (layer.group) children.set(layer.group, index + 1);
          const stagger = layer.group ? groups.get(layer.group)!.stagger * index : 0;
          const from = Math.round((layer.start + stagger) * fps);
          const to = layer.end === undefined ? frames : Math.round((layer.end + stagger) * fps);
          layerStart = (first + from) / fps;
          if (from >= to || to > frames) bad(`${name}: invalid layer interval after stagger`);
          const keys = keysFor(layer.keys, (to - from) / fps, name,
            (t, msg) => report('discontinuity', [layer.id], layerStart + t, msg));
          if (layer.kind === 'video' && (layer.motionPath || layer.reveal || layer.depth)) bad(`${name}: motionPath, reveal and depth are Canvas features; not available on video layers`);
          // A motion path positions the layer centre; keys and groups still add offsets to it.
          const fx = layer.motionPath
            ? layerKeys(keys, p.x, p.y, layer.opacity * p.opacity)
            : layerKeys(keys, layer.x - .5 + p.x, layer.y - .5 + p.y, layer.opacity * p.opacity);
          let motion: VectorLayer['motion'];
          if (layer.motionPath) {
            const mp = layer.motionPath;
            for (let i = 1; i < mp.keys.length; i++) if (mp.keys[i]!.t <= mp.keys[i - 1]!.t) bad(`${name}: motionPath keys must have increasing t`);
            try {
              motion = { poly: motionPolyline(mp.d), view: [mp.view?.w ?? 1, mp.view?.h ?? 1], keys: mp.keys, orient: mp.orient };
            } catch (err) { bad(`${name}: motionPath ${(err as Error).message}`); }
          }
          const motionFields = {
            ...(motion && { motion }),
            ...(layer.reveal && { reveal: layer.reveal }),
            ...(layer.depth ? { depth: layer.depth } : {}),
          };
          if (p.s !== 1) {
            if (!fx.some((k) => k.s !== undefined)) {
              if (fx[0]?.t === 0) fx[0].s = p.s;
              else fx.unshift({ t: 0, s: p.s });
            } else for (const key of fx) if (key.s !== undefined) key.s *= p.s;
          }
          const totalRot = (layer.rotation ?? 0) + p.r;
          if (totalRot) {
            if (!fx.some((k) => k.r !== undefined)) {
              if (fx[0]?.t === 0) fx[0].r = totalRot;
              else fx.unshift({ t: 0, r: totalRot });
            }
            else for (const key of fx) if (key.r !== undefined) key.r += totalRot;
          }
          const style = layer.style ? styles.get(layer.style) ?? bad(`${name}: unknown style ${layer.style}`) : undefined;
          const width = layer.w * w, height = layer.h * h;
          const at = (first + from) / fps, d = (to - from) / fps;
          const id = `${entry.id}-${layer.id}`;
          const z = spec.z + (sceneIndex * 16 + layerIndex + 1) / 512;
          const effects: Effect[] = fx.length ? [{ type: 'kf', keys: fx }] : [];
          // The camera clock is scene-local, including time before this layer starts.
          const cameraFx: Effect[] | undefined = camera.length ? [{ type: 'kf', keys: camera.map((key) => ({ ...key, t: key.t - from / fps })) }] : undefined;
          const usesCanvas = layer.render === 'canvas'
            || Boolean(layer.motionPath || layer.reveal || layer.depth)
            // Motion blur is a Canvas feature: moving shapes and text use the Canvas path when it is on.
            || Boolean(spec.mblur && layer.keys?.length && layer.kind !== 'image' && layer.kind !== 'video')
            || (layer.kind === 'text' && Boolean(layer.anim))
            || layer.kind === 'path'
            || layer.kind === 'rrect'
            || layer.kind === 'chart'
            || Boolean(layer.shadow || layer.clip)
            || (layer.kind === 'text' && Boolean(layer.wrap || layer.bg || layer.gradient || layer.align !== 'center'))
            || ((layer.kind === 'rect' || layer.kind === 'ellipse' || layer.kind === 'polygon') && Boolean(layer.gradient || layer.strokeWidth > 0))
            || (layer.kind === 'image' && layer.radius > 0);

          if (layer.kind === 'image' && usesCanvas) {
            const asset = assets.get(layer.asset);
            if (!asset || asset.kind !== 'image' || !asset.path) bad(`${name}: expected a registered image asset ${layer.asset}`);
            paths.set(layerIndex, {
              id, z,
              layer: {
                id: layer.id, kind: 'image', from, to, keys: fx, draw: [], box: [width, height],
                stroke: 0, glow: 0, color: '#FFFFFF', cap: 'round',
                imagePath: asset!.path!, imageFit: layer.fit, radius: layer.radius,
                ...(layer.shadow && { shadow: layer.shadow }), ...(layer.clip && { clip: layer.clip }), ...motionFields,
              },
            });
          } else if (layer.kind === 'image' || layer.kind === 'video') {
            const asset = assets.get(layer.asset);
            if (asset?.kind !== layer.kind) bad(`${name}: expected a registered ${layer.kind} asset ${layer.asset}`);
            if (layer.kind === 'video' && layer.in + d > asset!.dur + .001) bad(`${name}: overlay exceeds source duration`);
            out.media.push({ id, src: layer.asset, in: layer.in, ref: { at }, d, fit: 'contain', fx: effects, z,
              scene: { w: layer.w, h: layer.h, ...(cameraFx && { camera: cameraFx }) } });
          } else if (layer.kind === 'path') {
            const view: [number, number] = [layer.view?.w ?? 100, layer.view?.h ?? 100];
            const [l, t, r, b] = pathBounds(layer.d);
            const tol = 1e-6 * Math.max(...view);
            if (l < -tol || t < -tol || r > view[0] + tol || b > view[1] + tol) {
              report('clipping', [layer.id], at, `${name}: path leaves its view box`);
            }
            if (layer.draw) drawKeysFor(layer.draw, d, name, (kt, msg) => report('discontinuity', [layer.id], at + kt, msg));
            let morph: VectorLayer['morph'];
            if (layer.morph) {
              for (let i = 0; i < layer.morph.length; i++) {
                if (layer.morph[i]!.t <= (i ? layer.morph[i - 1]!.t : 0)) bad(`${name}: morph keys need increasing t > 0`);
                if (layer.morph[i]!.t > d + 1e-6) bad(`${name}: morph key at ${layer.morph[i]!.t}s is after the layer ends`);
              }
              try {
                const shapes = prepareMorph([layer.d, ...layer.morph.map((m) => m.d)]);
                morph = [{ t: 0, shape: shapes[0]! }, ...layer.morph.map((m, i) => ({ t: m.t, ...(m.e && { e: m.e }), shape: shapes[i + 1]! }))];
              } catch (err) { bad(`${name}: morph ${(err as Error).message}`); }
            }
            paths.set(layerIndex, { id, z, layer: { id: layer.id, kind: 'path', from, to, keys: fx, draw: layer.draw ?? [], d: layer.d, view,
              box: [width, height], stroke: layer.stroke, glow: layer.glow, color: style?.color ?? '#FFFFFF',
              ...(layer.fill && { fill: layer.fill }), cap: layer.cap,
              ...(layer.shadow && { shadow: layer.shadow }), ...(layer.clip && { clip: layer.clip }), ...(morph && { morph }), ...motionFields } });
          } else if (layer.kind === 'chart') {
            if (layer.draw) drawKeysFor(layer.draw, d, name, (kt, msg) => report('discontinuity', [layer.id], at + kt, msg));
            paths.set(layerIndex, {
              id, z,
              layer: {
                id: layer.id, kind: 'chart', from, to, keys: fx, draw: layer.draw ?? [],
                box: [width, height], stroke: 0, glow: 0, color: style?.color ?? '#FFFFFF', cap: 'round',
                chartSpec: { chartType: layer.chartType, data: layer.data, max: layer.max, unit: layer.unit, accent: layer.accent, trackColor: layer.trackColor, ...chartFont(style?.font) },
                ...(layer.shadow && { shadow: layer.shadow }), ...(layer.clip && { clip: layer.clip }), ...motionFields,
              },
            });
          } else if (usesCanvas) {
            if (layer.kind === 'text') {
              const font = resolveFont(style?.font ?? 'regular');
              const fontSize = Math.round(style?.size ?? 48);
              if (!textFits(layer.text, font, fontSize, width, height, { wrap: layer.wrap, lineHeight: layer.lineHeight, pad: layer.pad, hasBg: Boolean(layer.bg), maxLines: layer.maxLines, bold: style?.font !== 'regular' })) {
                report('clipping', [layer.id], at, `${name}: text clips its box`);
              }
              paths.set(layerIndex, {
                id, z,
                layer: {
                  id: layer.id, kind: 'text', from, to, keys: fx, draw: [], box: [width, height],
                  stroke: 0, glow: 0, color: style?.color ?? '#FFFFFF', cap: 'round',
                  ...(layer.gradient && { gradient: layer.gradient }),
                  ...(layer.shadow && { shadow: layer.shadow }), ...(layer.clip && { clip: layer.clip }), ...motionFields,
                  ...(layer.anim && { textAnim: layer.anim }),
                  textSpec: {
                    text: layer.text, fontName: font.name, fontFile: font.file, fontSize,
                    bold: style?.font !== 'regular', align: layer.align, valign: layer.valign,
                    lineHeight: layer.lineHeight, wrap: layer.wrap, maxLines: layer.maxLines, ellipsis: layer.ellipsis,
                    bg: layer.bg, pad: layer.pad, radius: layer.radius,
                  },
                },
              });
            } else if (layer.kind === 'rect' || layer.kind === 'rrect' || layer.kind === 'ellipse' || layer.kind === 'polygon') {
              if (layer.kind === 'polygon') {
                const points = layer.points.map(({ x, y }): Point => [x * width, y * height]);
                if (Math.abs(signedArea(points)) < .1) bad(`${name}: degenerate polygon`);
              }
              paths.set(layerIndex, {
                id, z,
                layer: {
                  id: layer.id, kind: layer.kind, from, to, keys: fx, draw: [], box: [width, height],
                  stroke: layer.strokeWidth, glow: 0, color: layer.strokeColor ?? style?.color ?? '#FFFFFF',
                  fill: layer.fill ?? style?.color, cap: 'round',
                  ...(layer.kind === 'rrect' && { radius: layer.radius }),
                  ...(layer.kind === 'polygon' && { points: layer.points.map(({ x, y }): [number, number] => [x, y]) }),
                  ...(layer.gradient && { gradient: layer.gradient }),
                  ...(layer.shadow && { shadow: layer.shadow }), ...(layer.clip && { clip: layer.clip }), ...motionFields,
                },
              });
            }
          } else {
            const doc = new AssDoc(w, h);
            const font = layer.kind === 'text' ? resolveFont(style?.font ?? 'regular') : { name: 'Arial' };
            if (layer.kind === 'text' && !out.fonts.some((f) => f.name === font.name)) out.fonts.push(font);
            const fontSize = Math.round(style?.size ?? 48);
            const styleName = doc.style({ name: 'Scene', font: font.name, size: fontSize, align: 5, outlineW: 0, shadow: 0 });
            const color = tagColor(style?.color ?? '#FFFFFF');
            let text: string;
            if (layer.kind === 'text') {
              if (!textFits(layer.text, font, fontSize, width, height)) report('clipping', [layer.id], at, `${name}: text clips its box`);
              text = `{\\an5\\pos(${w / 2},${h / 2})\\c${color}}${escapeText(layer.text)}`;
            } else {
              const points = layer.kind === 'polygon' ? layer.points.map(({ x, y }): Point => [x * width, y * height])
                : Array.from({ length: 40 }, (_, i): Point => [width / 2 * (1 + Math.cos(i * Math.PI / 20)), height / 2 * (1 + Math.sin(i * Math.PI / 20))]);
              if (layer.kind === 'polygon' && Math.abs(signedArea(points)) < .1) bad(`${name}: degenerate polygon`);
              const drawing = layer.kind === 'rect' ? rect(0, 0, width, height) : poly(points);
              text = `{\\an7\\pos(${(w - width) / 2},${(h - height) / 2})\\p1\\c${color}}${drawing}{\\p0}`;
            }
            doc.add({ start: 0, end: d, style: styleName, text });
            out.layers.push({ id, at, d, ass: doc.toString(), fx: effects, z, ...(cameraFx && { camera: cameraFx }) });
          }
          return [{ layer, from, to, fx, box: corners(width, height), ...(motion && { motion }) }];
        } catch (e) {
          if (!onIssue || !(e instanceof TmepError)) throw e;
          report('invalid', [layer.id], layerStart, e.message);
          return [];
        }
      });
      // One raster overlay per run of consecutive path layers keeps draw order and z between other layers.
      let run: { id: string; z: number; members: VectorLayer[] } | undefined;
      const flush = () => {
        if (!run) return;
        const lo = Math.min(...run.members.map((m) => m.from)), hi = Math.max(...run.members.map((m) => m.to));
        out.vectors.push({ id: run.id, at: (first + lo) / fps, d: (hi - lo) / fps, frames: hi - lo, z: run.z, w, h, fps,
          camera, sceneFrame: lo, layers: run.members.map((m) => ({ ...m, from: m.from - lo, to: m.to - lo })),
          ...(spec.mblur && { mblur: spec.mblur }), ...(spec.focus && { focus: spec.focus }) });
        run = undefined;
      };
      for (let i = 0; i < spec.layers.length; i++) {
        const p = paths.get(i);
        if (!p) { flush(); continue; }
        run ??= { id: p.id, z: p.z, members: [] };
        run.members.push(p.layer);
      }
      flush();
      validateFrames(layers, camera, frames, fps, w, h, safeBox, captionBand, pages, first, report);
    } catch (e) {
      if (!onIssue || !(e instanceof TmepError)) throw e;
      report('invalid', [], sceneStart, e.message);
    }
  }
  return out;
}

/** Deterministically auto-correct safe layout defects (safe-area, caption overlap, text overflow) without silently altering intent. */
export function autoCorrectScenes(
  tl: Timeline,
  words: TlWord[],
  assets: SceneAssets,
): {
  tl: Timeline;
  corrections: { scene: string; layer: string; code: string; msg: string }[];
  unresolved: SceneDiagnostic[];
} {
  const cloned = JSON.parse(JSON.stringify(tl)) as Timeline;
  const corrections: { scene: string; layer: string; code: string; msg: string }[] = [];
  if (!cloned.scenes?.length) return { tl: cloned, corrections, unresolved: [] };

  const { w, h } = cloned.settings;
  const cap = captionLayout(cloned.captions, w, h);
  const capHalf = cap.size * (cloned.captions.style === 'kinetic' ? 1.6 : 1.4);

  for (let pass = 0; pass < 5; pass++) {
    const diag = diagnoseScenes(cloned, words, assets);
    if (diag.ok) return { tl: cloned, corrections, unresolved: [] };
    let changed = false;
    for (const issue of diag.issues) {
      const entry = cloned.scenes.find((s) => s.id === issue.scene);
      if (!entry) continue;
      const spec = entry.spec;
      const safe = spec.safe ?? { left: 0, top: 0, right: 0, bottom: 0 };
      for (const lid of issue.layers) {
        const layer = spec.layers.find((l) => l.id === lid);
        if (!layer) continue;
        if (issue.code === 'safe-area') {
          const minX = safe.left + layer.w / 2 + 0.005;
          const maxX = 1 - safe.right - layer.w / 2 - 0.005;
          const minY = safe.top + layer.h / 2 + 0.005;
          const maxY = 1 - safe.bottom - layer.h / 2 - 0.005;
          const nx = minX <= maxX ? Math.min(maxX, Math.max(minX, layer.x)) : layer.x;
          const ny = minY <= maxY ? Math.min(maxY, Math.max(minY, layer.y)) : layer.y;
          if (nx !== layer.x || ny !== layer.y) {
            layer.x = nx;
            layer.y = ny;
            changed = true;
            corrections.push({ scene: entry.id, layer: lid, code: 'safe-area', msg: `clamped ${lid} inside safe area` });
          }
        } else if (issue.code === 'caption') {
          const capNormY = cap.y / h;
          const capNormH = capHalf / h;
          const aboveY = capNormY - capNormH - layer.h / 2 - 0.02;
          const belowY = capNormY + capNormH + layer.h / 2 + 0.02;
          const minY = safe.top + layer.h / 2 + 0.005;
          const maxY = 1 - safe.bottom - layer.h / 2 - 0.005;
          if (aboveY >= minY) {
            layer.y = aboveY;
            changed = true;
            corrections.push({ scene: entry.id, layer: lid, code: 'caption', msg: `shifted ${lid} above caption band` });
          } else if (belowY <= maxY) {
            layer.y = belowY;
            changed = true;
            corrections.push({ scene: entry.id, layer: lid, code: 'caption', msg: `shifted ${lid} below caption band` });
          }
        } else if (issue.code === 'clipping' && layer.kind === 'text') {
          if (!layer.wrap) {
            layer.wrap = true;
            changed = true;
            corrections.push({ scene: entry.id, layer: lid, code: 'clipping', msg: `enabled measured text wrap on ${lid}` });
          } else if (layer.style && spec.styles) {
            const st = spec.styles.find((s) => s.id === layer.style);
            if (st && st.size > 18) {
              st.size = Math.max(18, Math.round(st.size * 0.85));
              changed = true;
              corrections.push({ scene: entry.id, layer: lid, code: 'clipping', msg: `reduced style ${st.id} size to ${st.size}px` });
            }
          }
        }
      }
    }
    if (!changed) break;
  }
  const finalDiag = diagnoseScenes(cloned, words, assets);
  return { tl: cloned, corrections, unresolved: finalDiag.issues };
}

function validateFrames(
  layers: { layer: Layer; from: number; to: number; fx: Key[]; box: Point[]; motion?: VectorLayer['motion'] }[], camera: Key[],
  frames: number, fps: number, w: number, h: number, safe: { l: number; r: number; t: number; b: number },
  band: Point[], pages: { s: number; e: number }[], first: number, report: Report,
): void {
  let page = 0;
  for (let f = 0; f < frames; f++) {
    const time = (first + f) / fps;
    while (pages[page] && pages[page]!.e <= time) page++;
    const hasCaption = !!pages[page] && pages[page]!.s <= time;
    const view = transform(camera, f / fps);
    const active: { layer: Layer; box: Point[] }[] = [];
    for (const { layer, from, to, fx, box, motion } of layers) {
      if (f < from || f >= to) continue;
      const sample = transform(fx, (f - from) / fps);
      if (sample.o <= .001) continue;
      if (motion) {
        // Check the layer where it actually travels along its motion path.
        const { pt } = pointAt(motion.poly, progressAt(motion.keys, (f - from) / fps));
        sample.x += pt[0] / motion.view[0] - .5;
        sample.y += pt[1] / motion.view[1] - .5;
      }
      const k = 1 / (1 + (layer.depth ?? 0));
      const cam = k === 1 ? view : { ...view, x: view.x * k, y: view.y * k, s: 1 + (view.s - 1) * k };
      const local = box.map((p) => transformPoint(p, sample, w, h));
      const screen = local.map((p) => transformPoint(p, cam, w, h));
      const within = (pts: Point[], l: number, r: number, t: number, b: number) =>
        pts.every(([x, y]) => x >= l - .01 && x <= r + .01 && y >= t - .01 && y <= b + .01);
      if (!layer.bleed && (!within(local, -w / 2, w / 2, -h / 2, h / 2) || !within(screen, safe.l, safe.r, safe.t, safe.b))) {
        report('safe-area', [layer.id], time, `${layer.id}: outside the frame or safe area at ${time.toFixed(3)}s`);
      }
      if (hasCaption && !layer.overlap && intersects(screen, band)) report('caption', [layer.id], time, `${layer.id}: overlaps the caption band at ${time.toFixed(3)}s`);
      if (!layer.overlap && (layer.kind === 'rect' || layer.kind === 'text')) {
        for (const other of active) if (intersects(screen, other.box)) {
          report('collision', [other.layer.id, layer.id], time, `${layer.id} and ${other.layer.id}: collision at ${time.toFixed(3)}s`);
        }
        active.push({ layer, box: screen });
      }
    }
  }
}
