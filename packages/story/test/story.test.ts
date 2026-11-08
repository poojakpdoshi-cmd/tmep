import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectList, detectStat, detectStep, detectCta, storyboard, splitSentences } from '../src/rules.ts';
import { planTimeline } from '../src/planner.ts';
import { TEMPLATES, getTemplate } from '../src/templates.ts';
import type { TlWord, Word } from '../../core/src/index.ts';
import { layout, resolveRef, duration } from '../../core/src/index.ts';

const tw = (text: string, start = 0): TlWord[] => text.split(' ').map((w, k) => ({ w, s: start + k * 0.4, e: start + k * 0.4 + 0.3, src: 'v1', i: k, k }));
const sent = (text: string) => splitSentences(tw(text))[0]!;

test('list detection: "create images, videos, audio, and code"', () => {
  const items = detectList(sent('Generative AI can create images, videos, audio, and code.'));
  assert.deepEqual(items?.map((x) => x.label), ['images', 'videos', 'audio', 'code']);
  assert.ok(items!.every((x, i, a) => i === 0 || x.t > a[i - 1]!.t), 'items timed to their words');
  assert.equal(detectList(sent('I like this and that.')), undefined);
});

test('stat detection: percents, multipliers, money; ignores years and small numbers', () => {
  assert.deepEqual(detectStat(sent('It is 90 percent faster than editing.'))?.value, '90%');
  assert.equal(detectStat(sent('That is 10 times better.'))?.value, '10x');
  assert.equal(detectStat(sent('We raised $5 million last year.'))?.value, '$5M');
  assert.equal(detectStat(sent('Back in 2019 it started.')), undefined);
  assert.equal(detectStat(sent('I have 3 cats.')), undefined);
});

test('step and CTA detection', () => {
  assert.equal(detectStep(sent('First, record your footage.'))?.n, 1);
  assert.equal(detectStep(sent('Step two is editing.'))?.n, 2);
  assert.equal(detectCta(sent('Follow for more tips.'))?.text, 'Follow for more');
  assert.equal(detectCta(sent('Check the link in bio.'))?.text, 'Link in bio');
});

test('storyboard density limiter never overlaps graphics', () => {
  const words = [...tw('AI can make images, videos, audio, and code.'), ...tw('It is 90 percent faster.', 3.8), ...tw('First, do this.', 6)];
  const { accepted } = storyboard(words, { lists: true, stats: true, steps: true, cta: true, keywords: false, zoomEvery: 3, sfx: true, gfxGap: 0.4, dur: 9 });
  const g = accepted.filter((p) => p.kind === 'gfx').sort((a, b) => a.t - b.t);
  for (let i = 1; i < g.length; i++) assert.ok(g[i]!.t >= g[i - 1]!.t + g[i - 1]!.d, 'no overlap');
  assert.ok(accepted.some((p) => p.kind === 'sfx' && p.sfx === 'pop'));
});

test('planner: reel template builds a complete, anchored, target-length timeline', () => {
  const W = (text: string, start: number): Word[] => text.split(' ').map((w, k) => ({ w, s: start + k * 0.42, e: start + k * 0.42 + 0.34 }));
  const words = [
    ...W('Generative AI is changing content creation.', 0.5),
    ...W('Um, let me explain why.', 4),
    ...W('Generative AI can create images, videos, audio, and code.', 7),
    ...W('It is 90 percent faster than editing by hand.', 14),
    ...W('Follow for more tips like this.', 20),
  ];
  const { tl, summary } = planTimeline({ template: 'reel', sources: [{ id: 'v1', dur: 25, kind: 'video', words }], target: 15, title: 'AI in 15s' });
  assert.equal(tl.settings.ratio, '9:16');
  assert.ok(summary.dur <= 15 * 1.1, `dur ${summary.dur}`);
  assert.ok(summary.gfx.icons === 1 && summary.gfx.cta === 1 && summary.gfx.title === 1, JSON.stringify(summary.gfx));
  const placed = layout(tl);
  for (const g of tl.gfx) {
    const t = resolveRef(placed, g.ref);
    assert.ok(t !== undefined && t >= 0 && t < duration(tl), `${g.id} resolvable`);
  }
  assert.equal(tl.captions.style, 'kinetic');
});

test('all templates resolve and plan without errors', () => {
  const words: Word[] = 'One two three four five six seven eight nine ten.'.split(' ').map((w, k) => ({ w, s: k * 0.5, e: k * 0.5 + 0.4 }));
  for (const name of Object.keys(TEMPLATES)) {
    const { tl } = planTimeline({ template: name, sources: [{ id: 'v1', dur: 6, kind: 'video', words }] });
    assert.ok(tl.clips.length > 0, name);
  }
  assert.equal(getTemplate('instagram_reel')?.name, 'reel');
  assert.throws(() => planTimeline({ template: 'nope', sources: [] }), /unknown template/);
});
