/**
 * Planner: transcript(s) + template -> complete timeline, deterministically.
 * One `video_plan` call replaces what would otherwise be thousands of LLM tokens of
 * timestamps, animation code and FFmpeg commands.
 */
import {
  type Timeline,
  type Word,
  type Captions,
  type Ratio,
  TmepError,
  RATIOS,
  emptyTimeline,
  newClip,
  nextId,
  layout,
  timelineWords,
  anchorAt,
  tlToSrc,
  duration,
  r2,
  addTransition,
} from '../../core/src/index.ts';
import { roughCut, keywords } from '../../speech/src/analyze.ts';
import { getTemplate, TEMPLATES } from './templates.ts';
import { storyboard } from './rules.ts';
import { SFX_KINDS } from '../../render/src/sfx.ts';

export interface PlanInput {
  template: string;
  sources: { id: string; dur: number; kind: string; w?: number; h?: number; words?: Word[] }[];
  target?: number;
  ratio?: Ratio;
  captions?: Partial<Captions>;
  title?: string;
  sub?: string;
  music?: string;
  sfx?: boolean;
  graphics?: boolean;
  zooms?: boolean;
  transitions?: boolean;
}

export interface PlanSummary {
  dur: number;
  clips: number;
  kept: number;
  sentences: number;
  gfx: Record<string, number>;
  zooms: number;
  sfx: number;
  trans: number;
  rejected: number;
}

