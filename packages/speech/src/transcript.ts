/**
 * Normalized transcript format + parsers for engine outputs and imported subtitles.
 * All engines are reduced to: words [{w, s, e, p?}] in source seconds.
 */
import type { Word } from '../../core/src/index.ts';
import { TmepError, r2 } from '../../core/src/index.ts';

export interface Transcript {
  v: 1;
  engine: string;
  model?: string;
  lang: string;
  /** true when word times were interpolated rather than measured. */
  approx: boolean;
  words: Word[];
  createdAt: string;
}

export function makeTranscript(engine: string, lang: string, words: Word[], extra: { model?: string; approx?: boolean } = {}): Transcript {
  if (words.some(w => !Number.isFinite(w.s) || !Number.isFinite(w.e) || w.s < 0 || w.e <= w.s))
    throw new TmepError('E_INPUT', 'transcript contains invalid word timestamps');
  const clean = words
    .map((w) => ({ ...w, w: w.w.trim(), s: r2(w.s, 3), e: r2(Math.max(w.e, w.s + 0.01), 3) }))
    .filter((w) => w.w.length > 0)
    .sort((a, b) => a.s - b.s);
  // Enforce monotonic, non-overlapping word times (engines occasionally overlap).
  for (let i = 1; i < clean.length; i++) {
    const prev = clean[i - 1]!;
    if (clean[i]!.s <= prev.s) throw new TmepError('E_INPUT', 'transcript contains simultaneous word starts; realignment required');
    if (clean[i]!.s < prev.e) prev.e = clean[i]!.s;
  }
  return { v: 1, engine, model: extra.model, lang, approx: extra.approx ?? false, words: clean, createdAt: new Date().toISOString() };
}

// ---------- whisper.cpp (-ojf / --output-json-full) ----------
interface WcppToken {
  text: string;
  offsets?: { from: number; to: number };
  p?: number;
}
interface WcppSegment {
  offsets: { from: number; to: number };
  text: string;
  tokens?: WcppToken[];
}
interface WcppJson {
  result?: { language?: string };
  transcription?: WcppSegment[];
}

/**
 * whisper.cpp full JSON: tokens carry millisecond offsets. Tokens whose text starts with
 * a space begin a new word; other tokens are sub-word continuations. Special tokens like
 * "[_BEG_]" / "[_TT_123]" are skipped. Falls back to proportional timing per segment when
 * tokens are absent (marks transcript approx).
 */
export function parseWhisperCppJson(json: string | WcppJson): { lang: string; words: Word[]; approx: boolean } {
  const j: WcppJson = typeof json === 'string' ? JSON.parse(json) : json;
  if (!Array.isArray(j.transcription)) throw new TmepError('E_ENGINE_FAILED', 'whisper.cpp JSON has no transcription array');
  const words: Word[] = [];
  let approx = false;
  for (const seg of j.transcription) {
    const toks = (seg.tokens ?? []).filter((t) => !/^\s*\[_[A-Z]+_?\d*\]\s*$/.test(t.text) && !/^\s*\[_/.test(t.text) && t.offsets);
    if (toks.length) {
      let cur: Word | undefined;
      const probs: number[] = [];
      const flush = () => {
        if (cur && cur.w.trim()) {
          if (probs.length) cur.p = r2(probs.reduce((a, b) => a + b, 0) / probs.length, 3);
          words.push(cur);
        }
        probs.length = 0;
      };
      for (const t of toks) {
        const s = t.offsets!.from / 1000;
        const e = t.offsets!.to / 1000;
        const startsWord = /^\s/.test(t.text) || !cur;
        const isPunct = /^[.,!?;:%)"'\]]+$/.test(t.text.trim());
        if (startsWord && !isPunct) {
          flush();
          cur = { w: t.text.trim(), s, e };
        } else if (cur) {
          cur.w += t.text.trim();
          cur.e = Math.max(cur.e, e);
        }
        if (typeof t.p === 'number') probs.push(t.p);
      }
      flush();
    } else if (seg.text.trim()) {
      approx = true;
      words.push(...spreadWords(seg.text, seg.offsets.from / 1000, seg.offsets.to / 1000));
    }
  }
  return { lang: j.result?.language ?? 'und', words, approx };
}

/** Proportional word timing by character length (used only when no word times exist). */
export function spreadWords(text: string, s: number, e: number): Word[] {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  const total = toks.reduce((a, t) => a + t.length + 1, 0);
  const out: Word[] = [];
  let cur = s;
  for (const t of toks) {
    const d = ((e - s) * (t.length + 1)) / total;
    out.push({ w: t, s: cur, e: cur + d * 0.92 });
    cur += d;
  }
  return out;
}

// ---------- faster-whisper helper output ----------
export function parseFasterWhisperJson(json: string): { lang: string; words: Word[] } {
  const j = JSON.parse(json) as { language?: string; words?: { w: string; s: number; e: number; p?: number }[] };
  if (!Array.isArray(j.words)) throw new TmepError('E_ENGINE_FAILED', 'faster-whisper helper returned no words');
  return { lang: j.language ?? 'und', words: j.words.map((w) => ({ w: w.w, s: w.s, e: w.e, p: w.p })) };
}

// ---------- subtitle / JSON import ----------
const tc = (s: string): number => {
  const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(s.trim());
  if (!m) throw new TmepError('E_INPUT', `bad timecode "${s}"`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
};

/** SRT / WebVTT -> words (approximate word timing inside each cue). */
export function parseSubtitles(text: string): Word[] {
  const words: Word[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() && l.trim() !== 'WEBVTT');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti]!.split('-->');
    const body = lines
      .slice(ti + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (body) words.push(...spreadWords(body, tc(a!), tc(z!.split(/\s+/).filter(Boolean)[0]!)));
  }
  return words;
}

/**
 * Generic JSON import. Accepts:
 *  - {words:[{w|word|text, s|start, e|end}]}            (TMEP / WhisperX-like)
 *  - {segments:[{start,end,text,words?:[{word,start,end}]}]}  (openai-whisper / faster-whisper dumps)
 *  - whisper.cpp -ojf output
 */
export function parseTranscriptJson(text: string): { words: Word[]; lang?: string; approx: boolean } {
  const j = JSON.parse(text) as Record<string, unknown>;
  if (Array.isArray(j.transcription)) {
    const r = parseWhisperCppJson(j as WcppJson);
    return { words: r.words, lang: r.lang, approx: r.approx };
  }
  const pick = (o: Record<string, unknown>): Word => ({
    w: String(o.w ?? o.word ?? o.text ?? ''),
    s: Number(o.s ?? o.start),
    e: Number(o.e ?? o.end),
  });
  if (Array.isArray(j.words)) return { words: (j.words as Record<string, unknown>[]).map(pick), lang: (j.language ?? j.lang) as string | undefined, approx: j.approx === true };
  if (Array.isArray(j.segments)) {
    const words: Word[] = [];
    let approx = false;
    for (const seg of j.segments as Record<string, unknown>[]) {
      if (Array.isArray(seg.words) && seg.words.length) words.push(...(seg.words as Record<string, unknown>[]).map(pick));
      else {
        approx = true;
        words.push(...spreadWords(String(seg.text ?? ''), Number(seg.start), Number(seg.end)));
      }
    }
    return { words, lang: j.language as string | undefined, approx };
  }
  throw new TmepError('E_INPUT', 'unrecognized transcript JSON', 'expected {words:[...]}, {segments:[...]} or whisper.cpp -ojf output');
}

export function transcriptText(words: Word[]): string {
  return words.map((w) => w.w).join(' ');
}
