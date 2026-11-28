import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectCuts, findSilences, findMoments, groupScenes, quietRegions, samplingFps, type FootageAnalysis, type Shot } from '../src/footage.ts';
import { footageFindings, sourceToOutput } from '../../render/src/footage-qa.ts';
import { editingBrief } from '../../story/src/brief.ts';
import { emptyTimeline, newClip } from '../../core/src/index.ts';

const hist = (bin: number) => { const h = new Float32Array(16); h[bin] = 1; return h; };
const frame = (t: number, bin: number, diff = 1, luma = 100) => ({ t, luma, clipLow: 0, clipHigh: 0, detail: 10, diff, hist: hist(bin), grid: new Array(9).fill(1) });

test('cut detection: histogram changes, structural changes, and one-frame flashes are not cuts', () => {
  const fps = 10;
  const stats = [
    ...Array.from({ length: 20 }, (_, i) => frame(i / fps, 3)),
    ...Array.from({ length: 20 }, (_, i) => frame((20 + i) / fps, 9)), // hard cut at 2.0 s (histogram)
    frame(4.0, 15, 120, 250), // a one-frame white flash
    ...Array.from({ length: 19 }, (_, i) => frame((41 + i) / fps, 9)),
  ];
  // the frame after the flash returns to the previous look
  stats[41] = frame(4.1, 9, 120);
  const cuts = detectCuts(stats as never, fps);
  assert.deepEqual(cuts.map((c) => c.t), [2]);
  // a structural change with an identical histogram (two different patterns, same tones)
  const same = [...Array.from({ length: 20 }, (_, i) => frame(i / fps, 5, 1)), frame(2, 5, 80), ...Array.from({ length: 19 }, (_, i) => frame((21 + i) / fps, 5, 1))];
  assert.deepEqual(detectCuts(same as never, fps).map((c) => c.t), [2]);
});

test('silences use an adaptive floor; moments need evidence; adaptive sampling bounds work', () => {
  const levels = [...Array(10).fill(-30), ...Array(4).fill(-80), ...Array(10).fill(-30)];
  assert.deepEqual(findSilences(levels), [{ t0: 5, t1: 7 }]);
  const motion = Array(40).fill(2); motion[20] = 12;
  const audio = Array(40).fill(-30); audio[30] = -10;
  const m = findMoments(motion, audio, [], 5);
  assert.deepEqual(m.map((x) => Math.round(x.t)), [10, 15]);
  assert.ok(m.every((x) => x.evidence.length && x.confidence > 0 && x.confidence < 1));
  assert.equal(findMoments(Array(40).fill(2), Array(40).fill(-30), []).length, 0, 'flat signals produce no moments');
  assert.equal(samplingFps(120, 30), 10);
  assert.equal(samplingFps(3600, 30), 2);
});

test('scenes group visually similar shots and split on long pauses; quiet regions rank by activity', () => {
  const sig = (b: number) => { const s = new Array(16).fill(0); s[b] = 1; return s; };
  const shot = (id: string, t0: number, t1: number, b: number): Shot => ({ id, t0, t1, cutScore: 0.5, keyframe: t0, luma: 100, motion: 2, detail: 10, signature: sig(b) });
  const shots = [shot('s1', 0, 2, 3), shot('s2', 2, 4, 3), shot('s3', 4, 6, 9), shot('s4', 6, 8, 9)];
  assert.deepEqual(groupScenes(shots, []).map((s) => s.shots), [['s1', 's2'], ['s3', 's4']]);
  assert.deepEqual(groupScenes(shots, [{ t0: 5.5, t1: 7.2 }]).map((s) => s.shots), [['s1', 's2'], ['s3'], ['s4']]);
  const q = quietRegions([0.1, 0.9, 0.9, 0.9, 0.2, 0.9, 0.9, 0.9, 0.3]);
  assert.deepEqual(q.map((r) => [r.x, r.y]), [[0.167, 0.167], [0.5, 0.5], [0.833, 0.833]]);
});

