import { num, obj, str, TmepError, type Infer } from '../../core/src/index.ts';
import { compileStoryboard, storyboardSchema, STORYBOARD_FPS } from './storyboard.ts';

const optionsSchema = obj({
  wpm: num({ min: 60, max: 240 }).default(150),
  narration: str({ pattern: /^a[1-9]\d*$/ }).optional(),
});

type Storyboard = Infer<typeof storyboardSchema>;
type Scene = Storyboard['scenes'][number];
const sentenceSplitter = new Intl.Segmenter('en', { granularity: 'sentence' });
const wordSplitter = new Intl.Segmenter('en', { granularity: 'word' });
const sequence = /^(first(?:ly)?|second(?:ly)?|third(?:ly)?|next|then|finally|lastly)\b[,:.)-]?\s+/iu;
const inlineSequence = /[,;]\s+(?=(?:second(?:ly)?|third(?:ly)?|next|then|finally|lastly)\b)/iu;
const vague = /^(?:a|an|and|but|do|does|go|he|her|here|him|i|is|it|me|my|no|now|or|our|she|so|that|the|them|then|there|these|they|thing|things|this|those|to|us|very|was|we|what|who|why|will|with|yes|you|your)$/iu;

function words(text: string): string[] {
  return [...wordSplitter.segment(text)].filter(({ isWordLike }) => isWordLike).map(({ segment }) => segment);
}

// Words that open a clause or modifier, so a label may end just before them.
const boundary = /^(?:after|at|because|before|by|during|each|every|for|from|in|into|on|per|since|so|than|through|to|until|when|where|which|while|whereas|with|without)$/iu;
// Words a label must not end on.
const weakEnd = /^(?:a|an|and|as|at|by|for|from|her|his|in|into|its|my|of|on|or|our|that|the|their|this|to|with|your)$/iu;
const sentenceCase = (text: string) => text.charAt(0).toLocaleUpperCase('en') + text.slice(1);
const trimWeak = (tokens: string[]) => {
  const out = [...tokens];
  while (out.length > 1 && weakEnd.test(out.at(-1)!)) out.pop();
  return out.join(' ').replace(/[,;:]+$/u, '');
};

/**
 * Fit a script excerpt into a display label. In order of preference: the whole phrase,
 * the phrase without articles, the longest leading clause that stops before a clause
 * boundary, and only then a word cut marked with an ellipsis. Never ends on a function word.
 */
function label(text: string, limit: number, shortened: () => void): string {
  const clean = text.trim().replace(/\s+/gu, ' ').replace(/[.!;:,]+$/u, '');
  if (clean.length <= limit) return sentenceCase(clean);
  shortened();
  const compact = clean.replace(/(^|\s)(?:a|an|the)\s+/giu, '$1');
  if (compact.length <= limit) return sentenceCase(compact);
  for (const variant of [clean, compact]) {
    const tokens = variant.split(' ');
    for (let end = tokens.length - 1; end >= 2; end--) {
      if (!boundary.test(tokens[end]!)) continue;
      const phrase = trimWeak(tokens.slice(0, end));
      if (phrase.includes(' ') && phrase.length <= limit) return sentenceCase(phrase);
    }
  }
  const tokens = compact.split(' ');
  let end = tokens.length;
  while (end > 0 && tokens.slice(0, end).join(' ').length > limit - 1) end--;
  if (!end) throw new TmepError('E_INPUT', 'a label has no short source phrase that fits the template; author its visual plan manually');
  return sentenceCase(trimWeak(tokens.slice(0, end))) + '…';
}

/** Split an explanation sentence at the clause boundary nearest its middle. */
function pivotOf(body: string): number {
  const tokens = [...wordSplitter.segment(body)].filter(({ isWordLike }) => isWordLike);
  if (tokens.length <= 2) return 0;
  const inner = tokens.map((token, n) => ({ token, n })).filter(({ token, n }) => n >= 2 && n <= tokens.length - 2 && boundary.test(token.segment));
  const middle = tokens.length / 2;
  const best = inner.sort((a, b) => Math.abs(a.n - middle) - Math.abs(b.n - middle))[0];
  if (best) return best.token.index;
  // No clause boundary: keep the earlier split, but never end the title on a function word.
  let n = Math.min(3, Math.floor(tokens.length / 2));
  while (n < tokens.length - 1 && weakEnd.test(tokens[n - 1]!.segment)) n++;
  return tokens[n]!.index;
}

function splitScript(script: string): string[] {
  return script.split(/\r?\n/u).flatMap((line) =>
    [...sentenceSplitter.segment(line)].flatMap(({ segment }) => {
      const text = segment.trim();
      return sequence.test(text) ? text.split(inlineSequence) : [text];
    }),
  ).filter((text) => words(text).length);
}

