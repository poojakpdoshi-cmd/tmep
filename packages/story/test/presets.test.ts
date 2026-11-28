import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOps, emptyTimeline, newClip } from '../../core/src/index.ts';
import { diagnoseScenes } from '../../motion/src/scene.ts';
import { canvasModule } from '../../motion/src/vector.ts';
import { compileIntent } from '../src/compiler.ts';
import { compilePreset, placeBox, fitText, STYLE_PROFILES, PRESET_KINDS } from '../src/presets.ts';

let dir: string;
let shot: string;
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'frame-presets-'));
  shot = path.join(dir, 'shot.png');
  const c = canvasModule().createCanvas(320, 200);
  const g = c.getContext('2d');
  g.fillStyle = '#e2e8f0'; g.fillRect(0, 0, 320, 200);
  writeFileSync(shot, c.toBuffer('image/png'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const intents: Record<string, Record<string, unknown>> = {
  kinetic_title: { title: 'Local footage intelligence, built in', subtitle: 'No uploads. No cloud. Every decision explained.' },
  lower_third: { title: 'Dr. Ananya Rao', subtitle: 'Cardiologist, AIIMS Delhi' },
  callout: { target: { x: 0.3, y: 0.35 }, label: 'Tap to record' },
  ui_demo: { asset: 'i1', clicks: [{ x: 0.2, y: 0.3, t: 1, label: 'Import' }, { x: 0.7, y: 0.6, t: 2.4, label: 'Render' }] },
  animated_diagram: { nodes: ['Footage', 'Understand', 'Compile', 'Render', 'Inspect'] },
  dynamic_chart: { title: 'Tokens per edit', chart: { chartType: 'bar', data: [{ label: 'Scripts', value: 18187 }, { label: 'FRAME', value: 217 }] } },
};

function check(spec: unknown, ratio: '9:16' | '16:9') {
  const tl = emptyTimeline(ratio);
  tl.clips = [newClip(tl, 'v1', 0, 10)];
  const assets = { v1: { kind: 'video', dur: 10 }, i1: { kind: 'image', dur: 0 } };
  const out = applyOps(tl, [{ op: 'scene', spec }], { assets, transcripts: {} }).tl;
  return diagnoseScenes(out, [], new Map(Object.entries({ v1: { kind: 'video', dur: 10 }, i1: { kind: 'image', dur: 0, path: shot } })));
}

for (const ratio of ['9:16', '16:9'] as const) {
  for (const kind of PRESET_KINDS) {
    for (const profile of ['editorial', 'bold', 'documentary']) {
      test(`${kind} (${ratio}, ${profile}) compiles to a scene with no validation issues`, () => {
        const r = compilePreset({ kind, profile, platform: ratio === '9:16' ? 'reels' : 'youtube', duration: 4, ...intents[kind] }, { ratio });
        const diag = check(r.spec, ratio);
        assert.deepEqual(diag.issues.map((i) => `${i.code}:${i.msg}`), [], `corrections: ${JSON.stringify(r.corrections)}`);
      });
    }
  }
}

test('placeBox keeps elements inside the area and clear of reserved regions', () => {
  const area = { x: 0.5, y: 0.5, w: 0.8, h: 0.8 };
  const face = { x: 0.3, y: 0.6, w: 0.3, h: 0.3 };
  const r = placeBox(0.3, 0.1, { x: 0.3, y: 0.6 }, area, [face]);
  assert.equal(r.overlap, 0);
  assert.ok(r.box.x - r.box.w / 2 >= 0.1 - 1e-9 && r.box.x + r.box.w / 2 <= 0.9 + 1e-9);
  assert.throws(() => placeBox(0.95, 0.1, { x: .5, y: .5 }, area, []), /does not fit/);
});

test('a lower third goes to the side away from the presenter and never covers the face', () => {
  const face = { x: 0.32, y: 0.5, w: 0.36, h: 0.4 };
  const r = compilePreset({ kind: 'lower_third', title: 'Dr. Ananya Rao', subtitle: 'Cardiologist', platform: 'reels', avoid: [face] }, { ratio: '9:16' });
  const panel = r.spec.layers.find((l) => l.id === 'panel')!;
  assert.ok(panel.x > 0.5, `panel on the right: x=${panel.x}`);
  const ov = Math.max(0, Math.min(panel.x + panel.w / 2, face.x + face.w / 2) - Math.max(panel.x - panel.w / 2, face.x - face.w / 2)) *
    Math.max(0, Math.min(panel.y + panel.h / 2, face.y + face.h / 2) - Math.max(panel.y - panel.h / 2, face.y - face.h / 2));
  assert.equal(ov, 0);
  // and above the lower caption band (top at 0.63 in 9:16)
  assert.ok(panel.y + panel.h / 2 <= 0.631, `panel bottom ${panel.y + panel.h / 2}`);
});

test('a callout label never covers its own target', () => {
  for (const target of [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.5 }, { x: 0.5, y: 0.45 }]) {
    const r = compilePreset({ kind: 'callout', target, label: 'Battery health', platform: 'reels' }, { ratio: '9:16' });
    const l = r.spec.layers.find((x) => x.id === 'label')!;
    const inside = target.x > l.x - l.w / 2 && target.x < l.x + l.w / 2 && target.y > l.y - l.h / 2 && target.y < l.y + l.h / 2;
    assert.ok(!inside, `label covers target ${JSON.stringify(target)}`);
  }
});

test('type scales with the frame: portrait headlines are mobile-legible (≥ 80 px at 1080×1920)', () => {
  const r = compilePreset({ kind: 'kinetic_title', title: 'Short', platform: 'reels' }, { ratio: '9:16' });
  const head = (r.spec.styles ?? []).find((s) => s.id === 'head')!;
  assert.ok(head.size >= 80, `headline ${head.size}px`);
  const long = fitText('A considerably longer headline that has to wrap onto two lines at most', 'bold', 900, 260, 104, 40, 2);
  assert.ok(long.lines <= 2 && long.size < 104);
});

test('ui_demo cursor arrives at each click on time', () => {
  const r = compilePreset({ kind: 'ui_demo', asset: 'i1', clicks: [{ x: 0.2, y: 0.3, t: 1 }, { x: 0.8, y: 0.7, t: 3 }], duration: 4, platform: 'youtube' }, { ratio: '16:9' });
  const cursor = r.spec.layers.find((l) => l.id === 'cursor') as { motionPath: { keys: { t: number; p: number }[] } };
  const keys = cursor.motionPath.keys;
  assert.equal(keys[keys.length - 1]!.p, 1);
  assert.ok(Math.abs(keys[1]!.t - 0.85) < 1e-9 && Math.abs(keys[2]!.t - 2.85) < 1e-9, JSON.stringify(keys));
});

test('compileIntent routes preset kinds and every style profile is complete', () => {
  const r = compileIntent({ kind: 'kinetic_title', title: 'Hello' }, { ratio: '9:16' });
  assert.equal(r.ops[0]!.op, 'scene');
  for (const [name, p] of Object.entries(STYLE_PROFILES)) {
    for (const k of ['panel', 'text', 'muted', 'accent', 'accentText', 'line'] as const) assert.match(p.palette[k], /^#[0-9A-Fa-f]{6,8}$/, `${name}.${k}`);
  }
  assert.throws(() => compilePreset({ kind: 'callout', label: 'x' }), /needs target/);
});
