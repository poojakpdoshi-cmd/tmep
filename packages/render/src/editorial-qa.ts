/**
 * FRAME Inspector, editorial checks (Phase 7.3). Deterministic, evidence-backed checks over the timeline,
 * its words, cached footage analyses and (optionally) a rendered preview. Every finding is classed:
 *
 *  - objective   a measurable defect or a broken explicit instruction (clipped word, caption flash,
 *                unverified captions burned in, active speaker outside the crop, unauthorized look, …)
 *  - advisory    a craft judgement with its evidence (pacing, repetition, unmotivated b-roll/SFX, …)
 *  - preference  an advisory that the user's explicit instruction overrides: reported, never "fixed"
 *
 * A report with no objective findings is not evidence of creative quality; the summary says so.
 */
import { layout, resolveRef, type Timeline, type TlWord } from '../../core/src/index.ts';
import type { FootageAnalysis } from '../../media/src/footage.ts';
import { centreToOffset } from '../../media/src/semantic.ts';
import { audioEnvelope } from '../../media/src/speaker.ts';
import { captionLayout, paginate } from '../../motion/src/captions.ts';
import { cropCentre } from './footage-qa.ts';

export type EditorialClass = 'objective' | 'advisory' | 'preference';
export interface EditorialFinding {
  code: string; class: EditorialClass; severity: 'defect' | 'advisory'; msg: string; evidence: string[];
  /** Timeline seconds the finding concerns (the correction engine re-renders only this range). */
  at?: [number, number];
  /** Ops that address the finding; only objective findings carry them. */
  fixOps?: Record<string, unknown>[];
  detail?: Record<string, unknown>;
}
export interface EditorialOptions {
  constraints?: { target?: number; ratio?: string; captions?: boolean; zooms?: boolean; graphics?: boolean; transitions?: boolean; music?: string; keep?: [number, number][]; avoid?: [number, number][]; allowLook?: boolean; allowBackgroundChange?: boolean; maxEffectsPerMinute?: number };
  /** Transcript quality of the sources (engine without measured caption-grade accuracy, or approximate timing). */
  transcript?: { approx?: boolean; unverified?: string };
  /** Words describing each b-roll asset (library tags, description), by asset id. */
  assetTerms?: Map<string, string[]>;
  /** Source transcripts (source time) by asset id, for cut-through-word checks. */
  sources?: Record<string, { w: string; s: number; e: number }[] | undefined>;
  renderedPath?: string;
  ffmpeg?: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const norm = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}%.]+/gu, ' ').trim();
const STOP = new Set('the a an and or of to in on for with is are was were be this that it its at by from as your you we our'.split(' '));

