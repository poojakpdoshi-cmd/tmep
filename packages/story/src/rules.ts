/**
 * Visual storytelling rules: map what is being said to graphics, emphasis and sound,
 * deterministically. Each rule emits proposals; a density limiter keeps the frame
 * clean (no overlapping graphics, minimum gaps), so effects are never placed at random.
 */
import type { TlWord } from '../../core/src/index.ts';
import { iconFor } from '../../motion/src/icons.ts';
import { STOPWORDS } from '../../speech/src/analyze.ts';

export interface Proposal {
  kind: 'gfx' | 'zoom' | 'sfx';
  rule: string;
  t: number;
  d: number;
  preset?: string;
  props?: Record<string, unknown>;
  to?: number;
  sfx?: string;
  vol?: number;
  /** larger wins when proposals collide */
  priority: number;
}

const clean = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}%$.']+/gu, '').replace(/\.$/, '');

interface Sent {
  words: TlWord[];
  s: number;
  e: number;
}

export function splitSentences(words: TlWord[]): Sent[] {
  const out: Sent[] = [];
  let cur: TlWord[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (/[.!?]["')\]]*$/.test(w.w) || !next || next.s - w.e > 0.9) {
      out.push({ words: cur, s: cur[0]!.s, e: cur[cur.length - 1]!.e });
      cur = [];
    }
  });
  return out;
}

