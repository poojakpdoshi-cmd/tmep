import { arr, num, obj, oneOf, str, union, TmepError, visualSceneSchema, visualSceneContent } from '../../core/src/index.ts';

const label = str({ min: 1, max: 48, pattern: /^(?=.*\S)[^\x00-\x1f\x7f]+$/ });
const timing = {
  frames: num({ int: true, min: 6, max: 1800 }),
  transition: oneOf(['cut', 'fade'] as const).default('cut'),
};

export const storyboardSchema = obj({
  v: oneOf([1] as const),
  script: str({ min: 1, max: 20000, pattern: /\S/ }),
  narration: str({ pattern: /^a[1-9]\d*$/ }).optional(),
  scenes: arr(union([
    obj({ ...timing, template: oneOf(['process'] as const), title: label, steps: arr(label, { min: 2, max: 3 }),
      // Optional frame offsets, one per step, at which each step label enters (narration cues).
      cues: arr(num({ int: true, min: 0, max: 1799 }), { min: 2, max: 3 }).optional() }),
    obj({ ...timing, template: oneOf(['explanation'] as const), title: label, point: label }),
    obj({ ...timing, template: oneOf(['comparison'] as const), first: label, second: label }),
    obj({ ...timing, template: oneOf(['custom'] as const), visual: visualSceneContent }),
  ]), { min: 1, max: 16 }),
});

export const STORYBOARD_FPS = 30;

/** Greedy word wrap for centred labels; one word longer than `width` stays on its own line. */
function wrap(value: string, width: number): string {
  return value.split(/\s+/u).reduce<string[]>((rows, word) => {
    const last = rows.at(-1);
    if (last && last.length + 1 + word.length <= width) rows[rows.length - 1] += ' ' + word;
    else rows.push(word);
    return rows;
  }, []).join('\n');
}

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
    const text = (id: string, value: string, y: number, start = 0, style = 'type', h = .095) =>
      ({ id, kind: 'text', text: value, style, y, w: .85, h, start, keys: enter() });
    if (scene.template === 'process' && scene.cues) {
      if (scene.cues.length !== scene.steps.length) throw new TmepError('E_INPUT', `scene ${i + 1}: cues needs one frame offset per step`);
      if (scene.cues.some((cue, n) => cue >= scene.frames || (n && cue <= scene.cues![n - 1]!))) {
        throw new TmepError('E_INPUT', `scene ${i + 1}: cues must increase and stay inside the scene`);
      }
    }
    // Steps enter on their cue (or evenly across the scene), not all within the first second.
    const stepStarts = scene.template === 'process' ? scene.steps.map((_, n) => {
      const cue = (scene.cues?.[n] ?? Math.round(n * scene.frames / scene.steps.length)) / STORYBOARD_FPS;
      const start = Math.min(Math.max(cue, (n + 1) * beat), duration - beat - 1 / STORYBOARD_FPS);
      return Math.round(start * STORYBOARD_FPS) / STORYBOARD_FPS;
    }) : [];
    // The connector draws down to each step as it enters (step centres .38 + .16n on a .36–.72 path).
    const draw: { t: number; to: number; e?: 'out' }[] = [{ t: 0, to: 0 }];
    stepStarts.forEach((start, n) => {
      const last = draw.at(-1)!;
      if (start > last.t) draw.push({ t: start, to: last.to });
      const t = Math.max(start + beat, draw.at(-1)!.t + 1 / STORYBOARD_FPS);
      if (t < duration) draw.push({ t, to: Math.min(1, (((.02 + .16 * n) / .36) * 500 - 20) / 460), e: 'out' });
    });
    const visual = scene.template === 'custom' ? scene.visual : scene.template === 'comparison' ? {
      styles: [
        { id: 'type', size: 52, font: 'bold', color: '#F2F6FF' },
        { id: 'upper', color: '#214B4B' }, { id: 'lower', color: '#293C69' },
      ],
      layers: [scene.first, scene.second].flatMap((value, n) => {
        const y = .38 + n * .22;
        const start = n * beat;
        return [
          { id: `card${n}`, kind: 'rect', style: n ? 'lower' : 'upper', y, w: .85, h: .18,
            start, overlap: true, keys: enter() },
          text(`claim${n}`, wrap(value, 19), y, start, 'type', .16),
        ];
      }),
    } : {
      // Phone-legible sizes; labels wrap inside boxes sized for the planner's label limits.
      styles: [
        { id: 'head', size: 60, font: 'bold', color: '#F2F6FF' },
        { id: 'type', size: 48, font: 'bold', color: '#F2F6FF' }, { id: 'accent', color: '#70DAC4' },
      ],
      layers: scene.template === 'process' ? [
        text('title', wrap(scene.title, 22), .20, 0, 'head', .13),
        { id: 'connector', kind: 'path', style: 'accent', x: .18, y: .54, w: .08, h: .36,
          view: { w: 100, h: 500 }, d: 'M50 20 V480', stroke: 12, draw },
        ...scene.steps.map((step, n) => ({
          ...text(`step${n}`, wrap(step, 20), .38 + .16 * n, stepStarts[n], 'type', .10), x: .58, w: .66,
        })),
      ] : [
        { id: 'panel', kind: 'rect', style: 'accent', y: .56, w: .85, h: .24, overlap: true,
          keys: [{ t: 0, s: .4, o: 0 }, { t: 2 * beat, s: 1, o: .32, e: 'out' }] },
        text('title', wrap(scene.title, 22), .32, 0, 'head', .13),
        { ...text('point', wrap(scene.point, 24), .56, beat, 'type', .20), w: .78 },
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
