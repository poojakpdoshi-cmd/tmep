/**
 * Audio correctness of the staged mix (Stabilization A5).
 *
 * Two independent checks, both on decoded 32-bit float PCM:
 *
 *  1. Against the reference. `tests/legacy-audio.ts` is the single-pass mixer from 949e6c5.
 *     On a timeline whose clip lengths are a whole number of milliseconds AND of samples (so
 *     the reference's millisecond rounding cannot differ from sample-exact maths), the staged
 *     mix must be bit-identical to it, with speech, crossfades, sound effects, ducked music and
 *     loudness normalization all in play.
 *  2. Chunk invariance. The same timeline mixed in chunks of two clips and in one single chunk
 *     must give bit-identical output. This is what the reference cannot check: it pins down the
 *     chunk boundaries, including boundaries that fall inside a crossfade, and it holds for
 *     timelines (speed changes) where the reference itself drifts.
 *
 * Exact duration is checked too: the mix is always exactly `samplePos(frames)` samples long.
 * The reference is NOT: a clip whose length is not a whole number of milliseconds (any speed
 * change) makes it accumulate error, so audio drifts against video on long timelines.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as api from '../packages/engine/src/api.ts';
import { Project, layout, totalFrames, type Timeline } from '../packages/core/src/index.ts';
import type { MediaRef } from '../packages/render/src/graph.ts';
import { renderAudio, planSpeech, clipAudio, samplePos, SR, AUDIO_LIMITS, type AudioLimits } from '../packages/render/src/audio.ts';
import { sfxFile, SFX_KINDS } from '../packages/render/src/sfx.ts';
import { ffmpegInfo } from '../packages/media/src/ffmpeg.ts';
import { maybeScript } from '../packages/render/src/stage.ts';
import { legacyAudioArgs } from './legacy-audio.ts';

const FIX = path.join(os.tmpdir(), 'tmep-audio-fixture');
const PCM = ['-c:a', 'pcm_f32le', '-ar', String(SR), '-ac', '2'];
const FPS = 30;
let skip: string | undefined;

before(async () => {
  try {
    const info = await ffmpegInfo();
    if (!info.encoders.has('libx264')) skip = 'ffmpeg lacks libx264';
  } catch {
    skip = 'ffmpeg not installed';
  }
  if (skip) return;
  mkdirSync(FIX, { recursive: true });
  const clip = path.join(FIX, 'clip.mp4');
  if (!existsSync(clip)) {
    // speech-like content: a few tones and noise, so crossfades and misalignment are audible in the numbers
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-f', 'lavfi', '-i', 'aevalsrc=0.4*sin(2*PI*t*(300+200*sin(2*PI*t*3)))+0.2*sin(2*PI*t*1700):s=48000:d=4', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', clip]);
    assert.equal(r.status, 0, r.stderr?.toString().slice(-500));
  }
  const music = path.join(FIX, 'music.wav');
  if (!existsSync(music)) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.25*sin(2*PI*110*t)+0.1*sin(2*PI*220*t):s=48000:d=20', '-c:a', 'pcm_s16le', music]);
    assert.equal(r.status, 0);
  }
});

interface Case {
  name: string;
  clips: number;
  trans?: boolean;
  speed?: boolean;
  sfx?: boolean;
  music?: boolean;
  loud?: boolean;
  /** `n` sound effects starting 2 s in, `every` ms apart (0: all at the same instant). */
  dense?: { n: number; every: number };
  /** Mute every clip and switch loudness normalization off: the mix is the effect bus alone. */
  silent?: boolean;
}

interface Built {
  tl: Timeline;
  placed: ReturnType<typeof layout>;
  frames: number;
  media: Record<string, MediaRef>;
  sfx: { file: string; t: number; vol: number }[];
  project: Project;
  dir: string;
  work: string;
}

/**
 * A timeline of `clips` 0.4 s cuts (12 frames at 30 fps: 400 ms and 19,200 samples exactly).
 * Sources vary per clip so chunk boundaries, which follow clip content, really occur.
 */
