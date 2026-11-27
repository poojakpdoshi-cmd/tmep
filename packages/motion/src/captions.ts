/**
 * Caption compiler: timeline words -> animated ASS events.
 * Uses measured glyph widths, phrase-aware line breaking, safe-zone clamping,
 * and zero-reflow active-word highlighting.
 */
import type { Captions, TlWord } from '../../core/src/index.ts';
import { AssDoc, tagColor, escapeText, ms } from './ass.ts';
import { canvasModule } from './vector.ts';
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
  maxWidthPx: number;
}

export interface CaptionLayoutOptions {
  safeTop?: number;
  safeBottom?: number;
  reservePresenter?: { x: number; y: number; w: number; h: number };
}

export function captionLayout(c: Captions, w: number, h: number, opts: CaptionLayoutOptions = {}): CaptionLayout {
  const portrait = h > w * 1.2;
  const square = !portrait && h > w * 0.9;
  const base = portrait ? w * 0.076 : square ? w * 0.068 : h * 0.062;
  const size = Math.round(base * c.size);
  const halfH = size * 1.35;
  const safeTop = (opts.safeTop ?? (portrait ? 0.08 : 0.06)) * h;
  const safeBottom = (opts.safeBottom ?? (portrait ? 0.21 : 0.10)) * h;

  let y = c.pos === 'upper'
    ? h * (portrait ? 0.22 : 0.16)
    : c.pos === 'middle'
      ? h * 0.5
      : h * (portrait ? 0.70 : 0.84);

  // Clamp within platform safe zones
  y = Math.max(safeTop + halfH, Math.min(h - safeBottom - halfH, y));

  // Avoid reserved presenter region if provided
  if (opts.reservePresenter) {
    const rp = opts.reservePresenter;
    const rpTop = (rp.y - rp.h / 2) * h;
    const rpBot = (rp.y + rp.h / 2) * h;
    if (y + halfH > rpTop && y - halfH < rpBot) {
      const above = rpTop - halfH - 12;
      const below = rpBot + halfH + 12;
      if (above >= safeTop + halfH) y = above;
      else if (below <= h - safeBottom - halfH) y = below;
    }
  }

  return {
    x: w / 2,
    y,
    size,
    maxChars: portrait ? 16 : square ? 20 : 34,
    maxWidthPx: Math.round(w * (portrait ? 0.72 : 0.68)),
  };
}

export function makeWidthMeasurer(font: string, size: number): (text: string) => number {
  try {
    const { createCanvas } = canvasModule();
    const ctx = createCanvas(1, 1).getContext('2d');
    ctx.font = `700 ${size}px "${font}"`;
    return (text: string) => ctx.measureText(text).width;
  } catch {
    return (text: string) => text.length * size * 0.56;
  }
}

const FILLER = /^(um+|uh+|erm|er|ah|hmm+|mm+|uhm)$/i;
const SHORT_FUNC = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'at', 'by', 'with']);

export function displayWord(w: string, c: Captions): string {
  let t = w;
  for (const [find, rep] of c.fix) {
    if (t.replace(/[^\p{L}\p{N}']/gu, '').toLowerCase() === find.toLowerCase()) t = t.replace(/[\p{L}\p{N}']+/u, rep);
  }
  if (c.script === 'latin' && hasDevanagari(t)) t = transliterateWord(t);
  t = t.replace(/^[,;:]+|[,;:]+$/g, '');
  return c.upper ? t.toLocaleUpperCase() : t;
}

/** Group words into short caption pages (break on pauses, punctuation, measured width). */
export function paginate(
  words: TlWord[],
  c: Captions,
  maxChars: number,
  measure?: (text: string) => number,
  maxWidthPx?: number,
): CaptionPage[] {
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
    const disp = displayWord(w.w, c);
    const len = disp.length;
    const prev = cur[cur.length - 1];
    const nextToks = [...cur.map((x) => displayWord(x.w, c)), disp];
    const tooWide = measure && maxWidthPx
      ? measure(nextToks.join(' ')) > maxWidthPx * 1.9
      : chars + len + 1 > maxChars * 2;
    if (cur.length && (cur.length >= c.maxWords || tooWide || (prev && w.s - prev.e > 0.45) || w.s - cur[0]!.s > 2.6)) flush();
    cur.push(w);
    chars += len + 1;
    if (/[.!?,;:।]$/.test(w.w) && cur.length >= Math.min(2, c.maxWords)) flush();
  }
  flush();
  for (let i = 0; i < pages.length; i++) {
    const next = pages[i + 1];
    const p = pages[i]!;
    p.e = next ? Math.min(next.s, p.e + 0.6) : p.e + 0.5;
  }
  return pages;
}

