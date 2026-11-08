/**
 * Deterministic transcript analysis: sentences, pauses, fillers, keyword scoring,
 * rough-cut selection and lexical search. No LLM involved.
 */
import type { Word } from '../../core/src/index.ts';
import { isFiller, r2 } from '../../core/src/index.ts';

export interface Sentence {
  i: number;
  /** word index range [w0, w1] inclusive, in source transcript */
  w0: number;
  w1: number;
  s: number;
  e: number;
  text: string;
}

export const STOPWORDS = new Set(
  'a an the and or but if then so of to in on at by for with from as is are was were be been being it its this that these those i you he she we they me my your our their his her them us do does did have has had not no yes can could will would should just very really also about into over than too there here what which who whom when where why how all any some more most such only own same other each few both up down out off again further once because while during before after above below between through until against am im youre dont its thats theres ive id ill weve were theyre isnt arent wasnt werent cant couldnt wont wouldnt shouldnt get got gonna wanna like'.split(
    ' ',
  ),
);

const clean = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '').replace(/'/g, '');

/** Split into sentences at terminal punctuation or long pauses. */
export function sentences(words: Word[], pause = 0.75): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    const terminal = /[.!?]["')\]]*$/.test(w.w) || /[।]$/.test(w.w);
    const gap = next ? next.s - w.e : Infinity;
    if (terminal || gap >= pause || i - start >= 40) {
      const ws = words.slice(start, i + 1);
      out.push({ i: out.length, w0: start, w1: i, s: words[start]!.s, e: w.e, text: ws.map((x) => x.w).join(' ') });
      start = i + 1;
    }
  }
  return out;
}

export interface SpeechStats {
  words: number;
  speech: number;
  pauses: number;
  fillers: number;
  wpm: number;
}

export function speechStats(words: Word[], pauseMin = 0.5): SpeechStats {
  if (!words.length) return { words: 0, speech: 0, pauses: 0, fillers: 0, wpm: 0 };
  let speech = 0;
  let pauses = 0;
  for (let i = 0; i < words.length; i++) {
    speech += words[i]!.e - words[i]!.s;
    if (i > 0 && words[i]!.s - words[i - 1]!.e >= pauseMin) pauses++;
  }
  const span = words[words.length - 1]!.e - words[0]!.s;
  return { words: words.length, speech: r2(speech), pauses, fillers: words.filter((w) => isFiller(w.w)).length, wpm: Math.round((words.length / Math.max(span, 1)) * 60) };
}

/** Term frequencies across the transcript (content words only). */
export function keywords(words: Word[], top = 12): { k: string; n: number }[] {
  const tf = new Map<string, number>();
  for (const w of words) {
    const c = clean(w.w);
    if (c.length < 3 || STOPWORDS.has(c) || /^\d+$/.test(c)) continue;
    tf.set(c, (tf.get(c) ?? 0) + 1);
  }
  return [...tf.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([k, n]) => ({ k, n }));
}

/** Score a sentence for inclusion in a short edit (information density heuristics). */
export function scoreSentence(s: Sentence, words: Word[], kw: Set<string>): number {
  const ws = words.slice(s.w0, s.w1 + 1);
  const content = ws.filter((w) => {
    const c = clean(w.w);
    return c.length > 2 && !STOPWORDS.has(c);
  });
  const fill = ws.filter((w) => isFiller(w.w)).length;
  const kwHits = ws.filter((w) => kw.has(clean(w.w))).length;
  const hasNumber = ws.some((w) => /\d/.test(w.w));
  const hasList = (s.text.match(/,/g)?.length ?? 0) >= 2;
  const density = content.length / Math.max(1, ws.length);
  const dur = s.e - s.s;
  let score = density * 2 + kwHits * 0.5 + (hasNumber ? 0.6 : 0) + (hasList ? 0.8 : 0) - fill * 0.4;
  if (dur < 1.2) score -= 0.8; // fragments
  if (dur > 9) score -= 0.5; // rambles are hard to fit
  return r2(score, 3);
}

export interface RoughCutOptions {
  /** target total duration in seconds (0 = keep everything) */
  target: number;
  maxGap: number;
  pad: number;
  dropFillers: boolean;
  keepFirst: boolean;
  /** keep the final sentence (e.g. a call to action) */
  keepLast?: boolean;
}

/**
 * Rough cut: choose sentences (always keeping the hook = first sentence) by score until
 * the target duration is reached, then cut fillers and tighten pauses inside them.
 * Returns source ranges in chronological order.
 */
