import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Project } from '../src/project.ts';
import { emptyTimeline, newClip, layout, anchorAt, resolveRef, cutTimeline } from '../src/timeline.ts';
import { applyOps } from '../src/ops.ts';
import * as api from '../../engine/src/api.ts';
import { planTimeline } from '../../story/src/planner.ts';

test('correctness: concurrent api.edit calls preserve all updates without lost writes', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-corr-conc-'));
  try {
    const p = await Project.open(dir, { create: true });
    await p.addAsset({
      path: path.join(dir, 'v1.mp4'),
      name: 'v1.mp4',
      size: 1024,
      hash: 'h1',
      kind: 'video',
      dur: 10,
      w: 1080,
      h: 1920,
      fps: 30,
      audio: true,
    });
    const base = emptyTimeline();
    base.clips.push(newClip(base, 'v1', 0, 10));
    await p.commit(base, [], 'init');

    const ctx: api.Ctx = { project: dir, detail: 'minimal' };
    await Promise.all([
      api.edit(ctx, { ops: ['gfx title 0 2 props.text="Edit A"'], note: 'A' }),
      api.edit(ctx, { ops: ['gfx title 3 2 props.text="Edit B"'], note: 'B' }),
      api.edit(ctx, { ops: ['gfx title 6 2 props.text="Edit C"'], note: 'C' }),
    ]);

    const finalTl = await p.timeline();
    assert.equal(finalTl.gfx.length, 3);
    const texts = new Set(finalTl.gfx.map((g) => g.props.text));
    assert.deepEqual(texts, new Set(['Edit A', 'Edit B', 'Edit C']));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('correctness: expectedRev detects concurrent modification conflict (E_CONFLICT)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-corr-occ-'));
  try {
    const p = await Project.open(dir, { create: true });
    await p.addAsset({
      path: path.join(dir, 'v1.mp4'),
      name: 'v1.mp4',
      size: 1024,
      hash: 'h1',
      kind: 'video',
      dur: 10,
      w: 1080,
      h: 1920,
      fps: 30,
      audio: true,
    });
    const base = emptyTimeline();
    base.clips.push(newClip(base, 'v1', 0, 10));
    const r1 = await p.commit(base, [], 'init');
    const ctx: api.Ctx = { project: dir, detail: 'minimal' };
    await api.edit(ctx, { ops: ['gfx title 0 2 props.text="First"'], expectedRev: r1 });
    await assert.rejects(
      () => api.edit(ctx, { ops: ['gfx title 3 2 props.text="Stale"'], expectedRev: r1 }),
      (e: any) => e.code === 'E_CONFLICT',
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('correctness: reused-footage anchors and zoom bind to the exact clip instance (and keep legacy fallback)', () => {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'a1', 0, 4), newClip(tl, 'a1', 0, 4));
  const placed = layout(tl);
  const ref = anchorAt(placed, 6.0);
  assert.equal(ref.clip, tl.clips[1]!.id);
  assert.equal(resolveRef(placed, ref), 6.0);
  assert.equal(resolveRef(placed, { src: 'a1', t: 2 }), 2);

  const { tl: zoomed } = applyOps(tl, ['zoom 6 1.25 1'], {
    transcripts: {},
    assets: { a1: { dur: 10, kind: 'video' } },
  });
  assert.equal(zoomed.clips[0]!.zoom.length, 0);
  assert.equal(zoomed.clips[1]!.zoom.length, 1);
  assert.equal(zoomed.clips[1]!.zoom[0]!.s, 2);
});

test('correctness: frame-rounded clip tails never discard anchored items and splitClip preserves right anchors', () => {
  const tl = emptyTimeline('9:16', 30);
  tl.clips.push(newClip(tl, 'a1', 0, 1.017));
  const placed = layout(tl);
  const refTail = anchorAt(placed, placed[0]!.dur - 0.001);
  const resolved = resolveRef(placed, refTail);
  assert.ok(resolved !== undefined && resolved <= placed[0]!.dur + 1e-6);

  const tlSplit = emptyTimeline('9:16', 30);
  const c1 = newClip(tlSplit, 'a1', 0, 10);
  tlSplit.clips.push(c1);
  tlSplit.gfx.push({ id: 'g1', preset: 'title', ref: { clip: c1.id, src: 'a1', t: 7 }, d: 1, props: {} });
  cutTimeline(tlSplit, 3, 5);
  const placedAfter = layout(tlSplit);
  assert.equal(tlSplit.clips.length, 2);
  assert.equal(tlSplit.gfx[0]!.ref.clip, tlSplit.clips[1]!.id);
  assert.equal(resolveRef(placedAfter, tlSplit.gfx[0]!.ref), 5);
});

test('correctness: planTimeline disables push/jumpZoom when zooms=false and samples non-transcribed footage beyond 0s', () => {
  const { tl } = planTimeline({
    template: 'reel',
    zooms: false,
    target: 8,
    sources: [
      { id: 'v1', dur: 30, kind: 'video', w: 1080, h: 1920 },
      { id: 'v2', dur: 20, kind: 'video', w: 1080, h: 1920 },
    ],
  });
  for (const c of tl.clips) {
    assert.equal(c.push, 0);
    assert.equal(c.base, 1);
    assert.equal(c.zoom.length, 0);
  }
  assert.ok(tl.clips.some((c) => c.src === 'v1' && c.in > 0));
  assert.ok(tl.clips.some((c) => c.src === 'v2' && c.in > 0));
});
