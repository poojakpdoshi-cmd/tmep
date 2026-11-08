/**
 * Motion-graphics preset library. Each preset compiles a small props object into ASS
 * events, so an agent selects `{preset:"icons", props:{items:[...]}}` instead of writing
 * hundreds of lines of animation code. Layouts adapt to 9:16, 1:1, 4:5 and 16:9 and keep
 * clear of the caption band and short-form UI safe zones.
 */
import { AssDoc, tagColor, tagAlpha, escapeText, ms } from './ass.ts';
import { ICONS, iconFor } from './icons.ts';
import { rrect, rect, circle } from './icons.ts';
import { TmepError } from '../../core/src/index.ts';

export interface PresetCtx {
  doc: AssDoc;
  t0: number;
  d: number;
  props: Record<string, unknown>;
  accent: string;
  /** style names */
  heavy: string;
  bold: string;
  draw: string;
}

interface PresetDef {
  desc: string;
  props: string;
  defaultDur: number;
  render: (c: PresetCtx) => void;
}

const W = (c: PresetCtx) => c.doc.w;
const H = (c: PresetCtx) => c.doc.h;
const portrait = (c: PresetCtx) => H(c) > W(c) * 1.2;
const unit = (c: PresetCtx) => Math.min(W(c), H(c));
const i = Math.round;
const str = (v: unknown, fallback = ''): string => (v === undefined || v === null ? fallback : String(v));

/** Scale pop: 0 -> overshoot -> 100% of `to`. */
function pop(to = 100, delay = 0, dur = 0.26): string {
  const a = ms(delay);
  const b = ms(delay + dur * 0.65);
  const e = ms(delay + dur);
  return `\\fscx0\\fscy0\\t(${a},${b},0.6,\\fscx${i(to * 1.1)}\\fscy${i(to * 1.1)})\\t(${b},${e},\\fscx${to}\\fscy${to})`;
}

const fade = (inS: number, outS: number) => `\\fad(${ms(inS)},${ms(outS)})`;
const textW = (s: string, size: number, upper = true) => s.length * size * (upper ? 0.64 : 0.56);

/**
 * libass aligns vector drawings against a box anchored at the drawing origin, so shapes
 * with negative coordinates end up off-centre. Translate every shape so its bounding box
 * starts at (0,0); then \\an5 centres it and \\fscx/\\fscy pops scale around its middle.
 */
