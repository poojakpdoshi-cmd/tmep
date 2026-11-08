/**
 * Editing templates: named bundles of editorial decisions (pacing, framing, caption
 * style, graphics density, transitions, sound design). Agents pick a template name
 * instead of specifying dozens of parameters.
 */
import type { Captions, Ratio } from '../../core/src/index.ts';

export interface Template {
  name: string;
  desc: string;
  ratio: Ratio;
  fps: number;
  /** target duration in seconds (0 = keep all usable speech) */
  target: number;
  maxGap: number;
  pad: number;
  captions: Partial<Captions>;
  /** alternate 1.0/1.08 framing between jump cuts */
  jumpZoom: boolean;
  /** slow push-in per clip (extra scale reached at clip end) */
  push: number;
  /** min seconds between emphasis punch-zooms (0 = none) */
  zoomEvery: number;
  transition: { type: string; d: number } | null;
  gfx: { lists: boolean; stats: boolean; steps: boolean; cta: boolean; keywords: boolean; progress: boolean };
  /** min seconds between graphics */
  gfxGap: number;
  sfx: boolean;
  fit: 'cover' | 'blur' | 'contain';
}

const base = {
  fps: 30,
  pad: 0.07,
  push: 0.03,
  fit: 'cover' as const,
  gfxGap: 1.2,
};

export const TEMPLATES: Record<string, Template> = {
  reel: {
    ...base,
    name: 'reel',
    desc: 'Instagram Reel / TikTok: 9:16, ~30s, tight cuts, kinetic captions, punch zooms, icons & SFX',
    ratio: '9:16',
    target: 30,
    maxGap: 0.22,
    captions: { style: 'kinetic', pos: 'lower', maxWords: 3, upper: true },
    jumpZoom: true,
    zoomEvery: 3.5,
    transition: { type: 'smoothleft', d: 0.3 },
    gfx: { lists: true, stats: true, steps: true, cta: true, keywords: false, progress: true },
    gfxGap: 0.4,
    sfx: true,
  },
  short: {
    ...base,
    name: 'short',
    desc: 'Social short (YouTube Shorts style): 9:16, ~45s, boxed captions, moderate graphics',
    ratio: '9:16',
    target: 45,
    maxGap: 0.28,
    captions: { style: 'boxed', pos: 'lower', maxWords: 4, upper: false },
    jumpZoom: true,
    zoomEvery: 5,
    transition: { type: 'fade', d: 0.25 },
    gfx: { lists: true, stats: true, steps: true, cta: true, keywords: false, progress: false },
    gfxGap: 0.6,
    sfx: true,
  },
  talking_head: {
    ...base,
    name: 'talking_head',
    desc: 'Talking-head video: keep content, remove pauses/fillers, clean captions, subtle zooms',
    ratio: '16:9',
    target: 0,
    maxGap: 0.4,
    captions: { style: 'clean', pos: 'lower', maxWords: 6, upper: false, size: 0.85 },
    jumpZoom: true,
    zoomEvery: 8,
    transition: null,
    gfx: { lists: true, stats: true, steps: false, cta: false, keywords: false, progress: false },
    sfx: false,
  },
  tutorial: {
    ...base,
    name: 'tutorial',
    desc: 'Tech tutorial: 16:9, step badges, clean captions, fades between topics, no gimmicks',
    ratio: '16:9',
    target: 0,
    maxGap: 0.5,
    push: 0,
    captions: { style: 'clean', pos: 'lower', maxWords: 7, upper: false, size: 0.8 },
    jumpZoom: false,
    zoomEvery: 0,
    transition: { type: 'fade', d: 0.3 },
    gfx: { lists: true, stats: false, steps: true, cta: false, keywords: false, progress: false },
    sfx: false,
  },
  product_demo: {
    ...base,
    name: 'product_demo',
    desc: 'Product demo: 16:9, boxed captions, feature icons, stats, CTA, slide transitions',
    ratio: '16:9',
    target: 60,
    maxGap: 0.3,
    captions: { style: 'boxed', pos: 'lower', maxWords: 5, upper: false, size: 0.85 },
    jumpZoom: false,
    zoomEvery: 6,
    transition: { type: 'slideleft', d: 0.35 },
    gfx: { lists: true, stats: true, steps: true, cta: true, keywords: false, progress: false },
    sfx: true,
  },
  cinematic_explainer: {
    ...base,
    name: 'cinematic_explainer',
    desc: 'Cinematic explainer: 16:9, karaoke captions, slow push-ins, keyword pops, fade-through-black',
    ratio: '16:9',
    target: 0,
    maxGap: 0.35,
    push: 0.07,
    captions: { style: 'karaoke', pos: 'lower', maxWords: 5, upper: true, size: 0.85 },
    jumpZoom: false,
    zoomEvery: 0,
    transition: { type: 'fadeblack', d: 0.5 },
    gfx: { lists: true, stats: true, steps: false, cta: false, keywords: true, progress: false },
    sfx: true,
  },
  youtube: {
    ...base,
    name: 'youtube',
    desc: 'Long-form YouTube: 16:9, keep content, tighten pauses, light graphics, dissolves at topics',
    ratio: '16:9',
    target: 0,
    maxGap: 0.45,
    captions: { style: 'none' },
    jumpZoom: true,
    zoomEvery: 10,
    transition: { type: 'dissolve', d: 0.3 },
    gfx: { lists: true, stats: true, steps: true, cta: true, keywords: false, progress: false },
    sfx: false,
  },
};

export const TEMPLATE_ALIASES: Record<string, string> = {
  instagram_reel: 'reel',
  instagram: 'reel',
  tiktok: 'reel',
  shorts: 'short',
  social_short: 'short',
  educational_reel: 'reel',
  tech_tutorial: 'tutorial',
  explainer: 'cinematic_explainer',
  demo: 'product_demo',
};

export function getTemplate(name: string): Template | undefined {
  return TEMPLATES[name] ?? TEMPLATES[TEMPLATE_ALIASES[name] ?? ''];
}
