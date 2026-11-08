/**
 * Timeline -> single ASS document (captions + motion graphics), with fonts resolved.
 */
import { type Timeline, type TlWord, type Placed, layout, resolveRef, duration } from '../../core/src/index.ts';
import { AssDoc } from './ass.ts';
import { compileCaptions } from './captions.ts';
import { renderPreset } from './presets.ts';
import { resolveFont, type ResolvedFont } from './fonts.ts';
import { hasDevanagari } from '../../speech/src/hinglish.ts';

export interface CompiledAss {
  ass: string;
  fonts: ResolvedFont[];
  events: number;
  captions: number;
  gfx: number;
  skipped: string[];
}

export function compileAss(tl: Timeline, words: TlWord[], placed: Placed[] = layout(tl)): CompiledAss {
  const { w, h } = tl.settings;
  const doc = new AssDoc(w, h);
  const dur = duration(tl);
  const native = tl.captions.script !== 'latin' && words.some((x) => hasDevanagari(x.w));
  const heavy = resolveFont(tl.captions.font ?? (native ? 'devanagari' : 'heavy'));
  const bold = resolveFont('bold');
  const fonts = [heavy, bold];
  doc.style({ name: 'GfxH', font: heavy.name, bold: true, size: 80, color: '#FFFFFF', outline: '#000000', outlineW: 4, shadow: 2, align: 5 });
  doc.style({ name: 'GfxB', font: bold.name, bold: true, size: 50, color: '#FFFFFF', outline: '#000000', outlineW: 3, shadow: 1, align: 5 });
  doc.style({ name: 'Draw', font: bold.name, size: 20, color: '#FFFFFF', outlineW: 0, shadow: 0, align: 7 });
  const captions = compileCaptions(doc, words, tl.captions, heavy.name, dur);
  let gfx = 0;
  const skipped: string[] = [];
  for (const g of tl.gfx) {
    const t0 = resolveRef(placed, g.ref);
    if (t0 === undefined || t0 >= dur) {
      skipped.push(g.id);
      continue;
    }
    const before = doc.events.length;
    renderPreset(g.preset, { doc, t0, d: Math.min(g.d, dur - t0), props: g.props, accent: (g.props.accent as string) ?? tl.captions.accent, heavy: 'GfxH', bold: 'GfxB', draw: 'Draw' });
    gfx += doc.events.length - before;
  }
  return { ass: doc.toString(), fonts, events: doc.events.length, captions, gfx, skipped };
}
