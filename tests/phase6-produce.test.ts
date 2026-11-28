/**
 * Phase 6 production orchestrator through the public API: full run to correction, persistence,
 * dependency-aware revision (only affected stages recompute), per-stage revisions, cancellation and
 * resume, explicit constraints honoured, open decisions reported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as api from '../packages/engine/src/api.ts';
import { produce } from '../packages/engine/src/production.ts';
import { ffmpeg } from '../packages/media/src/ffmpeg.ts';

test('production: run, revise incrementally, cancel and resume', { timeout: 400_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frame-prod-'));
  const prev = process.env.FRAME_MODELS; process.env.FRAME_MODELS = path.join(dir, 'none');
  try {
    const ctx: api.Ctx = { project: dir, detail: 'debug' };
    const src = path.join(dir, 'talk.mp4');
    await ffmpeg({ args: ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=14', '-f', 'lavfi', '-i', "sine=frequency=300:sample_rate=48000:duration=14,volume='if(between(t,4,6)+between(t,9,10.5),0,1)':eval=frame", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src] });
    await api.importMedia(ctx, { paths: [src] });
    const w = (t: string, s0: number) => t.split(' ').map((x, i) => ({ w: x, s: s0 + i * 0.35, e: s0 + i * 0.35 + 0.3 }));
    const words = [...w('Our revenue grew 40 percent this year.', 0.2), ...w('First we hired, then we trained, and finally we shipped.', 6.3), ...w('Thanks for watching.', 11)];
    const truth = path.join(dir, 'words.json'); await writeFile(truth, JSON.stringify({ words }));
    await api.transcribe(ctx, { asset: 'v1', file: truth });

    await assert.rejects(produce(ctx, { action: 'start', asset: 'v1', genre: 'vlog' as never }), /genre must be/);
    const r1 = await produce(ctx, { action: 'start', id: 'demo', asset: 'v1', genre: 'informative', constraints: { ratio: '9:16', target: 6 } }) as any;
    assert.deepEqual(Object.values(r1.report.stages).slice(0, 12), Array(12).fill('done'), JSON.stringify(r1.report.stages));
    assert.equal(r1.report.stages.final, 'pending', 'final render only on request');
    assert.ok(r1.stages.roughcut.out.seconds <= 6.05, `rough cut fits the 6 s target (${r1.stages.roughcut.out.seconds})`);
    assert.ok(r1.stages.roughcut.out.droppedSentences >= 1);
    assert.ok(Object.keys(r1.report.revisions).length >= 4, 'each editing stage commits its own revision');
    assert.ok(r1.report.openDecisions.some((d: string) => /music/.test(d)), 'music is left to the user');
    assert.ok(r1.strategy.decisions.some((d: any) => /no background change/.test(d.what)));
    const state = JSON.parse(await readFile(path.join(dir, '.tmep', 'productions', 'demo.json'), 'utf8'));
    assert.equal(state.schema, 'frame.production/1');

    // Revise one constraint: only the stages that depend on it recompute.
    const r2 = await produce(ctx, { action: 'revise', id: 'demo', constraints: { captions: false } }) as any;
    assert.ok(!r2.recomputed.includes('roughcut') && !r2.recomputed.includes('motion'), `recomputed ${r2.recomputed}`);
    assert.ok(r2.recomputed.includes('strategy') && r2.recomputed.includes('fine'), `recomputed ${r2.recomputed}`);
    const tl = await (await api.openProject(dir, false)).timeline();
    assert.equal(tl.captions.style, 'none', 'explicit captions:false is applied');
    assert.ok(r2.strategy.decisions.some((d: any) => d.source === 'user' && /captions/.test(d.what)));

    // Nothing changed → nothing recomputes.
    const r3 = await produce(ctx, { action: 'resume', id: 'demo' }) as any;
    assert.deepEqual(r3.recomputed, []);

    // Cancellation leaves a resumable state.
    const ac = new AbortController(); ac.abort();
    await assert.rejects(produce(ctx, { action: 'revise', id: 'demo', constraints: { zooms: false } }, ac.signal), /cancelled/);
    const r4 = await produce(ctx, { action: 'resume', id: 'demo' }) as any;
    assert.ok(r4.recomputed.includes('fine'), 'the revision is completed on resume');
    assert.equal(r4.strategy.zooms.allowed, false);
  } finally { if (prev === undefined) delete process.env.FRAME_MODELS; else process.env.FRAME_MODELS = prev; await rm(dir, { recursive: true, force: true }); }
});
