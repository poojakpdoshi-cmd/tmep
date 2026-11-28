/**
 * Phase 5 semantic layer: pure logic over worker observations (no models needed), plus the new
 * structural cut / gradual transition rules on synthetic frame statistics.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectCuts, detectGradual } from '../src/footage.ts';
import { trackObjects, findSubjects, reframeKeys, poseActivities, similarShots, textOverTime, alignSpeech, eventCandidates, sceneTypes, type SemFrame, type Kp } from '../src/semantic.ts';
import { installModels, modelStatus, MODELS } from '../src/models.ts';

const TW = 32, TH = 18;
interface St { t: number; luma: number; diff: number; t32: Float32Array; [k: string]: unknown }
/** Frame statistics with a 32×18 thumbnail produced by `pix(x, y)`. */
function stat(t: number, pix: (x: number, y: number) => number, prev?: St): St {
  const t32 = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) t32[y * TW + x] = pix(x, y);
  const thumb = new Array(64).fill(0);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) thumb[Math.floor((y * 8) / TH) * 8 + Math.floor((x * 8) / TW)] += t32[y * TW + x]! / ((TW * TH) / 64);
  const hist = new Float32Array(16);
  for (const v of t32) hist[Math.min(15, Math.max(0, Math.floor(v / 16)))]! += 1 / t32.length;
  let diff = 0; if (prev) for (let i = 0; i < t32.length; i++) diff += Math.abs(t32[i]! - prev.t32[i]!);
  const luma = t32.reduce((a, b) => a + b, 0) / t32.length;
  return { t, luma, clipLow: 0, clipHigh: 0, detail: 10, diff: prev ? diff / t32.length : 0, hist, grid: new Array(9).fill(0.1), thumb, t32 };
}
const seq = (n: number, fps: number, pix: (i: number, x: number, y: number) => number) => {
  const out: St[] = [];
  for (let i = 0; i < n; i++) out.push(stat(i / fps, (x, y) => pix(i, x, y), out[i - 1]));
  return out;
};
// Non-periodic textures (a periodic one would be "explained" by shifting it by its period).
const noise = (seed: number) => (x: number, y: number) => { const v = Math.sin((Math.floor(x) * 12.9898 + Math.floor(y) * 78.233 + seed) * 43758.5453); return v - Math.floor(v); };
const nA = noise(1), nB = noise(2);
const texA = (x: number, y: number) => 40 + 160 * nA(x, y);
const texB = (x: number, y: number) => 40 + 160 * nB(x, y);

test('cuts: similar-tone structural cut is found, an exposure jump is not; gradual: dissolve yes, pan no', () => {
  const fps = 10;
  // same mean level, different structure at frame 30
  const cut = seq(60, fps, (i, x, y) => (i < 30 ? texA(x, y) : texB(x, y) - 20));
  assert.deepEqual(detectCuts(cut as never, fps).map((c) => c.t), [3]);
  const expo = seq(60, fps, (i, x, y) => texA(x, y) * (i < 30 ? 1 : 1.6));
  assert.deepEqual(detectCuts(expo as never, fps), [], 'exposure jump keeps structure');
  // 1 s dissolve A→B centred at 3.0 s (blend, with very different tones)
  const dis = seq(60, fps, (i, x, y) => { const k = Math.min(1, Math.max(0, (i - 25) / 10)); return (1 - k) * texA(x, y) + k * (texB(x, y) + 20); });
  const g = detectGradual(dis as never, fps, detectCuts(dis as never, fps));
  assert.equal(g.length, 1); assert.ok(Math.abs(g[0]!.t - 3) <= 0.3, `dissolve at ${g[0]!.t}`);
  // camera pan with an exposure ramp: shifting explains it
  const pan = seq(60, fps, (i, x, y) => texA(x + i * 0.6, y) * (1 + i * 0.01));
  assert.deepEqual(detectGradual(pan as never, fps, detectCuts(pan as never, fps)), []);
});

const person = (t: number, x: number, face = true): SemFrame => ({ t, objects: [['person', 0.8, x, 0.2, 0.2, 0.7]], faces: face ? [[0.9, x + 0.05, 0.22, 0.1, 0.12]] : [] });

