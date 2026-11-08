import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { obj, str, num, oneOf, arr, bool } from '../src/schema.ts';
import { emptyTimeline, newClip, layout, timelineWords, resolveAnchor, cutTimeline, duration, srcToTl, type Word } from '../src/timeline.ts';
import { applyOps, parseOpString, normalizeOp, diffTimelines } from '../src/ops.ts';
import { Project } from '../src/project.ts';
import { TmepError } from '../src/errors.ts';

test('schema: defaults, coercion, strict keys with suggestions, JSON schema', () => {
  const s = obj({ name: str({ min: 1 }), n: num({ min: 0 }).default(3), mode: oneOf(['a', 'b'] as const).optional(), on: bool().optional(), xs: arr(num()).optional() });
  const ok = s.parse({ name: 'x', n: '2.5', on: 'true' });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.value, { name: 'x', n: 2.5, on: true });
  const d = s.parse({ name: 'x' });
  assert.ok(d.ok && d.value.n === 3);
  const bad = s.parse({ nme: 'x', mode: 'c' });
  assert.ok(!bad.ok);
  if (!bad.ok) {
    const msgs = bad.issues.map((i) => `${i.path}:${i.msg}`).join('|');
    assert.match(msgs, /name:required/);
    assert.match(msgs, /nme:unknown key \(did you mean 'name'\?\)/);
    assert.match(msgs, /mode:must be one of a\|b/);
  }
  assert.deepEqual(s.json.required, ['name']);
  assert.equal(s.json.additionalProperties, false);
});

const words: Word[] = [
  { w: 'Hello', s: 1.0, e: 1.4 },
  { w: 'there,', s: 1.5, e: 1.9 },
  { w: 'um', s: 2.4, e: 2.6 },
  { w: 'generative', s: 3.0, e: 3.6 },
  { w: 'AI', s: 3.7, e: 3.9 },
  { w: 'rocks.', s: 4.0, e: 4.5 },
];
const ctx = () => ({ transcripts: { v1: words }, assets: { v1: { dur: 10, kind: 'video' } } });

test('timeline: frame-exact layout with transitions', () => {
  const tl = emptyTimeline('9:16', 30);
  tl.clips.push(newClip(tl, 'v1', 0, 2), newClip(tl, 'v1', 3, 5));
  tl.clips[1]!.trans = { type: 'fade', d: 0.5 };
  const p = layout(tl);
  assert.equal(p[0]!.frames, 60);
  assert.equal(p[1]!.transFrames, 15);
  assert.equal(p[1]!.startFrame, 45);
  assert.equal(duration(tl), 3.5);
});

test('anchors: phrase, prefix, nth, word index, clip end', () => {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0.5, 5));
  const tw = timelineWords(tl, { v1: words });
  assert.equal(resolveAnchor(tl, tw, '@generative ai').t, 2.5);
  assert.equal(resolveAnchor(tl, tw, '@generat').t, 2.5);
  assert.equal(resolveAnchor(tl, tw, '@generative ai^end').t, 3.4);
  assert.equal(resolveAnchor(tl, tw, 'w:0').t, 0.5);
  assert.equal(resolveAnchor(tl, tw, 'c:c1^end').t, 4.5);
  assert.throws(() => resolveAnchor(tl, tw, '@missing words'), (e: TmepError) => e.code === 'E_ANCHOR');
});

test('cuts keep anchored items synced to their words', () => {
  const base = emptyTimeline();
  base.clips.push(newClip(base, 'v1', 0, 6));
  const r1 = applyOps(base, ['gfx keyword @generative props.text=AI', { op: 'zoom', at: '@rocks', to: 1.2 }], { ...ctx(), presets: ['keyword'] });
  // cut the first 2.9 seconds; the graphic must still land on "generative"
  const r2 = applyOps(r1.tl, ['cut 0 2.9'], ctx());
  const p = layout(r2.tl);
  const g = r2.tl.gfx[0]!;
  assert.equal(g.ref.src, 'v1');
  assert.equal(g.ref.t, 3.0);
  assert.ok(Math.abs(srcToTl(p, 'v1', g.ref.t!)! - 0.1) < 1e-6);
  assert.equal(r2.tl.clips[0]!.zoom.length, 1);
});