export function roughCut(words: Word[], o: RoughCutOptions): { ranges: [number, number][]; kept: number[]; est: number } {
  const sents = sentences(words);
  if (!sents.length) return { ranges: [], kept: [], est: 0 };
  const kw = new Set(keywords(words, 15).map((x) => x.k));
  const estDur = (s: Sentence) => {
    let d = 0;
    for (let i = s.w0; i <= s.w1; i++) {
      const w = words[i]!;
      if (o.dropFillers && isFiller(w.w)) continue;
      d += w.e - w.s;
      const nx = words[i + 1];
      if (nx && i < s.w1) d += Math.min(nx.s - w.e, o.maxGap);
    }
    return d + 2 * o.pad;
  };
  let chosen: Sentence[];
  if (!o.target) chosen = sents;
  else {
    const scored = sents.map((s) => ({ s, sc: scoreSentence(s, words, kw), d: estDur(s) }));
    chosen = [];
    let total = 0;
    if (o.keepFirst) {
      chosen.push(sents[0]!);
      total += scored[0]!.d;
    }
    if (o.keepLast && sents.length > 1) {
      chosen.push(sents[sents.length - 1]!);
      total += scored[scored.length - 1]!.d;
    }
    const rest = scored.filter((x) => !chosen.includes(x.s)).sort((a, b) => b.sc - a.sc || a.s.s - b.s.s);
    for (const x of rest) {
      if (total + x.d <= o.target * 1.04) {
        chosen.push(x.s);
        total += x.d;
      }
    }
    chosen.sort((a, b) => a.s - b.s);
  }
  const ranges: [number, number][] = [];
  for (const s of chosen) {
    let runStart: number | undefined;
    let runEnd = 0;
    for (let i = s.w0; i <= s.w1; i++) {
      const w = words[i]!;
      if (o.dropFillers && isFiller(w.w)) {
        if (runStart !== undefined) ranges.push([runStart, runEnd]);
        runStart = undefined;
        continue;
      }
      if (runStart === undefined) runStart = Math.max(0, w.s - o.pad);
      else if (w.s - runEnd > o.maxGap + o.pad) {
        ranges.push([runStart, runEnd]);
        runStart = Math.max(0, w.s - o.pad);
      }
      runEnd = w.e + o.pad;
    }
    if (runStart !== undefined) ranges.push([runStart, runEnd]);
  }
  // merge overlapping / touching ranges
  const merged: [number, number][] = [];
  for (const r of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 0.02) last[1] = Math.max(last[1], r[1]);
    else merged.push([r2(r[0], 3), r2(r[1], 3)]);
  }
  const est = merged.reduce((a, [s, e]) => a + e - s, 0);
  return { ranges: merged.map(([s, e]) => [r2(s, 3), r2(e, 3)]), kept: chosen.map((s) => s.i), est: r2(est) };
}

// ---------- lexical search (BM25 + light stemming + concept expansion) ----------
const CONCEPTS: string[][] = [
  ['ai', 'artificial', 'intelligence', 'ml', 'model', 'models', 'llm', 'gpt', 'neural'],
  ['video', 'videos', 'footage', 'clip', 'clips', 'film', 'movie'],
  ['image', 'images', 'picture', 'pictures', 'photo', 'photos'],
  ['audio', 'sound', 'voice', 'music', 'podcast'],
  ['code', 'coding', 'program', 'programming', 'software', 'developer'],
  ['money', 'price', 'cost', 'revenue', 'dollars', 'pay', 'cheap', 'expensive'],
  ['fast', 'faster', 'speed', 'quick', 'quickly', 'instant'],
  ['start', 'begin', 'intro', 'introduction', 'hello', 'welcome'],
  ['end', 'outro', 'conclusion', 'subscribe', 'follow', 'bye'],
];

export const stem = (w: string): string => {
  let s = clean(w);
  for (const suf of ['ingly', 'edly', 'ing', 'ers', 'ies', 'ied', 'ed', 'es', 'ly', 's']) {
    if (s.length > suf.length + 2 && s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s;
};

export interface SearchHit {
  sentence: number;
  s: number;
  e: number;
  score: number;
  text: string;
}

export function searchSentences(words: Word[], query: string, limit = 5): SearchHit[] {
  const sents = sentences(words);
  const docs = sents.map((s) => words.slice(s.w0, s.w1 + 1).map((w) => stem(w.w)).filter(Boolean));
  const N = docs.length || 1;
  const avg = docs.reduce((a, d) => a + d.length, 0) / N;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const qTerms = new Map<string, number>();
  for (const raw of query.split(/\s+/)) {
    const st = stem(raw);
    if (!st || STOPWORDS.has(st)) continue;
    qTerms.set(st, 1);
    for (const group of CONCEPTS) if (group.includes(clean(raw))) for (const g of group) if (!qTerms.has(stem(g))) qTerms.set(stem(g), 0.4);
  }
  const k1 = 1.4;
  const b = 0.75;
  const hits: SearchHit[] = [];
  docs.forEach((d, i) => {
    let score = 0;
    for (const [t, wt] of qTerms) {
      const f = d.filter((x) => x === t).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += wt * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    if (score > 0) hits.push({ sentence: i, s: sents[i]!.s, e: sents[i]!.e, score: r2(score, 3), text: sents[i]!.text });
  });
  return hits.sort((x, y) => y.score - x.score).slice(0, limit);
}
