/**
 * Bounds of the staged audio mix (Stabilization A5). Pure planning: no FFmpeg, so these run
 * everywhere and are the guard against the failure A5 fixed — a command line, or a number of
 * inputs, that grows with the length of the timeline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandLineLength, WINDOWS_CMDLINE_MAX } from '../../media/src/exec.ts';
import { graphToScript } from '../src/stage.ts';
import { planSpeech, planSfx, speechChunkArgs, sfxWindowArgs, finalMixArgs, samplePos, SR, AUDIO_LIMITS, type ClipAudio, type AudioLimits } from '../src/audio.ts';
import { emptyTimeline, type Timeline } from '../../core/src/index.ts';

/** A long Windows path, as footage in a user's folder has. */
const LONG = 'C:\\Users\\poojakdoshi\\Videos\\Reels\\2026-11 shoot\\raw footage (camera A, take 3, selects)\\interview-master-01.mp4';

const clips = (n: number, opts: { x?: number; path?: string } = {}): ClipAudio[] =>
  Array.from({ length: n }, (_, i) => ({
    path: opts.path ?? LONG,
    in: i * 0.37,
    speed: 1,
    vol: 1,
    n: 19_200,
    x: i && opts.x ? opts.x : 0,
    hash: `${(i * 2654435761) % 0xffffffff}`.padStart(8, '0'),
  }));

const timeline = (): Timeline => emptyTimeline('9:16', 30);

/**
 * The command line a process is really started with: a graph too long to pass as an argument
 * goes to a file in the working directory (`maybeScript`), so measure what is left.
 */
function effectiveLength(args: string[]): number {
  const sent = graphToScript(args) ? args.map((a, i) => (args[i - 1] === '-filter_complex' ? 'graph-0123456789ab.1234.abcdef.tmp.txt' : a)) : args;
  return commandLineLength('C:\\ffmpeg\\bin\\ffmpeg.exe', ['-hide_banner', '-nostdin', '-y', ...sent]);
}

/** Longest command line and most inputs of every FFmpeg process the stage would start. */
function worst(n: number, opts: { x?: number; sfx?: number; music?: boolean } = {}) {
  const tl = timeline();
  if (opts.music) tl.music = { src: 'a1', vol: -12, duck: true, fade: 1.5 } as Timeline['music'];
  const list = clips(n, opts.x ? { x: opts.x } : {});
  const chunks = planSpeech(list);
  const total = chunks.reduce((a, c) => a + c.samples, 0);
  const sfx = Array.from({ length: opts.sfx ?? 0 }, (_, i) => ({ file: 'C:\\Users\\poojakdoshi\\AppData\\Local\\Temp\\tmep\\cache\\sfx\\whoosh-v1.wav', t: i * 0.31, vol: -3, len: SR / 2 }));
  const windows = planSfx(sfx, total);
  const cmds = [
    ...chunks.map((c) => speechChunkArgs(c, 'C:\\Users\\poojakdoshi\\AppData\\Local\\Temp\\tmep\\cache\\audio\\stems\\0123456789abcdef0123.wav.1234.abcdef.tmp.wav').args),
    ...windows.map((w) => sfxWindowArgs(w, 'C:\\Users\\poojakdoshi\\AppData\\Local\\Temp\\tmep\\cache\\audio\\stems\\0123456789abcdef0123.wav.1234.abcdef.tmp.wav').args),
    finalMixArgs(tl, { speechList: 'speech.txt', ...(windows.length ? { sfxList: 'sfx.txt' } : {}), ...(opts.music ? { music: { path: LONG, kind: 'audio' as const, hash: 'h', audio: true, dur: 120 } } : {}), totalSamples: total, out: 'C:\\Users\\poojakdoshi\\Videos\\Reels\\renders\\reel.m4a.1234.abcdef.tmp.m4a' }).args,
  ];
  return {
    chars: Math.max(...cmds.map(effectiveLength)),
    inputs: Math.max(...cmds.map((a) => a.filter((x) => x === '-i').length)),
    stems: chunks.length + windows.length,
    total,
  };
}

