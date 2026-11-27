import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { emptyTimeline, newClip } from '../../core/src/index.ts';
import { compileScenes } from '../src/scene.ts';
import { canvasModule, rasterizeVectorRun } from '../src/vector.ts';

test('canvas primitives: rrect, gradient, shadow, wrapped text, chart, image, clip, and spring easing compile and rasterize', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-canvas-prim-'));
  try {
    // Create a small PNG image asset via Skia Canvas
    const { createCanvas } = canvasModule();
    const imgCanvas = createCanvas(160, 90);
    const ictx = imgCanvas.getContext('2d');
    ictx.fillStyle = '#38BDF8';
    ictx.fillRect(0, 0, 160, 90);
    const imgPath = path.join(dir, 'thumb.png');
    await fsp.writeFile(imgPath, imgCanvas.encodeSync('png'));

    const tl = emptyTimeline('9:16', 30);
    tl.clips.push(newClip(tl, 'v1', 0, 4));
    tl.scenes = [
      {
        id: 's1',
        spec: {
          v: 1,
          at: 0,
          offset: 0,
          duration: 2,
          z: 5,
          styles: [{ id: 'h1', color: '#F8FAFC', font: 'bold', size: 42 }],
          groups: [{ id: 'cardGrp', x: 0, y: -0.05, s: 1, r: 0, opacity: 1, stagger: 0 }],
          layers: [
            {
              id: 'card',
              kind: 'rrect',
              group: 'cardGrp',
              x: 0.5,
              y: 0.5,
              w: 0.84,
              h: 0.32,
              radius: 28,
              gradient: {
                type: 'linear',
                angle: 135,
                stops: [
                  { offset: 0, color: '#1E293B' },
                  { offset: 1, color: '#0F172A' },
                ],
              },
              shadow: { color: '#00000080', blur: 24, x: 0, y: 12 },
              keys: [
                { t: 0, s: 0.85, o: 0 },
                { t: 0.45, s: 1, o: 1, e: 'spring' },
              ],
            },
            {
              id: 'title',
              kind: 'text',
              group: 'cardGrp',
              style: 'h1',
              text: 'Measured typography wraps cleanly inside bounded cards',
              x: 0.5,
              y: 0.42,
              w: 0.72,
              h: 0.14,
              align: 'left',
              wrap: true,
              maxLines: 3,
              ellipsis: true,
              bg: '#1D4ED8',
              pad: 14,
              radius: 14,
              overlap: true,
            },
            {
              id: 'metrics',
              kind: 'chart',
              chartType: 'hbar',
              x: 0.5,
              y: 0.56,
              w: 0.72,
              h: 0.12,
              data: [
                { label: 'Speed', value: 84, color: '#38BDF8' },
                { label: 'Tokens', value: 92, color: '#70DAC4' },
              ],
              max: 100,
              unit: '%',
              draw: [
                { t: 0, to: 0 },
                { t: 0.6, to: 1, e: 'out' },
              ],
              overlap: true,
            },
            {
              id: 'thumb',
              kind: 'image',
              asset: 'i1',
              x: 0.5,
              y: 0.25,
              w: 0.4,
              h: 0.12,
              fit: 'cover',
              radius: 18,
              shadow: { color: '#00000066', blur: 16, x: 0, y: 6 },
              clip: { kind: 'rrect', radius: 18 },
            },
          ],
        } as any,
      },
    ];

    const assets = new Map([
      ['v1', { kind: 'video', dur: 10 }],
      ['i1', { kind: 'image', dur: 0, path: imgPath }],
    ]);
    const compiled = compileScenes(tl, [], assets);
    assert.equal(compiled.vectors.length, 1);
    assert.equal(compiled.vectors[0]!.layers.length, 4);

    const outDir = path.join(dir, 'frames');
    const { encoded } = await rasterizeVectorRun(compiled.vectors[0]!, 540, 960, outDir);
    assert.ok(encoded > 1, `expected animated frames > 1, got ${encoded}`);
    const f0 = await fsp.stat(path.join(outDir, '00000.png'));
    const f30 = await fsp.stat(path.join(outDir, '00030.png'));
    assert.ok(f0.size > 1000 && f30.size > 1000);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