test('transcript-based delete removes fillers and phrases', () => {
  const base = emptyTimeline();
  base.clips.push(newClip(base, 'v1', 0, 6));
  const r = applyOps(base, [{ op: 'delete', fillers: true }, 'delete there'], ctx());
  const tw = timelineWords(r.tl, { v1: words }).map((w) => w.w);
  assert.ok(!tw.includes('um'));
  assert.ok(!tw.includes('there,'));
  assert.ok(tw.includes('generative'));
  assert.equal(r.tl.clips.length, 3);
});

test('compact op strings parse positionals, quotes, props and phrase anchors', () => {
  assert.deepEqual(parseOpString('cut 1.5 3'), { op: 'cut', from: 1.5, to: 3 });
  assert.deepEqual(parseOpString("gfx title 0 props.text='Hello world' d=2"), { op: 'gfx', preset: 'title', at: 0, props: { text: 'Hello world' }, d: 2 });
  assert.deepEqual(parseOpString('zoom @generative ai 1.2'), { op: 'zoom', at: '@generative ai', to: 1.2 });
  assert.throws(() => normalizeOp('zom 3'), (e: TmepError) => e.code === 'E_INPUT' && /did you mean "zoom"/.test(e.hint ?? ''));
  assert.throws(() => normalizeOp({ op: 'zoom', at: 1, to: 9 }), /to: must be <= 3/);
});

test('ops batch is atomic and diff is compact', () => {
  const base = emptyTimeline();
  base.clips.push(newClip(base, 'v1', 0, 6));
  assert.throws(() => applyOps(base, ['captions boxed', 'zoom @nope'], ctx()));
  assert.equal(base.captions.style, 'kinetic');
  const r = applyOps(base, ['captions boxed', 'cut 1 2'], ctx());
  const d = diffTimelines(base, r.tl);
  assert.deepEqual(d.captions, ['style']);
  assert.ok((d.clips as { add: string[] }).add.length === 1);
});

test('cutTimeline rejects empty range', () => {
  const tl = emptyTimeline();
  tl.clips.push(newClip(tl, 'v1', 0, 6));
  assert.throws(() => cutTimeline(tl, 2, 2), (e: TmepError) => e.code === 'E_RANGE');
});

test('project: assets dedupe by hash, revisions, undo/redo', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tmep-proj-'));
  const p = await Project.open(dir, { create: true });
  const a = await p.addAsset({ kind: 'video', path: '/x.mp4', name: 'x.mp4', hash: 'h1', dur: 10, audio: true, size: 1 });
  const b = await p.addAsset({ kind: 'video', path: '/moved/x.mp4', name: 'x.mp4', hash: 'h1', dur: 10, audio: true, size: 1 });
  assert.equal(a.asset.id, 'v1');
  assert.equal(b.asset.id, 'v1');
  assert.ok(b.existed);
  assert.equal((await p.asset('v1')).path, '/moved/x.mp4');
  const tl = emptyTimeline();
  const r1 = await p.commit(tl, ['a']);
  tl.captions.style = 'clean';
  const r2 = await p.commit(tl, ['b']);
  assert.deepEqual([r1, r2], [1, 2]);
  assert.equal(await p.undo(), 1);
  assert.equal((await p.timeline()).captions.style, 'kinetic');
  assert.equal(await p.redo(), 2);
  assert.equal((await p.timeline()).captions.style, 'clean');
  await assert.rejects(p.asset('v9'), (e: TmepError) => e.code === 'E_NOT_FOUND');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('transitions get silence handles; refused inside continuous speech', () => {
  const ws: Word[] = [
    { w: 'one', s: 0, e: 0.5 },
    { w: 'two', s: 0.55, e: 1.0 },
    { w: 'three', s: 3.0, e: 3.5 },
  ];
  const c = { transcripts: { v1: ws }, assets: { v1: { dur: 10, kind: 'video' } } };
  const base = emptyTimeline();
  base.clips.push(newClip(base, 'v1', 0, 1.05), newClip(base, 'v1', 2.95, 3.6));
  const r = applyOps(base, ['transition fade 0.4 all=true'], c);
  assert.equal(r.tl.clips[1]!.trans?.d, 0.4);
  assert.ok(r.tl.clips[0]!.out <= 2.97 && r.tl.clips[1]!.in >= 1.03, 'handles stay in silence');
  const tight = emptyTimeline();
  tight.clips.push(newClip(tight, 'v1', 0, 0.52), newClip(tight, 'v1', 0.53, 1.0));
  const r2 = applyOps(tight, ['transition fade 0.4 all=true'], c);
  assert.equal(r2.tl.clips[1]!.trans, undefined);
  assert.match(r2.notes[0]!, /skipped/);
});
