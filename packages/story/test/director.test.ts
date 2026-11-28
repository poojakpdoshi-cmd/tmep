/** Phase 6 Director: genre policy, explicit constraints win, approximate transcripts do not burn captions, reference style is clamped. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { direct } from '../src/director.ts';
import { fitRanges, itemsFor, prioritize } from '../../engine/src/production.ts';

const a = { asset: { audio: true }, observed: { shots: [], tracks: [], audio: [] }, inferred: { moments: [], subjects: undefined } } as never;
const words = [{ w: 'hello', s: 0, e: 0.4 }];

test('genre policies are restrained and explicit constraints win', () => {
  const cin = direct({ genre: 'cinematic' }, a, words);
  assert.equal(cin.zooms.allowed, false); assert.equal(cin.captions.burn, false); assert.equal(cin.effectBudgetPerMinute, 1);
  const inf = direct({ genre: 'informative' }, a, words);
  assert.ok(inf.zooms.allowed && inf.captions.burn && inf.graphics.kinds.includes('stat'));
  const off = direct({ genre: 'informative', constraints: { zooms: false, captions: false } }, a, words);
  assert.equal(off.zooms.perMinute, 0); assert.equal(off.captions.burn, false);
  assert.ok(off.decisions.filter((d) => d.source === 'user').length >= 2);
  assert.ok(off.decisions.some((d) => /no background change/.test(d.what)));
  const forced = direct({ genre: 'cinematic', constraints: { captions: true } }, a, words);
  assert.equal(forced.captions.burn, true, 'a user can ask for captions on any genre');
});

test('approximate transcripts do not burn captions unless confirmed; no transcript, no captions', () => {
  const s = direct({ genre: 'podcast' }, a, words, { transcriptApprox: true });
  assert.equal(s.captions.burn, false); assert.ok(s.open.some((o) => /approximate/.test(o)));
  assert.equal(direct({ genre: 'podcast', constraints: { captions: true } }, a, words, { transcriptApprox: true }).captions.burn, true);
  assert.equal(direct({ genre: 'podcast' }, a, []).captions.burn, false);
});

test('reference style informs, clamped to the genre; looks need permission', () => {
  const ref = { schema: 'frame.style/1', pacing: { cutsPerMinute: 90, medianShotSec: 0.7, gradualShare: 0 }, motion: { meanMotion: 5, cameraMovingShare: 0.5, cameraPanSpeed: 0.2 }, colour: { luma: 0.5, saturation: 0.6, contrast: 0.7, warmth: 0.1 }, methods: {} } as never;
  const s = direct({ genre: 'educational' }, a, words, { reference: ref });
  assert.equal(s.pacing.cutsPerMinuteGoal, 15, 'clamped to the educational range, not copied');
  assert.equal(s.colour.look, undefined); assert.ok(s.open.some((o) => /colour look/.test(o)));
  const l = direct({ genre: 'educational', constraints: { allowLook: true } }, a, words, { reference: ref });
  assert.ok(l.colour.look && Math.abs(l.colour.look.saturation!) <= 0.2);
});

test('rough cut fits a target by dropping the weakest sentences; keep/avoid honoured; effect budget; priorities', () => {
  const ws = 'One. Two words here. The key result is 40 percent growth. Filler sentence here.'.split(' ').map((w, i) => ({ w, s: i, e: i + 0.8 }));
  const f = fitRanges([[0, 14]], ws, { target: 8, avoid: [[0, 1]] }, [8]);
  const len = f.ranges.reduce((s, [x, y]) => s + y - x, 0);
  assert.ok(len <= 8 && f.ranges.every(([x]) => x >= 1), JSON.stringify(f));
  const plan = { items: Array.from({ length: 6 }, (_, i) => ({ id: `moment-${i}`, kind: 'moment', status: 'proposed', confidence: i / 10, ops: [{ op: 'punch' }] })) } as never;
  const s = direct({ genre: 'informative' }, a, words);
  assert.equal(itemsFor('fine', plan, s, 1).filter((i) => i.kind === 'moment').length, 3, 'at most 3 zooms per minute');
  assert.equal(prioritize([{ code: 'repetitive-zoom', severity: 'advisory', msg: '' }, { code: 'caption-overlap', severity: 'defect', msg: '' }, { code: 'crop-cuts-subject', severity: 'advisory', msg: '' }])[1]!.code, 'crop-cuts-subject');
});

test('Phase 7: speaker framing, motivated SFX, split screen left open, minimum length from beats', () => {
  const spk = { ...(a as object), inferred: { moments: [], speakers: { fps: 8, faceTracks: [], segments: [{ t0: 0, t1: 3, track: 'face1', confidence: 0.1 }, { t0: 3, t1: 6, track: 'face2', confidence: 0.1 }], recommendations: [{ at: [10, 15], kind: 'split-screen', reason: 'test' }], speech: 'transcript', basis: '', ms: 1 } } } as never;
  const d = direct({ genre: 'podcast' }, spk, words);
  assert.equal(d.framing.mode, 'active-speaker');
  assert.ok(d.open.some((o) => /split screen 10–15/.test(o)), 'split screen is proposed, not applied');
  assert.equal(d.sfx.allowed, false, 'no SFX for a podcast by default');
  const inf = direct({ genre: 'informative' }, a, words);
  assert.deepEqual([inf.sfx.allowed, inf.sfx.on], [true, 'graphic-entrances']);
  assert.equal(direct({ genre: 'informative', constraints: { sfx: false } }, a, words).sfx.allowed, false);
  assert.equal(direct({ genre: 'informative', constraints: { graphics: false } }, a, words).sfx.allowed, false, 'no graphics, nothing to motivate a sound');
  // 20 s of speech, minimum 26 s: the strongest moments outside the speech are added (≤ 3 s each), in order.
  const fit = fitRanges([[0, 10], [20, 30]], [], { min: 26 }, [{ t: 15, t0: 14, t1: 16.5, confidence: 0.9 }, { t: 40, t0: 39, t1: 41, confidence: 0.8 }, { t: 5, confidence: 1 }]);
  assert.deepEqual(fit.beats, [[13.75, 16.25], [39, 41]]);
  assert.deepEqual(fit.ranges.map((r) => r[0]), [0, 13.75, 20, 39]);
  assert.equal(fitRanges([[0, 10]], [], { min: 26, avoid: [[30, 50]] }, [{ t: 40, confidence: 0.9 }]).beats?.length, 0, 'avoid ranges are respected');
});
