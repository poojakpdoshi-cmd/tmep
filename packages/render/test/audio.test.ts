/**
 * Bounds of the staged audio mix (Stabilization A5). Pure planning: no FFmpeg, so these run
 * everywhere and are the guard against the failure A5 fixed — a command line, or a number of
 * inputs, that grows with the length of the timeline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandLineLength, WINDOWS_CMDLINE_MAX } from '../../media/src/exec.ts';
import { graphToScript } from '../src/stage.ts';
import { planSpeech, planSfx, speechChunkArgs, sfxWindowArgs, finalMixArgs, samplePos, SR, AUDIO_LIMITS, type ClipAudio } from '../src/audio.ts';
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

test('sound-effect windows cover the bus in order and stay bounded', () => {
  const file = '/tmp/tmep/sfx/pop-v1.wav';
  const total = samplePos(30 * 60, 30); // one minute
  // 300 effects, bursts of simultaneous ones, plus long gaps
  const sfx = Array.from({ length: 300 }, (_, i) => ({ file, t: i < 150 ? 0.5 + i * 0.01 : 20 + (i - 150) * 0.25, vol: -3, len: SR }));
  const windows = planSfx(sfx, total, { ...AUDIO_LIMITS, maxSfx: 32 });
  let cursor = 0;
  for (const w of windows) {
    assert.equal(w.at, cursor + w.silence * SR, 'a window starts after the silence that precedes it');
    assert.ok(w.samples > 0, 'no empty window');
    // a window mixes exactly the effects that sound in it: no more (wasted work), no fewer
    // (a dropped effect). How many that is belongs to the content, not to the planner.
    const overlapping = sfx.filter((s) => {
      const st = Math.round(s.t * 1000) * (SR / 1000);
      return st < w.at + w.samples && st + s.len > w.at;
    }).length;
    assert.equal(w.uses.length, overlapping, `window at ${w.at}: ${w.uses.length} effects for ${overlapping} overlapping`);
    // what must stay bounded is the number of files opened, and the command line
    assert.equal(sfxWindowArgs(w, 'out.wav').args.filter((a) => a === '-i').length, 1, 'one input per distinct effect file');
    assert.ok(effectiveLength(sfxWindowArgs(w, 'out.wav').args) < WINDOWS_CMDLINE_MAX / 2);
    cursor = w.at + w.samples;
  }
  assert.ok(cursor <= total, `the bus never runs past the timeline: ${cursor} of ${total}`);
  // every effect that sounds inside the timeline is in some window
  const placed = new Set(windows.flatMap((w) => w.uses.map((u) => u.off + w.at)));
  for (const s of sfx) {
    const start = Math.round(s.t * 1000) * (SR / 1000);
    if (start < total) assert.ok(placed.has(start), `effect at ${s.t}s is on the bus`);
  }
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
