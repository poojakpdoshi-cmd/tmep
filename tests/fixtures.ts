/**
 * Synthetic test footage with KNOWN word timings.
 *
 * Each word is synthesized separately (FFmpeg's flite TTS when available, tone bursts
 * otherwise) and placed at a known offset, so the ground-truth transcript is exact.
 * This lets CI verify cutting, caption sync and rendering without a speech model.
 * It does NOT measure speech-recognition accuracy (see docs/BENCHMARKS.md).
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { ffmpeg, ffmpegInfo, probe } from '../packages/media/src/ffmpeg.ts';
import { exists } from '../packages/core/src/index.ts';

export interface FixtureWord {
  w: string;
  /** what the TTS speaks (defaults to w) */
  say?: string;
}

/** Sentences, with the pause (s) that follows each one. */
export const SCRIPT: { words: FixtureWord[]; pause: number }[] = [
  { words: 'Generative AI is changing how we create content.'.split(' ').map((w) => ({ w })), pause: 0.55 },
  { words: [{ w: 'Um,', say: 'um' }, { w: 'let' }, { w: 'me' }, { w: 'explain.' }], pause: 0.5 },
  { words: 'Generative AI can create images, videos, audio, and code.'.split(' ').map((w) => ({ w })), pause: 1.6 },
  { words: [{ w: 'It' }, { w: 'is' }, { w: '90', say: 'ninety' }, { w: 'percent' }, { w: 'faster' }, { w: 'than' }, { w: 'editing' }, { w: 'by' }, { w: 'hand.' }], pause: 0.6 },
  { words: 'First, record your raw footage in one take.'.split(' ').map((w) => ({ w })), pause: 0.6 },
  { words: 'This is the most important secret.'.split(' ').map((w) => ({ w })), pause: 0.6 },
  { words: 'Follow for more tips like this.'.split(' ').map((w) => ({ w })), pause: 0.8 },
];

export interface Fixture {
  video: string;
  truth: string;
  words: { w: string; s: number; e: number }[];
  dur: number;
  tts: 'flite' | 'tone';
}

export async function makeFixture(dir: string, opts: { w?: number; h?: number; fps?: number } = {}): Promise<Fixture> {
  await fsp.mkdir(dir, { recursive: true });
  const video = path.join(dir, 'talking_head.mp4');
  const truth = path.join(dir, 'talking_head.words.json');
  if ((await exists(video)) && (await exists(truth))) {
    const j = JSON.parse(await fsp.readFile(truth, 'utf8'));
    return { video, truth, words: j.words, dur: j.dur, tts: j.tts };
  }
  const info = await ffmpegInfo();
  const tts = info.filters.has('flite') ? 'flite' : 'tone';
  const wdir = path.join(dir, 'w');
  await fsp.mkdir(wdir, { recursive: true });
  const words: { w: string; s: number; e: number }[] = [];
  const clips: { file: string; at: number }[] = [];
  let t = 0.8;
  let n = 0;
  for (const sent of SCRIPT) {
    for (const fw of sent.words) {
      const file = path.join(wdir, `${String(n++).padStart(3, '0')}.wav`);
      const say = (fw.say ?? fw.w).replace(/[^A-Za-z0-9 ]/g, '');
      if (tts === 'flite') {
        await ffmpeg({ args: ['-f', 'lavfi', '-i', `flite=text='${say}':voice=slt`, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse', '-ar', '48000', '-ac', '1', file] });
      } else {
        const d = (0.12 + say.length * 0.055).toFixed(3);
        await ffmpeg({ args: ['-f', 'lavfi', '-i', `sine=frequency=${180 + (n % 5) * 40}:sample_rate=48000:duration=${d}`, '-af', 'volume=0.5,afade=t=in:d=0.01,afade=t=out:st=' + (Number(d) - 0.02).toFixed(3) + ':d=0.02', '-ac', '1', file] });
      }
      const d = (await probe(file)).dur;
      words.push({ w: fw.w, s: round(t), e: round(t + d) });
      clips.push({ file, at: t });
      t += d + 0.07;
    }
    t += sent.pause;
  }
  const dur = round(t + 0.6);
  // mix words into one track (adelay + amix), in batches to keep the graph small
  const speech = path.join(dir, 'speech.wav');
  const inputs = clips.flatMap((c) => ['-i', c.file]);
  const graph = clips.map((c, i) => `[${i}:a]adelay=${Math.round(c.at * 1000)}|${Math.round(c.at * 1000)}[d${i}]`).join(';') + `;${clips.map((_, i) => `[d${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:duration=longest,apad=whole_dur=${dur},atrim=duration=${dur}[a]`;
  await ffmpeg({ args: [...inputs, '-filter_complex', graph, '-map', '[a]', '-ac', '2', '-ar', '48000', speech] });
  const W = opts.w ?? 1920;
  const H = opts.h ?? 1080;
  const fps = opts.fps ?? 30;
  // dark "studio" frame with a moving subject block (stand-in for a speaker)
  await ffmpeg({
    args: [
      '-f', 'lavfi', '-i', `color=c=0x1d2733:s=${W}x${H}:r=${fps}:d=${dur}`,
      '-f', 'lavfi', '-i', `color=c=0x6f4e37:s=${Math.round(W * 0.16)}x${Math.round(H * 0.42)}:r=${fps}:d=${dur}`,
      '-i', speech,
      '-filter_complex', `[0][1]overlay=x='${Math.round(W * 0.42)}+${Math.round(W * 0.03)}*sin(t*1.7)':y='${Math.round(H * 0.33)}+${Math.round(H * 0.01)}*sin(t*2.3)',drawbox=x=0:y=${Math.round(H * 0.9)}:w=${W}:h=${Math.round(H * 0.1)}:color=0x2b3a4a:t=fill[v]`,
      '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', video,
    ],
  });
  await fsp.writeFile(truth, JSON.stringify({ words, dur, tts }));
  await fsp.rm(wdir, { recursive: true, force: true });
  await fsp.rm(speech, { force: true });
  return { video, truth, words, dur, tts };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