function analysis(over: Partial<FootageAnalysis['inferred']> = {}): FootageAnalysis {
  return {
    schema: 'frame.footage/1', asset: { file: 'x.mp4', dur: 20, w: 1920, h: 1080, fps: 30, audio: true, analyzedSeconds: 20, truncated: false }, provenance: [],
    capabilities: { shots: { status: 'ok', tool: 't' }, motion: { status: 'ok', tool: 't' }, quality: { status: 'ok', tool: 't' }, audio: { status: 'ok', tool: 't' },
      speech: { status: 'unavailable', reason: 'no transcript' }, faces: { status: 'unavailable', reason: 'OpenCV for Python not installed' }, text: { status: 'unavailable', reason: 'not requested' } },
    observed: { shots: [{ id: 's1', t0: 0, t1: 20, cutScore: 0, keyframe: 10, luma: 100, motion: 2, detail: 10, signature: [] }], motion: [], audio: [-30, -10], silences: [{ t0: 4, t1: 5 }], quality: [], gridActivity: [] },
    inferred: { scenes: [{ id: 'sc1', shots: ['s1'], t0: 0, t1: 20, confidence: 0.6, basis: 'start' }], moments: [{ id: 'm1', t: 15, t0: 13.5, t1: 16.5, score: 3, confidence: 0.78, evidence: ['audio 12 dB above median'], signals: {} }],
      quietRegions: [{ x: 0.83, y: 0.17, w: 0.33, h: 0.33, activity: 0.1 }], pacing: { cutsPerMinute: 0, meanShotSec: 20, label: 'low' }, ...over },
  };
}

test('source-to-output mapping follows cover crop and crop centre', () => {
  const b = sourceToOutput({ x: 0.5, y: 0.5, w: 0.2, h: 0.4 }, { w: 1920, h: 1080 }, { w: 1080, h: 1920 }, 0.5, 0.5);
  assert.ok(Math.abs(b.x - 0.5) < 1e-9 && Math.abs(b.y - 0.5) < 1e-9 && b.w > 0.6, JSON.stringify(b));
  const left = sourceToOutput({ x: 0.2, y: 0.5, w: 0.1, h: 0.2 }, { w: 1920, h: 1080 }, { w: 1080, h: 1920 }, 0.5, 0.5);
  assert.ok(left.x < 0, 'a subject at the left edge of 16:9 falls outside a centred 9:16 crop');
});

test('footage-aware QA flags graphics and captions over the presenter, a bad crop, repeated zooms and a missing moment', () => {
  const tl = emptyTimeline('9:16');
  tl.clips = [newClip(tl, 'v1', 0, 10)];
  tl.clips[0]!.cx = 0.5;
  tl.scenes = [{ id: 'k', spec: { v: 1, at: 1, offset: 0, duration: 3, z: 0, layers: [{ id: 'card', kind: 'rect', x: 0.5, y: 0.45, w: 0.8, h: 0.2 }] } as never }];
  tl.clips[0]!.fx = Array.from({ length: 4 }, (_, i) => ({ type: 'kf' as const, keys: [{ t: i, s: 1 }, { t: i + 0.5, s: 1.2 }] }));
  const centred = analysis({ presenter: { x: 0.5, y: 0.55, w: 0.12, h: 0.35, confidence: 0.9, basis: 'test' } });
  const codes = footageFindings(tl, new Map([['v1', centred]])).map((f) => f.code);
  assert.ok(codes.includes('graphics-over-presenter'), codes.join());
  assert.ok(codes.includes('captions-over-presenter'), codes.join());
  assert.ok(codes.includes('missing-moment'), 'moment at 15 s is outside the 0–10 s clip');
  assert.ok(!codes.includes('crop-cuts-presenter'), 'a centred presenter survives a centred crop');
  const offside = analysis({ presenter: { x: 0.12, y: 0.5, w: 0.15, h: 0.4, confidence: 0.9, basis: 'test' } });
  assert.ok(footageFindings(tl, new Map([['v1', offside]])).some((f) => f.code === 'crop-cuts-presenter'));
  const long = emptyTimeline('16:9');
  long.clips = [newClip(long, 'v1', 0, 20)];
  long.clips[0]!.fx = Array.from({ length: 6 }, (_, i) => ({ type: 'kf' as const, keys: [{ t: i * 3, s: 1 }, { t: i * 3 + 0.5, s: 1.25 }] }));
  assert.ok(footageFindings(long, new Map([['v1', analysis()]])).some((f) => f.code === 'repetitive-zoom'));
});

