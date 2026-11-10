/**
 * Effect retiming (audit P2-1). Clip effects use clip-local OUTPUT seconds; editing the clip must
 * keep every effect attached to the same source content, exactly as `cut` already does:
 *   - `trim in=` shifts effect times by the change in clip start (in output seconds)
 *   - `speed` scales effect times (and mask reveal durations) by old/new speed
 *   - `trim out=` changes nothing
 * The invariant checked throughout: the effect state shown with a given SOURCE frame is unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTimeline, newClip, type Timeline, type Clip } from '../src/timeline.ts';
import { applyOps } from '../src/ops.ts';
import { sampleKeys, ease, KEY_PROPS, type FxTransform, type FxMask, type KeyProp } from '../src/effects.ts';

const ctx = () => ({ transcripts: {}, assets: { v1: { dur: 20, kind: 'video' } } });
const near = (a: number, b: number, msg: string, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} != ${b}`);

/** Effect state of a clip at SOURCE time X (undefined when X is outside the clip). */
function stateAtSource(c: Clip, X: number): Record<string, number> | undefined {
  if (X < c.in - 1e-9 || X > c.out + 1e-9) return undefined;
  const t = (X - c.in) / c.speed;
  const out: Record<string, number> = {};
  (c.fx ?? []).forEach((f, i) => {
    if (f.type === 'kf') for (const p of KEY_PROPS) out[`${i}.${p}`] = sampleKeys(f.keys, p as KeyProp, t);
    else if (f.reveal) out[`${i}.reveal`] = ease(f.reveal.e, Math.min(1, Math.max(0, (t - f.reveal.at) / f.reveal.d)));
  });
  return out;
}

/** Every remaining clip must show, at each source time it contains, the same effect state as the reference clip. */
function assertContentAnchored(ref: Clip, tl: Timeline, label: string): void {
  let checked = 0;
  for (const c of tl.clips) {
    for (let X = c.in; X <= c.out + 1e-9; X += (c.out - c.in) / 16) {
      const want = stateAtSource(ref, X);
      const got = stateAtSource(c, X);
      if (!want || !got) continue;
      for (const k of Object.keys(want)) near(got[k]!, want[k]!, `${label}: ${c.id} ${k} @src ${X.toFixed(3)}`);
      checked++;
    }
  }
  assert.ok(checked > 10, `${label}: sampled ${checked} source points`);
}

function withFx(ops: string[]): Timeline {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0, 8));
  return applyOps(tl, ops, ctx()).tl;
}
const FX = ['fx kf c1 keys="0:s=1,o=0,r=0;2:o=1,e=out;6:s=1.4,r=6,e=io"', 'fx mask c1 shape=ellipse w=0.6 h=0.6 reveal=2 at=1 e=linear'];

test('trim in: effects shift with the clip start so the same source frame keeps its effect state', () => {
  const ref = withFx(FX).clips[0]!;
  const r = applyOps(withFx(FX), ['trim c1 in=1.5'], ctx()).tl;
  const c = r.clips[0]!;
  assert.equal(c.in, 1.5);
  near(sampleKeys((c.fx![0] as FxTransform).keys, 'o', 0), sampleKeys((ref.fx![0] as FxTransform).keys, 'o', 1.5), 'opacity at new first frame');
  near((c.fx![1] as FxMask).reveal!.at, -0.5, 'reveal start moved 1.5 s earlier');
  assertContentAnchored(ref, r, 'trim in');
  // extending the head again moves effects back: trim in=1.5 then in=0.5 == trim in=0.5
  const back = applyOps(r, ['trim c1 in=0.5'], ctx()).tl;
  assertContentAnchored(ref, back, 'trim in back to 0.5');
});

test('trim out only: effects are unchanged', () => {
  const before = withFx(FX).clips[0]!;
  const after = applyOps(withFx(FX), ['trim c1 out=5'], ctx()).tl.clips[0]!;
  assert.deepEqual(after.fx, before.fx);
});

test('speed: effect times and reveal durations scale with the clip so effects still span the same content', () => {
  const ref = withFx(['fx zoomin c1', ...FX]).clips[0]!; // zoomin spans the whole 8 s clip
  const r = applyOps(withFx(['fx zoomin c1', ...FX]), ['speed 2 clip=c1'], ctx()).tl;
  const c = r.clips[0]!;
  const zoom = (c.fx![0] as FxTransform).keys;
  near(zoom[zoom.length - 1]!.t, 4, 'zoom now ends at the end of the 4 s clip');
  near(sampleKeys(zoom, 's', 4), 1.15, 'zoom reaches its target at the clip end');
  const m = (c.fx![2] as FxMask).reveal!;
  near(m.at, 0.5, 'reveal start scaled');
  near(m.d, 1, 'reveal duration scaled');
  assertContentAnchored(ref, r, 'speed 2');
  // round trip restores the original timing
  const rt = applyOps(r, ['speed 0.5 clip=c1', 'speed 1 clip=c1'], ctx()).tl.clips[0]!;
  for (const [i, f] of ref.fx!.entries()) {
    if (f.type === 'kf') (rt.fx![i] as FxTransform).keys.forEach((k, j) => near(k.t, f.keys[j]!.t, `round-trip key ${i}.${j}`));
  }
});

test('speed without a clip id retimes every clip by its own old speed', () => {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0, 4), newClip(tl, 'v1', 4, 8));
  tl.clips[1]!.speed = 2;
  const r0 = applyOps(tl, ['fx kf keys="0:o=0;2:o=1,e=linear"'], ctx()).tl; // same clip-local keys on both
  const refs = structuredClone(r0.clips);
  const r = applyOps(r0, ['speed 4'], ctx()).tl;
  near((r.clips[0]!.fx![0] as FxTransform).keys[1]!.t, 0.5, 'clip 1: 1x -> 4x');
  near((r.clips[1]!.fx![0] as FxTransform).keys[1]!.t, 1, 'clip 2: 2x -> 4x');
  for (const [i, ref] of refs.entries()) assertContentAnchored(ref, { ...r, clips: [r.clips[i]!] }, `clip ${i}`);
});

test('combined trim, speed, cut and fx keep effects attached to their source content', () => {
  const ref = withFx(FX).clips[0]!;
  const r = applyOps(withFx(FX), ['trim c1 in=0.5', 'speed 2 clip=c1', 'cut 1 1.5', 'trim c1 out=3.2', 'speed 0.75'], ctx()).tl;
  assert.ok(r.clips.length >= 2, `split happened: ${r.clips.map((c) => c.id).join(',')}`);
  assertContentAnchored(ref, r, 'trim+speed+cut+trim+speed');
  // parts never share effect objects
  assert.notEqual(r.clips[0]!.fx, r.clips[1]!.fx);
  assert.notEqual((r.clips[0]!.fx![0] as FxTransform).keys, (r.clips[1]!.fx![0] as FxTransform).keys);
});

test('clips without effects and effect-free edits are unchanged', () => {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0, 8));
  const r = applyOps(tl, ['trim c1 in=1', 'speed 2'], ctx()).tl;
  assert.equal(r.clips[0]!.fx, undefined);
  assert.deepEqual([r.clips[0]!.in, r.clips[0]!.speed], [1, 2]);
});
