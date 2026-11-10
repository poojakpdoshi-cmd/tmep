/**
 * The single-pass audio mixer as it was on 949e6c5, before Stabilization A5 — the trusted
 * reference the staged mixer in packages/render/src/audio.ts is compared against
 * (tests/audio-parity.test.ts). It is a verbatim copy except that the output codec is a
 * parameter, so the reference can be rendered as PCM and compared sample by sample.
 *
 * Do not "fix" anything here: its millisecond rounding and its growth with the number of
 * clips are the behaviour A5 replaces, and the comparison is only meaningful while this file
 * keeps producing exactly what that commit produced.
 */
import type { Timeline, Placed } from '../packages/core/src/index.ts';
import type { MediaRef } from '../packages/render/src/graph.ts';

const n3 = (x: number) => String(Math.round(x * 1000) / 1000);

export interface LegacyAudioPlan {
  args: string[];
  graph: string;
}

/** One continuous audio pass: speech (with crossfades) + ducked music + SFX + loudness. */
export function legacyAudioArgs(tl: Timeline, placed: Placed[], media: Record<string, MediaRef>, sfx: { file: string; t: number; vol: number }[], totalFrames: number, out: string, range?: { s: number; e: number }, codec: string[] = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000']): LegacyAudioPlan {
  const fps = tl.settings.fps;
  const total = totalFrames / fps;
  const inputs: string[] = [];
  const g: string[] = [];
  let k = 0;
  const labels: string[] = [];
  placed.forEach((p, j) => {
    const c = p.clip;
    const m = media[c.src]!;
    const D = p.frames / fps;
    const srcDur = D * c.speed;
    if (m.kind !== 'image' && m.audio && !c.mute) {
      inputs.push('-ss', n3(c.in), '-t', n3(srcDur + 0.3), '-i', m.path);
      const chain = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'asetpts=PTS-STARTPTS'];
      let sp = c.speed;
      while (sp > 2.0) {
        chain.push('atempo=2.0');
        sp /= 2;
      }
      while (sp < 0.5) {
        chain.push('atempo=0.5');
        sp /= 0.5;
      }
      if (Math.abs(sp - 1) > 1e-6) chain.push(`atempo=${n3(sp)}`);
      if (c.vol !== 1) chain.push(`volume=${n3(c.vol)}`);
      chain.push(`atrim=duration=${n3(D)}`, `apad=whole_dur=${n3(D)}`, 'afade=t=in:d=0.012', `afade=t=out:st=${n3(Math.max(0, D - 0.015))}:d=0.015`);
      g.push(`[${k}:a]${chain.join(',')}[a${j}]`);
      k++;
    } else g.push(`aevalsrc=0:s=48000:c=stereo:d=${n3(D)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${j}]`);
    labels.push(`a${j}`);
  });
  let cur = labels[0]!;
  for (let j = 1; j < placed.length; j++) {
    const p = placed[j]!;
    if (p.transFrames > 0) g.push(`[${cur}][a${j}]acrossfade=d=${n3(p.transFrames / fps)}:c1=tri:c2=tri[ax${j}]`);
    else g.push(`[${cur}][a${j}]concat=n=2:v=0:a=1[ax${j}]`);
    cur = `ax${j}`;
  }
  const mix: string[] = [];
  if (tl.music) {
    const m = media[tl.music.src];
    if (m && (m.kind === 'audio' || m.audio)) {
      inputs.push('-stream_loop', '-1', '-i', m.path);
      const f = Math.min(tl.music.fade, total / 3);
      g.push(`[${k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${n3(total)},asetpts=PTS-STARTPTS,volume=${n3(tl.music.vol)}dB,afade=t=in:d=${n3(f)},afade=t=out:st=${n3(Math.max(0, total - f))}:d=${n3(f)}[mus]`);
      k++;
      if (tl.music.duck) {
        g.push(`[${cur}]asplit=2[sp][sc]`);
        g.push('[mus][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=380:makeup=1[musd]');
        cur = 'sp';
        mix.push('musd');
      } else mix.push('mus');
    }
  }
  sfx.forEach((s, i) => {
    if (s.t < 0 || s.t >= total) return;
    inputs.push('-i', s.file);
    const d = Math.round(s.t * 1000);
    g.push(`[${k}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${d}|${d},volume=${n3(s.vol)}dB[sx${i}]`);
    mix.push(`sx${i}`);
    k++;
  });
  let master = cur;
  if (mix.length) {
    g.push(`[${cur}]${mix.map((x) => `[${x}]`).join('')}amix=inputs=${mix.length + 1}:duration=first:dropout_transition=0:normalize=0[mix]`);
    master = 'mix';
  }
  const post: string[] = [];
  if (tl.loudness < 0) post.push(`loudnorm=I=${tl.loudness}:TP=-1.5:LRA=11`, 'aresample=48000');
  if (range) post.push(`atrim=start=${n3(range.s)}:end=${n3(range.e)}`, 'asetpts=PTS-STARTPTS');
  const len = range ? range.e - range.s : total;
  post.push(`apad=whole_dur=${n3(len)}`, `atrim=duration=${n3(len)}`);
  g.push(`[${master}]${post.join(',')}[aout]`);
  const graph = g.join(';');
  return { args: [...inputs, '-filter_complex', graph, '-map', '[aout]', ...codec, out], graph };
}