test('no command line and no input count grows with the number of clips', () => {
  const sizes = [50, 100, 200, 400, 800, 2000, 5000];
  const rows = sizes.map((n) => ({ n, ...worst(n) }));
  for (const r of rows) {
    assert.ok(r.chars < WINDOWS_CMDLINE_MAX / 2, `${r.n} clips: longest command line ${r.chars} characters`);
    assert.ok(r.inputs <= AUDIO_LIMITS.maxClips + 1, `${r.n} clips: ${r.inputs} inputs`);
  }
  // the bound is flat, not merely under the limit: once chunks are full, more clips add
  // more chunks, never a longer command
  const full = rows.filter((r) => r.n >= 400);
  const chars = new Set(full.map((r) => r.chars));
  const inputs = new Set(full.map((r) => r.inputs));
  assert.equal(inputs.size, 1, `400..5000 clips: same inputs per process (${[...inputs].join(',')})`);
  assert.ok(Math.max(...chars) - Math.min(...chars) < 100, `400..5000 clips: same command length (${[...chars].join(',')})`);
  assert.ok(rows[rows.length - 1]!.stems > rows[0]!.stems * 50, 'the work itself still scales with the timeline');
  assert.equal(rows[rows.length - 1]!.total, 5000 * 19_200, 'every clip is still in the mix');
});

test('the bound holds with crossfades, sound effects and music too', () => {
  for (const opts of [{ x: 3000 }, { sfx: 400 }, { music: true }, { x: 3000, sfx: 400, music: true }]) {
    const r = worst(1000, opts);
    assert.ok(r.chars < WINDOWS_CMDLINE_MAX / 2, `${JSON.stringify(opts)}: ${r.chars} characters`);
    assert.ok(r.stems > 0);
    assert.ok(r.inputs <= AUDIO_LIMITS.maxClips + 1, `${JSON.stringify(opts)}: ${r.inputs} inputs`);
  }
});

test('a chunk is cut short when its inputs would get too long, however few clips it has', () => {
  // a pathological path: one clip's input arguments alone are 2 KB
  const long = `C:\\${'nested folder\\'.repeat(140)}clip.mp4`;
  const chunks = planSpeech(clips(60, { path: long }));
  assert.ok(chunks.length > 60 / AUDIO_LIMITS.maxClips, 'more chunks than the clip limit alone would give');
  for (const c of chunks) {
    const chars = effectiveLength(speechChunkArgs(c, 'out.wav').args);
    assert.ok(chars < WINDOWS_CMDLINE_MAX / 2, `${c.count} clips of a 2 KB path: ${chars} characters`);
  }
});

interface Fx {
  file: string;
  t: number;
  vol: number;
  len: number;
}

const FX_FILES = ['pop', 'click', 'ding', 'whoosh', 'riser', 'swoosh'].map((k) => `C:\\Users\\poojakdoshi\\AppData\\Local\\Temp\\tmep\\cache\\sfx\\${k}-v1.wav`);
/** Lengths of the built-in effects in samples (0.22 s ... 1.0 s). */
const FX_LEN = [10_560, 3_360, 43_200, 26_400, 48_000, 14_400];
const fx = (i: number, t: number): Fx => ({ file: FX_FILES[i % 6]!, t, vol: -30 - (i % 5), len: FX_LEN[i % 6]! });

/**
 * The accounting every effect plan has to satisfy, checked from the plan alone:
 *  - windows follow each other on the bus, none empty, none past the end of the timeline;
 *  - a window lists exactly the effects that sound in it, each exactly once — not one fewer (an
 *    effect dropped) and not one more (an effect doubled, or a stream that mixes nothing);
 *  - no effect sounds where the bus has no window (the silence between windows).
 * Together: every sample of every effect is mixed exactly once.
 * Returns the largest number of streams and of inputs any window needs.
 */
