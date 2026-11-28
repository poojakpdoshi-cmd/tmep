/** Phase 6 licence audit: declared vs independently verified (attribution record, embedded metadata). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as api from '../packages/engine/src/api.ts';
import { ffmpeg } from '../packages/media/src/ffmpeg.ts';
import { licenceMentioned } from '../packages/media/src/library.ts';

test('licences: declared until evidence verifies them; changing the claim drops the verification', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frame-lic-'));
  const prev = process.env.FRAME_MODELS; process.env.FRAME_MODELS = path.join(dir, 'none');
  try {
    const ctx: api.Ctx = { project: dir, detail: 'standard' };
    const a = path.join(dir, 'Sports_360P-11b7_clip.mp4'), b = path.join(dir, 'tagged.mp4'), c = path.join(dir, 'plain.png');
    await ffmpeg({ args: ['-f', 'lavfi', '-i', 'testsrc=s=160x90:d=1', '-pix_fmt', 'yuv420p', a] });
    await ffmpeg({ args: ['-f', 'lavfi', '-i', 'testsrc=s=160x90:d=1', '-pix_fmt', 'yuv420p', '-metadata', 'copyright=Jane Doe, licensed CC BY 4.0 https://creativecommons.org/licenses/by/4.0/', b] });
    await ffmpeg({ args: ['-f', 'lavfi', '-i', 'testsrc=s=160x90', '-frames:v', '1', c] });
    const add = await api.library(ctx, { action: 'add', paths: [a, b], meta: { licence: { id: 'CC-BY-4.0' } } }) as any;
    assert.deepEqual(add.added.map((x: any) => x.status), ['declared', 'declared']);
    await api.library(ctx, { action: 'add', paths: [c] });
    const attr = path.join(dir, 'ATTRIBUTION');
    await writeFile(attr, 'Sports_360P-11b7 is an audio-removed excerpt from "Match" by "Club" licensed under CC BY 4.0\nOther_360P-0000 licensed under CC BY 3.0\n');
    const v = await api.library(ctx, { action: 'verify', evidence: attr }) as any;
    const st = Object.fromEntries(v.results.map((r: any) => [r.id, r.status]));
    assert.deepEqual(st, { L1: 'verified', L2: 'verified', L3: 'unknown' }, JSON.stringify(v));
    assert.match(v.results[0].evidence, /ATTRIBUTION: Sports_360P-11b7/);
    assert.match(v.results[1].evidence, /^copyright:/);
    const audit = await api.library(ctx, { action: 'audit' }) as any;
    assert.deepEqual([audit.verified, audit.declared, audit.unknown], [2, 0, 1]);
    await api.library(ctx, { action: 'licence', id: 'L1', meta: { licence: { id: 'CC0-1.0' } } });
    const after = await api.library(ctx, { action: 'list' }) as any;
    assert.equal(after.entries[0].status, 'declared', 'a new claim is not covered by the old evidence');
    await assert.rejects(api.inspect(ctx, { what: 'library', ...({ action: 'verify' } as object) }), /read-only/);
    assert.ok(licenceMentioned('CC-BY-SA-4.0', 'cc by-sa 4.0') && !licenceMentioned('CC-BY-4.0', 'CC BY-SA 4.0') && licenceMentioned('CC0-1.0', 'Public domain CC0'));
  } finally { if (prev === undefined) delete process.env.FRAME_MODELS; else process.env.FRAME_MODELS = prev; await rm(dir, { recursive: true, force: true }); }
});
