/**
 * Devanagari -> romanized "Hinglish" transliteration for captions.
 *
 * Whisper often emits Hindi in Devanagari even when creators want Latin-script
 * captions. This rule-based transliterator converts Devanagari words to common
 * informal Hinglish spellings with schwa deletion. It is deterministic and
 * intentionally simple; it is NOT a speech recognizer and does not change timing.
 * English words in Latin script pass through unchanged.
 */

const V: Record<string, string> = { अ: 'a', आ: 'aa', इ: 'i', ई: 'ee', उ: 'u', ऊ: 'oo', ऋ: 'ri', ए: 'e', ऐ: 'ai', ओ: 'o', औ: 'au', ऑ: 'o', ऍ: 'e' };
const M: Record<string, string> = { 'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e' };
const C: Record<string, string> = {
  क: 'k', ख: 'kh', ग: 'g', घ: 'gh', ङ: 'n', च: 'ch', छ: 'chh', ज: 'j', झ: 'jh', ञ: 'n',
  ट: 't', ठ: 'th', ड: 'd', ढ: 'dh', ण: 'n', त: 't', थ: 'th', द: 'd', ध: 'dh', न: 'n',
  प: 'p', फ: 'ph', ब: 'b', भ: 'bh', म: 'm', य: 'y', र: 'r', ल: 'l', व: 'v', श: 'sh', ष: 'sh', स: 's', ह: 'h',
  क़: 'q', ख़: 'kh', ग़: 'gh', ज़: 'z', ड़: 'r', ढ़: 'rh', फ़: 'f', य़: 'y',
};
const NUKTA_BASE: Record<string, string> = { क: 'क़', ख: 'ख़', ग: 'ग़', ज: 'ज़', ड: 'ड़', ढ: 'ढ़', फ: 'फ़', य: 'य़' };
const VIRAMA = '्';
const NUKTA = '़';
const DIGITS = '०१२३४५६७८९';

interface Syl {
  c?: string; // consonant (romanized)
  v: string; // vowel (romanized), 'a' = inherent schwa
  inherent: boolean;
  suffix: string; // anusvara/visarga etc.
}

export const hasDevanagari = (s: string): boolean => /[ऀ-ॿ]/.test(s);

export function transliterateWord(word: string): string {
  if (!hasDevanagari(word)) return word;
  const chars = [...word.normalize('NFC')];
  const syls: Syl[] = [];
  let lead = '';
  let trail = '';
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i]!;
    if (chars[i + 1] === NUKTA && NUKTA_BASE[ch]) {
      ch = NUKTA_BASE[ch]!;
      i++;
    }
    const di = DIGITS.indexOf(ch);
    if (di >= 0) {
      syls.push({ v: String(di), inherent: false, suffix: '' });
      continue;
    }
    if (C[ch] !== undefined) {
      const next = chars[i + 1];
      if (next === VIRAMA) {
        syls.push({ c: C[ch], v: '', inherent: false, suffix: '' });
        i++;
      } else if (next && M[next] !== undefined) {
        syls.push({ c: C[ch], v: M[next]!, inherent: false, suffix: '' });
        i++;
      } else syls.push({ c: C[ch], v: 'a', inherent: true, suffix: '' });
    } else if (V[ch] !== undefined) syls.push({ v: V[ch]!, inherent: false, suffix: '' });
    else if (ch === 'ं' || ch === 'ँ') {
      const last = syls[syls.length - 1];
      if (last) last.suffix += 'n';
    } else if (ch === 'ः') {
      const last = syls[syls.length - 1];
      if (last) last.suffix += 'h';
    } else if (/[ऀ-ॿ]/.test(ch)) {
      /* other signs (danda etc.) dropped */
    } else if (!syls.length) lead += ch;
    else trail += ch;
  }
  // schwa deletion: final, then medial (V C a C V -> V C C V), scanning right to left
  const n = syls.length;
  if (n > 1 && syls[n - 1]!.inherent && !syls[n - 1]!.suffix) syls[n - 1]!.v = '';
  for (let i = n - 2; i >= 1; i--) {
    const s = syls[i]!;
    const prev = syls[i - 1]!;
    const next = syls[i + 1]!;
    // never delete after a closed syllable (would create a CCC cluster: zindagi, not zindgi)
    if (s.inherent && !s.suffix && prev.v !== '' && !prev.suffix && next.c && next.v !== '') s.v = '';
  }
  let out = syls
    .map((s, i) => {
      let v = s.v;
      if (i === n - 1 && v === 'aa') v = 'a';
      if (i === n - 1 && v === 'ee') v = 'i';
      let suffix = s.suffix;
      const nx = syls[i + 1];
      if (suffix === 'n' && nx?.c && /^[pbm]/.test(nx.c)) suffix = 'm';
      return (s.c ?? '') + v + suffix;
    })
    .join('');
  out = out.replace(/chchh/g, 'cch').replace(/^aa(?=[^aeiou])/, 'aa');
  return lead + out + trail;
}

export function transliterate(text: string): string {
  return text
    .split(/(\s+)/)
    .map((t) => (/\s/.test(t) ? t : transliterateWord(t)))
    .join('');
}