export async function editorialFindings(tl: Timeline, words: TlWord[], analyses: Map<string, FootageAnalysis>, o: EditorialOptions = {}): Promise<{ findings: EditorialFinding[]; summary: { objective: number; advisory: number; preference: number; note: string } }> {
  const out: EditorialFinding[] = [];
  const c = o.constraints ?? {};
  const add = (f: Omit<EditorialFinding, 'severity'>) => out.push({ ...f, severity: f.class === 'objective' ? 'defect' : 'advisory' });
  const placed = layout(tl);
  const dur = placed.reduce((m, p) => Math.max(m, p.start + p.dur), 0);
  const at = (ref: unknown) => resolveRef(placed, ref as never);
  const spoken = (t0: number, t1: number) => words.filter((w) => w.e >= t0 && w.s <= t1).map((w) => norm(w.w)).join(' ');

  // ---- cuts that clip words (objective): a clip edge inside a source word (source transcripts needed)
  for (const p of placed) {
    const src = o.sources?.[p.clip.src] ?? [];
    for (const [edge, t, tlT] of [['in', p.clip.in, p.start], ['out', p.clip.out, p.start + p.dur]] as const) {
      const w = src.find((x) => t > x.s + 0.04 && t < x.e - 0.04);
      if (w) add({ code: 'clipped-word', class: 'objective', msg: `clip ${p.clip.id} ${edge} point ${r2(t)} s cuts through "${w.w}" (${r2(w.s)}–${r2(w.e)} s)`, evidence: [`source word ${r2(w.s)}–${r2(w.e)} s; cut at ${r2(t)} s`], at: [r2(Math.max(0, tlT - 0.5)), r2(tlT + 0.5)], fixOps: [{ op: 'trim', clip: p.clip.id, [edge]: r2(edge === 'in' ? Math.max(0, w.s - 0.05) : w.e + 0.05) }], detail: { clip: p.clip.id, edge } });
    }
  }

  // ---- captions: flashes (objective), reading speed and confidence (advisory), unverified text (objective)
  if (tl.captions.style !== 'none' && words.length) {
    const lay = captionLayout(tl.captions, tl.settings.w, tl.settings.h);
    const pages = paginate(words, tl.captions, lay.maxChars);
    const flash = pages.filter((pg) => pg.words.length >= 2 && pg.e - pg.s < 0.3);
    if (flash.length) add({ code: 'caption-flash', class: 'objective', msg: `${flash.length} caption page(s) of 2+ words stay on screen < 0.3 s`, evidence: flash.slice(0, 3).map((pg) => `${r2(pg.s)} s "${pg.words.map((w) => w.w).join(' ')}" for ${r2(pg.e - pg.s)} s`), at: [r2(flash[0]!.s), r2(flash.at(-1)!.e)], fixOps: [{ op: 'captions', maxWords: Math.max(1, tl.captions.maxWords - 1) }] });
    const fast = pages.filter((pg) => pg.e - pg.s >= 0.3 && pg.words.map((w) => w.w).join(' ').length / Math.max(0.3, pg.e - pg.s) > 22);
    if (fast.length > pages.length * 0.2) add({ code: 'caption-fast', class: 'advisory', msg: `${fast.length}/${pages.length} caption pages exceed 22 characters/s (subtitle guidelines: ≤ 20 cps for adults)`, evidence: [`median page ${r2(median(pages.map((pg) => pg.e - pg.s)))} s`], at: [r2(fast[0]!.s), r2(fast.at(-1)!.e)] });
    const low = words.filter((w) => (w.p ?? 1) < 0.5);
    if (low.length) add({ code: 'low-confidence-caption', class: 'advisory', msg: `${low.length} captioned words have recogniser confidence < 0.5: review them`, evidence: low.slice(0, 6).map((w) => `"${w.w}" at ${r2(w.s)} s (p=${r2(w.p!)})`) });
    if (o.transcript?.unverified || o.transcript?.approx) add({ code: 'unverified-captions', class: 'objective', msg: `burned-in captions come from ${o.transcript.unverified ?? 'an approximate transcript'} without measured caption-grade accuracy`, evidence: ['docs/phase-7/INTELLIGENCE.md: only Parakeet-TDT measured caption-grade (FLEURS-en WER 9.6 %)'], fixOps: [] });
    // Competing text: a graphic with text on screen together with captions for > 1.5 s.
    for (const g of tl.gfx) {
      const t = at(g.ref);
      if (t === undefined) continue;
      const overlap = pages.filter((pg) => pg.e > t && pg.s < t + g.d).reduce((s, pg) => s + Math.min(pg.e, t + g.d) - Math.max(pg.s, t), 0);
      if (overlap > 1.5 && /title|stat|lower|quote|text|icons|list/i.test(g.preset)) add({ code: 'competing-text', class: 'advisory', msg: `graphic ${g.id} (${g.preset}) shares the screen with captions for ${r2(overlap)} s: two text elements compete for attention`, evidence: [`${g.id} ${r2(t)}–${r2(t + g.d)} s`], at: [r2(t), r2(t + g.d)] });
    }
  }

  // ---- active speaker outside the crop (objective when speaker framing exists for this aspect)
  for (const p of placed) {
    const a = analyses.get(p.clip.src);
    const sp = a?.inferred.speakers, rf = a?.inferred.reframe?.find((r) => r.aspect === tl.settings.ratio && r.subject === 'active speaker');
    if (!a || !sp || !rf?.crop || rf.crop.w >= 0.999) continue;
    let off = 0, total = 0;
    for (const s of sp.segments) {
      const t0 = Math.max(s.t0, p.clip.in), t1 = Math.min(s.t1, p.clip.out);
      if (t1 <= t0) continue;
      const tr = sp.faceTracks.find((f) => f.id === s.track);
      if (!tr) continue;
      for (let t = t0; t < t1; t += 0.25) {
        total += 0.25;
        const [ox] = cropCentre(p.clip, t);
        const centre = rf.crop.w / 2 + ox * (1 - rf.crop.w);
        if (Math.abs(tr.x - centre) > rf.crop.w / 2) off += 0.25;
      }
    }
    if (off >= 1 && off / Math.max(1e-6, total) > 0.15) {
      const keys = rf.keys.filter((k) => k.t >= p.clip.in - 0.5 && k.t <= p.clip.out + 0.5).map((k) => ({ t: k.t, cx: centreToOffset(k.cx, rf.crop!.w), cy: centreToOffset(k.cy, rf.crop!.h) }));
      add({ code: 'speaker-off-crop', class: 'objective', msg: `clip ${p.clip.id}: the active speaker is outside the ${tl.settings.ratio} crop for ${r2(off)} of ${r2(total)} s of speech`, evidence: [sp.basis, `speaker segments ${sp.segments.length}`], at: [r2(p.start), r2(p.start + p.dur)], ...(keys.length && { fixOps: [{ op: 'reframe', clip: p.clip.id, cx: keys[0]!.cx, cy: keys[0]!.cy, ...(keys.length > 1 && { follow: keys }) }] }), detail: { clip: p.clip.id } });
    }
  }

  // ---- excessive crop motion (advisory): follow keys travelling > 1.5 frame widths per minute in a clip
  for (const p of placed) {
    const a = analyses.get(p.clip.src), f = p.clip.follow;
    if (!a || !f || f.length < 2) continue;
    const cw = Math.min(1, (a.asset.h * tl.settings.w) / tl.settings.h / a.asset.w);
    const travel = f.slice(1).reduce((s, k, i) => s + (k.t - f[i]!.t > 0.05 ? Math.abs(k.cx - f[i]!.cx) * (1 - cw) : 0), 0);
    const perMin = (travel / Math.max(1, p.clip.out - p.clip.in)) * 60;
    if (perMin > 1.5) add({ code: 'excessive-crop-motion', class: 'advisory', msg: `clip ${p.clip.id}: the crop travels ${r2(perMin)} frame widths/min`, evidence: [`${f.length} follow keys`], at: [r2(p.start), r2(p.start + p.dur)] });
  }

  // ---- b-roll: hides a gesture (advisory), unmotivated by what is said (advisory)
  for (const b of tl.broll) {
    const t = at(b.ref);
    if (t === undefined) continue;
    for (const p of placed.filter((q) => q.start < t + b.d && q.start + q.dur > t)) {
      const gest = analyses.get(p.clip.src)?.observed.gestures ?? [];
      const src0 = p.clip.in + (Math.max(t, p.start) - p.start) * p.clip.speed, src1 = p.clip.in + (Math.min(t + b.d, p.start + p.dur) - p.start) * p.clip.speed;
      const hidden = gest.filter((x) => x.score >= 0.7 && x.t >= src0 && x.t <= src1);
      if (hidden.length) add({ code: 'broll-hides-gesture', class: 'advisory', msg: `b-roll ${b.id} covers ${hidden.length} deliberate gesture(s) (${[...new Set(hidden.map((x) => x.label))].join(', ')})`, evidence: hidden.slice(0, 3).map((x) => `${x.label} at source ${r2(x.t)} s (${r2(x.score)})`), at: [r2(t), r2(t + b.d)] });
    }
    const terms = (o.assetTerms?.get(b.src) ?? []).flatMap((x) => norm(x).split(' ')).filter((x) => x.length > 2 && !STOP.has(x));
    if (terms.length) {
      const said = spoken(t - 2, t + b.d + 1);
      if (!terms.some((x) => said.includes(x.replace(/s$/, '')))) add({ code: 'unmotivated-broll', class: 'advisory', msg: `b-roll ${b.id} (${terms.slice(0, 4).join(', ')}) matches nothing said around it`, evidence: [`speech ${r2(t - 2)}–${r2(t + b.d + 1)} s: "${said.slice(0, 80)}"`], at: [r2(t), r2(t + b.d)] });
    }
  }

  // ---- graphics: a figure that is not said nearby (advisory)
  for (const g of tl.gfx) {
    const t = at(g.ref), v = g.props?.value;
    if (t === undefined || v === undefined) continue;
    const said = spoken(t - 4, t + g.d + 2).replace(/\s+/g, ''), val = norm(String(v)).replace(/\s+/g, '');
    if (val && !said.includes(val.replace(/%$/, ''))) add({ code: 'irrelevant-graphic', class: 'advisory', msg: `graphic ${g.id} shows "${v}" but that figure is not said within 4 s`, evidence: [`speech near ${r2(t)} s`], at: [r2(t), r2(t + g.d)] });
  }

  // ---- SFX without a visual cause (advisory): not within 0.3 s of a cut, graphic, zoom or b-roll start
  const events = [...placed.slice(1).map((p) => p.start), ...tl.gfx.map((g) => at(g.ref)), ...tl.broll.map((b) => at(b.ref)), ...placed.flatMap((p) => p.clip.zoom.map((z) => p.start + (z.s - p.clip.in) / p.clip.speed))].filter((x): x is number => x !== undefined);
  const loose = tl.sfx.filter((s) => { const t = at(s.ref); return t !== undefined && !events.some((e) => Math.abs(e - t) <= 0.3); });
  if (loose.length) add({ code: 'unmotivated-sfx', class: 'advisory', msg: `${loose.length} sound effect(s) do not coincide with any cut, graphic, zoom or b-roll`, evidence: loose.slice(0, 4).map((s) => `${s.kind} at ${r2(at(s.ref)!)} s`) });

  // ---- density, repetition and pacing (advisory, or preference when the user asked for it)
  const zooms = placed.reduce((n, p) => n + p.clip.zoom.length, 0), trans = placed.filter((p) => p.clip.trans).length;
  const fxCount = zooms + trans + tl.gfx.length + tl.sfx.length + tl.broll.length, perMin = dur > 0 ? (fxCount / dur) * 60 : 0, lim = c.maxEffectsPerMinute ?? 12;
  if (dur >= 15 && perMin > lim) add({ code: 'effects-density', class: c.maxEffectsPerMinute === undefined && (c.zooms === true || c.transitions === true || c.graphics === true) ? 'preference' : c.maxEffectsPerMinute !== undefined ? 'objective' : 'advisory', msg: `${fxCount} effects in ${r2(dur)} s (${r2(perMin)}/min; limit ${lim}/min)`, evidence: [`zooms ${zooms}, transitions ${trans}, graphics ${tl.gfx.length}, sfx ${tl.sfx.length}, b-roll ${tl.broll.length}`] });
  const types = placed.filter((p) => p.clip.trans).map((p) => p.clip.trans!.type);
  if (types.length >= 4 && new Set(types).size === 1 && types[0] !== 'cut') add({ code: 'repetitive-pattern', class: c.transitions === true ? 'preference' : 'advisory', msg: `every transition is "${types[0]}" (${types.length}×): a uniform effect reads as a template`, evidence: [`${types.length} transitions`] });
  const presets = tl.gfx.map((g) => [at(g.ref) ?? 0, g.preset] as const).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  for (let i = 0; i + 2 < presets.length; i++) if (presets[i] === presets[i + 1] && presets[i] === presets[i + 2]) { add({ code: 'repetitive-pattern', class: 'advisory', msg: `three consecutive "${presets[i]}" graphics`, evidence: [presets.join(', ')] }); break; }
  const zt = placed.flatMap((p) => p.clip.zoom.map((z) => p.start + (z.s - p.clip.in) / p.clip.speed)).sort((x, y) => x - y), gaps = zt.slice(1).map((t, i) => t - zt[i]!);
  if (gaps.length >= 4) { const m = gaps.reduce((s, x) => s + x, 0) / gaps.length, sd = Math.sqrt(gaps.reduce((s, x) => s + (x - m) ** 2, 0) / gaps.length); if (sd < 0.15 * m) add({ code: 'repetitive-pattern', class: c.zooms === true ? 'preference' : 'advisory', msg: `zooms every ${r2(m)} s like clockwork (sd ${r2(sd)} s): motivate them by content`, evidence: [`${zt.length} zooms`] }); }
  const changes = [0, ...placed.slice(1).map((p) => p.start), ...zt, ...tl.gfx.map((g) => at(g.ref) ?? 0), ...tl.broll.flatMap((b) => { const t = at(b.ref) ?? 0; return [t, t + b.d]; }), dur].sort((x, y) => x - y);
  const still = changes.slice(1).map((t, i) => [changes[i]!, t] as const).filter(([x, y]) => y - x > (tl.settings.h > tl.settings.w ? 12 : 20));
  if (still.length && dur <= 180) add({ code: 'static-stretch', class: 'advisory', msg: `${still.length} stretch(es) with no visual change longer than ${tl.settings.h > tl.settings.w ? 12 : 20} s`, evidence: still.map(([x, y]) => `${r2(x)}–${r2(y)} s`), at: [r2(still[0]![0]), r2(still[0]![1])] });
  const shotLen = placed.length > 3 ? dur / placed.length : Infinity;
  if (shotLen < 1.2 && words.length / Math.max(1, dur) > 1.5) add({ code: 'frantic-pacing', class: 'advisory', msg: `average clip length ${r2(shotLen)} s under continuous speech`, evidence: [`${placed.length} clips in ${r2(dur)} s`] });

  // ---- typography and colour coherence (advisory)
  const fonts = new Set([tl.captions.style !== 'none' ? tl.captions.font ?? 'default' : undefined, ...tl.gfx.map((g) => g.props?.font as string | undefined)].filter(Boolean));
  if (fonts.size > 2) add({ code: 'typography-inconsistent', class: 'advisory', msg: `${fonts.size} type families on screen (${[...fonts].join(', ')}); two read as a system`, evidence: [...fonts].map(String) });
  const accents = new Set([tl.captions.style !== 'none' ? tl.captions.accent : undefined, ...tl.gfx.map((g) => g.props?.accent as string | undefined)].filter(Boolean).map((x) => String(x).toLowerCase()));
  if (accents.size > 3) add({ code: 'typography-inconsistent', class: 'advisory', msg: `${accents.size} accent colours`, evidence: [...accents] });

  // ---- explicit requirements (objective)
  const req = (ok: boolean, what: string, fixOps?: Record<string, unknown>[]) => { if (!ok) add({ code: 'unfulfilled-requirement', class: 'objective', msg: what, evidence: ['production constraints'], ...(fixOps && { fixOps }) }); };
  if (c.target !== undefined) req(dur <= c.target + 1.5, `length ${r2(dur)} s exceeds the requested ${c.target} s`);
  if (c.ratio) req(tl.settings.ratio === c.ratio, `ratio ${tl.settings.ratio} but ${c.ratio} was requested`, [{ op: 'format', ratio: c.ratio }]);
  if (c.captions === true) req(tl.captions.style !== 'none', 'captions were requested but none are burned in', [{ op: 'captions', pos: 'lower' }]);
  if (c.captions === false) req(tl.captions.style === 'none', 'captions were declined but are burned in', [{ op: 'captions', style: 'none' }]);
  if (c.zooms === false) req(zooms === 0 && !placed.some((p) => (p.clip.fx ?? []).some((e) => e.type === 'kf')), 'zooms were declined but the edit zooms');
  if (c.graphics === false) req(tl.gfx.length === 0, `graphics were declined but ${tl.gfx.length} are present`, tl.gfx.map((g) => ({ op: 'remove', id: g.id })));
  if (c.transitions === false) req(trans === 0, `transitions were declined but ${trans} are present`);
  if (c.music) req(!!tl.music, `music "${c.music}" was requested but there is none`);
  for (const [k0, k1] of c.keep ?? []) req(placed.some((p) => p.clip.in <= k0 + 0.2 && p.clip.out >= k1 - 0.2), `must-keep range ${k0}–${k1} s is not fully in the edit`);
  for (const [v0, v1] of c.avoid ?? []) req(!placed.some((p) => p.clip.in < v1 - 0.2 && p.clip.out > v0 + 0.2), `range ${v0}–${v1} s was to be avoided but is in the edit`);
  const look = (g?: { saturation?: number; lut?: string; curves?: unknown; temp?: number; tint?: number; vignette?: number }) => !!g && (g.lut !== undefined || g.curves !== undefined || (g.saturation !== undefined && g.saturation !== 1) || !!g.temp || !!g.tint || !!g.vignette);
  // Authorization applies to automated (production) edits: a look the user applied by hand is their instruction.
  if (o.constraints && !c.allowLook && (look(tl.color) || tl.clips.some((x) => look(x.color)))) add({ code: 'unauthorized-look', class: 'objective', msg: 'a colour look (LUT, curves, saturation, temperature, tint or vignette) is applied without authorization', evidence: ['constraints.allowLook is not set'], fixOps: [...(look(tl.color) ? [{ op: 'color', clear: true }] : []), ...tl.clips.filter((x) => look(x.color)).map((x) => ({ op: 'color', clip: x.id, clear: true }))] });
  if (o.constraints && !c.allowBackgroundChange && tl.clips.some((x) => (x.fx ?? []).some((e) => e.type === 'chromakey' || e.type === 'mask'))) add({ code: 'unauthorized-background', class: 'objective', msg: 'a chroma key or mask changes the background without authorization', evidence: ['constraints.allowBackgroundChange is not set'] });

  // ---- audio balance from the rendered preview (objective, measured): music in pauses vs speech level
  if (o.renderedPath && tl.music && words.length >= 10) {
    const env = await audioEnvelope(o.ffmpeg ?? 'ffmpeg', o.renderedPath, 0.1, dur + 1);
    const inSpeech = (t: number) => words.some((w) => t >= w.s && t <= w.e);
    const sp = env.filter((_, i) => inSpeech(i * 0.1 + 0.05)), gap = env.filter((_, i) => !words.some((w) => i * 0.1 + 0.05 >= w.s - 0.3 && i * 0.1 + 0.05 <= w.e + 0.3));
    if (sp.length > 20 && gap.length > 10) {
      const s = median(sp), g = median(gap);
      if (g > s - 6) add({ code: 'music-masks-speech', class: 'objective', msg: `music between phrases (${r2(g)} dBFS) is within 6 dB of speech (${r2(s)} dBFS): speech will be hard to follow`, evidence: [`median RMS over ${sp.length} speech / ${gap.length} pause windows of the preview`], fixOps: [{ op: 'music', src: tl.music.src, vol: r2(Math.max(0.05, (tl.music.vol ?? 0.3) * 0.5)), duck: true, fade: tl.music.fade }] });
    }
  }

  const n = (k: EditorialClass) => out.filter((f) => f.class === k).length;
  return { findings: out, summary: { objective: n('objective'), advisory: n('advisory'), preference: n('preference'), note: 'No objective defects is not proof of creative quality: advisories and human review still apply.' } };
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)]! : 0; };

