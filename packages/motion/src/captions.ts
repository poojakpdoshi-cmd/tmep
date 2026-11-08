/**
 * Caption compiler: timeline words -> animated ASS events.
 * Styles: kinetic (word pop + highlight), karaoke (colour sweep), clean, boxed.
 */
import type { Captions, TlWord } from '../../core/src/index.ts';
import { AssDoc, tagColor, escapeText, ms } from './ass.ts';
import { transliterateWord, hasDevanagari } from '../../speech/src/hinglish.ts';

export interface CaptionPage {
  words: TlWord[];
  s: number;
  e: number;
}

export interface CaptionLayout {
  x: number;
  y: number;
  size: number;
  maxChars: number;
}

export function captionLayout(c: Captions, w: number, h: number): CaptionLayout {
  const portrait = h > w * 1.2;
  const square = !portrait && h > w * 0.9;
  const base = portrait ? w * 0.08 : square ? w * 0.072 : h * 0.065;
  const y = c.pos === 'upper' ? h * (portrait ? 0.24 : 0.16) : c.pos === 'middle' ? h * 0.5 : h * (portrait ? 0.7 : 0.84);
  return { x: w / 2, y, size: Math.round(base * c.size), maxChars: portrait ? 16 : square ? 20 : 34 };
}

const FILLER = /^(um+|uh+|erm|er|ah|hmm+|mm+|uhm)$/i;

export function displayWord(w: string, c: Captions): string {
  let t = w;
  for (const [find, rep] of c.fix) {
    if (t.replace(/[^\p{L}\p{N}']/gu, '').toLowerCase() === find.toLowerCase()) t = t.replace(/[\p{L}\p{N}']+/u, rep);
  }
  if (c.script === 'latin' && hasDevanagari(t)) t = transliterateWord(t);
  t = t.replace(/^[,;:]+|[,;:]+$/g, '');
  return c.upper ? t.toLocaleUpperCase() : t;
}

/** Group words into short caption pages (break on pauses, punctuation, length). */
export function paginate(words: TlWord[], c: Captions, maxChars: number): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let cur: TlWord[] = [];
  let chars = 0;
  const flush = () => {
    if (cur.length) pages.push({ words: cur, s: cur[0]!.s, e: cur[cur.length - 1]!.e });
    cur = [];
    chars = 0;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (FILLER.test(w.w.replace(/[^\w]/g, ''))) continue;
    const len = displayWord(w.w, c).length;
    const prev = cur[cur.length - 1];
    if (cur.length && (cur.length >= c.maxWords || chars + len + 1 > maxChars * 2 || (prev && w.s - prev.e > 0.45) || w.s - cur[0]!.s > 2.6)) flush();
    cur.push(w);
    chars += len + 1;
    if (/[.!?,;:]$/.test(w.w) && cur.length >= Math.min(2, c.maxWords)) flush();
  }
  flush();
  // Extend each page to the next page start (max +0.6s) so captions don't flicker off.
  for (let i = 0; i < pages.length; i++) {
    const next = pages[i + 1];
    const p = pages[i]!;
    p.e = next ? Math.min(next.s, p.e + 0.6) : p.e + 0.5;
  }
  return pages;
}

function lineBreak(tokens: string[], maxChars: number): number | undefined {
  const total = tokens.reduce((a, t) => a + t.length + 1, 0);
  if (total <= maxChars || tokens.length < 2) return undefined;
  let best = 1;
  let bestDiff = Infinity;
  let acc = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    acc += tokens[i]!.length + 1;
    const diff = Math.abs(total / 2 - acc);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i + 1;
    }
  }
  return best;
}

export function compileCaptions(doc: AssDoc, words: TlWord[], c: Captions, font: string, dur: number): number {
  if (c.style === 'none' || !words.length) return 0;
  const L = captionLayout(c, doc.w, doc.h);
  const outline = Math.max(3, Math.round(L.size * 0.075));
  const boxed = c.style === 'boxed';
  doc.style({
    name: 'Cap',
    font,
    bold: true,
    size: L.size,
    color: c.style === 'karaoke' ? c.accent : c.color,
    outline: boxed ? '#111111' : '#000000',
    back: '#000000',
    outlineW: boxed ? Math.round(L.size * 0.22) : outline,
    shadow: boxed ? 0 : Math.round(L.size * 0.04),
    borderStyle: boxed ? 3 : 1,
    align: 5,
    spacing: c.upper ? 1 : 0,
  });
  const pages = paginate(words, c, L.maxChars);
  const accent = tagColor(c.accent);
  const base = tagColor(c.color);
  const pos = `\\an5\\pos(${Math.round(L.x)},${Math.round(L.y)})`;
  let n = 0;
  for (const p of pages) {
    const toks = p.words.map((w) => displayWord(w.w, c));
    const br = lineBreak(toks, L.maxChars);
    const join = (parts: string[]) => parts.map((t, i) => (br !== undefined && i === br ? `\\N${t}` : i === 0 ? t : ` ${t}`)).join('');
    const end = Math.min(p.e, dur);
    if (c.style === 'karaoke') {
      const parts = p.words.map((w, i) => {
        const next = p.words[i + 1];
        const k = Math.max(1, Math.round(((next ? next.s : w.e) - w.s) * 100));
        return `{\\kf${k}}${escapeText(toks[i]!)}`;
      });
      const lead = Math.max(0, Math.round((p.words[0]!.s - p.s) * 100));
      doc.add({ start: p.s, end, style: 'Cap', text: `{${pos}\\fad(60,60)}${lead ? `{\\k${lead}}` : ''}${join(parts)}`, layer: 2 });
      n++;
      continue;
    }
    if (c.style === 'clean' || boxed) {
      doc.add({ start: p.s, end, style: 'Cap', text: `{${pos}\\fad(70,70)}${join(toks.map(escapeText))}`, layer: 2 });
      n++;
      continue;
    }
    // kinetic: one event per active word; active word pops and takes the accent colour
    p.words.forEach((w, i) => {
      const s = i === 0 ? p.s : w.s;
      const e = i === p.words.length - 1 ? end : p.words[i + 1]!.s;
      if (e <= s) return;
      const enter = i === 0 ? '\\fad(70,0)' : '';
      const parts = toks.map((t, j) =>
        j === i ? `{\\c${accent}\\fscx100\\fscy100\\t(0,${ms(0.09)},0.5,\\fscx114\\fscy114)\\t(${ms(0.09)},${ms(0.2)},\\fscx106\\fscy106)}${escapeText(t)}{\\c${base}\\fscx100\\fscy100}` : escapeText(t),
      );
      doc.add({ start: s, end: e, style: 'Cap', text: `{${pos}${enter}}${join(parts)}`, layer: 2 });
      n++;
    });
  }
  return n;
}
