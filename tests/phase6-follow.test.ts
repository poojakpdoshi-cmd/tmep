/** Phase 6: subject-follow reframe keys render as a moving crop (decoded frames keep the subject centred). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as api from '../packages/engine/src/api.ts';
import { ffmpeg } from '../packages/media/src/ffmpeg.ts';
import { centreToOffset } from '../packages/media/src/semantic.ts';

test('follow keys move the 9:16 crop with a travelling subject', { timeout: 180_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frame-follow-'));
  try {
    const src = path.join(dir, 'run.mp4');
    // A white 60×120 box crosses a 640×360 frame left → right over 4 s (centre x from 0.1 to 0.9).
    await ffmpeg({ args: ['-f', 'lavfi', '-i', 'color=c=0x202020:s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'color=c=white:s=60x120:r=30:d=4', '-filter_complex', "[0][1]overlay=x='34+t*128':y=120", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src] });
    const ctx: api.Ctx = { project: dir, detail: 'standard' };
    await api.importMedia(ctx, { paths: [src] });
    await api.edit(ctx, { ratio: '9:16', ops: [{ op: 'add', src: 'v1', in: 0, out: 4 }, { op: 'reframe', clip: 'c1', follow: [0, 1, 2, 3, 4].map((t) => ({ t, cx: centreToOffset((64 + 128 * t) / 640, (360 * 9) / 16 / 640), cy: 0.5 })) }] });
    await assert.rejects(api.edit(ctx, { ops: [{ op: 'reframe', clip: 'c1', follow: '2:0.5;1:0.5' }] }), /increasing t/);
    const out = path.join(dir, 'renders', 'f.mp4');
    const r = await api.render(ctx, { out, preview: true, wait: 150 });
    assert.equal(r.state, 'done', JSON.stringify(r));
    // Decode at 1, 2, 3 s and find the white box's horizontal centre in the 9:16 output.
    for (const t of [1, 2, 3]) {
      const d = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'scale=90:160,format=gray', '-f', 'rawvideo', '-']).stdout as Buffer;
      let sx = 0, n = 0;
      for (let y = 0; y < 160; y++) for (let x = 0; x < 90; x++) if (d[y * 90 + x]! > 200) { sx += x; n++; }
      assert.ok(n > 50, `box visible at ${t}s (${n} px)`);
      assert.ok(Math.abs(sx / n / 90 - 0.5) < 0.12, `box centred at ${t}s: x=${(sx / n / 90).toFixed(2)}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
