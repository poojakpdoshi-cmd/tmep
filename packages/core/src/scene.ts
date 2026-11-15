import { arr, bool, num, obj, oneOf, str, union, type Infer } from './schema.ts';

const id = str({ min: 1, max: 64, pattern: /^[A-Za-z][\w-]*$/ });
const seconds = num({ min: 0, max: 60 });
const offset = num({ min: -2, max: 2 });
const color = str({ pattern: /^#[0-9a-fA-F]{6}$/ });
const timing = union([num({ min: 0 }), str({ min: 1, max: 160 })]);
const motion = {
  x: offset.optional(), y: offset.optional(), s: num({ min: .05, max: 5 }).optional(),
  r: num({ min: -360, max: 360 }).optional(),
};
const easing = oneOf(['linear', 'in', 'out', 'io', 'hold'] as const).optional();
const cameraKey = obj({ t: seconds, ...motion, e: easing });
const layerKey = obj({ t: seconds, ...motion, o: num({ min: 0, max: 1 }).optional(), e: easing });
const text = str({ min: 1, max: 240, pattern: /^[^\x00-\x09\x0b-\x1f\x7f]+$/ });
const fraction = num({ min: 0, max: 1 });
const inset = num({ min: 0, max: .49 });
// SVG path data: a moveto, then commands and numbers only. Skia parses and checks the grammar.
const pathData = str({ min: 2, max: 4000, pattern: /^\s*[Mm][MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]*$/ });
const drawKey = obj({ t: seconds, from: fraction.optional(), to: fraction.optional(), e: easing });
const layer = {
  id, group: id.optional(), style: id.optional(), start: seconds.default(0), end: seconds.optional(),
  x: offset.default(.5), y: offset.default(.5),
  w: num({ min: .001, max: 1 }), h: num({ min: .001, max: 1 }),
  opacity: fraction.default(1), rotation: motion.r.default(0),
  keys: arr(layerKey, { min: 1, max: 12 }).optional(),
  overlap: bool().default(false), bleed: bool().default(false),
};

/** The same strict contract is used for runtime input and agent schema discovery. */
export const visualSceneSchema = obj({
  v: oneOf([1] as const),
  at: timing,
  offset: num({ min: -60, max: 60 }).default(0),
  duration: num({ min: .01, max: 60 }),
  ratio: oneOf(['9:16', '16:9', '1:1', '4:5'] as const).optional(),
  z: num({ int: true, min: -100, max: 100 }).default(0),
  safe: obj({ left: inset.default(0), top: inset.default(0), right: inset.default(0), bottom: inset.default(0) }).optional(),
  styles: arr(obj({
    id, color: color.default('#FFFFFF'), font: oneOf(['regular', 'bold', 'heavy'] as const).default('regular'),
    size: num({ min: 8, max: 300 }).default(48),
  }), { max: 16 }).optional(),
  groups: arr(obj({ id, parent: id.optional(), x: offset.default(0), y: offset.default(0),
    opacity: fraction.default(1), stagger: seconds.default(0) }), { max: 16 }).optional(),
  camera: arr(cameraKey, { min: 1, max: 12 }).optional(),
  layers: arr(union([
    obj({ ...layer, kind: oneOf(['text'] as const), text }),
    obj({ ...layer, kind: oneOf(['rect', 'ellipse'] as const) }),
    obj({ ...layer, kind: oneOf(['polygon'] as const),
      points: arr(obj({ x: fraction, y: fraction }), { min: 3, max: 24 }) }),
    obj({ ...layer, kind: oneOf(['image', 'video'] as const), asset: id, in: seconds.default(0) }),
    // Vector path for the deterministic frame rasterizer. `draw` trims the stroke along its length.
    obj({ ...layer, kind: oneOf(['path'] as const), d: pathData,
      view: obj({ w: num({ min: .001, max: 10000 }), h: num({ min: .001, max: 10000 }) }).optional(),
      stroke: num({ min: 0, max: 64 }).default(6), fill: color.optional(), glow: num({ min: 0, max: 64 }).default(0),
      cap: oneOf(['round', 'butt', 'square'] as const).default('round'),
      draw: arr(drawKey, { min: 1, max: 12 }).optional() }),
  ]), { min: 1, max: 16 }),
});

export type VisualScene = Infer<typeof visualSceneSchema>;
export interface SceneEntry { id: string; spec: VisualScene }