async function build(c: Case): Promise<Built> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmep-audio-'));
  const ctx: api.Ctx = { project: dir, detail: 'standard' };
  const paths = [path.join(FIX, 'clip.mp4'), ...(c.music ? [path.join(FIX, 'music.wav')] : [])];
  await api.importMedia(ctx, { paths });
  const ranges = Array.from({ length: c.clips }, (_, i) => [((i * 7) % 8) * 0.4, ((i * 7) % 8) * 0.4 + 0.4]);
  const ops: Record<string, unknown>[] = [{ op: 'format', ratio: '9:16' }, { op: 'keep', src: 'v1', ranges }];
  if (c.music) ops.push({ op: 'music', src: 'a1', duck: true });
  await api.edit(ctx, { ops });
  const project = await Project.open(dir);
  const tl = (await project.timeline()) as Timeline;
  if (c.trans) for (let i = 1; i < tl.clips.length; i++) tl.clips[i]!.trans = { type: 'fade', d: 0.1 };
  if (c.speed) {
    tl.clips.forEach((clip, i) => {
      if (i % 3 === 0) clip.speed = 1.5;
      if (i % 5 === 0) clip.vol = 0.5;
      if (i % 7 === 0) clip.mute = true;
    });
  }
  if (c.loud) tl.loudness = -14;
  if (c.silent) {
    for (const clip of tl.clips) clip.mute = true;
    tl.loudness = 0;
  }
  const placed = layout(tl);
  const media: Record<string, MediaRef> = {};
  for (const id of new Set<string>([...tl.clips.map((x) => x.src), ...(tl.music ? [tl.music.src] : [])])) {
    const a = await project.asset(id);
    media[id] = { path: a.path, kind: a.kind, hash: a.hash, audio: a.audio, dur: a.dur };
  }
  const sfx: { file: string; t: number; vol: number }[] = [];
  if (c.sfx) {
    const sdir = project.cachePath('sfx');
    const kinds = ['pop', 'ding', 'whoosh', 'click'];
    for (let i = 0; i < 12; i++) sfx.push({ file: await sfxFile(sdir, kinds[i % kinds.length]!), t: i * 0.7 + 0.15, vol: -3 });
  }
  if (c.dense) {
    // all six built-in effects (0.07 s ... 1 s long) at five different volumes
    const sdir = project.cachePath('sfx');
    for (let i = 0; i < c.dense.n; i++) sfx.push({ file: await sfxFile(sdir, SFX_KINDS[i % SFX_KINDS.length]!), t: 2 + (i * c.dense.every) / 1000, vol: -30 - (i % 5) });
  }
  const work = path.join(dir, 'work');
  mkdirSync(work, { recursive: true });
  return { tl, placed, frames: totalFrames(tl), media, sfx, project, dir, work };
}

/** Samples of a PCM float WAV file, interleaved. */
function samples(file: string): Float32Array {
  const b = readFileSync(file);
  const off = b.indexOf(Buffer.from('data')) + 8;
  const n = Math.floor((b.length - off) / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readFloatLE(off + i * 4);
  return out;
}

const worstDiff = (a: Float32Array, b: Float32Array): number => {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
};

/** The staged mix, as PCM, with the given chunk limits (and, optionally, only some of the effects). */
async function staged(b: Built, out: string, limits?: Partial<AudioLimits>, sfx: Built['sfx'] = b.sfx): Promise<{ file: string; stems: number; maxInputs: number }> {
  const file = path.join(b.dir, out);
  const stats = await renderAudio({
    tl: b.tl, placed: b.placed, media: b.media, sfx, frames: b.frames,
    out: file, stemDir: path.join(b.dir, 'stems', out), work: b.work, temps: new Set<string>(), codec: PCM,
    ...(limits ? { limits: { ...AUDIO_LIMITS, ...limits } } : {}),
  });
  return { file, stems: stats.stems, maxInputs: stats.maxInputs };
}

/**
 * The single-pass mixer of 949e6c5, as PCM. Its graph is long, so it goes to a script file
 * through the production helper — which also picks the option name this FFmpeg understands
 * (`-filter_complex_script`, or `-/filter_complex` from FFmpeg 8).
 */
async function reference(b: Built): Promise<string> {
  const file = path.join(b.dir, 'reference.wav');
  const plan = legacyAudioArgs(b.tl, b.placed, b.media, b.sfx, b.frames, file, undefined, PCM);
  const args = await maybeScript(plan.args, b.work);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args], { cwd: b.work, encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, `reference mix failed: ${r.stderr.slice(-600)}`);
  return file;
}

