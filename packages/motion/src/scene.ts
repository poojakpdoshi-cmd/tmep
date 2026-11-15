import { createRequire } from 'node:module';
import {
  duration, formatIssues, KEY_PROPS, resolveAnchor, sampleKeys, TmepError, validateKeys, visualSceneSchema,
  type BRoll, type Effect, type Key, type Timeline, type TlWord, type VisualScene,
} from '../../core/src/index.ts';
import { AssDoc, escapeText, tagColor } from './ass.ts';
import { captionLayout, paginate } from './captions.ts';
import { resolveFont, type ResolvedFont } from './fonts.ts';
import { poly, rect, signedArea } from './icons.ts';
import { pathBounds, type DrawKey, type VectorLayer, type VectorRun } from './vector.ts';

export interface SceneGraphic { id: string; at: number; d: number; ass: string; fx: Effect[]; z: number; camera?: Effect[] }
export interface CompiledScenes { layers: SceneGraphic[]; media: BRoll[]; fonts: ResolvedFont[]; vectors: VectorRun[] }
export type SceneAssets = ReadonlyMap<string, { kind: string; dur: number }>;
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
type Parent = { x: number; y: number; opacity: number };
const origin: Parent = { x: 0, y: 0, opacity: 1 };
const require = createRequire(import.meta.url);
const bad = (message: string): never => { throw new TmepError('E_INPUT', message); };

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
function textFits(text: string, font: ResolvedFont, size: number, w: number, h: number): boolean {
  // Use the existing optional Canvas installation for glyph metrics, never to paint video frames.
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
  ctx.font = `${size}px "${font.name}"`;
  const lines = text.split('\n').map((line) => ctx.measureText(line));
  return lines.every((m) => Math.max(m.width, m.actualBoundingBoxLeft + m.actualBoundingBoxRight) <= w)
    && lines.reduce((sum, m) => sum + Math.max(size, m.fontBoundingBoxAscent + m.fontBoundingBoxDescent), 0) <= h;
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
        const value = { x: p.x + g.x, y: p.y + g.y, opacity: p.opacity * g.opacity };
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
          const fx = layerKeys(keys, layer.x - .5 + p.x, layer.y - .5 + p.y, layer.opacity * p.opacity);
          if (layer.rotation) {
            if (!fx.some((k) => k.r !== undefined)) {
              if (fx[0]?.t === 0) fx[0].r = layer.rotation;
              else fx.unshift({ t: 0, r: layer.rotation });
            }
            else for (const key of fx) if (key.r !== undefined) key.r += layer.rotation;
          }
          const style = layer.style ? styles.get(layer.style) ?? bad(`${name}: unknown style ${layer.style}`) : undefined;
          const width = layer.w * w, height = layer.h * h;
          const at = (first + from) / fps, d = (to - from) / fps;
          const id = `${entry.id}-${layer.id}`;
          const z = spec.z + (sceneIndex * 16 + layerIndex + 1) / 512;
          const effects: Effect[] = fx.length ? [{ type: 'kf', keys: fx }] : [];
          // The camera clock is scene-local, including time before this layer starts.
          const cameraFx: Effect[] | undefined = camera.length ? [{ type: 'kf', keys: camera.map((key) => ({ ...key, t: key.t - from / fps })) }] : undefined;
          if (layer.kind === 'image' || layer.kind === 'video') {
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
            paths.set(layerIndex, { id, z, layer: { id: layer.id, from, to, keys: fx, draw: layer.draw ?? [], d: layer.d, view,
              box: [width, height], stroke: layer.stroke, glow: layer.glow, color: style?.color ?? '#FFFFFF',
              ...(layer.fill && { fill: layer.fill }), cap: layer.cap } });
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
          return [{ layer, from, to, fx, box: corners(width, height) }];
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
          camera, sceneFrame: lo, layers: run.members.map((m) => ({ ...m, from: m.from - lo, to: m.to - lo })) });
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

function validateFrames(
  layers: { layer: Layer; from: number; to: number; fx: Key[]; box: Point[] }[], camera: Key[],
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
    for (const { layer, from, to, fx, box } of layers) {
      if (f < from || f >= to) continue;
      const sample = transform(fx, (f - from) / fps);
      if (sample.o <= .001) continue;
      const local = box.map((p) => transformPoint(p, sample, w, h));
      const screen = local.map((p) => transformPoint(p, view, w, h));
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
