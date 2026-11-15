import { arr, num, obj, oneOf, str, union, TmepError, visualSceneSchema, visualSceneContent } from '../../core/src/index.ts';

const label = str({ min: 1, max: 32, pattern: /^(?=.*\S)[^\x00-\x1f\x7f]+$/ });
const timing = {
  frames: num({ int: true, min: 6, max: 1800 }),
  transition: oneOf(['cut', 'fade'] as const).default('cut'),
};

export const storyboardSchema = obj({
  v: oneOf([1] as const),
  script: str({ min: 1, max: 20000, pattern: /\S/ }),
  narration: str({ pattern: /^a[1-9]\d*$/ }).optional(),
  scenes: arr(union([
    obj({ ...timing, template: oneOf(['process'] as const), title: label, steps: arr(label, { min: 2, max: 3 }) }),
    obj({ ...timing, template: oneOf(['explanation'] as const), title: label, point: label }),
    obj({ ...timing, template: oneOf(['custom'] as const), visual: visualSceneContent }),
  ]), { min: 1, max: 16 }),
});

export const STORYBOARD_FPS = 30;

export function compileStoryboard(input: unknown) {
  const parsed = storyboardSchema.parse(input);
  if (!parsed.ok) throw new TmepError('E_INPUT', parsed.issues.map(({ path, msg }) => `${path}: ${msg}`).join('; '));
  let frames = 0;
  const scenes = parsed.value.scenes.map((scene, i) => {
    const at = frames / STORYBOARD_FPS;
    frames += scene.frames;
    const duration = scene.frames / STORYBOARD_FPS;
    const beat = Math.min(.4, duration / 5);
    const enter = () => [{ t: 0, y: -.02, o: 0 }, { t: beat, y: 0, o: 1, e: 'out' }];
    const text = (id: string, value: string, y: number, start = 0) =>
      ({ id, kind: 'text', text: value, style: 'type', y, w: .85, h: .095, start, keys: enter() });
    const visual = scene.template === 'custom' ? scene.visual : {
      styles: [{ id: 'type', size: 36, font: 'bold', color: '#F2F6FF' }, { id: 'accent', color: '#70DAC4' }],
      layers: scene.template === 'process' ? [
        text('title', scene.title, .18),
        { id: 'connector', kind: 'path', style: 'accent', x: .18, y: .50, w: .08, h: .30,
          view: { w: 100, h: 500 }, d: 'M50 20 V480', stroke: 12, draw: [{ t: 0, to: 0 }, { t: 2 * beat, to: 1, e: 'out' }] },
        ...scene.steps.map((step, n) => ({
          ...text(`step${n}`, step, .36 + .14 * n, (n + 1) * beat), x: .59, w: .68,
        })),
      ] : [
        { id: 'panel', kind: 'rect', style: 'accent', y: .58, w: .78, h: .19, overlap: true,
          keys: [{ t: 0, s: .4, o: 0 }, { t: 2 * beat, s: 1, o: .32, e: 'out' }] },
        text('title', scene.title, .29),
        text('point', scene.point, .58, beat),
      ],
    };
    if (scene.template === 'custom' && scene.transition === 'fade' && scene.visual.camera) {
      throw new TmepError('E_INPUT', `scene ${i + 1}: fade requires a scene without camera keys`);
    }
    const spec = visualSceneSchema.parse({
      ...visual, v: 1, ratio: '9:16', at, duration,
      layers: scene.transition === 'cut' ? visual.layers : [...visual.layers, {
        id: 'storyboardFade', kind: 'rect', w: 1, h: 1, overlap: true, bleed: true, style: 'storyboardBlack',
        end: Math.min(9, scene.frames) / STORYBOARD_FPS,
        keys: [{ t: 0, o: 1 }, { t: (Math.min(9, scene.frames) - 1) / STORYBOARD_FPS, o: 0 }],
      }],
      ...(scene.transition === 'fade' && { styles: [...(visual.styles ?? []), { id: 'storyboardBlack', color: '#000000' }] }),
    });
    if (!spec.ok) throw new TmepError('E_INPUT', `scene ${i + 1}: ${spec.issues.map(({ path, msg }) => `${path}: ${msg}`).join('; ')}`);
    return { frames: scene.frames, spec: spec.value };
  });
  return { script: parsed.value.script, narration: parsed.value.narration, frames, scenes };
}