/**
 * Allowed difference from the reference, and why it is not zero in two cases.
 *
 * Sound effects: the reference summed every effect into the master `amix` alongside the
 * speech; effects are now summed into their own stem first and that stem is mixed in. The same
 * numbers are added in a different order, and float32 addition is not associative, so single
 * samples can differ by one unit in the last place — about 3e-8, 150 dB below the programme.
 *
 * Ducked music: `sidechaincompress` computes its gain envelope frame by frame, so its output
 * depends on how the samples are framed (clearly on FFmpeg 8, not on 6.1). The staged mix
 * re-frames both of its inputs to a fixed size, deliberately, so that the ducking cannot
 * depend on where the chunk boundaries fell; the reference used whatever frames its own graph
 * produced. The difference is confined to the ducking envelope: a fraction of a percent of the
 * music's own level, which the RMS check below holds to 0.1% of the programme.
 */
const tolerance = (c: Case): number => (c.music ? 5e-3 : c.sfx ? 1e-7 : 0);

const CASES: Case[] = [
  { name: 'speech only', clips: 60 },
  { name: 'crossfades on every cut', clips: 60, trans: true },
  { name: 'sound effects', clips: 60, sfx: true },
  { name: 'ducked music', clips: 60, music: true },
  { name: 'loudness normalization', clips: 60, loud: true },
  { name: 'crossfades + effects + ducked music + loudness', clips: 60, trans: true, sfx: true, music: true, loud: true },
];

for (const c of CASES) {
  test(`the staged mix matches the single-pass reference sample for sample: ${c.name}`, { timeout: 300_000 }, async (t) => {
    if (skip) return t.skip(skip);
    const b = await build(c);
    const mine = await staged(b, 'staged.wav');
    assert.ok(mine.stems > 1, `the timeline must be split into stems to test anything: ${mine.stems}`);
    assert.ok(mine.maxInputs <= AUDIO_LIMITS.maxClips + 1, `inputs per process stay bounded: ${mine.maxInputs}`);
    const want = samplePos(b.frames, FPS);
    const a = samples(await reference(b));
    const d = samples(mine.file);
    assert.equal(d.length / 2, want, 'the mix is exactly as long as the timeline');
    assert.equal(a.length / 2, want, 'this timeline is sample-aligned, so the reference agrees');
    const diff = worstDiff(a, d);
    assert.ok(diff <= tolerance(c), `worst sample differs from the reference by ${diff} (allowed ${tolerance(c)})`);
    if (tolerance(c) > 0) {
      // a tolerance must not hide a timing or content error: the difference has to be noise
      let err = 0;
      let signal = 0;
      for (let i = 0; i < a.length; i++) {
        err += (a[i]! - d[i]!) ** 2;
        signal += a[i]! ** 2;
      }
      const ratio = Math.sqrt(err / signal);
      assert.ok(ratio < 1e-3, `the difference is ${(ratio * 100).toFixed(4)}% of the programme (RMS)`);
    }
  });
}

for (const c of [...CASES, { name: 'speed changes, volume and mutes', clips: 60, speed: true, trans: true, sfx: true, music: true } as Case]) {
  test(`the mix does not depend on how it was chunked: ${c.name}`, { timeout: 300_000 }, async (t) => {
    if (skip) return t.skip(skip);
    const b = await build(c);
    // two clips per chunk: boundaries land inside crossfades, and every stem is a join
    const small = await staged(b, 'chunked.wav', { minClips: 1, maxClips: 2, every: 1 });
    const whole = await staged(b, 'single.wav', { minClips: 10_000, maxClips: 10_000, every: 1_000_000, maxSfx: 1000 });
    assert.ok(small.stems > whole.stems, `the chunked mix really is split: ${small.stems} vs ${whole.stems}`);
    const a = samples(whole.file);
    const d = samples(small.file);
    assert.equal(d.length, a.length, 'same length whatever the chunking');
    assert.equal(worstDiff(a, d), 0, 'not one sample differs between chunked and single-pass mixing');
  });
}

// ---- dense effect overlaps -------------------------------------------------------------------
// A window of the effect bus mixes every effect audible in it, and when far more effects sound
// at once than may start in one window (32), that is one FFmpeg process with hundreds of
// streams. These check the audio of exactly that: nothing missing, nothing doubled.
//
// Tolerance. The reference adds each effect into the master mix one by one; the staged mix adds
// them into a stem first. With hundreds of terms the two orders of float32 addition differ by a
// few units in the last place: measured 2e-7 to 9e-7 of the peak for 33 to 400 overlapping
// effects. 4e-6 of the peak is allowed. A missing or doubled effect is not in that league: the
// quietest one here (-34 dB) is about 6e-3 of the peak, a thousand times the tolerance.

