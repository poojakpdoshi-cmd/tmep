/** Native whisper.cpp VAD detection; never use its compressed token timeline. */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { TmepError, exists } from '../../core/src/index.ts';
import { run } from '../../media/src/exec.ts';
import { makeTranscript, type Transcript } from './transcript.ts';

export interface VadOptions {
  vad?: 'off' | 'on' | 'verify';
  vadModel?: string;
  vadThreshold?: number;
  vadPadMs?: number;
}
export function validateVad(o: VadOptions) {
  if (o.vad !== undefined && !['off', 'on', 'verify'].includes(o.vad)) throw new TmepError('E_INPUT', 'vad must be off, on or verify');
  if (o.vadModel !== undefined && (typeof o.vadModel !== 'string' || !o.vadModel.trim())) throw new TmepError('E_INPUT', 'vadModel must be a local path');
  if (o.vadThreshold !== undefined && (!Number.isFinite(o.vadThreshold) || o.vadThreshold <= 0 || o.vadThreshold >= 1)) throw new TmepError('E_INPUT', 'vadThreshold must be between 0 and 1');
  if (o.vadPadMs !== undefined && (!Number.isInteger(o.vadPadMs) || o.vadPadMs < 100 || o.vadPadMs > 2000)) throw new TmepError('E_INPUT', 'vadPadMs must be 100-2000');
  if ((!o.vad || o.vad === 'off') && [o.vadModel, o.vadThreshold, o.vadPadMs].some(x => x !== undefined)) throw new TmepError('E_INPUT', 'VAD settings require --vad on or verify');
}
export function detectorPath(whisper: string) {
  return process.env.TMEP_WHISPER_VAD ?? path.join(path.dirname(whisper), 'whisper-vad-speech-segments' + (process.platform === 'win32' ? '.exe' : ''));
}
export function parseRegions(text: string, duration: number): [number, number][] {
  const count = /Detected (\d+) speech segments:/.exec(text);
  const rows = [...text.matchAll(/Speech segment \d+: start = ([\d.]+), end = ([\d.]+)/g)];
  if (!count || rows.length !== Number(count[1]) || rows.length > 256) throw new Error('invalid or excessive VAD regions');
  const regions: [number, number][] = [];
  for (const m of rows) {
    // whisper.cpp v1.8.3 detector prints centiseconds, despite its README examples.
    const s = Number(m[1]) / 100, e = Math.min(duration, Number(m[2]) / 100);
    if (!Number.isFinite(s + e) || s < 0 || e <= s || s < (regions.at(-1)?.[0] ?? 0)) throw new Error('invalid VAD timestamps');
    const previous = regions.at(-1);
    if (previous && s <= previous[1]) previous[1] = Math.max(previous[1], e);
    else regions.push([s, e]);
  }
  return regions;
}
/** Only the canonical mono 16k PCM WAV produced by TMEP is accepted. */
export function pcmData(wav: Buffer): Buffer {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('VAD needs PCM WAV');
  let valid = false;
  for (let i = 12; i + 8 <= wav.length;) {
    const size = wav.readUInt32LE(i + 4), start = i + 8;
    if (start + size > wav.length) throw new Error('truncated WAV');
    const tag = wav.toString('ascii', i, i + 4);
    if (tag === 'fmt ' && size >= 16) valid = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 && wav.readUInt32LE(start + 4) === 16000 && wav.readUInt16LE(start + 14) === 16;
    if (tag === 'data' && valid && size % 2 === 0) return wav.subarray(start, start + size);
    i = start + size + size % 2;
  }
  throw new Error('VAD needs mono 16k PCM16 WAV');
}
export function pcmWav(data: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
export async function detectChunks(wav: string, dir: string, bin: string, o: VadOptions, signal?: AbortSignal) {
  const detector = detectorPath(bin), model = o.vadModel ?? process.env.TMEP_WHISPER_VAD_MODEL;
  if (!(await exists(detector)) || !model || !(await exists(model))) throw new TmepError('E_ENGINE_MISSING', 'native VAD executable or model missing', 'set TMEP_WHISPER_VAD and TMEP_WHISPER_VAD_MODEL; using full audio');
  const pcm = pcmData(await fs.readFile(wav)), duration = pcm.length / 32000;
  const result = await run(detector, ['--file', wav, '--vad-model', model, '--vad-threshold', String(o.vadThreshold ?? .5), '--vad-speech-pad-ms', String(o.vadPadMs ?? 400), '--no-prints'], { signal });
  if (result.code) throw new Error('VAD detection failed');
  const regions = parseRegions(result.stdout, duration);
  if (!regions.length) throw new Error('VAD detected no speech; full-audio check required');
  await fs.mkdir(dir, { recursive: true });
  const chunks = [];
  for (const [i, [s, e]] of regions.entries()) {
    const start = Math.floor(s * 16000), end = Math.ceil(e * 16000);
    const file = path.join(dir, `${i}.wav`);
    await fs.writeFile(file, pcmWav(pcm.subarray(start * 2, end * 2)));
    chunks.push({ file, start: start / 16000, duration: (end - start) / 16000 });
  }
  return { chunks, duration, processed: chunks.reduce((sum, c) => sum + c.duration, 0) };
}
export function joinChunks(parts: Transcript[], chunks: { start: number; duration: number }[]): Transcript {
  if (!parts.length || parts.length !== chunks.length) throw new Error('missing VAD transcript');
  const words = parts.flatMap((tr, i) => {
    const c = chunks[i]!;
    if (!tr.words.length || tr.words.some(w => w.s < 0 || w.e > c.duration + .1 || (w.p !== undefined && w.p < .2))) throw new Error('uncertain VAD transcript; full-audio fallback required');
    return tr.words.map(w => ({ ...w, s: w.s + c.start, e: Math.min(w.e, c.duration) + c.start }));
  });
  return makeTranscript(parts[0]!.engine, parts[0]!.lang, words, { model: parts[0]!.model, approx: parts.some(p => p.approx) });
}
export function compareVad(reference: Transcript, candidate: Transcript): boolean {
  return reference.lang === candidate.lang && reference.words.length === candidate.words.length && reference.words.every((w, i) => {
    const c = candidate.words[i]!;
    return w.w === c.w && Math.abs(w.s - c.s) <= .1 && Math.abs(w.e - c.e) <= .1;
  });
}
