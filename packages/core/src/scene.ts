import { arr, bool, num, obj, oneOf, str, union, type Infer } from './schema.ts';
import { EASES } from './effects.ts';

const id = str({ min: 1, max: 64, pattern: /^[A-Za-z][\w-]*$/ });
const seconds = num({ min: 0, max: 60 });
const offset = num({ min: -2, max: 2 });
const color = str({ pattern: /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/ });
const timing = union([num({ min: 0 }), str({ min: 1, max: 160 })]);
const motion = {
  x: offset.optional(), y: offset.optional(), s: num({ min: .05, max: 5 }).optional(),
  r: num({ min: -360, max: 360 }).optional(),
};
// One easing vocabulary for effects, scenes and the FFmpeg/Canvas renderers.
const easing = oneOf(EASES).optional();
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
// Phase 4A motion: text animation, motion paths, shape morphs, reveals, depth, motion blur.
const unitPose = obj({
  o: fraction.optional(),
  x: num({ min: -20, max: 20 }).optional(), // em (font size) units
  y: num({ min: -20, max: 20 }).optional(),
  s: num({ min: 0, max: 5 }).optional(),
  r: num({ min: -360, max: 360 }).optional(),
});
const textAnim = obj({
  by: oneOf(['char', 'word', 'line'] as const).default('word'),
  at: seconds.default(0),
  stagger: num({ min: 0, max: 2 }).default(0.05),
  d: num({ min: 0.01, max: 10 }).default(0.5),
  e: easing,
  from: unitPose,
  out: obj({ at: seconds, stagger: num({ min: 0, max: 2 }).default(0.03), d: num({ min: 0.01, max: 10 }).default(0.35), e: easing, to: unitPose }).optional(),
});
const motionPath = obj({
  d: pathData,
  view: obj({ w: num({ min: .001, max: 10000 }), h: num({ min: .001, max: 10000 }) }).optional(),
  keys: arr(obj({ t: seconds, p: fraction, e: easing }), { min: 1, max: 12 }),
  orient: bool().default(false),
});
const reveal = obj({
  from: oneOf(['left', 'right', 'top', 'bottom', 'center'] as const).default('left'),
  at: seconds.default(0),
  d: num({ min: 0.01, max: 30 }).default(0.6),
  e: easing,
});
const morphKey = obj({ t: seconds, d: pathData, e: easing });

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
  /** Follow a path (frame coordinates by default); keys give arc-length progress over time. */
  motionPath: motionPath.optional(),
  /** Mask wipe/iris that reveals the layer. */
  reveal: reveal.optional(),
  /** 2.5D depth: 0 = picture plane; larger values move and zoom less with the camera (parallax). */
  depth: num({ min: 0, max: 20 }).default(0),
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
  /** Camera-shutter motion blur for Canvas layers: sub-frame samples averaged per frame. */
  mblur: obj({ samples: num({ int: true, min: 2, max: 8 }).default(4), shutter: num({ min: 0.05, max: 1 }).default(0.5) }).optional(),
  /** Depth of field for layers with `depth`: blur grows with distance from the focus depth. */
  focus: obj({ depth: num({ min: 0, max: 20 }).default(0), blur: num({ min: 0, max: 40 }).default(6) }).optional(),
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
      /** Per character / word / line animation (kinetic typography). */
      anim: textAnim.optional(),
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
      draw: arr(drawKey, { min: 1, max: 12 }).optional(),
      /** Shape morph targets: the path becomes each `d` at time `t` (structures may differ). */
      morph: arr(morphKey, { min: 1, max: 8 }).optional() }),
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
