/**
 * Phase 4 Stage 4.0 gate: colour-space conversion against reference media with known ground truth.
 *
 * Five full-range RGB bars (18 % grey, 50 % grey, near-white, green, red) are encoded as
 *   - BT.709 (control), BT.601 / SMPTE 170M, BT.2020 SDR,
 *   - PQ (SMPTE 2084, BT.2020, SDR white at the BT.2408 HDR reference white of 203 nits),
 *   - HLG (ARIB STD-B67, BT.2020, same 203-nit reference white),
 * using zscale, tagged accordingly, imported, rendered through the public API with NO colour op
 * (automatic detection), decoded as BT.709 RGB, and compared with the original bars.
 * A correct pipeline returns approximately the original SDR values for every source.
 *
 *   node bench/phase4/color-reference.ts [workdir]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as api from '../../packages/engine/src/api.ts';

const work = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'frame-color-ref'));
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const ff = (a: string[]) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a], { maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(String(r.stderr).slice(0, 800));
  return r.stdout as Buffer;
};

const bars: [string, [number, number, number]][] = [
  ['grey18', [46, 46, 46]], ['grey50', [128, 128, 128]], ['white', [230, 230, 230]], ['green', [40, 200, 40]], ['red', [200, 40, 40]],
];
const W = 640, H = 360, BW = W / bars.length;
const src = bars.map(([, [r, g, b]], i) => `color=c=0x${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}:s=${BW}x${H}:r=30:d=2[c${i}]`).join(';') +
  ';' + bars.map((_, i) => `[c${i}]`).join('') + `hstack=inputs=${bars.length},format=gbrp`;

interface Variant { name: string; z: string; tags: string[]; pix: string }
const variants: Variant[] = [
  { name: 'bt709', z: 'zscale=min=gbr:m=bt709:rin=full:r=tv', tags: ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'], pix: 'yuv420p' },
  { name: 'bt601', z: 'zscale=tin=bt709:t=601:pin=bt709:p=170m:min=gbr:m=170m:rin=full:r=tv', tags: ['-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m'], pix: 'yuv420p' },
  { name: 'bt2020-sdr', z: 'zscale=tin=bt709:t=bt709:pin=bt709:p=2020:min=gbr:m=2020_ncl:rin=full:r=tv', tags: ['-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'bt709'], pix: 'yuv420p10le' },
  { name: 'pq', z: 'zscale=tin=bt709:t=smpte2084:pin=bt709:p=2020:min=gbr:m=2020_ncl:rin=full:r=tv:npl=203', tags: ['-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084'], pix: 'yuv420p10le' },
  { name: 'hlg', z: 'zscale=tin=bt709:t=arib-std-b67:pin=bt709:p=2020:min=gbr:m=2020_ncl:rin=full:r=tv:npl=203', tags: ['-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67'], pix: 'yuv420p10le' },
];

const sample = (file: string): [number, number, number][] => {
  const px = ff(['-ss', '1', '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H}:in_color_matrix=bt709:in_range=tv,format=rgb24`, '-f', 'rawvideo', '-']);
  const OW = W;
  return bars.map((_, i) => {
    const x0 = Math.round(i * BW + BW / 4), x1 = Math.round(i * BW + (3 * BW) / 4), y0 = H / 4, y1 = (3 * H) / 4;
    const acc = [0, 0, 0]; let n = 0;
    for (let y = y0; y < y1; y += 4) for (let x = x0; x < x1; x += 4) { const o = (y * OW + x) * 3; acc[0]! += px[o]!; acc[1]! += px[o + 1]!; acc[2]! += px[o + 2]!; n++; }
    return acc.map((v) => Math.round(v / n)) as [number, number, number];
  });
};

const rows: Record<string, unknown>[] = [];
for (const v of variants) {
  const file = path.join(work, `${v.name}.mp4`);
  ff(['-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2', '-vf', `${v.z},format=${v.pix}`, ...v.tags,
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', file]);
  const sourceDecodedNaive = sample(file); // what a pipeline that ignores the tags would show
  const proj = path.join(work, `proj-${v.name}`);
  mkdirSync(proj, { recursive: true });
  const ctx = { project: proj, detail: 'standard' as const };
  await api.importMedia(ctx, { paths: [file] });
  await api.edit(ctx, { ratio: '16:9', ops: [{ op: 'add', src: 'v1', in: 0, out: 2 }] });
  const out = path.join(proj, 'renders', 'out.mp4');
  const r = await api.render(ctx, { out, wait: 300 });
  if (r.state !== 'done') throw new Error(`${v.name}: render ${r.state} ${JSON.stringify(r.err)}`);
  const got = sample(out);
  const err = got.map((g, i) => Math.max(...g.map((c, k) => Math.abs(c - bars[i]![1][k]!))));
  const naiveErr = sourceDecodedNaive.map((g, i) => Math.max(...g.map((c, k) => Math.abs(c - bars[i]![1][k]!))));
  const maxErr = Math.max(...err);
  rows.push({ variant: v.name, ok: maxErr <= 8, maxErr, perBar: Object.fromEntries(bars.map(([n], i) => [n, { expect: bars[i]![1], got: got[i], err: err[i] }])), untaggedDecodeMaxErr: Math.max(...naiveErr) });
  console.log(`${maxErr <= 8 ? 'PASS' : 'FAIL'} ${v.name.padEnd(11)} maxErr=${String(maxErr).padStart(3)}  (tag-ignoring decode would give ${Math.max(...naiveErr)})  got=${JSON.stringify(got)}`);
}
const outFile = path.resolve(import.meta.dirname, '../../docs/phase-4/evidence/color-reference.json');
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), host: `${os.platform()} ${os.arch()}, node ${process.version}`, tolerance: 8, bars: Object.fromEntries(bars), rows }, null, 1) + '\n');