function checkBus(sfx: Fx[], total: number, limits: AudioLimits = AUDIO_LIMITS): { windows: number; streams: number; inputs: number; chars: number } {
  const windows = planSfx(sfx, total, limits);
  const id = (file: string, start: number, vol: number) => `${file}|${start}|${vol}`;
  const real = sfx
    .map((s) => ({ ...s, start: Math.round(s.t * 1000) * (SR / 1000) }))
    .filter((s) => s.t >= 0 && s.start < total)
    .map((s) => ({ ...s, end: Math.min(s.start + s.len, total) }));
  const covered = new Map<string, number>();
  let cursor = 0;
  let streams = 0;
  let inputs = 0;
  let chars = 0;
  for (const w of windows) {
    assert.equal(w.at, cursor + w.silence * SR, 'a window starts after the silence that precedes it');
    assert.ok(w.samples > 0, 'no empty window');
    const end = w.at + w.samples;
    const want = real.filter((s) => s.start < end && s.end > w.at).map((s) => id(s.file, s.start, s.vol)).sort();
    const got = w.uses.map((u) => id(u.file, w.at + u.off, u.vol)).sort();
    assert.deepEqual(got, want, `window ${w.at}..${end} mixes exactly the effects that sound in it`);
    for (const s of real) {
      const n = Math.min(end, s.end) - Math.max(w.at, s.start);
      if (n > 0) covered.set(id(s.file, s.start, s.vol), (covered.get(id(s.file, s.start, s.vol)) ?? 0) + n);
    }
    const args = sfxWindowArgs(w, 'C:\\Users\\poojakdoshi\\AppData\\Local\\Temp\\tmep\\cache\\audio\\stems\\0123456789abcdef0123.wav.1234.abcdef.tmp.wav').args;
    assert.equal(args.filter((a) => a === '-i').length, new Set(w.uses.map((u) => u.file)).size, 'one input per distinct effect file');
    streams = Math.max(streams, w.uses.length);
    inputs = Math.max(inputs, args.filter((a) => a === '-i').length);
    chars = Math.max(chars, effectiveLength(args));
    cursor = end;
  }
  assert.ok(cursor <= total, `the bus never runs past the timeline: ${cursor} of ${total}`);
  // identical effects share an id: together they must be covered once each
  const due = new Map<string, number>();
  for (const s of real) due.set(id(s.file, s.start, s.vol), (due.get(id(s.file, s.start, s.vol)) ?? 0) + (s.end - s.start));
  assert.deepEqual([...covered].sort(), [...due].sort(), 'every sample of every effect is on the bus exactly once');
  return { windows: windows.length, streams, inputs, chars };
}

test('sound-effect windows cover the bus in order: bursts, long gaps and every chunk size', () => {
  const total = samplePos(30 * 60, 30); // one minute
  // 300 effects: a burst 10 ms apart, then a long gap, then a steady run
  const sfx = Array.from({ length: 300 }, (_, i) => fx(i, i < 150 ? 0.5 + i * 0.01 : 20 + (i - 150) * 0.25));
  for (const maxSfx of [1, 5, 32, 1000]) {
    const r = checkBus(sfx, total, { ...AUDIO_LIMITS, maxSfx });
    assert.ok(r.inputs <= 6 && r.chars < WINDOWS_CMDLINE_MAX / 2, JSON.stringify(r));
  }
});

// Dense overlaps. `maxSfx` limits how many effects START in a window; a window also carries the
// effects still sounding when it begins, so what it mixes is what is audible in it. These pin
// down what that means when far more than `maxSfx` effects sound at once.
for (const n of [33, 64, 128, 400]) {
  test(`${n} effects at the same instant: one window, every effect once, six inputs`, () => {
    const total = SR * 12;
    const r = checkBus(Array.from({ length: n }, (_, i) => fx(i, 2)), total);
    assert.equal(r.windows, 1, 'they cannot be told apart in time, so they share a window');
    assert.equal(r.streams, n, 'the window mixes all of them');
    assert.equal(r.inputs, 6, 'but opens each effect file once');
    assert.ok(r.chars < WINDOWS_CMDLINE_MAX / 2, `command line ${r.chars} characters`);
  });

  test(`${n} effects 3 ms apart: no window mixes more than start in it plus those still sounding`, () => {
    const total = SR * 12;
    const sfx = Array.from({ length: n }, (_, i) => fx(i, 1 + i * 0.003));
    const r = checkBus(sfx, total);
    assert.equal(r.windows, Math.ceil(n / AUDIO_LIMITS.maxSfx));
    // the longest effect is 1 s, so at most 334 are ever audible together, whatever n is
    assert.ok(r.streams <= AUDIO_LIMITS.maxSfx + Math.min(n, 334), `${r.streams} streams`);
    assert.equal(r.inputs, 6);
    assert.ok(r.chars < WINDOWS_CMDLINE_MAX / 2, `command line ${r.chars} characters`);
  });
}

