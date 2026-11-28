/**
 * Phase 5 through the public API: asset library (licences, search, duplicates, recommendations and
 * requests), structured editing plan (build, override, dry-run, compile, revision safety, incremental
 * refresh), semantic capability reporting when models are absent, and model plans without downloads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as api from '../packages/engine/src/api.ts';
import { ffmpeg } from '../packages/media/src/ffmpeg.ts';

test('library + structured plan end to end', { timeout: 180_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frame-p5-'));
  const prevModels = process.env.FRAME_MODELS;
  process.env.FRAME_MODELS = path.join(dir, 'no-models');
  try {
    const ctx: api.Ctx = { project: dir, detail: 'standard' };
    const src = path.join(dir, 'talk.mp4');
    await ffmpeg({ args: ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=12', '-f', 'lavfi', '-i', "sine=frequency=300:sample_rate=48000:duration=12,volume='if(between(t,4,6),0,1)':eval=frame", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src] });
    const chart = path.join(dir, 'revenue-chart.png'), chart2 = path.join(dir, 'revenue-chart-copy.png'), icon = path.join(dir, 'rocket.svg');
    await ffmpeg({ args: ['-f', 'lavfi', '-i', 'testsrc=s=320x180', '-frames:v', '1', chart] });
    await ffmpeg({ args: ['-f', 'lavfi', '-i', 'testsrc=s=320x180,eq=brightness=0.02', '-frames:v', '1', chart2] });
    await writeFile(icon, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>rocket launch</title><path d="M12 2l3 7H9z"/></svg>');
    await api.importMedia(ctx, { paths: [src] });
    const words = [
      ['Our', 0.2], ['revenue', 0.5], ['grew', 0.9], ['40', 1.2], ['percent', 1.5], ['this', 1.9], ['year.', 2.1],
      ['Then', 6.3], ['we', 6.6], ['launched', 6.9], ['the', 7.3], ['rocket', 7.5], ['program.', 7.9],
      ['Open', 9.0], ['the', 9.3], ['settings', 9.5], ['screen', 9.9], ['and', 10.2], ['click', 10.4], ['save.', 10.7],
    ].map(([w, s]) => ({ w: w as string, s: s as number, e: (s as number) + 0.25 }));
    const truth = path.join(dir, 'words.json');
    await writeFile(truth, JSON.stringify({ words }));
    await api.transcribe(ctx, { asset: 'v1', file: truth });

    // Library: licences recorded, unknown licences flagged, near-duplicates found, SVG text indexed.
    const add1 = await api.library(ctx, { action: 'add', paths: [chart], meta: { kind: 'chart', title: 'Revenue growth chart', tags: ['revenue', 'growth', 'percent'], licence: { id: 'owned' } } }) as any;
    assert.equal(add1.added[0].verified, true);
    const add2 = await api.library(ctx, { action: 'add', paths: [chart2, icon], meta: { tags: ['launch'] } }) as any;
    assert.equal(add2.added[0].licence, 'unknown');
    assert.ok(add2.duplicates?.some((d: any) => d.kind === 'near'), JSON.stringify(add2));
    const found = await api.library(ctx, { action: 'search', query: 'rocket' }) as any;
    assert.equal(found.results[0].id, 'L3', 'SVG <title> is searchable');
    assert.equal(found.results[0].usable, false, 'no licence → not usable');
    await assert.rejects(api.library(ctx, { action: 'search', query: 'x', kind: 'gif' }), /unknown asset kind/);
    await api.library(ctx, { action: 'licence', id: 'L3', meta: { licence: { id: 'CC0-1.0', source: 'test' } } });
    const rec = await api.inspect(ctx, { what: 'library', asset: 'v1', ...({ action: 'recommend' } as object) }) as any;
    assert.ok(rec.recommendations.some((r: any) => r.asset === 'L1' && r.at[0] < 1), JSON.stringify(rec));
    assert.ok(rec.recommendations.some((r: any) => r.asset === 'L3'), 'licence update makes the icon usable');
    const demo = rec.requests.find((r: any) => r.kind === 'screen-recording');
    assert.ok(demo && demo.mustBeGenuine && demo.at[0] >= 9, 'a UI walkthrough is requested as a genuine recording, not synthesized');

    // Semantic layer without models: reported as unavailable, never guessed; model plan downloads nothing.
    const fa = await api.inspect({ ...ctx, detail: 'debug' }, { what: 'footage', asset: 'v1', semantic: true }) as any;
    assert.equal(fa.capabilities.semantic.status, 'unavailable');
    assert.match(fa.capabilities.semantic.reason, /models not installed/);
    assert.equal(fa.observed.tracks, undefined);
    const plan0 = await api.models({ install: ['objects'] }) as any;
    assert.deepEqual(plan0.installed, []);
    assert.equal(plan0.planned[0].licence, 'Apache-2.0');

    // Structured plan.
    const built = await api.editPlan(ctx, { action: 'build', asset: 'v1', task: 'informative' }) as any;
    const kinds = built.items.map((i: any) => i.kind);
    assert.ok(kinds.includes('retain') && kinds.includes('captions') && kinds.includes('graphic') && kinds.includes('asset'), kinds.join(','));
    const retain = built.items.find((i: any) => i.kind === 'retain');
    assert.equal(retain.ops[0].ranges.length, 3, 'two pauses ≥ 0.8 s split the speech');
    assert.ok(built.assetRequests.some((r: any) => r.kind === 'screen-recording'));
    const dry = await api.editPlan(ctx, { action: 'compile', asset: 'v1', task: 'informative', dryRun: true }) as any;
    assert.ok(dry.dryRun);
    assert.ok(dry.ops.some((o: any) => o.op === 'gfx' && o.preset === 'stat'), JSON.stringify(dry.ops));
    // Override: drop every library asset → deterministic compile with no imports; graphic time is mapped.
    const assetIds = built.items.filter((i: any) => i.kind === 'asset').map((i: any) => i.id);
    await api.editPlan(ctx, { action: 'override', asset: 'v1', task: 'informative', overrides: Object.fromEntries(assetIds.map((id: string) => [id, 'drop'])) });
    const c1 = await api.editPlan(ctx, { action: 'compile', asset: 'v1', task: 'informative', dryRun: true }) as any;
    const c2 = await api.editPlan(ctx, { action: 'compile', asset: 'v1', task: 'informative', dryRun: true }) as any;
    assert.deepEqual(c1.ops, c2.ops, 'compile is deterministic');
    assert.ok(!c1.ops.some((o: any) => o.op === 'broll'));
    const applied = await api.editPlan(ctx, { action: 'compile', asset: 'v1', task: 'informative' }) as any;
    assert.ok(applied.rev >= 1, JSON.stringify(applied));
    // Revision safety: the head moved, so compiling the same plan again is refused unless rebased.
    await assert.rejects(api.editPlan(ctx, { action: 'compile', asset: 'v1', task: 'informative' }), /moved from rev/);
    // Incremental refresh. The compile created the timeline (its format is now known), so a first refresh
    // recomputes format-dependent items; then a library-only change recomputes only library items.
    const f0 = await api.editPlan(ctx, { action: 'refresh', asset: 'v1', task: 'informative' }) as any;
    assert.deepEqual(f0.changed, ['format']);
    await api.library(ctx, { action: 'licence', id: 'L2', meta: { licence: { id: 'CC-BY-4.0', attribution: 'test' } } });
    const fr = await api.editPlan(ctx, { action: 'refresh', asset: 'v1', task: 'informative' }) as any;
    assert.deepEqual(fr.changed, ['library']);
    assert.ok(fr.kept > 0 && fr.items.filter((i: any) => i.recomputed).every((i: any) => i.kind === 'asset'), JSON.stringify(fr.items.map((i: any) => [i.kind, i.recomputed])));
  } finally {
    if (prevModels === undefined) delete process.env.FRAME_MODELS; else process.env.FRAME_MODELS = prevModels;
    await rm(dir, { recursive: true, force: true });
  }
});
