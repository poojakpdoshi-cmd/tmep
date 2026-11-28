/**
 * Task-specific editing briefs from a footage analysis (Phase 4B).
 *
 * A brief is what an external agent needs to make editorial decisions — and nothing else: no raw
 * frames, no full transcript, no per-window series. Every item keeps its timestamp, its evidence and
 * whether it was observed or inferred, so the agent can decide what to trust.
 */
import type { Word } from '../../core/src/index.ts';
import type { FootageAnalysis } from '../../media/src/footage.ts';
import { sentences, keywords, scoreSentence } from '../../speech/src/analyze.ts';
import { detectList, detectStat, detectStep, detectCta, splitSentences } from './rules.ts';

export const BRIEF_TASKS = ['informative', 'sports', 'cinematic', 'product', 'generic'] as const;
export type BriefTask = (typeof BRIEF_TASKS)[number];

const r1 = (x: number) => Math.round(x * 10) / 10;
const span = (a: number, b: number): [number, number] => [r1(a), r1(b)];

export function editingBrief(a: FootageAnalysis, task: BriefTask = 'generic', words: Word[] = [], max = 6): Record<string, unknown> {
  const o = a.observed, inf = a.inferred;
  const gaps = Object.entries(a.capabilities).filter(([, c]) => c.status === 'unavailable').map(([k, c]) => `${k}: ${(c as { reason: string }).reason}`);
  const moments = inf.moments.slice().sort((x, y) => y.score - x.score).slice(0, max)
    .sort((x, y) => x.t - y.t).map((m) => ({ id: m.id, at: span(m.t0, m.t1), conf: m.confidence, why: m.evidence.join('; ') }));
  const regions = inf.quietRegions.map((q) => ({ x: q.x, y: q.y, w: q.w, h: q.h }));
  const base: Record<string, unknown> = {
    brief: 'frame.brief/1',
    task,
    media: { dur: a.asset.dur, size: `${a.asset.w}x${a.asset.h}`, fps: a.asset.fps, audio: a.asset.audio, ...(a.asset.truncated && { analyzedSeconds: a.asset.analyzedSeconds }) },
    observed: {
      shots: o.shots.length,
      pacing: inf.pacing,
      ...(o.quality.length && { quality: o.quality.slice(0, max).map((q) => ({ shot: q.shot, flags: q.flags })) }),
    },
    inferred: {
      scenes: inf.scenes.slice(0, max).map((s) => ({ id: s.id, at: span(s.t0, s.t1), shots: s.shots.length })),
      ...(inf.presenter && { presenter: { x: inf.presenter.x, y: inf.presenter.y, w: inf.presenter.w, h: inf.presenter.h, conf: inf.presenter.confidence } }),
    },
    ...(gaps.length && { unavailable: gaps }),
  };

  if (task === 'informative') {
    const ss = words.length ? sentences(words) : [];
    const kw = keywords(words, 6);
    const kwSet = new Set(kw.map((k) => k.k));
    const statements = ss.map((s) => ({ s, score: scoreSentence(s, words, kwSet) })).sort((x, y) => y.score - x.score).slice(0, max)
      .sort((x, y) => x.s.s - y.s.s).map(({ s }) => ({ at: span(s.s, s.e), text: s.text.length > 140 ? `${s.text.slice(0, 137)}…` : s.text }));
    const tl = words.map((w, i) => ({ ...w, src: 'v', i, k: i }));
    const visuals: Record<string, unknown>[] = [];
    for (const sent of splitSentences(tl)) {
      const stat = detectStat(sent), list = detectList(sent), step = detectStep(sent), cta = detectCta(sent);
      if (stat) visuals.push({ at: r1(stat.t), kind: 'stat', value: stat.value, label: stat.label, preset: 'dynamic_chart|kinetic_title' });
      if (list) visuals.push({ at: r1(list[0]!.t), kind: 'list', items: list.map((l) => l.label), preset: 'animated_diagram' });
      if (step) visuals.push({ at: r1(step.t), kind: 'step', n: step.n });
      if (cta) visuals.push({ at: r1(cta.t), kind: 'cta', text: cta.text });
      if (visuals.length >= max) break;
    }
    return {
      ...base,
      topic: kw.map((k) => k.k),
      statements,
      cuts: o.silences.filter((s) => s.t1 - s.t0 >= 0.6).slice(0, max * 2).map((s) => span(s.t0, s.t1)),
      visuals,
      graphicRegions: regions,
      captions: inf.presenter && inf.presenter.y > 0.55 ? 'upper' : 'lower',
      ...(!words.length && { note: 'no transcript: statements, topic and visual cues need transcribe first' }),
    };
  }
  if (task === 'sports') {
    const text = (o.text ?? []).slice(0, max).map((t) => ({ at: r1(t.t), text: t.text, conf: t.conf }));
    return {
      ...base,
      moments,
      ...(text.length && { visibleText: text }),
      loudest: o.audio.length ? o.audio.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v).slice(0, 3).map(({ v, i }) => ({ at: r1(i * 0.5), db: r1(v) })) : [],
      note: 'moments are signal peaks (crowd/commentary level, motion, cut density) — not recognized goals, wickets or boundaries; verify before cutting',
    };
  }
  if (task === 'cinematic') {
    return {
      ...base,
      shots: o.shots.slice(0, max * 3).map((s) => ({ id: s.id, at: span(s.t0, s.t1), luma: Math.round(s.luma), motion: r1(s.motion), detail: r1(s.detail) })),
      moments,
    };
  }
  if (task === 'product') {
    const text = (o.text ?? []).slice(0, max).map((t) => ({ at: r1(t.t), text: t.text }));
    const steady = o.shots.filter((s) => s.motion < 1 && s.t1 - s.t0 >= 1.5).slice(0, max).map((s) => ({ id: s.id, at: span(s.t0, s.t1) }));
    return { ...base, steadyShots: steady, graphicRegions: regions, ...(text.length && { visibleText: text }), note: 'steady shots suit callouts and ui_demo presets' };
  }
  return { ...base, moments, graphicRegions: regions, silences: o.silences.slice(0, max).map((s) => span(s.t0, s.t1)) };
}
