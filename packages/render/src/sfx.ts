/**
 * Sound effects synthesized locally with FFmpeg sources (no third-party audio assets,
 * no licensing questions). Generated once per kind and cached as WAV.
 */
import path from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
import { exists } from '../../core/src/index.ts';
import { ffmpeg } from '../../media/src/ffmpeg.ts';
import { tmpFor } from './stage.ts';

const SR = 48000;

export const SFX: Record<string, { desc: string; graph: string }> = {
  pop: { desc: 'short bubbly pop (icon/list reveals)', graph: `aevalsrc='0.55*sin(2*PI*t*(260+1100*exp(-t*38)))*exp(-t*22)':s=${SR}:d=0.22` },
  click: { desc: 'tight UI click (steps, badges)', graph: `aevalsrc='0.7*sin(2*PI*2300*t)*exp(-t*140)+0.3*sin(2*PI*1200*t)*exp(-t*90)':s=${SR}:d=0.07` },
  ding: { desc: 'bright bell (stats, highlights)', graph: `aevalsrc='0.42*(sin(2*PI*1318.5*t)+0.45*sin(2*PI*2637*t)+0.2*sin(2*PI*3955*t))*exp(-t*5.5)':s=${SR}:d=0.9` },
  whoosh: { desc: 'air whoosh (transitions)', graph: `anoisesrc=d=0.55:c=pink:r=${SR}:a=0.6:s=7,highpass=f=350,lowpass=f=5200,afade=t=in:d=0.3:curve=qsin,afade=t=out:st=0.3:d=0.25:curve=qsin` },
  riser: { desc: 'rising sweep (build-up before reveal)', graph: `aevalsrc='0.32*sin(2*PI*t*(180+520*t))*min(t/0.9\\,1)':s=${SR}:d=1.0,afade=t=out:st=0.85:d=0.15` },
  swoosh: { desc: 'short high swish (text slides)', graph: `anoisesrc=d=0.3:c=white:r=${SR}:a=0.35:s=3,bandpass=f=3800:width_type=q:w=0.9,afade=t=in:d=0.12,afade=t=out:st=0.12:d=0.18` },
};

export const SFX_KINDS = Object.keys(SFX);

export async function sfxFile(cacheDir: string, kind: string): Promise<string> {
  const def = SFX[kind];
  if (!def) throw new Error(`unknown sfx ${kind}`);
  const file = path.join(cacheDir, `${kind}-v1.wav`);
  if (await exists(file)) return file;
  await mkdir(cacheDir, { recursive: true });
  const tmp = tmpFor(file, '.wav');
  try {
    await ffmpeg({ args: ['-f', 'lavfi', '-i', def.graph, '-ac', '2', '-ar', String(SR), '-c:a', 'pcm_s16le', tmp] });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
  return file;
}
