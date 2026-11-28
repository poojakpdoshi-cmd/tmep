/**
 * Footage-aware Inspector checks (Phase 4B). They use cached footage analyses — never new analysis —
 * and are advisory: they point at likely editorial problems with evidence, they do not block.
 *
 *  - graphics-over-presenter: a scene layer covers the presenter region while it is on screen
 *  - captions-over-presenter: the caption band covers the presenter region
 *  - crop-cuts-presenter: the output crop cuts off part of the presenter region
 *  - repetitive-zoom: more punch/zoom moves per minute than a restrained edit uses
 *  - missing-moment: a high-confidence candidate moment of a used source is not in the edit
 */
import { layout, RATIOS, type Timeline, type Effect } from '../../core/src/index.ts';
import type { FootageAnalysis, Box } from '../../media/src/footage.ts';

export interface FootageFinding { code: 'graphics-over-presenter' | 'captions-over-presenter' | 'crop-cuts-presenter' | 'repetitive-zoom' | 'missing-moment'; severity: 'advisory'; msg: string; detail?: Record<string, unknown> }

const overlapFrac = (a: Box, b: Box) => {
  const w = Math.max(0, Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2));
  const h = Math.max(0, Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2));
  return (w * h) / Math.max(1e-9, b.w * b.h);
};

/** Map a box in source-frame fractions to output-frame fractions for a cover-fit clip with crop centre (cx, cy). */
export function sourceToOutput(box: Box, src: { w: number; h: number }, out: { w: number; h: number }, cx = 0.5, cy = 0.5): Box {
  const k = Math.max(out.w / src.w, out.h / src.h);
  const sw = src.w * k, sh = src.h * k;
  const ox = (sw - out.w) * cx, oy = (sh - out.h) * cy;
  return { x: (box.x * sw - ox) / out.w, y: (box.y * sh - oy) / out.h, w: (box.w * sw) / out.w, h: (box.h * sh) / out.h };
}

export function footageFindings(tl: Timeline, analyses: Map<string, FootageAnalysis>): FootageFinding[] {
  const out: FootageFinding[] = [];
  if (!analyses.size) return out;
  const [W, H] = RATIOS[tl.settings.ratio];
  const placed = layout(tl);
  const portrait = H > W;
  const capBand: Box | undefined = tl.captions.style === 'none' ? undefined
    : tl.captions.pos === 'upper' ? { x: 0.5, y: portrait ? 0.27 : 0.18, w: 1, h: 0.12 }
    : tl.captions.pos === 'middle' ? { x: 0.5, y: 0.5, w: 1, h: 0.12 }
    : { x: 0.5, y: portrait ? 0.715 : 0.84, w: 1, h: portrait ? 0.17 : 0.14 };
  for (const p of placed) {
    const a = analyses.get(p.clip.src);
    const pres = a?.inferred.presenter;
    if (!a || !pres || pres.confidence < 0.5) continue;
    const box = sourceToOutput(pres, { w: a.asset.w, h: a.asset.h }, { w: W, h: H }, p.clip.cx, p.clip.cy);
    const visible = Math.max(0, Math.min(1, box.x + box.w / 2) - Math.max(0, box.x - box.w / 2)) * Math.max(0, Math.min(1, box.y + box.h / 2) - Math.max(0, box.y - box.h / 2)) / Math.max(1e-9, box.w * box.h);
    if (visible < 0.85) out.push({ code: 'crop-cuts-presenter', severity: 'advisory', msg: `clip ${p.clip.id}: the ${tl.settings.ratio} crop keeps ${(visible * 100).toFixed(0)}% of the presenter region; adjust reframe cx/cy`, detail: { clip: p.clip.id, presenter: box } });
    if (capBand && overlapFrac(capBand, box) > 0.2) out.push({ code: 'captions-over-presenter', severity: 'advisory', msg: `clip ${p.clip.id}: ${tl.captions.pos ?? 'lower'} captions cover ${(overlapFrac(capBand, box) * 100).toFixed(0)}% of the presenter region`, detail: { clip: p.clip.id } });
    const t0 = p.start, t1 = p.start + p.dur;
    for (const sc of tl.scenes ?? []) {
      const at = typeof sc.spec.at === 'number' ? sc.spec.at : NaN;
      if (!(at < t1 && at + sc.spec.duration > t0)) continue;
      for (const l of sc.spec.layers) {
        if (l.kind === 'video' || l.kind === 'image' && (l.w > 0.9 && l.h > 0.9)) continue;
        // Overlap relative to the smaller box: a small graphic sitting on the presenter matters as much
        // as a large one covering part of them.
        const lb = { x: l.x, y: l.y, w: l.w, h: l.h };
        const f = Math.max(overlapFrac(lb, box), overlapFrac(box, lb));
        if (f > 0.25) out.push({ code: 'graphics-over-presenter', severity: 'advisory', msg: `scene ${sc.id}/${l.id} overlaps the presenter region in clip ${p.clip.id} (${(f * 100).toFixed(0)}% of the smaller box); pass the presenter box as avoid or compile with footage`, detail: { scene: sc.id, layer: l.id, clip: p.clip.id } });
      }
    }
  }
  // Repetitive zooms: scale moves (kf keys that change s, punch/zoom presets) per minute.
  const dur = placed.reduce((m, p) => Math.max(m, p.start + p.dur), 0);
  const zoomMoves = tl.clips.reduce((n, c) => n + (c.fx ?? []).filter((e: Effect) => e.type === 'kf' && e.keys.some((k, i) => i > 0 && k.s !== undefined && Math.abs(k.s - (e.keys[i - 1]!.s ?? 1)) > 0.04)).length + (c.zoom?.length ?? 0), 0);
  const perMin = dur > 0 ? (zoomMoves / dur) * 60 : 0;
  if (dur >= 15 && perMin > 8) out.push({ code: 'repetitive-zoom', severity: 'advisory', msg: `${zoomMoves} zoom moves in ${dur.toFixed(0)} s (${perMin.toFixed(1)}/min); restrained edits rarely exceed 8/min`, detail: { zoomMoves, perMin } });
  // Missing moments: confident moments of sources used in the edit that no clip includes.
  for (const [src, a] of analyses) {
    const clips = tl.clips.filter((c) => c.src === src);
    if (!clips.length) continue;
    for (const m of a.inferred.moments) {
      if (m.confidence < 0.7) continue;
      if (!clips.some((c) => m.t >= c.in && m.t <= c.out)) out.push({ code: 'missing-moment', severity: 'advisory', msg: `${src} moment ${m.id} at ${m.t}s (${m.evidence.join('; ')}) is not in the edit`, detail: { src, moment: m.id, t: m.t, confidence: m.confidence } });
    }
  }
  return out;
}