test('tracking, subjects and reframing follow a presenter and a moving subject; cuts end tracks', () => {
  const fps = 2;
  const frames: SemFrame[] = [];
  for (let i = 0; i < 40; i++) {
    const f = person(i / fps, 0.1);
    f.objects!.push(['sports ball', 0.6, 0.1 + i * 0.02, 0.8, 0.04, 0.04]);
    if (i === 7) f.objects = f.objects!.slice(1); // one missed sample is bridged
    frames.push(f);
  }
  const tr = trackObjects(frames, fps, [10]);
  const people = tr.filter((t) => t.label === 'person');
  assert.equal(people.length, 2, 'the cut at 10 s ends the person track');
  assert.equal(people[0]!.n, 19);
  const ball = tr.find((t) => t.label === 'sports ball')!;
  assert.ok(ball.speed > 0.03 && ball.speed < 0.05, `ball speed ${ball.speed}`);
  const sub = findSubjects(tr, 20);
  assert.ok(sub.presenter && people.some((p) => p.id === sub.presenter), `presenter ${sub.presenter}`);
  const rf = reframeKeys(people[0], { w: 1920, h: 1080 }, [9, 16], [{ t0: 0 }]);
  assert.equal(rf.subjectInside, 1, 'a person on the left stays inside the 9:16 crop');
  assert.ok(rf.keys[0]!.cx < 0.35, `crop moved left (${rf.keys[0]!.cx})`);
  assert.equal(rf.keys.length, 1, 'a still subject needs one key');
});

test('pose activity: waving is gesturing, walking is moving across frame', () => {
  const kp = (dx: number, wristY: number): Kp => ({
    nose: [0.5 + dx, 0.2, 1], ls: [0.45 + dx, 0.35, 1], rs: [0.55 + dx, 0.35, 1], le: [0.43 + dx, 0.45, 1], re: [0.57 + dx, 0.45, 1],
    lw: [0.42 + dx, wristY, 1], rw: [0.58 + dx, 0.55, 1], lh: [0.47 + dx, 0.6, 1], rh: [0.53 + dx, 0.6, 1], lk: [0.47 + dx, 0.75, 1], rk: [0.53 + dx, 0.75, 1], la: [0.47 + dx, 0.9, 1], ra: [0.53 + dx, 0.9, 1],
  });
  const mk = (walk: boolean) => Array.from({ length: 10 }, (_, i): SemFrame => {
    const dx = walk ? i * 0.1 : 0, x = 0.4 + dx;
    return { t: i * 0.5, objects: [['person', 0.9, x, 0.15, 0.2, 0.8]], poses: [{ box: [x, 0.15, 0.2, 0.8], kp: kp(dx - 0.0, walk ? 0.55 : i % 2 ? 0.3 : 0.55) }] };
  });
  for (const [walk, want] of [[false, 'gesturing'], [true, 'moving across frame']] as const) {
    const fr = mk(walk);
    const acts = poseActivities(fr, trackObjects(fr, 2));
    assert.equal(acts[0]?.label, want);
  }
});

test('similar shots, replay candidates, text over time, speech alignment and event candidates', () => {
  const shots = [0, 4, 8, 12].map((t0, i) => ({ id: `s${i + 1}`, t0, t1: t0 + 4, cutScore: 0.5, keyframe: t0 + 2, luma: 100, motion: 2, detail: 10, signature: new Array(16).fill(1 / 16) }));
  const e1 = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0)), e2 = Array.from({ length: 8 }, (_, i) => (i === 1 ? 1 : 0));
  const frames: SemFrame[] = [0.5, 4.5, 8.5, 12.5].map((t, i) => ({ t, emb: i === 1 || i === 3 ? e2 : e1 }));
  const d = similarShots(shots, frames, [2]);
  assert.deepEqual(d.map((x) => [x.a, x.b, x.kind]), [['s1', 's3', 'replay-candidate'], ['s2', 's4', 'near-duplicate']]);
  const ocr = [{ t: 0.5, text: 'HOME 0 AWAY 0', conf: 0.9 }, { t: 1.5, text: 'HOME 0 AWAY 0', conf: 0.9 }, { t: 2.5, text: 'HOME 1 AWAY 0', conf: 0.9 }, { t: 3.5, text: 'Welcome to the match', conf: 0.9 }];
  const tt = textOverTime(ocr, 1);
  assert.deepEqual(tt.changes.map((c) => [c.t, c.before, c.after]), [[2.5, '0 0', '1 0']]);
  assert.ok(tt.tracks.some((x) => x.text === 'HOME' && x.t0 === 0.5 && x.t1 === 2.5));
  const al = alignSpeech([{ w: 'Home', s: 1.0, e: 1.3 }, { w: 'balls', s: 30, e: 30.2 }], [{ id: 'sports-ball1', label: 'sports ball', t0: 0, t1: 4, n: 4, score: 0.6, coverage: 1, speed: 0, area: 0.01, boxes: [] }], tt.tracks);
  assert.deepEqual(al.map((x) => [x.word, x.target]), [['Home', 'text']]);
  const a = { observed: { shots }, inferred: { moments: [{ id: 'm1', t: 2.5, t0: 2, t1: 3, score: 0.8, confidence: 0.7, evidence: ['audio peak'], signals: {} }] } } as never;
  const ev = eventCandidates(a, [], tt.changes, d);
  assert.equal(ev.length, 1);
  assert.deepEqual(Object.keys(ev[0]!.signals).sort(), ['cutAfter', 'moment', 'replay', 'scoreChange'].sort());
  assert.match(ev[0]!.note, /candidate only/);
});

