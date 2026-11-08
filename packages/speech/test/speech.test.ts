import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhisperCppJson, parseSubtitles, parseTranscriptJson, makeTranscript } from '../src/transcript.ts';
import { transliterate, transliterateWord } from '../src/hinglish.ts';
import { sentences, roughCut, searchSentences, speechStats } from '../src/analyze.ts';
import type { Word } from '../../core/src/index.ts';

/**
 * Hand-built fixture that follows the documented structure of whisper.cpp `-ojf`
 * output (segments with millisecond `offsets` and per-token entries). It is NOT a
 * captured run; it exercises the token -> word merging logic.
 */
const WCPP = {
  result: { language: 'en' },
  transcription: [
    {
      timestamps: { from: '00:00:00,000', to: '00:00:02,000' },
      offsets: { from: 0, to: 2000 },
      text: ' Generative AI rocks.',
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 }, id: 50364, p: 0.9 },
        { text: ' Gener', offsets: { from: 100, to: 400 }, id: 1, p: 0.8 },
        { text: 'ative', offsets: { from: 400, to: 700 }, id: 2, p: 0.9 },
        { text: ' AI', offsets: { from: 760, to: 1000 }, id: 3, p: 0.95 },
        { text: ' rocks', offsets: { from: 1100, to: 1500 }, id: 4, p: 0.7 },
        { text: '.', offsets: { from: 1500, to: 1520 }, id: 5, p: 0.99 },
        { text: '[_TT_100]', offsets: { from: 2000, to: 2000 }, id: 50464, p: 0.5 },
      ],
    },
    { timestamps: { from: '00:00:02,000', to: '00:00:03,000' }, offsets: { from: 2000, to: 3000 }, text: ' Bye now' },
  ],
};

test('whisper.cpp -ojf: tokens merge into words; special tokens skipped; fallback marks approx', () => {
  const r = parseWhisperCppJson(WCPP);
  assert.equal(r.lang, 'en');
  assert.deepEqual(
    r.words.slice(0, 3).map((w) => [w.w, w.s, w.e]),
    [
      ['Generative', 0.1, 0.7],
      ['AI', 0.76, 1.0],
      ['rocks.', 1.1, 1.52],
    ],
  );
  assert.equal(r.words[3]!.w, 'Bye');
  assert.ok(r.approx, 'segment without tokens -> approximate timing');
});

test('SRT and VTT import produce ordered approximate words', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello world\n\n2\n00:00:02,500 --> 00:00:04,000\n<i>Second</i> line here\n';
  const w = parseSubtitles(srt);
  assert.deepEqual(w.map((x) => x.w), ['Hello', 'world', 'Second', 'line', 'here']);
  assert.ok(w[0]!.s === 1 && w[4]!.e <= 4);
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi there\n';
  assert.deepEqual(parseSubtitles(vtt).map((x) => x.w), ['Hi', 'there']);
});

test('JSON import accepts words[] and segments[] (faster-whisper/openai dumps)', () => {
  const a = parseTranscriptJson(JSON.stringify({ words: [{ word: 'a', start: 0, end: 0.2 }] }));
  assert.equal(a.words[0]!.w, 'a');
  const b = parseTranscriptJson(JSON.stringify({ language: 'hi', segments: [{ start: 0, end: 1, text: 'x', words: [{ word: ' x', start: 0.1, end: 0.5 }] }] }));
  assert.equal(b.lang, 'hi');
  assert.equal(b.words[0]!.s, 0.1);
});

test('makeTranscript enforces monotonic non-overlapping words', () => {
  const t = makeTranscript('x', 'en', [
    { w: 'b', s: 1, e: 2 },
    { w: 'a', s: 0, e: 1.5 },
  ]);
  assert.deepEqual(t.words.map((w) => w.w), ['a', 'b']);
  assert.ok(t.words[0]!.e <= t.words[1]!.s);
});

test('Hinglish: Devanagari -> romanized with schwa deletion', () => {
  const cases: Record<string, string> = { नमस्ते: 'namaste', आज: 'aaj', हम: 'ham', करना: 'karna', बात: 'baat', दोस्तों: 'doston', अच्छा: 'accha', ज़िंदगी: 'zindagi' };
  for (const [dev, lat] of Object.entries(cases)) assert.equal(transliterateWord(dev), lat, dev);
  assert.equal(transliterate('AI बहुत powerful है'), 'AI bahut powerful hai');
});

const W = (text: string, start = 0, step = 0.4): Word[] => text.split(' ').map((w, i) => ({ w, s: start + i * step, e: start + i * step + 0.3 }));

test('sentences, stats, rough cut to target, search', () => {
  const words = [...W('Hook sentence that matters most.'), ...W('Um this is filler talk.', 3), ...W('Generative AI can create images, videos, audio, and code.', 6), ...W('Bye for now.', 12)];
  assert.equal(sentences(words).length, 4);
  const st = speechStats(words);
  assert.equal(st.fillers, 1);
  const rc = roughCut(words, { target: 6.5, maxGap: 0.3, pad: 0.05, dropFillers: true, keepFirst: true });
  assert.ok(rc.kept.includes(0), 'hook kept');
  assert.ok(rc.kept.includes(2), 'dense list sentence kept');
  assert.ok(!rc.kept.includes(1), 'filler sentence dropped');
  assert.ok(rc.est <= 6.5 * 1.1);
  const hits = searchSentences(words, 'artificial intelligence pictures');
  assert.match(hits[0]!.text, /Generative AI/);
});
