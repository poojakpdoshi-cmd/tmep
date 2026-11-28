/**
 * FRAME Director (Phase 6.2): turns user intent + verified footage analysis (+ an optional reference
 * style profile) into an editorial strategy (`frame.strategy/1`). Deterministic and explainable:
 * every choice cites the genre policy, a measured signal or an explicit user instruction.
 *
 * Restraint is the default: effects are budgeted per minute, graphics only carry what is said or
 * shown, captions are burned only from trustworthy timing, and nothing that changes the look or the
 * background happens unless the user asked for it. Explicit user constraints always win.
 */
import type { FootageAnalysis } from '../../media/src/footage.ts';
import type { StyleProfile } from '../../media/src/style.ts';

export const STRATEGY_SCHEMA = 'frame.strategy/1';
export const GENRES = ['informative', 'cinematic', 'sports', 'podcast', 'product', 'educational'] as const;
export type Genre = (typeof GENRES)[number];

export interface Constraints {
  /** Target output length in seconds (the rough cut is shortened to fit; never padded). */
  target?: number;
  ratio?: '9:16' | '16:9' | '1:1' | '4:5';
  captions?: boolean;
  zooms?: boolean;
  graphics?: boolean;
  transitions?: boolean;
  music?: string;
  /** Source ranges that must stay / must go (seconds). */
  keep?: [number, number][];
  avoid?: [number, number][];
  /** Colour "looks" and background replacement are off unless explicitly allowed. */
  allowLook?: boolean;
  allowBackgroundChange?: boolean;
  maxEffectsPerMinute?: number;
}
export interface Intent { genre: Genre; goal?: string; constraints?: Constraints }

export interface Strategy {
  schema: typeof STRATEGY_SCHEMA;
  genre: Genre;
  target?: number;
  ratio: string;
  pacing: { removePausesOver: number; padding: number; cutsPerMinuteGoal?: number };
  zooms: { allowed: boolean; perMinute: number; on: 'strong-moments' | 'event-candidates' | 'none' };
  jumpCuts: 'punch-alternate' | 'leave';
  graphics: { allowed: boolean; kinds: string[] };
  captions: { burn: boolean; position: 'upper' | 'lower'; reason: string };
  transitions: { allowed: boolean; kinds: string[] };
  colour: { corrective: boolean; look?: { saturation?: number; reason: string } };
  audio: { compress: boolean; music?: string };
  assets: { allowed: boolean };
  effectBudgetPerMinute: number;
  decisions: { what: string; why: string; source: 'policy' | 'footage' | 'user' | 'reference' }[];
  /** Choices left to the user or an external agent (never guessed). */
  open: string[];
}

const POLICY: Record<Genre, { pause: number; zoomPerMin: number; zoomOn: Strategy['zooms']['on']; graphics: string[]; captions: boolean; transitions: string[]; budget: number; jump: Strategy['jumpCuts']; assets: boolean; cpm?: [number, number] }> = {
  informative: { pause: 0.6, zoomPerMin: 3, zoomOn: 'strong-moments', graphics: ['stat', 'icons'], captions: true, transitions: [], budget: 6, jump: 'punch-alternate', assets: true, cpm: [6, 30] },
  educational: { pause: 0.8, zoomPerMin: 2, zoomOn: 'strong-moments', graphics: ['stat', 'icons'], captions: true, transitions: [], budget: 4, jump: 'punch-alternate', assets: true, cpm: [3, 15] },
  podcast: { pause: 1.0, zoomPerMin: 2, zoomOn: 'strong-moments', graphics: [], captions: true, transitions: [], budget: 3, jump: 'punch-alternate', assets: false, cpm: [2, 12] },
  product: { pause: 0.6, zoomPerMin: 2, zoomOn: 'strong-moments', graphics: ['callout'], captions: true, transitions: [], budget: 4, jump: 'punch-alternate', assets: true, cpm: [6, 24] },
  cinematic: { pause: 1.5, zoomPerMin: 0, zoomOn: 'none', graphics: [], captions: false, transitions: ['fade'], budget: 1, jump: 'leave', assets: false, cpm: [2, 20] },
  sports: { pause: 2.0, zoomPerMin: 4, zoomOn: 'event-candidates', graphics: [], captions: false, transitions: [], budget: 6, jump: 'leave', assets: false, cpm: [8, 40] },
};

/** Band (upper ≈ 0.12–0.32, lower ≈ 0.68–0.88 of the frame height) with fewer head collisions; lower on a tie. */
export function captionBand(a: FootageAnalysis): 'upper' | 'lower' {
  const heads: number[] = [];
  for (const tr of a.observed.tracks ?? []) if (tr.label === 'person') for (const b of tr.boxes) heads.push(b[2] + b[4] * 0.12);
  for (const f of a.observed.faces ?? []) for (const b of f.boxes) heads.push(b.y);
  if (!heads.length && a.inferred.presenter) heads.push(a.inferred.presenter.y - a.inferred.presenter.h * 0.3);
  const upper = heads.filter((y) => y >= 0.08 && y <= 0.36).length, lower = heads.filter((y) => y >= 0.64 && y <= 0.92).length;
  return upper < lower ? 'upper' : 'lower';
}

