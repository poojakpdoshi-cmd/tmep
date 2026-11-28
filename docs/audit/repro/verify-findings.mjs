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

async function check(name, fn) {
  try {
    results[name] = { ok: true, ...(await fn()) };
  } catch (e) {
    results[name] = { ok: false, code: e.code ?? 'ERR', message: e.message ?? String(e) };
  }
}

try {
  // 1. Concurrency race in api.edit()
  const p1Dir = path.join(tmpRoot, 'concurrency');
  const p1 = await Project.open(p1Dir, { create: true });
  await p1.addAsset({
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
    clips: [{ id: 'c1', src: 'v1', in: 0, out: 10, speed: 1, fit: 'cover', vol: 1, mute: false, cx: 0.5, cy: 0.5, base: 1, push: 0, zoom: [] }],
  };
  await p1.commit(tl1, [], 'init');

  await check('1_concurrentEdits', async () => {
    await Promise.all([
      api.edit({ project: p1Dir }, { ops: ['gfx title 0 2 props.text="Edit A"'], note: 'A' }),
      api.edit({ project: p1Dir }, { ops: ['gfx title 3 2 props.text="Edit B"'], note: 'B' }),
      api.edit({ project: p1Dir }, { ops: ['gfx title 6 2 props.text="Edit C"'], note: 'C' }),
    ]);
    const finalTl = await (await Project.open(p1Dir)).timeline();
    return {
      submitted: 3,
      survivingGfxCount: finalTl.gfx.length,
      survivingTitles: finalTl.gfx.map((g) => g.props?.text),
      remediated: finalTl.gfx.length === 3,
    };
  });

  // 2a. Non-integer revision rejected
  await check('2a_nonIntegerRevision', async () => {
    try {
      await p1.revision(1.5);
      return { rejected: false };
    } catch (e) {
      return { rejected: true, code: e.code, message: e.message, remediated: e.code === 'E_INPUT' };
    }
  });

  // 2b. jobPath traversal rejected
  await check('2b_jobPathTraversal', async () => {
    try {
      const traversedJobPath = p1.jobPath('../tmep');
      return { rejected: false, traversedJobPath };
    } catch (e) {
      return { rejected: true, code: e.code, message: e.message, remediated: e.code === 'E_SECURITY' };
    }
  });

  // 2c. Render out path traversal rejected
  await check('2c_renderOutTraversal', async () => {
    try {
      await api.render({ project: p1Dir, outRoots: [p1Dir] }, { out: '../outside-overwrite.mp4', wait: 1 });
      return { rejected: false };
    } catch (e) {
      return { rejected: true, code: e.code, message: e.message, remediated: e.code === 'E_SECURITY' };
    }
  });

  // 2d. External import outside workspace/mediaRoots rejected
  await check('2d_importOutsideRoot', async () => {
    const outsideFile = path.join(tmpRoot, 'outside-secret.mp4');
    await fs.writeFile(outsideFile, 'dummy');
    try {
      await api.importMedia({ project: p1Dir, mediaRoots: [p1Dir] }, { paths: [outsideFile] });
      return { rejected: false };
    } catch (e) {
      return { rejected: true, code: e.code, message: e.message, remediated: e.code === 'E_SECURITY' };
    }
  });

  // 3. Reused footage anchor resolution + zoom op
  await check('3_reusedFootageAnchor', async () => {
    const tlReused = {
      ...emptyTimeline(),
      clips: [
        { id: 'c1', src: 'a1', in: 0, out: 4, speed: 1, fit: 'cover', cx: 0.5, cy: 0.5, base: 1, push: 0, vol: 1, mute: false, zoom: [] },
        { id: 'c2', src: 'a1', in: 0, out: 4, speed: 1, fit: 'cover', cx: 0.5, cy: 0.5, base: 1, push: 0, vol: 1, mute: false, zoom: [] },
      ],
    };
    const placedReused = layout(tlReused);
    const refAt6s = anchorAt(placedReused, 6.0);
    const resolvedTlTime = resolveRef(placedReused, refAt6s);
    const afterZoom = applyOps(tlReused, ['zoom 6 1.25 1'], {
      transcripts: {},
      assets: { a1: { id: 'a1', path: 'a1.mp4', hash: 'h1', kind: 'video', dur: 10, w: 1080, h: 1920, fps: 30, audio: true } },
    });
    const zoomAttachedToClipId = afterZoom.tl.clips.find((c) => c.zoom?.length)?.id ?? null;
    return {
      requestedTlTime: 6.0,
      anchorRef: refAt6s,
      resolvedTlTime,
      zoomAttachedToClipId,
      remediated: refAt6s?.clip === 'c2' && Math.abs((resolvedTlTime ?? 0) - 6.0) < 0.05 && zoomAttachedToClipId === 'c2',
    };
  });

  // 4. Frame-rounding tail / 1ms anchorAt rounding
  await check('4_frameRoundingTail', async () => {
    const tlTailUp = {
      ...emptyTimeline('9:16', 30),
      clips: [{ id: 'c1', src: 'a1', in: 0, out: 1.017, speed: 1, fit: 'cover', cx: 0.5, cy: 0.5, base: 1, push: 0, vol: 1, mute: false, zoom: [] }],
    };
    const placedTailUp = layout(tlTailUp);
    const refTail = anchorAt(placedTailUp, placedTailUp[0].dur - 0.001);
    const resolvedBack = resolveRef(placedTailUp, refTail) ?? null;
    return {
      clipOut: 1.017,
      quantizedDur: placedTailUp[0].dur,
      refAtTail: refTail,
      resolvedBack,
      remediated: resolvedBack !== null,
    };
  });

  // 5. video_inspect read-only on non-existent dir
  await check('5_readOnlyInspect', async () => {
    const inspectDir = path.join(tmpRoot, 'readonly-inspect-test');
    let errCode = null;
    try {
      await api.inspect({ project: inspectDir }, { what: 'project' });
    } catch (e) {
      errCode = e.code;
    }
    const dirExists = await fs.access(inspectDir).then(() => true, () => false);
    return {
      errCode,
      dirExists,
      remediated: !dirExists,
    };
  });

  // 6. Token estimates
  await check('6_tokens', async () => {
    const toolsJson = JSON.stringify(toolList());
    const helpSb = JSON.stringify(await api.help('storyboard'));
    const helpScene = JSON.stringify(await api.help('scene'));
    return {
      toolListBytes: toolsJson.length,
      toolListEstTokens: estimateTokens(toolsJson),
      helpStoryboardBytes: helpSb.length,
      helpStoryboardEstTokens: estimateTokens(helpSb),
      helpSceneBytes: helpScene.length,
      helpSceneEstTokens: estimateTokens(helpScene),
      remediated: estimateTokens(helpSb) < 500 && estimateTokens(helpScene) < 500,
    };
  });

  console.log(JSON.stringify(results, null, 2));
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
