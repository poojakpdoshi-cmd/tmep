/**
 * Phase 7.4 verified correction engine through the public production API: an objective defect is fixed
 * on a new revision, the affected range is previewed, the fix is kept only when re-inspection confirms
 * it; a fix that would contradict an explicit instruction is refused; the editorial Inspector reports
 * classes and never claims creative quality.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as api from '../packages/engine/src/api.ts';
import { produce, conflicts } from '../packages/engine/src/production.ts';
import { ffmpeg } from '../packages/media/src/ffmpeg.ts';

test('corrections never contradict explicit instructions', () => {
  assert.match(conflicts([{ op: 'captions', pos: 'upper' }], { captions: false }) ?? '', /declined/);
  assert.match(conflicts([{ op: 'color', saturation: 1.2 }], {}) ?? '', /authorization/);
  assert.equal(conflicts([{ op: 'color', clear: true }], {}), undefined, 'removing a look is always allowed');
  assert.match(conflicts([{ op: 'format', ratio: '1:1' }], { ratio: '9:16' }) ?? '', /9:16/);
  assert.equal(conflicts([{ op: 'trim', clip: 'c1', in: 0.1 }], { zooms: false }), undefined);
});

test('production: objective defects are corrected and verified; the best revision is kept', { timeout: 400_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frame-fix-'));
  const prev = process.env.FRAME_MODELS; process.env.FRAME_MODELS = path.join(dir, 'none');
  try {
    const ctx: api.Ctx = { project: dir, detail: 'debug' };
    const src = path.join(dir, 'talk.mp4');
    await ffmpeg({ args: ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=8', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src] });
    await api.importMedia(ctx, { paths: [src] });
    const w = (t: string, s0: number) => t.split(' ').map((x, i) => ({ w: x, s: s0 + i * 0.35, e: s0 + i * 0.35 + 0.3 }));
    const truth = path.join(dir, 'words.json');
    await writeFile(truth, JSON.stringify({ words: [...w('Our revenue grew 40 percent this year.', 0.2), ...w('Thanks for watching.', 4)] }));
    await api.transcribe(ctx, { asset: 'v1', file: truth });
    // Overrides plant two defects the Director would not make: a cut through "Our" and a colour look.
    const r = await produce(ctx, { action: 'start', id: 'fix', asset: 'v1', genre: 'informative', constraints: { ratio: '9:16' },
      overrides: { roughcut: { ops: [{ op: 'format', ratio: '9:16' }, { op: 'keep', src: 'v1', ranges: [[0.35, 2.8], [4, 5.2]] }] }, finish: { ops: [{ op: 'color', saturation: 1.4 }] } } }) as any;
    const out = r.stages.correct.out;
    const verdict = (code: string) => out.attempts.find((a: any) => a.finding.startsWith(code))?.verdict;
    assert.equal(verdict('clipped-word'), 'accepted', JSON.stringify(out.attempts));
    assert.equal(verdict('unauthorized-look'), 'accepted', JSON.stringify(out.attempts));
    assert.ok(out.attempts.some((a: any) => a.preview), 'the affected range was previewed');
    const p = await api.openProject(dir, false);
    assert.equal((await p.manifest()).head, out.rev, 'the best verified revision is current');
    const tl = await p.timeline();
    assert.equal(tl.color, undefined, 'the unauthorized look is gone');
    assert.ok(tl.clips[0]!.in <= 0.2, `the cut no longer clips "Our" (in=${tl.clips[0]!.in})`);
    assert.match(out.note, /not proof of creative quality/);
    const qa = await api.inspect(ctx, { what: 'qa', constraints: { ratio: '9:16' } }) as any;
    assert.equal(qa.editorial.objective, 0, JSON.stringify(qa.findings.filter((f: any) => f.class === 'objective')));
    assert.ok(qa.findings.every((f: any) => !f.class || ['objective', 'advisory', 'preference'].includes(f.class)));
  } finally { if (prev === undefined) delete process.env.FRAME_MODELS; else process.env.FRAME_MODELS = prev; await rm(dir, { recursive: true, force: true }); }
});