test('effects that start exactly where a window ends belong to the next window only', () => {
  // 10 effects at 0.5 s, then 40 at 1.0 s: the first group of 32 holds 22 of the 1.0 s effects,
  // which start exactly where its window ends. They must not be streams of that window (they
  // would be delayed past its end and cut: work for nothing, and a cache key that depends on
  // effects the window does not contain).
  const sfx = [...Array.from({ length: 10 }, (_, i) => fx(i, 0.5)), ...Array.from({ length: 40 }, (_, i) => fx(i, 1.0))];
  const windows = planSfx(sfx, SR * 12);
  assert.equal(windows[0]!.at + windows[0]!.samples, SR, 'the first window ends where the 40 start');
  assert.equal(windows[0]!.uses.length, 10, 'and holds only the 10 that sound in it');
  assert.ok(windows[0]!.uses.every((u) => u.off < windows[0]!.samples));
  checkBus(sfx, SR * 12);
  // changing one of the 40 does not change the first window's stem
  const edited = sfx.map((s, i) => (i === 15 ? { ...s, vol: -3 } : s));
  assert.equal(planSfx(edited, SR * 12)[0]!.key, windows[0]!.key);
});

test('more effects than a window may start, all at one sample after a short lead-in', () => {
  // 40 effects at 0.5 s. The first 32 would be a window of half a second of silence followed by
  // nothing: there is no such window, the lead-in belongs to the one that holds all 40.
  const sfx = Array.from({ length: 40 }, (_, i) => fx(i, 0.5));
  const windows = planSfx(sfx, SR * 12);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.at, 0);
  assert.equal(windows[0]!.uses.length, 40);
  assert.ok(windows[0]!.uses.every((u) => u.off === SR / 2));
  checkBus(sfx, SR * 12);
  // the same after whole seconds of silence, which are not part of the window
  const later = planSfx(sfx.map((s) => ({ ...s, t: 3.5 })), SR * 12);
  assert.deepEqual([later.length, later[0]!.silence, later[0]!.at, later[0]!.uses.length], [1, 3, 3 * SR, 40]);
});

test('dense random overlaps, effects cut off by the end of the timeline, and tiny windows', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const total = SR * 8;
  // 500 effects in 8 s, many identical, some starting in the last second and running past the end
  const sfx = Array.from({ length: 500 }, () => fx(Math.floor(rnd() * 6), Math.round(rnd() * 7990) / 1000));
  for (const maxSfx of [1, 7, 32]) checkBus(sfx, total, { ...AUDIO_LIMITS, maxSfx });
});

test('the inputs and the command line of an effect window do not grow with the overlap', () => {
  // what does grow is the filter graph, which goes to a file once it is long
  const at = (n: number) => checkBus(Array.from({ length: n }, (_, i) => fx(i, 2)), SR * 12);
  const few = at(33);
  const many = at(5000);
  assert.equal(many.streams, 5000);
  assert.equal(many.inputs, few.inputs);
  assert.ok(many.chars < few.chars, `the graph of 5000 streams is not on the command line: ${many.chars} characters`);
});

test('effects outside the timeline are dropped, as before', () => {
  const file = '/tmp/x.wav';
  const total = SR * 10;
  const windows = planSfx([{ file, t: -1, vol: 0, len: SR }, { file, t: 10.5, vol: 0, len: SR }, { file, t: 5, vol: 0, len: SR }], total);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.uses.length, 1);
  assert.equal(windows[0]!.at, SR * 5);
});

test('a timeline without sound effects has no effect bus at all', () => {
  assert.deepEqual(planSfx([], SR * 10), []);
  const args = finalMixArgs(timeline(), { speechList: 'speech.txt', totalSamples: SR * 10, out: 'out.m4a' }).args;
  assert.equal(args.filter((a) => a === '-i').length, 1, 'speech only');
});
