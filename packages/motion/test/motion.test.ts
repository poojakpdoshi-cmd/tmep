import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assColor, tagColor, assTime, escapeText, AssDoc } from '../src/ass.ts';
import { ICONS, iconFor, circle, poly, signedArea } from '../src/icons.ts';
import { paginate, compileCaptions } from '../src/captions.ts';
import { renderPreset, PRESET_NAMES, normalizeShape } from '../src/presets.ts';
import { readFontFace, fontIndex } from '../src/fonts.ts';
import { defaultCaptions, type TlWord } from '../../core/src/index.ts';

test('ASS colour/time/escape formatting', () => {
  assert.equal(assColor('#FFD400'), '&H0000D4FF');
  assert.equal(assColor('#000000', 0.5), '&H80000000');
  assert.equal(tagColor('#112233'), '&H332211&');
  assert.equal(assTime(3725.456), '1:02:05.46');
  assert.equal(escapeText('a{b}\\c\nd'), 'a\\{b\\}\\\\c\\Nd');
});

test('icons: every icon parses as ASS drawing; holes have reversed winding', () => {
  for (const [name, shape] of Object.entries(ICONS)) {
    assert.match(shape, /^m [-\d.]+ [-\d.]+( [mlb]( [-\d.]+ [-\d.]+)+)+$/, name);
  }
  const pts: [number, number][] = [
    [-12, -22],
    [-12, 22],
    [24, 0],
  ];
  const fill = poly(pts).match(/-?[\d.]+/g)!.map(Number);
  const hole = poly(pts, true).match(/-?[\d.]+/g)!.map(Number);
  const toPts = (n: number[]) => n.reduce<[number, number][]>((a, v, i) => (i % 2 ? (a[a.length - 1]![1] = v, a) : [...a, [v, 0]]), []);
  assert.ok(signedArea(toPts(fill)) > 0);
  assert.ok(signedArea(toPts(hole)) < 0);
  assert.ok(circle(0, 0, 10).startsWith('m 10 0 b'));
  assert.equal(iconFor('Videos'), 'video');
  assert.equal(iconFor('pictures'), 'image');
  assert.equal(iconFor('zebra'), undefined);
});

test('normalizeShape translates drawings to a positive bounding box', () => {
  assert.equal(normalizeShape('m -10 -20 l 10 -20 l 10 20'), 'm 0 0 l 20 0 l 20 40');
});

const tw = (text: string, start = 0): TlWord[] => text.split(' ').map((w, k) => ({ w, s: start + k * 0.3, e: start + k * 0.3 + 0.25, src: 'v1', i: k, k }));

test('captions: pagination breaks on punctuation, pauses and word limit; skips fillers', () => {
  const words = [...tw('Generative AI is changing how we work.'), ...tw('um So here we go', 5)];
  const pages = paginate(words, { ...defaultCaptions(), maxWords: 3 }, 16);
  assert.ok(pages.every((p) => p.words.length <= 3));
  assert.ok(!pages.some((p) => p.words.some((w) => w.w === 'um')));
  assert.ok(pages.some((p) => p.words[p.words.length - 1]!.w === 'work.'));
  for (let i = 1; i < pages.length; i++) assert.ok(pages[i]!.s >= pages[i - 1]!.e - 1e-9, 'pages do not overlap');
});

test('captions: kinetic emits one event per word with accent highlight; corrections applied', () => {
  const doc = new AssDoc(1080, 1920);
  const c = { ...defaultCaptions(), fix: [['Jenerative', 'Generative']] as [string, string][] };
  const n = compileCaptions(doc, tw('Jenerative AI rocks'), c, 'Inter Black', 10);
  assert.equal(n, 3);
  const s = doc.toString();
  assert.match(s, /GENERATIVE/);
  assert.doesNotMatch(s, /JENERATIVE/);
  assert.match(s, /\\c&H00D4FF&/);
});

test('every preset compiles to valid dialogue lines', () => {
  const props: Record<string, Record<string, unknown>> = {
    title: { text: 'Hello world', sub: 'sub' },
    lower_third: { name: 'Ada', role: 'Engineer' },
    icons: { items: [{ label: 'images' }, { label: 'video' }, { label: 'code' }, { label: 'audio' }] },
    stat: { value: '$5.5M', label: 'raised' },
    badge: { n: 2, text: 'record' },
    bars: { bars: [{ label: 'a', value: 3 }, { label: 'b', value: 7 }], title: 't' },
    progress: {},
    cta: { text: 'Follow', icon: 'user' },
    keyword: { text: 'secret' },
    icon: { icon: 'rocket', label: 'launch' },
    flash: {},
  };
  for (const name of PRESET_NAMES) {
    for (const [w, h] of [
      [1080, 1920],
      [1920, 1080],
    ] as const) {
      const doc = new AssDoc(w, h);
      renderPreset(name, { doc, t0: 1, d: 2.5, props: props[name] ?? {}, accent: '#FFD400', heavy: 'H', bold: 'B', draw: 'D' });
      assert.ok(doc.events.length > 0, name);
      for (const line of doc.toString().split('\n').filter((l) => l.startsWith('Dialogue:'))) {
        assert.match(line, /^Dialogue: \d+,\d:\d\d:\d\d\.\d\d,\d:\d\d:\d\d\.\d\d,[A-Za-z]+,,0,0,0,,\{/, name);
        assert.doesNotMatch(line, /NaN|undefined|Infinity/, name);
      }
    }
  }
  // count-up stat produces stepped numbers ending at the target
  const doc = new AssDoc(1080, 1920);
  renderPreset('stat', { doc, t0: 0, d: 2, props: { value: '90%' }, accent: '#FFD400', heavy: 'H', bold: 'B', draw: 'D' });
  assert.match(doc.toString(), /}90%$/m);
});

test('font index parses installed fonts (skipped if none)', (t) => {
  const idx = fontIndex();
  if (!idx.length) return t.skip('no fonts installed');
  const f = readFontFace(idx[0]!.file);
  assert.ok(f && f.family.length > 0 && f.weight >= 100);
});

test('captions: line breaks are real \\N in every style (no escaped backslash)', () => {
  for (const style of ['kinetic', 'karaoke', 'clean', 'boxed'] as const) {
    const doc = new AssDoc(1080, 1920);
    compileCaptions(doc, tw('Editing everything by hand.'), { ...defaultCaptions(), style, maxWords: 4 }, 'Inter Black', 10);
    const s = doc.toString();
    assert.match(s, /\\N/, style);
    assert.doesNotMatch(s, /\\\\N/, style);
  }
});
