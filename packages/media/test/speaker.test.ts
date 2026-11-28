import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSpeakers, faceTracks, speakerFraming, speechMask } from '../src/speaker.ts';
import { smoothFollow } from '../../story/src/plan.ts';

type M = [number, number, number, number, number, number];
/** Two faces (left x=0.2, right x=0.75) at 10 fps; `talk(t)` says who moves their mouth. */
function dialogue(seconds: number, talk: (t: number) => 'L' | 'R' | '', opts: { leftX?: number; rightX?: number } = {}) {
  const frames: { t: number; mouths: M[] }[] = [];
  for (let i = 0; i < seconds * 10; i++) {
    const t = i / 10, who = talk(t), osc = (k: number) => 0.25 + 0.2 * Math.sin(2 * Math.PI * 4 * t + k);
    frames.push({ t, mouths: [
      [opts.leftX ?? 0.2, 0.2, 0.08, 0.15, who === 'L' ? osc(0) : 0.02, who === 'L' ? osc(1) * 0.3 : 0.005],
      [opts.rightX ?? 0.75, 0.2, 0.08, 0.15, who === 'R' ? osc(2) : 0.02, who === 'R' ? osc(3) * 0.3 : 0.005],
    ] });
  }
  return frames;
}
const speechAll = (seconds: number) => ({ env: new Array(seconds * 10).fill(-20), mask: new Array(seconds * 10).fill(true) });

test('faces link into tracks and a cut ends them', () => {
  const tr = faceTracks(dialogue(6, () => ''), [3]);
  assert.equal(tr.length, 4, 'two faces × two shots');
  assert.ok(tr.every((t) => t.samples.length >= 25));
});

test('the active speaker follows mouth movement, with hysteresis', () => {
  // Left talks 0–4 s (with a 0.3 s right-face blip at 2 s), right talks 4–8 s.
  const fr = dialogue(8, (t) => (t >= 2 && t < 2.3 ? 'R' : t < 4 ? 'L' : 'R'));
  const tr = faceTracks(fr);
  const { env, mask } = speechAll(8);
  const { segments } = activeSpeakers(tr, env, mask, 0.1, 0, 8);
  const left = tr.find((t) => t.x < 0.5)!.id, right = tr.find((t) => t.x > 0.5)!.id;
  assert.deepEqual(segments.map((s) => s.track), [left, right], JSON.stringify(segments));
  assert.ok(segments[1]!.t0 >= 4 && segments[1]!.t0 <= 5.5, `switch at ${segments[1]!.t0}`);
});

test('a still face during speech is not the speaker (off-screen voice)', () => {
  const fr = dialogue(5, () => '').map((f) => ({ ...f, mouths: [f.mouths[0]!] }));
  const { env, mask } = speechAll(5);
  assert.equal(activeSpeakers(faceTracks(fr), env, mask, 0.1, 0, 5).segments.length, 0);
});

test('speech mask bridges short pauses between words', () => {
  const m = speechMask(new Array(40).fill(-30), 0.1, [{ s: 0.5, e: 1.0 }, { s: 1.5, e: 2.0 }, { s: 3.4, e: 3.6 }]);
  assert.ok(m[13] && m[14], 'a 0.5 s pause inside the turn is speech');
  assert.ok(!m[27], 'a 1.4 s gap is not');
});

test('framing: speaker changes ease, cuts step, close faces share the crop', () => {
  const fr = dialogue(8, (t) => (t < 4 ? 'L' : 'R'));
  const tr = faceTracks(fr);
  const { env, mask } = speechAll(8);
  const sp = activeSpeakers(tr, env, mask, 0.1, 0, 8);
  const f = speakerFraming(tr, sp.windows, { w: 0.32, h: 1 });
  assert.ok(Math.abs(f.keys[0]!.cx - 0.24) < 0.05, `starts on the left speaker: ${f.keys[0]!.cx}`);
  assert.ok(Math.abs(f.keys.at(-1)!.cx - 0.79) < 0.05, `ends on the right speaker: ${f.keys.at(-1)!.cx}`);
  const move = f.keys.findIndex((k, i) => i > 0 && k.cx !== f.keys[i - 1]!.cx);
  assert.ok(f.keys[move]!.t - f.keys[move - 1]!.t >= 0.45, 'the switch is an eased move, not a jump');
  // Faces close together: one crop holds both, no movement on a speaker change.
  const near = faceTracks(dialogue(8, (t) => (t < 4 ? 'L' : 'R'), { leftX: 0.4, rightX: 0.52 }));
  const g = speakerFraming(near, activeSpeakers(near, env, mask, 0.1, 0, 8).windows, { w: 0.32, h: 1 });
  assert.equal(g.keys.length, 1);
  // A cut: hold up to the cut, then step.
  const cut = faceTracks(dialogue(8, (t) => (t < 4 ? 'L' : 'R')).map((x) => (x.t >= 4 ? { ...x, mouths: [x.mouths[1]!] } : { ...x, mouths: [x.mouths[0]!] })), [4]);
  const c = speakerFraming(cut, activeSpeakers(cut, env, mask, 0.1, 0, 8).windows, { w: 0.32, h: 1 }, [{ t0: 0 }, { t0: 4 }]);
  const i = c.keys.findIndex((k) => k.t >= 4);
  assert.ok(c.keys[i]!.t - c.keys[i - 1]!.t <= 0.05 && c.keys[i]!.cx > 0.7, JSON.stringify(c.keys));
  assert.equal(c.travelPerMin, 0, 'a cut is not crop travel');
  // Smoothing keeps that step (it used to pan across cuts at 0.35 widths/s).
  const sm = smoothFollow(c.keys);
  const j = sm.findIndex((k) => k.t >= 4);
  assert.ok(sm[j]!.cx > 0.7, JSON.stringify(sm));
});

test('rapid alternation between distant faces recommends a split screen', () => {
  const fr = dialogue(12, (t) => (Math.floor(t / 2) % 2 ? 'R' : 'L'));
  const tr = faceTracks(fr);
  const { env, mask } = speechAll(12);
  const f = speakerFraming(tr, activeSpeakers(tr, env, mask, 0.1, 0, 12).windows, { w: 0.32, h: 1 });
  assert.ok(f.recommendations.some((r) => r.kind === 'split-screen'), JSON.stringify(f.recommendations));
});
