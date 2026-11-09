/**
 * Timeline -> single ASS document (captions + motion graphics), with fonts resolved.
 */
import { type Timeline, type TlWord, type Placed, type Effect, layout, resolveRef, duration } from '../../core/src/index.ts';
import { AssDoc } from './ass.ts';
import { compileCaptions } from './captions.ts';
import { renderPreset } from './presets.ts';
import { resolveFont, type ResolvedFont } from './fonts.ts';
import { hasDevanagari } from '../../speech/src/hinglish.ts';

export interface GraphicLayer {
  id: string;
  /** Graphics preset start on the full timeline. */
  at: number;
  d: number;
  /** Local-time ASS document containing only this preset's events. */
  ass: string;
  fx: Effect[];
  z?: number;
}

export interface CompiledAss {
  ass: string;
  fonts: ResolvedFont[];
  events: number;
  captions: number;
  gfx: number;
  skipped: string[];
  /** Only fx-enabled graphics are isolated; legacy graphics remain in the main ASS. */
  layers: GraphicLayer[];
}

export function compileAss(tl: Timeline, words: TlWord[], placed: Placed[] = layout(tl)): CompiledAss {
  const { w, h } = tl.settings;
  const dur = duration(tl);
  const native = tl.captions.script !== 'latin' && words.some((x) => hasDevanagari(x.w));
  const heavy = resolveFont(tl.captions.font ?? (native ? 'devanagari' : 'heavy'));
  const bold = resolveFont('bold');
  const fonts = [heavy, bold];
  const newDoc = () => {
    const doc = new AssDoc(w, h);
    doc.style({ name: 'GfxH', font: heavy.name, bold: true, size: 80, color: '#FFFFFF', outline: '#000000', outlineW: 4, shadow: 2, align: 5 });
    doc.style({ name: 'GfxB', font: bold.name, bold: true, size: 50, color: '#FFFFFF', outline: '#000000', outlineW: 3, shadow: 1, align: 5 });
    doc.style({ name: 'Draw', font: bold.name, size: 20, color: '#FFFFFF', outlineW: 0, shadow: 0, align: 7 });
    return doc;
  };
  const doc = newDoc();
  const captions = compileCaptions(doc, words, tl.captions, heavy.name, dur);
  const layers: GraphicLayer[] = [];
  let gfx = 0;
  const skipped: string[] = [];
  for (const g of tl.gfx) {
    const t0 = resolveRef(placed, g.ref);
    if (t0 === undefined || t0 >= dur) {
      skipped.push(g.id);
      continue;
    }
    const d = Math.min(g.d, dur - t0);
    // An fx-enabled preset becomes its own alpha graphics overlay. Its animation
    // time is local to the preset so it can resume across cached video units.
    const isolated = !!g.fx?.length || g.z !== undefined;
    const target = isolated ? newDoc() : doc;
    const before = target.events.length;
    renderPreset(g.preset, { doc: target, t0: isolated ? 0 : t0, d, props: g.props, accent: (g.props.accent as string) ?? tl.captions.accent, heavy: 'GfxH', bold: 'GfxB', draw: 'Draw' });
    const count = target.events.length - before;
    gfx += count;
    if (isolated && count) layers.push({ id: g.id, at: t0, d, ass: target.toString(), fx: g.fx ?? [], ...(g.z !== undefined ? { z: g.z } : {}) });
  }
  return { ass: doc.toString(), fonts, events: doc.events.length, captions, gfx, skipped, layers };
}