function lineBreak(tokens: string[], rawWords: string[], maxWidthPx: number, measure: (t: string) => number): number | undefined {
  if (tokens.length < 2) return undefined;
  const full = tokens.join(' ');
  if (measure(full) <= maxWidthPx) return undefined;

  let best = 1;
  let bestScore = Infinity;
  for (let i = 0; i < tokens.length - 1; i++) {
    const left = tokens.slice(0, i + 1).join(' ');
    const right = tokens.slice(i + 1).join(' ');
    const w1 = measure(left);
    const w2 = measure(right);
    let penalty = Math.abs(w1 - w2);
    if (w1 > maxWidthPx) penalty += (w1 - maxWidthPx) * 3;
    if (w2 > maxWidthPx) penalty += (w2 - maxWidthPx) * 3;
    // Prefer breaking after punctuation, discourage stranding short function words at line end
    if (/[,;:।]$/.test(rawWords[i] ?? '')) penalty -= maxWidthPx * 0.25;
    if (SHORT_FUNC.has((tokens[i] ?? '').toLowerCase())) penalty += maxWidthPx * 0.18;
    if (penalty < bestScore) {
      bestScore = penalty;
      best = i + 1;
    }
  }
  return best;
}

export function compileCaptions(
  doc: AssDoc,
  words: TlWord[],
  c: Captions,
  font: string,
  dur: number,
  opts: CaptionLayoutOptions = {},
): number {
  if (c.style === 'none' || !words.length) return 0;
  const L = captionLayout(c, doc.w, doc.h, opts);
  const measure = makeWidthMeasurer(font, L.size);
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
  const pages = paginate(words, c, L.maxChars, measure, L.maxWidthPx);
  const accent = tagColor(c.accent);
  const base = tagColor(c.color);
  const pos = `\\an5\\pos(${Math.round(L.x)},${Math.round(L.y)})`;
  let n = 0;
  for (const p of pages) {
    const toks = p.words.map((w) => displayWord(w.w, c));
    const br = lineBreak(toks, p.words.map((w) => w.w), L.maxWidthPx, measure);
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
    // kinetic: zero-reflow active-word emphasis (no inline font scaling that shifts neighboring words)
    p.words.forEach((w, i) => {
      const s = i === 0 ? p.s : w.s;
      const e = i === p.words.length - 1 ? end : p.words[i + 1]!.s;
      if (e <= s) return;
      const fadeIn = i === 0 ? 70 : 0;
      const fadeOut = i === p.words.length - 1 ? 70 : 0;
      const enter = fadeIn || fadeOut ? `\\fad(${fadeIn},${fadeOut})` : '';
      const parts = toks.map((t, j) =>
        j === i
          ? `{\\c${accent}\\bord${outline + 2}\\t(0,${ms(0.12)},\\bord${outline})}${escapeText(t)}{\\c${base}\\bord${outline}}`
          : escapeText(t),
      );
      doc.add({ start: s, end: e, style: 'Cap', text: `{${pos}${enter}}${join(parts)}`, layer: 2 });
      n++;
    });
  }
  return n;
}
