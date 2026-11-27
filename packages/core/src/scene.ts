import { arr, bool, num, obj, oneOf, str, union, type Infer } from './schema.ts';

const id = str({ min: 1, max: 64, pattern: /^[A-Za-z][\w-]*$/ });
const seconds = num({ min: 0, max: 60 });
const offset = num({ min: -2, max: 2 });
const color = str({ pattern: /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/ });
const timing = union([num({ min: 0 }), str({ min: 1, max: 160 })]);
const motion = {
  x: offset.optional(), y: offset.optional(), s: num({ min: .05, max: 5 }).optional(),
  r: num({ min: -360, max: 360 }).optional(),
};
const easing = oneOf(['linear', 'in', 'out', 'io', 'back', 'spring', 'hold'] as const).optional();
const cameraKey = obj({ t: seconds, ...motion, e: easing });
const layerKey = obj({ t: seconds, ...motion, o: num({ min: 0, max: 1 }).optional(), e: easing });
const text = str({ min: 1, max: 800, pattern: /^[^\x00-\x09\x0b-\x1f\x7f]+$/ });
const fraction = num({ min: 0, max: 1 });
const inset = num({ min: 0, max: .49 });
// SVG path data: a moveto, then commands and numbers only. Skia parses and checks the grammar.
const pathData = str({ min: 2, max: 4000, pattern: /^\s*[Mm][MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]*$/ });
const drawKey = obj({ t: seconds, from: fraction.optional(), to: fraction.optional(), e: easing });

const gradient = obj({
  type: oneOf(['linear', 'radial'] as const).default('linear'),
  angle: num({ min: -360, max: 360 }).default(135),
  stops: arr(obj({ offset: fraction, color }), { min: 2, max: 8 }),
});
const shadow = obj({
  color: color.default('#00000066'),
  blur: num({ min: 0, max: 120 }).default(24),
  x: num({ min: -100, max: 100 }).default(0),
  y: num({ min: -100, max: 100 }).default(10),
});
const clipShape = obj({
  kind: oneOf(['rect', 'rrect', 'ellipse'] as const),
  radius: num({ min: 0, max: 500 }).default(16),
});

const layer = {
  id, group: id.optional(), style: id.optional(), start: seconds.default(0), end: seconds.optional(),
  x: offset.default(.5), y: offset.default(.5),
  w: num({ min: .001, max: 1 }), h: num({ min: .001, max: 1 }),
  opacity: fraction.default(1), rotation: motion.r.default(0),
  keys: arr(layerKey, { min: 1, max: 16 }).optional(),
  overlap: bool().default(false), bleed: bool().default(false),
  render: oneOf(['auto', 'ass', 'canvas'] as const).optional(),
  shadow: shadow.optional(),
  clip: clipShape.optional(),
};

const shapeProps = {
  fill: color.optional(),
  strokeColor: color.optional(),
  strokeWidth: num({ min: 0, max: 64 }).default(0),
  gradient: gradient.optional(),
};

const content = {
  safe: obj({ left: inset.default(0), top: inset.default(0), right: inset.default(0), bottom: inset.default(0) }).optional(),
  styles: arr(obj({
    id, color: color.default('#FFFFFF'), font: oneOf(['regular', 'bold', 'heavy'] as const).default('regular'),
    size: num({ min: 8, max: 300 }).default(48),
  }), { max: 24 }).optional(),
  groups: arr(obj({
    id, parent: id.optional(), x: offset.default(0), y: offset.default(0),
    s: num({ min: .05, max: 5 }).default(1), r: motion.r.default(0),
    opacity: fraction.default(1), stagger: seconds.default(0),
    keys: arr(layerKey, { min: 1, max: 12 }).optional(),
  }), { max: 24 }).optional(),
  camera: arr(cameraKey, { min: 1, max: 12 }).optional(),
  layers: arr(union([
    obj({
      ...layer, kind: oneOf(['text'] as const), text,
      align: oneOf(['left', 'center', 'right'] as const).default('center'),
      valign: oneOf(['top', 'middle', 'bottom'] as const).default('middle'),
      lineHeight: num({ min: 0.8, max: 2.5 }).default(1.22),
      wrap: bool().default(false),
      maxLines: num({ int: true, min: 1, max: 20 }).optional(),
      ellipsis: bool().default(false),
      bg: color.optional(),
      pad: num({ min: 0, max: 120 }).default(16),
      radius: num({ min: 0, max: 200 }).default(14),
      gradient: gradient.optional(),
    }),
    obj({ ...layer, kind: oneOf(['rect', 'ellipse'] as const), ...shapeProps }),
    obj({ ...layer, kind: oneOf(['rrect'] as const), radius: num({ min: 0, max: 500 }).default(24), ...shapeProps }),
    obj({ ...layer, kind: oneOf(['polygon'] as const),
      points: arr(obj({ x: fraction, y: fraction }), { min: 3, max: 24 }), ...shapeProps }),
    obj({ ...layer, kind: oneOf(['image', 'video'] as const), asset: id, in: seconds.default(0),
      fit: oneOf(['contain', 'cover'] as const).default('contain'),
      radius: num({ min: 0, max: 500 }).default(0) }),
    obj({
      ...layer, kind: oneOf(['chart'] as const),
      chartType: oneOf(['bar', 'hbar', 'line', 'ring'] as const),
      data: arr(obj({ label: str({ min: 1, max: 40 }), value: num({ min: 0, max: 1e9 }), color: color.optional() }), { min: 1, max: 16 }),
      max: num({ min: 0.001, max: 1e9 }).optional(),
      unit: str({ max: 16 }).default(''),
      accent: color.default('#70DAC4'),
      trackColor: color.default('#FFFFFF26'),
      draw: arr(drawKey, { min: 1, max: 12 }).optional(),
    }),
    // Vector path for the deterministic frame rasterizer. `draw` trims the stroke along its length.
    obj({ ...layer, kind: oneOf(['path'] as const), d: pathData,
      view: obj({ w: num({ min: .001, max: 10000 }), h: num({ min: .001, max: 10000 }) }).optional(),
      stroke: num({ min: 0, max: 64 }).default(6), fill: color.optional(), glow: num({ min: 0, max: 64 }).default(0),
      cap: oneOf(['round', 'butt', 'square'] as const).default('round'),
      draw: arr(drawKey, { min: 1, max: 12 }).optional() }),
  ]), { min: 1, max: 32 }),
};

export const visualSceneContent = obj(content);

/** The same strict contract is used for runtime input and agent schema discovery. */
export const visualSceneSchema = obj({
  v: oneOf([1] as const),
  at: timing,
  offset: num({ min: -60, max: 60 }).default(0),
  duration: num({ min: .01, max: 60 }),
  ratio: oneOf(['9:16', '16:9', '1:1', '4:5'] as const).optional(),
  z: num({ int: true, min: -100, max: 100 }).default(0),
  ...content,
});

export type VisualScene = Infer<typeof visualSceneSchema>;
export interface SceneEntry { id: string; spec: VisualScene }
