import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyTimeline, newClip, timelineWords, type Timeline } from '../../core/src/index.ts';
import { editorialFindings } from '../src/editorial-qa.ts';
import type { FootageAnalysis } from '../../media/src/footage.ts';

const said = (text: string, t0: number, step = 0.4) => text.split(' ').map((w, i) => ({ w, s: t0 + i * step, e: t0 + i * step + step * 0.8 }));
function edit(build: (tl: Timeline) => void): Timeline { const tl = emptyTimeline('9:16', 30); build(tl); return tl; }
const codes = (f: { code: string; class: string }[]) => f.map((x) => `${x.code}:${x.class}`).sort();

test('a cut through a word is an objective defect with a trim fix', async () => {
  const src = said('we grew revenue by forty percent last quarter', 0);
  const tl = edit((t) => { t.clips.push(newClip(t, 'v1', 0, 1.0)); t.clips.push(newClip(t, 'v1', 2.0, 3.6)); });
  const words = timelineWords(tl, { v1: src });
  const r = await editorialFindings(tl, words, new Map(), { sources: { v1: src } });
  const cut = r.findings.filter((f) => f.code === 'clipped-word');
  assert.ok(cut.length >= 1 && cut.every((f) => f.class === 'objective' && f.severity === 'defect'), JSON.stringify(cut));
  assert.equal((cut[0]!.fixOps![0] as { op: string }).op, 'trim');
  assert.ok(cut[0]!.at, 'findings carry the timeline range to re-render');
});

test('explicit requirements are objective; what the user asked for is a preference, not a defect', async () => {
  const src = said('a b c d e f g h i j k l m n o p q r s t', 0, 1.5);
  const tl = edit((t) => {
    t.clips.push(newClip(t, 'v1', 0, 30));
    for (let i = 0; i < 9; i++) t.clips[0]!.zoom.push({ s: 1 + i * 3, d: 0.4, to: 1.1, mode: 'punch' });
    t.color = { saturation: 1.3 };
  });
  const words = timelineWords(tl, { v1: src });
  const asked = await editorialFindings(tl, words, new Map(), { constraints: { zooms: true, captions: false, target: 20 } });
  assert.ok(codes(asked.findings).includes('repetitive-pattern:preference'), codes(asked.findings).join());
  assert.ok(codes(asked.findings).includes('unfulfilled-requirement:objective'), 'captions declined but burned in; 30 s > 20 s');
  assert.ok(codes(asked.findings).includes('unauthorized-look:objective'));
  const fix = asked.findings.find((f) => f.code === 'unauthorized-look')!.fixOps!;
  assert.deepEqual(fix, [{ op: 'color', clear: true }]);
  // Without production constraints (hand editing) a grade the user applied is not "unauthorized".
  const manual = await editorialFindings(tl, words, new Map());
  assert.ok(!manual.findings.some((f) => f.code === 'unauthorized-look'));
  assert.ok(codes(manual.findings).includes('repetitive-pattern:advisory'));
  assert.match(manual.summary.note, /not proof of creative quality/);
});

test('graphics, b-roll and SFX are checked against what is said and shown', async () => {
  const src = said('our churn dropped to 3 percent after the redesign of the onboarding flow', 0);
  const tl = edit((t) => {
    t.clips.push(newClip(t, 'v1', 0, 8));
    t.gfx.push({ id: 'g1', preset: 'stat', ref: { at: 1 }, d: 2, props: { value: '45%' } });
    t.broll.push({ id: 'b1', src: 'img1', in: 0, ref: { at: 3 }, d: 2, fit: 'cover' });
    t.sfx.push({ id: 's1', kind: 'whoosh', ref: { at: 5.5 }, vol: 1 });
  });
  const words = timelineWords(tl, { v1: src });
  const r = await editorialFindings(tl, words, new Map(), { assetTerms: new Map([['img1', ['beach', 'sunset']]]) });
  const c = codes(r.findings);
  for (const k of ['irrelevant-graphic:advisory', 'unmotivated-broll:advisory', 'unmotivated-sfx:advisory', 'competing-text:advisory']) assert.ok(c.includes(k), `${k} in ${c.join()}`);
  // Relevant content passes.
  const ok = edit((t) => { t.clips.push(newClip(t, 'v1', 0, 8)); t.gfx.push({ id: 'g1', preset: 'stat', ref: { at: 1 }, d: 2, props: { value: '3%' } }); t.broll.push({ id: 'b1', src: 'img1', in: 0, ref: { at: 3 }, d: 2, fit: 'cover' }); t.captions.style = 'none'; });
  const r2 = await editorialFindings(ok, timelineWords(ok, { v1: src }), new Map(), { assetTerms: new Map([['img1', ['onboarding screens']]]) });
  assert.deepEqual(r2.findings.filter((f) => /irrelevant|unmotivated/.test(f.code)), []);
});

test('the active speaker outside the crop is objective and carries a speaker-follow fix', async () => {
  const tl = edit((t) => { t.clips.push(newClip(t, 'v1', 0, 8)); t.clips[0]!.cx = 0; t.captions.style = 'none'; });
  const a = {
    asset: { file: 'x', dur: 8, w: 1920, h: 1080, fps: 30, audio: true, analyzedSeconds: 8, truncated: false },
    observed: { shots: [{ id: 's1', t0: 0, t1: 8 }] },
    inferred: {
      reframe: [{ aspect: '9:16', subject: 'active speaker', keys: [{ t: 0, cx: 0.8, cy: 0.5 }], crop: { w: 0.316, h: 1 }, subjectInside: 1, basis: 'test' }],
      speakers: { fps: 8, faceTracks: [{ id: 'face1', t0: 0, t1: 8, x: 0.8, area: 0.02 }], segments: [{ t0: 1, t1: 6, track: 'face1', confidence: 0.1 }], recommendations: [], speech: 'transcript', basis: 'test', ms: 1 },
    },
  } as unknown as FootageAnalysis;
  const r = await editorialFindings(tl, [], new Map([['v1', a]]));
  const f = r.findings.find((x) => x.code === 'speaker-off-crop');
  assert.ok(f && f.class === 'objective', JSON.stringify(r.findings));
  assert.equal((f!.fixOps![0] as { cx: number }).cx, 0.939, 'centre 0.8 with a 0.316 crop → offset 1 (clamped right)');
});