/** Largest difference between two mixes, relative to the peak of the first, and as RMS. */
function compare(a: ArrayLike<number>, d: ArrayLike<number>): { peak: number; worst: number; rms: number } {
  let peak = 0;
  let worst = 0;
  let err = 0;
  let signal = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = Math.abs(a[i]! - d[i]!);
    peak = Math.max(peak, Math.abs(a[i]!));
    worst = Math.max(worst, diff);
    err += diff * diff;
    signal += a[i]! * a[i]!;
  }
  return { peak, worst: worst / peak, rms: Math.sqrt(err / signal) };
}

for (const dense of [{ n: 33, every: 0 }, { n: 64, every: 0 }, { n: 128, every: 0 }, { n: 128, every: 3 }]) {
  const what = dense.every ? `${dense.n} effects ${dense.every} ms apart` : `${dense.n} effects at the same instant`;
  test(`dense overlap matches the single-pass reference: ${what}`, { timeout: 300_000 }, async (t) => {
    if (skip) return t.skip(skip);
    const b = await build({ name: what, clips: 30, dense });
    const mine = await staged(b, 'staged.wav');
    // six effect files, however many effects: the most inputs any process has is a speech chunk's
    assert.ok(mine.maxInputs <= AUDIO_LIMITS.maxClips + 1, `inputs per process: ${mine.maxInputs}`);
    const want = samplePos(b.frames, FPS);
    const a = samples(await reference(b));
    const d = samples(mine.file);
    assert.equal(d.length / 2, want, 'the mix is exactly as long as the timeline');
    assert.equal(a.length / 2, want);
    const r = compare(a, d);
    assert.ok(r.worst <= 4e-6, `worst sample differs by ${r.worst.toExponential(2)} of the peak`);
    assert.ok(r.rms < 1e-6, `RMS difference ${r.rms.toExponential(2)} of the programme`);
  });
}

for (const dense of [{ n: 400, every: 0 }, { n: 400, every: 3 }]) {
  const what = dense.every ? `400 effects ${dense.every} ms apart` : '400 effects at the same instant';

  test(`dense overlap is the sum of its parts: ${what}`, { timeout: 300_000 }, async (t) => {
    if (skip) return t.skip(skip);
    // The reference cannot mix this everywhere (see the next test), so it is checked without
    // it. With the speech muted and loudness normalization off (it is on by default, and not
    // linear), the mix is the effect bus alone, and mixing is linear: all 400 effects together
    // must equal the sum of four separate mixes of 100 effects each. An effect lost or doubled
    // only when the overlap is dense would break exactly this.
    const b = await build({ name: what, clips: 30, dense, silent: true });
    const whole = samples((await staged(b, 'whole.wav')).file);
    const sum = new Float64Array(whole.length);
    for (let k = 0; k < 4; k++) {
      const part = samples((await staged(b, `part${k}.wav`, undefined, b.sfx.filter((_, i) => i % 4 === k))).file);
      assert.equal(part.length, whole.length);
      for (let i = 0; i < part.length; i++) sum[i]! += part[i]!;
    }
    assert.equal(whole.length / 2, samplePos(b.frames, FPS), 'the mix is exactly as long as the timeline');
    const r = compare(sum, whole);
    assert.ok(r.peak > 0.05, `the effects are in the mix (peak ${r.peak.toFixed(3)})`);
    assert.ok(r.worst <= 4e-6, `worst sample differs by ${r.worst.toExponential(2)} of the peak`);
    assert.ok(r.rms < 1e-6, `RMS difference ${r.rms.toExponential(2)}`);
  });

  test(`dense overlap matches the single-pass reference: ${what}`, { timeout: 300_000 }, async (t) => {
    if (skip) return t.skip(skip);
    // The reference needs one input per effect: 430 here. That is past Windows' command-line
    // limit and past the macOS default of 256 open files — the limits A5 removed — so it can
    // only be run for comparison on Linux.
    if (process.platform !== 'linux') return t.skip(`the single-pass reference cannot open 430 inputs on ${process.platform}`);
    const b = await build({ name: what, clips: 30, dense });
    const mine = await staged(b, 'staged.wav');
    const a = samples(await reference(b));
    const d = samples(mine.file);
    assert.equal(d.length, a.length);
    assert.equal(d.length / 2, samplePos(b.frames, FPS));
    const r = compare(a, d);
    assert.ok(r.worst <= 4e-6, `worst sample differs by ${r.worst.toExponential(2)} of the peak`);
    assert.ok(r.rms < 1e-6, `RMS difference ${r.rms.toExponential(2)} of the programme`);
  });
}