export function planTimeline(inp: PlanInput): { tl: Timeline; summary: PlanSummary } {
  const tpl = getTemplate(inp.template);
  if (!tpl) throw new TmepError('E_INPUT', `unknown template "${inp.template}"`, `templates: ${Object.keys(TEMPLATES).join(',')}`);
  if (!inp.sources.length) throw new TmepError('E_INPUT', 'plan needs at least one source asset');
  const ratio = inp.ratio ?? tpl.ratio;
  const tl = emptyTimeline(ratio, tpl.fps);
  const [w, h] = RATIOS[ratio];
  tl.settings = { ...tl.settings, w, h };
  tl.meta = { template: tpl.name };
  const target = inp.target ?? tpl.target;
  let keptSentences = 0;
  let totalSentences = 0;

  // 1) rough cut every source (target split by source speech share)
  const speechTotal = inp.sources.reduce((a, s) => a + (s.words?.length ? s.words[s.words.length - 1]!.e - s.words[0]!.s : 0), 0) || 1;
  for (const src of inp.sources) {
    if (src.kind === 'image') {
      tl.clips.push(newClip(tl, src.id, 0, 3, { fit: tpl.fit }));
      continue;
    }
    if (!src.words?.length) {
      // no transcript: keep the whole source (or target length)
      const out = target ? Math.min(src.dur, target) : src.dur;
      tl.clips.push(newClip(tl, src.id, 0, out, { fit: tpl.fit }));
      continue;
    }
    const share = (src.words[src.words.length - 1]!.e - src.words[0]!.s) / speechTotal;
    const lastText = src.words.slice(-14).map((w) => w.w.toLowerCase()).join(' ');
    const ctaLast = tpl.gfx.cta && /\b(follow|subscribe|link in (the )?bio|comment|save this)\b/.test(lastText.split(/[.!?]\s/).pop() ?? '');
    const rc = roughCut(src.words, { target: target ? target * share : 0, maxGap: tpl.maxGap, pad: tpl.pad, dropFillers: true, keepFirst: true, keepLast: ctaLast });
    keptSentences += rc.kept.length;
    totalSentences += countSentences(src.words);
    for (const [s, e] of rc.ranges) tl.clips.push(newClip(tl, src.id, s, Math.min(e, src.dur), { fit: tpl.fit }));
  }
  if (!tl.clips.length) throw new TmepError('E_STATE', 'rough cut produced no clips (is the transcript empty?)');

  // 2) framing: crop centre, jump-cut alternation, push-ins
  let alt = false;
  tl.clips.forEach((c, i) => {
    c.push = tpl.push;
    const prev = tl.clips[i - 1];
    const isJump = prev && prev.src === c.src && c.in - prev.out > 0.05;
    if (tpl.jumpZoom && isJump) alt = !alt;
    else if (!isJump) alt = false;
    c.base = alt ? 1.08 : 1;
  });

  // 3) captions
  tl.captions = { ...tl.captions, ...tpl.captions, ...(inp.captions ?? {}) };

  // 4) storytelling pass over the edited timeline
  const transcripts: Record<string, Word[] | undefined> = {};
  for (const s of inp.sources) transcripts[s.id] = s.words;
  let placed = layout(tl);
  const dur = duration(tl);
  const words = timelineWords(tl, transcripts, placed);
  const allWords = inp.sources.flatMap((s) => s.words ?? []);
  const kw = keywords(allWords, 3).map((k) => k.k);
  const useGfx = inp.graphics ?? true;
  const sfxOn = (inp.sfx ?? tpl.sfx) && SFX_KINDS.length > 0;
  const sb = storyboard(words, {
    ...(useGfx ? tpl.gfx : { lists: false, stats: false, steps: false, cta: false, keywords: false, progress: false }),
    zoomEvery: inp.zooms === false ? 0 : tpl.zoomEvery,
    sfx: sfxOn,
    gfxGap: tpl.gfxGap,
    dur,
    topKeywords: kw,
  });
  const gfxCount: Record<string, number> = {};
  let zooms = 0;
  let sfxCount = 0;
  for (const p of sb.accepted) {
    if (p.kind === 'gfx') {
      tl.gfx.push({ id: nextId(tl, 'g'), preset: p.preset!, ref: anchorAt(placed, p.t), d: r2(p.d, 3), props: p.props ?? {} });
      gfxCount[p.preset!] = (gfxCount[p.preset!] ?? 0) + 1;
    } else if (p.kind === 'sfx') {
      tl.sfx.push({ id: nextId(tl, 's'), kind: p.sfx!, ref: anchorAt(placed, p.t), vol: p.vol ?? -14 });
      sfxCount++;
    } else if (p.kind === 'zoom') {
      const hit = tlToSrc(placed, p.t);
      if (!hit) continue;
      hit.p.clip.zoom.push({ s: r2(hit.srcT, 3), d: r2(p.d, 3), to: p.to ?? 1.15, mode: 'punch' });
      zooms++;
    }
  }

  // 5) transitions at topic changes (skipped content or long source gaps), never on jump cuts
  let trans = 0;
  if (tpl.transition && inp.transitions !== false) {
    tl.clips.forEach((c, i) => {
      const prev = tl.clips[i - 1];
      if (!prev) return;
      const gap = c.src === prev.src ? c.in - prev.out : Infinity;
      if (gap > 2.5) {
        const td = addTransition(tl, i, tpl.transition!.type, tpl.transition!.d, transcripts, (id) => inp.sources.find((x) => x.id === id)?.dur ?? Infinity);
        if (!td) return;
        trans++;
        if (sfxOn) {
          placed = layout(tl);
          const p = placed[i]!;
          tl.sfx.push({ id: nextId(tl, 's'), kind: 'whoosh', ref: anchorAt(placed, p.start), vol: -16 });
          sfxCount++;
        }
      }
    });
  }

  // 6) title, progress bar, music
  placed = layout(tl);
  const finalDur = duration(tl);
  if (inp.title) {
    tl.gfx.unshift({ id: nextId(tl, 'g'), preset: 'title', ref: { at: 0 }, d: Math.min(2.8, finalDur), props: { text: inp.title, ...(inp.sub ? { sub: inp.sub } : {}) } });
    gfxCount.title = 1;
    if (sfxOn) tl.sfx.push({ id: nextId(tl, 's'), kind: 'swoosh', ref: { at: 0.05 }, vol: -18 });
  }
  if (useGfx && tpl.gfx.progress) {
    tl.gfx.push({ id: nextId(tl, 'g'), preset: 'progress', ref: { at: 0 }, d: r2(finalDur, 3), props: {} });
    gfxCount.progress = 1;
  }
  if (inp.music) tl.music = { src: inp.music, vol: -18, duck: true, fade: 1.5 };

  return {
    tl,
    summary: { dur: r2(finalDur), clips: tl.clips.length, kept: keptSentences, sentences: totalSentences, gfx: gfxCount, zooms, sfx: sfxCount, trans, rejected: sb.rejected },
  };
}

function countSentences(words: Word[]): number {
  return words.filter((w, i) => /[.!?]$/.test(w.w) || (words[i + 1] && words[i + 1]!.s - w.e > 0.75) || i === words.length - 1).length;
}
