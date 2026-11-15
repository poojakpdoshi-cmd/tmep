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

function label(text: string, limit: number, shortened: () => void): string {
  const clean = text.trim().replace(/\s+/gu, ' ').replace(/[.!?;:,]+$/u, '');
  if (clean.length <= limit) return clean;
  const prefix = clean.slice(0, limit - 1);
  const boundary = prefix.lastIndexOf(' ');
  if (boundary < 1) throw new TmepError('E_INPUT', 'a label has no short source phrase that fits the template; author its visual plan manually');
  shortened();
  return prefix.slice(0, boundary) + '…';
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
    const start = i++;
    const part = parts[start]!;
    const steps = [part];
    if (sequence.test(part)) {
      while (i < parts.length && steps.length < 3 && sequence.test(parts[i]!) && !/^first(?:ly)?\b/iu.test(parts[i]!)) {
        steps.push(parts[i++]!);
        if (/^(?:finally|lastly|third)\b/iu.test(steps.at(-1)!)) break;
      }
    }
    estimatedWords += steps.reduce((count, text) => count + words(text).length, 0);
    const end = Math.round(estimatedWords * 60 * STORYBOARD_FPS / wpm);
    const frames = end - elapsedFrames;
    elapsedFrames = end;
    if (frames > 1800) throw new TmepError('E_RANGE', `scene ${scenes.length + 1} exceeds 60 seconds at ${wpm} WPM; split or shorten that passage`);
    const fields = { frames, transition: start === 0 ? 'cut' as const : 'fade' as const };
    let shortened = false;
    const markShortened = () => { shortened = true; };
    const bodies = steps.map((step) => step.replace(sequence, '').trim());
    if (bodies.some((body) => !words(body).some((word) => /\p{L}/u.test(word) && !vague.test(word)))) {
      throw new TmepError('E_INPUT', `scene ${scenes.length + 1} has no clear subject or action; make that passage explicit`);
    }
    if (bodies.length >= 2) {
      scenes.push({ ...fields, template: 'process', title: label(bodies[0]!, 24, markShortened),
        steps: bodies.map((body) => label(body, 20, markShortened)) });
    } else {
      const body = bodies[0]!;
      const sides = body.split(/,\s+while\s+|,?\s+whereas\s+/iu);
      if (sides.length === 2 && sides.every((side) => words(side).length >= 3)) {
        scenes.push({ ...fields, template: 'comparison',
          first: label(sides[0]!, 32, markShortened), second: label(sides[1]!, 32, markShortened) });
      } else {
        const tokens = [...wordSplitter.segment(body)].filter(({ isWordLike }) => isWordLike);
        const pivot = tokens.length > 2 ? tokens[Math.min(3, Math.floor(tokens.length / 2))]!.index : 0;
        const title = label(pivot ? body.slice(0, pivot) : body, 24, markShortened);
        const point = label(pivot ? body.slice(pivot) : body, 24, markShortened);
        scenes.push({ ...fields, template: 'explanation', title, point });
      }
    }
    if (shortened) warnings.push(`Scene ${scenes.length}: on-screen labels are excerpts. The script is preserved.`);
  }
  const storyboard: Storyboard = { v: 1, script, narration, scenes };
  compileStoryboard(storyboard);
  return { storyboard, frames: elapsedFrames, warnings };
}