test('the mix is sample-exact where the single-pass reference drifted', { timeout: 300_000 }, async (t) => {
  if (skip) return t.skip(skip);
  // 1.5x speed: 12 frames of source become 8 frames, 266.67 ms — not a whole number of
  // milliseconds, which is what the reference rounded (and accumulated) per clip
  const b = await build({ name: 'speed', clips: 60, speed: true });
  const mine = await staged(b, 'staged.wav');
  const want = samplePos(b.frames, FPS);
  assert.equal(samples(mine.file).length / 2, want, 'exactly as long as the timeline');
  const ref = samples(await reference(b)).length / 2;
  assert.ok(ref < want, `the reference is shorter than the timeline (drift): ${ref} vs ${want}`);
});

test('chunk plans cover every sample exactly once, whatever the limits', () => {
  // pure planning, no ffmpeg: clip lengths and crossfades of a few shapes
  const shapes: { n: number; x: number }[][] = [
    Array.from({ length: 50 }, () => ({ n: 19200, x: 0 })),
    Array.from({ length: 50 }, (_, i) => ({ n: 19200, x: i ? 3000 : 0 })),
    Array.from({ length: 50 }, (_, i) => ({ n: 4000 + ((i * 7919) % 30000), x: i ? (i % 3 === 0 ? 1999 : 0) : 0 })),
  ];
  for (const limits of [AUDIO_LIMITS, { ...AUDIO_LIMITS, minClips: 1, maxClips: 2, every: 1 }, { ...AUDIO_LIMITS, maxClips: 7, every: 3 }]) {
    for (const shape of shapes) {
      const clips = shape.map((s, i) => ({ in: 0, speed: 1, vol: 1, n: s.n, x: s.x, hash: `${i}`.padStart(8, '0'), path: '/x.mp4' }));
      const total = clips.reduce((a, c) => a + c.n - c.x, 0);
      const chunks = planSpeech(clips, limits);
      assert.equal(chunks[0]!.at, 0);
      let cursor = 0;
      let covered = 0;
      for (const ch of chunks) {
        assert.equal(ch.at, cursor, `chunk ${ch.first} starts where the previous ended`);
        assert.ok(ch.samples > 0, 'no empty chunk');
        assert.ok(ch.count <= limits.maxClips, `at most ${limits.maxClips} clips per chunk: ${ch.count}`);
        assert.ok(ch.clips.length <= limits.maxClips + 1, 'at most one borrowed crossfade partner');
        cursor += ch.samples;
        covered += ch.count;
      }
      assert.equal(cursor, total, 'the chunks cover the timeline exactly');
      assert.equal(covered, clips.length, 'every clip belongs to exactly one chunk');
    }
  }
});

test('a chunk boundary never falls where a crossfade could not be split', () => {
  // clips short enough that a transition reaches more than half of them: the plan must keep
  // such a pair in one chunk rather than splitting a clip that has no room for both fades
  const clips = Array.from({ length: 40 }, (_, i) => ({ in: 0, speed: 1, vol: 1, n: 2000, x: i ? 1200 : 0, hash: `${i}`.padStart(8, '0'), path: '/x.mp4' }));
  for (const ch of planSpeech(clips, { ...AUDIO_LIMITS, minClips: 1, maxClips: 2, every: 1 })) {
    const first = ch.clips[0]!;
    if (ch.head > 0) assert.ok(first.x + (ch.clips[1]?.x ?? 0) <= first.n, 'a split clip has room for its fade-in and its fade-out');
  }
});

test('clipAudio marks images, muted and silent clips as silence, and hashes only what is audible', async (t) => {
  if (skip) return t.skip(skip);
  const b = await build({ name: 'silence', clips: 6 });
  b.tl.clips[1]!.mute = true;
  const audio = clipAudio(layout(b.tl), b.media, FPS);
  assert.equal(audio[1]!.path, undefined, 'a muted clip has no source');
  assert.ok(audio[0]!.path, 'an audible clip has one');
  assert.notEqual(audio[0]!.hash, audio[1]!.hash);
  // a silent clip of the same length hashes the same wherever it is: one cached stem serves both
  b.tl.clips[3]!.mute = true;
  const again = clipAudio(layout(b.tl), b.media, FPS);
  assert.equal(again[3]!.hash, again[1]!.hash);
});