/** Generate an editable Phase 1 storyboard without opening or changing a project. */
export function planScript(script: unknown, options: unknown = {}) {
  if (typeof script !== 'string' || !script.trim() || script.length > 20000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(script)) {
    throw new TmepError('E_INPUT', 'script must be non-empty plain text of at most 20,000 characters');
  }
  const parsed = optionsSchema.parse(options);
  if (!parsed.ok) throw new TmepError('E_INPUT', parsed.issues.map(({ path, msg }) => `${path}: ${msg}`).join('; '));
  const { wpm, narration } = parsed.value;
  const parts = splitScript(script);
  const content = words(parts.map((part) => part.replace(sequence, '')).join(' '));
  if (!content.some((word) => /\p{L}/u.test(word) && !vague.test(word))) {
    throw new TmepError('E_INPUT', 'script has no clear subject or action for the supported templates; add explicit content or author a storyboard');
  }

  const scenes: Scene[] = [];
  const warnings = ['Timing is estimated from speaking pace, without speech alignment.',
    'Visuals use stock process, explanation, and comparison templates. Review the storyboard if the script needs bespoke diagrams or illustrations.'];
  let estimatedWords = 0;
  let elapsedFrames = 0;
  for (let i = 0; i < parts.length;) {
    if (scenes.length === 16) throw new TmepError('E_RANGE', 'script requires more than 16 scenes; shorten it or split it into multiple storyboards');
    // A question or colon line directly before a step run titles that process.
    const runAt = (j: number) => j + 1 < parts.length && sequence.test(parts[j]!) && sequence.test(parts[j + 1]!)
      && !/^first(?:ly)?\b/iu.test(parts[j + 1]!);
    const heading = /[?:]$/u.test(parts[i]!) && !sequence.test(parts[i]!) && runAt(i + 1) ? parts[i++]! : undefined;
    const part = parts[i++]!;
    const steps = [part];
    if (sequence.test(part)) {
      while (i < parts.length && steps.length < 3 && sequence.test(parts[i]!) && !/^first(?:ly)?\b/iu.test(parts[i]!)) {
        steps.push(parts[i++]!);
        if (/^(?:finally|lastly|third)\b/iu.test(steps.at(-1)!)) break;
      }
    }
    const toFrame = (count: number) => Math.round(count * 60 * STORYBOARD_FPS / wpm);
    // Each step's estimated narration start, relative to the scene, so its label can enter on cue.
    let spoken = estimatedWords + (heading ? words(heading).length : 0);
    const cues = steps.map((text) => {
      const at = toFrame(spoken) - elapsedFrames;
      spoken += words(text).length;
      return at;
    });
    estimatedWords = spoken;
    const end = toFrame(estimatedWords);
    const frames = end - elapsedFrames;
    elapsedFrames = end;
    if (frames > 1800) throw new TmepError('E_RANGE', `scene ${scenes.length + 1} exceeds 60 seconds at ${wpm} WPM; split or shorten that passage`);
    const fields = { frames, transition: scenes.length === 0 ? 'cut' as const : 'fade' as const };
    let shortened = false;
    const markShortened = () => { shortened = true; };
    const bodies = steps.map((step) => step.replace(sequence, '').trim());
    if (bodies.some((body) => !words(body).some((word) => /\p{L}/u.test(word) && !vague.test(word)))) {
      throw new TmepError('E_INPUT', `scene ${scenes.length + 1} has no clear subject or action; make that passage explicit`);
    }
    if (bodies.length >= 2) {
      // Without a heading, name the run instead of repeating its first step as the title.
      scenes.push({ ...fields, template: 'process', title: heading ? label(heading, 40, markShortened) : `${bodies.length} steps`,
        steps: bodies.map((body) => label(body, 32, markShortened)), cues });
    } else {
      const body = bodies[0]!;
      const sides = body.split(/,\s+while\s+|,?\s+whereas\s+/iu);
      if (sides.length === 2 && sides.every((side) => words(side).length >= 3)) {
        scenes.push({ ...fields, template: 'comparison',
          first: label(sides[0]!, 44, markShortened), second: label(sides[1]!, 44, markShortened) });
      } else {
        const pivot = pivotOf(body);
        const title = label(pivot ? body.slice(0, pivot) : body, 40, markShortened);
        const point = label(pivot ? body.slice(pivot) : body, 44, markShortened);
        scenes.push({ ...fields, template: 'explanation', title, point });
      }
    }
    if (shortened) warnings.push(`Scene ${scenes.length}: on-screen labels are excerpts. The script is preserved.`);
  }
  const storyboard: Storyboard = { v: 1, script, narration, scenes };
  compileStoryboard(storyboard);
  return { storyboard, frames: elapsedFrames, warnings };
}
