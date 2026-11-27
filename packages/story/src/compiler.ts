import {
  arr, bool, num, obj, oneOf, str, union, formatIssues, TmepError,
  visualSceneSchema, type Infer, type Ratio, type VisualScene, RATIOS,
} from '../../core/src/index.ts';
import { canvasModule, wrapMeasuredText } from '../../motion/src/vector.ts';
import { resolveFont } from '../../motion/src/fonts.ts';

export type Platform = 'reels' | 'shorts' | 'tiktok' | 'youtube' | 'square' | 'default';
export type ThemeName = 'dark' | 'slate' | 'emerald' | 'light';
export type MotionProfile = 'restrained' | 'editorial' | 'dynamic';

export const PLATFORM_SAFE_ZONES: Record<Platform, { left: number; top: number; right: number; bottom: number }> = {
  reels: { left: 0.05, top: 0.08, right: 0.11, bottom: 0.21 },
  shorts: { left: 0.05, top: 0.08, right: 0.12, bottom: 0.22 },
  tiktok: { left: 0.05, top: 0.09, right: 0.12, bottom: 0.22 },
  youtube: { left: 0.05, top: 0.06, right: 0.05, bottom: 0.10 },
  square: { left: 0.05, top: 0.06, right: 0.05, bottom: 0.10 },
  default: { left: 0.05, top: 0.06, right: 0.05, bottom: 0.12 },
};

const THEMES: Record<ThemeName, { card: string; cardEnd: string; text: string; muted: string; accent: string; track: string }> = {
  dark: { card: '#0F172A', cardEnd: '#1E293B', text: '#F8FAFC', muted: '#CBD5E1', accent: '#38BDF8', track: '#FFFFFF26' },
  slate: { card: '#111827', cardEnd: '#1F2937', text: '#F9FAFB', muted: '#D1D5DB', accent: '#70DAC4', track: '#FFFFFF26' },
  emerald: { card: '#062825', cardEnd: '#0D3B36', text: '#F2F6FF', muted: '#A7F3D0', accent: '#34D399', track: '#FFFFFF26' },
  light: { card: '#F8FAFC', cardEnd: '#E2E8F0', text: '#0F172A', muted: '#334155', accent: '#2563EB', track: '#0F172A22' },
};

const color = str({ pattern: /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/ });

export const compileIntentSchema = obj({
  id: str({ min: 1, max: 48, pattern: /^[A-Za-z][\w-]*$/ }).default('comp1'),
  kind: oneOf(['explainer_card', 'product_demo', 'sports_stat', 'diagram', 'talking_head_callout'] as const),
  at: union([num({ min: 0 }), str({ min: 1, max: 160 })]).default(0),
  duration: num({ min: 0.5, max: 60 }).default(4),
  ratio: oneOf(['9:16', '16:9', '1:1', '4:5'] as const).optional(),
  platform: oneOf(['reels', 'shorts', 'tiktok', 'youtube', 'square', 'default'] as const).default('default'),
  theme: oneOf(['dark', 'slate', 'emerald', 'light'] as const).default('dark'),
  motion: oneOf(['restrained', 'editorial', 'dynamic'] as const).default('editorial'),
  z: num({ int: true, min: -100, max: 100 }).default(8),
  title: str({ min: 1, max: 140 }),
  subtitle: str({ min: 1, max: 320 }).optional(),
  badge: str({ min: 1, max: 32 }).optional(),
  asset: str({ min: 1, max: 64, pattern: /^[A-Za-z][\w-]*$/ }).optional(),
  chart: obj({
    chartType: oneOf(['bar', 'hbar', 'line', 'ring'] as const),
    data: arr(obj({ label: str({ min: 1, max: 40 }), value: num({ min: 0, max: 1e9 }), color: color.optional() }), { min: 1, max: 16 }),
    max: num({ min: 0.001, max: 1e9 }).optional(),
    unit: str({ max: 16 }).default(''),
  }).optional(),
  steps: arr(str({ min: 1, max: 80 }), { min: 2, max: 4 }).optional(),
  reservePresenter: obj({
    x: num({ min: 0, max: 1 }),
    y: num({ min: 0, max: 1 }),
    w: num({ min: 0.05, max: 1 }),
    h: num({ min: 0.05, max: 1 }),
  }).optional(),
  dryRun: bool().default(false),
});