export function direct(intent: Intent, a: FootageAnalysis, words: { w: string; s: number; e: number }[], opts: { transcriptApprox?: boolean; transcriptUnverified?: string; reference?: StyleProfile } = {}): Strategy {
  const g = intent.genre, P = POLICY[g], c = intent.constraints ?? {};
  const decisions: Strategy['decisions'] = [];
  const open: string[] = [];
  const say = (what: string, why: string, source: Strategy['decisions'][number]['source']) => decisions.push({ what, why, source });
  const user = <T>(v: T | undefined, d: T, what: string): T => { if (v !== undefined) { say(`${what}: ${String(v)}`, 'explicit user instruction', 'user'); return v; } return d; };

  // Captions: only from trustworthy timing, and in the band that covers the fewest heads (faces, pose
  // heads, tops of person boxes) — bodies may sit under captions, faces may not.
  const position = captionBand(a);
  let burn = c.captions ?? P.captions;
  let capReason = c.captions !== undefined ? 'explicit user instruction' : `${g} policy`;
  if (!words.length) { burn = false; capReason = 'no transcript'; }
  else if (opts.transcriptUnverified && c.captions === undefined) { burn = false; capReason = `transcript from ${opts.transcriptUnverified}, whose measured accuracy is too low to burn unreviewed captions`; open.push(`captions: review the ${opts.transcriptUnverified} transcript (or import subtitles), then set captions:true`); }
  else if (opts.transcriptApprox && c.captions === undefined) { burn = false; capReason = 'transcript timing is approximate (segment-level): captions would drift — import subtitles or confirm captions explicitly'; open.push('captions: transcript timing is approximate; confirm or provide subtitles'); }
  say(`captions ${burn ? `burned, ${position}` : 'off'}`, capReason, c.captions !== undefined ? 'user' : 'policy');

  const zoomsAllowed = user(c.zooms, P.zoomPerMin > 0, 'zooms');
  const graphicsAllowed = user(c.graphics, P.graphics.length > 0, 'graphics');
  const transitionsAllowed = user(c.transitions, P.transitions.length > 0, 'transitions');
  const budget = user(c.maxEffectsPerMinute, P.budget, 'effect budget per minute');
  say(`effect budget ${budget}/min, zooms ≤ ${zoomsAllowed ? P.zoomPerMin : 0}/min`, `${g} policy: restraint over effect count`, 'policy');

  let pause = P.pause;
  let cpmGoal: number | undefined;
  let look: Strategy['colour']['look'];
  if (opts.reference) {
    const r = opts.reference;
    const [lo, hi] = P.cpm ?? [2, 30];
    cpmGoal = Math.max(lo, Math.min(hi, r.pacing.cutsPerMinute));
    say(`pacing goal ${cpmGoal} cuts/min`, `reference measures ${r.pacing.cutsPerMinute}; clamped to the ${g} range ${lo}–${hi} rather than copied`, 'reference');
    if (r.pacing.medianShotSec < 2.5) { pause = Math.max(0.4, pause - 0.2); say(`remove pauses over ${pause} s`, `reference median shot ${r.pacing.medianShotSec} s is brisk`, 'reference'); }
    if (r.typography && burn && c.captions === undefined && r.typography.position !== 'middle' && !(r.typography.position === 'lower' && position === 'upper')) say(`captions ${r.typography.position}`, `reference text sits ${r.typography.position}; subject placement allows it`, 'reference');
    if (r.colour) {
      if (c.allowLook) look = { saturation: Math.max(-0.2, Math.min(0.2, Math.round((r.colour.saturation - 0.35) * 100) / 100)), reason: `reference saturation ${r.colour.saturation} (look allowed by user; bounded to ±0.2)` };
      else open.push(`colour look: reference saturation ${r.colour.saturation}, warmth ${r.colour.warmth} — not applied (looks need allowLook)`);
    }
  }
  pause = user(undefined, pause, 'pause threshold');
  if (!c.allowBackgroundChange) say('no background change', 'never without an explicit instruction', 'policy');
  if (P.graphics.length && graphicsAllowed) open.push('graphic wording beyond spoken figures/lists (titles, names) needs the user');
  if (!c.music && g !== 'cinematic') open.push('music: none chosen (selection is a creative decision)');
  return {
    schema: STRATEGY_SCHEMA, genre: g, ...(c.target && { target: c.target }), ratio: c.ratio ?? '9:16',
    pacing: { removePausesOver: pause, padding: 0.15, ...(cpmGoal && { cutsPerMinuteGoal: cpmGoal }) },
    zooms: { allowed: zoomsAllowed, perMinute: zoomsAllowed ? P.zoomPerMin : 0, on: zoomsAllowed ? P.zoomOn : 'none' },
    jumpCuts: zoomsAllowed ? P.jump : 'leave',
    graphics: { allowed: graphicsAllowed, kinds: graphicsAllowed ? P.graphics : [] },
    captions: { burn, position, reason: capReason },
    transitions: { allowed: transitionsAllowed, kinds: transitionsAllowed ? (P.transitions.length ? P.transitions : ['fade']) : [] },
    colour: { corrective: true, ...(look && { look }) },
    audio: { compress: !!words.length && a.asset.audio, ...(c.music && { music: c.music }) },
    assets: { allowed: P.assets && graphicsAllowed !== false },
    effectBudgetPerMinute: budget, decisions, open,
  };
}