test('briefs are compact, task-specific and state what is unavailable instead of guessing', () => {
  const words = 'Solar panels cut bills by 40% in three years . First , install the inverter . Then connect the meter . Follow for more tips .'.split(' ')
    .map((w, i) => ({ w, s: i * 0.4, e: i * 0.4 + 0.35 }));
  const b = editingBrief(analysis(), 'informative', words, 4) as Record<string, any>;
  assert.equal(b.brief, 'frame.brief/1');
  assert.ok(b.statements.length > 0 && b.statements.length <= 4);
  assert.ok(b.visuals.some((v: { kind: string; value?: string }) => v.kind === 'stat' && v.value === '40%'), JSON.stringify(b.visuals));
  assert.ok(b.unavailable.some((u: string) => u.startsWith('faces:')));
  const s = editingBrief(analysis(), 'sports') as Record<string, any>;
  assert.match(s.note, /not recognized goals/);
  assert.equal(s.moments[0].id, 'm1');
  assert.ok(JSON.stringify(b).length < 2500, `informative brief stays compact (${JSON.stringify(b).length} chars)`);
  const noTr = editingBrief(analysis(), 'informative') as Record<string, any>;
  assert.match(noTr.note, /no transcript/);
});

test('Phase 5 QA: graphics over a moving subject at the times it passes, subject cut by the crop, b-roll hiding it', () => {
  const tl = emptyTimeline('9:16');
  tl.clips = [newClip(tl, 'v1', 0, 10)];
  // A runner crosses the 16:9 frame left → right over 10 s; a card sits on the right from 6 s to 9 s.
  const boxes = Array.from({ length: 21 }, (_, i) => [i * 0.5, 0.05 + i * 0.04, 0.4, 0.1, 0.4] as [number, number, number, number, number]);
  const runner = { id: 'person1', label: 'person', t0: 0, t1: 10, n: 21, score: 0.8, coverage: 1, speed: 0.08, area: 0.04, faceSamples: 0, boxes };
  const a = analysis({ subjects: { primary: 'person1', moving: ['person1'], basis: [] }, reframe: [{ aspect: '9:16', subject: 'person1', keys: [{ t: 0, cx: 0.3, cy: 0.5 }], subjectInside: 1, basis: 'test' }] });
  a.observed.tracks = [runner];
  tl.scenes = [{ id: 'k', spec: { v: 1, at: 6, offset: 0, duration: 3, z: 0, layers: [{ id: 'card', kind: 'rect', x: 0.75, y: 0.6, w: 0.4, h: 0.3 }] } as never }];
  const f = footageFindings(tl, new Map([['v1', a]]));
  const g = f.find((x) => x.code === 'graphics-over-subject');
  assert.ok(g, f.map((x) => x.code).join());
  assert.ok((g!.detail!.times as number[]).every((t) => t >= 6 && t < 9), JSON.stringify(g!.detail));
  const crop = f.find((x) => x.code === 'crop-cuts-subject');
  assert.ok(crop && crop.fix === 'reframe c1 follow=person1' || crop?.fix?.startsWith('reframe'), 'the runner leaves a centred 9:16 crop; reframe keys are offered');
  tl.broll = [{ id: 'b1', src: 'v2', in: 0, ref: { at: 2 }, d: 3, fit: 'cover' } as never];
  assert.ok(footageFindings(tl, new Map([['v1', a]])).some((x) => x.code === 'overlay-over-subject'));
  // No tracks → no Phase 5 findings (nothing is guessed).
  assert.ok(!footageFindings(tl, new Map([['v1', analysis()]])).some((x) => /subject/.test(x.code)));
});
