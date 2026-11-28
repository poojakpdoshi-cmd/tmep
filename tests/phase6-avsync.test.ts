/** Phase 6: av-sync uses decoded audio length (AAC container padding is not drift); real drift is still a defect. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as api from '../packages/engine/src/api.ts';
import { ffmpeg } from '../packages/media/src/ffmpeg.ts';

test('av-sync: padding is not drift, half a second is', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frame-avsync-'));
  try {
    const ctx: api.Ctx = { project: dir, detail: 'standard' };
    const src = path.join(dir, 'src.mp4');
    await ffmpeg({ args: ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2.0333', '-f', 'lavfi', '-i', 'sine=f=440:d=2.0333:sample_rate=48000', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src] });
    await api.importMedia(ctx, { paths: [src] });
    await api.edit(ctx, { ratio: '16:9', ops: [{ op: 'add', src: 'v1', in: 0, out: 2.0333 }] });
    const out = path.join(dir, 'renders', 'a.mp4');
    const r = await api.render(ctx, { out, preview: true, wait: 120 }) as { state: string };
    assert.equal(r.state, 'done');
    const ok = await api.inspect(ctx, { what: 'qa', file: out }) as { findings: { code: string }[] };
    assert.ok(!ok.findings.some((f) => f.code === 'av-sync'), JSON.stringify(ok.findings));
    const drift = path.join(dir, 'renders', 'drift.mp4');
    await ffmpeg({ args: ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2.0333', '-f', 'lavfi', '-i', 'sine=f=440:d=2.55:sample_rate=48000', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', drift] });
    const bad = await api.inspect(ctx, { what: 'qa', file: drift }) as { findings: { code: string; msg: string }[] };
    assert.ok(bad.findings.some((f) => f.code === 'av-sync' && /decoded/.test(f.msg)), JSON.stringify(bad.findings));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
