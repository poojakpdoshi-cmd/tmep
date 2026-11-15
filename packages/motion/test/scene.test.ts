import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOps, emptyTimeline, newClip, type TlWord } from '../../core/src/index.ts';
import { compileScenes, diagnoseScenes } from '../src/scene.ts';

const assets = { v1: { kind: 'video', dur: 5 }, i1: { kind: 'image', dur: 0 } };
const media = new Map(Object.entries(assets));
const track = [{ w: 'map', s: 1, e: 1.25, src: 'v1', i: 0, k: 0 }];
const shape = { id: 'panel', kind: 'rect', x: .3, y: .3, w: .18, h: .1 };
const spec = { v: 1, at: '@map', duration: 2, layers: [shape] };

function timeline(raw: Record<string, unknown>) {
  const tl = emptyTimeline();
  tl.clips = [newClip(tl, 'v1', 0, 5)];
  return applyOps(tl, [{ op: 'scene', spec: raw }], { assets, transcripts: { v1: track } }).tl;
}
const compile = (raw: Record<string, unknown>, words: TlWord[] = track) => compileScenes(timeline(raw), words, media);

test('compiles hierarchy, stagger, camera, registered media and ASS in mixed layer order', () => {
  const out = compile({
    ...spec, offset: .1,
    groups: [{ id: 'root', x: .05 }, { id: 'pair', parent: 'root', stagger: .2, opacity: .8 }],
    styles: [{ id: 'mint', color: '#44CC99' }],
    camera: [{ t: 0, s: 1 }, { t: 1, s: 1.1, e: 'io' }],
    layers: [
      { ...shape, group: 'pair', style: 'mint' },
      { id: 'photo', kind: 'image', asset: 'i1', group: 'pair', x: .7, y: .3, w: .18, h: .1 },
      { ...shape, id: 'triangle', kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: .5, y: 1 }], x: .3, y: .5 },
    ],
  });
  assert.match(out.layers[0]!.ass, /\\p1\\c&H99CC44&/);
  assert.equal(out.layers[0]!.at, 1.1);
  assert.equal(out.media[0]!.ref.at, 1.3);
  assert.equal(out.media[0]!.scene!.w, .18);
  assert.deepEqual(out.media[0]!.scene!.camera, [{ type: 'kf', keys: [{ t: -.2, s: 1 }, { t: .8, s: 1.1, e: 'io' }] }]);
  assert.ok(out.layers[0]!.z < out.media[0]!.z! && out.media[0]!.z! < out.layers[1]!.z);
  const tl = timeline(spec);
  assert.equal(compileScenes(tl, [{ ...track[0]!, s: 2, e: 2.25 }], media).layers[0]!.at, 2);
  assert.equal(applyOps(tl, [{ op: 'remove', id: tl.scenes![0]!.id }], { assets, transcripts: {} }).tl.scenes!.length, 0);
});

test('rejects invalid timing, unknown effects, group cycles and invalid media', () => {
  assert.throws(() => compile({ ...spec, at: 4 }), /outside the timeline/);
  assert.throws(() => compile({ ...spec, layers: [{ ...shape, end: .2, start: .4 }] }), /invalid layer interval/);
  assert.throws(() => compile({ ...spec, layers: [{ ...shape, keys: [{ t: 0, x: .1, blur: 3 }] }] }), /unknown key/);
  assert.throws(() => compile({ ...spec, groups: [{ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }] }), /cyclic group/);
  assert.throws(() => compile({ ...spec, layers: [{ ...shape, kind: 'video', asset: 'v1', in: 4 }] }), /exceeds source/);
  assert.throws(() => compile({ ...spec, ratio: '16:9' }), /aspect ratio/);
  assert.throws(() => compile({ ...spec, layers: [{ ...shape, keys: [{ t: .5, x: 0 }, { t: .5, x: .1 }] }] }), /duplicate key/);
  assert.throws(() => compile({ ...spec, layers: [{ ...shape, keys: [{ t: 0, x: 0 }, { t: .5, x: .1, e: 'hold' }] }] }), /jumps/);
});

test('checks safe areas and moving collisions at output frames', () => {
  assert.throws(() => compile({ ...spec, camera: [{ t: 0, x: 0 }, { t: 1, x: -.4 }] }), /outside the frame/);
  assert.throws(() => compile({ ...spec, safe: { left: .25 } }), /safe area/);
  assert.throws(() => compile({ ...spec, layers: [
    shape, { ...shape, id: 'moving', x: .7, keys: [{ t: 0, x: 0 }, { t: 1, x: -.6 }] },
  ] }), /collision/);
  assert.doesNotThrow(() => compile({ ...spec, layers: [shape, { ...shape, id: 'intentional', overlap: true }] }));
  assert.throws(() => compile({ ...spec, layers: [{ ...shape, y: .7 }] }), /caption band/);
  assert.throws(() => compile({ ...spec, safe: { bottom: .35 } }), /captions outside/);
});

test('checks glyph bounds against the text box', () => {
  const text = { ...shape, id: 'label', kind: 'text', text: 'Bounded label' };
  assert.match(compile({ ...spec, layers: [{ ...text, w: .5 }] }).layers[0]!.ass, /Bounded label/);
  assert.throws(() => compile({ ...spec, layers: [{ ...text, w: .01 }] }), /text clips/);
});

test('reports independent findings with the first affected timeline time and layer IDs', () => {
  const tl = timeline({ ...spec, layers: [
    shape, { ...shape, id: 'second' },
    { ...shape, id: 'edge', x: .98, y: .5 },
    { ...shape, id: 'jump', y: .8, keys: [{ t: 0, o: 1 }, { t: .5, o: .4, e: 'hold' }] },
    { ...shape, id: 'small', kind: 'text', x: .7, text: 'Clipped text', w: .01 },
    { ...shape, id: 'invalid', group: 'unknown' },
  ] });
  const report = diagnoseScenes(tl, track, media);
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues.map(({ code, layers, t, severity }) => [code, layers, t, severity]), [
    ['clipping', ['small'], 1, 'error'],
    ['invalid', ['invalid'], 1, 'error'],
    ['collision', ['panel', 'second'], 1, 'error'],
    ['safe-area', ['edge'], 1, 'error'],
    ['caption', ['jump'], 1, 'error'],
    ['discontinuity', ['jump'], 1.5, 'error'],
  ]);
  const prototype = structuredClone(tl);
  Object.assign(prototype.scenes![0]!.spec.layers[0]!, { blur: 4 });
  const [issue] = diagnoseScenes(prototype, track, media).issues;
  assert.deepEqual([issue?.code, issue?.layers, issue?.t], ['invalid', ['panel'], null]);
});