export function normalizeShape(shape: string): string {
  const nums = [...shape.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  let minX = Infinity;
  let minY = Infinity;
  for (let k = 0; k + 1 < nums.length; k += 2) {
    minX = Math.min(minX, nums[k]!);
    minY = Math.min(minY, nums[k + 1]!);
  }
  if (!Number.isFinite(minX)) return shape;
  let idx = 0;
  return shape.replace(/-?\d+(?:\.\d+)?/g, (m) => {
    const v = Number(m) - (idx++ % 2 === 0 ? minX : minY);
    return String(Math.round(v * 10) / 10);
  });
}

function drawEvent(c: PresetCtx, start: number, end: number, tags: string, shape: string, layer = 3): void {
  c.doc.add({ start, end, style: c.draw, text: `{${tags}\\p1}${normalizeShape(shape)}{\\p0}`, layer });
}

function textEvent(c: PresetCtx, style: string, start: number, end: number, tags: string, text: string, layer = 4): void {
  c.doc.add({ start, end, style, text: `{${tags}}${escapeText(text)}`, layer });
}

const PRESETS: Record<string, PresetDef> = {
  title: {
    desc: 'Hook/title text at the top with accent underline wipe',
    props: 'text, sub?',
    defaultDur: 2.8,
    render: (c) => {
      const text = str(c.props.text).toUpperCase();
      if (!text) throw new TmepError('E_INPUT', 'title needs props.text');
      const size = i(unit(c) * (portrait(c) ? 0.088 : 0.075));
      const y = i(H(c) * (portrait(c) ? 0.16 : 0.14));
      const words = text.split(/\s+/);
      const maxChars = portrait(c) ? 16 : 30;
      let lines = [text];
      if (text.length > maxChars && words.length > 1) {
        const mid = Math.ceil(words.length / 2);
        lines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
      }
      const end = c.t0 + c.d;
      const x = i(W(c) / 2);
      textEvent(c, c.heavy, c.t0, end, `\\an5\\move(${x},${y - 36},${x},${y},0,${ms(0.32)})${fade(0.2, 0.25)}\\fs${size}\\bord${i(size * 0.08)}\\shad${i(size * 0.05)}`, lines.join('\n'));
      const barW = i(Math.min(W(c) * 0.5, textW(lines[0]!, size) * 0.6));
      const by = y + i(size * (lines.length === 2 ? 1.25 : 0.75));
      const x0 = x - i(barW / 2);
      drawEvent(c, c.t0 + 0.12, end, `\\an7\\pos(${x0},${by})\\1c${tagColor(c.accent)}\\bord0\\shad0\\clip(${x0},0,${x0},${H(c)})\\t(0,${ms(0.35)},0.5,\\clip(${x0},0,${x0 + barW},${H(c)}))${fade(0, 0.25)}`, rect(0, 0, barW, i(size * 0.14)));
      const sub = str(c.props.sub);
      if (sub) textEvent(c, c.bold, c.t0 + 0.25, end, `\\an5\\pos(${x},${by + i(size * 0.75)})${fade(0.25, 0.25)}\\fs${i(size * 0.48)}\\bord${i(size * 0.05)}`, sub);
    },
  },
  lower_third: {
    desc: 'Name/role plate sliding in from the left',
    props: 'name, role?',
    defaultDur: 4,
    render: (c) => {
      const name = str(c.props.name);
      if (!name) throw new TmepError('E_INPUT', 'lower_third needs props.name');
      const role = str(c.props.role);
      const size = i(unit(c) * 0.055);
      const x = i(W(c) * 0.07);
      const y = i(H(c) * (portrait(c) ? 0.58 : 0.6));
      const w = i(Math.max(textW(name, size, false), textW(role, size * 0.62, false)) + size * 1.4);
      const h = i(role ? size * 2.3 : size * 1.5);
      const end = c.t0 + c.d;
      const slide = `\\move(${x - 70},${y},${x},${y},0,${ms(0.32)})`;
      drawEvent(c, c.t0, end, `\\an7${slide}\\1c&H151515&\\1a${tagAlpha(0.85)}\\bord0\\shad0${fade(0.18, 0.25)}`, rrect(0, 0, w, h, i(size * 0.3)), 3);
      drawEvent(c, c.t0, end, `\\an7${slide}\\1c${tagColor(c.accent)}\\bord0\\shad0${fade(0.18, 0.25)}`, rrect(0, 0, i(size * 0.22), h, i(size * 0.1)), 4);
      const tx = x + i(size * 0.6);
      textEvent(c, c.heavy, c.t0 + 0.1, end, `\\an4\\move(${tx - 70},${y + i(role ? h * 0.32 : h / 2)},${tx},${y + i(role ? h * 0.32 : h / 2)},0,${ms(0.32)})\\fs${size}\\bord0\\shad0${fade(0.2, 0.25)}`, name);
      if (role) textEvent(c, c.bold, c.t0 + 0.2, end, `\\an4\\move(${tx - 70},${y + i(h * 0.72)},${tx},${y + i(h * 0.72)},0,${ms(0.32)})\\fs${i(size * 0.62)}\\1c${tagColor(c.accent)}\\bord0\\shad0${fade(0.2, 0.25)}`, role);
    },
  },
  icons: {
    desc: 'Icon cards that pop in one by one (lists, enumerations)',
    props: 'items:[{label, icon?, at?(s from start)}]',
    defaultDur: 3.5,
    render: (c) => {
      const items = (Array.isArray(c.props.items) ? c.props.items : []) as Record<string, unknown>[];
      if (!items.length) throw new TmepError('E_INPUT', 'icons needs props.items[]');
      const n = Math.min(items.length, 6);
      const cols = n <= 3 ? n : n === 4 ? 2 : 3;
      const rows = Math.ceil(n / cols);
      const card = i(Math.min((W(c) * 0.86) / cols, (H(c) * (portrait(c) ? 0.36 : 0.5)) / rows) * 0.9);
      const gap = i(card * 0.11);
      const cy = H(c) * (portrait(c) ? 0.38 : 0.42);
      const totalW = cols * card + (cols - 1) * gap;
      const totalH = rows * card + (rows - 1) * gap;
      const end = c.t0 + c.d;
      items.slice(0, n).forEach((it, k) => {
        const col = k % cols;
        const row = Math.floor(k / cols);
        const rowCount = row === rows - 1 ? n - row * cols : cols;
        const rowW = rowCount * card + (rowCount - 1) * gap;
        const x = i(W(c) / 2 - rowW / 2 + col * (card + gap) + card / 2 - (rowCount === cols ? 0 : 0));
        const y = i(cy - totalH / 2 + row * (card + gap) + card / 2);
        void totalW;
        const at = Math.min(Math.max(0, Number(it.at ?? k * 0.35)), c.d - 0.3);
        const s = c.t0 + at;
        const label = str(it.label).toUpperCase().slice(0, 14);
        const iconName = str(it.icon) || iconFor(str(it.label)) || 'sparkle';
        const shape = ICONS[iconName] ?? ICONS.sparkle!;
        drawEvent(c, s, end, `\\an5\\pos(${x},${y})\\1c&H14110F&\\1a${tagAlpha(0.8)}\\bord0\\shad0${pop(100, 0, 0.3)}${fade(0, 0.22)}`, rrect(-card / 2, -card / 2, card / 2, card / 2, card * 0.16), 3);
        const iconScale = i(card * 0.0046 * 100);
        drawEvent(c, s + 0.05, end, `\\an5\\pos(${x},${y - i(card * 0.1)})\\1c${tagColor(c.accent)}\\bord0\\shad0${pop(iconScale, 0, 0.3)}${fade(0, 0.22)}`, shape, 4);
        const fs = i(Math.min(card * 0.15, (card * 0.9) / Math.max(1, label.length * 0.62)));
        textEvent(c, c.heavy, s + 0.12, end, `\\an5\\pos(${x},${y + i(card * 0.33)})\\fs${fs}\\bord0\\shad0${fade(0.12, 0.22)}`, label, 5);
      });
    },
  },
  stat: {
    desc: 'Big animated number with count-up and burst (e.g. "90%", "3x", "$5M")',
    props: 'value, label?',
    defaultDur: 2.4,
    render: (c) => {
      const value = str(c.props.value);
      if (!value) throw new TmepError('E_INPUT', 'stat needs props.value');
      const m = /^([^\d-]*)(-?\d[\d,]*(?:\.\d+)?)(.*)$/.exec(value);
      const size = i(unit(c) * (value.length > 5 ? 0.17 : 0.22));
      const x = i(W(c) / 2);
      const y = i(H(c) * (portrait(c) ? 0.37 : 0.42));
      const end = c.t0 + c.d;
      const acc = tagColor(c.accent);
      drawEvent(c, c.t0, c.t0 + 0.6, `\\an5\\pos(${x},${y})\\1c${acc}\\bord0\\shad0\\fscx40\\fscy40\\1a&H40&\\t(0,${ms(0.55)},0.5,\\fscx150\\fscy150\\1a&HFF&)`, `${circle(0, 0, size * 0.9)} ${circle(0, 0, size * 0.8, true)}`, 2);
      const style = `\\an5\\pos(${x},${y})\\fs${size}\\1c${acc}\\bord${i(size * 0.06)}\\shad${i(size * 0.04)}`;
      if (m) {
        const target = parseFloat(m[2]!.replace(/,/g, ''));
        const decimals = (m[2]!.split('.')[1] ?? '').length;
        const steps = 10;
        const countDur = Math.min(0.6, c.d * 0.4);
        for (let k = 0; k < steps; k++) {
          const v = (target * (k + 1)) / steps;
          const shown = `${m[1]}${v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${m[3]}`;
          const s = c.t0 + (k * countDur) / steps;
          const e = k === steps - 1 ? end : c.t0 + ((k + 1) * countDur) / steps;
          textEvent(c, c.heavy, s, e, `${style}${k === 0 ? `\\fscx70\\fscy70\\t(0,${ms(countDur)},0.5,\\fscx100\\fscy100)` : ''}${k === steps - 1 ? `\\t(0,${ms(0.12)},\\fscx108\\fscy108)\\t(${ms(0.12)},${ms(0.24)},\\fscx100\\fscy100)${fade(0, 0.25)}` : ''}`, shown, 4);
        }
      } else textEvent(c, c.heavy, c.t0, end, `${style}${pop()}${fade(0, 0.25)}`, value, 4);
      const label = str(c.props.label);
      if (label) textEvent(c, c.bold, c.t0 + 0.3, end, `\\an5\\pos(${x},${y + i(size * 0.78)})\\fs${i(size * 0.3)}\\bord${i(size * 0.03)}${fade(0.2, 0.25)}`, label.toUpperCase(), 4);
    },
  },
  badge: {
    desc: 'Numbered step badge with optional text ("Step 1")',
    props: 'n, text?',
    defaultDur: 2.2,
    render: (c) => {
      const n = str(c.props.n, '1');
      const size = i(unit(c) * 0.15);
      const x = i(W(c) / 2);
      const y = i(H(c) * (portrait(c) ? 0.3 : 0.32));
      const end = c.t0 + c.d;
      drawEvent(c, c.t0, end, `\\an5\\pos(${x},${y})\\1c${tagColor(c.accent)}\\bord0\\shad${i(size * 0.03)}${pop()}${fade(0, 0.22)}`, circle(0, 0, size / 2), 3);
      textEvent(c, c.heavy, c.t0 + 0.06, end, `\\an5\\pos(${x},${y})\\fs${i(size * 0.55)}\\1c&H141414&\\bord0\\shad0${pop()}${fade(0, 0.22)}`, n, 4);
      const text = str(c.props.text);
      if (text) textEvent(c, c.heavy, c.t0 + 0.2, end, `\\an5\\pos(${x},${y + i(size * 0.85)})\\fs${i(size * 0.32)}\\bord${i(size * 0.03)}${fade(0.18, 0.22)}`, text.toUpperCase(), 4);
    },
  },
  bars: {
    desc: 'Animated bar chart',
    props: 'bars:[{label, value}], title?, unit?',
    defaultDur: 4,
    render: (c) => {
      const bars = (Array.isArray(c.props.bars) ? c.props.bars : []) as Record<string, unknown>[];
      if (!bars.length) throw new TmepError('E_INPUT', 'bars needs props.bars[]');
      const n = Math.min(bars.length, 6);
      const max = Math.max(...bars.slice(0, n).map((b) => Number(b.value) || 0), 1e-9);
      const areaW = W(c) * (portrait(c) ? 0.78 : 0.6);
      const areaH = H(c) * (portrait(c) ? 0.2 : 0.38);
      const base = i(H(c) * (portrait(c) ? 0.5 : 0.7));
      const x0 = W(c) / 2 - areaW / 2;
      const slot = areaW / n;
      const bw = i(slot * 0.62);
      const fs = i(Math.min(slot * 0.2, unit(c) * 0.04));
      const end = c.t0 + c.d;
      const pad = i(fs * 1.6);
      drawEvent(c, c.t0, end, `\\an7\\pos(${i(x0 - pad)},${i(base - areaH - pad * 2.4)})\\1c&H14110F&\\1a${tagAlpha(0.72)}\\bord0\\shad0${fade(0.2, 0.25)}`, rrect(0, 0, i(areaW + pad * 2), i(areaH + pad * 4.4), i(pad * 0.6)), 2);
      const title = str(c.props.title);
      if (title) textEvent(c, c.heavy, c.t0, end, `\\an5\\pos(${i(W(c) / 2)},${i(base - areaH - pad * 1.4)})\\fs${i(fs * 1.25)}\\bord0\\shad0${fade(0.2, 0.25)}`, title.toUpperCase(), 4);
      const unitS = str(c.props.unit);
      bars.slice(0, n).forEach((b, k) => {
        const v = Number(b.value) || 0;
        const h = Math.max(4, i((v / max) * areaH * (title ? 0.82 : 1)));
        const cx = i(x0 + slot * (k + 0.5));
        const s = c.t0 + 0.15 + k * 0.12;
        drawEvent(c, s, end, `\\an2\\pos(${cx},${base})\\1c${tagColor(c.accent)}\\bord0\\shad0\\fscy0\\t(0,${ms(0.5)},0.5,\\fscy100)${fade(0, 0.25)}`, rect(-bw / 2, -h, bw / 2, 0), 3);
        textEvent(c, c.bold, s + 0.4, end, `\\an2\\pos(${cx},${base - h - i(fs * 0.3)})\\fs${fs}\\bord0\\shad0${fade(0.15, 0.25)}`, `${v}${unitS}`, 4);
        textEvent(c, c.bold, s, end, `\\an8\\pos(${cx},${base + i(fs * 0.4)})\\fs${i(fs * 0.85)}\\bord0\\shad0${fade(0.15, 0.25)}`, str(b.label).toUpperCase().slice(0, 10), 4);
      });
    },
  },
  progress: {
    desc: 'Thin progress bar across the top for the whole range',
    props: 'color?',
    defaultDur: 10,
    render: (c) => {
      const h = Math.max(6, i(H(c) * 0.006));
      const col = tagColor(str(c.props.color, c.accent));
      drawEvent(c, c.t0, c.t0 + c.d, `\\an7\\pos(0,0)\\1c${col}\\bord0\\shad0\\clip(0,0,0,${h})\\t(0,${ms(c.d)},\\clip(0,0,${W(c)},${h}))`, rect(0, 0, W(c), h), 6);
    },
  },
  cta: {
    desc: 'Call-to-action pill ("Follow for more") with pulse',
    props: 'text?, icon?',
    defaultDur: 2.6,
    render: (c) => {
      const text = str(c.props.text, 'Follow for more').toUpperCase();
      const size = i(unit(c) * 0.05);
      const w = i(textW(text, size) + size * (c.props.icon ? 3 : 1.8));
      const h = i(size * 1.9);
      const x = i(W(c) / 2);
      const y = i(H(c) * (portrait(c) ? 0.56 : 0.62));
      const end = c.t0 + c.d;
      const pulse = `\\t(${ms(0.6)},${ms(0.8)},\\fscx106\\fscy106)\\t(${ms(0.8)},${ms(1.0)},\\fscx100\\fscy100)`;
      drawEvent(c, c.t0, end, `\\an5\\pos(${x},${y})\\1c${tagColor(c.accent)}\\bord0\\shad${i(size * 0.08)}${pop()}${pulse}${fade(0, 0.25)}`, rrect(-w / 2, -h / 2, w / 2, h / 2, h / 2), 3);
      const icon = c.props.icon ? ICONS[str(c.props.icon)] : undefined;
      const tx = icon ? x + i(size * 0.6) : x;
      textEvent(c, c.heavy, c.t0 + 0.08, end, `\\an5\\pos(${tx},${y})\\fs${size}\\1c&H141414&\\bord0\\shad0${pop()}${pulse}${fade(0, 0.25)}`, text, 4);
      if (icon) drawEvent(c, c.t0 + 0.08, end, `\\an5\\pos(${x - i(w / 2) + i(size * 1.1)},${y})\\1c&H141414&\\bord0\\shad0${pop(i(size * 0.9))}${fade(0, 0.25)}`, icon, 4);
    },
  },
  keyword: {
    desc: 'Big emphasised keyword in the centre',
    props: 'text',
    defaultDur: 1.6,
    render: (c) => {
      const text = str(c.props.text).toUpperCase();
      if (!text) throw new TmepError('E_INPUT', 'keyword needs props.text');
      const size = i(unit(c) * Math.min(0.14, 1.1 / Math.max(6, text.length)));
      textEvent(c, c.heavy, c.t0, c.t0 + c.d, `\\an5\\pos(${i(W(c) / 2)},${i(H(c) * 0.4)})\\fs${size}\\1c${tagColor(c.accent)}\\bord${i(size * 0.09)}\\shad${i(size * 0.05)}\\frz3${pop()}${fade(0, 0.2)}`, text, 5);
    },
  },
  icon: {
    desc: 'Single large icon popping in (optional label)',
    props: 'icon, label?',
    defaultDur: 1.8,
    render: (c) => {
      const name = str(c.props.icon) || iconFor(str(c.props.label)) || 'sparkle';
      const shape = ICONS[name];
      if (!shape) throw new TmepError('E_INPUT', `unknown icon "${name}"`, `icons: ${Object.keys(ICONS).join(',')}`);
      const sz = i(unit(c) * 0.26);
      const x = i(W(c) / 2);
      const y = i(H(c) * (portrait(c) ? 0.36 : 0.4));
      const end = c.t0 + c.d;
      drawEvent(c, c.t0, end, `\\an5\\pos(${x},${y})\\1c&H14110F&\\1a${tagAlpha(0.75)}\\bord0\\shad0${pop()}${fade(0, 0.2)}`, circle(0, 0, sz * 0.72), 3);
      drawEvent(c, c.t0 + 0.05, end, `\\an5\\pos(${x},${y})\\1c${tagColor(c.accent)}\\bord0\\shad0${pop(i(sz))}${fade(0, 0.2)}`, shape, 4);
      const label = str(c.props.label);
      if (label) textEvent(c, c.heavy, c.t0 + 0.15, end, `\\an5\\pos(${x},${y + i(sz * 0.95)})\\fs${i(sz * 0.2)}\\bord${i(sz * 0.02)}${fade(0.15, 0.2)}`, label.toUpperCase(), 4);
    },
  },
  flash: {
    desc: 'Quick full-frame flash (accent for cuts/transitions)',
    props: 'color?',
    defaultDur: 0.25,
    render: (c) => {
      const half = ms(c.d / 2);
      drawEvent(c, c.t0, c.t0 + c.d, `\\an7\\pos(0,0)\\1c${tagColor(str(c.props.color, '#FFFFFF'))}\\bord0\\shad0\\1a&HFF&\\t(0,${half},\\1a&H30&)\\t(${half},${ms(c.d)},\\1a&HFF&)`, rect(0, 0, W(c), H(c)), 8);
    },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

export function presetCatalog(): Record<string, { desc: string; props: string; d: number }> {
  const out: Record<string, { desc: string; props: string; d: number }> = {};
  for (const [k, v] of Object.entries(PRESETS)) out[k] = { desc: v.desc, props: v.props, d: v.defaultDur };
  return out;
}

export function renderPreset(name: string, c: PresetCtx): void {
  const p = PRESETS[name];
  if (!p) throw new TmepError('E_INPUT', `unknown preset ${name}`, `presets: ${PRESET_NAMES.join(',')}`);
  p.render(c);
}

export const presetDefaultDur = (name: string): number => PRESETS[name]?.defaultDur ?? 2.5;
