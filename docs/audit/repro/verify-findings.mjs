import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as api from '../../../packages/engine/src/api.ts';
import { Project } from '../../../packages/core/src/project.ts';
import { emptyTimeline, anchorAt, resolveRef, layout } from '../../../packages/core/src/timeline.ts';
import { applyOps } from '../../../packages/core/src/ops.ts';
import { toolList } from '../../../packages/mcp/src/tools.ts';
import { estimateTokens } from '../../../bench/tokens.ts';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-audit-repro-'));
const results = {};

try {
  // 1. Concurrency race in api.edit()
  const p1Dir = path.join(tmpRoot, 'concurrency');
  const p1 = await Project.open(p1Dir, { create: true });
  const asset = await p1.addAsset({
    path: path.join(p1Dir, 'a1.mp4'),
    hash: 'h1',
    kind: 'video',
    dur: 10,
    w: 1080,
    h: 1920,
    fps: 30,
    audio: true,
  });
  const tl1 = {
    ...emptyTimeline(),
    clips: [{ id: 'c1', src: 'v1', in: 0, out: 10, speed: 1, fit: 'cover', vol: 1 }],
  };
  await p1.commit(tl1, [], 'init');
  await Promise.all([
    api.edit({ project: p1Dir }, { ops: ['gfx title 0 2 props.text="Edit A"'], note: 'A' }),
    api.edit({ project: p1Dir }, { ops: ['gfx title 3 2 props.text="Edit B"'], note: 'B' }),
    api.edit({ project: p1Dir }, { ops: ['gfx title 6 2 props.text="Edit C"'], note: 'C' }),
  ]);
  const finalTl = await (await Project.open(p1Dir)).timeline();
  results.concurrentEdits = {
    submitted: 3,
    survivingGfxCount: finalTl.gfx.length,
    survivingTitles: finalTl.gfx.map((g) => g.props?.text),
  };

  // 2. Non-integer revision & jobPath traversal
  let revFloatErr = null;
  try {
    await p1.revision(1.5);
  } catch (e) {
    revFloatErr = { code: e.code, message: e.message };
  }
  const traversedJobPath = p1.jobPath('../tmep');
  results.pathAndRevision = {
    revFloatErr,
    jobPathTraversalResolved: path.relative(p1.dir, traversedJobPath).replace(/\\/g, '/'),
  };

  // 3. Reused footage anchor resolution + zoom op
  const tlReused = {
    ...emptyTimeline(),
    clips: [
      { id: 'c1', src: 'a1', in: 0, out: 4, speed: 1, fit: 'cover', vol: 1, zoom: [] },
      { id: 'c2', src: 'a1', in: 0, out: 4, speed: 1, fit: 'cover', vol: 1, zoom: [] },
    ],
  };
  const placedReused = layout(tlReused);
  const refAt6s = anchorAt(placedReused, 6.0);
  const resolvedTlTime = resolveRef(placedReused, refAt6s);
  const afterZoom = applyOps(tlReused, ['zoom 6 1.25 1'], {
    transcripts: {},
    assets: { a1: { id: 'a1', path: 'a1.mp4', hash: 'h1', kind: 'video', dur: 10, w: 1080, h: 1920, fps: 30, audio: true } },
  });
  results.reusedFootageAnchor = {
    requestedTlTime: 6.0,
    anchorRef: refAt6s,
    resolvedTlTime,
    zoomAttachedToClipId: afterZoom.tl.clips.find((c) => c.zoom?.length)?.id ?? null,
  };

  // 4. Frame-rounding tail / 1ms anchorAt rounding
  const tlTailUp = {
    ...emptyTimeline('9:16', 30),
    clips: [{ id: 'c1', src: 'a1', in: 0, out: 1.017, speed: 1, fit: 'cover', vol: 1 }],
  };
  const placedTailUp = layout(tlTailUp);
  const refTail = anchorAt(placedTailUp, placedTailUp[0].dur - 0.001);
  results.frameRoundingTail = {
    clipOut: 1.017,
    quantizedDur: placedTailUp[0].dur,
    refAtTail: refTail,
    resolvedBack: resolveRef(placedTailUp, refTail) ?? null,
  };

  // 5. video_inspect creating project on non-existent dir
  const inspectDir = path.join(tmpRoot, 'readonly-inspect-test');
  await api.inspect({ project: inspectDir }, { what: 'project' });
  const createdFiles = await fs.readdir(inspectDir);
  results.readOnlyInspectMutatesDisk = {
    createdFiles: createdFiles.sort(),
  };

  // 6. Token estimates
  const toolsJson = JSON.stringify(toolList());
  const helpSb = JSON.stringify(await api.help('storyboard'));
  const helpScene = JSON.stringify(await api.help('scene'));
  results.tokens = {
    toolListBytes: toolsJson.length,
    toolListEstTokens: estimateTokens(toolsJson),
    helpStoryboardBytes: helpSb.length,
    helpStoryboardEstTokens: estimateTokens(helpSb),
    helpSceneBytes: helpScene.length,
    helpSceneEstTokens: estimateTokens(helpScene),
  };

  console.log(JSON.stringify(results, null, 2));
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
