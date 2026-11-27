import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { compileIntent } from '../src/compiler.ts';
import { Project, emptyTimeline, newClip } from '../../core/src/index.ts';
import { McpServer } from '../../mcp/src/server.ts';

test('compiler: compiles all 5 intent kinds with platform safe-zones and deterministic corrections', () => {
  const explainer = compileIntent({
    kind: 'explainer_card',
    platform: 'reels',
    theme: 'dark',
    motion: 'editorial',
    title: 'Deterministic Local Compilation Reduces Agent Token Overhead Significantly',
    subtitle: 'Layout, wrapping, and safe zones happen locally.',
    badge: 'FRAME',
  });
  assert.equal(explainer.ops.length, 1);
  assert.ok(explainer.corrections.some((c) => c.code === 'caption-avoidance'));
  assert.ok(explainer.corrections.some((c) => c.code === 'font-shrink'));

  const demo = compileIntent({
    kind: 'product_demo',
    asset: 'i1',
    title: 'Live Product Frame',
    platform: 'youtube',
    ratio: '16:9',
  });
  assert.ok(demo.spec.layers.some((l) => l.kind === 'image' && l.asset === 'i1'));

  const sports = compileIntent({
    kind: 'sports_stat',
    title: 'Match Telemetry',
    chart: { chartType: 'hbar', data: [{ label: 'Possession', value: 64 }, { label: 'Shots', value: 18 }], max: 100, unit: '%' },
  });
  assert.ok(sports.spec.layers.some((l) => l.kind === 'chart'));

  const diagram = compileIntent({
    kind: 'diagram',
    title: 'Three-Stage Pipeline',
    steps: ['Ingest footage', 'Compile layout', 'Verify frames'],
  });
  assert.equal(diagram.spec.layers.filter((l) => l.id.startsWith('step')).length, 3);

  const talk = compileIntent({
    kind: 'talking_head_callout',
    title: 'Key Takeaway',
    subtitle: 'Reserved presenter avoids overlap',
    reservePresenter: { x: 0.5, y: 0.72, w: 0.8, h: 0.4 },
  });
  assert.ok(talk.corrections.some((c) => c.code === 'presenter-avoidance'));
});

test('compiler: MCP video_plan supports intent + dryRun without mutating revisions', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-compiler-mcp-'));
  const srv = new McpServer({ cwd: dir });
  try {
    const p = await Project.open(dir, { create: true });
    await p.addAsset({ path: path.join(dir, 'v1.mp4'), name: 'v1.mp4', size: 100, hash: 'h1', kind: 'video', dur: 10, w: 1080, h: 1920, fps: 30, audio: true });
    const tl = emptyTimeline('9:16', 30);
    tl.clips.push(newClip(tl, 'v1', 0, 6));
    await p.commit(tl, [], 'init');

    const dry = (await srv.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'video_plan',
        arguments: {
          dryRun: true,
          intent: { kind: 'explainer_card', title: 'Dry Run Card', subtitle: 'Does not commit', at: 0, duration: 2 },
        },
      },
    })) as any;
    const dryBody = JSON.parse(dry.result.content[0].text);
    assert.equal(dryBody.dryRun, true);
    assert.equal((await p.manifest()).revs, 1);

    const commit = (await srv.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'video_plan',
        arguments: {
          intent: { kind: 'explainer_card', title: 'Committed Card', subtitle: 'Persists rev 2', at: 0, duration: 2 },
        },
      },
    })) as any;
    const commitBody = JSON.parse(commit.result.content[0].text);
    assert.equal(commitBody.rev, 2);
    assert.equal((await p.manifest()).revs, 2);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
