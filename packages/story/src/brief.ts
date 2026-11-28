/**
 * Task-specific editing briefs from a footage analysis (Phase 4B).
 *
 * A brief is what an external agent needs to make editorial decisions — and nothing else: no raw
 * frames, no full transcript, no per-window series. Every item keeps its timestamp, its evidence and
 * whether it was observed or inferred, so the agent can decide what to trust.
 *
 * Phase 5: when the semantic layer ran, briefs add scene types, subjects, tracks, text over time and
 * event candidates; every domain keeps the same rule — candidates are never presented as recognized.
 */
import type { Word } from '../../core/src/index.ts';
import type { FootageAnalysis } from '../../media/src/footage.ts';
import { sentences, keywords, scoreSentence } from '../../speech/src/analyze.ts';
import { detectList, detectStat, detectStep, detectCta, splitSentences } from './rules.ts';

export const BRIEF_TASKS = ['informative', 'sports', 'cinematic', 'product', 'podcast', 'educational', 'generic'] as const;
export type BriefTask = (typeof BRIEF_TASKS)[number];

const r1 = (x: number) => Math.round(x * 10) / 10;
const span = (a: number, b: number): [number, number] => [r1(a), r1(b)];

export function editingBrief(a: FootageAnalysis, task: BriefTask = 'generic', words: Word[] = [], max = 6): Record<string, unknown> {
  const o = a.observed, inf = a.inferred;
  const gaps = Object.entries(a.capabilities).filter(([, c]) => c.status === 'unavailable').map(([k, c]) => `${k}: ${(c as { reason: string }).reason}`);
  const moments = inf.moments.slice().sort((x, y) => y.score - x.score).slice(0, max)
    .sort((x, y) => x.t - y.t).map((m) => ({ id: m.id, at: span(m.t0, m.t1), conf: m.confidence, why: m.evidence.join('; ') }));
  const regions = inf.quietRegions.map((q) => ({ x: q.x, y: q.y, w: q.w, h: q.h }));
  // Consecutive shots with the same scene type, as [t0, t1, label, mean confidence].
  const sceneRuns: { at: [number, number]; type: string; conf: number }[] = [];
  for (const st of inf.sceneTypes ?? []) {
    const sh = o.shots.find((x) => x.id === st.shot); if (!sh) continue;
    const last = sceneRuns.at(-1);
    if (last && last.type === st.label) { last.at[1] = r1(sh.t1); last.conf = Math.min(last.conf, st.confidence); } else sceneRuns.push({ at: span(sh.t0, sh.t1), type: st.label, conf: st.confidence });
  }
  const tracksBrief = (pred: (t: NonNullable<typeof o.tracks>[number]) => boolean) => (o.tracks ?? []).filter((t) => t.n >= 3 && pred(t)).sort((x, y) => y.n * y.area - x.n * x.area).slice(0, max).map((t) => ({ id: t.id, label: t.label, at: span(t.t0, t.t1), speed: t.speed }));
  const events = (inf.events ?? []).slice().sort((x, y) => y.score - x.score).slice(0, max).sort((x, y) => x.t - y.t).map((e) => ({ id: e.id, at: span(e.t0, e.t1), score: e.score, signals: Object.keys(e.signals), why: e.evidence.slice(0, 3).join('; ') }));
  const shotsOf = (type: string) => (inf.sceneTypes ?? []).filter((x) => x.label === type).map((x) => o.shots.find((s) => s.id === x.shot)!).filter(Boolean).map((s) => ({ id: s.id, at: span(s.t0, s.t1) }));
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
      ...(sceneRuns.length && { sceneTypes: sceneRuns.slice(0, max * 2), sceneTypesNote: 'rule-based hints from detections; agreed with labels on 9 of 23 held-out real UGC spans — verify before relying on them' }),
      ...(inf.subjects && { subjects: { presenter: inf.subjects.presenter, primary: inf.subjects.primary, moving: inf.subjects.moving.slice(0, max) } }),
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
      ...(events.length && { eventCandidates: events }),
      ...(inf.textChanges?.length && { scoreChanges: inf.textChanges.slice(0, max).map((c) => ({ at: r1(c.t), from: c.before, to: c.after, conf: c.confidence })) }),
      ...(inf.duplicates?.some((d) => d.kind === 'replay-candidate') && { replayCandidates: inf.duplicates.filter((d) => d.kind === 'replay-candidate').slice(0, max) }),
      ...(o.tracks && { fastSubjects: tracksBrief((t) => t.speed >= 0.25) }),
      ...(text.length && { visibleText: text }),
      loudest: o.audio.length ? o.audio.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v).slice(0, 3).map(({ v, i }) => ({ at: r1(i * 0.5), db: r1(v) })) : [],
      note: 'moments and event candidates are coinciding signal peaks (audio, motion, cuts, on-screen number changes, possible replays, fast subjects) — not recognized goals, wickets or boundaries; event recognition has not been evaluated on labelled footage; verify before cutting',
    };
  }
  if (task === 'cinematic') {
    return {
      ...base,
      shots: o.shots.slice(0, max * 3).map((s) => ({ id: s.id, at: span(s.t0, s.t1), luma: Math.round(s.luma), motion: r1(s.motion), detail: r1(s.detail), ...(s.boundary === 'gradual' && { in: 'gradual' }), ...(inf.sceneTypes && { type: inf.sceneTypes.find((x) => x.shot === s.id)?.label }) })),
      moments,
      ...(inf.duplicates?.length && { similarShots: inf.duplicates.slice(0, max).map((d) => ({ a: d.a, b: d.b, sim: d.similarity, kind: d.kind })) }),
      ...(inf.activities?.length && { activity: inf.activities.slice(0, max).map((x) => ({ track: x.track, at: span(x.t0, x.t1), label: x.label, conf: x.confidence })) }),
      ...(o.tracks && { movingSubjects: tracksBrief((t) => t.speed >= 0.25) }),
    };
  }
  if (task === 'product') {
    const text = (o.text ?? []).slice(0, max).map((t) => ({ at: r1(t.t), text: t.text }));
    const steady = o.shots.filter((s) => s.motion < 1 && s.t1 - s.t0 >= 1.5).slice(0, max).map((s) => ({ id: s.id, at: span(s.t0, s.t1) }));
    return {
      ...base, steadyShots: steady, graphicRegions: regions, ...(text.length && { visibleText: text }),
      ...(o.tracks && { objects: tracksBrief((t) => t.label !== 'person') }),
      ...(inf.sceneTypes && { closeUps: shotsOf('object close-up'), screens: shotsOf('screen/slides') }),
      note: 'steady shots suit callouts and ui_demo presets; product demonstrations must come from real recordings of the product (request them as assets) — never simulate one',
    };
  }
  if (task === 'podcast') {
    const speech = o.speech ?? [];
    const singles = shotsOf('talking-head'), groups = shotsOf('multi-person conversation');
    const longSingles = singles.filter((s) => s.at[1] - s.at[0] >= 12);
    return {
      ...base,
      speakers: { maxFacesInFrame: Math.max(0, ...(o.faces ?? []).map((f) => f.boxes.length)), people: tracksBrief((t) => t.label === 'person').length },
      ...(inf.sceneTypes && { singleShots: singles.slice(0, max), groupShots: groups.slice(0, max) }),
      tighten: o.silences.filter((x) => x.t1 - x.t0 >= 0.8).slice(0, max * 2).map((x) => span(x.t0, x.t1)),
      ...(speech.length && { speechSegments: speech.length }),
      ...(longSingles.length && { cutawayOpportunities: longSingles.map((s) => ({ ...s, why: 'single shot ≥ 12 s: consider b-roll, a quote card or a reframe' })) }),
      captions: inf.presenter && inf.presenter.y > 0.55 ? 'upper' : 'lower',
      ...(!words.length && { note: 'no transcript: quotes and topics need transcribe first' }),
    };
  }
  if (task === 'educational') {
    const kw = keywords(words, 8);
    return {
      ...base,
      topic: kw.map((k) => k.k),
      ...(inf.sceneTypes && { boardOrScreenShots: shotsOf('screen/slides').slice(0, max), presenterShots: shotsOf('talking-head').slice(0, max) }),
      ...(o.textTracks?.length && { onScreenText: o.textTracks.filter((t) => t.text.length >= 3).slice(0, max * 2).map((t) => ({ text: t.text, at: span(t.t0, t.t1) })) }),
      ...(inf.alignment?.length && { spokenAndShown: inf.alignment.slice(0, max).map((x) => ({ word: x.word, at: x.t, on: x.target, dt: x.dt })) }),
      ...(o.gestures?.length && { gestures: o.gestures.slice(0, max).map((g) => ({ at: r1(g.t), label: g.label })) }),
      cuts: o.silences.filter((x) => x.t1 - x.t0 >= 0.8).slice(0, max * 2).map((x) => span(x.t0, x.t1)),
      graphicRegions: regions,
      ...(!words.length && { note: 'no transcript: topics and spoken/shown alignment need transcribe first' }),
    };
  }
  return { ...base, moments, ...(events.length && { eventCandidates: events }), graphicRegions: regions, silences: o.silences.slice(0, max).map((s) => span(s.t0, s.t1)) };
}
