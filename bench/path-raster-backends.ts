// Rasterize the same 4-path draw-on animation (120 frames, 540x960 transparent PNGs) with the
// in-process Skia canvas used by path layers, or with headless Chrome over CDP
// (packages/media/src/chrome.ts) using SVG stroke-dashoffset with pathLength=1.
// Usage: node bench/path-raster-backends.ts skia|chrome <new-output-dir>
// Compare outputs with: ffmpeg -i <skia>/00050.png -i <chrome>/00050.png -lavfi psnr -f null -
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChromePage } from '../packages/media/src/chrome.ts';
import { canvasModule } from '../packages/motion/src/vector.ts';

const [backend, out] = process.argv.slice(2);
assert.ok(out && (backend === 'skia' || backend === 'chrome'), 'usage: skia|chrome <new-output-dir>');
const W = 540, H = 960, FPS = 30, N = 120;
const paths = [
  'M 60 700 C 160 520 260 860 360 640 S 480 420 480 300',
  'M 80 240 L 460 240 L 460 380 L 80 380 Z',
  'M 270 520 A 120 120 0 1 1 269.9 520',
  'M 100 820 Q 270 660 440 820',
];
const ease = (p: number) => (p < .5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const progress = (f: number, i: number) => ease(Math.min(1, Math.max(0, (f / FPS - i * .3) / 1.6)));
const file = (f: number) => path.join(out, `${String(f).padStart(5, '0')}.png`);
mkdirSync(out, { recursive: true });
const start = performance.now();
let firstFrameAt = start;

if (backend === 'skia') {
  const { createCanvas, Path2D } = canvasModule();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const shapes = paths.map((d) => new Path2D(d));
  firstFrameAt = performance.now();
  for (let f = 0; f < N; f++) {
    ctx.clearRect(0, 0, W, H);
    Object.assign(ctx, { lineWidth: 10, lineCap: 'round', lineJoin: 'round', strokeStyle: '#92E7CE' });
    shapes.forEach((shape, i) => {
      const p = progress(f, i);
      if (p > 0) ctx.stroke(p >= 1 ? shape : new Path2D(shape).trim(0, p));
    });
    writeFileSync(file(f), canvas.encodeSync('png'));
  }
} else {
  const page = path.join(out, 'page.html');
  writeFileSync(page, `<!doctype html><body style="margin:0;background:transparent"><svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${
    paths.map((d, i) => `<path id="p${i}" d="${d}" pathLength="1" fill="none" stroke="#92E7CE" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 1" stroke-dashoffset="1"/>`).join('')
  }</svg><script>const ease=${ease.toString()};window.TMEP={ready:true,frame(f){for(let i=0;i<${paths.length};i++){const p=ease(Math.min(1,Math.max(0,(f/${FPS}-i*.3)/1.6)));document.getElementById('p'+i).setAttribute('stroke-dashoffset',String(1-p));}}};</script></body>`);
  const chrome = await ChromePage.launch();
  try {
    await chrome.open(pathToFileURL(page).href, W, H);
    firstFrameAt = performance.now();
    for (let f = 0; f < N; f++) {
      await chrome.eval(`TMEP.frame(${f})`);
      writeFileSync(file(f), await chrome.screenshot(W, H));
    }
  } finally {
    chrome.close();
  }
}
const end = performance.now();
console.log(JSON.stringify({ backend, frames: N, size: `${W}x${H}`, wallMs: Math.round(end - start),
  startupMs: Math.round(firstFrameAt - start), msPerFrame: +((end - firstFrameAt) / N).toFixed(2) }));
