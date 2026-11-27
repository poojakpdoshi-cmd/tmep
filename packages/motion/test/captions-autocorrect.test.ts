import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTimeline, newClip } from '../../core/src/index.ts';
import { AssDoc } from '../src/ass.ts';
import { captionLayout, compileCaptions } from '../src/captions.ts';
import { autoCorrectScenes } from '../src/scene.ts';

test('captions: kinetic uses zero-reflow highlights and captionLayout respects safe zones and presenter reserve', () => {
  const doc = new AssDoc(1080, 1920);
  const words = [
    { w: 'Build', s: 0, e: 0.3, src: 'v1', i: 0, k: 0 },
    { w: 'professional', s: 0.3, e: 0.7, src: 'v1', i: 1, k: 1 },
    { w: 'videos', s: 0.7, e: 1.0, src: 'v1', i: 2, k: 2 },
    { w: 'locally.', s: 1.0, e: 1.4, src: 'v1', i: 3, k: 3 },
  ];
  const n = compileCaptions(doc, words, {
    style: 'kinetic',
    pos: 'lower',
    maxWords: 5,
    upper: false,
    color: '#FFFFFF',
    accent: '#38BDF8',
    size: 1,
    emphasis: true,
    script: 'latin',
    fix: [],
  }, 'Arial', 2.0);
  assert.ok(n >= 4);
  const ass = doc.toString();
  assert.doesNotMatch(ass, /\\fscx114/, 'kinetic captions must not scale inline words and cause reflow');

  const lay = captionLayout({
    style: 'clean', pos: 'lower', maxWords: 5, upper: false, color: '#FFFFFF', accent: '#38BDF8', size: 1, emphasis: true, script: 'latin', fix: [],
  }, 1080, 1920, { safeBottom: 0.25, reservePresenter: { x: 0.5, y: 0.65, w: 0.8, h: 0.2 } });
  assert.ok(lay.y < 1920 * 0.75);
});

test('autoCorrectScenes: fixes safe-area, caption overlap, and text clipping while reporting corrections', () => {
  const tl = emptyTimeline('9:16', 30);
  tl.clips.push(newClip(tl, 'v1', 0, 5));
  tl.scenes = [
    {
      id: 'sc1',
      spec: {
        v: 1,
        at: 0,
        offset: 0,
        duration: 3,
        z: 5,
        safe: { left: 0.05, top: 0.08, right: 0.05, bottom: 0.2 },
        styles: [{ id: 's1', color: '#FFFFFF', font: 'bold', size: 64 }],
        layers: [
          {
            id: 'oobText',
            kind: 'text',
            style: 's1',
            text: 'A very long headline that overflows its narrow container box',
            x: 0.96,
            y: 0.94,
            w: 0.4,
            h: 0.12,
            wrap: false,
          },
        ],
      } as any,
    },
  ];
  const assets = new Map([['v1', { kind: 'video', dur: 10 }]]);
  const res = autoCorrectScenes(tl, [], assets);
  assert.ok(res.corrections.some((c) => c.code === 'safe-area'));
  assert.ok(res.corrections.some((c) => c.code === 'clipping'));
  assert.equal(res.unresolved.length, 0);
});
