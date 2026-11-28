/**
 * Scene classification (Phase 6). A multinomial logistic model over, per frame:
 * a MobileNetV3-large embedding (1280-d), EfficientNet-Lite2 ImageNet class probabilities (1001-d, square
 * root; classes below 1e-4 are dropped) and six detection counts (faces, people, poses). Trained offline on
 * labelled real clips (bench/phase6/scene-train.py); the weights ship in data/scene-model.json.
 * Replaces the Phase 5 detection rules (9 of 23 held-out spans correct). Accuracy is reported in
 * docs/phase-6/INTELLIGENCE.md; the classifier's own probability is given as confidence.
 */
import { readFileSync } from 'node:fs';
import type { SemFrame } from './semantic.ts';

export const SCENE_CLASSES = ['talking-head', 'group', 'performance', 'screen', 'animation', 'sports', 'close-up', 'scenery'] as const;
export type SceneClass = (typeof SCENE_CLASSES)[number];
export interface SceneModel { classes: readonly string[]; dims: number; mu: number[]; sd: number[]; W: number[][]; b: number[]; meta?: Record<string, unknown> }

export const EMB_DIMS = 1280, CLS_DIMS = 1001, DET_DIMS = 6;

/** Feature vector of one frame, or undefined when the scene models did not run on it. */
export function sceneFeatures(f: SemFrame): number[] | undefined {
  if (f.embL?.length !== EMB_DIMS || !f.cls) return undefined;
  const cls = new Array(CLS_DIMS).fill(0);
  for (const [i, p] of f.cls) if (i >= 0 && i < CLS_DIMS) cls[i] = Math.sqrt(p);
  const faces = f.faces ?? [], people = (f.objects ?? []).filter((o) => o[0] === 'person'), poses = f.poses ?? [];
  const det = [
    Math.min(faces.length, 3) / 3,
    Math.min(1, Math.max(0, ...faces.map((x) => x[3] * x[4])) * 15),
    Math.min(people.length, 6) / 6,
    Math.min(1, Math.max(0, ...people.map((p) => p[4] * p[5])) * 2),
    Math.min(poses.length, 4) / 4,
    Math.min(1, Math.max(0, ...poses.map((p) => p.box[2] * p.box[3])) * 2),
  ];
  return [...f.embL, ...cls, ...det];
}

export function predict(m: SceneModel, x: number[]): number[] {
  const z = m.W.map((w, k) => { let s = m.b[k]!; for (let j = 0; j < m.dims; j++) if (w[j]) s += w[j]! * ((x[j]! - m.mu[j]!) / (m.sd[j]! || 1e-6)); return s; });
  const mx = Math.max(...z), e = z.map((v) => Math.exp(v - mx)), Z = e.reduce((s, v) => s + v, 0);
  return e.map((v) => v / Z);
}

let cached: SceneModel | null | undefined;
/** The shipped model, or null when it is absent (scene types are then reported unavailable). */
export function sceneModel(): SceneModel | null {
  if (cached !== undefined) return cached;
  try { cached = JSON.parse(readFileSync(new URL('../data/scene-model.json', import.meta.url), 'utf8')) as SceneModel; } catch { cached = null; }
  return cached;
}

/** Classify a set of frames (a shot): mean class probability over the frames that carry scene features. */
export function classifyFrames(frames: SemFrame[], m = sceneModel()): { label: SceneClass; confidence: number; frames: number; runnerUp: string } | undefined {
  if (!m) return undefined;
  const ps = frames.map(sceneFeatures).filter((x): x is number[] => !!x).map((x) => predict(m, x));
  if (!ps.length) return undefined;
  const mean = m.classes.map((_, k) => ps.reduce((s, p) => s + p[k]!, 0) / ps.length);
  const order = mean.map((p, k) => [p, k] as const).sort((a, b) => b[0] - a[0]);
  return { label: m.classes[order[0]![1]] as SceneClass, confidence: Math.round(order[0]![0] * 1000) / 1000, frames: ps.length, runnerUp: m.classes[order[1]![1]]! };
}
