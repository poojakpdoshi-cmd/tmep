/**
 * Voiceover-first reel prototype: voiceover -> word timings -> scene plan -> frames -> MP4.
 *
 *   node examples/voiceover-reel/render.ts [--audio vo.wav --words words.json] [--out file.mp4] [--captions 0] [--fps 60]
 *
 * With --audio/--words (words.json = [{w,s,e}] in seconds, e.g. from Whisper) the real voiceover drives everything.
 * Without them, a SYNTHETIC flite voiceover is generated word by word so timings are exact (labelled as such).
 * Scene choreography is a designed template; all timing (word reveals, caption pills, cuts, scene changes)
 * is derived automatically from the word timestamps.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChromePage } from '../../packages/media/src/chrome.ts';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k: string, d?: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const W = 1080, H = 1920, FPS = Number(arg('fps', '60'));
const CAPS = arg('captions', '1') !== '0';
const work = join(here, 'output', 'work'); mkdirSync(work, { recursive: true });
const out = resolve(arg('out', join(here, 'output', CAPS ? 'voiceover-reel.mp4' : 'voiceover-reel-nocaps.mp4')));
const ff = (args: string[]) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status) throw new Error(r.stderr.toString()); };

interface Word { w: string; s: number; e: number }
// Script grouped by sentence; [display, spoken]
const SCRIPT: [string, string?][][] = [
  [['Start'], ['with'], ['a'], ['voiceover.']],
  [['TMEP', 'tee em ee pee'], ['listens,'], ['finds'], ['every'], ['word,'], ['and'], ['times'], ['each'], ['caption.']],
  [['Then'], ['it'], ['composes'], ['the'], ['visuals'], ['and'], ['cuts'], ['on'], ['the'], ['beat.']],
  [['One'], ['voice.'], ['One'], ['finished'], ['reel.']],
];

function synth(): { audio: string; words: Word[]; synthetic: true } {
  const words: Word[] = []; const parts: string[] = []; let t = 0.25, n = 0;
  const sil = (d: number) => { const f = join(work, `sil${n++}.wav`); ff(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono`, '-t', d.toFixed(3), f]); parts.push(f); };
  sil(0.25);
  SCRIPT.forEach((sent, si) => sent.forEach(([w, say], wi) => {
    const f = join(work, `w${si}_${wi}.wav`);
    const text = (say ?? w).replace(/[^A-Za-z ]/g, '');
    ff(['-f', 'lavfi', '-i', `flite=text='${text}':voice=slt`, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,atempo=1.1', '-ar', '48000', '-ac', '1', f]);
    const d = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString());
    parts.push(f); words.push({ w, s: +t.toFixed(3), e: +(t + d).toFixed(3) }); t += d;
    const gap = wi === sent.length - 1 ? 0.3 : /,$/.test(w) ? 0.12 : 0.04; sil(gap); t += gap;
  }));
  sil(1.05);
  const list = join(work, 'list.txt'); writeFileSync(list, parts.map(p => `file '${p}'`).join('\n'));
  const audio = join(work, 'vo.wav'); ff(['-f', 'concat', '-safe', '0', '-i', list, '-ar', '48000', '-ac', '1', audio]);
  return { audio, words, synthetic: true };
}

const a = arg('audio'), wj = arg('words');
const src = a && wj ? { audio: resolve(a), words: JSON.parse(readFileSync(wj, 'utf8')) as Word[], synthetic: false } : synth();
const { audio, words } = src;
const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio]).stdout.toString());

// waveform peaks (100/s) from raw PCM
const PPS = 100;
const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', audio, '-f', 's16le', '-ac', '1', '-ar', '8000', '-'], { maxBuffer: 1 << 28 }).stdout;
const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1), per = 8000 / PPS, peaks: number[] = [];
for (let i = 0; i < samples.length; i += per) { let m = 0; for (let j = i; j < Math.min(i + per, samples.length); j++) m = Math.max(m, Math.abs(samples[j])); peaks.push(m / 32768); }
const pmax = Math.max(...peaks) || 1; const peaksN = peaks.map(p => +(p / pmax).toFixed(3));

// scene plan: one scene per sentence (sentence ends found from punctuation in the transcript)
const ends = words.map((w, i) => /[.!?]$/.test(w.w) ? i : -1).filter(i => i >= 0);
if (ends.length < 4) throw new Error('need >=4 sentences in the transcript for the 4-scene template');
const scenes = [0, 1, 2, 3].map(k => ({ from: k ? ends[k - 1] + 1 : 0, to: k < 3 ? ends[k] : words.length - 1 }));
const sIdx = (k: number) => Array.from({ length: scenes[k].to - scenes[k].from + 1 }, (_, i) => scenes[k].from + i);
const split = (ids: number[]) => { const h = Math.ceil(ids.length / 2); return [ids.slice(0, h), ids.slice(h)]; };
const s2 = sIdx(2);
const data = {
  words, peaks: peaksN, pps: PPS, dur, captions: CAPS, scenes,
  heroLines1: split(sIdx(0)), heroLines4: split(sIdx(3)),
  cuts: [words[s2[Math.floor(s2.length * 0.4)]].s, words[s2[Math.floor(s2.length * 0.65)]].s],
};
writeFileSync(join(here, 'output', 'plan.json'), JSON.stringify({ synthetic: src.synthetic, dur, scenes, cuts: data.cuts, words }, null, 1));
const html = readFileSync(join(here, 'scene.html'), 'utf8').replace('<script>', `<script>window.DATA=${JSON.stringify(data)};</script><script>`);
const page = join(work, 'scene.html'); writeFileSync(page, html);

const chrome = await ChromePage.launch();
await chrome.open(pathToFileURL(page).href, W, H);
const enc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-i', audio,
  '-filter_complex', '[1:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]', '-map', '0:v', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const frames = Math.round(dur * FPS), t0 = Date.now();
for (let f = 0; f < frames; f++) {
  await chrome.eval(`window.TMEP.seek(${(f / FPS).toFixed(5)})`);
  const buf = await chrome.screenshot(W, H, 1, 'jpeg');
  if (!enc.stdin.write(buf)) await new Promise(r => enc.stdin.once('drain', r));
}
enc.stdin.end(); await new Promise(r => enc.on('close', r)); await chrome.close();
console.log(JSON.stringify({ out, frames, fps: FPS, dur: +dur.toFixed(2), synthetic: src.synthetic, captions: CAPS, renderSec: +((Date.now() - t0) / 1000).toFixed(1) }));
if (!existsSync(out)) process.exit(1);