/** "X can create images, videos, audio, and code" -> items [images, videos, audio, code]. */
export function detectList(sent: Sent): { label: string; t: number }[] | undefined {
  const ws = sent.words;
  const and = ws.findIndex((w, i) => i > 1 && /^(and|or|aur)$/i.test(clean(w.w)) && ws.slice(0, i).some((x) => /,$/.test(x.w)));
  if (and < 0) return undefined;
  // split the words before the conjunction into comma-terminated chunks
  const chunks: TlWord[][] = [[]];
  for (let i = 0; i < and; i++) {
    chunks[chunks.length - 1]!.push(ws[i]!);
    if (/,$/.test(ws[i]!.w) && i < and - 1) chunks.push([]);
  }
  const items: TlWord[][] = [];
  for (let c = chunks.length - 1; c >= 0 && items.length < 5; c--) {
    const ch = chunks[c]!;
    if (!ch.length) continue;
    if (ch.length <= 3) items.unshift(ch);
    else {
      items.unshift(ch.slice(-1)); // lead-in phrase: keep its head noun only
      break;
    }
  }
  const last: TlWord[] = [];
  for (let j = and + 1; j < ws.length && last.length < 2; j++) {
    last.push(ws[j]!);
    if (/[,.!?;:]$/.test(ws[j]!.w)) break;
  }
  if (!last.length) return undefined;
  items.push(last);
  const out = items
    .map((it) => {
      const content = it.filter((w) => !STOPWORDS.has(clean(w.w).replace(/[^a-z]/g, '')));
      const pick = content[content.length - 1] ?? it[it.length - 1]!;
      return { label: pick.w.replace(/[^\p{L}\p{N}'-]+/gu, ''), t: pick.s };
    })
    .filter((x) => x.label.length > 1);
  return out.length >= 3 ? out : undefined;
}

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30, fifty: 50, hundred: 100 };
const SCALE: Record<string, string> = { thousand: 'K', k: 'K', million: 'M', millions: 'M', billion: 'B', billions: 'B', trillion: 'T', lakh: ' lakh', crore: ' crore' };

/** Numbers worth showing: "90 percent", "3x", "10 times", "$5 million", "2 billion". */
export function detectStat(sent: Sent): { value: string; label: string; t: number } | undefined {
  const ws = sent.words;
  for (let i = 0; i < ws.length; i++) {
    const raw = ws[i]!.w;
    let c = clean(raw);
    const money = /^[$₹€£]/.test(c);
    const sym = money ? c[0] : '';
    if (money) c = c.slice(1);
    let num: string | undefined;
    if (/^\d[\d,]*(\.\d+)?(%|x|k|m|b)?$/.test(c)) num = c;
    else if (NUM_WORDS[c] !== undefined && /^(percent|x|times|million|billion|thousand)$/.test(clean(ws[i + 1]?.w ?? ''))) num = String(NUM_WORDS[c]);
    if (!num) continue;
    const nxt = clean(ws[i + 1]?.w ?? '');
    let value = num;
    let used = 1;
    if (nxt === 'percent' || nxt === '%') {
      value = `${num}%`;
      used = 2;
    } else if (nxt === 'times' || nxt === 'x') {
      value = `${num}x`;
      used = 2;
    } else if (SCALE[nxt]) {
      value = `${num}${SCALE[nxt]}`;
      used = 2;
    } else if (/%|x$/.test(num)) value = num;
    else if (!money && Number(num.replace(/,/g, '')) < 10 && !/\d{4}/.test(num)) continue; // small bare numbers are rarely stats
    else if (/^(19|20)\d\d$/.test(num)) continue; // years are not stats
    value = `${sym}${value}`;
    const after = ws.slice(i + used, i + used + 4).filter((w) => !STOPWORDS.has(clean(w.w)));
    const label = after
      .slice(0, 2)
      .map((w) => w.w.replace(/[^\p{L}\p{N}'-]+/gu, ''))
      .join(' ');
    return { value, label, t: ws[i]!.s };
  }
  return undefined;
}

const ORD: Record<string, number> = { first: 1, firstly: 1, second: 2, secondly: 2, third: 3, thirdly: 3, fourth: 4, fifth: 5, finally: 0 };

export function detectStep(sent: Sent): { n: number; t: number } | undefined {
  const a = clean(sent.words[0]?.w ?? '');
  const b = clean(sent.words[1]?.w ?? '');
  if (ORD[a] !== undefined && ORD[a]! > 0) return { n: ORD[a]!, t: sent.words[0]!.s };
  if ((a === 'step' || a === 'number' || a === 'tip') && (NUM_WORDS[b] || /^\d+$/.test(b))) return { n: NUM_WORDS[b] ?? Number(b), t: sent.words[0]!.s };
  return undefined;
}

export function detectCta(sent: Sent): { text: string; icon: string; t: number } | undefined {
  const text = sent.words.map((w) => clean(w.w)).join(' ');
  if (/\bsubscribe\b/.test(text)) return { text: 'Subscribe', icon: 'play', t: sent.s };
  if (/\bfollow\b/.test(text)) return { text: 'Follow for more', icon: 'user', t: sent.s };
  if (/\blink in (the )?bio\b/.test(text)) return { text: 'Link in bio', icon: 'globe', t: sent.s };
  if (/\bcomment\b/.test(text)) return { text: 'Comment below', icon: 'chat', t: sent.s };
  if (/\bsave (this|it)\b/.test(text)) return { text: 'Save this', icon: 'star', t: sent.s };
  return undefined;
}

const EMPHASIS = new Set('never always best worst biggest huge massive insane crazy secret important critical free every only most fastest easiest powerful amazing incredible literally actually exactly game-changer gamechanger million billion'.split(' '));

export function emphasisWords(words: TlWord[]): TlWord[] {
  return words.filter((w) => EMPHASIS.has(clean(w.w)) || /!$/.test(w.w) || (/^[A-Z]{3,}$/.test(w.w.replace(/[^A-Za-z]/g, '')) && w.w.length > 3));
}

export interface RuleOptions {
  lists: boolean;
  stats: boolean;
  steps: boolean;
  cta: boolean;
  keywords: boolean;
  zoomEvery: number;
  sfx: boolean;
  gfxGap: number;
  dur: number;
  topKeywords?: string[];
}

/** Run all rules and resolve collisions. Returns accepted proposals (timeline times). */
export function storyboard(words: TlWord[], o: RuleOptions): { accepted: Proposal[]; rejected: number } {
  const sents = splitSentences(words);
  const props: Proposal[] = [];
  for (const s of sents) {
    const end = Math.min(o.dur, s.e + 0.35);
    if (o.lists) {
      const items = detectList(s);
      if (items) {
        const t0 = items[0]!.t;
        props.push({ kind: 'gfx', rule: 'list', preset: 'icons', t: t0, d: Math.max(1.6, end - t0), priority: 5, props: { items: items.map((x) => ({ label: x.label, icon: iconFor(x.label), at: Math.max(0, x.t - t0) })) } });
        if (o.sfx) items.forEach((x) => props.push({ kind: 'sfx', rule: 'list', sfx: 'pop', t: x.t, d: 0.2, vol: -17, priority: 5 }));
        continue;
      }
    }
    if (o.stats) {
      const st = detectStat(s);
      if (st) {
        props.push({ kind: 'gfx', rule: 'stat', preset: 'stat', t: st.t, d: Math.min(2.6, Math.max(1.6, end - st.t)), priority: 4, props: { value: st.value, ...(st.label ? { label: st.label } : {}) } });
        if (o.sfx) props.push({ kind: 'sfx', rule: 'stat', sfx: 'ding', t: st.t, d: 0.8, vol: -18, priority: 4 });
        continue;
      }
    }
    if (o.steps) {
      const step = detectStep(s);
      if (step && step.n > 0) {
        const text = s.words
          .slice(1, 4)
          .filter((w) => !STOPWORDS.has(clean(w.w)))
          .map((w) => w.w.replace(/[^\p{L}\p{N}'-]+/gu, ''))
          .join(' ');
        props.push({ kind: 'gfx', rule: 'step', preset: 'badge', t: step.t, d: Math.min(2.2, end - step.t), priority: 3, props: { n: step.n, ...(text ? { text } : {}) } });
        if (o.sfx) props.push({ kind: 'sfx', rule: 'step', sfx: 'click', t: step.t, d: 0.1, vol: -14, priority: 3 });
        continue;
      }
    }
    if (o.cta) {
      const cta = detectCta(s);
      if (cta) {
        props.push({ kind: 'gfx', rule: 'cta', preset: 'cta', t: cta.t, d: Math.max(1.8, Math.min(3, o.dur - cta.t)), priority: 3, props: { text: cta.text, icon: cta.icon } });
        if (o.sfx) props.push({ kind: 'sfx', rule: 'cta', sfx: 'pop', t: cta.t, d: 0.2, vol: -16, priority: 3 });
        continue;
      }
    }
    if (o.keywords && o.topKeywords?.length) {
      const hit = s.words.find((w) => o.topKeywords!.includes(clean(w.w)));
      if (hit) props.push({ kind: 'gfx', rule: 'keyword', preset: 'keyword', t: hit.s, d: 1.4, priority: 1, props: { text: hit.w.replace(/[^\p{L}\p{N}'-]+/gu, '') } });
    }
  }
  if (o.zoomEvery > 0) {
    for (const w of emphasisWords(words)) props.push({ kind: 'zoom', rule: 'emphasis', t: w.s, d: Math.max(0.5, w.e - w.s + 0.5), to: 1.16, priority: 2 });
  }
  // density limiter
  const accepted: Proposal[] = [];
  let rejected = 0;
  const gfxBusy: [number, number][] = [];
  const usedKeywords = new Set<string>();
  let lastZoom = -Infinity;
  for (const p of [...props].sort((a, b) => b.priority - a.priority || a.t - b.t)) {
    if (p.kind === 'gfx') {
      if (p.rule === 'keyword') {
        const k = String(p.props?.text).toLowerCase();
        if (usedKeywords.has(k)) {
          rejected++;
          continue;
        }
        usedKeywords.add(k);
      }
      const clashAt = (t: number, d: number) => gfxBusy.some(([a, b]) => t < b + o.gfxGap && t + d > a - o.gfxGap);
      if (clashAt(p.t, p.d)) {
        // slide later (up to 1s) into free space, keeping the original end time
        const end = p.t + p.d;
        const free = gfxBusy.map(([, b]) => b + o.gfxGap).filter((t) => t > p.t && t <= p.t + 1.0 && end - t >= 1.2 && !clashAt(t, end - t)).sort((x, y) => x - y)[0];
        if (free === undefined) {
          rejected++;
          continue;
        }
        p.d = end - free;
        p.t = free;
      }
      if (p.t + 0.5 > o.dur) {
        rejected++;
        continue;
      }
      gfxBusy.push([p.t, p.t + p.d]);
      accepted.push(p);
    }
  }
  // sfx only for accepted graphics (same rule & time window)
  for (const p of props.filter((x) => x.kind === 'sfx')) {
    const g = accepted.find((x) => x.kind === 'gfx' && x.rule === p.rule && p.t >= x.t - 1.05 && p.t <= x.t + x.d);
    if (g) accepted.push({ ...p, t: Math.max(p.t, g.t) }); // follow a graphic that slid later
  }
  for (const p of props.filter((x) => x.kind === 'zoom').sort((a, b) => a.t - b.t)) {
    if (p.t - lastZoom < o.zoomEvery || gfxBusy.some(([a, b]) => p.t >= a && p.t <= b)) {
      rejected++;
      continue;
    }
    lastZoom = p.t;
    accepted.push(p);
  }
  return { accepted: accepted.sort((a, b) => a.t - b.t), rejected };
}