test('scene rules: talking head, screen with text, empty frames', () => {
  const shots = [{ id: 's1', t0: 0, t1: 4, motion: 1 }, { id: 's2', t0: 4, t1: 8, motion: 1 }, { id: 's3', t0: 8, t1: 12, motion: 1 }];
  const frames: SemFrame[] = [];
  for (let t = 0; t < 12; t += 0.5) frames.push(t < 4 ? person(t, 0.4) : { t, objects: [], faces: [] });
  const a = { observed: { shots, text: [{ t: 5, text: 'Quarterly revenue grew twelve percent year over year', conf: 0.9 }, { t: 6, text: 'Three drivers of growth this quarter', conf: 0.9 }] } } as never;
  assert.deepEqual(sceneTypes(a, frames).map((s) => s.label), ['talking-head', 'screen', 'scenery'], 'without scene features the detection rules apply (Phase 6 labels)');
});

test('model manager plans downloads without fetching anything', async () => {
  const prev = process.env.FRAME_MODELS;
  process.env.FRAME_MODELS = '/nonexistent-frame-models';
  try {
    const st = await modelStatus();
    assert.equal(st.models.length, MODELS.length);
    assert.ok(st.models.every((m) => !m.installed && m.licence === 'Apache-2.0'));
    assert.equal(st.downloadBytes, MODELS.reduce((a, m) => a + m.bytes, 0));
    const plan = await installModels(['objects']);
    assert.equal(plan.installed.length, 0, 'no download without confirm');
    assert.equal(plan.planned[0]!.file, 'efficientdet_lite0.tflite');
  } finally { if (prev === undefined) delete process.env.FRAME_MODELS; else process.env.FRAME_MODELS = prev; }
});

test('camera motion: a pan is measured, a cut is not; subject speed is relative to the camera', async () => {
  const { cameraMotion } = await import('../src/footage.ts');
  const fps = 10;
  // Content moves right by 0.6 cells/frame = 6 cells/s of 32 → ~0.19 frame widths/s.
  const pan = seq(30, fps, (i, x, y) => texA(x - i * 0.6, y));
  const cam = cameraMotion(pan as never, fps, [], 3);
  assert.ok(cam.slice(1, 5).every((c) => c.dx > 0.12 && c.dx < 0.26), JSON.stringify(cam)); // window 0 straddles the synthetic edge
  assert.deepEqual(cameraMotion(pan as never, fps, [0.3], 0.5), [{ dx: 0, dy: 0 }], 'a cut inside the window gives no motion');
  // A person who stays put on screen while the camera pans is moving in the scene; one who moves with the pan is not.
  const frames = Array.from({ length: 8 }, (_, i): SemFrame => ({ t: i * 0.5, objects: [['person', 0.9, 0.4 + i * 0.05, 0.2, 0.2, 0.6]] }));
  const still = trackObjects(frames, 2, [], Array(8).fill({ dx: 0.1, dy: 0 }))[0]!;
  const free = trackObjects(frames, 2, [])[0]!;
  assert.ok(still.speed < 0.02 && free.speed > 0.09, `${still.speed} vs ${free.speed}`);
});