export type CompileIntent = Infer<typeof compileIntentSchema>;

export interface CompileCorrection {
  code: 'safe-zone-clamp' | 'font-shrink' | 'presenter-avoidance' | 'caption-avoidance';
  msg: string;
}

export interface CompileResult {
  ops: { op: 'scene'; spec: VisualScene }[];
  spec: VisualScene;
  corrections: CompileCorrection[];
}

function fitFontSize(
  text: string,
  fontName: string,
  fontFile: string | undefined,
  boxW: number,
  boxH: number,
  maxSize: number,
  minSize: number,
  maxLines: number,
): { size: number; shrunk: boolean } {
  const { createCanvas, GlobalFonts } = canvasModule();
  if (fontFile) GlobalFonts.registerFromPath(fontFile, fontName);
  const ctx = createCanvas(1, 1).getContext('2d');
  for (let s = maxSize; s >= minSize; s -= 2) {
    ctx.font = `700 ${s}px "${fontName}"`;
    const lines = wrapMeasuredText(ctx, text, boxW);
    const totalH = lines.length * s * 1.22;
    if (lines.length <= maxLines && totalH <= boxH) {
      return { size: s, shrunk: s < maxSize };
    }
  }
  return { size: minSize, shrunk: true };
}

/** Deterministically compile high-level creative intent into a validated VisualScene op. */
export function compileIntent(raw: unknown, defaults: { ratio?: Ratio; captionPos?: 'lower' | 'middle' | 'upper' } = {}): CompileResult {
  const parsed = compileIntentSchema.parse(raw);
  if (!parsed.ok) {
    throw new TmepError('E_INPUT', `invalid compile intent: ${formatIssues(parsed.issues)}`);
  }
  const inp = parsed.value;
  const ratio: Ratio = inp.ratio ?? defaults.ratio ?? '9:16';
  const [W, H] = RATIOS[ratio];
  const portrait = H > W;
  const safe = PLATFORM_SAFE_ZONES[inp.platform];
  const palette = THEMES[inp.theme];
  const corrections: CompileCorrection[] = [];

  if (inp.kind === 'product_demo' && !inp.asset) {
    throw new TmepError('E_INPUT', 'product_demo requires an imported image asset id');
  }
  if (inp.kind === 'sports_stat' && !inp.chart) {
    throw new TmepError('E_INPUT', 'sports_stat requires a chart specification');
  }
  if (inp.kind === 'diagram' && (!inp.steps || inp.steps.length < 2)) {
    throw new TmepError('E_INPUT', 'diagram requires 2-4 steps');
  }

  // Available safe content box in normalized coordinates
  let availTop = safe.top + 0.02;
  let availBot = 1 - safe.bottom - 0.02;
  const availLeft = safe.left + 0.02;
  const availRight = 1 - safe.right - 0.02;

  // Avoid caption band when captions are in lower/upper/middle
  const capPos = defaults.captionPos ?? 'lower';
  if (capPos === 'lower') {
    const capTop = portrait ? 0.63 : 0.76;
    if (availBot > capTop) {
      availBot = capTop;
      corrections.push({ code: 'caption-avoidance', msg: `clamped composition bottom to ${(availBot * 100).toFixed(0)}% to clear lower captions` });
    }
  } else if (capPos === 'upper') {
    const capBot = portrait ? 0.31 : 0.24;
    if (availTop < capBot) {
      availTop = capBot;
      corrections.push({ code: 'caption-avoidance', msg: `shifted composition top to ${(availTop * 100).toFixed(0)}% to clear upper captions` });
    }
  }

  // Avoid reserved presenter region if provided
  if (inp.reservePresenter) {
    const rp = inp.reservePresenter;
    const rpTop = rp.y - rp.h / 2;
    const rpBot = rp.y + rp.h / 2;
    if (rpBot > availTop && rpTop < availBot) {
      if (rp.y >= 0.5 && rpTop - availTop >= 0.22) {
        availBot = Math.min(availBot, rpTop - 0.02);
        corrections.push({ code: 'presenter-avoidance', msg: `placed layout above reserved presenter region (y <= ${(availBot * 100).toFixed(0)}%)` });
      } else if (availBot - rpBot >= 0.22) {
        availTop = Math.max(availTop, rpBot + 0.02);
        corrections.push({ code: 'presenter-avoidance', msg: `placed layout below reserved presenter region (y >= ${(availTop * 100).toFixed(0)}%)` });
      }
    }
  }

  const boxW = Math.min(0.86, availRight - availLeft);
  const cx = (availLeft + availRight) / 2;
  const boxH = Math.max(0.22, Math.min(portrait ? 0.44 : 0.62, availBot - availTop));
  const cy = availTop + boxH / 2;

  const ease = inp.motion === 'dynamic' ? 'spring' : inp.motion === 'editorial' ? 'out' : 'io';
  const enterD = inp.motion === 'restrained' ? 0.35 : 0.45;
  const boldFont = resolveFont('bold');
  const regFont = resolveFont('regular');
  const titleFit = fitFontSize(inp.title, boldFont.name, boldFont.file, boxW * W * 0.86, boxH * H * 0.26, portrait ? 46 : 44, 22, 2);
  if (titleFit.shrunk) {
    corrections.push({ code: 'font-shrink', msg: `auto-sized title font to ${titleFit.size}px to prevent box overflow` });
  }

  const layers: Record<string, unknown>[] = [];
  const styles: Record<string, unknown>[] = [
    { id: 'titleStyle', color: palette.text, font: 'bold', size: titleFit.size },
    { id: 'bodyStyle', color: palette.muted, font: 'regular', size: Math.max(18, Math.round(titleFit.size * 0.62)) },
    { id: 'badgeStyle', color: '#0F172A', font: 'bold', size: Math.max(16, Math.round(titleFit.size * 0.48)) },
  ];

  // Base card layer
  layers.push({
    id: 'card',
    kind: 'rrect',
    x: cx,
    y: cy,
    w: boxW,
    h: boxH,
    radius: 26,
    gradient: { type: 'linear', angle: 135, stops: [{ offset: 0, color: palette.card }, { offset: 1, color: palette.cardEnd }] },
    shadow: { color: '#00000066', blur: 24, x: 0, y: 10 },
    keys: [
      { t: 0, s: inp.motion === 'restrained' ? 0.98 : 0.9, o: 0 },
      { t: Math.min(enterD, inp.duration * 0.4), s: 1, o: 1, e: ease },
    ],
  });

  // Optional badge pill
  if (inp.badge) {
    layers.push({
      id: 'badge',
      kind: 'text',
      style: 'badgeStyle',
      text: inp.badge.toUpperCase(),
      x: cx - boxW * 0.28,
      y: cy - boxH * 0.36,
      w: boxW * 0.32,
      h: boxH * 0.14,
      bg: palette.accent,
      pad: 8,
      radius: 12,
      wrap: true,
      maxLines: 1,
      ellipsis: true,
      overlap: true,
    });
  }

  // Title
  const titleY = inp.kind === 'talking_head_callout' ? cy - (inp.subtitle ? boxH * 0.16 : 0) : cy - boxH * 0.24;
  layers.push({
    id: 'title',
    kind: 'text',
    style: 'titleStyle',
    text: inp.title,
    x: cx,
    y: titleY,
    w: boxW * 0.86,
    h: boxH * 0.26,
    align: 'left',
    wrap: true,
    maxLines: 2,
    ellipsis: true,
    overlap: true,
    keys: [
      { t: 0, y: 0.02, o: 0 },
      { t: Math.min(enterD + 0.1, inp.duration * 0.5), y: 0, o: 1, e: 'out' },
    ],
  });

  if (inp.kind === 'product_demo' && inp.asset) {
    layers.push({
      id: 'media',
      kind: 'image',
      asset: inp.asset,
      x: cx,
      y: cy + boxH * 0.14,
      w: boxW * 0.84,
      h: boxH * 0.52,
      fit: 'contain',
      radius: 16,
      shadow: { color: '#00000055', blur: 16, x: 0, y: 6 },
      clip: { kind: 'rrect', radius: 16 },
      overlap: true,
    });
  } else if (inp.chart) {
    layers.push({
      id: 'chart',
      kind: 'chart',
      chartType: inp.chart.chartType,
      data: inp.chart.data,
      ...(inp.chart.max !== undefined && { max: inp.chart.max }),
      unit: inp.chart.unit ?? '',
      accent: palette.accent,
      trackColor: palette.track,
      x: cx,
      y: cy + boxH * 0.14,
      w: boxW * 0.86,
      h: boxH * 0.52,
      draw: [
        { t: 0.1, to: 0 },
        { t: Math.min(0.85, inp.duration * 0.6), to: 1, e: 'out' },
      ],
      overlap: true,
    });
  } else if (inp.kind === 'diagram' && inp.steps?.length) {
    const stepH = (boxH * 0.54) / inp.steps.length;
    inp.steps.forEach((step, idx) => {
      const sy = cy - boxH * 0.02 + idx * stepH;
      const delay = Math.min(idx * 0.22, inp.duration * 0.5);
      layers.push({
        id: `step${idx + 1}`,
        kind: 'text',
        style: 'bodyStyle',
        text: `${idx + 1}. ${step}`,
        x: cx,
        y: sy,
        w: boxW * 0.84,
        h: stepH * 0.82,
        align: 'left',
        bg: palette.track,
        pad: 10,
        radius: 12,
        wrap: true,
        maxLines: 2,
        ellipsis: true,
        overlap: true,
        keys: delay > 0.01
          ? [
              { t: 0, o: 0 },
              { t: delay, x: -0.02, o: 0 },
              { t: Math.min(delay + 0.3, inp.duration * 0.8), x: 0, o: 1, e: 'out' },
            ]
          : [
              { t: 0, x: -0.02, o: 0 },
              { t: Math.min(0.3, inp.duration * 0.8), x: 0, o: 1, e: 'out' },
            ],
      });
    });
  } else if (inp.subtitle) {
    const subFit = fitFontSize(inp.subtitle, regFont.name, regFont.file, boxW * W * 0.86, boxH * H * 0.42, Math.max(18, Math.round(titleFit.size * 0.62)), 16, 4);
    if (subFit.shrunk) {
      styles[1] = { id: 'bodyStyle', color: palette.muted, font: 'regular', size: subFit.size };
    }
    layers.push({
      id: 'body',
      kind: 'text',
      style: 'bodyStyle',
      text: inp.subtitle,
      x: cx,
      y: cy + boxH * 0.14,
      w: boxW * 0.86,
      h: boxH * 0.42,
      align: 'left',
      wrap: true,
      maxLines: 4,
      ellipsis: true,
      overlap: true,
    });
  }

  const rawSpec = {
    v: 1 as const,
    at: inp.at,
    offset: 0,
    duration: inp.duration,
    ratio,
    z: inp.z,
    safe,
    styles,
    layers,
  };
  const checked = visualSceneSchema.parse(rawSpec);
  if (!checked.ok) {
    throw new TmepError('E_INTERNAL', `compiled scene invalid: ${formatIssues(checked.issues)}`);
  }
  const spec = checked.value;
  return {
    ops: [{ op: 'scene', spec }],
    spec,
    corrections,
  };
}
